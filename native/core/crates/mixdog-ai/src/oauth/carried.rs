//! What a credential is, and how it is found again in text that comes back.
//!
//! **What a credential is.** Only what the transport itself attached to one request, by provenance ([`of_request`],
//! [`of_upgrade`]): the value of an `Authorization` / `Proxy-Authorization` header (the credential after its scheme word;
//! for `Basic`, the `user:key` its base64 holds and the key), the value of a header whose name ends in `api-key` / `apikey`,
//! the userinfo of the URL and a key in its query (`key`, `api_key`, `access_token`, `token`), and the secret fields of an
//! OAuth token request, which is known by its kind (a body with a top-level `grant_type`), never by a field name found in an
//! arbitrary body. The credentials are the exchange's own: the guard redacts them from that exchange's answer (its redirects
//! included). What the transport attached stays a credential until the process ends: [`remember`] keeps it in a
//! process-wide registry (so the old credential of a refreshed token, or the key of an earlier request, is found in the text of
//! a later one), and so are the tokens a token response grants ([`remember_grant`]), since they are attached next. The
//! registry holds at most [`REGISTRY_CAP`] values, the oldest dropped first, and its matcher ([`remembered`]) is built once
//! per registry version.
//!
//! **How it is found.** Never by a list of spellings. The text is read through a canonical view ([`canonical`]) with a map from
//! each byte of the view back to the source bytes it came from: percent-escapes (either hex case) decoded, JSON escapes
//! (`\/`, `\uXXXX` and surrogate pairs, …), `%uXXXX` escapes and HTML character references (`&#47;`, `&#x2F;`, `&sol;`, …) unescaped, NUL bytes
//! (the high half of UTF-16 text) dropped, each repeated until nothing changes; then a single line break inside a base64 run
//! (a wrapped line) is removed. In that view one automaton looks for every credential and for its base64 and base64url forms
//! at the three byte alignments (padding optional). A credential holding a space is also looked for with `+` for the space,
//! and one holding a `+` with a space for it (a form encoder's and decoder's reading of each other); the view itself keeps a
//! `+` a `+`. A JWT credential's segments count one by one. A match redacts the whole
//! source span it came from (`long%252Fkey%252Bvalue` becomes one `[REDACTED]`). A credential shorter than
//! [`WHOLE_TOKEN_BELOW`] bytes counts only as a whole token (the bytes around it are not letters, digits, `_` or `-`): it is
//! redacted after `Bearer ` or in a header without eating a part of an ordinary word. Text in which no credential is found
//! comes back byte for byte.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;

pub const REDACTED: &str = "[REDACTED]";

/// A credential shorter than this is matched only as a whole token.
pub const WHOLE_TOKEN_BELOW: usize = 8;
/// Unescaping stops after this many rounds (three layers of encoding take three).
const MAX_ROUNDS: usize = 8;
/// A base64 run at least this long before a single line break is a wrapped base64 line, joined with the next.
const WRAPPED_RUN: usize = 16;
/// A request body larger than this is no token request (a token request is a few hundred bytes).
const MAX_TOKEN_BODY: usize = 64 * 1024;
/// The secret fields of an OAuth token request (RFC 6749 and its grant extensions).
const TOKEN_FIELDS: [&str; 10] =
    ["refresh_token", "code", "code_verifier", "device_code", "assertion", "client_assertion", "client_secret", "password", "subject_token", "actor_token"];
/// The fields of a token response that name the credentials it grants (OAuth's, and Cursor's exchange in its own spelling).
const GRANT_FIELDS: [&str; 6] = ["access_token", "refresh_token", "id_token", "accessToken", "refreshToken", "idToken"];
/// A token response larger than this grants nothing that is remembered (a grant is a few kilobytes).
pub const MAX_GRANT_BODY: usize = 256 * 1024;
/// The process-wide registry holds at most this many values; over it the oldest are dropped. A daemon has a handful of
/// accounts (ten is generous) and each refresh adds an access token and, at most, an id token that differ from the last: 512
/// values are the last ~25 refreshes of every one of ten accounts, many days at the usual refresh interval of hours. The
/// cost is paid only when all of them are 1.2 KiB JWTs: then (`a_full_registry_costs_one_build_per_version`) the automaton
/// has 5.9 million states, ~140 MiB, built in about 3 s once per registry version, and a 1 MiB stream passes in ~0.3 s;
/// ordinary keys are a few hundred bytes each, a hundredth of that.
pub const REGISTRY_CAP: usize = 512;

// ---------------------------------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------------------------------

fn add(out: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if !value.is_empty() && !out.iter().any(|known| known == value) {
        out.push(value.to_owned());
    }
}

