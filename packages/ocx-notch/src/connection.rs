//! Remote connection profile for OCX Notch.
//!
//! One optional profile: a nonsecret management base URL plus the protected
//! management credential. The credential never touches disk in plaintext — it
//! lives in Windows Credential Manager (generic credential, per-user vault),
//! which is why there is no JSON/file representation of it anywhere in this
//! process. Absence of a profile means local mode, which stays the default.

use super::wide;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};

static GENERATION: AtomicU64 = AtomicU64::new(0);
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

/// Credential Manager target for the single connection profile.
const CREDENTIAL_TARGET: &str = "OCX Notch:remote-connection";
const CREDENTIAL_COMMENT: &str = "OCX Notch remote management connection";
/// `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`: nothing stored yet, which is not a failure.
const E_NOT_FOUND: i32 = -2147023728; // 0x80070490

pub const LOCAL_HOST: &str = "127.0.0.1";
pub const LOCAL_PORT: u16 = 10_100;
pub const LOCAL_BASE_URL: &str = "http://127.0.0.1:10100";
const MAX_ADDRESS_LEN: usize = 255;
const MAX_TOKEN_LEN: usize = 512;

/// A validated management endpoint. `base_url` is the normalized origin used for
/// the `Origin` header, `host`/`port` are what WinHTTP connects to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    pub base_url: String,
    pub host: String,
    pub port: u16,
    pub secure: bool,
}

/// Endpoint plus its management credential. Deliberately not `Debug`: no code
/// path may format the token into a log line, window state, or error message.
#[derive(Clone)]
pub struct Profile {
    pub endpoint: Endpoint,
    pub token: String,
}

/// What this machine is currently pointed at.
#[derive(Clone)]
pub enum Connection {
    /// No stored profile: local mode, the default.
    Local,
    Remote(Profile),
    /// A profile is stored but unusable — the credential vault could not be
    /// read, or the stored entry is corrupt. This is deliberately *not* local
    /// mode: falling back would point remote controls at a local process.
    Unavailable {
        base_url: Option<String>,
        reason: String,
    },
}

pub fn local_endpoint() -> Endpoint {
    Endpoint {
        base_url: LOCAL_BASE_URL.to_string(),
        host: LOCAL_HOST.to_string(),
        port: LOCAL_PORT,
        secure: false,
    }
}

/// Parse an operator-supplied management address.
///
/// Accepts exactly `http://host[:port]` or `https://host[:port]` with an
/// optional single trailing slash. Userinfo, path, query, fragment, whitespace,
/// and control characters are rejected so a pasted address can never smuggle a
/// request line, header, or alternate route into the transport.
pub fn parse_endpoint(raw: &str) -> Result<Endpoint, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("Enter the OCX server address".into());
    }
    if value.len() > MAX_ADDRESS_LEN {
        return Err("Server address is too long".into());
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || !ch.is_ascii())
    {
        return Err("Server address contains invalid characters".into());
    }

    let (secure, rest) = if let Some(rest) = strip_scheme(value, "https://") {
        (true, rest)
    } else if let Some(rest) = strip_scheme(value, "http://") {
        (false, rest)
    } else {
        return Err("Address must start with http:// or https://".into());
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() {
        return Err("Enter the OCX server address".into());
    }
    if rest.contains('@') {
        return Err("Address must not include a user name or password".into());
    }
    if rest.contains('/') {
        return Err("Address must not include a path".into());
    }
    if rest.contains('?') || rest.contains('#') {
        return Err("Address must not include a query or fragment".into());
    }

    let (host, port) = split_host_port(rest)?;
    if !secure && !allows_plain_http(&host) {
        return Err("Remote HTTP is allowed only for loopback, private, or overlay-network addresses; use HTTPS for public hosts".into());
    }
    let port = port.unwrap_or(if secure { 443 } else { 80 });
    let scheme = if secure { "https" } else { "http" };
    let display_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    // Origins drop the scheme's default port, matching how the server derives
    // its own origin from the Host header.
    let base_url = if port == if secure { 443 } else { 80 } {
        format!("{scheme}://{display_host}")
    } else {
        format!("{scheme}://{display_host}:{port}")
    };
    Ok(Endpoint {
        base_url,
        host,
        port,
        secure,
    })
}

fn allows_plain_http(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || is_shared_overlay_ipv4(address)
        }
        Ok(IpAddr::V6(address)) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn is_shared_overlay_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

fn strip_scheme<'a>(value: &'a str, scheme: &str) -> Option<&'a str> {
    let head = value.get(..scheme.len())?;
    head.eq_ignore_ascii_case(scheme)
        .then(|| &value[scheme.len()..])
}

