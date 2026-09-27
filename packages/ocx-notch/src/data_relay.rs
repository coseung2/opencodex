//! Long-lived loopback relay for Codex Responses traffic.
//!
//! Codex talks to this listener through its built-in OpenAI provider, which
//! keeps native zstd request compression enabled. The relay reads the OCX data
//! credential from Windows Credential Manager for every request, injects it,
//! and streams the encoded request body to the selected data origin without
//! decoding or persisting it.

use crate::api::connection::{self, Endpoint};
use crate::codex_connection;
use std::ffi::c_void;
use std::io::{Cursor, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{w, PCWSTR};
use windows::Win32::Networking::WinHttp::*;
use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

pub const RELAY_HOST: &str = "127.0.0.1";
pub const RELAY_PORT: u16 = 10_101;
const HEALTH_PATH: &str = "/__ocx_notch_health";
const IDENTITY_PATH: &str = "/__ocx_notch_identity";
const SHUTDOWN_PATH: &str = "/__ocx_notch_shutdown";
/// Control header carrying the per-user relay control token. The token lives in
/// the current user's Credential Manager, so another local account cannot stop,
/// or take over, a relay it does not own.
const CONTROL_HEADER: &str = "X-OCX-Notch-Relay-Control";
const CONTROL_TARGET: &str = "OCX Notch:relay-control";
/// Purpose strings keep the control proofs separate: a proof captured from one
/// endpoint cannot be replayed against the other.
const PROBE_PURPOSE: &str = "ocx-notch-relay-probe";
const SHUTDOWN_PURPOSE: &str = "ocx-notch-relay-shutdown";
const MAX_HEADER_BYTES: usize = 64 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;
const PUBLIC_FALLBACK_MAX_BYTES: u64 = 90 * 1024 * 1024;
/// Sentinel for a client that abandoned its own request. It is not a relay
/// failure, and the client must not receive an error body it could read as the
/// answer to a later request on the same socket.
const CLIENT_ABORTED: &str = "client aborted the request";
/// Sentinel for a request whose own framing is invalid. It is a client error and
/// is answered with 400 rather than being reported as a relay failure.
const CLIENT_MALFORMED: &str = "client sent a malformed request body";
/// Sentinel for a failure while writing the request body to the data origin.
const UPSTREAM_WRITE_FAILED: &str = "Could not forward the encoded OCX request";
/// Client pools hold sockets open without sending anything. Such a connection is
/// dropped quietly rather than answered, because a late error body would be read
/// as the answer to whatever the client sends next on that pooled socket.
const IDLE_READ_TIMEOUT: Duration = Duration::from_secs(15);
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Header {
    name: String,
    value: String,
}

#[derive(Debug)]
struct IncomingRequest {
    method: String,
    target: String,
    version: String,
    headers: Vec<Header>,
    body_prefix: Vec<u8>,
    content_length: Option<u64>,
    chunked: bool,
}

struct InternetHandle(*mut c_void);

impl Drop for InternetHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

unsafe impl Send for InternetHandle {}

/// What currently holds the relay port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RelayState {
    /// Nothing is listening.
    Absent,
    /// A relay answering with this machine's control token.
    Ours,
    /// Something else: a relay from an older Notch build, or another account's.
    Foreign,
    /// A listener that could not prove either way within the probe deadline.
    Unverified,
}

pub fn ensure_running() -> Result<bool, String> {
    match probe_relay() {
        RelayState::Ours => return Ok(false),
        // An inconclusive probe must never start a takeover: the listener may be a
        // healthy relay whose status line merely arrived split across packets.
        RelayState::Unverified => {
            return Err(
                "The OCX Notch data relay on 127.0.0.1:10101 did not answer the control probe"
                    .into(),
            )
        }
        RelayState::Foreign => {
            // The port is held by a relay this Notch cannot control. This process
            // must not stop an unidentified listener, so report it instead.
            return Err(
                "Another OCX Notch data relay is already listening on 127.0.0.1:10101; end that process and reconnect"
                    .into(),
            );
        }
        RelayState::Absent => {}
    }
    let executable = std::env::current_exe().map_err(|_| "Could not locate OCX Notch")?;
    let mut child = Command::new(executable)
        .arg("--data-relay")
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Could not start the OCX Notch data relay")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if probe_relay() == RelayState::Ours {
            return Ok(true);
        }
        // A relay that exited cannot become ready; reap it so a failed start does
        // not leave a zombie behind on every retry.
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err("The OCX Notch data relay did not become ready".into())
}

pub fn stop() -> Result<(), String> {
    // Ownership is proven before anything is stopped: a listener that cannot show
    // it holds this account's control token is reported, never shut down.
    match probe_relay() {
        RelayState::Ours => {}
        RelayState::Absent => return Ok(()),
        RelayState::Foreign => {
            return Err(
                "A data relay this Notch does not own is listening on 127.0.0.1:10101".into(),
            )
        }
        RelayState::Unverified => {
            return Err(
                "The OCX Notch data relay on 127.0.0.1:10101 did not answer the control probe"
                    .into(),
            )
        }
    }
    // The shutdown request proves possession of the control token with a nonce and
    // an HMAC, so no other local account can stop this relay by connecting to the
    // port. The token itself never travels.
    let token = connection::read_secret(CONTROL_TARGET)?
        .ok_or("The OCX Notch relay control token is missing")?;
    let proof = control_proof_header(&token, SHUTDOWN_PURPOSE)
        .ok_or("Could not prove the relay control token")?;
    let _ = control_status(
        &control_request("POST", SHUTDOWN_PATH, Some(&proof)),
        relay_address(),
    );
    if !wait_for_port(false, Duration::from_secs(3)) {
        return Err("The OCX Notch data relay did not stop".into());
    }
    // The token is left in place: the relay that just stopped removes its own
    // record, and deleting it here could erase the token a replacement relay has
    // already published for the same port.
    Ok(())
}

fn probe_relay() -> RelayState {
    let Ok(Some(token)) = connection::read_secret(CONTROL_TARGET) else {
        return if port_open() {
            RelayState::Foreign
        } else {
            RelayState::Absent
        };
    };
    // The caller proves it holds the control token; the relay never answers with a
    // token-derived value, so probing cannot become a signing oracle.
    let Some(header) = control_proof_header(&token, PROBE_PURPOSE) else {
        return RelayState::Unverified;
    };
    match control_status(
        &control_request("GET", IDENTITY_PATH, Some(&header)),
        relay_address(),
    ) {
        ControlProbe::Answer(200) => RelayState::Ours,
        ControlProbe::Answer(_) => RelayState::Foreign,
        ControlProbe::Refused => RelayState::Absent,
        ControlProbe::Unanswered => RelayState::Unverified,
    }
}

/// What a control probe learned about the listener on the relay port.
enum ControlProbe {
    /// The listener answered with a complete response carrying this status code.
    Answer(u16),
    /// Nothing is listening.
    Refused,
    /// A listener accepted the connection but sent no complete status line.
    Unanswered,
}

fn control_request(method: &str, path: &str, proof: Option<&str>) -> String {
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {RELAY_HOST}:{RELAY_PORT}\r\n");
    if let Some(proof) = proof {
        request.push_str(&format!("{CONTROL_HEADER}: {proof}\r\n"));
    }
    if method == "POST" {
        request.push_str("Content-Length: 0\r\n");
    }
    request.push_str("Connection: close\r\n\r\n");
    request
}

/// Send one control request and read its status line. TCP does not promise that a
/// status line arrives in one read, so this drains until the first line ends or the
/// overall deadline passes, and reports an inconclusive probe instead of guessing.
fn relay_address() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], RELAY_PORT))
}

fn control_status(request: &str, address: SocketAddr) -> ControlProbe {
    let stream = TcpStream::connect_timeout(&address, Duration::from_millis(300));
    let Ok(mut stream) = stream else {
        return ControlProbe::Refused;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1_000)));
    if stream.write_all(request.as_bytes()).is_err() {
        return ControlProbe::Unanswered;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    // The status line can arrive split across packets, so this reads until the
    // whole header block and the body it declares have arrived.
    match read_http_response(&mut stream, Duration::from_secs(2), MAX_HEADER_BYTES + 4096) {
        Ok(status) => ControlProbe::Answer(status),
        Err(_) => ControlProbe::Unanswered,
    }
}

