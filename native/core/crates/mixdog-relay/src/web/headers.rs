//! The headers every static answer carries (`lib/static-http.mjs`): the browser security set, the CSP hash of an inlined
//! `boot.js`, and the pairing and device cookies with the rule for reading them back.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fsio::ReadProof;
use sha2::{Digest, Sha256};

use crate::http1::Headers;
use crate::http1::util::decode_uri_component;
use crate::js;

pub const PAIRING_COOKIE_NAME: &str = "mixdog_token";
/// The device route cookie: the installed web app launches at `/d/<deviceId>/` and the assets it pulls afterwards are plain
/// root URLs, so the cookie carries the route across those requests.
pub const DEVICE_COOKIE_NAME: &str = "mixdog_device";

/// A set of response headers in the order they were set: a name appears once (compared case-insensitively, the spelling and
/// place of its first setting kept, as `{ ...a, ...b }` handed to `writeHead` leaves it) and holds one value or, for
/// `Set-Cookie`, several.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResponseHeaders {
    entries: Vec<(String, Vec<String>)>,
}

impl ResponseHeaders {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets `name` to one value, replacing an earlier setting in place.
    pub fn set(&mut self, name: &str, value: impl Into<String>) {
        self.set_values(name, vec![value.into()]);
    }

    /// Sets `name` to several values (one header line each).
    pub fn set_values(&mut self, name: &str, values: Vec<String>) {
        match self.entries.iter_mut().find(|(existing, _)| existing.eq_ignore_ascii_case(name)) {
            Some(entry) => entry.1 = values,
            None => self.entries.push((name.to_owned(), values)),
        }
    }

    /// `{ ...self, ...other }`.
    pub fn extend(&mut self, other: &Self) {
        for (name, values) in &other.entries {
            self.set_values(name, values.clone());
        }
    }

