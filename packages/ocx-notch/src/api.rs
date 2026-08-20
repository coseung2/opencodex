use crate::model::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::ffi::c_void;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use windows::core::{w, PCWSTR};
use windows::Win32::Networking::WinHttp::*;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 10100;

struct InternetHandle(*mut c_void);

impl Drop for InternetHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

pub fn get_json<T: DeserializeOwned>(path: &str, timeout_ms: i32) -> Result<T, String> {
    let body = request("GET", path, None, timeout_ms)?;
    serde_json::from_slice(&body).map_err(|error| format!("Invalid OCX response: {error}"))
}

pub fn post_json<T: DeserializeOwned>(
    path: &str,
    value: &impl serde::Serialize,
) -> Result<T, String> {
    let body = serde_json::to_vec(value).map_err(|error| format!("Invalid request: {error}"))?;
    let response = request("POST", path, Some(&body), 20_000)?;
    serde_json::from_slice(&response).map_err(|error| format!("Invalid OCX response: {error}"))
}

pub fn post_empty(path: &str, value: &impl serde::Serialize) -> Result<(), String> {
    let body = serde_json::to_vec(value).map_err(|error| format!("Invalid request: {error}"))?;
    request("POST", path, Some(&body), 20_000).map(|_| ())
}

pub fn post_raw(path: &str, body: &[u8]) -> Result<(), String> {
    request("POST", path, Some(body), 20_000).map(|_| ())
}

pub fn valid_provider_name(provider: &str) -> bool {
    !provider.is_empty()
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn set_auto_switch_threshold(threshold: u32) -> Result<(), String> {
    let body = format!("{{\"threshold\":{threshold}}}");
    request(
        "PUT",
        "/api/codex-auth/auto-switch",
        Some(body.as_bytes()),
        10_000,
    )?;
    Ok(())
}

pub fn set_codex_account_paused(id: &str, paused: bool) -> Result<(), String> {
    let body = serde_json::json!({ "id": id, "paused": paused }).to_string();
    request(
        "PUT",
        "/api/codex-auth/accounts/pause",
        Some(body.as_bytes()),
        10_000,
    )?;
    Ok(())
}

/// Pause or resume one OAuth pool account (kiro, anthropic, xai, ...).
pub fn set_oauth_account_paused(provider: &str, id: &str, paused: bool) -> Result<(), String> {
    let body = serde_json::json!({
        "provider": provider,
        "accountId": id,
        "paused": paused,
    })
    .to_string();
    request(
        "PUT",
        "/api/oauth/accounts/pause",
        Some(body.as_bytes()),
        10_000,
    )?;
    Ok(())
}

pub fn run_ocx_command(action: &str) -> Result<(), String> {
    let action = match action {
        "start" | "stop" => action,
        _ => return Err("Invalid OCX action".into()),
    };
    let command = format!("ocx {action}");
    Command::new("cmd.exe")
        .args(["/D", "/S", "/C", command.as_str()])
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| format!("Could not launch ocx {action}"))?;
    Ok(())
}

pub fn stop_ocx() -> Result<(), String> {
    match request("POST", "/api/stop", None, 2_000) {
        Ok(_) => Ok(()),
        Err(error) if error.contains("HTTP 404") || error.contains("HTTP 405") => {
            run_ocx_command("stop")
        }
        Err(error) => Err(error),
    }
}