/// The `user:key` a Basic credential's base64 holds.
fn basic_pair(encoded: &str) -> Option<String> {
    let bare = encoded.trim_end_matches('=');
    [STANDARD_NO_PAD, URL_SAFE_NO_PAD].iter().find_map(|engine| String::from_utf8(engine.decode(bare).ok()?).ok()).filter(|pair| pair.contains(':'))
}

fn of_headers(headers: &[(String, String)], out: &mut Vec<String>) {
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        if name == "authorization" || name == "proxy-authorization" {
            let value = value.trim();
            match value.split_once(' ').filter(|(scheme, _)| !scheme.is_empty() && scheme.bytes().all(|b| b.is_ascii_alphabetic())) {
                Some((scheme, credential)) => {
                    let credential = credential.trim();
                    add(out, credential);
                    if scheme.eq_ignore_ascii_case("basic")
                        && let Some(pair) = basic_pair(credential)
                    {
                        add(out, &pair);
                        add(out, pair.split_once(':').map_or("", |(_, key)| key));
                    }
                }
                None => add(out, value),
            }
        } else if name.ends_with("api-key") || name.ends_with("apikey") || name.ends_with("api_key") {
            add(out, value);
        }
    }
}

fn of_url(url: &str, out: &mut Vec<String>) {
    let Ok(parsed) = url::Url::parse(url) else { return };
    for part in [parsed.username(), parsed.password().unwrap_or("")] {
        add(out, &String::from_utf8_lossy(&percent_decode(part.as_bytes())));
    }
    for (name, value) in parsed.query_pairs() {
        let name: String = name.chars().filter(|c| *c != '_' && *c != '-').flat_map(char::to_lowercase).collect();
        if ["key", "apikey", "accesstoken", "token"].contains(&name.as_str()) {
            add(out, &value);
        }
    }
}

fn percent_decode(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match (bytes[i], bytes.get(i + 1).copied().and_then(hex), bytes.get(i + 2).copied().and_then(hex)) {
            (b'%', Some(high), Some(low)) => {
                out.push(high * 16 + low);
                i += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    out
}

/// The fields of a token request (a form or JSON body with a top-level `grant_type`), the secret ones in the order they are
/// listed; `None` for any other body.
fn token_request_fields(body: &[u8]) -> Option<Vec<(String, String)>> {
    if body.is_empty() || body.len() > MAX_TOKEN_BODY {
        return None;
    }
    if body[0] == b'{' {
        let serde_json::Value::Object(fields) = serde_json::from_slice::<serde_json::Value>(body).ok()? else { return None };
        fields.get("grant_type").filter(|grant| grant.is_string())?;
        return Some(TOKEN_FIELDS.iter().filter_map(|name| Some(((*name).to_owned(), fields.get(*name)?.as_str()?.to_owned()))).collect());
    }
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(body).map(|(name, value)| (name.into_owned(), value.into_owned())).collect();
    pairs.iter().any(|(name, _)| name == "grant_type").then_some(pairs)
}

/// Whether `body` is a token request: its answer is the grant, which arrives whole.
pub fn is_token_request(body: &[u8]) -> bool {
    token_request_fields(body).is_some()
}

/// The secret fields of a token request. Any other body carries none.
fn of_token_request(body: &[u8], out: &mut Vec<String>) {
    for (name, value) in token_request_fields(body).unwrap_or_default() {
        if TOKEN_FIELDS.contains(&name.as_str()) {
            add(out, &value);
        }
    }
}

/// Remembers the credentials a token response (a JSON object) grants: they are attached to the requests that follow.
pub fn remember_grant(body: &[u8]) {
    if body.len() > MAX_GRANT_BODY {
        return;
    }
    let Some(serde_json::Value::Object(fields)) = serde_json::from_slice::<serde_json::Value>(body).ok() else { return };
    let mut granted = Vec::new();
    for name in GRANT_FIELDS {
        if let Some(value) = fields.get(name).and_then(serde_json::Value::as_str) {
            add(&mut granted, value);
        }
    }
    remember(&granted);
}

/// The credentials the transport attached to `request` (see the module's rule).
pub fn of_request(request: &WireRequest) -> Vec<String> {
    let mut out = Vec::new();
    of_headers(&request.headers, &mut out);
    of_url(&request.url, &mut out);
    of_token_request(&request.body, &mut out);
    out
}

/// The credentials a WebSocket upgrade carries: its credential headers and the userinfo and key of its URL.
pub fn of_upgrade(uri: &str, headers: &[(String, String)]) -> Vec<String> {
    let mut out = Vec::new();
    of_headers(headers, &mut out);
    of_url(uri, &mut out);
    out
}

// ---------------------------------------------------------------------------------------------------------------------
// The canonical view
// ---------------------------------------------------------------------------------------------------------------------

/// The source bytes `[start, end)` one byte of a view came from.
type Span = (usize, usize);

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

pub(crate) fn is_base64(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'-' | b'_')
}

/// A byte of a word: what a whole-token credential may not touch.
fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') || byte >= 0x80
}