/// Read one complete HTTP response and return its status code. Framing is read with
/// `Content-Length` only, which is all the relay's control endpoints use, and a
/// response that does not arrive complete within the deadline is inconclusive.
fn read_http_response(
    stream: &mut TcpStream,
    timeout: Duration,
    limit: usize,
) -> Result<u16, String> {
    let deadline = Instant::now() + timeout;
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(head_end) = find_header_end(&buffer) {
            let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
            let status_line = head.split("\r\n").next().unwrap_or_default();
            let content_length = head
                .split("\r\n")
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, value)| value.trim().parse::<usize>().ok());
            if let Some(content_length) = content_length {
                let body_start = head_end + 4;
                if buffer.len() >= body_start + content_length {
                    return control_status_code(status_line.as_bytes())
                        .ok_or_else(|| "The relay control response was invalid".to_string());
                }
            }
        }
        if buffer.len() >= limit || Instant::now() >= deadline {
            return Err("The relay control response was incomplete".into());
        }
        match stream.read(&mut chunk) {
            Ok(0) => return Err("The relay control response was incomplete".into()),
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => return Err("The relay control response was incomplete".into()),
        }
    }
}

fn control_status_code(status_line: &[u8]) -> Option<u16> {
    std::str::from_utf8(status_line)
        .ok()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// Status code of a response head's first line.
fn head_status(head: &[u8]) -> Option<u16> {
    let end = head
        .windows(2)
        .position(|pair| pair == b"\r\n")
        .unwrap_or(head.len());
    control_status_code(&head[..end])
}

/// HMAC-SHA-256 over the purpose and nonce. Binding the purpose keeps a proof
/// captured from one endpoint from being replayed against another.
fn control_proof(token: &str, purpose: &str, nonce: &str) -> Vec<u8> {
    let mut message = Vec::with_capacity(purpose.len() + nonce.len() + 1);
    message.extend_from_slice(purpose.as_bytes());
    message.push(0);
    message.extend_from_slice(nonce.as_bytes());
    hmac_sha256(token.as_bytes(), &message).to_vec()
}

/// Build the `nonce:proof` header value that proves possession of the token.
fn control_proof_header(token: &str, purpose: &str) -> Option<String> {
    let nonce = random_hex(16).ok()?;
    let proof = hex(&control_proof(token, purpose, &nonce));
    Some(format!("{nonce}:{proof}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buffer = vec![0u8; bytes];
    unsafe { BCryptGenRandom(None, &mut buffer, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|_| "Could not generate a relay control nonce".to_string())?;
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// HMAC-SHA-256 over one message with a 32-byte key.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&sha256(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + message.len());
    inner.extend(block.iter().map(|byte| byte ^ 0x36));
    inner.extend_from_slice(message);
    let mut outer = Vec::with_capacity(96);
    outer.extend(block.iter().map(|byte| byte ^ 0x5c));
    outer.extend_from_slice(&sha256(&inner));
    sha256(&outer)
}

/// SHA-256 of a message no larger than two 64-byte blocks, which is all the
/// control proof and its padding require.
fn sha256(message: &[u8]) -> [u8; 32] {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const ROUND: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut padded = message.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&(message.len() as u64 * 8).to_be_bytes());
    let mut state = INITIAL;
    for chunk in padded.chunks(64) {
        let mut block = [0u8; 64];
        block.copy_from_slice(chunk);
        compress(&mut state, &block, &ROUND);
    }
    let mut digest = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

fn compress(state: &mut [u32; 8], block: &[u8; 64], round: &[u32; 64]) {
    let mut schedule = [0u32; 64];
    for index in 0..16 {
        schedule[index] = u32::from_be_bytes([
            block[index * 4],
            block[index * 4 + 1],
            block[index * 4 + 2],
            block[index * 4 + 3],
        ]);
    }
    for index in 16..64 {
        let s0 = schedule[index - 15].rotate_right(7)
            ^ schedule[index - 15].rotate_right(18)
            ^ (schedule[index - 15] >> 3);
        let s1 = schedule[index - 2].rotate_right(17)
            ^ schedule[index - 2].rotate_right(19)
            ^ (schedule[index - 2] >> 10);
        schedule[index] = schedule[index - 16]
            .wrapping_add(s0)
            .wrapping_add(schedule[index - 7])
            .wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for index in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choice = (e & f) ^ (!e & g);
        let temp1 = h
            .wrapping_add(s1)
            .wrapping_add(choice)
            .wrapping_add(round[index])
            .wrapping_add(schedule[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let temp2 = s0.wrapping_add(majority);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(temp1);
        d = c;
        c = b;
        b = a;
        a = temp1.wrapping_add(temp2);
    }
    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
    state[4] = state[4].wrapping_add(e);
    state[5] = state[5].wrapping_add(f);
    state[6] = state[6].wrapping_add(g);
    state[7] = state[7].wrapping_add(h);
}

fn port_open() -> bool {
    TcpStream::connect_timeout(&relay_address(), Duration::from_millis(150)).is_ok()
}

fn wait_for_port(present: bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if port_open() == present {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn run() -> Result<(), String> {
    let listener = TcpListener::bind((RELAY_HOST, RELAY_PORT))
        .map_err(|_| "The OCX Notch data relay port is already in use")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not initialize the OCX Notch data relay")?;
    // Bind first: a second instance must never overwrite the control token of the
    // relay that actually owns the port.
    let control = publish_control_token()?;
    let shutdown = Arc::new(AtomicBool::new(false));
    let outcome = (|| -> Result<(), String> {
        while !shutdown.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((stream, peer)) if peer.ip().is_loopback() => {
                    let shutdown = shutdown.clone();
                    let control = control.clone();
                    thread::spawn(move || {
                        let _ = handle_client(stream, &shutdown, &control);
                    });
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25));
                }
                Err(_) => return Err("The OCX Notch data relay listener failed".into()),
            }
        }
        Ok(())
    })();
    // Only this instance removes its own record: deleting a token another relay
    // has already published for the same port would make that relay unstoppable.
    let _ = connection::delete_secret(CONTROL_TARGET);
    outcome
}

/// Generate this instance's control token and publish it in the current user's
/// credential vault, so only that user can stop or replace this relay.
fn publish_control_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    unsafe { BCryptGenRandom(None, &mut bytes, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }
        .ok()
        .map_err(|_| "Could not generate a relay control token".to_string())?;
    let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    connection::write_secret(
        CONTROL_TARGET,
        &format!("{RELAY_HOST}:{RELAY_PORT}"),
        &token,
    )?;
    Ok(token)
}

fn handle_client(
    mut client: TcpStream,
    shutdown: &AtomicBool,
    control: &str,
) -> Result<(), String> {
    let _ = client.set_write_timeout(Some(Duration::from_secs(600)));
    let request = match read_request(&mut client) {
        RequestRead::Request(request) => request,
        // A pooled or aborted connection is closed without a response. An error
        // body written here would be read as the answer to whatever the client
        // sends next on that socket, which is how "Could not read request
        // headers" reached Codex as a failed turn.
        RequestRead::Incomplete => return Ok(()),
        RequestRead::Malformed(error) => {
            write_json_error(&mut client, 400, "invalid_request", &error);
            return Ok(());
        }
    };
    if request.target == HEALTH_PATH {
        client
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nok")
            .map_err(|_| "Could not answer relay health check".to_string())?;
        return Ok(());
    }
    if request.target == IDENTITY_PATH {
        // The caller proves it holds the control token; this endpoint never answers
        // with a token-derived value, so it cannot be used as a signing oracle.
        let (status, body) = if control_caller_authorized(&request, control, PROBE_PURPOSE) {
            ("200 OK", "ok")
        } else {
            ("403 Forbidden", "control token required")
        };
        let _ = client.write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
        return Ok(());
    }
    if request.target == SHUTDOWN_PATH {
        if request.method != "POST"
            || !control_caller_authorized(&request, control, SHUTDOWN_PURPOSE)
        {
            write_json_error(
                &mut client,
                403,
                "control_token_required",
                "The OCX Notch relay control token is required",
            );
            return Ok(());
        }
        shutdown.store(true, Ordering::Release);
        let _ = client.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nok",
        );
        return Ok(());
    }
    if !request.target.starts_with("/v1/") {
        write_json_error(
            &mut client,
            404,
            "unsupported_path",
            "The relay accepts only OCX data-plane routes",
        );
        return Ok(());
    }
    if codex_connection::read_mode() != "remote" {
        write_json_error(
            &mut client,
            503,
            "relay_disconnected",
            "OCX Notch is not connected to a remote server",
        );
        return Ok(());
    }
    let profile = match connection::saved_profile() {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            write_json_error(
                &mut client,
                503,
                "relay_disconnected",
                "No remote OCX connection is saved",
            );
            return Ok(());
        }
        Err(error) => {
            write_json_error(&mut client, 503, "credential_unavailable", &error);
            return Ok(());
        }
    };
    let key = match codex_connection::load_key(&profile.endpoint.base_url) {
        Ok(Some(key)) => key,
        Ok(None) => {
            write_json_error(
                &mut client,
                503,
                "credential_unavailable",
                "No OCX data credential is saved",
            );
            return Ok(());
        }
        Err(error) => {
            write_json_error(&mut client, 503, "credential_unavailable", &error);
            return Ok(());
        }
    };
    if let Err(error) = connection::validate_token(&key.key) {
        write_json_error(&mut client, 503, "credential_unavailable", &error);
        return Ok(());
    }

    // Codex's built-in OpenAI provider upgrades `/v1/responses` when it believes the
    // endpoint speaks WebSockets. The upstream OCX server answers that handshake with
    // 101 (a real socket) or 426, which codex-rs maps to a silent HTTP fallback. The
    // handshake must therefore reach the server intact: stripping the upgrade headers
    // turned it into a plain `GET /v1/responses`, which the server rejected as an
    // unknown endpoint and Codex surfaced as a failed first attempt on every turn.
    if is_websocket_upgrade(&request) {
        if !profile.data_endpoint.secure {
            if let Ok(upstream) = connect_endpoint(&profile.data_endpoint) {
                return relay_websocket(
                    client,
                    upstream,
                    &profile.data_endpoint,
                    request,
                    &key.key,
                );
            }
        }
        // WinHTTP cannot carry an upgraded connection, so answer the way the server
        // does when WebSockets are off: Codex falls back to HTTP SSE without an error.
        write_json_error(
            &mut client,
            426,
            "upgrade_required",
            "The OCX data relay does not carry WebSockets on this path",
        );
        return Ok(());
    }

    if !profile.data_endpoint.secure {
        match connect_endpoint(&profile.data_endpoint) {
            Ok(upstream) => {
                return relay_plain_http(
                    client,
                    upstream,
                    &profile.data_endpoint,
                    request,
                    &key.key,
                )
            }
            Err(error) if profile.data_endpoint != profile.endpoint => {
                if let Err(reason) = fallback_allowed(&request) {
                    write_json_error(&mut client, 503, "private_data_path_unavailable", &format!(
                        "The private OCX data path is unavailable and public fallback is unsafe: {reason}"
                    ));
                    return Ok(());
                }
                let _ = error;
                return relay_winhttp(client, &profile.endpoint, request, &key.key);
            }
            Err(error) => {
                write_json_error(&mut client, 502, "data_origin_unavailable", &error);
                return Ok(());
            }
        }
    }
    if profile.data_endpoint == profile.endpoint {
        if let Err(reason) = fallback_allowed(&request) {
            write_json_error(&mut client, 413, "public_fallback_too_large", &reason);
            return Ok(());
        }
    }
    relay_winhttp(client, &profile.data_endpoint, request, &key.key)
}

fn fallback_allowed(request: &IncomingRequest) -> Result<(), String> {
    if request.chunked {
        return Err("a chunked request has no safe preflight size".into());
    }
    let length = request.content_length.unwrap_or(0);
    if length > PUBLIC_FALLBACK_MAX_BYTES {
        return Err(format!(
            "the encoded request is {length} bytes; the public fallback ceiling is {PUBLIC_FALLBACK_MAX_BYTES} bytes"
        ));
    }
    Ok(())
}

fn connect_endpoint(endpoint: &Endpoint) -> Result<TcpStream, String> {
    let addresses: Vec<_> = (endpoint.host.as_str(), endpoint.port)
        .to_socket_addrs()
        .map_err(|_| "Could not resolve the private OCX data origin")?
        .collect();
    for address in addresses {
        if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_secs(4)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(600)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(600)));
            return Ok(stream);
        }
    }
    Err("Could not connect to the private OCX data origin".into())
}

