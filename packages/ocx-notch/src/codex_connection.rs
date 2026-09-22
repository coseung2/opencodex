//! Local Codex routing owned by Notch. Long-lived ownership metadata stays in
//! the Windows vault; Codex receives the remote admission key through the
//! current user's environment because it must keep its own ChatGPT bearer.
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
const PROVIDER: &str = "ocx-notch";
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

pub fn install_admission_environment(key: &str) -> Result<EnvironmentRollback, String> {
    connection::validate_token(key)?;
    let previous_value = read_user_environment_value()?;
    let previous_ownership = connection::read_secret(ENV_OWNERSHIP_TARGET)?;
    let preserved_baseline = previous_ownership
        .as_deref()
        .and_then(|value| serde_json::from_str::<EnvironmentOwnership>(value).ok())
        .filter(|ownership| {
            previous_value.as_ref().map(|value| value.value.as_str())
                == Some(ownership.installed.as_str())
        })
        .and_then(|ownership| ownership.previous);
    let ownership = EnvironmentOwnership {
        previous: preserved_baseline.or_else(|| previous_value.clone()),
        installed: key.to_string(),
    };
    let installed = EnvironmentValue {
        value: key.to_string(),
        expandable: false,
    };
    write_user_environment_value(Some(&installed))?;
    let encoded = serde_json::to_string(&ownership)
        .map_err(|_| "Could not encode Codex admission ownership")?;
    if let Err(error) = save_environment_ownership(Some(&encoded)) {
        let _ = write_user_environment_value(previous_value.as_ref());
        return Err(error);
    }
    Ok(EnvironmentRollback {
        previous_value,
        previous_ownership,
        installed_value: Some(installed),
        installed_ownership: Some(encoded),
    })
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

fn preflight_config_restore_in(dir: &Path) -> Result<ConfigRestore, String> {
    let ownership =
        read_config_ownership(dir)?.ok_or("Notch has no saved Codex configuration to restore")?;
    let current = fs::read_to_string(dir.join("config.toml"))
        .map_err(|_| "Could not read Codex config.toml")?;
    if current != ownership.installed {
        return Err("Codex settings changed after Notch connected; reconnect or restore config.toml.before-notch before disconnecting".into());
    }
    Ok(ConfigRestore {
        before: ownership.before.clone(),
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
    let mut lines = Vec::new();
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
    let provider = if origin.is_some() { PROVIDER } else { "openai" };
    output.push_str(&format!(
        "\nmodel_provider = {}\nmodel_catalog_json = {}\n",
        quote(provider),
        quote(&catalog.to_string_lossy())
    ));
    if origin.is_none() {
        output.push_str("openai_base_url = \"http://127.0.0.1:10100/v1\"\n");
    }
    output.push_str(&lines[root_end..].join("\n"));
    if let Some(origin) = origin {
        output.push_str(&format!("\n\n{BEGIN}\n[model_providers.{PROVIDER}]\nname = \"OCX Notch\"\nbase_url = {}\nwire_api = \"responses\"\nrequires_openai_auth = true\nenv_http_headers = {{ \"x-opencodex-api-key\" = \"{ADMISSION_ENV_VAR}\" }}\nsupports_websockets = false\n{END}\n", quote(&format!("{origin}/v1"))));
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
    if let Some(ownership) = prior_ownership.as_ref() {
        if before != ownership.installed {
            return Err("Codex settings changed while managed by Notch; restore or disconnect them before reconnecting".into());
        }
    }
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
            before: prior_ownership
                .as_ref()
                .map_or_else(|| before.clone(), |ownership| ownership.before.clone()),
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
    fn routing_stays_at_root_and_preserves_other_settings() {
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
        assert!(!output.contains("127.0.0.1"));
        assert!(output.contains("requires_openai_auth = true"));
        assert!(output.contains("OPENCODEX_NOTCH_API_AUTH_TOKEN"));
        assert!(!output.contains("--codex-token"));
        let again = transform_config(
            &output,
            Some("https://ocx.example.com"),
            Path::new("C:\\catalog.json"),
            Path::new("C:\\Notch\\ocx-notch.exe"),
        )
        .unwrap();
        assert_eq!(again.matches("[model_providers.ocx-notch]").count(), 1);
        let local = transform_config(
            &again,
            None,
            Path::new("local.json"),
            Path::new("notch.exe"),
        )
        .unwrap();
        assert!(local.contains("model_provider = \"openai\""));
        assert!(!local.contains("--codex-token"));
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
    fn config_restore_rejects_user_edits_and_can_roll_back_exactly() {
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
            before: "model = \"original\"\n".into(),
            installed: "model_provider = \"ocx-notch\"\n".into(),
        };
        write_config_ownership(&root, &ownership).unwrap();
        fs::write(root.join("config.toml"), "model = \"user-edit\"\n").unwrap();
        assert!(preflight_config_restore_in(&root).is_err());

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