fn split_host_port(rest: &str) -> Result<(String, Option<u16>), String> {
    if let Some(tail) = rest.strip_prefix('[') {
        let (host, remainder) = tail
            .split_once(']')
            .ok_or_else(|| "IPv6 address must be wrapped in brackets".to_string())?;
        let address = host
            .parse::<Ipv6Addr>()
            .map_err(|_| "Invalid IPv6 address".to_string())?;
        return Ok((address.to_string(), parse_port(remainder)?));
    }
    match rest.rsplit_once(':') {
        Some((host, port)) => {
            validate_host_name(host)?;
            Ok((
                host.to_ascii_lowercase(),
                Some(parse_port(&format!(":{port}"))?.ok_or_else(|| "Invalid port".to_string())?),
            ))
        }
        None => {
            validate_host_name(rest)?;
            Ok((rest.to_ascii_lowercase(), None))
        }
    }
}

fn parse_port(remainder: &str) -> Result<Option<u16>, String> {
    if remainder.is_empty() {
        return Ok(None);
    }
    let digits = remainder
        .strip_prefix(':')
        .ok_or_else(|| "Address must not include a path".to_string())?;
    if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Invalid port".into());
    }
    match digits.parse::<u16>() {
        Ok(0) | Err(_) => Err("Invalid port".into()),
        Ok(port) => Ok(Some(port)),
    }
}

fn validate_host_name(host: &str) -> Result<(), String> {
    if host.is_empty() || host.len() > 253 {
        return Err("Invalid server host".into());
    }
    if host.starts_with(['.', '-']) || host.ends_with(['.', '-']) || host.contains("..") {
        return Err("Invalid server host".into());
    }
    if !host
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        return Err("Invalid server host".into());
    }
    Ok(())
}

/// Reject anything that could not travel safely in an HTTP header value.
pub fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("Enter the management token".into());
    }
    if token.len() > MAX_TOKEN_LEN {
        return Err("Management token is too long".into());
    }
    if !token
        .bytes()
        .all(|byte| (0x21..=0x7e).contains(&byte) || byte == b' ')
    {
        return Err("Management token contains invalid characters".into());
    }
    Ok(())
}

fn state() -> &'static RwLock<Option<Connection>> {
    static STATE: OnceLock<RwLock<Option<Connection>>> = OnceLock::new();
    STATE.get_or_init(|| RwLock::new(None))
}

/// The active connection. Reads the vault once, then serves the cached snapshot.
/// A cache lock that cannot be taken is reported as unavailable, not as local.
pub fn active() -> Connection {
    if let Ok(guard) = state().read() {
        if let Some(connection) = guard.as_ref() {
            return connection.clone();
        }
    }
    let loaded = load_stored();
    let Ok(mut guard) = state().write() else {
        return Connection::Unavailable {
            base_url: None,
            reason: "The saved connection could not be read".into(),
        };
    };
    guard.get_or_insert(loaded).clone()
}

fn set_state(next: Connection) {
    if let Ok(mut guard) = state().write() {
        *guard = Some(next);
        GENERATION.fetch_add(1, Ordering::AcqRel);
    }
}

/// Persist the profile, then publish it. A failed write leaves the previous
/// profile in place, both on disk and in this process.
pub fn commit(profile: Profile) -> Result<(), String> {
    let previous = saved_profile()?;
    store_credential(&profile)?;
    if let Err(error) = crate::codex_connection::write_mode("remote") {
        let restored = match previous {
            Some(previous) => store_credential(&previous),
            None => delete_credential(),
        };
        return Err(if restored.is_err() {
            format!("{error}; could not restore the previous server credential")
        } else {
            error
        });
    }
    set_state(Connection::Remote(profile));
    Ok(())
}

pub fn saved_profile() -> Result<Option<Profile>, String> {
    match read_credential()?.map(interpret_stored) {
        Some(Connection::Remote(profile)) => Ok(Some(profile)),
        Some(Connection::Unavailable { reason, .. }) => Err(reason),
        _ => Ok(None),
    }
}

pub fn read_secret(name: &str) -> Result<Option<String>, String> {
    Ok(read_named_credential(name)?.and_then(|entry| entry.token))
}

pub fn disconnect() -> Result<(), String> {
    crate::codex_connection::write_mode("disconnected")?;
    set_state(load_stored());
    Ok(())
}

/// Return to local mode and remove the stored credential.
pub fn clear() -> Result<(), String> {
    crate::codex_connection::write_mode("local")?;
    set_state(Connection::Local);
    Ok(())
}

#[cfg(test)]
pub fn override_active(connection: Connection) {
    set_state(connection);
}

/// Raw stored entry: the nonsecret address and the credential blob.
struct StoredEntry {
    base_url: Option<String>,
    token: Option<String>,
}