fn relay_plain_http(
    mut client: TcpStream,
    mut upstream: TcpStream,
    endpoint: &Endpoint,
    request: IncomingRequest,
    key: &str,
) -> Result<(), String> {
    let prepared = (|| -> Result<Vec<u8>, String> {
        let head = upstream_request_head(&request, endpoint, key);
        upstream
            .write_all(&head)
            .map_err(|_| "Could not start the private OCX request")?;
        copy_request_body(&mut client, &mut upstream, &request)?;
        // Do NOT half-close (shutdown Write) the upstream here. OCX's Bun-based
        // `/v1/responses` handler treats the client FIN as an aborted request and
        // closes the socket with no response, which surfaced as
        // "The private OCX response ended before its headers" (502). The request
        // body is already fully delimited by Content-Length or the terminating
        // zero chunk, so the upstream knows where the body ends without a FIN.
        read_response_prefix(&mut upstream)
    })();
    let prefix = match prepared {
        Ok(prefix) => prefix,
        // The client gave up on its own request: nothing to report to it.
        Err(error) if error == CLIENT_ABORTED => return Ok(()),
        // The client's own framing was invalid: answer the request, not the relay.
        Err(error) if error.starts_with(CLIENT_MALFORMED) => {
            write_json_error(&mut client, 400, "invalid_request", &error);
            return Ok(());
        }
        Err(error) => {
            write_json_error(&mut client, 502, "data_transport_failed", &error);
            return Ok(());
        }
    };
    let (head, body) = split_response_head(&prefix);
    client
        .write_all(&client_response_head(head))
        .map_err(|_| "Could not start the private OCX response")?;
    client
        .write_all(body)
        .map_err(|_| "Could not start the private OCX response")?;
    std::io::copy(&mut upstream, &mut client)
        .map_err(|_| "The private OCX response stream ended unexpectedly")?;
    Ok(())
}

fn read_response_prefix(upstream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut buffer = Vec::with_capacity(4096);
    loop {
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err("The private OCX response headers were too large".into());
        }
        let mut chunk = [0u8; 4096];
        let read = upstream
            .read(&mut chunk)
            .map_err(|_| "The private OCX response ended before its headers")?;
        if read == 0 {
            return Err("The private OCX response ended before its headers".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(header_end) = find_header_end(&buffer) {
            let status = buffer[..header_end]
                .split(|byte| *byte == b'\r')
                .next()
                .unwrap_or_default();
            if !status.starts_with(b"HTTP/") {
                return Err("The private OCX data origin returned an invalid response".into());
            }
            return Ok(buffer);
        }
    }
}

/// A WebSocket handshake, which must reach the server intact instead of being
/// flattened into a plain data-plane request.
fn is_websocket_upgrade(request: &IncomingRequest) -> bool {
    request.method == "GET"
        && request.headers.iter().any(|header| {
            header.name.eq_ignore_ascii_case("upgrade")
                && header.value.eq_ignore_ascii_case("websocket")
        })
        && request
            .headers
            .iter()
            .any(|header| header.name.eq_ignore_ascii_case("sec-websocket-key"))
}

/// Unlike the single-request data path, an upgrade keeps its connection-management
/// and `Sec-WebSocket-*` headers; only hop-by-hop credentials are replaced.
fn upgrade_header_allowed(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "x-opencodex-api-key"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
    )
}

fn upstream_upgrade_head(request: &IncomingRequest, endpoint: &Endpoint, key: &str) -> Vec<u8> {
    let mut output = format!(
        "{} {} {}\r\nHost: {}\r\n",
        request.method,
        request.target,
        request.version,
        authority(endpoint)
    );
    for header in &request.headers {
        if upgrade_header_allowed(&header.name) {
            output.push_str(&header.name);
            output.push_str(": ");
            output.push_str(&header.value);
            output.push_str("\r\n");
        }
    }
    output.push_str("X-OpenCodex-API-Key: ");
    output.push_str(key);
    output.push_str("\r\n\r\n");
    output.into_bytes()
}

