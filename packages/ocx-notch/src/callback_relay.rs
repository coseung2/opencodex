//! Local loopback HTTP receiver for relaying remote OAuth callbacks.
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
use std::time::{Duration, Instant};
const MAX_HEAD: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_millis(250);
const REQUEST_DEADLINE: Duration = Duration::from_secs(1);
pub struct CallbackRelay {
    listeners: Vec<TcpListener>,
    origin: String,
    authority: String,
    path: String,
}
impl CallbackRelay {
    /// Bind only the loopback address and port named by `callback_uri`.
    pub fn bind(callback_uri: &str) -> Result<Self, String> {
        let target = parse_callback_uri(callback_uri)?;
        let mut listeners = Vec::new();
        for address in target.addresses {
            match TcpListener::bind(address) {
                Ok(listener) => {
                    listener.set_nonblocking(true).map_err(|error| {
                        format!("Could not prepare the OAuth callback listener: {error}")
                    })?;
                    listeners.push(listener);
                }
                Err(error)
                    if target.is_localhost
                        && !listeners.is_empty()
                        && unavailable_address_family(error.kind()) => {}
                Err(error) => {
                    return Err(format!(
                        "Could not bind the OAuth callback listener: {error}"
                    ));
                }
            }
        }
        if listeners.is_empty() {
            return Err("Could not bind the OAuth callback listener".into());
        }
        Ok(Self {
            listeners,
            origin: target.origin,
            authority: target.authority,
            path: target.path,
        })
    }
    /// Poll once. Invalid or incomplete browser requests are answered safely and ignored.
    pub fn try_callback(&mut self) -> Result<Option<String>, String> {
        for listener in &self.listeners {
            match listener.accept() {
                Ok((mut stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        respond(&mut stream, "403 Forbidden", "Request rejected.");
                        return Ok(None);
                    }
                    return Ok(self.handle(&mut stream));
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => {
                    return Err(format!("Could not accept the OAuth callback: {error}"));
                }
            }
        }
        Ok(None)
    }
    fn handle(&self, stream: &mut TcpStream) -> Option<String> {
        let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
        let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
        let head = match read_head(stream) {
            Ok(head) => head,
            Err(ReadFailure::TooLarge) => {
                respond(
                    stream,
                    "431 Request Header Fields Too Large",
                    "Request rejected.",
                );
                return None;
            }
            Err(ReadFailure::Timeout) => {
                respond(stream, "408 Request Timeout", "Request timed out.");
                return None;
            }
            Err(ReadFailure::Invalid) => {
                respond(stream, "400 Bad Request", "Request rejected.");
                return None;
            }
        };
        let (target, host) = match parse_request(&head) {
            Some(parts) => parts,
            None => {
                respond(stream, "400 Bad Request", "Request rejected.");
                return None;
            }
        };
        if !host.eq_ignore_ascii_case(&self.authority) {
            respond(stream, "403 Forbidden", "Request rejected.");
            return None;
        }
        let path = target.split_once('?').map_or(target, |(path, _)| path);
        if path != self.path {
            respond(stream, "404 Not Found", "Unknown callback path.");
            return None;
        }
        respond(
            stream,
            "200 OK",
            "Sign-in received. You can close this tab and return to OCX Notch.",
        );
        Some(format!("{}{target}", self.origin))
    }
}
fn unavailable_address_family(kind: ErrorKind) -> bool {
    matches!(kind, ErrorKind::AddrNotAvailable | ErrorKind::Unsupported)
}
struct ParsedTarget {
    origin: String,
    authority: String,
    path: String,
    addresses: Vec<SocketAddr>,
    is_localhost: bool,
}
fn parse_callback_uri(raw: &str) -> Result<ParsedTarget, String> {
    if raw.trim() != raw
        || raw.len() > 2048
        || raw
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || !c.is_ascii())
    {
        return Err("The callback URI is invalid".into());
    }
    let rest = raw
        .strip_prefix("http://")
        .ok_or_else(|| "The callback URI must use loopback HTTP".to_string())?;
    let split = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..split];
    let path = if split == rest.len() {
        "/"
    } else {
        &rest[split..]
    };
    if path.contains(['?', '#']) || path.is_empty() {
        return Err("The callback URI must contain only an exact callback path".into());
    }
    let (host, port) = parse_authority(authority)?;
    let is_localhost = host.eq_ignore_ascii_case("localhost");
    let addresses = if is_localhost {
        vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ]
    } else {
        let ip: IpAddr = host
            .parse()
            .map_err(|_| "The callback URI must name a loopback address".to_string())?;
        if !ip.is_loopback() {
            return Err("The callback URI must name a loopback address".into());
        }
        vec![SocketAddr::new(ip, port)]
    };
    Ok(ParsedTarget {
        origin: format!("http://{authority}"),
        authority: authority.to_string(),
        path: path.to_string(),
        addresses,
        is_localhost,
    })
}
fn parse_authority(authority: &str) -> Result<(&str, u16), String> {
    let invalid = || "The callback URI must include a loopback host and port".to_string();
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').ok_or_else(invalid)?;
        (host, tail.strip_prefix(':').ok_or_else(invalid)?)
    } else {
        authority.rsplit_once(':').ok_or_else(invalid)?
    };
    if host.is_empty() || host.contains('@') || port.is_empty() {
        return Err(invalid());
    }
    let port = port.parse::<u16>().map_err(|_| invalid())?;
    if port == 0 {
        return Err(invalid());
    }
    Ok((host, port))
}
enum ReadFailure {
    TooLarge,
    Timeout,
    Invalid,
}
fn read_head(stream: &mut TcpStream) -> Result<Vec<u8>, ReadFailure> {
    let mut data = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let deadline = Instant::now() + REQUEST_DEADLINE;
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(ReadFailure::Timeout)?;
        stream
            .set_read_timeout(Some(remaining.min(IO_TIMEOUT)))
            .map_err(|_| ReadFailure::Invalid)?;
        match stream.read(&mut chunk) {
            Ok(0) => return Err(ReadFailure::Invalid),
            Ok(count) => {
                data.extend_from_slice(&chunk[..count]);
                if data.len() > MAX_HEAD {
                    return Err(ReadFailure::TooLarge);
                }
                if data.windows(4).any(|part| part == b"\r\n\r\n") {
                    return Ok(data);
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                return Err(ReadFailure::Timeout)
            }
            Err(_) => return Err(ReadFailure::Invalid),
        }
    }
}
fn parse_request(head: &[u8]) -> Option<(&str, &str)> {
    if head.len() > MAX_HEAD {
        return None;
    }
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split_ascii_whitespace();
    if request.next()? != "GET" {
        return None;
    }
    let target = request.next()?;
    if request.next()? != "HTTP/1.1" || request.next().is_some() || !target.starts_with('/') {
        return None;
    }
    if target.contains('#') || target.chars().any(char::is_control) {
        return None;
    }
    let mut host = None;
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() || value.trim().is_empty() {
                return None;
            }
            host = Some(value.trim());
        }
    }
    Some((target, host?))
}
fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body =
        format!("<!doctype html><meta charset=utf-8><title>OCX Notch</title><p>{message}</p>");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Instant;
    fn uri() -> String {
        let probe = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        format!("http://127.0.0.1:{port}/oauth/callback")
    }
    fn request(relay: &mut CallbackRelay, raw: &[u8]) -> (Option<String>, String) {
        let address = relay.listeners[0].local_addr().unwrap();
        let payload = raw.to_vec();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(&payload).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        });
        let started = Instant::now();
        let result = loop {
            if let Some(value) = relay.try_callback().unwrap() {
                break Some(value);
            }
            if started.elapsed() > Duration::from_secs(2) {
                break None;
            }
            thread::sleep(Duration::from_millis(5));
        };
        (result, client.join().unwrap())
    }
    #[test]
    fn parses_only_http_loopback_callbacks() {
        assert!(parse_callback_uri("http://127.0.0.1:1234/cb").is_ok());
        assert!(parse_callback_uri("http://[::1]:1234/cb").is_ok());
        assert!(parse_callback_uri("http://localhost:1234/cb").is_ok());
        for bad in [
            "https://127.0.0.1:1/cb",
            "http://10.0.0.1:1/cb",
            "http://127.0.0.1/cb",
            "http://127.0.0.1:1/cb?q=x",
        ] {
            assert!(parse_callback_uri(bad).is_err(), "accepted {bad}");
        }
    }
    #[test]
    fn accepts_exact_path_host_and_returns_full_url() {
        let uri = uri();
        let authority = uri
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap();
        let mut relay = CallbackRelay::bind(&uri).unwrap();
        let raw =
            format!("GET /oauth/callback?code=a&state=b HTTP/1.1\r\nHost: {authority}\r\n\r\n");
        let (value, response) = request(&mut relay, raw.as_bytes());
        assert_eq!(
            value.as_deref(),
            Some(format!("{uri}?code=a&state=b").as_str())
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
    }
    #[test]
    fn rejects_wrong_path_method_and_host() {
        for line in [
            "GET /wrong HTTP/1.1",
            "POST /oauth/callback HTTP/1.1",
            "GET /oauth/callback HTTP/1.1",
        ] {
            let uri = uri();
            let mut relay = CallbackRelay::bind(&uri).unwrap();
            let host = if line.starts_with("GET /oauth") {
                "evil.invalid"
            } else {
                uri.strip_prefix("http://")
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap()
            };
            let raw = format!("{line}\r\nHost: {host}\r\n\r\n");
            let (value, response) = request(&mut relay, raw.as_bytes());
            assert!(value.is_none());
            assert!(!response.starts_with("HTTP/1.1 200"));
        }
    }
    #[test]
    fn rejects_oversized_and_timed_out_requests_and_releases_socket() {
        let uri = uri();
        let mut relay = CallbackRelay::bind(&uri).unwrap();
        let oversized = vec![b'a'; MAX_HEAD + 1];
        let (_, response) = request(&mut relay, &oversized);
        assert!(response.starts_with("HTTP/1.1 431"));
        let address = relay.listeners[0].local_addr().unwrap();
        let (connected_tx, connected_rx) = std::sync::mpsc::channel();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(b"GET /oauth").unwrap();
            connected_tx.send(()).unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).unwrap();
            response
        });
        connected_rx.recv().unwrap();
        assert!(relay.try_callback().unwrap().is_none());
        assert!(client.join().unwrap().starts_with("HTTP/1.1 408"));
        drop(relay);
        assert!(CallbackRelay::bind(&uri).is_ok());
    }
    #[test]
    fn slow_drip_cannot_extend_the_absolute_request_deadline() {
        let uri = uri();
        let mut relay = CallbackRelay::bind(&uri).unwrap();
        let address = relay.listeners[0].local_addr().unwrap();
        let (connected_tx, connected_rx) = std::sync::mpsc::channel();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            connected_tx.send(()).unwrap();
            let started = Instant::now();
            while started.elapsed() < REQUEST_DEADLINE + Duration::from_millis(500) {
                if stream.write_all(b"G").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        connected_rx.recv().unwrap();
        let started = Instant::now();
        assert!(relay.try_callback().unwrap().is_none());
        assert!(started.elapsed() < REQUEST_DEADLINE + Duration::from_millis(400));
        client.join().unwrap();
    }
    #[test]
    fn address_in_use_is_never_treated_as_an_unavailable_ip_family() {
        assert!(!unavailable_address_family(ErrorKind::AddrInUse));
        assert!(unavailable_address_family(ErrorKind::AddrNotAvailable));
    }
}