    /// The first value of `name`.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.values(name).first().map(String::as_str)
    }

    pub fn values(&self, name: &str) -> &[String] {
        self.entries.iter().find(|(existing, _)| existing.eq_ignore_ascii_case(name)).map_or(&[], |(_, values)| values)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &[String])> {
        self.entries.iter().map(|(name, values)| (name.as_str(), values.as_slice()))
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The script part of the policy; the hash of an inlined boot script goes after `'self'`.
const SCRIPT_SRC: &str = "script-src 'self'";

/// `BROWSER_SECURITY_HEADERS['Content-Security-Policy']`. `'self'` of `frame-src` covers the `/preview-frame` route.
const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com; media-src 'self' data: blob:; frame-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/// `BROWSER_SECURITY_HEADERS`, in the order they are sent.
pub const BROWSER_SECURITY_HEADERS: [(&str, &str); 7] = [
    ("Content-Security-Policy", CONTENT_SECURITY_POLICY),
    ("Cross-Origin-Opener-Policy", "same-origin"),
    ("Cross-Origin-Resource-Policy", "same-origin"),
    ("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
];

/// The base security headers, sent on every answer, HEAD and 304 included.
pub fn browser_security_headers() -> ResponseHeaders {
    let mut headers = ResponseHeaders::new();
    for (name, value) in BROWSER_SECURITY_HEADERS {
        headers.set(name, value);
    }
    headers
}

/// `browserSecurityHeadersForTarget`: the production renderer inlines `boot.js` into `index.html` to remove a
/// parser-blocking round trip. Only that exact source is granted script permission (its sha256), and only when the served
/// document really contains it; every other answer keeps the self-only script policy.
pub fn security_headers_for_target<P: ReadProof>(proof: &P, target: &Path) -> ResponseHeaders {
    let mut headers = browser_security_headers();
    if !target.to_string_lossy().ends_with("index.html") {
        return headers;
    }
    let Some(dir) = target.parent() else { return headers };
    let (Ok(source), Ok(document)) = (mixdog_fsio::read(proof, dir.join("boot.js")), mixdog_fsio::read(proof, target)) else {
        return headers;
    };
    let source = js::decode_utf8(&source);
    let document = js::decode_utf8(&document);
    if !document.contains(&format!("<script>{source}</script>")) {
        return headers;
    }
    let hash = STANDARD.encode(Sha256::digest(source.as_bytes()));
    let policy = CONTENT_SECURITY_POLICY.replacen(SCRIPT_SRC, &format!("{SCRIPT_SRC} 'sha256-{hash}'"), 1);
    headers.set("Content-Security-Policy", policy);
    headers
}

/// `parseCookieValue`: the decoded value of cookie `name`, empty when it is absent or does not decode.
fn parse_cookie_value(header: Option<&str>, name: &str) -> String {
    for part in header.unwrap_or_default().split(';') {
        let Some(eq) = part.find('=') else { continue };
        if eq > 0 && js::js_trim(&part[..eq]) == name {
            return decode_uri_component(js::js_trim(&part[eq + 1..])).unwrap_or_default();
        }
    }
    String::new()
}

/// `parseCookieToken`: per-browser credentials ride Authorization or localStorage; the cookie is the fallback for asset
/// requests a browser sends with no header of its own.
pub fn parse_cookie_token(header: Option<&str>) -> String {
    parse_cookie_value(header, PAIRING_COOKIE_NAME)
}

/// Whether a request's cookie may count as a credential. The app's own requests are same-origin (or browser-initiated,
/// `Sec-Fetch-Site: none`) and an outside link opening the relay is a top-level document navigation. Anything else cross-site
/// (including the opaque-origin preview frame, whose requests carry `Origin: null`) never authenticates by cookie. A browser
/// without Fetch Metadata is judged by `SameSite=Lax` alone.
pub fn cookie_credential_allowed(headers: &Headers) -> bool {
    if js::js_trim(headers.get("origin").unwrap_or_default()).to_lowercase() == "null" {
        return false;
    }
    let site = headers.get("sec-fetch-site").unwrap_or_default().to_lowercase();
    if site != "cross-site" && site != "same-site" {
        return true;
    }
    headers.get("sec-fetch-mode").unwrap_or_default().to_lowercase() == "navigate"
        && headers.get("sec-fetch-dest").unwrap_or_default().to_lowercase() == "document"
}

/// `requestCookieToken`: the pairing cookie of a request, when it may authenticate.
pub fn request_cookie_token(headers: &Headers) -> String {
    if cookie_credential_allowed(headers) { parse_cookie_token(headers.get("cookie")) } else { String::new() }
}

/// `parseCookieDevice`: which desktop this container was launched for, set by the `/d/<id>/` entry navigation and read by
/// every root asset request that follows.
pub fn parse_cookie_device(header: Option<&str>) -> String {
    parse_cookie_value(header, DEVICE_COOKIE_NAME)
}

/// `encodeURIComponent`: everything but `A-Za-z0-9 - _ . ! ~ * ' ( )` as upper-case `%XX` of its UTF-8 bytes.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn cookie_header(name: &str, value: &str, encrypted: bool, http_only: bool) -> ResponseHeaders {
    let mut headers = ResponseHeaders::new();
    if value.is_empty() {
        return headers;
    }
    let secure = if encrypted { "; Secure" } else { "" };
    let flags = if http_only { "HttpOnly; " } else { "" };
    let cookie = format!("{name}={}; Path=/; Max-Age=31536000; {flags}SameSite=Lax{secure}", encode_uri_component(value));
    headers.set("Set-Cookie", cookie);
    headers
}

/// `pairingCookieHeaders`: persists the entry token; empty when the request had none. `encrypted` is
/// `request.socket.encrypted`.
pub fn pairing_cookie_headers(query_token: &str, encrypted: bool) -> ResponseHeaders {
    cookie_header(PAIRING_COOKIE_NAME, query_token, encrypted, true)
}

/// `deviceCookieHeaders`: not HttpOnly on purpose. It names no secret, and the app shell reads it to recover its device
/// route when a navigation lands outside `/d/<id>/`.
pub fn device_cookie_headers(device_id: &str, encrypted: bool) -> ResponseHeaders {
    cookie_header(DEVICE_COOKIE_NAME, device_id, encrypted, false)
}

/// `mergeCookieHeaders`: one response may set both cookies, which a plain merge would drop one of.
pub fn merge_cookie_headers(sets: &[&ResponseHeaders]) -> ResponseHeaders {
    let cookies: Vec<String> = sets.iter().flat_map(|set| set.values("Set-Cookie").iter().cloned()).collect();
    let mut merged = ResponseHeaders::new();
    if !cookies.is_empty() {
        merged.set_values("Set-Cookie", cookies);
    }
    merged
}