/// The ASCII characters HTML names (`&sol;`, `&plus;`, …).
const ENTITIES: [(&str, u8); 30] = [
    ("amp", b'&'), ("lt", b'<'), ("gt", b'>'), ("quot", b'"'), ("apos", b'\''), ("sol", b'/'), ("bsol", b'\\'), ("plus", b'+'),
    ("equals", b'='), ("percnt", b'%'), ("num", b'#'), ("colon", b':'), ("semi", b';'), ("lowbar", b'_'), ("period", b'.'),
    ("comma", b','), ("excl", b'!'), ("quest", b'?'), ("dollar", b'$'), ("lpar", b'('), ("rpar", b')'), ("ast", b'*'),
    ("commat", b'@'), ("lsqb", b'['), ("rsqb", b']'), ("lcub", b'{'), ("rcub", b'}'), ("verbar", b'|'), ("grave", b'`'), ("Hat", b'^'),
];
/// The longest HTML reference read (`&#x0010FFFF;`).
const MAX_REFERENCE: usize = 12;

/// What one escape at a position decodes to.
enum Escape {
    /// `len` source bytes are one byte (a percent-escape is a byte, not a character).
    Byte(usize, u8),
    /// `len` source bytes are the UTF-8 bytes of `char`.
    Char(usize, char),
    /// The text ends inside what may still become an escape.
    Unfinished,
    None,
}

fn hex4(bytes: &[u8], at: usize) -> Option<u32> {
    let digits = bytes.get(at..at + 4)?;
    digits.iter().try_fold(0_u32, |value, b| Some(value * 16 + u32::from(hex(*b)?)))
}

/// Whether `rest` is a beginning of `\uXXXX`.
fn json_unit_prefix(rest: &[u8]) -> bool {
    rest.len() < 6 && rest.first().is_none_or(|b| *b == b'\\') && rest.get(1).is_none_or(|b| *b == b'u') && rest.iter().skip(2).all(|b| hex(*b).is_some())
}

fn escape_at(bytes: &[u8], i: usize) -> Escape {
    let rest = &bytes[i..];
    match rest[0] {
        // `%uXXXX`, the escape of JavaScript's `escape()`, is a UTF-16 unit like a JSON `\uXXXX`.
        b'%' if rest.get(1) == Some(&b'u') => match hex4(rest, 2) {
            Some(unit) => char::from_u32(unit).map_or(Escape::None, |c| Escape::Char(6, c)),
            None if rest.len() < 6 && rest.iter().skip(2).all(|b| hex(*b).is_some()) => Escape::Unfinished,
            None => Escape::None,
        },
        b'%' => match (rest.get(1).copied().map(hex), rest.get(2).copied().map(hex)) {
            (Some(Some(high)), Some(Some(low))) => Escape::Byte(3, high * 16 + low),
            (None, _) | (Some(Some(_)), None) => Escape::Unfinished,
            _ => Escape::None,
        },
        b'\\' => match rest.get(1) {
            None => Escape::Unfinished,
            Some(b'u') => {
                let Some(unit) = hex4(rest, 2) else {
                    return if json_unit_prefix(rest) { Escape::Unfinished } else { Escape::None };
                };
                if (0xD800..0xDC00).contains(&unit) {
                    return match hex4(rest, 8).filter(|_| rest.get(6..8) == Some(b"\\u")) {
                        Some(low) if (0xDC00..0xE000).contains(&low) => {
                            char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)).map_or(Escape::None, |c| Escape::Char(12, c))
                        }
                        _ if json_unit_prefix(&rest[6..]) => Escape::Unfinished,
                        _ => Escape::None,
                    };
                }
                char::from_u32(unit).map_or(Escape::None, |c| Escape::Char(6, c))
            }
            Some(&b) => match b {
                b'/' | b'\\' | b'"' => Escape::Byte(2, b),
                b'b' => Escape::Byte(2, 0x08),
                b'f' => Escape::Byte(2, 0x0C),
                b'n' => Escape::Byte(2, b'\n'),
                b'r' => Escape::Byte(2, b'\r'),
                b't' => Escape::Byte(2, b'\t'),
                _ => Escape::None,
            },
        },
        b'&' => {
            let body = &rest[1..rest.len().min(MAX_REFERENCE)];
            let Some(end) = body.iter().position(|b| *b == b';') else {
                return if rest.len() < MAX_REFERENCE && body.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'#') { Escape::Unfinished } else { Escape::None };
            };
            let name = &body[..end];
            let value = match name {
                [b'#', b'x' | b'X', digits @ ..] if !digits.is_empty() && digits.len() <= 8 => {
                    digits.iter().try_fold(0_u32, |value, b| Some(value * 16 + u32::from(hex(*b)?)))
                }
                [b'#', digits @ ..] if !digits.is_empty() && digits.len() <= 8 => {
                    digits.iter().try_fold(0_u32, |value, b| b.is_ascii_digit().then(|| value * 10 + u32::from(b - b'0')))
                }
                _ => return ENTITIES.iter().find(|(entity, _)| entity.as_bytes() == name).map_or(Escape::None, |(_, byte)| Escape::Byte(end + 2, *byte)),
            };
            value.and_then(char::from_u32).map_or(Escape::None, |c| Escape::Char(end + 2, c))
        }
        _ => Escape::None,
    }
}