fn load_stored() -> Connection {
    match crate::codex_connection::read_mode().as_str() {
        "local" => return Connection::Local,
        "disconnected" => {
            return Connection::Unavailable {
                base_url: saved_profile().ok().flatten().map(|p| p.endpoint.base_url),
                reason: "연결 끊김".into(),
            }
        }
        _ => {}
    }
    match read_credential() {
        // Nothing stored is the only genuine local answer.
        Ok(None) => Connection::Local,
        Ok(Some(entry)) => interpret_stored(entry),
        Err(reason) => Connection::Unavailable {
            base_url: None,
            reason,
        },
    }
}

/// Turn a stored entry into a connection. Any unusable field fails closed:
/// remote mode stays selected and reports why, so no control silently reverts
/// to the local process.
fn interpret_stored(entry: StoredEntry) -> Connection {
    let unusable =
        |base_url: Option<String>, reason: String| Connection::Unavailable { base_url, reason };
    let Some(base_url) = entry.base_url else {
        return unusable(
            None,
            "The saved connection is missing its server address".into(),
        );
    };
    let endpoint = match parse_endpoint(&base_url) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            return unusable(
                None,
                format!("The saved server address is invalid: {error}"),
            )
        }
    };
    let stored_base_url = Some(endpoint.base_url.clone());
    let Some(token) = entry.token else {
        return unusable(
            stored_base_url,
            "The saved management token is missing from Credential Manager".into(),
        );
    };
    if validate_token(&token).is_err() {
        return unusable(
            stored_base_url,
            "The saved management token is unusable".into(),
        );
    }
    Connection::Remote(Profile { endpoint, token })
}

fn read_credential() -> Result<Option<StoredEntry>, String> {
    read_named_credential(CREDENTIAL_TARGET)
}

fn read_named_credential(name: &str) -> Result<Option<StoredEntry>, String> {
    unsafe {
        let target = wide(name);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        if let Err(error) = CredReadW(
            PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            0,
            &mut credential,
        ) {
            return if error.code().0 == E_NOT_FOUND {
                Ok(None)
            } else {
                Err(format!(
                    "Credential Manager could not be read: {}",
                    error.message()
                ))
            };
        }
        if credential.is_null() {
            return Err("Credential Manager returned an empty connection entry".into());
        }
        let entry = &*credential;
        let base_url = pwstr_to_string(entry.UserName);
        let token = if entry.CredentialBlob.is_null() || entry.CredentialBlobSize == 0 {
            None
        } else {
            let bytes =
                std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize);
            std::str::from_utf8(bytes).ok().map(str::to_string)
        };
        CredFree(credential.cast());
        Ok(Some(StoredEntry { base_url, token }))
    }
}

unsafe fn pwstr_to_string(value: PWSTR) -> Option<String> {
    if value.is_null() {
        return None;
    }
    value.to_string().ok()
}

fn store_credential(profile: &Profile) -> Result<(), String> {
    write_secret(
        CREDENTIAL_TARGET,
        &profile.endpoint.base_url,
        &profile.token,
    )
}

pub fn write_secret(name: &str, username: &str, secret: &str) -> Result<(), String> {
    unsafe {
        let mut target = wide(name);
        let mut comment = wide(CREDENTIAL_COMMENT);
        let mut user = wide(username);
        let mut blob = secret.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            Comment: PWSTR(comment.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_mut_ptr()),
            ..Default::default()
        };
        CredWriteW(&credential, 0)
            .map_err(|error| format!("Could not save the connection: {}", error.message()))
    }
}

fn delete_credential() -> Result<(), String> {
    delete_secret(CREDENTIAL_TARGET)
}

