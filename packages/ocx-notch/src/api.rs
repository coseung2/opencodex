use crate::model::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::ffi::c_void;
use std::fs;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use windows::core::{w, PCWSTR};
use windows::Win32::Networking::WinHttp::*;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

// The connection profile lives beside this file; declaring it here keeps the
// transport self-contained instead of spreading remote-mode plumbing into main.
#[path = "connection.rs"]
pub mod connection;

use connection::{Connection, Endpoint, Profile};

thread_local! {
    static POLL_TARGET: std::cell::RefCell<Option<(u64, Connection)>> = const { std::cell::RefCell::new(None) };
}
pub fn begin_poll() {
    POLL_TARGET
        .with(|slot| *slot.borrow_mut() = Some((connection::generation(), connection::active())));
}
pub fn poll_generation() -> u64 {
    POLL_TARGET.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or_else(connection::generation, |(generation, _)| *generation)
    })
}

/// Where one management request is sent, and the credential it carries.
/// Snapshotted per request so a connection change mid-flight cannot mix a
/// remote endpoint with a local credential (or the reverse).
struct Target {
    endpoint: Endpoint,
    token: Option<String>,
}

fn active_target() -> Result<Target, String> {
    let active = POLL_TARGET
        .with(|slot| slot.borrow().as_ref().map(|(_, active)| active.clone()))
        .unwrap_or_else(connection::active);
    if poll_generation() != connection::generation() {
        return Err("Connection changed".into());
    }
    match active {
        // Remote mode never consults local environment variables or the local
        // admin-token file: the VM credential is the only accepted credential.
        Connection::Remote(profile) => Ok(Target {
            endpoint: profile.endpoint,
            token: Some(profile.token),
        }),
        Connection::Local => Ok(Target {
            endpoint: connection::local_endpoint(),
            token: management_token(),
        }),
        // A stored-but-unusable profile fails closed. Serving local data here
        // would silently point remote controls at this machine's OCX.
        Connection::Unavailable { reason, .. } => Err(reason),
    }
}

/// True when Notch is pointed at a central OCX rather than the local process.
/// A stored profile that cannot be loaded still counts as remote, so power
/// controls stay withheld while the connection is broken.
pub fn is_remote() -> bool {
    !matches!(connection::active(), Connection::Local)
}

/// The management origin currently in use, for display and for the `Origin`
/// header. Never contains a credential.
pub fn connection_base_url() -> String {
    match connection::active() {
        Connection::Remote(profile) => profile.endpoint.base_url,
        Connection::Local => connection::LOCAL_BASE_URL.to_string(),
        Connection::Unavailable { base_url, .. } => {
            base_url.unwrap_or_else(|| "remote (unavailable)".to_string())
        }
    }
}

/// Why a stored remote connection is unusable, when it is. `None` in local mode
/// and when the profile loaded cleanly.
pub fn connection_error() -> Option<String> {
    match connection::active() {
        Connection::Unavailable { reason, .. } => Some(reason),
        _ => None,
    }
}

