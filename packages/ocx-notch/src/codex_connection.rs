//! Local Codex routing owned by Notch. Long-lived ownership metadata and the
//! remote admission key stay in the Windows vault; the built-in OpenAI provider
//! sends compressed requests through Notch's authenticated loopback relay.
use crate::api::connection::{self, Profile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS, LPARAM, WPARAM,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SAM_FLAGS, REG_SZ,
    REG_VALUE_TYPE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
};

const BEGIN: &str = "# BEGIN OCX NOTCH PROVIDER";
const END: &str = "# END OCX NOTCH PROVIDER";
/// Custom provider kept for conversations that pinned it before the loopback
/// relay existed. It points at the same relay, so an existing thread keeps
/// working after the default provider moves to the built-in `openai` provider.
const RELAY_PROVIDER: &str = "ocx-notch";
const RELAY_BASE_URL: &str = "http://127.0.0.1:10101/v1";
pub const ADMISSION_ENV_VAR: &str = "OPENCODEX_NOTCH_API_AUTH_TOKEN";
const ENV_OWNERSHIP_TARGET: &str = "OCX Notch:codex-admission-environment";
const CONFIG_OWNERSHIP_FILE: &str = "ocx-notch-config-state.json";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct EnvironmentValue {
    value: String,
    #[serde(default)]
    expandable: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct EnvironmentOwnership {
    previous: Option<EnvironmentValue>,
    installed: String,
}

#[derive(Clone)]
pub struct EnvironmentRollback {
    previous_value: Option<EnvironmentValue>,
    previous_ownership: Option<String>,
    installed_value: Option<EnvironmentValue>,
    installed_ownership: Option<String>,
}

#[derive(Clone)]
pub struct ConfigRollback {
    previous_config: String,
    previous_ownership: Option<ConfigOwnership>,
    installed_config: String,
    installed_ownership: Option<ConfigOwnership>,
}

pub struct ConfigRestore {
    before: String,
    rollback: ConfigRollback,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct ConfigOwnership {
    before: String,
    installed: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ManagedConfigProjection {
    root_lines: Vec<String>,
    fence_blocks: Vec<Vec<String>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct DataKey {
    pub id: String,
    pub key: String,
    /// True only when Notch created this key through POST /api/keys. A key the
    /// user pasted into Connection Settings belongs to the server operator and
    /// must never be revoked when this client disconnects.
    #[serde(default = "server_issued_default")]
    pub server_issued: bool,
}

fn server_issued_default() -> bool {
    // Credentials saved by older Notch builds were always created by Notch.
    true
}

pub fn state_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("OCX Notch")
}

pub fn read_mode() -> String {
    match fs::read_to_string(state_dir().join("connection-mode")) {
        Ok(mode) => mode.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => "disconnected".into(),
    }
}

pub fn write_mode(mode: &str) -> Result<(), String> {
    atomic_write(&state_dir().join("connection-mode"), mode.as_bytes())
}

pub fn codex_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_HOME").filter(|s| !s.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os("USERPROFILE")
        .map(|p| PathBuf::from(p).join(".codex"))
        .ok_or_else(|| "Could not locate the Codex configuration".into())
}

pub fn key_target(origin: &str) -> String {
    format!("OCX Notch:codex-data:{origin}")
}

pub fn load_key(origin: &str) -> Result<Option<DataKey>, String> {
    connection::read_secret(&key_target(origin))?
        .map(|text| {
            serde_json::from_str(&text).map_err(|_| "Stored Codex credential is invalid".into())
        })
        .transpose()
}

pub fn save_key(origin: &str, key: &DataKey) -> Result<(), String> {
    let encoded = serde_json::to_string(key).map_err(|_| "Could not encode Codex credential")?;
    connection::write_secret(&key_target(origin), origin, &encoded)
}

/// Invoked by Codex's command-backed provider auth, with stdout piped to Codex.
/// Never return an old server's credential after a profile change or disconnect.
pub fn auth_token(origin: &str) -> Result<String, String> {
    if read_mode() != "remote" {
        return Err("OCX Notch is disconnected".into());
    }
    let profile = connection::saved_profile()?.ok_or("No remote server is saved")?;
    if profile.endpoint.base_url != origin {
        return Err("The OCX server has changed; restart Codex".into());
    }
    let key = load_key(origin)?.ok_or("Connect OCX Notch before using Codex")?;
    connection::validate_token(&key.key)?;
    Ok(key.key)
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid configuration path")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the configuration directory")?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temp = path.with_extension(format!(
        "notch-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "Could not create the configuration update")?;
    let result = (|| {
        file.write_all(contents)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Could not write the configuration update")?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| "Could not replace the configuration file")
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(str::to_string)
}

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn environment_key(access: REG_SAM_FLAGS) -> Result<RegistryKey, String> {
    unsafe {
        let mut key = HKEY::default();
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            windows::core::w!("Environment"),
            0,
            access,
            &mut key,
        );
        if status != ERROR_SUCCESS {
            return Err("Could not open the current user's environment settings".into());
        }
        Ok(RegistryKey(key))
    }
}

fn read_user_environment_value() -> Result<Option<EnvironmentValue>, String> {
    unsafe {
        let key = environment_key(KEY_QUERY_VALUE)?;
        let name = wide(ADMISSION_ENV_VAR);
        let mut kind = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let first = RegQueryValueExW(
            key.0,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        );
        if first == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if first != ERROR_SUCCESS && first != ERROR_MORE_DATA {
            return Err("Could not read the current user's Codex admission setting".into());
        }
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            return Err(
                "The existing Codex admission environment value has an unsupported type".into(),
            );
        }
        let mut bytes = vec![0u8; size as usize];
        let second = RegQueryValueExW(
            key.0,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            Some(bytes.as_mut_ptr()),
            Some(&mut size),
        );
        if second != ERROR_SUCCESS || size as usize > bytes.len() || size % 2 != 0 {
            return Err("Could not read the current user's Codex admission setting".into());
        }
        bytes.truncate(size as usize);
        let units = std::slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), bytes.len() / 2);
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let value = String::from_utf16(&units[..end])
            .map_err(|_| "The existing Codex admission environment value is invalid")?;
        Ok(Some(EnvironmentValue {
            value,
            expandable: kind == REG_EXPAND_SZ,
        }))
    }
}

fn write_user_environment_value(value: Option<&EnvironmentValue>) -> Result<(), String> {
    unsafe {
        let key = environment_key(KEY_SET_VALUE)?;
        let name = wide(ADMISSION_ENV_VAR);
        let status = if let Some(value) = value {
            let wide = wide(&value.value);
            let bytes = std::slice::from_raw_parts(wide.as_ptr().cast::<u8>(), wide.len() * 2);
            RegSetValueExW(
                key.0,
                PCWSTR(name.as_ptr()),
                0,
                if value.expandable {
                    REG_EXPAND_SZ
                } else {
                    REG_SZ
                },
                Some(bytes),
            )
        } else {
            RegDeleteValueW(key.0, PCWSTR(name.as_ptr()))
        };
        if status != ERROR_SUCCESS && !(value.is_none() && status == ERROR_FILE_NOT_FOUND) {
            return Err("Could not update the current user's Codex admission setting".into());
        }
    }
    match value {
        Some(value) => std::env::set_var(ADMISSION_ENV_VAR, &value.value),
        None => std::env::remove_var(ADMISSION_ENV_VAR),
    }
    broadcast_environment_change();
    Ok(())
}

fn broadcast_environment_change() {
    unsafe {
        let section = wide("Environment");
        let _ = SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            WPARAM(0),
            LPARAM(section.as_ptr() as isize),
            SMTO_ABORTIFHUNG,
            5_000,
            None,
        );
    }
}

