//! `lib/relay-http.mjs`: the request helpers the relay's routes share: origin checks, caller identity, the request line as a
//! URL, and the two plain-text answers.

use url::Url;

use super::head::Headers;
use super::response::{HeaderError, ResponseWriter};
use crate::rate_limit::RateLimiter;

/// `browserSocketOriginAllowed`: a browser's WebSocket upgrade must come from the relay's own origin: `Origin` is the same
/// scheme as the connection (`https` on TLS, else `http`), the same host (and port) as the `Host` header, with no path,
/// query, fragment or credentials.
pub fn browser_socket_origin_allowed(headers: &Headers, encrypted: bool) -> bool {
    let origin = headers.get("origin").unwrap_or("");
    let host = headers.get("host").unwrap_or("");
    if origin.is_empty() || host.is_empty() {
        return false;
    }
    let Ok(parsed) = Url::parse(origin) else { return false };
    let Some(parsed_host) = parsed.host_str() else { return false };
    let mut parsed_host = parsed_host.to_owned();
    if let Some(port) = parsed.port() {
        parsed_host.push(':');
        parsed_host.push_str(&port.to_string());
    }
    let scheme = if encrypted { "https" } else { "http" };
    parsed.scheme() == scheme
        && parsed_host.to_lowercase() == host.to_lowercase()
        && parsed.path() == "/"
        && parsed.query().is_none_or(str::is_empty)
        && parsed.fragment().is_none_or(str::is_empty)
        && parsed.username().is_empty()
        && parsed.password().is_none_or(str::is_empty)
}

/// `clientIp`: the address of the socket, `unknown` without one. Never `X-Forwarded-For`: the relay is the TLS edge, and a
/// header the caller wrote says nothing about who the caller is.
pub fn client_ip(remote_address: Option<&str>) -> &str {
    remote_address.filter(|address| !address.is_empty()).unwrap_or("unknown")
}

/// `requestUrl`: the request line as a URL against `http://localhost`, `None` when it does not parse.
pub fn request_url(target: &str) -> Option<Url> {
    let base = Url::parse("http://localhost").ok()?;
    base.join(if target.is_empty() { "/" } else { target }).ok()
}

/// `decodedRequestPath`: the URL and its percent-decoded path, `None` for a target that does not parse or whose path is not
/// valid percent-encoding (the caller answers 400).
pub fn decoded_request_path(target: &str) -> Option<(Url, String)> {
    let url = request_url(target)?;
    let pathname = decode_uri_component(url.path())?;
    Some((url, pathname))
}

/// `decodeURIComponent`: `None` where it throws `URIError`.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = text.get(at + 1..at + 3)?;
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `endText`: `writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(text)`.
pub fn end_text(response: &mut ResponseWriter, status: u16, text: &str, headers: &[(&str, &str)]) -> Result<(), HeaderError> {
    let mut merged: Vec<(&str, &str)> = vec![("Content-Type", "text/plain; charset=utf-8")];
    for &(name, value) in headers {
        match merged.iter_mut().find(|(existing, _)| *existing == name) {
            Some(entry) => entry.1 = value,
            None => merged.push((name, value)),
        }
    }
    response.write_head(status, &merged)?;
    response.end(Some(text.as_bytes()));
    Ok(())
}

/// `rejectUnauthorizedText`: bounded probing. A caller past the unauthorized limiter is throttled (429, `Retry-After: 60`)
/// instead of buying unlimited token guesses and log noise; otherwise 401.
pub fn reject_unauthorized_text(
    unauthorized_limiter: &mut RateLimiter,
    remote_address: Option<&str>,
    response: &mut ResponseWriter,
) -> Result<(), HeaderError> {
    if !unauthorized_limiter.allow(client_ip(remote_address)) {
        return end_text(response, 429, "Too many requests.", &[("Retry-After", "60")]);
    }
    end_text(response, 401, "Unauthorized.", &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> Headers {
        let mut headers = Headers::default();
        for (name, value) in pairs {
            headers.add(name, (*value).to_owned());
        }
        headers
    }

    #[test]
    fn browser_websocket_upgrades_require_the_relay_origin() {
        let allowed = |pairs: &[(&str, &str)], encrypted| browser_socket_origin_allowed(&headers(pairs), encrypted);
        assert!(allowed(&[("origin", "https://relay.example"), ("host", "relay.example")], true));
        assert!(allowed(&[("origin", "http://127.0.0.1:9800"), ("host", "127.0.0.1:9800")], false));
        assert!(!allowed(&[("origin", "https://evil.example"), ("host", "relay.example")], true));
        assert!(!allowed(&[("host", "relay.example")], true));
        assert!(!allowed(&[("origin", "https://relay.example/path"), ("host", "relay.example")], true));
    }

    #[test]
    fn the_origin_is_compared_as_a_url_is_written() {
        let allowed = |origin: &str, host: &str, encrypted| browser_socket_origin_allowed(&headers(&[("origin", origin), ("host", host)]), encrypted);
        // The scheme must be the connection's, the host is compared without case, the default port is not written.
        assert!(!allowed("http://relay.example", "relay.example", true));
        assert!(allowed("https://RELAY.example", "relay.EXAMPLE", true));
        assert!(allowed("https://relay.example:443", "relay.example", true));
        assert!(allowed("https://relay.example/", "relay.example", true));
        assert!(allowed("https://relay.example/?", "relay.example", true));
        assert!(!allowed("https://relay.example/?a=1", "relay.example", true));
        assert!(!allowed("https://relay.example/#a", "relay.example", true));
        assert!(!allowed("https://user@relay.example", "relay.example", true));
        assert!(!allowed("https://relay.example", "relay.example:8443", true));
        assert!(!allowed("not a url", "relay.example", true));
        assert!(allowed("https://[::1]:9800", "[::1]:9800", true));
    }

    #[test]
    fn caller_identity_falls_back_when_the_socket_has_no_address() {
        assert_eq!(client_ip(Some("203.0.113.9")), "203.0.113.9");
        assert_eq!(client_ip(None), "unknown");
        assert_eq!(client_ip(Some("")), "unknown");
    }

    #[test]
    fn the_request_line_is_a_url_against_localhost() {
        assert_eq!(request_url("").unwrap().path(), "/");
        assert_eq!(request_url("/a/b?x=1").unwrap().query(), Some("x=1"));
        assert_eq!(request_url("http://other.test/echo").unwrap().host_str(), Some("other.test"));
        assert!(request_url("http://[bad").is_none());
    }

    #[test]
    fn a_path_that_is_not_valid_percent_encoding_has_no_decoded_form() {
        let (url, path) = decoded_request_path("/a%20b/%E2%82%AC?q=1").unwrap();
        assert_eq!(path, "/a b/\u{20ac}");
        assert_eq!(url.query(), Some("q=1"));
        assert!(decoded_request_path("/%").is_none());
        assert!(decoded_request_path("/%zz").is_none());
        assert!(decoded_request_path("/%E2%82").is_none());
        assert!(decoded_request_path("/%C0%AF").is_none());
        assert_eq!(decoded_request_path("/a%2Fb").unwrap().1, "/a/b");
    }
}