/// One layer of the view: its bytes and, unless it is the source itself, the source span of each.
struct Layer {
    bytes: Vec<u8>,
    spans: Option<Vec<Span>>,
}

impl Layer {
    fn span(&self, i: usize) -> Span {
        self.spans.as_ref().map_or((i, i + 1), |spans| spans[i])
    }
}

/// The next layer, built only once something in the current one changes.
struct Next {
    bytes: Vec<u8>,
    spans: Vec<Span>,
    /// The source start of bytes dropped before the first kept one.
    dropped_from: Option<usize>,
}

impl Next {
    fn of_prefix(layer: &Layer, upto: usize) -> Self {
        Self { bytes: layer.bytes[..upto].to_vec(), spans: (0..upto).map(|i| layer.span(i)).collect(), dropped_from: None }
    }

    fn push(&mut self, bytes: &[u8], span: Span) {
        let start = self.dropped_from.take().map_or(span.0, |from| from.min(span.0));
        for byte in bytes {
            self.bytes.push(*byte);
            self.spans.push((start, span.1));
        }
    }

    /// The source bytes belong to the byte before them (the low half of a UTF-16 unit, the break of a wrapped line).
    fn drop(&mut self, span: Span) {
        match self.spans.last_mut() {
            Some(last) => last.1 = span.1,
            None => self.dropped_from = Some(self.dropped_from.map_or(span.0, |from| from.min(span.0))),
        }
    }

    fn into_layer(self) -> Layer {
        Layer { bytes: self.bytes, spans: Some(self.spans) }
    }
}

/// One round of unescaping; `hold` lowers to the source start of an escape the text ends inside.
fn unescape(layer: &Layer, last: bool, hold: &mut usize) -> Option<Layer> {
    let bytes = &layer.bytes;
    let mut next: Option<Next> = None;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        let escape = if matches!(byte, b'%' | b'\\' | b'&') { escape_at(bytes, i) } else { Escape::None };
        match escape {
            Escape::Byte(len, decoded) => {
                let span = (layer.span(i).0, layer.span(i + len - 1).1);
                next.get_or_insert_with(|| Next::of_prefix(layer, i)).push(&[decoded], span);
                i += len;
                continue;
            }
            Escape::Char(len, decoded) => {
                let span = (layer.span(i).0, layer.span(i + len - 1).1);
                let mut utf8 = [0_u8; 4];
                next.get_or_insert_with(|| Next::of_prefix(layer, i)).push(decoded.encode_utf8(&mut utf8).as_bytes(), span);
                i += len;
                continue;
            }
            Escape::Unfinished if !last => *hold = (*hold).min(layer.span(i).0),
            _ => {}
        }
        if byte == 0 {
            next.get_or_insert_with(|| Next::of_prefix(layer, i)).drop(layer.span(i));
        } else if let Some(next) = next.as_mut() {
            next.push(&[byte], layer.span(i));
        }
        i += 1;
    }
    next.map(Next::into_layer)
}

