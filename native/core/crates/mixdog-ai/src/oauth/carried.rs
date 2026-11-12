//! What a credential is, and how it is found again in text that comes back.
//!
//! **What a credential is.** Only what the transport itself attached to one request, by provenance ([`of_request`],
//! [`of_upgrade`]): the value of an `Authorization` / `Proxy-Authorization` header (the credential after its scheme word;
//! for `Basic`, the `user:key` its base64 holds and the key), the value of a header whose name ends in `api-key` / `apikey`,
//! the userinfo of the URL and a key in its query (`key`, `api_key`, `access_token`, `token`), and the secret fields of an
//! OAuth token request, which is known by its kind (a body with a top-level `grant_type`), never by a field name found in an
//! arbitrary body. A credential also becomes one where the process keeps it: each provider's own sign-in, refresh and load
//! path names what it stores ([`keep`]), whatever the field it read it from. Both land in one process-wide [`Registry`]
//! under a slot (the origin and position an exchange carried it in, or the credential file of an account): what a slot
//! holds now is pinned, so a static key and the current token of every account are never forgotten; what a slot held
//! before is retired and stays a credential too (the old credential of a refreshed token is found in the text of a later
//! exchange), bounded only by [`RETIRED_CAP`], over which the oldest retired value goes first, never a pinned one.
//!
//! **What it costs.** Knowing a credential costs a handful of index entries per canonical form (below), never a structure
//! rebuilt from all of them: a two-stage match. Each form is indexed by a fingerprint, its first eight bytes (a form shorter
//! than that by itself, with its length); the scan of a text looks every eight-byte window of the view up in that index,
//! and a hit is verified against the whole form, regenerated from the registry's value. Adding or retiring a credential
//! touches its own entries only, so it is done where the request is dispatched; a text is always scanned against the
//! registry as it is at that moment, so a response already streaming is searched for a credential attached after it began.
//!
//! **How it is found.** Never by a list of spellings. The text is read through a canonical view ([`canonical`]) with a map from
//! each byte of the view back to the source bytes it came from: percent-escapes (either hex case) decoded, JSON escapes
//! (`\/`, `\uXXXX` and surrogate pairs, …), `%uXXXX` escapes and HTML character references (`&#47;`, `&#x2F;`, `&sol;`, …) unescaped, NUL bytes
//! (the high half of UTF-16 text) dropped, each repeated until nothing changes; then a single line break inside a base64 run
//! (a wrapped line) is removed. In that view the scan looks for every credential and for its base64 and base64url forms
//! at the three byte alignments (padding optional). A credential holding a space is also looked for with `+` for the space,
//! and one holding a `+` with a space for it (a form encoder's and decoder's reading of each other); the view itself keeps a
//! `+` a `+`. A JWT credential's segments count one by one. A match redacts the whole
//! source span it came from (`long%252Fkey%252Bvalue` becomes one `[REDACTED]`). A credential shorter than
//! [`WHOLE_TOKEN_BELOW`] bytes counts only as a whole token (the bytes around it are not letters, digits, `_` or `-`): it is
//! redacted after `Bearer ` or in a header without eating a part of an ordinary word. Text in which no credential is found
//! comes back byte for byte.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::hash::BuildHasherDefault;
use std::hash::Hasher;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::PoisonError;
use std::sync::RwLock;

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
/// The retired values the registry keeps (pinned ones are never counted nor dropped). A retirement is a value a slot held
/// before: a refresh retires an account's access token, its refresh token when the server rotates it, and an id token, three
/// at most. Ten accounts (generous) refreshing every hour (the shortest common lifetime) retire 720 a day: 32,768 is 45 days
/// of that, twenty such accounts 22 days, and a daemon at the usual refresh intervals of several hours runs for months.
pub const RETIRED_CAP: usize = 32_768;
/// The fingerprint of a form: its first this many bytes (a shorter form is indexed whole).
const PRINT: usize = 8;

// ---------------------------------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------------------------------

/// A credential and the position of the exchange it rode in (a header's name, `userinfo`, a query key, a token request's
/// field): the position of an origin holds what the last exchange carried there.
fn add(out: &mut Vec<(String, String)>, position: &str, value: &str) {
    let value = value.trim();
    if !value.is_empty() && !out.iter().any(|(_, known)| known == value) {
        out.push((position.to_owned(), value.to_owned()));
    }
}

