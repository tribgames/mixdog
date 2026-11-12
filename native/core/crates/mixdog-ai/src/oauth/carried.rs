//! The credentials a request carried, and the forms each takes in text that comes back.
//!
//! A server repeats the credential it was sent inside its refusal, an SSE error, a redirect's `Location` or a
//! header. It does not always repeat it as it was sent: a query string holds it percent-encoded, a Basic
//! header holds `user:key` in base64, and a proxy or a log may hold the URL-safe base64. [`forms`] is every
//! spelling the redaction looks for; [`note`] remembers what a request carried so the transport redacts it
//! from everything that comes back on that request's behalf, however the text is cut into chunks.

use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::engine::general_purpose::URL_SAFE;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;

pub const REDACTED: &str = "[REDACTED]";

/// A credential shorter than this is not remembered from a request (it would redact ordinary words from every
/// stream): the scrub of a value the caller names has no such floor.
const MIN_NOTED: usize = 8;
/// A part of a credential (the key of `user:key`) shorter than this is not a form of its own.
const MIN_PART: usize = 4;
/// Credentials remembered at once; the oldest goes first.
const MAX_NOTED: usize = 256;
/// A request body larger than this carries no credential field (a login body is a few hundred bytes).
const MAX_BODY: usize = 64 * 1024;

fn percent(text: &str, keep: fn(u8) -> bool, lower: bool, plus: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if keep(byte) {
            out.push(char::from(byte));
        } else if plus && byte == b' ' {
            out.push('+');
        } else if lower {
            out.push_str(&format!("%{byte:02x}"));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `encodeURIComponent`'s unreserved set.
fn component(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte)
}

/// RFC 3986's unreserved set (what a form encoder and most clients keep).
fn unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-._~".contains(&byte)
}

/// The `user:key` a Basic credential's base64 holds, when `text` is one (either alphabet, padded or not).
fn decoded_basic(text: &str) -> Option<String> {
    if text.len() < MIN_NOTED {
        return None;
    }
    [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD].iter().find_map(|engine| {
        let bytes = engine.decode(text).ok()?;
        let decoded = String::from_utf8(bytes).ok()?;
        (decoded.contains(':') && !decoded.chars().any(char::is_control)).then_some(decoded)
    })
}

fn spread(base: &str, out: &mut Vec<String>) {
    let mut add = |form: String| {
        if !form.is_empty() && !out.contains(&form) {
            out.push(form);
        }
    };
    add(base.to_owned());
    add(percent(base, component, false, false));
    add(percent(base, unreserved, false, false));
    add(percent(base, unreserved, true, false));
    add(percent(base, unreserved, false, true));
    add(STANDARD.encode(base));
    add(STANDARD_NO_PAD.encode(base));
    add(URL_SAFE.encode(base));
    add(URL_SAFE_NO_PAD.encode(base));
}

/// Every spelling of `secret` the redaction looks for: itself, percent-encoded (`encodeURIComponent`, RFC 3986 in
/// either hex case, form `+`), base64 and base64url (padded or not); for a `user:key` the key alone in all of those;
/// for a Basic credential's base64 the `user:key` it holds and its key.
pub fn forms(secret: &str) -> Vec<String> {
    let mut out = Vec::new();
    spread(secret, &mut out);
    let mut parts = Vec::new();
    if let Some((_, key)) = secret.split_once(':') {
        parts.push(key.to_owned());
    }
    if let Some(decoded) = decoded_basic(secret) {
        if let Some((_, key)) = decoded.split_once(':') {
            parts.push(key.to_owned());
        }
        parts.push(decoded);
    }
    for part in parts.iter().filter(|part| part.len() >= MIN_PART) {
        spread(part, &mut out);
    }
    out
}

/// A set of byte strings found in text, leftmost first and longest at a position.
pub struct Matcher {
    forms: Vec<Vec<u8>>,
    first: [bool; 256],
    longest: usize,
}