/// Switch modes. `None`/`None` returns to local mode; otherwise both the
/// address and the token are required. A remote profile is probed before it is
/// committed, so a failed update leaves the previous profile untouched.
pub fn save_connection(base_url: Option<&str>, token: Option<&str>) -> Result<(), String> {
    let (Some(base_url), Some(token)) = (base_url, token) else {
        if base_url.is_some() || token.is_some() {
            return Err("Remote mode needs both a server address and a token".into());
        }
        let before = crate::codex_connection::configure(None, None)?;
        if let Err(error) = connection::clear() {
            crate::codex_connection::atomic_write(
                &crate::codex_connection::codex_dir()?.join("config.toml"),
                before.as_bytes(),
            )?;
            return Err(error);
        }
        return Ok(());
    };
    let endpoint = connection::parse_endpoint(base_url)?;
    let token = if token.trim().is_empty() {
        connection::saved_profile()?
            .filter(|p| p.endpoint == endpoint)
            .map(|p| p.token)
            .ok_or("Enter the management token for this server")?
    } else {
        token.trim().to_string()
    };
    connection::validate_token(&token)?;
    let profile = Profile { endpoint, token };
    probe_profile(&profile)?;
    let target = Target {
        endpoint: profile.endpoint.clone(),
        token: Some(profile.token.clone()),
    };
    let catalog: Value =
        serde_json::from_slice(&request_to(&target, "GET", "/api/catalog", None, 30_000)?)
            .map_err(|_| "Invalid remote Codex catalog")?;
    crate::codex_connection::validate_catalog(&catalog)?;
    let origin = &profile.endpoint.base_url;
    let stored = crate::codex_connection::load_key(origin)?;
    let stored = if let Some(key) = stored {
        connection::validate_token(&key.key)?;
        let data = Target {
            endpoint: profile.endpoint.clone(),
            token: Some(key.key.clone()),
        };
        match request_to(&data, "GET", "/v1/models", None, 10_000) {
            Ok(_) => Some(key),
            Err(error) if is_http_status(&error, 401) => None,
            Err(_) => return Err("Could not verify the existing Codex connection; retry when the server is reachable".into()),
        }
    } else {
        None
    };
    let key = if let Some(key) = stored {
        key
    } else {
        let body = br#"{"name":"OCX Notch Codex"}"#;
        let key: crate::codex_connection::DataKey = serde_json::from_slice(&request_to(
            &target,
            "POST",
            "/api/keys",
            Some(body),
            10_000,
        )?)
        .map_err(|_| "Invalid Codex credential response")?;
        // Persist before any later step can fail, so retry reuses this key.
        connection::validate_token(&key.key)?;
        if let Err(error) = crate::codex_connection::save_key(origin, &key) {
            let body = serde_json::to_vec(&serde_json::json!({"id":key.id})).unwrap();
            let cleanup = request_to(&target, "DELETE", "/api/keys", Some(&body), 10_000);
            return Err(if cleanup.is_err() {
                format!("{error}; remove the unused OCX Notch Codex key on the server")
            } else {
                error
            });
        }
        key
    };
    let data = Target {
        endpoint: profile.endpoint.clone(),
        token: Some(key.key),
    };
    connection::validate_token(data.token.as_deref().unwrap_or_default())?;
    request_to(&data, "GET", "/v1/models", None, 10_000)
        .map_err(|_| "The server rejected the Codex data credential")?;
    // An empty request must reach Responses validation without running a model.
    // GET /models alone cannot prove the distinct Responses admission path works.
    match request_to_with_bearer(&data, "POST", "/v1/responses", Some(b"{}"), 10_000, true) {
        Err(error) if is_http_status(&error, 400) || is_http_status(&error, 422) => {},
        _ => return Err("The server must translate Codex bearer authentication into the OCX data header before connecting".into()),
    }
    let previous_config = crate::codex_connection::configure(Some(origin), Some(&catalog))?;
    if let Err(error) = connection::commit(profile) {
        crate::codex_connection::atomic_write(
            &crate::codex_connection::codex_dir()?.join("config.toml"),
            previous_config.as_bytes(),
        )
        .map_err(|_| "Could not restore Codex configuration after a failed connection")?;
        return Err(error);
    }
    Ok(())
}

pub fn disconnect_codex() -> Result<(), String> {
    let profile = connection::saved_profile()?.ok_or("No remote OCX is saved")?;
    if let Some(key) = crate::codex_connection::load_key(&profile.endpoint.base_url)? {
        let target = Target {
            endpoint: profile.endpoint.clone(),
            token: Some(profile.token.clone()),
        };
        let body = serde_json::to_vec(&serde_json::json!({"id":key.id})).unwrap();
        match request_to(&target, "DELETE", "/api/keys", Some(&body), 10_000) {
            Ok(_) => {}
            Err(error) if is_http_status(&error, 404) => {}
            Err(_) => {
                return Err(
                    "Could not revoke the Codex connection on the server; reconnect and retry"
                        .into(),
                )
            }
        }
        connection::delete_secret(&crate::codex_connection::key_target(
            &profile.endpoint.base_url,
        ))?;
    }
    crate::codex_connection::configure(Some("http://127.0.0.1:9"), None)?;
    connection::disconnect()
}

pub fn sync_codex_catalog() -> Result<(), String> {
    if let Connection::Remote(profile) = connection::active() {
        let target = Target {
            endpoint: profile.endpoint.clone(),
            token: Some(profile.token.clone()),
        };
        let catalog: Value =
            serde_json::from_slice(&request_to(&target, "GET", "/api/catalog", None, 30_000)?)
                .map_err(|_| "Invalid remote Codex catalog")?;
        crate::codex_connection::sync_catalog(&profile, &catalog)?;
    }
    Ok(())
}