/// The `user:key` a Basic credential's base64 holds.
fn basic_pair(encoded: &str) -> Option<String> {
    let bare = encoded.trim_end_matches('=');
    [STANDARD_NO_PAD, URL_SAFE_NO_PAD].iter().find_map(|engine| String::from_utf8(engine.decode(bare).ok()?).ok()).filter(|pair| pair.contains(':'))
}

fn of_headers(headers: &[(String, String)], out: &mut Vec<(String, String)>) {
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        if name == "authorization" || name == "proxy-authorization" {
            let value = value.trim();
            match value.split_once(' ').filter(|(scheme, _)| !scheme.is_empty() && scheme.bytes().all(|b| b.is_ascii_alphabetic())) {
                Some((scheme, credential)) => {
                    let credential = credential.trim();
                    add(out, &name, credential);
                    if scheme.eq_ignore_ascii_case("basic")
                        && let Some(pair) = basic_pair(credential)
                    {
                        add(out, &name, &pair);
                        add(out, &name, pair.split_once(':').map_or("", |(_, key)| key));
                    }
                }
                None => add(out, &name, value),
            }
        } else if name.ends_with("api-key") || name.ends_with("apikey") || name.ends_with("api_key") {
            add(out, &name, value);
        }
    }
}

fn of_url(url: &str, out: &mut Vec<(String, String)>) {
    let Ok(parsed) = url::Url::parse(url) else { return };
    for part in [parsed.username(), parsed.password().unwrap_or("")] {
        add(out, "userinfo", &String::from_utf8_lossy(&percent_decode(part.as_bytes())));
    }
    for (name, value) in parsed.query_pairs() {
        let name: String = name.chars().filter(|c| *c != '_' && *c != '-').flat_map(char::to_lowercase).collect();
        if ["key", "apikey", "accesstoken", "token"].contains(&name.as_str()) {
            add(out, &format!("query {name}"), &value);
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
fn of_token_request(body: &[u8], out: &mut Vec<(String, String)>) {
    for (name, value) in token_request_fields(body).unwrap_or_default() {
        if TOKEN_FIELDS.contains(&name.as_str()) {
            add(out, &format!("token-request {name}"), &value);
        }
    }
}

fn attached_to_request(request: &WireRequest) -> Vec<(String, String)> {
    let mut out = Vec::new();
    of_headers(&request.headers, &mut out);
    of_url(&request.url, &mut out);
    of_token_request(&request.body, &mut out);
    out
}

fn attached_to_upgrade(uri: &str, headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    of_headers(headers, &mut out);
    of_url(uri, &mut out);
    out
}

/// The credentials the transport attached to `request` (see the module's rule).
pub fn of_request(request: &WireRequest) -> Vec<String> {
    attached_to_request(request).into_iter().map(|(_, value)| value).collect()
}

/// The credentials a WebSocket upgrade carries: its credential headers and the userinfo and key of its URL.
pub fn of_upgrade(uri: &str, headers: &[(String, String)]) -> Vec<String> {
    attached_to_upgrade(uri, headers).into_iter().map(|(_, value)| value).collect()
}

/// Registers what the transport attaches to `request`, before it is sent: each position of its origin now holds what this
/// request carries there.
pub fn attach_request(request: &WireRequest) {
    attach(&request.url, attached_to_request(request));
}

/// [`attach_request`] for a WebSocket upgrade.
pub fn attach_upgrade(uri: &str, headers: &[(String, String)]) {
    attach(uri, attached_to_upgrade(uri, headers));
}

fn attach(url: &str, attached: Vec<(String, String)>) {
    if attached.is_empty() {
        return;
    }
    let origin = url::Url::parse(url).map_or_else(|_| String::new(), |url| url.origin().ascii_serialization());
    let mut positions: Vec<(&str, Vec<&str>)> = Vec::new();
    for (position, value) in &attached {
        match positions.iter_mut().find(|(known, _)| *known == position.as_str()) {
            Some((_, values)) => values.push(value.as_str()),
            None => positions.push((position.as_str(), vec![value.as_str()])),
        }
    }
    let mut registry = write();
    for (position, values) in positions {
        registry.keep(&format!("{origin} {position}"), &values);
    }
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
    // The bytes from the first one an unfinished escape of an earlier round made on are not final: an escape that reads
    // into them is unfinished too (`&#92;u0&#x3` is a `\u0` the next text may finish).
    let settled = (0..bytes.len()).find(|at| layer.span(*at).0 >= *hold).unwrap_or(bytes.len());
    let mut next: Option<Next> = None;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        let escape = match byte {
            b'%' | b'\\' | b'&' if i < settled => escape_at(&bytes[..settled], i),
            b'%' | b'\\' | b'&' => escape_at(bytes, i),
            _ => Escape::None,
        };
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
fn wrap_points(layer: &Layer, context_run: usize, last: bool, settled: usize, ends: &mut Vec<usize>) -> Option<Layer> {
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
            if (j == bytes.len() || j == settled) && !last && breaks <= 1 {
                // The next text (or the unfinished escape the blanks run into) may continue the base64 line: the view's
                // position before the break is where a credential that begins on this line would continue.
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
    let settled = (0..layer.bytes.len()).find(|at| layer.span(*at).0 >= hold).unwrap_or(layer.bytes.len());
    if let Some(joined) = wrap_points(&layer, context.run, last, settled, &mut ends) {
        layer = joined;
    }
    (layer, ends, hold)
}

// ---------------------------------------------------------------------------------------------------------------------
// The forms and their index
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// Found anywhere.
    Anywhere,
    /// Found only with no word byte on either side.
    Token,
    /// A short credential's base64, a whole run: found as a [`Kind::Token`], its padding belonging to the match.
    TokenBase64,
    /// The base64 characters wholly made of the credential's bits: the partial character on each side and the padding
    /// belong to the match too.
    Base64,
}

/// The characters of `secret`'s base64 at the byte alignment `align` that hold its bits alone, in the URL-safe alphabet
/// when `url`.
fn base64_core(secret: &[u8], align: usize, url: bool) -> Vec<u8> {
    let mut shifted = vec![0_u8; align];
    shifted.extend_from_slice(secret);
    let encoded = STANDARD_NO_PAD.encode(&shifted).into_bytes();
    let first = (8 * align).div_ceil(6);
    let end = 8 * (align + secret.len()) / 6;
    encoded[first..end]
        .iter()
        .map(|b| match (b, url) {
            (b'+', true) => b'-',
            (b'/', true) => b'_',
            (other, _) => *other,
        })
        .collect()
}

/// How many forms one text of a credential has: a short one whole and as a whole base64 run in both alphabets; a long one
/// itself, its base64 cores at three alignments in both alphabets and, when it is not ASCII, its UTF-16 in both byte orders.
fn encodings(text: &str) -> usize {
    if text.len() < WHOLE_TOKEN_BELOW {
        3
    } else if text.is_ascii() {
        7
    } else {
        9
    }
}

/// Form `which` of one text of a credential (see [`encodings`]).
fn encoded(text: &str, which: usize) -> (Vec<u8>, Kind) {
    let bytes = text.as_bytes();
    if bytes.len() < WHOLE_TOKEN_BELOW {
        return match which {
            0 => (bytes.to_vec(), Kind::Token),
            1 => (STANDARD_NO_PAD.encode(bytes).into_bytes(), Kind::TokenBase64),
            _ => (URL_SAFE_NO_PAD.encode(bytes).into_bytes(), Kind::TokenBase64),
        };
    }
    match which {
        0 => (bytes.to_vec(), Kind::Anywhere),
        1..=6 => (base64_core(bytes, (which - 1) / 2, (which - 1) % 2 == 1), Kind::Base64),
        // UTF-16 text, its NULs dropped by the view.
        7 => (text.encode_utf16().flat_map(u16::to_le_bytes).filter(|b| *b != 0).collect(), Kind::Anywhere),
        _ => (text.encode_utf16().flat_map(u16::to_be_bytes).filter(|b| *b != 0).collect(), Kind::Anywhere),
    }
}

/// Every canonical form of one credential, in a fixed order: a form is named by its place in it.
fn forms_of(secret: &str) -> Vec<(Vec<u8>, Kind)> {
    plains_of(secret).iter().flat_map(|text| (0..encodings(text)).map(move |which| encoded(text, which))).collect()
}

/// Form `index` of [`forms_of`] alone (what a fingerprint's hit is verified against).
fn form_of(secret: &str, mut index: usize) -> Vec<u8> {
    for text in plains_of(secret) {
        let count = encodings(&text);
        if index < count {
            return encoded(&text, index).0;
        }
        index -= count;
    }
    Vec::new()
}

/// The texts a credential is echoed as before any encoding: itself, itself unescaped, its form encoder's and decoder's
/// readings and a JWT's segments.
fn plains_of(secret: &str) -> Vec<String> {
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
    let mut distinct: Vec<String> = Vec::with_capacity(plain.len());
    for text in plain {
        if !text.is_empty() && !distinct.contains(&text) {
            distinct.push(text);
        }
    }
    distinct
}

/// No record.
const NONE: u32 = u32::MAX;

/// A multiply-rotate hash for keys that are uniform already (packed bytes, lengths): one multiplication a word.
#[derive(Default)]
struct Fold(u64);

impl Hasher for Fold {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.write_u64(u64::from(*byte));
        }
    }

    fn write_u8(&mut self, n: u8) {
        self.write_u64(u64::from(n));
    }

    fn write_u32(&mut self, n: u32) {
        self.write_u64(u64::from(n));
    }

    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(26) ^ n).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
}

type Folded = BuildHasherDefault<Fold>;

/// Up to eight bytes as one big-endian word.
fn pack(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0, |word, byte| (word << 8) | u64::from(*byte))
}