/// Carry one WebSocket session. A 101 switches to a bidirectional splice; anything
/// else (the server's 426 when WebSockets are disabled) is forwarded as an ordinary
/// single-request response so Codex can fall back to HTTP SSE.
fn relay_websocket(
    mut client: TcpStream,
    mut upstream: TcpStream,
    endpoint: &Endpoint,
    request: IncomingRequest,
    key: &str,
) -> Result<(), String> {
    let prepared = (|| -> Result<Vec<u8>, String> {
        let head = upstream_upgrade_head(&request, endpoint, key);
        upstream
            .write_all(&head)
            .map_err(|_| "Could not start the private OCX handshake")?;
        copy_request_body(&mut client, &mut upstream, &request)?;
        read_response_prefix(&mut upstream)
    })();
    let prefix = match prepared {
        Ok(prefix) => prefix,
        Err(error) if error == CLIENT_ABORTED => return Ok(()),
        Err(error) => {
            write_json_error(&mut client, 502, "data_transport_failed", &error);
            return Ok(());
        }
    };
    let (head, extra) = split_response_head(&prefix);
    let switching_protocols = head_status(head) == Some(101);
    let response_head = if switching_protocols {
        head.to_vec()
    } else {
        client_response_head(head)
    };
    client
        .write_all(&response_head)
        .map_err(|_| "Could not start the private OCX response")?;
    client
        .write_all(extra)
        .map_err(|_| "Could not start the private OCX response")?;
    if !switching_protocols {
        std::io::copy(&mut upstream, &mut client)
            .map_err(|_| "The private OCX response stream ended unexpectedly")?;
        return Ok(());
    }
    // A session outlives any request timeout: clear them so an idle WebSocket is not
    // torn down mid-conversation.
    let _ = client.set_read_timeout(None);
    let _ = client.set_write_timeout(None);
    let _ = upstream.set_read_timeout(None);
    let _ = upstream.set_write_timeout(None);
    let mut client_reader = client
        .try_clone()
        .map_err(|_| "Could not relay the WebSocket".to_string())?;
    let mut upstream_writer = upstream
        .try_clone()
        .map_err(|_| "Could not relay the WebSocket".to_string())?;
    let upload = thread::spawn(move || {
        let _ = std::io::copy(&mut client_reader, &mut upstream_writer);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = upload.join();
    Ok(())
}

fn copy_request_body(
    client: &mut TcpStream,
    upstream: &mut impl Write,
    request: &IncomingRequest,
) -> Result<(), String> {
    if request.chunked {
        let prefix = Cursor::new(request.body_prefix.as_slice());
        return match copy_chunked_body(&mut prefix.chain(client), upstream) {
            // The upstream connection failed mid-body: that is a relay failure.
            Err(error) if error == UPSTREAM_WRITE_FAILED => Err(error),
            // A client that stopped sending, or whose framing is invalid, is not a
            // relay failure: keep both sentinels so the caller answers accordingly.
            Err(error) if error.starts_with(CLIENT_MALFORMED) => Err(error),
            Err(error) if error == CLIENT_ABORTED => Err(error),
            Err(error) => Err(format!("{CLIENT_MALFORMED}: {error}")),
            Ok(()) => Ok(()),
        };
    }
    upstream
        .write_all(&request.body_prefix)
        .map_err(|_| UPSTREAM_WRITE_FAILED.to_string())?;
    let remaining = request
        .content_length
        .unwrap_or(0)
        .saturating_sub(request.body_prefix.len() as u64);
    let mut limited = client.take(remaining);
    let copied = match std::io::copy(&mut limited, upstream) {
        Ok(copied) => copied,
        // The client aborted mid-upload: it is not owed an error body, and the
        // upstream request is already incomplete, so stop without answering.
        Err(_) => return Err(CLIENT_ABORTED.into()),
    };
    if copied != remaining {
        return Err(CLIENT_ABORTED.into());
    }
    Ok(())
}

/// Forward one complete HTTP/1.1 chunked body without waiting for the client
/// connection to close. Chunk framing and trailers are preserved byte-for-byte,
/// and the copy stops after the empty trailer line following the zero chunk.
fn copy_chunked_body(reader: &mut impl Read, writer: &mut impl Write) -> Result<(), String> {
    loop {
        // A client that stops mid-body is not a client error, so the sentinel keeps
        // that distinction; unreadable framing keeps its own.
        let size_line = read_chunk_line(reader, 8 * 1024)?;
        writer
            .write_all(&size_line)
            .map_err(|_| UPSTREAM_WRITE_FAILED.to_string())?;
        let size_text = std::str::from_utf8(&size_line[..size_line.len() - 2]).map_err(|_| {
            format!("{CLIENT_MALFORMED}: the OCX request used invalid chunk framing")
        })?;
        let size_text = size_text.split(';').next().unwrap_or_default().trim();
        if size_text.is_empty() || !size_text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!(
                "{CLIENT_MALFORMED}: the OCX request used invalid chunk framing"
            ));
        }
        let size = u64::from_str_radix(size_text, 16)
            .map_err(|_| format!("{CLIENT_MALFORMED}: the OCX request chunk was too large"))?;
        if size == 0 {
            let mut trailer_bytes = 0usize;
            loop {
                let trailer = read_chunk_line(reader, MAX_HEADER_BYTES - trailer_bytes)?;
                trailer_bytes += trailer.len();
                writer
                    .write_all(&trailer)
                    .map_err(|_| UPSTREAM_WRITE_FAILED.to_string())?;
                if trailer == b"\r\n" {
                    return Ok(());
                }
            }
        }
        copy_exact(reader, writer, size)?;
        let mut ending = [0u8; 2];
        reader
            .read_exact(&mut ending)
            .map_err(|_| CLIENT_ABORTED.to_string())?;
        if ending != *b"\r\n" {
            return Err(format!(
                "{CLIENT_MALFORMED}: the OCX request used invalid chunk framing"
            ));
        }
        writer
            .write_all(&ending)
            .map_err(|_| UPSTREAM_WRITE_FAILED.to_string())?;
    }
}

fn read_chunk_line(reader: &mut impl Read, limit: usize) -> Result<Vec<u8>, String> {
    if limit < 2 {
        return Err(format!(
            "{CLIENT_MALFORMED}: the OCX request chunk metadata was too large"
        ));
    }
    let mut line = Vec::new();
    while line.len() < limit {
        let mut byte = [0u8; 1];
        // The client stopped sending: an abandoned upload, not bad framing.
        reader
            .read_exact(&mut byte)
            .map_err(|_| CLIENT_ABORTED.to_string())?;
        line.push(byte[0]);
        if line.ends_with(b"\r\n") {
            return Ok(line);
        }
    }
    Err(format!(
        "{CLIENT_MALFORMED}: the OCX request chunk metadata was too large"
    ))
}

fn copy_exact(
    reader: &mut impl Read,
    writer: &mut impl Write,
    mut remaining: u64,
) -> Result<(), String> {
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
        let read = reader
            .read(&mut buffer[..wanted])
            .map_err(|_| CLIENT_ABORTED.to_string())?;
        if read == 0 {
            return Err(CLIENT_ABORTED.to_string());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|_| UPSTREAM_WRITE_FAILED.to_string())?;
        remaining -= read as u64;
    }
    Ok(())
}