/// The layer with each single line break inside a base64 run of at least [`WRAPPED_RUN`] characters removed (`context_run`:
/// the run the text handed on before this one ended in). `ends` gets the view positions where a run meets the end of an
/// unfinished text through blanks only: the next text may continue the line.
fn wrap_points(layer: &Layer, context_run: usize, last: bool, ends: &mut Vec<usize>) -> Option<Layer> {
    let bytes = &layer.bytes;
    let mut next: Option<Next> = None;
    let mut run = context_run;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if run >= WRAPPED_RUN && matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
            let mut j = i;
            let mut breaks = 0;
            while j < bytes.len() && matches!(bytes[j], b' ' | b'\t' | b'\r' | b'\n') {
                if bytes[j] == b'\n' || (bytes[j] == b'\r' && bytes.get(j + 1) != Some(&b'\n')) {
                    breaks += 1;
                }
                j += 1;
            }
            if j == bytes.len() && !last && breaks <= 1 {
                // The next text may continue the base64 line: the view's position before the break is where a credential
                // that begins on this line would continue.
                ends.push(next.as_ref().map_or(i, |next| next.bytes.len()));
            } else if j < bytes.len() && breaks == 1 && is_base64(bytes[j]) {
                let next = next.get_or_insert_with(|| Next::of_prefix(layer, i));
                for k in i..j {
                    next.drop(layer.span(k));
                }
                i = j;
                continue;
            }
        }
        run = if is_base64(byte) { run + 1 } else { 0 };
        if let Some(next) = next.as_mut() {
            next.push(&[byte], layer.span(i));
        }
        i += 1;
    }
    next.map(Next::into_layer)
}

/// The canonical view of `source` (see the module's rule), the view positions where a wrapped base64 line may continue in
/// the next text, and the source position from which the text is not final (an escape it ends inside).
fn canonical(source: &[u8], context: Context, last: bool) -> (Layer, Vec<usize>, usize) {
    let mut hold = source.len();
    let mut layer = Layer { bytes: source.to_vec(), spans: None };
    for _ in 0..MAX_ROUNDS {
        match unescape(&layer, last, &mut hold) {
            Some(next) => layer = next,
            None => break,
        }
    }
    let mut ends = Vec::new();
    if let Some(joined) = wrap_points(&layer, context.run, last, &mut ends) {
        layer = joined;
    }
    (layer, ends, hold)
}

// ---------------------------------------------------------------------------------------------------------------------
// The patterns and their automaton
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// Found anywhere.
    Anywhere,
    /// Found only with no word byte on either side.
    Token,
    /// The base64 characters wholly made of the credential's bits: the partial character on each side and the padding
    /// belong to the match too.
    Base64,
}

/// The characters of `secret`'s base64 at each of the three byte alignments that hold its bits alone, in both alphabets.
fn base64_cores(secret: &[u8], out: &mut Vec<(Vec<u8>, Kind)>) {
    for align in 0..3 {
        let mut shifted = vec![0_u8; align];
        shifted.extend_from_slice(secret);
        let encoded = STANDARD_NO_PAD.encode(&shifted).into_bytes();
        let first = (8 * align).div_ceil(6);
        let end = 8 * (align + secret.len()) / 6;
        let core = encoded[first..end].to_vec();
        let url: Vec<u8> = core.iter().map(|b| match b {
            b'+' => b'-',
            b'/' => b'_',
            other => *other,
        }).collect();
        out.push((core, Kind::Base64));
        out.push((url, Kind::Base64));
    }
}

/// Every pattern of one credential.
fn patterns_of(secret: &str, out: &mut Vec<(Vec<u8>, Kind)>) {
    let mut plain = vec![secret.to_owned()];
    // A credential holding an escape is echoed raw and found in the view decoded.
    let (decoded, _, _) = canonical(secret.as_bytes(), Context::default(), true);
    plain.push(String::from_utf8_lossy(&decoded.bytes).into_owned());
    // A form encoder writes a space as `+`, which the view keeps (a `+` of a key is a `+`).
    if secret.contains(' ') {
        plain.push(secret.replace(' ', "+"));
    }
    // ...and a form decoder reads that `+` back as a space (not for a credential that would begin or end with one).
    if secret.contains('+') && !secret.starts_with('+') && !secret.ends_with('+') {
        plain.push(secret.replace('+', " "));
    }
    // A JWT's segments, each echoed alone.
    let segments: Vec<&str> = secret.split('.').collect();
    if segments.len() == 3 && segments[0].starts_with("eyJ") && segments.iter().all(|s| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) {
        plain.extend(segments.iter().map(|s| (*s).to_owned()));
    }
    for text in plain.iter().filter(|text| !text.is_empty()) {
        let bytes = text.as_bytes();
        if bytes.len() < WHOLE_TOKEN_BELOW {
            out.push((bytes.to_vec(), Kind::Token));
            out.push((STANDARD_NO_PAD.encode(bytes).into_bytes(), Kind::Token));
            out.push((URL_SAFE_NO_PAD.encode(bytes).into_bytes(), Kind::Token));
            continue;
        }
        out.push((bytes.to_vec(), Kind::Anywhere));
        base64_cores(bytes, out);
        if !text.is_ascii() {
            // UTF-16 text, its NULs dropped by the view.
            let le: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).filter(|b| *b != 0).collect();
            let be: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).filter(|b| *b != 0).collect();
            out.push((le, Kind::Anywhere));
            out.push((be, Kind::Anywhere));
        }
    }
}