pub fn delete_secret(name: &str) -> Result<(), String> {
    unsafe {
        let target = wide(name);
        match CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0) {
            Ok(()) => Ok(()),
            Err(error) if error.code().0 == E_NOT_FOUND => Ok(()),
            Err(error) => Err(format!(
                "Could not remove the saved connection: {}",
                error.message()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_private_http_and_any_https_host_with_explicit_ports() {
        let endpoint = parse_endpoint(" http://100.120.114.62:10100/ ").expect("private host");
        assert_eq!(endpoint.base_url, "http://100.120.114.62:10100");
        assert_eq!(endpoint.host, "100.120.114.62");
        assert_eq!(endpoint.port, 10_100);
        assert!(!endpoint.secure);

        let secure = parse_endpoint("HTTPS://Ocx.Example.Com").expect("https host");
        assert_eq!(secure.base_url, "https://ocx.example.com");
        assert_eq!(secure.port, 443);
        assert!(secure.secure);
    }

    #[test]
    fn rejects_plain_http_to_public_addresses_and_host_names() {
        for address in [
            "http://203.0.113.10:10100",
            "http://ocx.example.com:10100",
            "http://8.8.8.8:10100",
        ] {
            assert!(parse_endpoint(address).is_err(), "accepted {address}");
        }
        assert!(parse_endpoint("https://ocx.example.com:10100").is_ok());
        for address in [
            "http://127.0.0.1:10100",
            "http://10.0.0.5:10100",
            "http://172.16.0.5:10100",
            "http://192.168.1.5:10100",
            "http://100.120.114.62:10100",
            "http://[fd7a:115c:a1e0::1]:10100",
        ] {
            assert!(parse_endpoint(address).is_ok(), "rejected {address}");
        }
    }

    #[test]
    fn ipv6_literals_keep_brackets_in_the_origin_and_drop_them_for_the_socket() {
        let endpoint = parse_endpoint("http://[fd7a:115c:a1e0::1]:10100").expect("ipv6 host");
        assert_eq!(endpoint.base_url, "http://[fd7a:115c:a1e0::1]:10100");
        assert_eq!(endpoint.host, "fd7a:115c:a1e0::1");
        assert_eq!(endpoint.port, 10_100);
    }

    #[test]
    fn malformed_ipv6_literals_are_rejected_by_address_parsing() {
        for address in [
            "http://[:::1]:10100",
            "http://[fd7a:115c:a1e0::1::2]:10100",
            "http://[fd7a:115c:a1e0::1%eth0]:10100",
            "http://[]:10100",
            "http://[127.0.0.1]:10100",
            "http://[fd7a:115c:a1e0::1]:10100/api",
        ] {
            assert!(
                parse_endpoint(address).is_err(),
                "expected rejection for {address}"
            );
        }
    }

    #[test]
    fn an_unusable_stored_entry_stays_remote_and_explains_itself() {
        let missing_token = interpret_stored(StoredEntry {
            base_url: Some("http://100.120.114.62:10100".into()),
            token: None,
        });
        match missing_token {
            Connection::Unavailable { base_url, reason } => {
                assert_eq!(base_url.as_deref(), Some("http://100.120.114.62:10100"));
                assert!(reason.contains("token"), "unexpected reason: {reason}");
            }
            _ => panic!("a stored entry without a token must not become local mode"),
        }

        assert!(matches!(
            interpret_stored(StoredEntry {
                base_url: Some("http://100.120.114.62:10100".into()),
                token: Some("bad\r\ntoken".into()),
            }),
            Connection::Unavailable { .. }
        ));
        assert!(matches!(
            interpret_stored(StoredEntry {
                base_url: Some("http://100.120.114.62:10100/api".into()),
                token: Some("ocx_admin_abc".into()),
            }),
            Connection::Unavailable { .. }
        ));
        assert!(matches!(
            interpret_stored(StoredEntry {
                base_url: None,
                token: Some("ocx_admin_abc".into()),
            }),
            Connection::Unavailable { .. }
        ));
        assert!(matches!(
            interpret_stored(StoredEntry {
                base_url: Some("http://100.120.114.62:10100".into()),
                token: Some("ocx_admin_abc".into()),
            }),
            Connection::Remote(_)
        ));
    }

    #[test]
    fn default_ports_are_omitted_from_the_origin() {
        assert_eq!(
            parse_endpoint("http://10.0.0.5:80").unwrap().base_url,
            "http://10.0.0.5"
        );
        assert_eq!(
            parse_endpoint("https://ocx.internal:8443")
                .unwrap()
                .base_url,
            "https://ocx.internal:8443"
        );
    }

    #[test]
    fn rejects_userinfo_paths_queries_fragments_and_injection() {
        for address in [
            "http://user:pass@10.0.0.5:10100",
            "http://10.0.0.5:10100/api/providers",
            "http://10.0.0.5:10100?admin=1",
            "http://10.0.0.5:10100#x",
            "http://10.0.0.5:10100/../api",
            "ftp://10.0.0.5:10100",
            "10.0.0.5:10100",
            "http://10.0.0.5:0",
            "http://10.0.0.5:99999",
            "http://10.0.0.5:1x",
            "http://",
            "http:// 10.0.0.5:10100",
            "http://10.0.0.5:10100\r\nX-Injected: 1",
            "http://[fd7a::1:10100",
            "http://호스트:10100",
        ] {
            assert!(
                parse_endpoint(address).is_err(),
                "expected rejection for {address}"
            );
        }
    }

    #[test]
    fn tokens_must_be_header_safe_and_bounded() {
        assert!(validate_token("ocx_admin_abc123").is_ok());
        assert!(validate_token("").is_err());
        assert!(validate_token("token\r\nX-Injected: 1").is_err());
        assert!(validate_token("토큰").is_err());
        assert!(validate_token(&"a".repeat(MAX_TOKEN_LEN + 1)).is_err());
    }
}