fn relay_winhttp(
    mut client: TcpStream,
    endpoint: &Endpoint,
    request: IncomingRequest,
    key: &str,
) -> Result<(), String> {
    if let Err(reason) = fallback_allowed(&request) {
        write_json_error(&mut client, 413, "public_fallback_too_large", &reason);
        return Ok(());
    }
    let length = request.content_length.unwrap_or(0);
    if request.chunked || length > u32::MAX as u64 {
        write_json_error(
            &mut client,
            413,
            "public_fallback_too_large",
            "Public fallback requires a bounded Content-Length request",
        );
        return Ok(());
    }
    let prepared = unsafe {
        (|| -> Result<(InternetHandle, InternetHandle, InternetHandle, Vec<u8>), String> {
            let session = InternetHandle(valid_handle(WinHttpOpen(
                w!("OCX Notch Data Relay/0.1"),
                WINHTTP_ACCESS_TYPE_NO_PROXY,
                PCWSTR::null(),
                PCWSTR::null(),
                0,
            ))?);
            WinHttpSetTimeouts(session.0, 10_000, 10_000, 600_000, 600_000).map_err(win_error)?;
            let host = wide(&endpoint.host);
            let connection = InternetHandle(valid_handle(WinHttpConnect(
                session.0,
                PCWSTR(host.as_ptr()),
                endpoint.port,
                0,
            ))?);
            let method = wide(&request.method);
            let target = wide(&request.target);
            let flags = if endpoint.secure {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            };
            let handle = InternetHandle(valid_handle(WinHttpOpenRequest(
                connection.0,
                PCWSTR(method.as_ptr()),
                PCWSTR(target.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null(),
                flags,
            ))?);
            let disable_redirects = WINHTTP_DISABLE_REDIRECTS.to_le_bytes();
            WinHttpSetOption(
                Some(handle.0),
                WINHTTP_OPTION_DISABLE_FEATURE,
                Some(&disable_redirects),
            )
            .map_err(win_error)?;
            let headers = winhttp_headers(&request, key);
            if !headers.is_empty() {
                let headers = wide(&headers);
                WinHttpAddRequestHeaders(
                    handle.0,
                    &headers[..headers.len() - 1],
                    WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE,
                )
                .map_err(win_error)?;
            }
            WinHttpSendRequest(handle.0, None, None, 0, length as u32, 0).map_err(win_error)?;
            write_winhttp_body(handle.0, &request.body_prefix)?;
            let remaining = length.saturating_sub(request.body_prefix.len() as u64);
            let mut limited = std::io::Read::by_ref(&mut client).take(remaining);
            let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
            let mut copied = 0u64;
            loop {
                let read = match limited.read(&mut buffer) {
                    Ok(read) => read,
                    // A client that abandons its upload is not a relay failure, and it
                    // must never receive an error body it could read as the answer to a
                    // later request: close the connection without answering.
                    Err(_) => return Err(CLIENT_ABORTED.into()),
                };
                if read == 0 {
                    break;
                }
                write_winhttp_body(handle.0, &buffer[..read])?;
                copied += read as u64;
            }
            if copied != remaining {
                return Err(CLIENT_ABORTED.into());
            }
            WinHttpReceiveResponse(handle.0, std::ptr::null_mut()).map_err(win_error)?;
            let response_head = winhttp_response_head(handle.0)?;
            Ok((session, connection, handle, response_head))
        })()
    };
    let (_session, _connection, handle, response_head) = match prepared {
        Ok(prepared) => prepared,
        // The client gave up on its own request: nothing to report to it.
        Err(error) if error == CLIENT_ABORTED => return Ok(()),
        Err(error) => {
            write_json_error(&mut client, 502, "data_transport_failed", &error);
            return Ok(());
        }
    };
    client
        .write_all(&response_head)
        .map_err(|_| "Could not start the public fallback response")?;
    unsafe {
        loop {
            let mut available = 0u32;
            WinHttpQueryDataAvailable(handle.0, &mut available).map_err(win_error)?;
            if available == 0 {
                break;
            }
            let mut body = vec![0u8; available.min(COPY_BUFFER_BYTES as u32) as usize];
            let mut read = 0u32;
            WinHttpReadData(
                handle.0,
                body.as_mut_ptr().cast::<c_void>(),
                body.len() as u32,
                &mut read,
            )
            .map_err(win_error)?;
            client
                .write_all(&body[..read as usize])
                .map_err(|_| "The public fallback response stream ended unexpectedly")?;
        }
    }
    Ok(())
}

unsafe fn write_winhttp_body(handle: *mut c_void, body: &[u8]) -> Result<(), String> {
    let mut offset = 0;
    while offset < body.len() {
        let mut written = 0u32;
        WinHttpWriteData(
            handle,
            Some(body[offset..].as_ptr().cast::<c_void>()),
            (body.len() - offset) as u32,
            &mut written,
        )
        .map_err(win_error)?;
        if written == 0 {
            return Err("The public fallback request stream stopped accepting data".into());
        }
        offset += written as usize;
    }
    Ok(())
}

unsafe fn winhttp_response_head(handle: *mut c_void) -> Result<Vec<u8>, String> {
    let mut size = 0u32;
    let _ = WinHttpQueryHeaders(
        handle,
        WINHTTP_QUERY_RAW_HEADERS_CRLF,
        PCWSTR::null(),
        None,
        &mut size,
        std::ptr::null_mut(),
    );
    if size == 0 || size > MAX_HEADER_BYTES as u32 {
        return Err("The public fallback returned invalid headers".into());
    }
    let mut bytes = vec![0u8; size as usize];
    WinHttpQueryHeaders(
        handle,
        WINHTTP_QUERY_RAW_HEADERS_CRLF,
        PCWSTR::null(),
        Some(bytes.as_mut_ptr().cast::<c_void>()),
        &mut size,
        std::ptr::null_mut(),
    )
    .map_err(win_error)?;
    bytes.truncate(size as usize);
    let units = std::slice::from_raw_parts(bytes.as_ptr().cast::<u16>(), bytes.len() / 2);
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    let raw = String::from_utf16(&units[..end])
        .map_err(|_| "The public fallback returned invalid headers")?;
    let mut lines = raw.split("\r\n");
    let status = lines
        .next()
        .filter(|line| line.starts_with("HTTP/"))
        .ok_or("The public fallback returned an invalid status")?;
    let mut output = format!("{status}\r\n");
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if response_header_allowed(name) {
            output.push_str(name);
            output.push(':');
            output.push_str(value);
            output.push_str("\r\n");
        }
    }
    output.push_str("Connection: close\r\n\r\n");
    Ok(output.into_bytes())
}

/// Outcome of reading one request from a client connection.
#[derive(Debug)]
enum RequestRead {
    Request(IncomingRequest),
    /// The peer never delivered a request line: a pooled connection that went
    /// idle, or one that was abandoned. Not a client error, and never answered.
    Incomplete,
    /// A request that violates HTTP framing. Answered with 400.
    Malformed(String),
}

fn read_request(stream: &mut TcpStream) -> RequestRead {
    let _ = stream.set_read_timeout(Some(IDLE_READ_TIMEOUT));
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if buffer.len() >= MAX_HEADER_BYTES {
            return RequestRead::Malformed("Request headers are too large".into());
        }
        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) if buffer.is_empty() => return RequestRead::Incomplete,
            Ok(0) => return RequestRead::Malformed("Request ended before its headers".into()),
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                // The client is mid-request: give it time to finish the headers.
                let _ = stream.set_read_timeout(Some(HEADER_READ_TIMEOUT));
            }
            Err(_) => return RequestRead::Incomplete,
        }
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
    };
    let head = match std::str::from_utf8(&buffer[..header_end]) {
        Ok(head) => head,
        Err(_) => return RequestRead::Malformed("Request headers must be ASCII".into()),
    };
    match parse_request_head(head, buffer[header_end + 4..].to_vec()) {
        Ok(request) => RequestRead::Request(request),
        Err(error) => RequestRead::Malformed(error),
    }
}

fn parse_request_head(head: &str, body_prefix: Vec<u8>) -> Result<IncomingRequest, String> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or("Missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("Missing request method")?;
    let target = parts.next().ok_or("Missing request target")?;
    let version = parts.next().ok_or("Missing HTTP version")?;
    if parts.next().is_some()
        || !method.bytes().all(|byte| byte.is_ascii_uppercase())
        || !target.starts_with('/')
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
    {
        return Err("Invalid request line".into());
    }
    let mut headers = Vec::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or("Invalid request header")?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value.bytes().any(|byte| byte < 0x20 && byte != b'\t')
        {
            return Err("Invalid request header".into());
        }
        headers.push(Header {
            name: name.to_string(),
            value: value.trim().to_string(),
        });
    }
    let (content_length, chunked) = request_framing(&headers, body_prefix.len())?;
    Ok(IncomingRequest {
        method: method.to_string(),
        target: target.to_string(),
        version: version.to_string(),
        headers,
        body_prefix,
        content_length,
        chunked,
    })
}

fn request_framing(
    headers: &[Header],
    body_prefix_len: usize,
) -> Result<(Option<u64>, bool), String> {
    let content_length = parse_content_length(headers)?;
    let chunked = parse_transfer_encoding(headers)?;
    if chunked && content_length.is_some() {
        return Err("Request cannot combine Content-Length and Transfer-Encoding".into());
    }
    if content_length.is_some_and(|length| body_prefix_len as u64 > length) {
        return Err("Request contained bytes beyond Content-Length".into());
    }
    if content_length.is_none() && !chunked && body_prefix_len != 0 {
        return Err("Request body has no Content-Length or Transfer-Encoding".into());
    }
    Ok((content_length, chunked))
}

fn parse_content_length(headers: &[Header]) -> Result<Option<u64>, String> {
    let values: Vec<_> = headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case("content-length"))
        .map(|header| header.value.as_str())
        .collect();
    if values.is_empty() {
        return Ok(None);
    }
    if values.len() != 1 || !values[0].bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Invalid Content-Length".into());
    }
    values[0]
        .parse::<u64>()
        .map(Some)
        .map_err(|_| "Invalid Content-Length".into())
}

fn parse_transfer_encoding(headers: &[Header]) -> Result<bool, String> {
    let values: Vec<_> = headers
        .iter()
        .filter(|header| header.name.eq_ignore_ascii_case("transfer-encoding"))
        .flat_map(|header| header.value.split(','))
        .map(str::trim)
        .collect();
    if values.is_empty() {
        return Ok(false);
    }
    if values.iter().any(|value| {
        value.is_empty()
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(
                        byte,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
    }) {
        return Err("Invalid Transfer-Encoding".into());
    }
    let chunked_positions: Vec<_> = values
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.eq_ignore_ascii_case("chunked").then_some(index))
        .collect();
    if chunked_positions.len() != 1 || chunked_positions[0] + 1 != values.len() {
        return Err("Transfer-Encoding must end in one chunked coding".into());
    }
    Ok(true)
}