/// No pattern ends at the state.
const NO_PATTERN: u32 = u32::MAX;

/// A multi-pattern automaton (Aho-Corasick): one pass over each text. Built compactly (25 bytes a state, children as a
/// sibling list) because the registry's automaton holds every credential the process ever attached.
struct Automaton {
    /// The state after the first byte of a pattern (0: none).
    root: Box<[u32; 256]>,
    /// A state's first child and its next sibling (0: none), and the byte that leads to it.
    first: Vec<u32>,
    sibling: Vec<u32>,
    byte: Vec<u8>,
    fail: Vec<u32>,
    depth: Vec<u32>,
    /// The pattern that ends at the state, and the nearest state on its fail chain where one does (0: none).
    own: Vec<u32>,
    dict: Vec<u32>,
}

impl Automaton {
    fn child(&self, state: usize, byte: u8) -> Option<u32> {
        if state == 0 {
            return Some(self.root[usize::from(byte)]).filter(|to| *to != 0);
        }
        let mut at = self.first[state];
        while at != 0 {
            if self.byte[at as usize] == byte {
                return Some(at);
            }
            at = self.sibling[at as usize];
        }
        None
    }

    fn new<'a>(patterns: impl Iterator<Item = &'a [u8]>) -> Self {
        let mut a = Self {
            root: Box::new([0_u32; 256]),
            first: vec![0],
            sibling: vec![0],
            byte: vec![0],
            fail: vec![0],
            depth: vec![0],
            own: vec![NO_PATTERN],
            dict: vec![0],
        };
        for (id, pattern) in patterns.enumerate() {
            let mut state = 0_usize;
            for &byte in pattern {
                state = match a.child(state, byte) {
                    Some(to) => to as usize,
                    None => {
                        let to = a.first.len() as u32;
                        let depth = a.depth[state] + 1;
                        a.first.push(0);
                        a.byte.push(byte);
                        a.fail.push(0);
                        a.depth.push(depth);
                        a.own.push(NO_PATTERN);
                        a.dict.push(0);
                        if state == 0 {
                            a.root[usize::from(byte)] = to;
                            a.sibling.push(0);
                        } else {
                            let head = a.first[state];
                            a.sibling.push(head);
                            a.first[state] = to;
                        }
                        to as usize
                    }
                };
            }
            a.own[state] = id as u32;
        }
        let mut queue: Vec<u32> = a.root.iter().copied().filter(|to| *to != 0).collect();
        let mut head = 0;
        while head < queue.len() {
            let state = queue[head] as usize;
            head += 1;
            let mut child = a.first[state];
            while child != 0 {
                let byte = a.byte[child as usize];
                let mut back = a.fail[state] as usize;
                let target = loop {
                    if let Some(next) = a.child(back, byte) {
                        break next;
                    }
                    if back == 0 {
                        break 0;
                    }
                    back = a.fail[back] as usize;
                };
                a.fail[child as usize] = target;
                a.dict[child as usize] = if a.own[target as usize] != NO_PATTERN { target } else { a.dict[target as usize] };
                queue.push(child);
                child = a.sibling[child as usize];
            }
        }
        a
    }

    fn step(&self, mut state: u32, byte: u8) -> u32 {
        loop {
            if let Some(to) = self.child(state as usize, byte) {
                return to;
            }
            if state == 0 {
                return 0;
            }
            state = self.fail[state as usize];
        }
    }

    /// Calls `found` with each pattern that ends at `state`.
    fn ending(&self, state: u32, mut found: impl FnMut(u32)) {
        let mut at = if self.own[state as usize] != NO_PATTERN { state } else { self.dict[state as usize] };
        while at != 0 {
            found(self.own[at as usize]);
            at = self.dict[at as usize];
        }
    }

    fn states(&self) -> usize {
        self.first.len()
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------------------------------------------------

/// What the text handed on before the text being read ended with, in the view: its last byte (the left side of a whole
/// token) and the length of the base64 run it ended in (a wrapped line that continues).
#[derive(Clone, Copy, Default, Debug)]
pub struct Context {
    byte: Option<u8>,
    run: usize,
}

/// The credentials of one exchange, found in any text that comes back.
pub struct Matcher {
    /// The length and kind of each pattern (the automaton holds the bytes).
    patterns: Vec<(usize, Kind)>,
    automaton: Automaton,
}

/// What [`Matcher::redact`] made of a text.
pub struct Redacted {
    /// The final text, redacted.
    pub out: Vec<u8>,
    /// How much of the source `out` covers; the rest waits for more text.
    pub consumed: usize,
    /// What the next text continues.
    pub context: Context,
    /// Whether anything was redacted.
    pub changed: bool,
}

impl Matcher {
    pub fn new(credentials: &[String]) -> Self {
        let mut all = Vec::new();
        for credential in credentials.iter().filter(|c| !c.is_empty()) {
            patterns_of(credential, &mut all);
        }
        // One pattern per byte string, the loosest kind kept.
        let mut at: std::collections::HashMap<Vec<u8>, usize> = std::collections::HashMap::new();
        let mut patterns: Vec<(Vec<u8>, Kind)> = Vec::new();
        for (bytes, kind) in all.into_iter().filter(|(bytes, _)| !bytes.is_empty()) {
            match at.get(&bytes) {
                Some(&known) if kind == Kind::Anywhere => patterns[known].1 = Kind::Anywhere,
                Some(_) => {}
                None => {
                    at.insert(bytes.clone(), patterns.len());
                    patterns.push((bytes, kind));
                }
            }
        }
        let automaton = Automaton::new(patterns.iter().map(|(bytes, _)| bytes.as_slice()));
        Self { patterns: patterns.into_iter().map(|(bytes, kind)| (bytes.len(), kind)).collect(), automaton }
    }

    /// How many states the automaton has (a measure of its cost).
    pub fn states(&self) -> usize {
        self.automaton.states()
    }

    /// The matcher of values a caller names (`scrubOAuthSecrets(text, secretValues)`).
    pub fn of_secrets(secrets: &[&str]) -> Self {
        Self::new(&secrets.iter().map(|secret| (*secret).to_owned()).collect::<Vec<_>>())
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    /// `source` with every credential redacted. `context` is what the text before it ended with; unless `last`, the end of
    /// `source` that may still become (a part of) a credential is not consumed and waits for the next text.
    pub fn redact(&self, source: &[u8], context: Context, last: bool) -> Redacted {
        if self.is_empty() {
            return Redacted { out: source.to_vec(), consumed: source.len(), context, changed: false };
        }
        let (view, wrap_ends, mut hold) = canonical(source, context, last);
        let bytes = &view.bytes;
        let source_start = |at: usize| if at < bytes.len() { view.span(at).0 } else { source.len() };
        let mut found: Vec<(usize, usize, Kind)> = Vec::new();
        let mut state = 0_u32;
        let mut wraps = wrap_ends.iter().peekable();
        // The view position where an unfinished escape begins: a credential that began before it may go on through it.
        let unfinished = (hold < source.len()).then(|| (0..bytes.len()).find(|at| view.span(*at).0 >= hold).unwrap_or(bytes.len()));
        for (at, &byte) in bytes.iter().enumerate() {
            if unfinished == Some(at) {
                let depth = self.automaton.depth[state as usize] as usize;
                if depth > 0 {
                    hold = hold.min(source_start(at - depth));
                }
            }
            while wraps.next_if(|end| **end == at).is_some() {
                // A credential that began on this wrapped line may continue on the next.
                let depth = self.automaton.depth[state as usize] as usize;
                if depth > 0 {
                    hold = hold.min(source_start(at - depth));
                }
            }
            state = self.automaton.step(state, byte);
            self.automaton.ending(state, |id| {
                let (len, kind) = self.patterns[id as usize];
                found.push((at + 1 - len, at + 1, kind));
            });
        }
        if !last {
            let depth = self.automaton.depth[state as usize] as usize;
            if depth > 0 {
                hold = hold.min(source_start(bytes.len() - depth));
            }
        }
        // Each match as the source span it redacts; one that needs a byte not yet read waits.
        let mut spans: Vec<Span> = Vec::new();
        for (mut start, mut end, kind) in found {
            match kind {
                Kind::Anywhere => {}
                Kind::Token => {
                    let before = if start > 0 { Some(bytes[start - 1]) } else { context.byte };
                    if before.is_some_and(is_word) || bytes.get(end).is_some_and(|b| is_word(*b)) {
                        continue;
                    }
                }
                Kind::Base64 => {
                    if start > 0 && is_base64(bytes[start - 1]) {
                        start -= 1;
                    }
                    if end < bytes.len() && is_base64(bytes[end]) {
                        end += 1;
                    }
                    let mut padding = 0;
                    while padding < 2 && bytes.get(end) == Some(&b'=') {
                        end += 1;
                        padding += 1;
                    }
                }
            }
            if !last && end == bytes.len() && kind != Kind::Anywhere {
                hold = hold.min(view.span(start).0);
                continue;
            }
            spans.push((view.span(start).0, view.span(end - 1).1));
        }
        // A match that reaches into the held text waits with it.
        loop {
            let crossing = spans.iter().filter(|(from, to)| *to > hold && *from < hold).map(|(from, _)| *from).min();
            match crossing {
                Some(from) => hold = from,
                None => break,
            }
        }
        spans.retain(|(_, to)| *to <= hold);
        spans.sort_unstable();
        let mut out = Vec::with_capacity(hold + REDACTED.len());
        let mut copied = 0;
        for (from, to) in &spans {
            if *to <= copied {
                continue;
            }
            out.extend_from_slice(&source[copied..(*from).max(copied)]);
            if *from >= copied {
                out.extend_from_slice(REDACTED.as_bytes());
            }
            copied = *to;
        }
        out.extend_from_slice(&source[copied.min(hold)..hold]);
        // What the consumed text ends with, in the view.
        let first_held = (0..bytes.len()).find(|at| view.span(*at).0 >= hold).unwrap_or(bytes.len());
        let next_context = if first_held == 0 {
            context
        } else {
            let run = bytes[..first_held].iter().rev().take_while(|b| is_base64(**b)).take(WRAPPED_RUN).count();
            let run = if run == first_held { (run + context.run).min(WRAPPED_RUN) } else { run };
            Context { byte: Some(bytes[first_held - 1]), run }
        };
        Redacted { out, consumed: hold, context: next_context, changed: !spans.is_empty() }
    }

    /// `text` redacted, or `None` when nothing in it was a credential.
    pub fn redacted(&self, text: &[u8]) -> Option<Vec<u8>> {
        let redacted = self.redact(text, Context::default(), true);
        redacted.changed.then_some(redacted.out)
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

/// The credentials a process has attached, oldest first, and the matcher of them as of the last change.
pub struct Registry {
    cap: usize,
    values: std::collections::VecDeque<String>,
    matcher: Option<Arc<Matcher>>,
}

impl Registry {
    pub const fn new(cap: usize) -> Self {
        Self { cap, values: std::collections::VecDeque::new(), matcher: None }
    }

    /// Keeps `credentials`; over the cap the oldest go. A value seen again becomes the newest (the set, and so the matcher,
    /// does not change).
    pub fn remember(&mut self, credentials: &[String]) {
        for credential in credentials.iter().map(|c| c.trim()).filter(|c| !c.is_empty()) {
            match self.values.iter().position(|known| known == credential) {
                Some(at) => {
                    if let Some(value) = self.values.remove(at) {
                        self.values.push_back(value);
                    }
                }
                None => {
                    self.values.push_back(credential.to_owned());
                    self.matcher = None;
                }
            }
        }
        while self.values.len() > self.cap {
            self.values.pop_front();
            self.matcher = None;
        }
    }

    /// The matcher of every value held, built when the set last changed and handed on as it is until it changes again.
    pub fn matcher(&mut self) -> Arc<Matcher> {
        self.matcher.get_or_insert_with(|| Arc::new(Matcher::new(&self.values.iter().cloned().collect::<Vec<_>>()))).clone()
    }
}

static REGISTRY: std::sync::Mutex<Registry> = std::sync::Mutex::new(Registry::new(REGISTRY_CAP));

fn registry() -> std::sync::MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A replay starts as a new process: the registry is empty.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_registry() {
    *registry() = Registry::new(REGISTRY_CAP);
}

/// Keeps what the transport attached to a request for the rest of the process (see the module's rule).
pub fn remember(credentials: &[String]) {
    if !credentials.is_empty() {
        registry().remember(credentials);
    }
}

/// The matcher of every credential this process ever attached: built once per registry version, shared by every response
/// text of every request.
pub fn remembered() -> Arc<Matcher> {
    registry().matcher()
}

/// A text that arrives in chunks, redacted as it arrives: the end of a chunk that may still become a credential (the
/// longest canonical form of one included, however it is escaped) waits for the next chunk, and nothing else does.
pub struct Stream {
    matcher: Arc<Matcher>,
    held: Vec<u8>,
    context: Context,
}

impl Stream {
    pub fn new(matcher: Arc<Matcher>) -> Self {
        Self { matcher, held: Vec::new(), context: Context::default() }
    }

    /// The final text `chunk` makes, redacted.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.held.extend_from_slice(chunk);
        let redacted = self.matcher.redact(&self.held, self.context, false);
        self.held.drain(..redacted.consumed);
        self.context = redacted.context;
        redacted.out
    }

    /// The text still held, redacted: the stream is over.
    pub fn finish(&mut self) -> Vec<u8> {
        let redacted = self.matcher.redact(&self.held, self.context, true);
        self.held.clear();
        redacted.out
    }
}

#[cfg(test)]
#[path = "carried_tests.rs"]
mod tests;