impl Matcher {
    fn new(mut forms: Vec<Vec<u8>>) -> Self {
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        let mut first = [false; 256];
        for form in &forms {
            first[usize::from(form[0])] = true;
        }
        let longest = forms.first().map_or(0, Vec::len);
        Self { forms, first, longest }
    }

    pub fn of_secrets(secrets: &[&str]) -> Self {
        Self::new(secrets.iter().filter(|secret| !secret.is_empty()).flat_map(|secret| forms(secret)).map(String::into_bytes).collect())
    }

    pub fn is_empty(&self) -> bool {
        self.forms.is_empty()
    }

    /// The length of the longest form at the start of `rest`.
    fn matched(&self, rest: &[u8]) -> Option<usize> {
        self.forms.iter().find(|form| rest.starts_with(form)).map(Vec::len)
    }

    /// Whether `rest` is the beginning of a form that has not finished arriving.
    fn partial(&self, rest: &[u8]) -> bool {
        rest.len() < self.longest && self.forms.iter().any(|form| form.len() > rest.len() && form.starts_with(rest))
    }

    /// `hay` with every form redacted, and where the tail that may still become a form begins (`hay.len()` when
    /// `last`, or when there is none): the bytes before it are final, the rest waits for the next chunk.
    pub fn redact(&self, hay: &[u8], last: bool) -> (Vec<u8>, usize) {
        let mut out = Vec::with_capacity(hay.len());
        let mut i = 0;
        while i < hay.len() {
            if !self.first[usize::from(hay[i])] {
                out.push(hay[i]);
                i += 1;
                continue;
            }
            if !last && self.partial(&hay[i..]) {
                return (out, i);
            }
            match self.matched(&hay[i..]) {
                Some(len) => {
                    out.extend_from_slice(REDACTED.as_bytes());
                    i += len;
                }
                None => {
                    out.push(hay[i]);
                    i += 1;
                }
            }
        }
        (out, hay.len())
    }

    /// `hay` redacted, or `None` when nothing in it needed to be.
    pub fn redacted(&self, hay: &[u8]) -> Option<Vec<u8>> {
        let (out, _) = self.redact(hay, true);
        (out != hay).then_some(out)
    }

    pub fn redact_str(&self, text: &str) -> String {
        self.redacted(text.as_bytes()).map_or_else(|| text.to_owned(), |out| String::from_utf8_lossy(&out).into_owned())
    }

    pub fn redact_headers(&self, headers: &mut [(String, String)]) {
        for (_, value) in headers {
            if let Some(clean) = self.redacted(value.as_bytes()) {
                *value = String::from_utf8_lossy(&clean).into_owned();
            }
        }
    }

    /// The error with every text it carries redacted (a transport error names the URL, query string included).
    pub fn redact_error(&self, mut error: ProviderError) -> ProviderError {
        error.message = self.redact_str(&error.message);
        error.code = error.code.map(|code| self.redact_str(&code));
        error
    }
}

struct Noted {
    secrets: Vec<String>,
    matcher: Arc<Matcher>,
}

static NOTED: LazyLock<Mutex<Noted>> = LazyLock::new(|| Mutex::new(Noted { secrets: Vec::new(), matcher: Arc::new(Matcher::new(Vec::new())) }));

/// Remembers `secret` as carried by a request.
pub fn note(secret: &str) {
    let secret = secret.trim();
    if secret.len() < MIN_NOTED {
        return;
    }
    let mut noted = NOTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if noted.secrets.iter().any(|known| known == secret) {
        return;
    }
    noted.secrets.push(secret.to_owned());
    if noted.secrets.len() > MAX_NOTED {
        noted.secrets.remove(0);
    }
    let all: Vec<&str> = noted.secrets.iter().map(String::as_str).collect();
    noted.matcher = Arc::new(Matcher::of_secrets(&all));
}

/// Forgets every remembered credential, as a new process has none.
#[cfg(any(test, feature = "test-support"))]
pub fn reset() {
    let mut noted = NOTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    noted.secrets.clear();
    noted.matcher = Arc::new(Matcher::new(Vec::new()));
}