fn upstream_request_head(request: &IncomingRequest, endpoint: &Endpoint, key: &str) -> Vec<u8> {
    let mut output = format!(
        "{} {} {}\r\nHost: {}\r\n",
        request.method,
        request.target,
        request.version,
        authority(endpoint)
    );
    for header in &request.headers {
        if request_header_allowed(&header.name) {
            output.push_str(&header.name);
            output.push_str(": ");
            output.push_str(&header.value);
            output.push_str("\r\n");
        }
    }
    output.push_str("X-OpenCodex-API-Key: ");
    output.push_str(key);
    output.push_str("\r\nConnection: close\r\n\r\n");
    output.into_bytes()
}

fn winhttp_headers(request: &IncomingRequest, key: &str) -> String {
    let mut output = String::new();
    for header in &request.headers {
        if request_header_allowed(&header.name)
            && !header.name.eq_ignore_ascii_case("content-length")
            && !header.name.eq_ignore_ascii_case("transfer-encoding")
        {
            output.push_str(&header.name);
            output.push_str(": ");
            output.push_str(&header.value);
            output.push_str("\r\n");
        }
    }
    output.push_str("X-OpenCodex-API-Key: ");
    output.push_str(key);
    output.push_str("\r\n");
    output
}

fn request_header_allowed(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "upgrade"
            | "host"
            | "x-opencodex-api-key"
    )
}

fn response_header_allowed(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "content-length"
    )
}

fn control_nonce(request: &IncomingRequest) -> Option<&str> {
    request
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(CONTROL_HEADER))
        .map(|header| header.value.as_str())
        .filter(|value| !value.is_empty() && value.len() <= 128)
}

/// Split the `nonce:proof` control header a caller uses to prove it holds the
/// control token.
fn control_proof_pair(request: &IncomingRequest) -> Option<(&str, &str)> {
    let (nonce, proof) = control_nonce(request)?.split_once(':')?;
    if nonce.is_empty() || proof.is_empty() {
        return None;
    }
    Some((nonce, proof))
}

/// True only when the caller proved it holds this relay's control token.
fn control_caller_authorized(request: &IncomingRequest, control: &str, purpose: &str) -> bool {
    control_proof_pair(request).is_some_and(|(nonce, proof)| {
        constant_time_eq(
            proof.as_bytes(),
            hex(&control_proof(control, purpose, nonce)).as_bytes(),
        )
    })
}

/// Compare secrets without an early exit, so a local caller cannot learn the
/// control token from response timing.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// Split a buffered response prefix into its header block and any body bytes that
/// arrived with it.
fn split_response_head(prefix: &[u8]) -> (&[u8], &[u8]) {
    match find_header_end(prefix) {
        Some(index) => (&prefix[..index + 4], &prefix[index + 4..]),
        None => (prefix, &[]),
    }
}

/// Rewrite an upstream response head for a single-request client connection.
/// Framing headers (`Content-Length`, `Transfer-Encoding`) are preserved so the
/// body can be copied verbatim, while connection management headers are replaced
/// with `Connection: close`. Without this, a client that saw `keep-alive` would
/// reuse a socket this relay closes after one response.
fn client_response_head(head: &[u8]) -> Vec<u8> {
    // Bytes, not `str`: a non-UTF-8 header must still lose its connection
    // management fields, otherwise a client could see `keep-alive` on a socket
    // this relay closes after one response.
    let text = String::from_utf8_lossy(head).into_owned();
    let mut lines = text.split("\r\n");
    let Some(status) = lines.next().filter(|line| line.starts_with("HTTP/")) else {
        return head.to_vec();
    };
    let mut output = format!("{status}\r\n");
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "connection"
                | "keep-alive"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "upgrade"
                | "trailer"
        ) {
            continue;
        }
        output.push_str(name);
        output.push(':');
        output.push_str(value);
        output.push_str("\r\n");
    }
    output.push_str("Connection: close\r\n\r\n");
    output.into_bytes()
}