fn save_environment_ownership(value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => connection::write_secret(ENV_OWNERSHIP_TARGET, ADMISSION_ENV_VAR, value),
        None => connection::delete_secret(ENV_OWNERSHIP_TARGET),
    }
}

pub fn rollback_admission_environment(rollback: &EnvironmentRollback) -> Result<(), String> {
    if read_user_environment_value()? != rollback.installed_value
        || connection::read_secret(ENV_OWNERSHIP_TARGET)? != rollback.installed_ownership
    {
        return Err("The Codex admission environment changed during the operation; the newer value was preserved".into());
    }
    write_user_environment_value(rollback.previous_value.as_ref())?;
    save_environment_ownership(rollback.previous_ownership.as_deref())
}

pub fn remove_owned_admission_environment() -> Result<EnvironmentRollback, String> {
    let previous_value = read_user_environment_value()?;
    let previous_ownership = connection::read_secret(ENV_OWNERSHIP_TARGET)?;
    let Some(encoded) = previous_ownership.as_deref() else {
        return Ok(EnvironmentRollback {
            installed_value: previous_value.clone(),
            installed_ownership: previous_ownership.clone(),
            previous_value,
            previous_ownership,
        });
    };
    let ownership: EnvironmentOwnership =
        serde_json::from_str(encoded).map_err(|_| "Stored Codex admission ownership is invalid")?;
    let restored_value = if previous_value.as_ref().map(|value| value.value.as_str())
        == Some(ownership.installed.as_str())
    {
        ownership.previous.clone()
    } else {
        previous_value.clone()
    };
    write_user_environment_value(restored_value.as_ref())?;
    if let Err(error) = save_environment_ownership(None) {
        let _ = write_user_environment_value(previous_value.as_ref());
        return Err(error);
    }
    Ok(EnvironmentRollback {
        previous_value,
        previous_ownership,
        installed_value: restored_value,
        installed_ownership: None,
    })
}