/// What every credential a request carried has been, as one matcher.
pub fn matcher() -> Arc<Matcher> {
    NOTED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).matcher.clone()
}

/// `text` with every credential any request carried redacted, in every form.
pub fn redact(text: &str) -> String {
    matcher().redact_str(text)
}

fn name_form(name: &str) -> String {
    name.chars().filter(|c| *c != '_' && *c != '-').flat_map(char::to_lowercase).collect()
}

/// A field (query parameter, form field, JSON key) whose value is a credential.
fn secret_field(name: &str) -> bool {
    let name = name_form(name);
    ["key", "token", "secret", "password", "assertion", "verifier", "signature"].iter().any(|tail| name.ends_with(tail))
        || ["code", "sig", "auth", "authorization"].contains(&name.as_str())
}

/// A header whose value is a credential.
fn secret_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    if name.starts_with("sec-websocket-") {
        return false;
    }
    ["authorization", "proxy-authorization", "cookie"].contains(&name.as_str())
        || ["key", "token", "secret", "password"].iter().any(|tail| name.ends_with(tail))
}

fn note_header(name: &str, value: &str) {
    if !secret_header(name) {
        return;
    }
    if name.eq_ignore_ascii_case("cookie") {
        for pair in value.split(';') {
            if let Some((_, cookie)) = pair.split_once('=') {
                note(cookie);
            }
        }
        return;
    }
    // The credential of `<scheme> <credential>` is what a server repeats: the scheme is a word, and the redaction
    // of a bearer keeps it (`Bearer [REDACTED]`).
    match value.split_once(' ').filter(|(scheme, _)| scheme.chars().all(|c| c.is_ascii_alphabetic())) {
        Some((_, credentials)) => note(credentials),
        None => note(value),
    }
}

fn note_url(url: &str) {
    let Ok(parsed) = url::Url::parse(url) else { return };
    for part in [parsed.username(), parsed.password().unwrap_or("")] {
        note(part);
        note(&percent_decoded(part));
    }
    for (name, value) in parsed.query_pairs() {
        if secret_field(&name) {
            note(&value);
        }
    }
}

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|pair| std::str::from_utf8(pair).ok()).and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn note_json(value: &serde_json::Value, depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (name, inner) in map {
                match inner {
                    serde_json::Value::String(text) if secret_field(name) => note(text),
                    _ => note_json(inner, depth + 1),
                }
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| note_json(item, depth + 1)),
        _ => {}
    }
}

fn note_body(body: &[u8]) {
    if body.is_empty() || body.len() > MAX_BODY {
        return;
    }
    if matches!(body[0], b'{' | b'[') {
        if let Ok(json) = serde_json::from_slice(body) {
            note_json(&json, 0);
        }
        return;
    }
    for (name, value) in url::form_urlencoded::parse(body) {
        if secret_field(&name) {
            note(&value);
        }
    }
}

/// Remembers every credential `request` carries: its credential headers, the userinfo and credential parameters of its
/// URL and the credential fields of a login body.
pub fn note_request(request: &WireRequest) {
    note_headers(&request.headers);
    note_url(&request.url);
    note_body(&request.body);
}

pub fn note_headers(headers: &[(String, String)]) {
    for (name, value) in headers {
        note_header(name, value);
    }
}