/// One to eight bytes as the high bytes of a word: the words of every text that begins with them form one range.
fn pack_left(bytes: &[u8]) -> u64 {
    pack(bytes) << (8 * (PRINT - bytes.len()))
}

#[cfg(test)]
thread_local! {
    /// The index entries this thread made or dropped: what registering a credential cost.
    static TOUCHED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The index entries this thread made or dropped so far.
#[cfg(test)]
pub(crate) fn touched() -> usize {
    TOUCHED.with(std::cell::Cell::get)
}

#[derive(Clone, Copy)]
struct Owner {
    cred: u32,
    form: u16,
    kind: Kind,
}

/// A form found in a view: its start, its end and its kind.
type Found = (usize, usize, Kind);

/// One form, indexed: the credentials that have it (equal bytes are one record) and the next record of its bucket.
struct Record {
    len: u32,
    owners: Vec<Owner>,
    next: u32,
}

impl Record {
    /// The loosest kind of those its owners give it.
    fn kind(&self) -> Kind {
        if self.owners.iter().any(|owner| owner.kind == Kind::Anywhere) { Kind::Anywhere } else { self.owners[0].kind }
    }
}

/// Every canonical form of every credential held, by fingerprint: the first stage of a match finds a form's first eight
/// bytes (a shorter form whole) in it, the second verifies the whole form, regenerated from the credential.
#[derive(Default)]
struct Index {
    /// Each credential (`None`: a free place) and the record of each of its forms, in the order of [`forms_of`].
    creds: Vec<Option<(Arc<str>, Vec<u32>)>>,
    free_creds: Vec<u32>,
    records: Vec<Option<Record>>,
    free_records: Vec<u32>,
    /// A form of at least [`PRINT`] bytes by its fingerprint, its length and its last [`PRINT`] bytes: the first record of
    /// that bucket (a form of at most twice [`PRINT`] bytes is wholly named by its key).
    long: HashMap<(u64, u32, u64), u32, Folded>,
    /// Each fingerprint's form lengths, and how many records have each.
    heads: HashMap<u64, Vec<(u32, u32)>, Folded>,
    /// A form shorter than [`PRINT`] bytes by its length and bytes.
    short: HashMap<(u8, u64), u32, Folded>,
    /// How many records each length below [`PRINT`] has.
    short_lengths: [u32; PRINT],
    /// The first bytes of every form, left-aligned, and how many records begin with them: whether a text ends inside one.
    beginnings: BTreeMap<u64, u32>,
    live: usize,
}

impl Index {
    fn is_empty(&self) -> bool {
        self.live == 0
    }

    fn record(&self, at: u32) -> &Record {
        self.records[at as usize].as_ref().expect("a bucket holds live records")
    }

    fn bytes_of(&self, record: &Record) -> Vec<u8> {
        let owner = record.owners[0];
        let (secret, _) = self.creds[owner.cred as usize].as_ref().expect("a record's owner is held");
        form_of(secret, usize::from(owner.form))
    }

    /// The first record of the bucket of `bytes`.
    fn head(&self, bytes: &[u8]) -> u32 {
        let found = if bytes.len() >= PRINT {
            self.long.get(&(pack(&bytes[..PRINT]), bytes.len() as u32, pack(&bytes[bytes.len() - PRINT..])))
        } else {
            self.short.get(&(bytes.len() as u8, pack(bytes)))
        };
        found.copied().unwrap_or(NONE)
    }

    fn set_head(&mut self, bytes: &[u8], at: u32) {
        if bytes.len() >= PRINT {
            let key = (pack(&bytes[..PRINT]), bytes.len() as u32, pack(&bytes[bytes.len() - PRINT..]));
            if at == NONE {
                self.long.remove(&key);
            } else {
                self.long.insert(key, at);
            }
        } else {
            let key = (bytes.len() as u8, pack(bytes));
            if at == NONE {
                self.short.remove(&key);
            } else {
                self.short.insert(key, at);
            }
        }
    }

    /// Indexes every form of `secret`, touching the entries of its own forms only; returns its place.
    fn insert(&mut self, secret: Arc<str>) -> u32 {
        let forms = forms_of(&secret);
        let cred = match self.free_creds.pop() {
            Some(cred) => cred,
            None => {
                self.creds.push(None);
                (self.creds.len() - 1) as u32
            }
        };
        self.creds[cred as usize] = Some((secret, Vec::new()));
        let mut placed = Vec::with_capacity(forms.len());
        for (form, (bytes, kind)) in forms.into_iter().enumerate() {
            let mut at = self.head(&bytes);
            while at != NONE {
                let record = self.record(at);
                if bytes.len() <= 2 * PRINT || self.bytes_of(record) == bytes {
                    break;
                }
                at = record.next;
            }
            if at == NONE {
                at = self.new_record(&bytes);
            }
            self.records[at as usize].as_mut().expect("just found or made").owners.push(Owner { cred, form: form as u16, kind });
            placed.push(at);
            #[cfg(test)]
            TOUCHED.with(|touched| touched.set(touched.get() + 1));
        }
        if let Some((_, records)) = self.creds[cred as usize].as_mut() {
            *records = placed;
        }
        self.live += 1;
        cred
    }

    fn new_record(&mut self, bytes: &[u8]) -> u32 {
        let record = Record { len: bytes.len() as u32, owners: Vec::new(), next: self.head(bytes) };
        let at = match self.free_records.pop() {
            Some(at) => {
                self.records[at as usize] = Some(record);
                at
            }
            None => {
                self.records.push(Some(record));
                (self.records.len() - 1) as u32
            }
        };
        self.set_head(bytes, at);
        if bytes.len() >= PRINT {
            let lengths = self.heads.entry(pack(&bytes[..PRINT])).or_default();
            match lengths.iter_mut().find(|(len, _)| *len == bytes.len() as u32) {
                Some((_, records)) => *records += 1,
                None => lengths.push((bytes.len() as u32, 1)),
            }
        } else {
            self.short_lengths[bytes.len()] += 1;
        }
        *self.beginnings.entry(pack_left(&bytes[..bytes.len().min(PRINT)])).or_default() += 1;
        at
    }

    /// Drops the credential at `cred` and every record only it had.
    fn remove(&mut self, cred: u32) {
        let Some((secret, placed)) = self.creds[cred as usize].take() else { return };
        let forms = forms_of(&secret);
        for (form, at) in placed.into_iter().enumerate() {
            let record = self.records[at as usize].as_mut().expect("a credential's records are live");
            if let Some(owner) = record.owners.iter().position(|owner| owner.cred == cred && usize::from(owner.form) == form) {
                record.owners.swap_remove(owner);
            }
            if record.owners.is_empty() {
                self.drop_record(at, &forms[form].0);
            }
            #[cfg(test)]
            TOUCHED.with(|touched| touched.set(touched.get() + 1));
        }
        self.free_creds.push(cred);
        self.live -= 1;
    }

    fn drop_record(&mut self, at: u32, bytes: &[u8]) {
        let next = self.record(at).next;
        let head = self.head(bytes);
        if head == at {
            self.set_head(bytes, next);
        } else {
            let mut before = head;
            while self.record(before).next != at {
                before = self.record(before).next;
            }
            self.records[before as usize].as_mut().expect("a bucket holds live records").next = next;
        }
        if bytes.len() >= PRINT {
            let fingerprint = pack(&bytes[..PRINT]);
            if let Some(lengths) = self.heads.get_mut(&fingerprint) {
                if let Some(entry) = lengths.iter().position(|(len, _)| *len == bytes.len() as u32) {
                    lengths[entry].1 -= 1;
                    if lengths[entry].1 == 0 {
                        lengths.swap_remove(entry);
                    }
                }
                if lengths.is_empty() {
                    self.heads.remove(&fingerprint);
                }
            }
        } else {
            self.short_lengths[bytes.len()] -= 1;
        }
        let beginning = pack_left(&bytes[..bytes.len().min(PRINT)]);
        if let Some(records) = self.beginnings.get_mut(&beginning) {
            *records -= 1;
            if *records == 0 {
                self.beginnings.remove(&beginning);
            }
        }
        self.records[at as usize] = None;
        self.free_records.push(at);
    }

    /// Every form found in `bytes`, and each place a fingerprint was seen with the longest form it begins.
    fn scan(&self, bytes: &[u8]) -> (Vec<Found>, Vec<(usize, usize)>) {
        let mut found = Vec::new();
        let mut begun = Vec::new();
        let short: Vec<usize> = (1..PRINT).filter(|len| self.short_lengths[*len] > 0).collect();
        let mut window = 0_u64;
        for (at, &byte) in bytes.iter().enumerate() {
            window = (window << 8) | u64::from(byte);
            let end = at + 1;
            for &len in &short {
                if end >= len
                    && let Some(&first) = self.short.get(&(len as u8, window & ((1_u64 << (8 * len)) - 1)))
                {
                    self.verify(first, end - len, bytes, &mut found);
                }
            }
            if end < PRINT {
                continue;
            }
            let Some(lengths) = self.heads.get(&window) else { continue };
            let start = end - PRINT;
            let mut longest = 0;
            for &(len, _) in lengths {
                let len = len as usize;
                longest = longest.max(len);
                if start + len <= bytes.len()
                    && let Some(&first) = self.long.get(&(window, len as u32, pack(&bytes[start + len - PRINT..start + len])))
                {
                    self.verify(first, start, bytes, &mut found);
                }
            }
            begun.push((start, longest));
        }
        (found, begun)
    }

    /// The second stage: the record of the bucket at `at` whose whole form is at `start`.
    fn verify(&self, mut at: u32, start: usize, bytes: &[u8], found: &mut Vec<Found>) {
        while at != NONE {
            let record = self.record(at);
            let end = start + record.len as usize;
            if record.len as usize <= 2 * PRINT || self.bytes_of(record) == bytes[start..end] {
                found.push((start, end, record.kind()));
                return;
            }
            at = record.next;
        }
    }

    /// Where the earliest form that `bytes[..at]` may end inside begins: a fingerprint seen whose longest form goes on past
    /// `at`, or a beginning of a form in the last bytes before it.
    fn open_from(&self, bytes: &[u8], begun: &[(usize, usize)], at: usize) -> Option<usize> {
        let long = begun.iter().find(|(start, longest)| start + PRINT <= at && start + longest > at).map(|(start, _)| *start);
        long.or_else(|| (at.saturating_sub(PRINT - 1)..at).find(|start| self.begins(&bytes[*start..at])))
    }

    /// Whether a form begins with `part` (one to seven bytes).
    fn begins(&self, part: &[u8]) -> bool {
        let low = pack_left(part);
        let high = low | (u64::MAX >> (8 * part.len()));
        self.beginnings.range(low..=high).next().is_some()
    }

    /// What the index holds in bytes, estimated from its containers' capacities: a hash entry its key, value and control
    /// byte, a tree entry its key and value and half again, a vector its capacity, a credential its text.
    #[cfg(test)]
    fn footprint(&self) -> usize {
        use std::mem::size_of;
        let records: usize = self.records.iter().flatten().map(|record| record.owners.capacity() * size_of::<Owner>()).sum();
        let creds: usize = self.creds.iter().flatten().map(|(secret, placed)| secret.len() + 16 + placed.capacity() * 4).sum();
        let heads: usize = self.heads.values().map(|lengths| lengths.capacity() * 8).sum();
        self.creds.capacity() * size_of::<Option<(Arc<str>, Vec<u32>)>>()
            + creds
            + self.records.capacity() * size_of::<Option<Record>>()
            + records
            + self.long.capacity() * (size_of::<((u64, u32, u64), u32)>() + 1)
            + self.heads.capacity() * (size_of::<(u64, Vec<(u32, u32)>)>() + 1)
            + heads
            + self.short.capacity() * (size_of::<((u8, u64), u32)>() + 1)
            + self.beginnings.len() * size_of::<(u64, u32)>() * 3 / 2
            + (self.free_creds.capacity() + self.free_records.capacity()) * 4
    }

    /// `source` with every form held redacted (see [`Matcher::redact`]).
    fn redact(&self, source: &[u8], context: Context, last: bool) -> Redacted {
        if self.is_empty() && last {
            return Redacted { out: source.to_vec(), consumed: source.len(), context, changed: false };
        }
        let (view, wrap_ends, mut hold) = canonical(source, context, last);
        let bytes = &view.bytes;
        let source_start = |at: usize| if at < bytes.len() { view.span(at).0 } else { source.len() };
        let (found, begun) = self.scan(bytes);
        // The view position where an unfinished escape begins, and where a wrapped base64 line may go on in the next text:
        // a form begun before it may continue through it.
        let unfinished = (hold < source.len()).then(|| (0..bytes.len()).find(|at| view.span(*at).0 >= hold).unwrap_or(bytes.len()));
        for at in unfinished.into_iter().chain(wrap_ends.iter().copied()) {
            if let Some(start) = self.open_from(bytes, &begun, at) {
                hold = hold.min(source_start(start));
            }
        }
        if !last && let Some(start) = self.open_from(bytes, &begun, bytes.len()) {
            hold = hold.min(source_start(start));
        }
        // Each match as the source span it redacts; one that needs a byte not yet read waits.
        let mut spans: Vec<Span> = Vec::new();
        for (mut start, mut end, kind) in found {
            match kind {
                Kind::Anywhere => {}
                Kind::Token | Kind::TokenBase64 => {
                    let before = if start > 0 { Some(bytes[start - 1]) } else { context.byte };
                    if before.is_some_and(is_word) || bytes.get(end).is_some_and(|b| is_word(*b)) {
                        continue;
                    }
                    let mut padding = 0;
                    while kind == Kind::TokenBase64 && padding < 2 && bytes.get(end) == Some(&b'=') {
                        end += 1;
                        padding += 1;
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

/// Credentials found in any text that comes back: a set of its own (the values a caller names), or a registry as it is at
/// the moment each text is read.
pub struct Matcher(Source);

enum Source {
    Own(Box<Index>),
    Registry(Arc<RwLock<Registry>>),
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

fn read(registry: &RwLock<Registry>) -> std::sync::RwLockReadGuard<'_, Registry> {
    registry.read().unwrap_or_else(PoisonError::into_inner)
}

impl Matcher {
    pub fn new(credentials: &[String]) -> Self {
        let mut index = Index::default();
        let mut seen: Vec<&str> = Vec::new();
        for credential in credentials.iter().filter(|c| !c.is_empty()) {
            if !seen.contains(&credential.as_str()) {
                seen.push(credential);
                index.insert(Arc::from(credential.as_str()));
            }
        }
        Self(Source::Own(Box::new(index)))
    }

    /// The matcher of values a caller names (`scrubOAuthSecrets(text, secretValues)`).
    pub fn of_secrets(secrets: &[&str]) -> Self {
        Self::new(&secrets.iter().map(|secret| (*secret).to_owned()).collect::<Vec<_>>())
    }

    /// The matcher of what `registry` holds whenever a text is read.
    pub fn of_registry(registry: Arc<RwLock<Registry>>) -> Self {
        Self(Source::Registry(registry))
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Source::Own(index) => index.is_empty(),
            Source::Registry(registry) => read(registry).index.is_empty(),
        }
    }

    /// `source` with every credential redacted. `context` is what the text before it ended with; unless `last`, the end of
    /// `source` that may still become (a part of) a credential is not consumed and waits for the next text.
    pub fn redact(&self, source: &[u8], context: Context, last: bool) -> Redacted {
        match &self.0 {
            Source::Own(index) => index.redact(source, context, last),
            Source::Registry(registry) => read(registry).index.redact(source, context, last),
        }
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

/// A value the registry holds: its place in the index, how many slots hold it now, and when it was retired.
struct Held {
    cred: u32,
    pins: u32,
    retired: Option<u64>,
}

/// Every credential the process attached or keeps, by slot (see the module's rule): what a slot holds now is pinned, what
/// it held before is retired, and over [`RETIRED_CAP`] retired values the oldest retired one goes.
pub struct Registry {
    cap: usize,
    index: Index,
    held: HashMap<Arc<str>, Held>,
    slots: HashMap<String, Vec<Arc<str>>>,
    /// Retirements, oldest first (an entry whose value was pinned again or retired later is stale).
    retired: VecDeque<(u64, Arc<str>)>,
    retired_live: usize,
    seq: u64,
}

impl Registry {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            index: Index::default(),
            held: HashMap::new(),
            slots: HashMap::new(),
            retired: VecDeque::new(),
            retired_live: 0,
            seq: 0,
        }
    }

    /// `slot` holds `values` now: they are pinned, and what it held before and holds no more is retired. Each new value
    /// costs the index entries of its own forms, whatever the registry holds.
    pub fn keep(&mut self, slot: &str, values: &[&str]) {
        let mut now: Vec<Arc<str>> = Vec::new();
        for value in values.iter().map(|value| value.trim()).filter(|value| !value.is_empty()) {
            if !now.iter().any(|known| &**known == value) {
                now.push(self.pin(value));
            }
        }
        let before = if now.is_empty() { self.slots.remove(slot) } else { self.slots.insert(slot.to_owned(), now) };
        for value in before.unwrap_or_default() {
            self.unpin(&value);
        }
        self.evict();
    }

    fn pin(&mut self, value: &str) -> Arc<str> {
        if let Some((known, _)) = self.held.get_key_value(value) {
            let known = known.clone();
            let held = self.held.get_mut(value).expect("just found");
            held.pins += 1;
            if held.retired.take().is_some() {
                self.retired_live -= 1;
            }
            return known;
        }
        let value: Arc<str> = Arc::from(value);
        let cred = self.index.insert(value.clone());
        self.held.insert(value.clone(), Held { cred, pins: 1, retired: None });
        value
    }

    fn unpin(&mut self, value: &Arc<str>) {
        let Some(held) = self.held.get_mut(value) else { return };
        held.pins -= 1;
        if held.pins == 0 {
            self.seq += 1;
            held.retired = Some(self.seq);
            self.retired.push_back((self.seq, value.clone()));
            self.retired_live += 1;
        }
    }

    /// Over the cap, the oldest retired values go; a pinned value never does.
    fn evict(&mut self) {
        while self.retired_live > self.cap {
            let Some((seq, value)) = self.retired.pop_front() else { break };
            if self.held.get(&value).is_some_and(|held| held.retired == Some(seq)) {
                let held = self.held.remove(&value).expect("just found");
                self.index.remove(held.cred);
                self.retired_live -= 1;
            }
        }
        if self.retired.len() > 2 * self.retired_live + 64 {
            let held = &self.held;
            self.retired.retain(|(seq, value)| held.get(value).is_some_and(|held| held.retired == Some(*seq)));
        }
    }

    /// Whether `value` is a credential the registry holds.
    pub fn holds(&self, value: &str) -> bool {
        self.held.contains_key(value)
    }

    /// How many values are pinned, and how many retired.
    pub fn counts(&self) -> (usize, usize) {
        (self.held.len() - self.retired_live, self.retired_live)
    }

    /// The bytes the registry's index holds (an estimate from its containers' capacities).
    #[cfg(test)]
    pub(crate) fn footprint(&self) -> usize {
        self.index.footprint()
    }
}

static REGISTRY: LazyLock<Arc<RwLock<Registry>>> = LazyLock::new(|| Arc::new(RwLock::new(Registry::new(RETIRED_CAP))));

fn write() -> std::sync::RwLockWriteGuard<'static, Registry> {
    REGISTRY.write().unwrap_or_else(PoisonError::into_inner)
}

/// A replay starts as a new process: the registry is empty.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_registry() {
    *write() = Registry::new(RETIRED_CAP);
}

/// A provider's own sign-in, refresh or load path names what `slot` (its account) holds now: every credential it keeps,
/// whatever field it read it from.
pub fn keep(slot: &str, values: &[&str]) {
    write().keep(slot, values);
}

/// The matcher of every credential this process attached or keeps, read as the registry is at each text: a response that
/// began before a credential was attached is searched for it from its next text on.
pub fn remembered() -> Arc<Matcher> {
    Arc::new(Matcher::of_registry(REGISTRY.clone()))
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