/// Install a connection profile without ever placing the token on a command
/// line: the caller passes the address, the token is read from stdin.
pub fn save_connection_from_stdin(base_url: &str) -> Result<(), String> {
    let mut token = String::new();
    std::io::stdin()
        .read_to_string(&mut token)
        .map_err(|error| format!("Could not read the token from stdin: {error}"))?;
    let token = token.trim_end_matches(['\r', '\n']).trim();
    if token.is_empty() {
        return Err("No token was supplied on stdin".into());
    }
    save_connection(Some(base_url), Some(token))
}

/// Confirm the endpoint answers and the credential is accepted before the
/// profile replaces the working one. `/healthz` proves reachability;
/// `/api/system/memory` is management-gated, so it proves the credential.
fn probe_profile(profile: &Profile) -> Result<(), String> {
    let target = Target {
        endpoint: profile.endpoint.clone(),
        token: Some(profile.token.clone()),
    };
    request_to(&target, "GET", "/healthz", None, 8_000)
        .map_err(|error| format!("Could not reach {}: {error}", profile.endpoint.base_url))?;
    request_to(&target, "GET", "/api/system/memory", None, 8_000).map_err(|error| {
        if is_http_status(&error, 401) || is_http_status(&error, 403) {
            "The server rejected this management token".to_string()
        } else {
            error
        }
    })?;
    Ok(())
}

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

pub fn put_json<T: DeserializeOwned>(
    path: &str,
    value: &impl serde::Serialize,
) -> Result<T, String> {
    let body = serde_json::to_vec(value).map_err(|error| format!("Invalid request: {error}"))?;
    let response = request("PUT", path, Some(&body), 30_000)?;
    serde_json::from_slice(&response).map_err(|error| format!("Invalid OCX response: {error}"))
}

/// Which login surface a flow belongs to. Remote flows are always scoped by
/// `flowId` so one client can never relay into or cancel another's attempt.
#[derive(Clone, Copy)]
pub enum LoginFlow<'a> {
    Codex,
    Provider(&'a str),
}

/// Relay a completed browser callback back to the server that started the flow.
/// Remote servers accept only the full callback URL, never a bare code.
pub fn submit_login_callback(
    flow: LoginFlow<'_>,
    flow_id: &str,
    callback_url: &str,
) -> Result<(), String> {
    if flow_id.trim().is_empty() {
        return Err("This login flow has no identifier".into());
    }
    let (path, body) = match flow {
        LoginFlow::Codex => (
            "/api/codex-auth/login/code",
            serde_json::json!({ "flowId": flow_id, "callbackUrl": callback_url }),
        ),
        LoginFlow::Provider(provider) => (
            "/api/oauth/login/code",
            serde_json::json!({
                "provider": provider,
                "flowId": flow_id,
                "callbackUrl": callback_url,
            }),
        ),
    };
    post_empty(path, &body)
}

/// Cancel one login flow. `flow_id` is required in remote mode; locally a
/// missing id keeps the existing provider-wide cancellation behavior.
pub fn cancel_login_flow(flow: LoginFlow<'_>, flow_id: Option<&str>) -> Result<(), String> {
    let flow_id = flow_id.map(str::trim).filter(|value| !value.is_empty());
    if is_remote() && flow_id.is_none() {
        return Err("This login flow has no identifier".into());
    }
    let (path, body) = match flow {
        LoginFlow::Codex => (
            "/api/codex-auth/login/cancel",
            match flow_id {
                Some(flow_id) => serde_json::json!({ "flowId": flow_id }),
                None => serde_json::json!({}),
            },
        ),
        LoginFlow::Provider(provider) => (
            "/api/oauth/login/cancel",
            match flow_id {
                Some(flow_id) => serde_json::json!({ "provider": provider, "flowId": flow_id }),
                None => serde_json::json!({ "provider": provider }),
            },
        ),
    };
    post_empty(path, &body)
}

/// Status path for a provider login, flow-scoped when an id is known.
pub fn oauth_status_path(provider: &str, flow_id: Option<&str>) -> String {
    let mut path = format!("/api/oauth/status?provider={}", encode_component(provider));
    if let Some(flow_id) = flow_id.map(str::trim).filter(|value| !value.is_empty()) {
        path.push_str("&flowId=");
        path.push_str(&encode_component(flow_id));
    }
    path
}