fn config_ownership_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_OWNERSHIP_FILE)
}

fn read_config_ownership(dir: &Path) -> Result<Option<ConfigOwnership>, String> {
    match fs::read(config_ownership_path(dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "Stored Notch Codex configuration ownership is invalid".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read Notch Codex configuration ownership".into()),
    }
}

fn write_config_ownership(dir: &Path, ownership: &ConfigOwnership) -> Result<(), String> {
    let encoded = serde_json::to_vec(ownership)
        .map_err(|_| "Could not encode Notch Codex configuration ownership")?;
    atomic_write(&config_ownership_path(dir), &encoded)
}

fn root_key(line: &str) -> Option<&str> {
    line.split_once('=')
        .map(|(key, _)| key.trim().trim_matches(['\'', '"']))
}

fn is_managed_root_line(line: &str) -> bool {
    line == "# Auto-injected by opencodex"
        || matches!(
            root_key(line),
            Some("openai_base_url" | "model_provider" | "model_catalog_json")
        )
}

fn config_lines(input: &str) -> Vec<String> {
    input
        .replace("\r\n", "\n")
        .split('\n')
        .map(str::to_string)
        .collect()
}

fn fence_ranges(lines: &[String]) -> Result<Vec<(usize, usize)>, String> {
    let mut ranges = Vec::new();
    let mut start = None;
    for (index, line) in lines.iter().enumerate() {
        if line == BEGIN {
            if start.replace(index).is_some() {
                return Err("Duplicate Notch provider block".into());
            }
        } else if line == END {
            let Some(begin) = start.take() else {
                return Err("Invalid Notch provider block".into());
            };
            ranges.push((begin, index));
        }
    }
    if start.is_some() {
        return Err("Incomplete Notch provider block".into());
    }
    Ok(ranges)
}

fn managed_config_projection(input: &str) -> Result<ManagedConfigProjection, String> {
    let lines = config_lines(input);
    let root_end = lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len());
    let root_lines = lines[..root_end]
        .iter()
        .filter(|line| is_managed_root_line(line))
        .cloned()
        .collect();
    let fence_blocks = fence_ranges(&lines)?
        .into_iter()
        .map(|(start, end)| lines[start..=end].to_vec())
        .collect();
    Ok(ManagedConfigProjection {
        root_lines,
        fence_blocks,
    })
}