/// Remembers what a WebSocket upgrade request carries.
pub fn note_upgrade(uri: &str, headers: &[(String, String)]) {
    note_headers(headers);
    note_url(uri);
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "carried/key+with spaces&odd=chars-7f3a";

    fn redacted(text: &str) -> String {
        Matcher::of_secrets(&[KEY]).redact_str(text)
    }

    #[test]
    fn every_spelling_of_a_credential_is_redacted() {
        let spellings = [
            KEY.to_owned(),
            percent(KEY, component, false, false),
            percent(KEY, unreserved, true, false),
            percent(KEY, unreserved, false, true),
            STANDARD.encode(KEY),
            URL_SAFE_NO_PAD.encode(KEY),
        ];
        for spelling in spellings {
            let clean = redacted(&format!("refused {spelling} for this account"));
            assert_eq!(clean, "refused [REDACTED] for this account", "{spelling}");
        }
    }

    #[test]
    fn a_basic_header_value_names_its_key() {
        let header = STANDARD.encode(format!("user:{KEY}"));
        let url_safe = URL_SAFE_NO_PAD.encode(format!("user:{KEY}"));
        let clean = Matcher::of_secrets(&[&header]).redact_str(&format!("echo {KEY}, {header} and {url_safe}"));
        assert_eq!(clean, "echo [REDACTED], [REDACTED] and [REDACTED]");
        // A `user:key` pair is a credential whose key is one too.
        let pair = Matcher::of_secrets(&[&format!("user:{KEY}")]);
        assert_eq!(pair.redact_str(&format!("{KEY} {}", STANDARD.encode(format!("user:{KEY}")))), "[REDACTED] [REDACTED]");
    }

    /// A form cut by a chunk boundary is held back until the chunk that finishes it; only a tail that begins a form waits.
    #[test]
    fn a_credential_split_across_chunks_is_redacted() {
        let matcher = Matcher::of_secrets(&["fixture-split-credential"]);
        let text = b"data: the credential fixture-split-credential was refused";
        for cut in 1..text.len() {
            let mut held = Vec::new();
            let mut got = Vec::new();
            for chunk in [&text[..cut], &text[cut..]] {
                held.extend_from_slice(chunk);
                let (out, from) = matcher.redact(&held, false);
                held.drain(..from);
                got.extend(out);
            }
            got.extend(matcher.redact(&held, true).0);
            assert_eq!(String::from_utf8(got).unwrap(), "data: the credential [REDACTED] was refused", "cut at {cut}");
        }
    }

    /// The scrub every provider error text passes redacts a named value in each spelling, not only as it was sent.
    #[test]
    fn the_oauth_scrub_redacts_a_named_value_in_each_spelling() {
        let echoed = format!("sent {KEY}, {} and {}", percent(KEY, component, false, false), URL_SAFE_NO_PAD.encode(KEY));
        assert_eq!(super::super::scrub::scrub_oauth_secrets(&echoed, &[KEY]), "sent [REDACTED], [REDACTED] and [REDACTED]");
    }

    #[test]
    fn text_with_no_credential_is_not_held() {
        let matcher = Matcher::of_secrets(&["fixture-split-credential"]);
        let (out, from) = matcher.redact(b"plain text, no credential", false);
        assert_eq!((out.as_slice(), from), (b"plain text, no credential".as_slice(), 25));
    }

    #[test]
    fn a_request_names_the_credentials_it_carries() {
        let request = WireRequest {
            transport: mixdog_core_api::domain::keepalive::TransportKind::Http1,
            method: "POST".into(),
            url: "https://user-7f3a:urlpassword-9c1d@example.test/v1?api_key=query%2Fkey-5b2e&alt=sse".into(),
            headers: vec![
                ("Authorization".into(), "Bearer header-token-1a2b3c".into()),
                ("x-goog-api-key".into(), "goog-key-4d5e6f7a".into()),
                ("sec-websocket-key".into(), "dGhlIHNhbXBsZSBub25jZQ==".into()),
            ],
            body: br#"{"grant":{"refresh_token":"refresh-secret-8e9f0a1b"},"prompt":"hello"}"#.to_vec(),
        };
        note_request(&request);
        // The scheme stays: only the credential is a secret.
        assert_eq!(redact("Bearer header-token-1a2b3c"), "Bearer [REDACTED]");
        let text = "a header-token-1a2b3c, goog-key-4d5e6f7a, query%2Fkey-5b2e, query/key-5b2e, urlpassword-9c1d, refresh-secret-8e9f0a1b, dGhlIHNhbXBsZSBub25jZQ==";
        assert_eq!(redact(text), "a [REDACTED], [REDACTED], [REDACTED], [REDACTED], [REDACTED], [REDACTED], dGhlIHNhbXBsZSBub25jZQ==");
    }
}
