use crate::model::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::ffi::c_void;
use windows::core::{w, PCWSTR};
use windows::Win32::Networking::WinHttp::*;

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

fn request(
    method: &str,
    path: &str,
    body: Option<&[u8]>,
    timeout_ms: i32,
) -> Result<Vec<u8>, String> {
    unsafe {
        let session = InternetHandle(valid_handle(WinHttpOpen(
            w!("OCX Notch/0.1"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
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
        if let Ok(token) = std::env::var("OPENCODEX_API_AUTH_TOKEN") {
            if !token.is_empty() && !token.contains(['\r', '\n']) {
                headers.push_str("Authorization: Bearer ");
                headers.push_str(&token);
                headers.push_str("\r\n");
            }
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
        if !(200..300).contains(&status) {
            return Err(format!("OCX returned HTTP {status}"));
        }

        let mut body = Vec::new();
        loop {
            let mut available = 0u32;
            WinHttpQueryDataAvailable(request.0, &mut available).map_err(win_error)?;
            if available == 0 {
                break;
            }
            let start = body.len();
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
        Ok(body)
    }
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
        let accounts = get_json::<CodexAccountsResponse>("/api/codex-auth/accounts", 20_000)
            .map(codex_account_views)
            .unwrap_or_default();
        return AccountPool {
            provider: config.name.clone(),
            accounts,
        };
    }

    let mode = config.auth_mode.as_deref().unwrap_or_default();
    let path = match mode {
        "oauth" => format!(
            "/api/oauth/accounts?provider={}",
            encode_component(&config.name)
        ),
        "key" => format!(
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
            Some(AccountView {
                identity,
                active,
                health,
                quota: None,
            })
        })
        .collect();
    AccountPool {
        provider: config.name.clone(),
        accounts,
    }
}

fn encode_component(value: &str) -> String {
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