/// Reverse only the routing lines and fenced provider block installed by the
/// previous Notch connection. Unrelated settings added while Notch was active
/// are retained. Any edit to the owned projection still fails closed.
fn restore_config_preserving_user_edits(
    current: &str,
    ownership: &ConfigOwnership,
) -> Result<String, String> {
    let current_projection = managed_config_projection(current)?;
    let installed_projection = managed_config_projection(&ownership.installed)?;
    if current_projection != installed_projection {
        return Err("Codex settings owned by Notch changed after it connected; restore the Notch routing settings before reconnecting or disconnecting".into());
    }

    let baseline_projection = managed_config_projection(&ownership.before)?;
    let lines = config_lines(current);
    let root_end = lines
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(lines.len());
    let current_ranges = fence_ranges(&lines)?;
    let first_fence = current_ranges.first().map(|(start, _)| *start);
    let mut output = Vec::with_capacity(lines.len());
    let mut inserted_root = false;
    let mut inserted_fences = false;
    let mut range_index = 0usize;
    let mut index = 0usize;
    while index < lines.len() {
        if let Some((start, end)) = current_ranges.get(range_index).copied() {
            if index == start {
                if baseline_projection.fence_blocks.is_empty()
                    && output.last().is_some_and(String::is_empty)
                    && lines.get(end + 1).is_some_and(String::is_empty)
                {
                    output.pop();
                }
                for block in &baseline_projection.fence_blocks {
                    output.extend(block.iter().cloned());
                }
                inserted_fences = true;
                range_index += 1;
                index = end + 1;
                continue;
            }
        }
        if index < root_end && is_managed_root_line(&lines[index]) {
            if !inserted_root {
                output.extend(baseline_projection.root_lines.iter().cloned());
                inserted_root = true;
            }
            index += 1;
            continue;
        }
        output.push(lines[index].clone());
        index += 1;
    }
    if !inserted_root && !baseline_projection.root_lines.is_empty() {
        let insertion = output
            .iter()
            .position(|line| line.trim_start().starts_with('['))
            .unwrap_or(output.len());
        output.splice(insertion..insertion, baseline_projection.root_lines);
    }
    if !inserted_fences && !baseline_projection.fence_blocks.is_empty() {
        if first_fence.is_none() && output.last().is_some_and(|line| !line.is_empty()) {
            output.push(String::new());
        }
        for block in baseline_projection.fence_blocks {
            output.extend(block);
        }
    }
    let restored = output.join("\n");
    Ok(if current.contains("\r\n") {
        restored.replace('\n', "\r\n")
    } else {
        restored
    })
}

fn preflight_config_restore_in(dir: &Path) -> Result<ConfigRestore, String> {
    let ownership =
        read_config_ownership(dir)?.ok_or("Notch has no saved Codex configuration to restore")?;
    let current = fs::read_to_string(dir.join("config.toml"))
        .map_err(|_| "Could not read Codex config.toml")?;
    let before = if current == ownership.installed {
        ownership.before.clone()
    } else {
        restore_config_preserving_user_edits(&current, &ownership)?
    };
    Ok(ConfigRestore {
        before,
        rollback: ConfigRollback {
            previous_config: current,
            previous_ownership: Some(ownership),
            installed_config: String::new(),
            installed_ownership: None,
        },
    })
}

pub fn preflight_config_restore() -> Result<ConfigRestore, String> {
    let dir = codex_dir()?;
    preflight_config_restore_in(&dir)
}