fn request(
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout_ms: i32,
) -> Result<Vec<u8>, String> {
    unsafe {
        let session = InternetHandle(valid_handle(WinHttpOpen(
            w!("OCX Notch/0.1"),
            // OCX is a fixed loopback service. Keep management requests off any
            // automatically discovered system proxy.
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?);
        WinHttpSetTimeouts(session.0, timeout_ms, timeout_ms, timeout_ms, timeout_ms)
            .map_err(win_error)?;

        let host = wide(HOST);
        let connection = InternetHandle(valid_handle(WinHttpConnect(
            session.0,
            PCWSTR(host.as_ptr()),
            PORT,
            0,
        ))?);
        let method = wide(method);
        let path = wide(path);
        let request = InternetHandle(valid_handle(WinHttpOpenRequest(
            connection.0,
            PCWSTR(method.as_ptr()),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_OPEN_REQUEST_FLAGS(0),
        ))?);

        let mut headers =
            String::from("Origin: http://127.0.0.1:10100\r\nAccept: application/json\r\n");
        if body.is_some() {
            headers.push_str("Content-Type: application/json\r\n");
        }
        if let Some(token) = management_token() {
            headers.push_str("X-OpenCodex-API-Key: ");
            headers.push_str(&token);
            headers.push_str("\r\n");
        }
        let headers = wide(&headers);
        WinHttpAddRequestHeaders(
            request.0,
            &headers[..headers.len() - 1],
            WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
        )
        .map_err(win_error)?;
        let body = body.unwrap_or_default();
        let body_ptr = (!body.is_empty()).then_some(body.as_ptr().cast::<c_void>());
        WinHttpSendRequest(
            request.0,
            None,
            body_ptr,
            body.len() as u32,
            body.len() as u32,
            0,
        )
        .map_err(win_error)?;
        WinHttpReceiveResponse(request.0, std::ptr::null_mut()).map_err(win_error)?;

        let mut status = 0u32;
        let mut status_size = std::mem::size_of::<u32>() as u32;
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some((&mut status as *mut u32).cast::<c_void>()),
            &mut status_size,
            std::ptr::null_mut(),
        )
        .map_err(win_error)?;
        let mut body = Vec::new();
        const MAX_BODY: usize = 1024 * 1024;
        loop {
            let mut available = 0u32;
            WinHttpQueryDataAvailable(request.0, &mut available).map_err(win_error)?;
            if available == 0 {
                break;
            }
            let start = body.len();
            if start.saturating_add(available as usize) > MAX_BODY {
                return Err("OCX response was too large".into());
            }
            body.resize(start + available as usize, 0);
            let mut read = 0u32;
            WinHttpReadData(
                request.0,
                body[start..].as_mut_ptr().cast::<c_void>(),
                available,
                &mut read,
            )
            .map_err(win_error)?;
            body.truncate(start + read as usize);
        }
        if !(200..300).contains(&status) {
            return Err(http_error(status, &body));
        }
        Ok(body)
    }
}

fn http_error(status: u32, body: &[u8]) -> String {
    let detail = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| value.replace(['\r', '\n'], " "))
        .map(|value| value.chars().take(512).collect::<String>());
    match detail {
        Some(detail) => format!("OCX returned HTTP {status}: {detail}"),
        None => format!("OCX returned HTTP {status}"),
    }
}

fn management_token() -> Option<String> {
    // OPENCODEX_API_AUTH_TOKEN protects the data plane and is deliberately not an
    // admin credential. Treating it as one hides every management-backed Notch
    // surface whenever that legacy variable is present.
    if let Ok(token) = std::env::var("OPENCODEX_ADMIN_AUTH_TOKEN") {
        let token = token.trim();
        if !token.is_empty() && !token.contains(['\r', '\n']) {
            return Some(token.to_string());
        }
    }
    let explicit = std::env::var_os("OPENCODEX_HOME").map(PathBuf::from);
    let profile_default = std::env::var_os("USERPROFILE")
        .map(|home| PathBuf::from(home).join(".opencodex"));
    management_token_from_dirs(explicit.as_deref(), profile_default.as_deref())
}

fn management_token_from_dirs(explicit: Option<&Path>, profile_default: Option<&Path>) -> Option<String> {
    let mut dirs = Vec::with_capacity(2);
    if let Some(path) = explicit {
        dirs.push(path);
    }
    if let Some(path) = profile_default {
        if !dirs.iter().any(|candidate| candidate == &path) {
            dirs.push(path);
        }
    }
    for dir in dirs {
        let Ok(token) = fs::read_to_string(dir.join("admin-api-token")) else {
            continue;
        };
        let token = token.trim().trim_start_matches('\u{feff}');
        if token.starts_with("ocx_admin_") && !token.contains(['\r', '\n']) {
            return Some(token.to_string());
        }
    }
    None
}

fn win_error(error: windows::core::Error) -> String {
    format!("OCX unavailable: {}", error.message())
}

fn valid_handle(handle: *mut c_void) -> Result<*mut c_void, String> {
    if handle.is_null() {
        Err(win_error(windows::core::Error::from_win32()))
    } else {
        Ok(handle)
    }
}

pub fn fetch_account_pool(config: &ProviderConfig) -> AccountPool {
    if config.name == "openai" {
        return fetch_codex_account_pool().unwrap_or_else(|_| AccountPool {
            provider: config.name.clone(),
            accounts: Vec::new(),
        });
    }

    let mode = config.auth_mode.as_deref().unwrap_or_default();
    let kind = if mode == "oauth" { "oauth" } else { "key" };
    let path = match mode {
        "oauth" => format!(
            "/api/oauth/accounts?provider={}",
            encode_component(&config.name)
        ),
        // Registry-seeded key providers may omit authMode entirely; the server
        // treats a missing mode as API-key auth (isKeyAuthProvider), so the
        // masked keys must show up here too.
        "key" | "" => format!(
            "/api/providers/keys?name={}",
            encode_component(&config.name)
        ),
        _ => {
            return AccountPool {
                provider: config.name.clone(),
                accounts: Vec::new(),
            }
        }
    };
    let value = match get_json::<Value>(&path, 20_000) {
        Ok(value) => value,
        Err(_) => {
            return AccountPool {
                provider: config.name.clone(),
                accounts: Vec::new(),
            }
        }
    };
    parse_account_pool_value(config.name.clone(), kind, &value)
}