/// Body for a Codex login start. `clientBrowser` is added in remote mode so the
/// VM hands the authorization URL back instead of opening its own browser.
pub fn codex_login_body(account_id: Option<&str>, reauth: bool) -> Value {
    let mut body = serde_json::Map::new();
    if let Some(account_id) = account_id {
        body.insert("id".into(), Value::String(account_id.to_string()));
    }
    if reauth {
        body.insert("reauth".into(), Value::Bool(true));
    }
    if is_remote() {
        body.insert("clientBrowser".into(), Value::Bool(true));
    }
    Value::Object(body)
}

/// Body for re-authenticating one existing OAuth pool account.
pub fn oauth_reauth_login_body(provider: &str, account_id: &str) -> Value {
    let mut body = serde_json::Map::new();
    body.insert("provider".into(), Value::String(provider.to_string()));
    body.insert("accountId".into(), Value::String(account_id.to_string()));
    body.insert("reauth".into(), Value::Bool(true));
    if is_remote() {
        body.insert("clientBrowser".into(), Value::Bool(true));
    }
    Value::Object(body)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthLoginRequest<'a> {
    pub provider: &'a str,
    pub add_account: bool,
    /// Only serialized in remote mode: the VM must not open a browser on itself.
    #[serde(skip_serializing_if = "is_false")]
    pub client_browser: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kiro_organization: Option<KiroOrganizationLoginRequest<'a>>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KiroOrganizationLoginRequest<'a> {
    pub start_url: &'a str,
    pub region: &'a str,
}

pub fn start_oauth_account_login<T: DeserializeOwned>(provider: &str) -> Result<T, String> {
    start_oauth_account_login_with_kiro_organization(provider, None)
}

pub fn start_oauth_account_login_with_kiro_organization<T: DeserializeOwned>(
    provider: &str,
    kiro_organization: Option<KiroOrganizationLoginRequest<'_>>,
) -> Result<T, String> {
    post_json(
        "/api/oauth/login",
        &OAuthLoginRequest {
            provider,
            add_account: true,
            client_browser: is_remote(),
            kiro_organization,
        },
    )
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

pub fn consume_reset_credit(account_id: &str) -> Result<ResetCreditConsumeResponse, String> {
    post_json(
        "/api/codex-auth/reset-credits/consume",
        &serde_json::json!({ "accountId": account_id }),
    )
}

pub fn fetch_reset_credits(account_id: &str) -> Result<ResetCreditsResponse, String> {
    get_json(
        &format!(
            "/api/codex-auth/reset-credits?accountId={}",
            encode_component(account_id)
        ),
        20_000,
    )
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
    // Remote mode owns no process on this machine. Start/Stop/Restart must not
    // silently act on a local OCX while the UI is pointed at the VM.
    if is_remote() {
        return Err("Power controls are unavailable while connected to a remote OCX".into());
    }
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
    if is_remote() {
        return Err("Power controls are unavailable while connected to a remote OCX".into());
    }
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
    request_to(&active_target()?, method, path, body, timeout_ms)
}

/// Headers for one management request. The `Origin` is always the exact origin
/// being addressed, so the server's origin check never sees a spoofed host.
fn request_headers(target: &Target, has_body: bool) -> String {
    let mut headers = format!(
        "Origin: {}\r\nAccept: application/json\r\n",
        target.endpoint.base_url
    );
    if has_body {
        headers.push_str("Content-Type: application/json\r\n");
    }
    if let Some(token) = &target.token {
        headers.push_str("X-OpenCodex-API-Key: ");
        headers.push_str(token);
        headers.push_str("\r\n");
    }
    headers
}

fn request_to(
    target: &Target,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout_ms: i32,
) -> Result<Vec<u8>, String> {
    request_to_with_bearer(target, method, path, body, timeout_ms, false)
}

fn request_to_with_bearer(
    target: &Target,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout_ms: i32,
    bearer: bool,
) -> Result<Vec<u8>, String> {
    unsafe {
        let session = InternetHandle(valid_handle(WinHttpOpen(
            w!("OCX Notch/0.1"),
            // Local OCX is loopback and a remote OCX is reached over the private
            // network; neither should traverse a discovered system proxy.
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ))?);
        WinHttpSetTimeouts(session.0, timeout_ms, timeout_ms, timeout_ms, timeout_ms)
            .map_err(win_error)?;

        let host = wide(&target.endpoint.host);
        let connection = InternetHandle(valid_handle(WinHttpConnect(
            session.0,
            PCWSTR(host.as_ptr()),
            target.endpoint.port,
            0,
        ))?);
        let method = wide(method);
        let path = wide(path);
        let flags = if target.endpoint.secure {
            WINHTTP_FLAG_SECURE
        } else {
            WINHTTP_OPEN_REQUEST_FLAGS(0)
        };
        let request = InternetHandle(valid_handle(WinHttpOpenRequest(
            connection.0,
            PCWSTR(method.as_ptr()),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        ))?);
        // A redirect would replay the credential against whatever host the
        // response names, so refuse to follow them at all.
        let disable_redirects = WINHTTP_DISABLE_REDIRECTS.to_le_bytes();
        WinHttpSetOption(
            Some(request.0),
            WINHTTP_OPTION_DISABLE_FEATURE,
            Some(&disable_redirects),
        )
        .map_err(win_error)?;

        let mut headers = request_headers(target, body.is_some());
        if bearer {
            headers = headers.replacen("X-OpenCodex-API-Key: ", "Authorization: Bearer ", 1);
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

pub fn is_http_status(error: &str, status: u32) -> bool {
    let prefix = format!("OCX returned HTTP {status}");
    error
        .strip_prefix(&prefix)
        .is_some_and(|remainder| remainder.is_empty() || remainder.starts_with(':'))
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
    let profile_default =
        std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".opencodex"));
    management_token_from_dirs(explicit.as_deref(), profile_default.as_deref())
}

fn management_token_from_dirs(
    explicit: Option<&Path>,
    profile_default: Option<&Path>,
) -> Option<String> {
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
        return fetch_codex_account_pool(false).unwrap_or_else(|_| AccountPool {
            provider: config.name.clone(),
            accounts: Vec::new(),
        });
    }

    let mode = config.auth_mode.as_deref().unwrap_or_default();
    let kind = if mode == "oauth" { "oauth" } else { "key" };
    let path = match mode {
        "oauth" => format!(
            "/api/oauth/accounts?provider={}&quota=1",
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

fn delete_account_path(provider: &str, kind: &str, id: &str) -> Result<String, String> {
    if id.is_empty() || id == "__main__" {
        return Err("This account cannot be removed".into());
    }
    let id = encode_component(id);
    let provider = encode_component(provider);
    match kind {
        "codex" => Ok(format!("/api/codex-auth/accounts?id={id}")),
        "oauth" => Ok(format!("/api/oauth/accounts?provider={provider}&id={id}")),
        "key" => Ok(format!("/api/providers/keys?name={provider}&id={id}")),
        _ => Err("Unknown account kind".into()),
    }
}

pub fn delete_account(provider: &str, kind: &str, id: &str) -> Result<(), String> {
    request(
        "DELETE",
        &delete_account_path(provider, kind, id)?,
        None,
        10_000,
    )?;
    Ok(())
}

pub fn fetch_codex_account_pool(refresh_quotas: bool) -> Result<AccountPool, String> {
    let path = if refresh_quotas {
        "/api/codex-auth/accounts?refresh=1"
    } else {
        "/api/codex-auth/accounts"
    };
    let accounts = get_json::<CodexAccountsResponse>(path, 20_000).map(codex_account_views)?;
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
    use connection::Connection;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// The connection snapshot is process-wide, so mode-dependent tests take
    /// turns and restore local mode afterwards.
    fn connection_guard() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        connection::override_active(Connection::Local);
        guard
    }

    fn remote_profile(base_url: &str, token: &str) -> Profile {
        Profile {
            endpoint: connection::parse_endpoint(base_url).expect("endpoint"),
            token: token.to_string(),
        }
    }

    #[test]
    fn local_mode_keeps_the_loopback_endpoint_and_origin() {
        let _guard = connection_guard();

        assert!(!is_remote());
        assert_eq!(connection_base_url(), "http://127.0.0.1:10100");
        assert!(connection_error().is_none());
        let target = active_target().expect("local target");
        assert_eq!(target.endpoint.host, "127.0.0.1");
        assert_eq!(target.endpoint.port, 10_100);
        assert!(!target.endpoint.secure);
        assert!(request_headers(&target, false).contains("Origin: http://127.0.0.1:10100\r\n"));
    }

    #[test]
    fn remote_requests_use_the_remote_origin_and_only_the_profile_credential() {
        let _guard = connection_guard();
        connection::override_active(Connection::Remote(remote_profile(
            "http://100.120.114.62:10100",
            "ocx_admin_remote",
        )));

        assert!(is_remote());
        assert_eq!(connection_base_url(), "http://100.120.114.62:10100");
        let target = active_target().expect("remote target");
        assert_eq!(target.endpoint.host, "100.120.114.62");
        assert_eq!(target.token.as_deref(), Some("ocx_admin_remote"));
        let headers = request_headers(&target, true);
        assert!(headers.contains("Origin: http://100.120.114.62:10100\r\n"));
        assert!(headers.contains("X-OpenCodex-API-Key: ocx_admin_remote\r\n"));
        assert!(headers.contains("Content-Type: application/json\r\n"));

        connection::override_active(Connection::Local);
    }

    #[test]
    fn an_unusable_stored_connection_fails_requests_instead_of_serving_local_data() {
        let _guard = connection_guard();
        connection::override_active(Connection::Unavailable {
            base_url: Some("http://100.120.114.62:10100".into()),
            reason: "The saved management token is unusable".into(),
        });

        assert!(is_remote());
        assert_eq!(connection_base_url(), "http://100.120.114.62:10100");
        assert_eq!(
            connection_error().as_deref(),
            Some("The saved management token is unusable")
        );
        assert_eq!(
            active_target().err().as_deref(),
            Some("The saved management token is unusable")
        );
        assert!(request("GET", "/healthz", None, 500).is_err());

        connection::override_active(Connection::Local);
    }

    #[test]
    fn remote_mode_refuses_every_power_action_without_a_local_fallback() {
        let _guard = connection_guard();
        connection::override_active(Connection::Remote(remote_profile(
            "http://100.120.114.62:10100",
            "ocx_admin_remote",
        )));

        for action in ["start", "stop", "restart"] {
            let error = run_ocx_command(action).expect_err("remote power action must be refused");
            assert!(error.contains("remote OCX"), "unexpected error: {error}");
        }
        let error = stop_ocx().expect_err("remote stop must be refused");
        assert!(error.contains("remote OCX"), "unexpected error: {error}");

        connection::override_active(Connection::Local);
    }

    #[test]
    fn login_bodies_request_the_client_browser_only_in_remote_mode() {
        let _guard = connection_guard();

        assert_eq!(
            codex_login_body(Some("acct"), true),
            serde_json::json!({"id": "acct", "reauth": true})
        );
        assert_eq!(
            serde_json::to_value(OAuthLoginRequest {
                provider: "kiro",
                add_account: true,
                client_browser: is_remote(),
                kiro_organization: None,
            })
            .unwrap(),
            serde_json::json!({"provider": "kiro", "addAccount": true})
        );

        connection::override_active(Connection::Remote(remote_profile(
            "http://100.120.114.62:10100",
            "ocx_admin_remote",
        )));

        assert_eq!(
            codex_login_body(None, false),
            serde_json::json!({"clientBrowser": true})
        );
        assert_eq!(
            oauth_reauth_login_body("kiro", "acct"),
            serde_json::json!({
                "provider": "kiro",
                "accountId": "acct",
                "reauth": true,
                "clientBrowser": true
            })
        );
        assert_eq!(
            serde_json::to_value(OAuthLoginRequest {
                provider: "kiro",
                add_account: true,
                client_browser: is_remote(),
                kiro_organization: None,
            })
            .unwrap(),
            serde_json::json!({"provider": "kiro", "addAccount": true, "clientBrowser": true})
        );

        connection::override_active(Connection::Local);
    }

    #[test]
    fn flow_scoped_helpers_require_an_identifier_when_remote() {
        let _guard = connection_guard();

        assert_eq!(
            oauth_status_path("kiro", Some("flow 1")),
            "/api/oauth/status?provider=kiro&flowId=flow%201"
        );
        assert_eq!(
            oauth_status_path("kiro", Some("  ")),
            "/api/oauth/status?provider=kiro"
        );
        assert!(submit_login_callback(
            LoginFlow::Codex,
            "  ",
            "http://127.0.0.1:1455/auth/callback?code=x"
        )
        .is_err());

        connection::override_active(Connection::Remote(remote_profile(
            "http://100.120.114.62:10100",
            "ocx_admin_remote",
        )));
        assert!(cancel_login_flow(LoginFlow::Provider("kiro"), None).is_err());
        assert!(cancel_login_flow(LoginFlow::Codex, None).is_err());

        connection::override_active(Connection::Local);
    }

    #[test]
    fn saving_a_connection_validates_before_it_touches_the_stored_profile() {
        let _guard = connection_guard();

        assert!(save_connection(Some("http://10.0.0.5:10100/api"), Some("ocx_admin_abc")).is_err());
        assert!(save_connection(Some("http://10.0.0.5:10100"), Some("bad\r\ntoken")).is_err());
        assert!(save_connection(Some("http://10.0.0.5:10100"), None).is_err());
        assert!(save_connection(None, Some("ocx_admin_abc")).is_err());
        // A rejected update must not have switched this process to remote mode.
        assert!(!is_remote());
    }

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
    fn reset_credit_consume_response_accepts_authoritative_remaining() {
        let response: ResetCreditConsumeResponse = serde_json::from_value(serde_json::json!({
            "code": "reset",
            "remaining": 2
        }))
        .expect("response parses");

        assert_eq!(response.code, "reset");
        assert_eq!(response.remaining, Some(2));
    }

    #[test]
    fn reset_credit_details_preserve_fifo_dates() {
        let response: ResetCreditsResponse = serde_json::from_value(serde_json::json!({
            "credits": [
                {"granted_at": "2026-08-22T00:27:48Z", "expires_at": "2026-09-21T00:27:48Z"},
                {"granted_at": "2026-08-23T00:27:48Z", "expires_at": "2026-09-22T00:27:48Z"}
            ],
            "available_count": 2
        }))
        .expect("details parse");

        assert_eq!(response.available_count, 2);
        assert_eq!(response.credits[0].granted_at, "2026-08-22T00:27:48Z");
        assert_eq!(response.credits[1].expires_at, "2026-09-22T00:27:48Z");
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
    fn http_status_detection_requires_an_exact_status_boundary() {
        assert!(is_http_status(
            "OCX returned HTTP 409: login already in progress",
            409
        ));
        assert!(is_http_status("OCX returned HTTP 409", 409));
        assert!(!is_http_status("OCX returned HTTP 4090", 409));
        assert!(!is_http_status("upstream returned HTTP 409", 409));
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
        fs::write(
            profile.join("admin-api-token"),
            "\u{feff}ocx_admin_profile-token\n",
        )
        .expect("token");

        let token = management_token_from_dirs(Some(&stale), Some(&profile));

        assert_eq!(token.as_deref(), Some("ocx_admin_profile-token"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn oauth_account_login_request_serializes_fresh_account_intent() {
        assert_eq!(
            serde_json::to_value(OAuthLoginRequest {
                provider: "kiro",
                add_account: true,
                client_browser: false,
                kiro_organization: None,
            })
            .unwrap(),
            serde_json::json!({"provider": "kiro", "addAccount": true})
        );
    }

    #[test]
    fn oauth_account_login_request_serializes_kiro_organization() {
        assert_eq!(
            serde_json::to_value(OAuthLoginRequest {
                provider: "kiro",
                add_account: true,
                client_browser: false,
                kiro_organization: Some(KiroOrganizationLoginRequest {
                    start_url: "https://d-example.awsapps.com/start",
                    region: "us-east-1",
                }),
            })
            .unwrap(),
            serde_json::json!({
                "provider": "kiro",
                "addAccount": true,
                "kiroOrganization": {
                    "startUrl": "https://d-example.awsapps.com/start",
                    "region": "us-east-1"
                }
            })
        );
    }

    #[test]
    fn deletion_routes_each_pool_kind_and_encodes_identifiers() {
        assert_eq!(
            delete_account_path("openai", "codex", "a&b").unwrap(),
            "/api/codex-auth/accounts?id=a%26b"
        );
        assert_eq!(
            delete_account_path("a/b", "oauth", "x?y").unwrap(),
            "/api/oauth/accounts?provider=a%2Fb&id=x%3Fy"
        );
        assert_eq!(
            delete_account_path("a b", "key", "x#y").unwrap(),
            "/api/providers/keys?name=a%20b&id=x%23y"
        );
        assert!(delete_account_path("openai", "codex", "__main__").is_err());
    }
}