fn restore_owned_config_in(dir: &Path, restore: &ConfigRestore) -> Result<ConfigRollback, String> {
    atomic_write(&dir.join("config.toml"), restore.before.as_bytes())?;
    match fs::remove_file(config_ownership_path(&dir)) {
        Ok(()) => Ok(ConfigRollback {
            installed_config: restore.before.clone(),
            installed_ownership: None,
            ..restore.rollback.clone()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ConfigRollback {
            installed_config: restore.before.clone(),
            installed_ownership: None,
            ..restore.rollback.clone()
        }),
        Err(_) => {
            let _ = atomic_write(
                &dir.join("config.toml"),
                restore.rollback.previous_config.as_bytes(),
            );
            Err("Could not remove Notch Codex configuration ownership".into())
        }
    }
}

pub fn restore_owned_config(restore: &ConfigRestore) -> Result<ConfigRollback, String> {
    let dir = codex_dir()?;
    restore_owned_config_in(&dir, restore)
}

fn rollback_config_update_in(dir: &Path, rollback: &ConfigRollback) -> Result<(), String> {
    let current = fs::read_to_string(dir.join("config.toml"))
        .map_err(|_| "Could not read Codex config.toml before rollback")?;
    if current != rollback.installed_config
        || read_config_ownership(dir)? != rollback.installed_ownership
    {
        return Err(
            "Codex settings changed during the operation; the newer settings were preserved".into(),
        );
    }
    atomic_write(
        &dir.join("config.toml"),
        rollback.previous_config.as_bytes(),
    )?;
    match rollback.previous_ownership.as_ref() {
        Some(ownership) => write_config_ownership(dir, ownership),
        None => match fs::remove_file(config_ownership_path(dir)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not restore Notch Codex configuration ownership".into()),
        },
    }
}

pub fn rollback_config_update(rollback: &ConfigRollback) -> Result<(), String> {
    let dir = codex_dir()?;
    rollback_config_update_in(&dir, rollback)
}

/// Only single-line root routing keys are changed. Tables and other content are
/// retained verbatim. Unusual multiline routing values fail before any write.
pub fn transform_config(
    input: &str,
    origin: Option<&str>,
    catalog: &Path,
    _executable: &Path,
) -> Result<String, String> {
    let normalized = input.replace("\r\n", "\n");
    if normalized.contains("\"\"\"") || normalized.contains("'''") {
        return Err("Multiline TOML strings require manual Codex connection configuration".into());
    }
    let mut lines: Vec<&str> = Vec::new();
    let mut owned = false;
    for line in normalized.lines() {
        if line == BEGIN {
            if owned {
                return Err("Duplicate Notch provider block".into());
            }
            owned = true;
            continue;
        }
        if line == END {
            if !owned {
                return Err("Invalid Notch provider block".into());
            }
            owned = false;
            continue;
        }
        if !owned {
            lines.push(line);
        }
    }
    if owned {
        return Err("Incomplete Notch provider block".into());
    }
    // The managed block sits at the end of the file behind one blank line. Drop
    // the line breaks that belonged to it so reconnecting rewrites byte-identical
    // settings instead of accumulating blank lines on every pass.
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if lines.iter().any(|l| {
        l.chars()
            .filter(|c| !c.is_whitespace() && *c != '\'' && *c != '"')
            .collect::<String>()
            .starts_with("[model_providers.ocx-notch")
    }) {
        return Err("The ocx-notch provider name is already in use outside Notch".into());
    }
    let root_end = lines
        .iter()
        .position(|l| l.trim_start().starts_with('['))
        .unwrap_or(lines.len());
    let mut root = Vec::new();
    for line in &lines[..root_end] {
        let key = line
            .split_once('=')
            .map(|(k, _)| k.trim().trim_matches(['\'', '"']));
        if key == Some("profile") {
            return Err("Disable the active Codex profile before changing its server".into());
        }
        if matches!(
            key,
            Some("openai_base_url" | "model_provider" | "model_catalog_json")
        ) {
            let value = line.split_once('=').unwrap().1.trim();
            if value.starts_with("\"\"\"")
                || value.starts_with("'''")
                || !(value.starts_with('"') || value.starts_with('\''))
            {
                return Err("Unsupported multiline Codex routing setting".into());
            }
            continue;
        }
        if *line != "# Auto-injected by opencodex" {
            root.push(*line);
        }
    }
    let mut output = root.join("\n");
    let quote = |s: &str| serde_json::to_string(s).unwrap();
    output.push_str(&format!(
        "\nmodel_provider = {}\nmodel_catalog_json = {}\n",
        quote("openai"),
        quote(&catalog.to_string_lossy())
    ));
    output.push_str(if origin.is_some() {
        "openai_base_url = \"http://127.0.0.1:10101/v1\"\n"
    } else {
        "openai_base_url = \"http://127.0.0.1:10100/v1\"\n"
    });
    output.push_str(&lines[root_end..].join("\n"));
    if origin.is_some() {
        // New conversations use the built-in provider above, which keeps Codex's
        // native request compression. Threads that already pinned the custom
        // provider resolve to this definition instead of failing to start.
        output.push_str(&format!(
            "\n\n{BEGIN}\n[model_providers.{RELAY_PROVIDER}]\nname = \"OCX Notch\"\nbase_url = \"{RELAY_BASE_URL}\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nsupports_websockets = false\n{END}\n"
        ));
    }
    Ok(if input.contains("\r\n") {
        output.replace('\n', "\r\n")
    } else {
        output
    })
}

pub fn validate_catalog(catalog: &Value) -> Result<(), String> {
    if catalog
        .get("models")
        .and_then(Value::as_array)
        .is_none_or(|models| models.is_empty())
    {
        return Err("The server returned an empty or invalid Codex catalog".into());
    }
    Ok(())
}

fn configured_catalog_path(dir: &Path) -> Result<PathBuf, String> {
    let config_path = dir.join("config.toml");
    let config = match fs::read_to_string(&config_path) {
        Ok(config) => config,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(dir.join("ocx-notch-catalog.json"));
        }
        Err(_) => return Err("Could not read Codex config.toml".into()),
    };
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().trim_matches(['\'', '"']) != "model_catalog_json" {
            continue;
        }
        let value = value.trim();
        let decoded = if value.starts_with('"') {
            serde_json::from_str::<String>(value)
                .map_err(|_| "Invalid model_catalog_json in Codex config.toml")?
        } else if value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2 {
            value[1..value.len() - 1].to_string()
        } else {
            return Err("Invalid model_catalog_json in Codex config.toml".into());
        };
        if decoded.is_empty() {
            return Err("Invalid model_catalog_json in Codex config.toml".into());
        }
        let path = PathBuf::from(decoded);
        return Ok(if path.is_absolute() {
            path
        } else {
            dir.join(path)
        });
    }
    Ok(dir.join("ocx-notch-catalog.json"))
}