fn parse_account_pool_value(provider: String, kind: &str, value: &Value) -> AccountPool {
    let active_id = value
        .get("activeAccountId")
        .or_else(|| value.get("activeId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let accounts = value
        .get("accounts")
        .or_else(|| value.get("keys"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|account| {
            let id = account.get("id")?.as_str()?.to_string();
            let identity = account
                .get("label")
                .or_else(|| account.get("masked"))
                .or_else(|| account.get("email"))
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            let active = account
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || id == active_id;
            let health = account
                .get("healthLabel")
                .or_else(|| account.get("healthSummary"))
                .and_then(Value::as_str)
                .unwrap_or(if active { "Active" } else { "Available" })
                .to_string();
            let quota = account
                .get("quota")
                .and_then(|value| serde_json::from_value::<Quota>(value.clone()).ok());
            Some(AccountView {
                id,
                identity,
                kind: kind.to_string(),
                active,
                health,
                quota,
                paused: account
                    .get("paused")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                needs_reauth: account
                    .get("needsReauth")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                is_main: false,
            })
        })
        .collect();
    AccountPool { provider, accounts }
}

/// Make one account the active account for its provider. `kind` is the account's
/// auth kind ("codex" | "oauth" | "key"), which selects the matching endpoint.
pub fn set_active_account(provider: &str, kind: &str, id: &str) -> Result<(), String> {
    let (path, body) = match kind {
        "codex" => (
            "/api/codex-auth/active",
            serde_json::json!({ "accountId": id }),
        ),
        "oauth" => (
            "/api/oauth/accounts/active",
            serde_json::json!({ "provider": provider, "accountId": id }),
        ),
        "key" => (
            "/api/providers/keys/active",
            serde_json::json!({ "name": provider, "id": id }),
        ),
        _ => return Err("Unknown account kind".into()),
    };
    let body = body.to_string();
    request("PUT", path, Some(body.as_bytes()), 10_000)?;
    Ok(())
}

pub fn fetch_codex_account_pool() -> Result<AccountPool, String> {
    let accounts = get_json::<CodexAccountsResponse>("/api/codex-auth/accounts", 20_000)
        .map(codex_account_views)?;
    Ok(AccountPool {
        provider: "openai".into(),
        accounts,
    })
}

pub fn encode_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn provider_names_allow_only_single_safe_path_components() {
        assert!(valid_provider_name("openai-compatible_1.2"));
        assert!(!valid_provider_name(""));
        assert!(!valid_provider_name("../openai"));
        assert!(!valid_provider_name("openai/other"));
        assert!(!valid_provider_name("openai?admin=true"));
    }

    #[test]
    fn provider_query_components_are_percent_encoded() {
        assert_eq!(encode_component("x ai/한"), "x%20ai%2F%ED%95%9C");
    }

    #[test]
    fn generic_pool_parsing_preserves_active_identity_and_reauth_state() {
        let value = serde_json::json!({
            "activeAccountId": "second",
            "accounts": [
                {"id": "first", "masked": "fir***@example.com", "paused": true},
                {
                    "id": "second",
                    "label": "work",
                    "needsReauth": true,
                    "healthLabel": "Reauth required"
                }
            ]
        });

        let pool = parse_account_pool_value("kiro".into(), "oauth", &value);

        assert_eq!(pool.provider, "kiro");
        assert_eq!(pool.accounts[0].identity, "fir***@example.com");
        assert_eq!(pool.accounts[0].kind, "oauth");
        assert_eq!(pool.accounts[1].kind, "oauth");
        assert!(!pool.accounts[0].active);
        assert!(pool.accounts[0].paused);
        assert!(!pool.accounts[1].paused);
        assert_eq!(pool.accounts[1].identity, "work");
        assert!(pool.accounts[1].active);
        assert!(pool.accounts[1].needs_reauth);
        assert_eq!(pool.accounts[1].health, "Reauth required");
    }

    #[test]
    fn http_errors_keep_status_and_safe_bounded_json_detail() {
        assert_eq!(
            http_error(409, br#"{"error":"login already in progress"}"#),
            "OCX returned HTTP 409: login already in progress"
        );
        assert_eq!(
            http_error(503, br#"{"message":"retry\r\nsoon"}"#),
            "OCX returned HTTP 503: retry  soon"
        );
        assert_eq!(http_error(500, b"not json"), "OCX returned HTTP 500");
        let long = format!(r#"{{"error":"{}"}}"#, "x".repeat(600));
        assert_eq!(http_error(400, long.as_bytes()).len(), 23 + 512);
    }

    #[test]
    fn management_token_falls_back_from_stale_explicit_home_to_profile() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ocx-notch-token-{suffix}"));
        let stale = root.join("stale");
        let profile = root.join("profile");
        fs::create_dir_all(&stale).expect("stale dir");
        fs::create_dir_all(&profile).expect("profile dir");
        fs::write(profile.join("admin-api-token"), "\u{feff}ocx_admin_profile-token\n")
            .expect("token");

        let token = management_token_from_dirs(Some(&stale), Some(&profile));

        assert_eq!(token.as_deref(), Some("ocx_admin_profile-token"));
        fs::remove_dir_all(root).expect("cleanup");
    }
}
