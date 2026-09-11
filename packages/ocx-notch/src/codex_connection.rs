//! Local Codex routing owned by Notch. Credentials stay in the Windows vault.
use crate::api::connection::{self, Profile};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const BEGIN: &str = "# BEGIN OCX NOTCH PROVIDER";
const END: &str = "# END OCX NOTCH PROVIDER";
const PROVIDER: &str = "ocx-notch";

#[derive(Serialize, Deserialize)]
pub struct DataKey {
    pub id: String,
    pub key: String,
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

/// Only single-line root routing keys are changed. Tables and other content are
/// retained verbatim. Unusual multiline routing values fail before any write.
pub fn transform_config(
    input: &str,
    origin: Option<&str>,
    catalog: &Path,
    executable: &Path,
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
        output.push_str(&format!("\n\n{BEGIN}\n[model_providers.{PROVIDER}]\nname = \"OCX Notch\"\nbase_url = {}\nwire_api = \"responses\"\nsupports_websockets = false\n[model_providers.{PROVIDER}.auth]\ncommand = {}\nargs = [\"--codex-token\", {}]\nrefresh_interval_ms = 1000\ntimeout_ms = 5000\n{END}\n", quote(&format!("{origin}/v1")), quote(&executable.to_string_lossy()), quote(origin)));
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

pub fn sync_catalog(profile: &Profile, catalog: &Value) -> Result<(), String> {
    validate_catalog(catalog)?;
    if read_mode() != "remote" {
        return Ok(());
    }
    if connection::saved_profile()?.is_none_or(|p| p.endpoint != profile.endpoint) {
        return Ok(());
    }
    atomic_write(
        &codex_dir()?.join("ocx-notch-catalog.json"),
        &serde_json::to_vec(catalog).map_err(|_| "Invalid catalog")?,
    )
}

pub fn configure(origin: Option<&str>, catalog: Option<&Value>) -> Result<String, String> {
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
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(!output.contains("requires_openai_auth"));
        assert!(output.contains("--codex-token"));
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
