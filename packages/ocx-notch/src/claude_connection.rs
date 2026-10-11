//! Opt-in, local-only Claude companion. Never sends local settings or credentials
//! to the management server; only the allowlisted catalog crosses this boundary.
use crate::api::connection;
use crate::{api, codex_connection, data_relay};
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::Win32::{
    Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
    System::Threading::CREATE_NO_WINDOW,
};

const AUTH_TARGET: &str = "OCX Notch:claude-edge-auth";
const DESIRED_TARGET: &str = "OCX Notch:claude-edge-desired";
const MAX_STATE: usize = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Desired {
    schema_version: u32,
    binding_id: String,
    desired: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogModel {
    id: String,
    route: String,
    name: String,
    effort_levels: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog {
    schema_version: u32,
    revision: String,
    generated_at: u64,
    expires_at: u64,
    models: Vec<CatalogModel>,
    model_map: std::collections::BTreeMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    schema_version: u32,
    desired: bool,
    connected: bool,
    binding_id: Option<String>,
    catalog: Option<Catalog>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ready {
    schema_version: u32,
    pid: u32,
    ready: bool,
    mode: String,
    settings: String,
    proxy_port: u16,
}
struct Runtime {
    child: Option<Child>,
    status: String,
    catalog: Option<Catalog>,
    next_retry: Instant,
}
fn runtime() -> &'static Mutex<Runtime> {
    static STATE: OnceLock<Mutex<Runtime>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(Runtime {
            child: None,
            status: "Not enabled (local opt-in required)".into(),
            catalog: None,
            next_retry: Instant::now(),
        })
    })
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn root() -> Result<PathBuf, String> {
    let path = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("Could not locate local Claude companion state")?;
    Ok(path.join("OCX Notch").join("claude-edge"))
}
fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Could not read Claude companion metadata")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_STATE as u64
    {
        return Err("Invalid Claude companion metadata".into());
    }
    let bytes = fs::read(path).map_err(|_| "Could not read Claude companion metadata")?;
    if bytes.len() > MAX_STATE {
        return Err("Claude companion metadata is too large".into());
    }
    Ok(bytes)
}
fn binding(profile: &connection::Profile) -> String {
    let input = format!(
        "ocx-notch-claude-v1\n{}\n{}",
        profile.endpoint.base_url, profile.data_endpoint.base_url
    );
    data_relay::sha256(input.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn current_binding() -> Result<String, String> {
    if !api::is_remote() || codex_connection::read_mode() == "disconnected" {
        return Err("Connect a remote server first; Claude setup is local to this PC".into());
    }
    connection::saved_profile()?
        .as_ref()
        .map(binding)
        .ok_or("No remote profile is available".into())
}
fn desired() -> Result<Option<Desired>, String> {
    let Some(proof) = connection::read_secret(DESIRED_TARGET)? else {
        return Ok(None);
    };
    let bytes = bounded_read(&root()?.join("desired.json"))?;
    let digest: String = data_relay::sha256(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if proof != digest {
        return Err("Claude opt-in ownership changed; enable again explicitly".into());
    }
    let value: Desired =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid Claude opt-in metadata")?;
    if value.schema_version != 1 || value.binding_id.len() != 64 {
        return Err("Invalid Claude opt-in metadata".into());
    }
    Ok(Some(value))
}
fn system_tool(name: &str) -> Result<PathBuf, String> {
    let base = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("Windows system directory is unavailable")?;
    Ok(base.join("System32").join(name))
}
// Protect before writing any opt-in or worker state. A vault digest additionally
// prevents editing this file from silently manufacturing user consent.
fn protect_root(path: &Path) -> Result<(), String> {
    if path.exists()
        && fs::symlink_metadata(path)
            .map_err(|_| "Could not inspect Claude state directory")?
            .file_type()
            .is_symlink()
    {
        return Err("Claude state directory must not be a link".into());
    }
    fs::create_dir_all(path).map_err(|_| "Could not create Claude state directory")?;
    let output = Command::new(system_tool("whoami.exe")?)
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .map_err(|_| "Could not identify Windows owner")?;
    if !output.status.success() {
        return Err("Could not identify Windows owner".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let sid = text
        .trim()
        .split(',')
        .next_back()
        .unwrap_or("")
        .trim_matches('"');
    if !sid.starts_with("S-1-")
        || !sid
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'S' || b == b'-')
    {
        return Err("Could not identify Windows owner".into());
    }
    let literal = path
        .to_str()
        .ok_or("Invalid Claude companion directory")?
        .replace('\'', "''");
    // Construct a fresh DACL, not grant:r alone (which retains other explicit
    // grants). The only trustee is the current user, inherited by state files.
    let script = format!("$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.SecurityIdentifier]::new('{sid}'); $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl('{literal}',$acl)");
    let status = Command::new(system_tool("WindowsPowerShell/v1.0/powershell.exe")?)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Could not protect Claude companion state")?;
    if !status.success() {
        return Err("Could not protect Claude companion state".into());
    }
    Ok(())
}
fn save_desired(value: &Desired) -> Result<(), String> {
    let path = root()?;
    protect_root(&path)?;
    let bytes = serde_json::to_vec(value).map_err(|_| "Could not encode Claude opt-in")?;
    codex_connection::atomic_write(&path.join("desired.json"), &bytes)?;
    let digest: String = data_relay::sha256(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    connection::write_secret(DESIRED_TARGET, "local Claude opt-in ownership", &digest)
}
fn valid_text(text: &str) -> bool {
    !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
}
fn parse_catalog(value: serde_json::Value, now: u64) -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_value(value)
        .map_err(|_| "Remote Claude catalog has unsupported metadata")?;
    if catalog.schema_version != 1
        || catalog.revision.len() != 64
        || !catalog.revision.bytes().all(|b| b.is_ascii_hexdigit())
        || catalog.generated_at > now.saturating_add(30_000)
        || catalog.expires_at <= now
        || catalog.expires_at <= catalog.generated_at
        || catalog.expires_at - catalog.generated_at > 5 * 60_000
        || catalog.models.is_empty()
        || catalog.models.len() > 2000
        || catalog.model_map.len() > 2000
    {
        return Err("Remote Claude catalog is invalid or expired".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for model in &catalog.models {
        if !valid_text(&model.id)
            || !valid_text(&model.route)
            || !valid_text(&model.name)
            || !ids.insert(&model.id)
            || model.effort_levels.len() > 16
            || model.effort_levels.iter().any(|e| !valid_text(e))
            || model.context_window == Some(0)
        {
            return Err("Remote Claude catalog contains invalid models".into());
        }
    }
    if catalog
        .model_map
        .iter()
        .any(|(id, route)| !valid_text(id) || !valid_text(route))
    {
        return Err("Remote Claude model map is invalid".into());
    }
    Ok(catalog)
}
fn decode_alias(alias: &str) -> Option<String> {
    let (rest, v2) = if let Some(rest) = alias.strip_prefix("claude-ocx2-") { (rest, true) }
        else { (alias.strip_prefix("claude-ocx-")?, false) };
    let (provider, model) = rest.split_once("--")?;
    if !valid_text(provider) || !valid_text(model) { return None; }
    let decode = |input: &str| {
        if !v2 { return input.to_string(); }
        let mut chars = input.chars().peekable();
        let mut output = String::new();
        while let Some(ch) = chars.next() {
            if ch == '~' {
                match chars.peek() {
                    Some('s') => { chars.next(); output.push('/'); continue; }
                    Some('t') => { chars.next(); output.push('~'); continue; }
                    _ => {}
                }
            }
            output.push(ch);
        }
        output
    };
    let provider = decode(provider); let model = decode(model);
    Some(if provider == "native" { model } else { format!("{provider}/{model}") })
}
fn legacy_catalog(policy: serde_json::Value, now: u64) -> Result<Catalog, String> {
    let rows = policy.get("aliases").and_then(|v| v.as_array()).ok_or("Legacy server returned no Claude aliases")?;
    let available: Vec<String> = serde_json::from_value(policy.get("available").cloned().ok_or("Legacy server returned no available routes")?).map_err(|_| "Legacy available routes are invalid")?;
    if available.len() > 2000 || available.iter().any(|r| !valid_text(r)) { return Err("Legacy available routes are invalid".into()); }
    if rows.len() > 2000 { return Err("Legacy Claude catalog is too large".into()); }
    let contexts = policy.get("contextWindows").and_then(|v| v.as_object());
    let model_map: std::collections::BTreeMap<String, String> = policy.get("modelMap").cloned()
        .map(serde_json::from_value).transpose().map_err(|_| "Legacy Claude model map is invalid")?.unwrap_or_default();
    let mut models = Vec::new();
    for row in rows {
        let id = row.get("id").and_then(|v| v.as_str()).ok_or("Legacy Claude alias is invalid")?;
        let name = row.get("display_name").and_then(|v| v.as_str()).ok_or("Legacy Claude alias label is invalid")?;
        // Nonreversible hashes and arbitrary provider IDs are not guessed.
        let Some(route) = decode_alias(id) else { continue; };
        if !available.contains(&route) { return Err("Legacy alias route is not in the available catalog".into()); }
        let context_window = contexts.and_then(|c| c.get(id).or_else(|| c.get(&route))).map(|v| v.as_u64().ok_or("Legacy context window is invalid")).transpose()?;
        models.push(CatalogModel { id: id.into(), route, name: name.into(), context_window, effort_levels: Vec::new() });
    }
    #[derive(Serialize)]
    #[serde(rename_all="camelCase")]
    struct Revision<'a> { models: &'a [CatalogModel], model_map: &'a std::collections::BTreeMap<String, String> }
    // Rust string ordering agrees with JavaScript for these ASCII route/alias keys.
    if model_map.keys().any(|key| !key.is_ascii()) { return Err("Legacy Claude map keys must be ASCII".into()); }
    let bytes = serde_json::to_vec(&Revision { models: &models, model_map: &model_map }).map_err(|_| "Could not encode legacy catalog")?;
    let revision = data_relay::sha256(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    let catalog = Catalog { schema_version: 1, revision, generated_at: now, expires_at: now.saturating_add(300_000), models, model_map };
    parse_catalog(serde_json::to_value(catalog).map_err(|_| "Could not encode legacy catalog")?, now)
}
fn refresh(rt: &mut Runtime, expected: &str) -> Result<(), String> {
    let result = (|| {
        if current_binding()? != expected {
            return Err(
                "Remote profile changed; enable Claude explicitly on the new connection".into(),
            );
        }
        let generation = connection::generation();
        let metadata: serde_json::Value = api::get_json("/api/claude-desktop", 15_000)?;
        if !metadata.is_object() { return Err("Invalid Claude desktop response".into()); }
        let catalog = match metadata.get("firstPartyCatalog") {
            Some(value) => parse_catalog(value.clone(), now_ms())?,
            // Compatibility only for missing fields, never null or malformed data.
            None => legacy_catalog(api::get_json("/api/claude-code", 15_000)?, now_ms())?,
        };
        if current_binding()? != expected || generation != connection::generation() {
            return Err("Remote connection changed during Claude catalog refresh".into());
        }
        Ok(catalog)
    })();
    if let Ok(catalog) = &result {
        rt.catalog = Some(catalog.clone());
    }
    if rt.catalog.is_none() {
        // A prior snapshot is metadata only and never grants connected readiness.
        // Preserve it through offline startup only for this exact profile binding.
        if let Ok(bytes) = bounded_read(&root()?.join("state.json")) {
            if let Ok(previous) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if previous.get("bindingId").and_then(|v| v.as_str()) == Some(expected) {
                    rt.catalog = previous
                        .get("catalog")
                        .cloned()
                        .and_then(|v| serde_json::from_value(v).ok());
                }
            }
        }
    }
    let state = State {
        schema_version: 1,
        desired: true,
        connected: result.is_ok(),
        binding_id: Some(expected.into()),
        catalog: rt.catalog.clone(),
    };
    let bytes = serde_json::to_vec(&state).map_err(|_| "Could not encode Claude edge metadata")?;
    if bytes.len() > MAX_STATE {
        return Err("Claude edge metadata is too large".into());
    }
    codex_connection::atomic_write(&root()?.join("state.json"), &bytes)?;
    result.map(|_| ())
}
fn worker_command() -> Result<Command, String> {
    let bun = std::env::var_os("OCX_NOTCH_BUN_PATH")
        .map(PathBuf::from)
        .ok_or("Launch Notch through the package launcher to enable Claude")?;
    let entry = std::env::var_os("OCX_NOTCH_CLI_ENTRY")
        .map(PathBuf::from)
        .ok_or("Package Claude entry is unavailable")?;
    if !bun.is_absolute()
        || !entry.is_absolute()
        || !bun.is_file()
        || !entry.is_file()
        || entry.file_name().is_none_or(|n| n != "index.ts")
    {
        return Err("Package Claude runtime paths are invalid".into());
    }
    let package = entry
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("Invalid package entry directory")?;
    let mut command = Command::new(bun);
    command.current_dir(package);
    let edge_entry = entry.with_file_name("claude-edge-entry.ts");
    if !edge_entry.is_file() { return Err("Dedicated Claude runtime entry is unavailable".into()); }
    command
        .arg("--no-env-file")
        .arg(edge_entry)
        .arg("--config-dir")
        .arg(root()?)
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // Start with no inherited credentials, including arbitrary provider-specific
    // names that a denylist cannot predict. Keep only local OS runtime metadata.
    command.env_clear();
    for name in [
        "SystemRoot",
        "WINDIR",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "USERNAME",
        "USERDOMAIN",
        "HOME",
        "CLAUDE_CONFIG_DIR",
        "TEMP",
        "TMP",
        "PATH",
        "PATHEXT",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    Ok(command)
}
fn relay_token() -> Result<String, String> {
    if let Some(token) = connection::read_secret(AUTH_TARGET)? {
        if token.len() == 43
            && token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Ok(token);
        }
        return Err("Stored Claude relay authorization is invalid".into());
    }
    let mut random = [0u8; 32];
    unsafe { BCryptGenRandom(None, &mut random, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|_| "Could not generate local Claude authorization")?;
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut token = String::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in random {
        bits = (bits << 8) | byte as u32;
        count += 8;
        while count >= 6 {
            count -= 6;
            token.push(alphabet[((bits >> count) & 63) as usize] as char);
        }
    }
    if count > 0 {
        token.push(alphabet[((bits << (6 - count)) & 63) as usize] as char);
    }
    connection::write_secret(AUTH_TARGET, "local Claude loopback authorization", &token)?;
    Ok(token)
}
fn ready(child: &Child, _applied: bool) -> bool {
    bounded_read(&root().unwrap_or_default().join("status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Ready>(&b).ok())
        .is_some_and(|s| {
            s.schema_version == 1
                && s.pid == child.id()
                && s.ready
                && s.mode == "first-party"
                && s.proxy_port == 10200
                && s.settings == "applied"
        })
}
fn start(rt: &mut Runtime, apply: bool) -> Result<(), String> {
    if let Some(child) = rt.child.as_mut() {
        if child
            .try_wait()
            .map_err(|_| "Could not inspect owned Claude worker")?
            .is_none()
        {
            if ready(child, apply) {
                return Ok(());
            }
            return Err("Owned Claude worker is not ready; disable then retry".into());
        }
        rt.child = None;
    }
    data_relay::ensure_running()?;
    let token = relay_token()?;
    let mut command = worker_command()?;
    command
        .arg("--state")
        .arg(root()?.join("state.json"))
        .stdin(Stdio::piped());
    if apply {
        command.arg("--apply");
        if root()?.join("picker-opt-in").is_file() { command.arg("--apply-picker"); }
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start package Claude worker")?;
    let auth = serde_json::json!({"schemaVersion":1,"relayToken":token});
    let send = child
        .stdin
        .as_mut()
        .ok_or("Claude worker input is unavailable")?
        .write_all(format!("{auth}\n").as_bytes());
    if send.is_err() {
        rt.child = Some(child);
        return Err("Could not authorize owned Claude worker".into());
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if ready(&child, apply) {
            rt.child = Some(child);
            return Ok(());
        }
        if let Some(exit) = child
            .try_wait()
            .map_err(|_| "Could not inspect owned Claude worker")?
        {
            let mut bytes = Vec::new();
            if let Some(stderr) = child.stderr.take() { let _ = stderr.take(64 * 1024).read_to_end(&mut bytes); }
            let diagnostic = String::from_utf8_lossy(&bytes);
            let reason = if diagnostic.contains("Cannot find") || diagnostic.contains("ModuleNotFound") { "runtime_dependency_unavailable" }
                else if diagnostic.contains("AccessDenied") || diagnostic.contains("Permission denied") { "runtime_access_denied" }
                else if diagnostic.contains("error: Script not found") { "runtime_entry_unavailable" }
                else if diagnostic.contains("SyntaxError") { "runtime_parse_failed" }
                else if diagnostic.contains("unknown option") || diagnostic.contains("Unknown flag") { "runtime_option_unsupported" }
                else { "runtime_startup_failed" };
            return Err(format!("Claude worker exited before readiness ({reason}, code {:?}); existing foreign settings were preserved", exit.code()));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    rt.child = Some(child);
    Err("Claude worker did not become ready; disable then retry".into())
}
fn stop_owned(rt: &mut Runtime) -> Result<(), String> {
    let Some(child) = rt.child.as_mut() else {
        return Ok(());
    };
    if let Some(mut input) = child.stdin.take() {
        let _ = input.write_all(b"{\"command\":\"shutdown\"}\n");
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|_| "Could not inspect owned Claude worker")?
            .is_some()
        {
            rt.child = None;
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("Owned Claude worker is still draining; retry disable shortly".into())
}
/// Read only local opt-in/status metadata; never contact a VM or print credentials.
pub fn release_setup_worker() {
    if let Ok(mut rt) = runtime().lock() { let _ = stop_owned(&mut rt); }
}
pub fn local_status() -> Result<(), String> {
    let mut rt = runtime().lock().map_err(|_| "Claude companion is busy")?;
    rt.status = match desired()? {
        None => "Not enabled (local opt-in required)".into(),
        Some(value) if !value.desired => "Claude 1P off".into(),
        Some(value) => {
            if current_binding().ok().as_deref() != Some(&value.binding_id) {
                "Claude 1P opted in · selected connection unavailable or changed".into()
            } else {
                let record = bounded_read(&root()?.join("status.json")).ok().and_then(|b| serde_json::from_slice::<Ready>(&b).ok());
                if record.is_some_and(|s| s.schema_version == 1 && s.ready && s.mode == "first-party" && s.settings == "applied") {
                    "Claude 1P opted in · last worker status ready (supervisor verifies live readiness)".into()
                } else { "Claude 1P opted in · waiting for local Notch supervisor".into() }
            }
        }
    };
    Ok(())
}
pub fn status() -> String {
    runtime()
        .try_lock()
        .map(|rt| rt.status.clone())
        .unwrap_or_else(|_| "Claude companion setup / refresh in progress…".into())
}
pub fn enable() -> Result<(), String> {
    let mut rt = runtime().lock().map_err(|_| "Claude companion is busy")?;
    let result = (|| {
        let binding = current_binding()?;
        protect_root(&root()?)?;
        refresh(&mut rt, &binding)?;
        start(&mut rt, true)?;
        save_desired(&Desired {
            schema_version: 1,
            desired: true,
            binding_id: binding,
        })
    })();
    rt.status = result
        .as_ref()
        .map(|_| "Ready · Claude 1P on this PC".into())
        .unwrap_or_else(|e: &String| e.clone());
    result
}
/// Separate explicit local action: Windows owns the certificate confirmation UI.
pub fn enable_picker() -> Result<(), String> {
    current_binding()?;
    protect_root(&root()?)?;
    let status = worker_command()?.arg("--trust-picker").stdin(Stdio::null()).status()
        .map_err(|_| "Could not open Windows picker certificate confirmation")?;
    if !status.success() { return Err("Picker certificate trust was declined or unavailable".into()); }
    codex_connection::atomic_write(&root()?.join("picker-opt-in"), b"explicit-local-picker-v1")?;
    enable()
}
pub fn disable_picker() -> Result<(), String> {
    let mut rt = runtime().lock().map_err(|_| "Claude companion is busy")?;
    stop_owned(&mut rt)?;
    let status = worker_command()?.arg("--untrust-picker").stdin(Stdio::null()).status()
        .map_err(|_| "Could not open Windows certificate removal confirmation")?;
    if !status.success() { return Err("Picker removal was declined or unavailable".into()); }
    let path = root()?.join("picker-opt-in");
    if path.is_file() { fs::remove_file(path).map_err(|_| "Could not remove picker opt-in")?; }
    start(&mut rt, false)
}
pub fn disable() -> Result<(), String> {
    let mut rt = runtime().lock().map_err(|_| "Claude companion is busy")?;
    let result = (|| {
        if let Some(mut value) = desired()? {
            value.desired = false;
            save_desired(&value)?;
        }
        stop_owned(&mut rt)?;
        let status = worker_command()?
            .arg("--remove")
            .stdin(Stdio::null())
            .status()
            .map_err(|_| "Could not remove owned Claude setup")?;
        if !status.success() {
            return Err(
                "Could not remove owned Claude setup; foreign settings were preserved".into(),
            );
        }
        Ok(())
    })();
    rt.status = result
        .as_ref()
        .map(|_| "Claude 1P off · owned settings restored".into())
        .unwrap_or_else(|e: &String| e.clone());
    result
}
/// Dedicated supervisor: no opt-in means no worker, no settings writes, no CA.
pub fn supervise() {
    std::thread::spawn(|| loop {
        let _ = (|| -> Result<(), String> {
            let mut rt = runtime().lock().map_err(|_| "Claude companion is busy")?;
            if Instant::now() < rt.next_retry {
                return Ok(());
            }
            rt.next_retry = Instant::now() + Duration::from_secs(30);
            let result: Result<(), String> = (|| {
                let Some(value) = desired()?.filter(|d| d.desired) else {
                    return Ok(());
                };
                protect_root(&root()?)?;
                // Keep the owned local listener available even during VM outage.
                // The disconnected metadata makes only routed requests fail closed.
                let refresh_result = refresh(&mut rt, &value.binding_id);
                start(&mut rt, false)?;
                refresh_result?;
                rt.status = "Ready · Claude 1P on this PC".into();
                Ok(())
            })();
            if let Err(error) = &result {
                rt.status = error.clone();
            }
            result
        })();
        std::thread::sleep(Duration::from_secs(2));
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_aliases_are_reversible_and_hash_ids_are_not_guessed() {
        assert_eq!(decode_alias("claude-ocx-native--gpt-test"), Some("gpt-test".into()));
        assert_eq!(decode_alias("claude-ocx-provider--model--literal"), Some("provider/model--literal".into()));
        assert_eq!(decode_alias("claude-ocx2-provider--model~svariant~t~x"), Some("provider/model/variant~~x".into()));
        assert_eq!(decode_alias("claude-ocxhash-deadbeef"), None);
        assert_eq!(decode_alias("provider/model"), None);
        let catalog = legacy_catalog(serde_json::json!({"available":["model"],"aliases":[{"id":"claude-ocx-native--model","display_name":"Model"},{"id":"opaque-hash","display_name":"Ignored"}],"contextWindows":{"claude-ocx-native--model":200000},"modelMap":{"sonnet":"model"}}),1000).unwrap();
        assert_eq!(catalog.models.len(),1);
        assert_eq!(catalog.models[0].context_window,Some(200000));
        assert!(catalog.models[0].effort_levels.is_empty());
        let expected = br#"{"models":[{"id":"claude-ocx-native--model","route":"model","name":"Model","effortLevels":[],"contextWindow":200000}],"modelMap":{"sonnet":"model"}}"#;
        let revision: String = data_relay::sha256(expected).iter().map(|b|format!("{b:02x}")).collect();
        assert_eq!(catalog.revision,revision);
    }
    fn fixture(now: u64) -> serde_json::Value {
        serde_json::json!({"schemaVersion":1,"revision":"a".repeat(64),"generatedAt":now,"expiresAt":now+120000,"models":[{"id":"model","route":"provider/model","name":"Model","effortLevels":["high"]}],"modelMap":{}})
    }
    #[test]
    fn metadata_is_allowlisted_and_bounded() {
        assert!(parse_catalog(fixture(1000), 1000).is_ok());
        let mut value = fixture(1000);
        value["token"] = "must-not-cross".into();
        assert!(parse_catalog(value, 1000).is_err());
        let mut value = fixture(1000);
        value["models"][0]["apiKey"] = "must-not-cross".into();
        assert!(parse_catalog(value, 1000).is_err());
        assert!(parse_catalog(fixture(1000), 121001).is_err());
        let mut value = fixture(1000);
        value["expiresAt"] = (1000 + 16 * 60000).into();
        assert!(parse_catalog(value, 1000).is_err());
    }
    #[test]
    fn binding_tracks_both_origins_not_tokens() {
        let endpoint = connection::parse_endpoint("https://example.com").unwrap();
        let mut profile = connection::Profile {
            endpoint: endpoint.clone(),
            data_endpoint: endpoint,
            token: "fixture".into(),
        };
        let original = binding(&profile);
        profile.token = "other fixture".into();
        assert_eq!(original, binding(&profile));
        profile.data_endpoint = connection::parse_endpoint("https://data.example.com").unwrap();
        assert_ne!(original, binding(&profile));
    }
}