pub fn sync_catalog(profile: &Profile, catalog: &Value) -> Result<(), String> {
    validate_catalog(catalog)?;
    if read_mode() != "remote" {
        return Ok(());
    }
    if connection::saved_profile()?.is_none_or(|p| p.endpoint != profile.endpoint) {
        return Ok(());
    }
    let dir = codex_dir()?;
    atomic_write(
        &configured_catalog_path(&dir)?,
        &serde_json::to_vec(catalog).map_err(|_| "Invalid catalog")?,
    )
}

pub fn configure(origin: Option<&str>, catalog: Option<&Value>) -> Result<ConfigRollback, String> {
    let dir = codex_dir()?;
    let path = dir.join("config.toml");
    let before = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(_) => return Err("Could not read Codex config.toml".into()),
    };
    let catalog_path = dir.join(if origin.is_some() {
        "ocx-notch-catalog.json"
    } else {
        "opencodex-catalog.json"
    });
    let executable = std::env::current_exe().map_err(|_| "Could not locate Notch")?;
    let prior_ownership = read_config_ownership(&dir)?;
    let preserved_before = match prior_ownership.as_ref() {
        Some(ownership) if before != ownership.installed => {
            restore_config_preserving_user_edits(&before, ownership)?
        }
        Some(ownership) => ownership.before.clone(),
        None => before.clone(),
    };
    let after = transform_config(&before, origin, &catalog_path, &executable)?;
    if let Some(catalog) = catalog {
        validate_catalog(catalog)?;
        atomic_write(
            &catalog_path,
            &serde_json::to_vec(catalog).map_err(|_| "Invalid catalog")?,
        )?;
    }
    let backup = dir.join("config.toml.before-notch");
    if !backup.exists() {
        atomic_write(&backup, before.as_bytes())?;
    }
    if fs::read_to_string(&path).unwrap_or_default() != before {
        return Err("Codex settings changed during connection; retry".into());
    }
    atomic_write(&path, after.as_bytes())?;
    let installed_ownership = if origin.is_some() {
        let ownership = ConfigOwnership {
            before: preserved_before,
            installed: after.clone(),
        };
        if let Err(error) = write_config_ownership(&dir, &ownership) {
            let _ = atomic_write(&path, before.as_bytes());
            return Err(error);
        }
        Some(ownership)
    } else {
        match fs::remove_file(config_ownership_path(&dir)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                let _ = atomic_write(&path, before.as_bytes());
                return Err("Could not remove Notch Codex configuration ownership".into());
            }
        }
        None
    };
    Ok(ConfigRollback {
        previous_config: before,
        previous_ownership: prior_ownership,
        installed_config: after,
        installed_ownership,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_data_keys_remain_server_issued_but_direct_keys_keep_ownership() {
        let legacy: DataKey = serde_json::from_str(r#"{"id":"old","key":"ocx_data_old"}"#).unwrap();
        assert!(legacy.server_issued);

        let direct = DataKey {
            id: String::new(),
            key: "ocx_viewer_friend".into(),
            server_issued: false,
        };
        let restored: DataKey =
            serde_json::from_str(&serde_json::to_string(&direct).unwrap()).unwrap();
        assert!(!restored.server_issued);
        assert!(restored.id.is_empty());
    }
    #[test]
    fn remote_routing_uses_the_builtin_openai_provider_and_loopback_relay() {
        let source = "model = \"test\"\n# Auto-injected by opencodex\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n[plugins.example]\nenabled = true\n";
        let output = transform_config(
            source,
            Some("https://ocx.example.com"),
            Path::new("C:\\catalog.json"),
            Path::new("C:\\Notch\\ocx-notch.exe"),
        )
        .unwrap();
        assert!(output.find("model_provider =").unwrap() < output.find("[plugins").unwrap());
        assert!(output.contains("[plugins.example]\nenabled = true"));
        assert!(output.contains("model_provider = \"openai\""));
        assert!(output.contains(&format!("openai_base_url = \"{RELAY_BASE_URL}\"")));
        // The custom provider stays defined so a conversation that already pinned
        // it still resolves; it must point at the relay and carry no secret
        // reference, because the relay injects the admission header.
        assert!(output.contains("[model_providers.ocx-notch]"));
        assert!(output.contains(&format!("base_url = \"{RELAY_BASE_URL}\"")));
        assert!(!output.contains("env_http_headers"));
        assert!(!output.contains("OPENCODEX_NOTCH_API_AUTH_TOKEN"));
        assert!(!output.contains("--codex-token"));
        let again = transform_config(
            &output,
            Some("https://ocx.example.com"),
            Path::new("C:\\catalog.json"),
            Path::new("C:\\Notch\\ocx-notch.exe"),
        )
        .unwrap();
        assert_eq!(again, output);
        let local = transform_config(
            &again,
            None,
            Path::new("local.json"),
            Path::new("notch.exe"),
        )
        .unwrap();
        assert!(local.contains("model_provider = \"openai\""));
        assert!(local.contains("openai_base_url = \"http://127.0.0.1:10100/v1\""));
        assert!(!local.contains("[model_providers.ocx-notch]"));
        assert!(!local.contains(BEGIN));
        assert!(!local.contains("--codex-token"));
    }

    #[test]
    fn reconnect_migrates_the_owned_custom_provider_block_to_the_relay() {
        let source = format!(
            "model_provider = \"ocx-notch\"\n\n{BEGIN}\n[model_providers.ocx-notch]\nname = \"OCX Notch\"\nbase_url = \"https://old.example/v1\"\nenv_http_headers = {{ \"x-opencodex-api-key\" = \"{ADMISSION_ENV_VAR}\" }}\n{END}\n"
        );
        let output = transform_config(
            &source,
            Some("https://new.example"),
            Path::new("catalog.json"),
            Path::new("notch.exe"),
        )
        .unwrap();

        assert!(output.contains("model_provider = \"openai\""));
        assert!(output.contains(&format!("openai_base_url = \"{RELAY_BASE_URL}\"")));
        assert!(!output.contains("https://old.example"));
        assert!(!output.contains(ADMISSION_ENV_VAR));
        assert_eq!(output.matches(BEGIN).count(), 1);
        assert_eq!(output.matches("[model_providers.ocx-notch]").count(), 1);
        assert!(output.contains(&format!(
            "[model_providers.ocx-notch]\nname = \"OCX Notch\"\nbase_url = \"{RELAY_BASE_URL}\""
        )));
    }
    #[test]
    fn remote_routing_stays_idempotent_for_root_only_and_crlf_configs() {
        for source in [
            "model = \"test\"\n",
            "model = \"test\"",
            "model = \"test\"\r\n",
        ] {
            let once = transform_config(
                source,
                Some("https://ocx.example.com"),
                Path::new("catalog.json"),
                Path::new("notch.exe"),
            )
            .unwrap();
            let twice = transform_config(
                &once,
                Some("https://ocx.example.com"),
                Path::new("catalog.json"),
                Path::new("notch.exe"),
            )
            .unwrap();
            let thrice = transform_config(
                &twice,
                Some("https://ocx.example.com"),
                Path::new("catalog.json"),
                Path::new("notch.exe"),
            )
            .unwrap();

            assert_eq!(
                twice, once,
                "remote transform is not idempotent for {source:?}"
            );
            assert_eq!(thrice, twice, "remote transform accumulates for {source:?}");
            assert_eq!(once.matches(BEGIN).count(), 1);
            if source.contains("\r\n") {
                assert!(once.contains("\r\n"));
            }
        }
    }

    #[test]
    fn refuses_ambiguous_config_before_writing() {
        for source in [
            "profile = \"custom\"",
            "openai_base_url = '''multiline\n'''",
            BEGIN,
            "[model_providers.ocx-notch]\nname='user'",
        ] {
            assert!(transform_config(
                source,
                Some("https://example.com"),
                Path::new("catalog"),
                Path::new("notch")
            )
            .is_err());
        }
        assert!(validate_catalog(&serde_json::json!({"models":[]})).is_err());
    }
    #[test]
    fn config_restore_preserves_unrelated_user_edits_and_can_roll_back_exactly() {
        let root = std::env::temp_dir().join(format!(
            "ocx-notch-config-ownership-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let ownership = ConfigOwnership {
            before: "model = \"original\"\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n".into(),
            installed: format!(
                "model = \"original\"\nmodel_provider = \"ocx-notch\"\n\n{BEGIN}\n[model_providers.ocx-notch]\nbase_url = \"https://old.example/v1\"\n{END}\n"
            ),
        };
        write_config_ownership(&root, &ownership).unwrap();
        let user_edited = ownership
            .installed
            .replace("model = \"original\"", "model = \"user-edit\"");
        fs::write(root.join("config.toml"), &user_edited).unwrap();
        let restore = preflight_config_restore_in(&root).unwrap();
        let rollback = restore_owned_config_in(&root, &restore).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("config.toml")).unwrap(),
            "model = \"user-edit\"\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n"
        );
        rollback_config_update_in(&root, &rollback).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("config.toml")).unwrap(),
            user_edited
        );

        fs::write(root.join("config.toml"), &ownership.installed).unwrap();
        let restore = preflight_config_restore_in(&root).unwrap();
        let rollback = restore_owned_config_in(&root, &restore).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("config.toml")).unwrap(),
            ownership.before
        );
        assert!(read_config_ownership(&root).unwrap().is_none());

        rollback_config_update_in(&root, &rollback).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("config.toml")).unwrap(),
            ownership.installed
        );
        assert_eq!(
            read_config_ownership(&root).unwrap().unwrap().before,
            ownership.before
        );

        let restore = preflight_config_restore_in(&root).unwrap();
        let rollback = restore_owned_config_in(&root, &restore).unwrap();
        fs::write(root.join("config.toml"), "model = \"concurrent-edit\"\n").unwrap();
        assert!(rollback_config_update_in(&root, &rollback).is_err());
        assert_eq!(
            fs::read_to_string(root.join("config.toml")).unwrap(),
            "model = \"concurrent-edit\"\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn config_restore_rejects_edits_to_notch_owned_routing() {
        let ownership = ConfigOwnership {
            before: "model_provider = \"openai\"\n".into(),
            installed: "model_provider = \"ocx-notch\"\n".into(),
        };
        for changed in [
            "model_provider = \"other\"\n",
            "model_provider = \"ocx-notch\"\nopenai_base_url = \"https://other.example/v1\"\n",
        ] {
            assert!(restore_config_preserving_user_edits(changed, &ownership).is_err());
        }
    }
    #[test]
    fn catalog_sync_uses_the_configured_root_path() {
        let root = std::env::temp_dir().join(format!(
            "ocx-notch-catalog-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        fs::write(
            root.join("config.toml"),
            "model_catalog_json = \"nested/catalog.json\"\n[model_providers.ocx-vm]\nmodel_catalog_json = \"ignored.json\"\n",
        )
        .unwrap();
        assert_eq!(
            configured_catalog_path(&root).unwrap(),
            root.join("nested/catalog.json")
        );

        fs::write(
            root.join("config.toml"),
            "model_provider = 'ocx-vm'\nmodel_catalog_json = 'legacy.json'\n",
        )
        .unwrap();
        assert_eq!(
            configured_catalog_path(&root).unwrap(),
            root.join("legacy.json")
        );

        fs::write(root.join("config.toml"), "model_provider = \"ocx-notch\"\n").unwrap();
        assert_eq!(
            configured_catalog_path(&root).unwrap(),
            root.join("ocx-notch-catalog.json")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cpu_uses_interval_and_rejects_restart_or_invalid_counters() {
        use crate::model::HostCpu;
        let previous = HostCpu {
            idle: 100,
            total: 200,
        };
        assert_eq!(
            HostCpu {
                idle: 150,
                total: 300
            }
            .percent_since(previous),
            Some(50.0)
        );
        assert!(previous.percent_since(previous).is_none());
        assert!(HostCpu { idle: 0, total: 0 }
            .percent_since(previous)
            .is_none());
        assert!(HostCpu {
            idle: 400,
            total: 300
        }
        .percent_since(previous)
        .is_none());
    }
}