fn authority(endpoint: &Endpoint) -> String {
    let host = if endpoint.host.contains(':') {
        format!("[{}]", endpoint.host)
    } else {
        endpoint.host.clone()
    };
    let default_port = if endpoint.secure { 443 } else { 80 };
    if endpoint.port == default_port {
        host
    } else {
        format!("{host}:{}", endpoint.port)
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn write_json_error(stream: &mut TcpStream, status: u16, code: &str, message: &str) {
    let body = serde_json::json!({
        "error": {
            "type": code,
            "message": message,
        }
    })
    .to_string();
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        426 => "Upgrade Required",
        502 => "Bad Gateway",
        _ => "Service Unavailable",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn valid_handle(handle: *mut c_void) -> Result<*mut c_void, String> {
    if handle.is_null() {
        Err(win_error(windows::core::Error::from_win32()))
    } else {
        Ok(handle)
    }
}

fn win_error(error: windows::core::Error) -> String {
    format!("OCX data transport failed: {}", error.message())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(headers: Vec<Header>, length: Option<u64>, chunked: bool) -> IncomingRequest {
        IncomingRequest {
            method: "POST".into(),
            target: "/v1/responses?test=1".into(),
            version: "HTTP/1.1".into(),
            headers,
            body_prefix: Vec::new(),
            content_length: length,
            chunked,
        }
    }

    #[test]
    fn relay_preserves_encoded_authorization_and_replaces_admission_headers() {
        let incoming = request(
            vec![
                Header {
                    name: "Authorization".into(),
                    value: "Bearer chatgpt".into(),
                },
                Header {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                },
                Header {
                    name: "Content-Encoding".into(),
                    value: "zstd".into(),
                },
                Header {
                    name: "X-OpenCodex-API-Key".into(),
                    value: "untrusted".into(),
                },
                Header {
                    name: "Connection".into(),
                    value: "keep-alive".into(),
                },
            ],
            Some(12),
            false,
        );
        let endpoint = connection::parse_endpoint("http://100.120.114.62:10100").unwrap();
        let head =
            String::from_utf8(upstream_request_head(&incoming, &endpoint, "vault-key")).unwrap();
        assert!(head.contains("Authorization: Bearer chatgpt\r\n"));
        assert!(head.contains("Content-Encoding: zstd\r\n"));
        assert!(head.contains("X-OpenCodex-API-Key: vault-key\r\n"));
        assert!(!head.contains("untrusted"));
        assert_eq!(head.matches("X-OpenCodex-API-Key:").count(), 1);
    }

    #[test]
    fn public_fallback_requires_a_bounded_conservative_size() {
        assert!(
            fallback_allowed(&request(Vec::new(), Some(PUBLIC_FALLBACK_MAX_BYTES), false)).is_ok()
        );
        assert!(fallback_allowed(&request(
            Vec::new(),
            Some(PUBLIC_FALLBACK_MAX_BYTES + 1),
            false
        ))
        .is_err());
        assert!(fallback_allowed(&request(Vec::new(), None, true)).is_err());
        assert!(fallback_allowed(&request(Vec::new(), None, false)).is_ok());
    }

    #[test]
    fn duplicate_or_ambiguous_body_lengths_are_rejected() {
        assert_eq!(
            parse_content_length(&[Header {
                name: "Content-Length".into(),
                value: "42".into()
            }])
            .unwrap(),
            Some(42)
        );
        assert!(parse_content_length(&[
            Header {
                name: "Content-Length".into(),
                value: "42".into()
            },
            Header {
                name: "content-length".into(),
                value: "42".into()
            },
        ])
        .is_err());
        assert!(parse_content_length(&[Header {
            name: "Content-Length".into(),
            value: "4x".into()
        }])
        .is_err());
    }

    #[test]
    fn transfer_encoding_requires_one_final_chunked_coding() {
        let header = |value: &str| Header {
            name: "Transfer-Encoding".into(),
            value: value.into(),
        };
        assert!(parse_transfer_encoding(&[header("chunked")]).unwrap());
        assert!(parse_transfer_encoding(&[header("gzip, chunked")]).unwrap());
        for value in [
            "gzip",
            "chunked, gzip",
            "chunked, chunked",
            "chunked;foo=bar",
            "",
        ] {
            assert!(
                parse_transfer_encoding(&[header(value)]).is_err(),
                "accepted {value}"
            );
        }
    }

    #[test]
    fn request_framing_rejects_ambiguous_or_unframed_body_bytes() {
        let content_length = Header {
            name: "Content-Length".into(),
            value: "4".into(),
        };
        let transfer_encoding = Header {
            name: "Transfer-Encoding".into(),
            value: "chunked".into(),
        };
        assert_eq!(
            request_framing(&[content_length.clone()], 4).unwrap(),
            (Some(4), false)
        );
        assert!(request_framing(&[content_length.clone()], 5).is_err());
        assert!(request_framing(&[content_length, transfer_encoding.clone()], 0).is_err());
        assert_eq!(
            request_framing(&[transfer_encoding], 3).unwrap(),
            (None, true)
        );
        assert!(request_framing(&[], 1).is_err());
        assert_eq!(request_framing(&[], 0).unwrap(), (None, false));
    }

    #[test]
    fn chunked_copy_stops_at_the_terminal_chunk_and_preserves_trailers() {
        let framed = b"4;kind=test\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Trace: done\r\n\r\nNEXT";
        let mut reader = Cursor::new(framed.as_slice());
        let mut output = Vec::new();

        copy_chunked_body(&mut reader, &mut output).unwrap();

        assert_eq!(output, &framed[..framed.len() - 4]);
        let mut remaining = Vec::new();
        reader.read_to_end(&mut remaining).unwrap();
        assert_eq!(remaining, b"NEXT");
    }

    #[test]
    fn chunked_copy_rejects_incomplete_or_invalid_framing() {
        assert!(copy_chunked_body(&mut Cursor::new(b"x\r\n"), &mut Vec::new()).is_err());
        assert!(copy_chunked_body(&mut Cursor::new(b"4\r\nabc"), &mut Vec::new()).is_err());
        assert!(copy_chunked_body(&mut Cursor::new(b"1\r\naXX"), &mut Vec::new()).is_err());
    }

    #[test]
    fn an_aborted_chunked_upload_is_silent_not_a_relay_failure() {
        // The client promised one more chunk and then went away.
        let framed = b"4\r\nWiki\r\n8\r\npedia";
        let error = copy_chunked_body(&mut Cursor::new(framed), &mut Vec::new()).unwrap_err();

        assert_eq!(error, CLIENT_ABORTED);
    }

    #[test]
    fn invalid_chunk_framing_is_a_client_error() {
        let error = copy_chunked_body(&mut Cursor::new(b"zz\r\n"), &mut Vec::new()).unwrap_err();

        assert!(error.starts_with(CLIENT_MALFORMED), "{error}");
    }

    #[test]
    fn an_upstream_write_failure_is_a_relay_failure() {
        struct Refusing;
        impl Write for Refusing {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let error = copy_chunked_body(&mut Cursor::new(b"4\r\nWiki\r\n0\r\n\r\n"), &mut Refusing)
            .unwrap_err();

        assert_eq!(error, UPSTREAM_WRITE_FAILED);
    }

    fn socket_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).unwrap();
        let (server, _) = listener.accept().unwrap();
        for stream in [&client, &server] {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        }
        (client, server)
    }

    fn read_until(stream: &mut TcpStream, marker: &[u8]) -> Vec<u8> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 256];
        while !buffer.windows(marker.len()).any(|window| window == marker) {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "the stream ended before {marker:?}");
            buffer.extend_from_slice(&chunk[..read]);
        }
        buffer
    }

    fn upgrade_request() -> IncomingRequest {
        parse_request_head(
            "GET /v1/responses HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13",
            Vec::new(),
        )
        .unwrap()
    }

    #[test]
    fn a_websocket_handshake_keeps_its_upgrade_headers() {
        let request = upgrade_request();
        assert!(is_websocket_upgrade(&request));
        let endpoint = connection::parse_endpoint("http://100.120.114.62:10100").unwrap();

        let head =
            String::from_utf8(upstream_upgrade_head(&request, &endpoint, "vault-key")).unwrap();

        assert!(head.starts_with("GET /v1/responses HTTP/1.1\r\n"));
        assert!(head.contains("Host: 100.120.114.62:10100\r\n"));
        assert!(head.contains("Upgrade: websocket\r\n"));
        assert!(head.contains("Connection: Upgrade\r\n"));
        assert!(head.contains("Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"));
        assert!(head.contains("Sec-WebSocket-Version: 13\r\n"));
        assert!(head.contains("X-OpenCodex-API-Key: vault-key\r\n"));
        // A plain data request is still flattened.
        assert!(!is_websocket_upgrade(
            &parse_request_head(
                "POST /v1/responses HTTP/1.1\r\nContent-Length: 0",
                Vec::new()
            )
            .unwrap()
        ));
    }

    #[test]
    fn a_websocket_upgrade_is_spliced_after_101() {
        let (mut client, relay_side) = socket_pair();
        let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut upstream, _) = listener.accept().unwrap();
            let _ = upstream.set_read_timeout(Some(Duration::from_secs(5)));
            let head = read_until(&mut upstream, b"\r\n\r\n");
            let head = String::from_utf8_lossy(&head).to_string();
            assert!(head.contains("Upgrade: websocket"), "{head}");
            assert!(head.contains("X-OpenCodex-API-Key: vault-key"), "{head}");
            upstream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: abc\r\n\r\n",
                )
                .unwrap();
            let mut payload = [0u8; 5];
            upstream.read_exact(&mut payload).unwrap();
            upstream.write_all(&payload).unwrap();
            upstream.flush().unwrap();
            // Hold the session open until the client goes away.
            let mut sink = [0u8; 16];
            let _ = upstream.read(&mut sink);
        });
        let upstream = TcpStream::connect(upstream_address).unwrap();
        let endpoint = connection::parse_endpoint("http://100.120.114.62:10100").unwrap();
        let relay = thread::spawn(move || {
            relay_websocket(
                relay_side,
                upstream,
                &endpoint,
                upgrade_request(),
                "vault-key",
            )
            .unwrap();
        });

        let head = read_until(&mut client, b"\r\n\r\n");
        let head = String::from_utf8_lossy(&head).to_string();
        assert!(
            head.starts_with("HTTP/1.1 101 Switching Protocols"),
            "{head}"
        );
        assert!(head.contains("Upgrade: websocket"), "{head}");
        assert!(!head.contains("Connection: close"), "{head}");

        client.write_all(b"hello").unwrap();
        client.flush().unwrap();
        let mut echo = [0u8; 5];
        client.read_exact(&mut echo).unwrap();
        assert_eq!(&echo, b"hello");

        drop(client);
        relay.join().unwrap();
        upstream_thread.join().unwrap();
    }

    #[test]
    fn a_refused_upgrade_becomes_a_single_request_response() {
        let (mut client, relay_side) = socket_pair();
        let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
        let upstream_address = listener.local_addr().unwrap();
        let upstream_thread = thread::spawn(move || {
            let (mut upstream, _) = listener.accept().unwrap();
            let _ = upstream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = read_until(&mut upstream, b"\r\n\r\n");
            upstream
                .write_all(
                    b"HTTP/1.1 426 Upgrade Required\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nno",
                )
                .unwrap();
        });
        let upstream = TcpStream::connect(upstream_address).unwrap();
        let endpoint = connection::parse_endpoint("http://100.120.114.62:10100").unwrap();
        let relay = thread::spawn(move || {
            relay_websocket(
                relay_side,
                upstream,
                &endpoint,
                upgrade_request(),
                "vault-key",
            )
            .unwrap();
        });

        let mut response = Vec::new();
        let mut chunk = [0u8; 256];
        loop {
            let read = client.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..read]);
        }
        let response = String::from_utf8_lossy(&response).to_string();
        assert!(
            response.starts_with("HTTP/1.1 426 Upgrade Required\r\n"),
            "{response}"
        );
        assert!(response.contains("Connection: close\r\n"), "{response}");
        assert!(!response.contains("keep-alive"), "{response}");
        assert!(response.ends_with("no"), "{response}");

        relay.join().unwrap();
        upstream_thread.join().unwrap();
    }

    #[test]
    fn pooled_or_aborted_connections_are_never_answered() {
        let (client, mut server) = socket_pair();

        drop(client);

        assert!(matches!(read_request(&mut server), RequestRead::Incomplete));
    }

    #[test]
    fn partial_request_headers_are_a_client_error() {
        let (mut client, mut server) = socket_pair();
        client
            .write_all(b"GET /v1/models HTTP/1.1\r\nHost: relay")
            .unwrap();
        client.shutdown(std::net::Shutdown::Write).unwrap();

        match read_request(&mut server) {
            RequestRead::Malformed(error) => {
                assert_eq!(error, "Request ended before its headers")
            }
            other => panic!("expected a malformed request, got {other:?}"),
        }
    }

    #[test]
    fn complete_request_headers_are_parsed_with_their_body() {
        let (mut client, mut server) = socket_pair();
        client
            .write_all(
                b"POST /v1/responses HTTP/1.1\r\nHost: relay\r\nAuthorization: Bearer chatgpt\r\nContent-Length: 5\r\n\r\nhello",
            )
            .unwrap();

        match read_request(&mut server) {
            RequestRead::Request(request) => {
                assert_eq!(request.method, "POST");
                assert_eq!(request.target, "/v1/responses");
                assert_eq!(request.content_length, Some(5));
                assert!(!request.chunked);
                assert!(request.body_prefix.len() <= 5);
            }
            other => panic!("expected a parsed request, got {other:?}"),
        }
    }

    #[test]
    fn response_head_forces_a_single_request_connection() {
        let upstream = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\n\r\n";

        let rewritten = String::from_utf8(client_response_head(upstream)).unwrap();

        assert!(rewritten.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(rewritten.contains("Content-Type: text/event-stream\r\n"));
        assert!(rewritten.contains("Transfer-Encoding: chunked\r\n"));
        assert!(rewritten.ends_with("Connection: close\r\n\r\n"));
        assert!(!rewritten.to_ascii_lowercase().contains("keep-alive"));
    }

    #[test]
    fn a_buffered_response_prefix_keeps_its_body_bytes() {
        let prefix = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

        let (head, body) = split_response_head(prefix);

        assert_eq!(head, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n");
        assert_eq!(body, b"ok");
    }

    #[test]
    fn control_proofs_require_the_published_token() {
        let token = "0011223344556677";
        let other = "0011223344556678";

        let proof = control_proof(token, PROBE_PURPOSE, "nonce");
        assert_eq!(proof.len(), 32);
        assert_eq!(proof, control_proof(token, PROBE_PURPOSE, "nonce"));
        assert_ne!(proof, control_proof(token, PROBE_PURPOSE, "other"));
        assert_ne!(proof, control_proof(other, PROBE_PURPOSE, "nonce"));
        // Purpose separation: a proof for one endpoint never authorizes another.
        assert_ne!(proof, control_proof(token, SHUTDOWN_PURPOSE, "nonce"));
        assert!(constant_time_eq(
            hex(&proof).as_bytes(),
            hex(&control_proof(token, PROBE_PURPOSE, "nonce")).as_bytes()
        ));
        assert!(!constant_time_eq(b"short", hex(&proof).as_bytes()));

        let signed = hex(&control_proof(token, PROBE_PURPOSE, "nonce"));
        let request = |header: &str| {
            parse_request_head(
                &format!(
                    "GET /__ocx_notch_identity HTTP/1.1\r\nX-OCX-Notch-Relay-Control: {header}"
                ),
                Vec::new(),
            )
            .unwrap()
        };
        let probe = request(&format!("nonce:{signed}"));
        assert!(control_caller_authorized(&probe, token, PROBE_PURPOSE));
        assert!(!control_caller_authorized(&probe, token, SHUTDOWN_PURPOSE));
        assert!(!control_caller_authorized(&probe, other, PROBE_PURPOSE));
        // A bare nonce, an empty proof, and a missing header are never authorized.
        for header in ["nonce", "nonce:", ":deadbeef", "nonce:deadbeef"] {
            let request = request(header);
            assert!(
                !control_caller_authorized(&request, token, PROBE_PURPOSE),
                "{header}"
            );
        }
        assert!(!control_caller_authorized(
            &parse_request_head("GET /__ocx_notch_identity HTTP/1.1", Vec::new()).unwrap(),
            token,
            PROBE_PURPOSE
        ));
    }

    #[test]
    fn sha256_matches_published_vectors() {
        assert_eq!(
            hex(&sha256(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(&sha256(b"The quick brown fox jumps over the lazy dog")),
            "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
        );
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231_case_two() {
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn a_real_relay_accepts_the_control_probe() {
        let control = "00112233445566778899aabbccddeeff";
        let header = control_proof_header(control, PROBE_PURPOSE).unwrap();
        let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut shutdown = AtomicBool::new(false);
            handle_client(stream, &mut shutdown, control).unwrap();
        });

        let probe = control_status(
            &control_request("GET", IDENTITY_PATH, Some(&header)),
            address,
        );

        match probe {
            ControlProbe::Answer(200) => {}
            other => panic!("expected an acceptance, got {}", probe_name(&other)),
        }
        server.join().unwrap();
    }

    #[test]
    fn a_relay_without_the_token_refuses_the_control_probe() {
        // No proof, a garbage proof, and a proof computed with the wrong token.
        let wrong = control_proof_header("0011223344556678", PROBE_PURPOSE).unwrap();
        for header in [None, Some("nonce:deadbeef"), Some(wrong.as_str())] {
            let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                let mut shutdown = AtomicBool::new(false);
                handle_client(stream, &mut shutdown, "0011223344556677").unwrap();
            });
            let probe = control_status(&control_request("GET", IDENTITY_PATH, header), address);

            match probe {
                ControlProbe::Answer(403) => {}
                other => panic!("expected a refusal, got {}", probe_name(&other)),
            }
            server.join().unwrap();
        }
    }

    fn probe_name(probe: &ControlProbe) -> &'static str {
        match probe {
            ControlProbe::Answer(_) => "an answer",
            ControlProbe::Refused => "a refusal",
            ControlProbe::Unanswered => "no answer",
        }
    }

    #[test]
    fn shutdown_without_a_caller_proof_leaves_the_relay_running() {
        let control = "00112233445566778899aabbccddeeff";
        // A valid probe proof is not a shutdown proof: the purposes are separate.
        let probe_proof = control_proof_header(control, PROBE_PURPOSE).unwrap();
        for header in [
            None,
            Some("nonce"),
            Some("nonce:00"),
            Some("nonce:0000000000000000000000000000000000000000000000000000000000000000"),
            Some(probe_proof.as_str()),
        ] {
            let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let shutdown = Arc::new(AtomicBool::new(false));
            let server_shutdown = Arc::clone(&shutdown);
            let server = thread::spawn(move || {
                let (stream, _) = listener.accept().unwrap();
                handle_client(stream, &server_shutdown, control).unwrap();
            });

            let probe = control_status(&control_request("POST", SHUTDOWN_PATH, header), address);

            match probe {
                ControlProbe::Answer(403) => {}
                other => panic!("expected a refusal, got {}", probe_name(&other)),
            }
            server.join().unwrap();
            assert!(
                !shutdown.load(Ordering::Acquire),
                "an unproven shutdown stopped the relay for {header:?}"
            );
        }

        // Even a valid proof cannot shut the relay down through another method.
        let proven = control_proof_header(control, SHUTDOWN_PURPOSE).unwrap();
        let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let server_shutdown = Arc::clone(&shutdown);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_client(stream, &server_shutdown, control).unwrap();
        });

        let probe = control_status(
            &control_request("GET", SHUTDOWN_PATH, Some(&proven)),
            address,
        );

        match probe {
            ControlProbe::Answer(403) => {}
            other => panic!("expected a refusal, got {}", probe_name(&other)),
        }
        server.join().unwrap();
        assert!(!shutdown.load(Ordering::Acquire));
    }

    #[test]
    fn a_proven_shutdown_stops_the_relay() {
        let control = "00112233445566778899aabbccddeeff";
        let header = control_proof_header(control, SHUTDOWN_PURPOSE).unwrap();
        let listener = TcpListener::bind((RELAY_HOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let server_shutdown = Arc::clone(&shutdown);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_client(stream, &server_shutdown, control).unwrap();
        });

        let probe = control_status(
            &control_request("POST", SHUTDOWN_PATH, Some(&header)),
            address,
        );

        match probe {
            ControlProbe::Answer(200) => {}
            other => panic!("expected an acceptance, got {}", probe_name(&other)),
        }
        server.join().unwrap();
        assert!(shutdown.load(Ordering::Acquire));
    }

    #[test]
    fn control_requests_carry_the_token_and_a_bounded_body() {
        let shutdown = control_request("POST", SHUTDOWN_PATH, Some("abc"));
        assert!(shutdown.starts_with("POST /__ocx_notch_shutdown HTTP/1.1\r\n"));
        assert!(shutdown.contains("X-OCX-Notch-Relay-Control: abc\r\n"));
        assert!(shutdown.contains("Content-Length: 0\r\n"));

        let legacy = control_request("POST", SHUTDOWN_PATH, None);
        assert!(!legacy.contains(CONTROL_HEADER));
    }
}
