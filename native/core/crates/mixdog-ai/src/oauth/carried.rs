//! What a credential is, and how it is found again in text that comes back.
//!
//! **What a credential is.** Only what the transport itself attached to one request, by provenance ([`of_request`],
//! [`of_upgrade`]): the value of an `Authorization` / `Proxy-Authorization` header (the credential after its scheme word;
//! for `Basic`, the `user:key` its base64 holds and the key), the value of a header whose name ends in `api-key` / `apikey`,
//! the userinfo of the URL and a key in its query (`key`, `api_key`, `access_token`, `token`), and the secret fields of an
//! OAuth token request, which is known by its kind (a body with a top-level `grant_type`), never by a field name found in an
//! arbitrary body. A credential also becomes one where the process reads it out of its source ([`keep`]): a key variable
//! (`Environment::key_var`, `process_key_var_os`), a keychain entry (the vault reads), a configured key, an account's
//! credential file (each provider's own load, refresh and sign-in path names what it stores, whatever the field it read it
//! from) and a token an exchange hands the process for later requests.
//!
//! **Who owns a value.** Its sources, the places it was read out of: a value is pinned while one of its sources still
//! yields it, so a static key and the current token of every account are never forgotten, however many values other
//! accounts carry or rotate. Only a value its own source replaced (or let go of) is retired; it stays a credential (the old
//! credential of a refreshed token is found in the text of a later exchange) among the last [`RETIRED_CAP`] retired, the
//! oldest retired going first. Two sources yielding one value keep it until both have let go. An exchange holds what it
//! carries ([`Lease`]) while it is in flight: a value its source replaces while a response still streams stays a credential
//! of that stream whatever is retired after it. A value seen only on a request, from no known source, never retires
//! another: once no exchange carries it, it is kept by recency of use (each carry makes it the newest) among the last
//! [`CARRIED_CAP`] such values.
//!
//! **What it costs.** Knowing a credential costs a handful of index entries per canonical form (below), never a structure
//! rebuilt from all of them: a two-stage match. Each form is indexed by a fingerprint, its first eight bytes (a form shorter
//! than that by itself, with its length); the scan of a text looks every eight-byte window of the view up in that index,
//! and a hit is verified against the whole form, regenerated from the registry's value. The index is persistent ([`Trie`]):
//! a scan takes the registry's current index in O(1) (one pointer, under a lock held for that copy alone) and scans it
//! holding no lock, while a registration changes its own copy, paying the nodes on the paths of its own entries only, and
//! publishes it the same way. Neither waits for the other: a registration never waits for a scan, and a scan of the next
//! chunk sees what was registered meanwhile (a response already streaming is searched for a credential attached after it
//! began).
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

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
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
/// The retired values the registry keeps (a value a source yields is never counted nor dropped). A retirement is a value
/// its own source replaced: a refresh retires an account's access token, its refresh token when the server rotates it, and
/// an id token, three at most. Ten accounts (generous) refreshing every hour (the shortest common lifetime) retire 720 a
/// day: 4,096 is five and a half days of that, and the old tokens of a refresh are expired or revoked long before.
pub const RETIRED_CAP: usize = 4_096;
/// The values seen only on requests (no known source) the registry keeps once no exchange carries them, the least
/// recently carried going first. Every credential the product reads is read out of a source, so these are the stray ones.
/// With [`RETIRED_CAP`], the most the registry holds besides what sources yield: 8,192 values.
pub const CARRIED_CAP: usize = 4_096;
/// The fingerprint of a form: its first this many bytes (a shorter form is indexed whole).
const PRINT: usize = 8;

// ---------------------------------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------------------------------

/// A credential an exchange carries, each once.
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

/// Registers what the transport attaches to `request`, before it is sent, for as long as the returned lease lives (the
/// exchange: its response read to the end or dropped). A value no source yields is kept after that by recency of use; it
/// retires nothing.
pub fn attach_request(request: &WireRequest) -> Lease {
    Lease::of(&REGISTRY, &of_request(request))
}

/// [`attach_request`] for a WebSocket upgrade: the lease lives as long as the socket.
pub fn attach_upgrade(uri: &str, headers: &[(String, String)]) -> Lease {
    Lease::of(&REGISTRY, &of_upgrade(uri, headers))
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

/// Up to eight bytes as one big-endian word.
fn pack(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0, |word, byte| (word << 8) | u64::from(*byte))
}

/// One to eight bytes as the high bytes of a word: the words of every text that begins with them form one range.
fn pack_left(bytes: &[u8]) -> u64 {
    pack(bytes) << (8 * (PRINT - bytes.len()))
}

/// A bijection of 64-bit words that spreads their bits (SplitMix64's finalizer): distinct keys stay distinct.
fn mix(mut word: u64) -> u64 {
    word = (word ^ (word >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    word = (word ^ (word >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    word ^ (word >> 31)
}

// ---------------------------------------------------------------------------------------------------------------------
// The persistent trie
// ---------------------------------------------------------------------------------------------------------------------

/// The bits of a key level `depth` of a [`Trie`] takes, highest first: six a level, the last (60 taken) the four left.
fn width(depth: u32) -> u32 {
    if depth < 10 { 6 } else { 4 }
}

fn chunk(key: u64, depth: u32) -> u32 {
    if depth < 10 { ((key >> (58 - 6 * depth)) & 63) as u32 } else { (key & 15) as u32 }
}

/// A map from 64-bit keys whose copy is one pointer: a radix trie of the key's bits, highest first, whose nodes are shared
/// between copies and copied on write along the path of a change alone. A scan reads a copy taken in O(1) while a
/// registration changes another; a change costs the nodes on its path (at most eleven), never the map.
struct Trie<V> {
    root: Option<Arc<Node<V>>>,
}

impl<V> Clone for Trie<V> {
    fn clone(&self) -> Self {
        Self { root: self.root.clone() }
    }
}

impl<V> Default for Trie<V> {
    fn default() -> Self {
        Self { root: None }
    }
}

struct Node<V> {
    /// Which of the (up to 64) children are present; `slots` holds them in that order.
    bitmap: u64,
    slots: Vec<Slot<V>>,
}

impl<V: Clone> Clone for Node<V> {
    fn clone(&self) -> Self {
        Self { bitmap: self.bitmap, slots: self.slots.clone() }
    }
}

#[derive(Clone)]
enum Slot<V> {
    Leaf(u64, V),
    Node(Arc<Node<V>>),
}

impl<V: Clone> Node<V> {
    fn empty() -> Self {
        Self { bitmap: 0, slots: Vec::new() }
    }

    /// The bit of `key`'s child at `depth` and its place among the slots.
    fn place(&self, key: u64, depth: u32) -> (u64, usize) {
        let bit = 1_u64 << chunk(key, depth);
        (bit, (self.bitmap & (bit - 1)).count_ones() as usize)
    }

    fn insert(&mut self, key: u64, value: V, depth: u32) -> Option<V> {
        let (bit, at) = self.place(key, depth);
        if self.bitmap & bit == 0 {
            self.bitmap |= bit;
            self.slots.insert(at, Slot::Leaf(key, value));
            return None;
        }
        // Another key's leaf where this one goes: both one level down.
        if matches!(&self.slots[at], Slot::Leaf(known, _) if *known != key) {
            let leaf = std::mem::replace(&mut self.slots[at], Slot::Node(Arc::new(Self::empty())));
            if let (Slot::Leaf(known, held), Slot::Node(next)) = (leaf, &mut self.slots[at]) {
                Arc::make_mut(next).insert(known, held, depth + 1);
            }
        }
        match &mut self.slots[at] {
            Slot::Node(next) => Arc::make_mut(next).insert(key, value, depth + 1),
            Slot::Leaf(_, held) => Some(std::mem::replace(held, value)),
        }
    }

    fn remove(&mut self, key: u64, depth: u32) -> Option<V> {
        let (bit, at) = self.place(key, depth);
        if self.bitmap & bit == 0 {
            return None;
        }
        if let Slot::Leaf(known, _) = &self.slots[at] {
            if *known != key {
                return None;
            }
            self.bitmap &= !bit;
            return match self.slots.remove(at) {
                Slot::Leaf(_, value) => Some(value),
                Slot::Node(_) => None,
            };
        }
        let Slot::Node(next) = &mut self.slots[at] else { return None };
        let next = Arc::make_mut(next);
        let removed = next.remove(key, depth + 1)?;
        // A child left with one leaf gives way to it, an empty one goes.
        if next.slots.len() <= 1 && !matches!(next.slots.first(), Some(Slot::Node(_))) {
            match next.slots.pop() {
                Some(leaf) => self.slots[at] = leaf,
                None => {
                    self.bitmap &= !bit;
                    self.slots.remove(at);
                }
            }
        }
        Some(removed)
    }

    fn visit_all(&self, visit: &mut impl FnMut(u64, &V) -> bool) -> bool {
        self.slots.iter().any(|slot| match slot {
            Slot::Leaf(key, value) => visit(*key, value),
            Slot::Node(next) => next.visit_all(visit),
        })
    }

    #[cfg(test)]
    fn footprint(&self, of: &impl Fn(&V) -> usize) -> usize {
        let own = std::mem::size_of::<Self>() + 16 + self.slots.capacity() * std::mem::size_of::<Slot<V>>();
        own + self
            .slots
            .iter()
            .map(|slot| match slot {
                Slot::Leaf(_, value) => of(value),
                Slot::Node(next) => next.footprint(of),
            })
            .sum::<usize>()
    }
}

impl<V: Clone> Trie<V> {
    fn get(&self, key: u64) -> Option<&V> {
        let mut node = self.root.as_deref()?;
        let mut depth = 0;
        loop {
            let (bit, at) = node.place(key, depth);
            if node.bitmap & bit == 0 {
                return None;
            }
            match &node.slots[at] {
                Slot::Leaf(known, value) => return (*known == key).then_some(value),
                Slot::Node(next) => node = next,
            }
            depth += 1;
        }
    }

    fn insert(&mut self, key: u64, value: V) -> Option<V> {
        Arc::make_mut(self.root.get_or_insert_with(|| Arc::new(Node::empty()))).insert(key, value, 0)
    }

    fn remove(&mut self, key: u64) -> Option<V> {
        let root = self.root.as_mut()?;
        let removed = Arc::make_mut(root).remove(key, 0);
        if root.slots.is_empty() {
            self.root = None;
        }
        removed
    }

    /// Visits the entries whose highest `bits` bits are `prefix`'s, in key order, until `visit` says it is done; returns
    /// whether it did.
    fn visit_prefixed(&self, prefix: u64, bits: u32, visit: &mut impl FnMut(u64, &V) -> bool) -> bool {
        let mask = if bits == 0 { 0 } else { u64::MAX << (64 - bits) };
        let Some(mut node) = self.root.as_deref() else { return false };
        let mut depth = 0;
        let mut taken = 0;
        while taken + width(depth) <= bits {
            let (bit, at) = node.place(prefix, depth);
            if node.bitmap & bit == 0 {
                return false;
            }
            match &node.slots[at] {
                Slot::Leaf(key, value) => return *key & mask == prefix & mask && visit(*key, value),
                Slot::Node(next) => node = next,
            }
            taken += width(depth);
            depth += 1;
        }
        // The children whose chunk begins with what is left of the prefix.
        let free = width(depth) - (bits - taken);
        let first = chunk(prefix, depth) >> free << free;
        for child in first..first + (1 << free) {
            let bit = 1_u64 << child;
            if node.bitmap & bit == 0 {
                continue;
            }
            let done = match &node.slots[(node.bitmap & (bit - 1)).count_ones() as usize] {
                Slot::Leaf(key, value) => *key & mask == prefix & mask && visit(*key, value),
                Slot::Node(next) => next.visit_all(visit),
            };
            if done {
                return true;
            }
        }
        false
    }

    #[cfg(test)]
    fn footprint(&self, of: impl Fn(&V) -> usize) -> usize {
        self.root.as_deref().map_or(0, |root| root.footprint(&of))
    }

    /// (nodes, slots allocated, leaves, deepest node).
    #[cfg(test)]
    fn shape(&self) -> (usize, usize, usize, u32) {
        fn walk<V>(node: &Node<V>, depth: u32, out: &mut (usize, usize, usize, u32)) {
            out.0 += 1;
            out.1 += node.slots.capacity();
            out.3 = out.3.max(depth);
            for slot in &node.slots {
                match slot {
                    Slot::Leaf(..) => out.2 += 1,
                    Slot::Node(next) => walk(next, depth + 1, out),
                }
            }
        }
        let mut out = (0, 0, 0, 0);
        if let Some(root) = self.root.as_deref() {
            walk(root, 0, &mut out);
        }
        out
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------------------------------

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

/// A form found in a view: its start, its end and its kind.
type Found = (usize, usize, Kind);

/// One form of one credential as the index holds it: what a fingerprint's hit is verified against (forms of at most
/// twice [`PRINT`] bytes are named whole by their first and last bytes; a longer one is regenerated from the credential).
struct Entry {
    secret: Arc<str>,
    form: u8,
    kind: Kind,
    len: u32,
    first: u64,
    last: u64,
}

/// A form's first and last [`PRINT`] bytes (a shorter form's bytes and nothing).
fn ends_of(bytes: &[u8]) -> (u64, u64) {
    if bytes.len() >= PRINT { (pack(&bytes[..PRINT]), pack(&bytes[bytes.len() - PRINT..])) } else { (pack(bytes), 0) }
}

/// The bucket of the forms with these ends and length: the high half of their entries' keys.
fn bucket(first: u64, last: u64, len: usize) -> u64 {
    mix(mix(first ^ len as u64) ^ last) & !0xFFFF_FFFF
}

/// An entry's key: its bucket, then the loosest kind first (a hit stops at the first entry whose form is there), the
/// credential's place and the form's.
fn entry_key(bytes: &[u8], kind: Kind, cred: u32, form: usize) -> u64 {
    let (first, last) = ends_of(bytes);
    let rank: u64 = match kind {
        Kind::Anywhere => 0,
        Kind::Token => 1,
        Kind::TokenBase64 => 2,
        Kind::Base64 => 3,
    };
    debug_assert!(cred < MAX_CREDS && form < 64, "a place and a form fit their bits");
    bucket(first, last, bytes.len()) | rank << 30 | u64::from(cred) << 6 | form as u64
}

/// The places an entry's key has bits for (24). Places are reused, and the registry holds the caps' 8,192 values besides
/// what sources yield: far fewer.
const MAX_CREDS: u32 = 1 << 24;

/// Every canonical form of every credential held, by fingerprint: the first stage of a match finds a form's first eight
/// bytes (a shorter form whole) in it, the second verifies the whole form. Persistent: a copy is a handful of pointers,
/// and a change copies the trie nodes on its own entries' paths.
#[derive(Clone, Default)]
struct Index {
    /// Each fingerprint (mixed) and the lengths of its forms, with how many entries have each.
    heads: Trie<Arc<[(u32, u32)]>>,
    /// Every form of every credential (see [`entry_key`]).
    forms: Trie<Arc<Entry>>,
    /// How many entries each length below [`PRINT`] has.
    short_lengths: [u32; PRINT],
    /// The first bytes of every form, left-aligned, and how many entries begin with them: whether a text ends inside one.
    starts: Trie<u32>,
    live: usize,
}

impl Index {
    fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// Indexes every form of `secret` at its place `cred`, touching the entries of its own forms only.
    fn insert(&mut self, secret: &Arc<str>, cred: u32) {
        for (form, (bytes, kind)) in forms_of(secret).into_iter().enumerate() {
            let (first, last) = ends_of(&bytes);
            let entry = Entry { secret: secret.clone(), form: form as u8, kind, len: bytes.len() as u32, first, last };
            self.forms.insert(entry_key(&bytes, kind, cred, form), Arc::new(entry));
            self.count(&bytes, true);
            #[cfg(test)]
            TOUCHED.with(|touched| touched.set(touched.get() + 1));
        }
        self.live += 1;
    }

    /// Drops every form of `secret` at its place `cred`.
    fn remove(&mut self, secret: &str, cred: u32) {
        for (form, (bytes, kind)) in forms_of(secret).into_iter().enumerate() {
            if self.forms.remove(entry_key(&bytes, kind, cred, form)).is_some() {
                self.count(&bytes, false);
            }
            #[cfg(test)]
            TOUCHED.with(|touched| touched.set(touched.get() + 1));
        }
        self.live -= 1;
    }

    /// One entry more (`up`) or less of a form of these bytes in the counts the scan reads.
    fn count(&mut self, bytes: &[u8], up: bool) {
        let step = |n: u32| if up { n + 1 } else { n.saturating_sub(1) };
        if bytes.len() >= PRINT {
            let key = mix(pack(&bytes[..PRINT]));
            let mut lengths: Vec<(u32, u32)> = self.heads.get(key).map_or_else(Vec::new, |lengths| lengths.to_vec());
            match lengths.iter().position(|(len, _)| *len == bytes.len() as u32) {
                Some(at) => lengths[at].1 = step(lengths[at].1),
                None if up => lengths.push((bytes.len() as u32, 1)),
                None => {}
            }
            lengths.retain(|(_, entries)| *entries > 0);
            if lengths.is_empty() {
                self.heads.remove(key);
            } else {
                self.heads.insert(key, lengths.into());
            }
        } else {
            self.short_lengths[bytes.len()] = step(self.short_lengths[bytes.len()]);
        }
        let start = pack_left(&bytes[..bytes.len().min(PRINT)]);
        match step(self.starts.get(start).copied().unwrap_or(0)) {
            0 => {
                self.starts.remove(start);
            }
            entries => {
                self.starts.insert(start, entries);
            }
        }
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
                if end >= len {
                    let part = window & ((1_u64 << (8 * len)) - 1);
                    self.verify(bucket(part, 0, len), (part, 0), end - len, len, bytes, &mut found);
                }
            }
            if end < PRINT {
                continue;
            }
            let Some(lengths) = self.heads.get(mix(window)) else { continue };
            let start = end - PRINT;
            let mut longest = 0;
            for &(len, _) in lengths.iter() {
                let len = len as usize;
                longest = longest.max(len);
                if start + len <= bytes.len() {
                    let last = pack(&bytes[start + len - PRINT..start + len]);
                    self.verify(bucket(window, last, len), (window, last), start, len, bytes, &mut found);
                }
            }
            begun.push((start, longest));
        }
        (found, begun)
    }

    /// The second stage: the first entry of `bucket` (the loosest kind first) whose whole form is `bytes[start..start + len]`.
    fn verify(&self, bucket: u64, ends: (u64, u64), start: usize, len: usize, bytes: &[u8], found: &mut Vec<Found>) {
        let text = &bytes[start..start + len];
        self.forms.visit_prefixed(bucket, 32, &mut |_, entry| {
            let whole = entry.len as usize == len
                && (entry.first, entry.last) == ends
                && (len <= 2 * PRINT || form_of(&entry.secret, usize::from(entry.form)) == text);
            if whole {
                found.push((start, start + len, entry.kind));
            }
            whole
        });
    }

    /// Where the earliest form that `bytes[..at]` may end inside begins: a fingerprint seen whose longest form goes on past
    /// `at`, or a beginning of a form in the last bytes before it.
    fn open_from(&self, bytes: &[u8], begun: &[(usize, usize)], at: usize) -> Option<usize> {
        let long = begun.iter().find(|(start, longest)| start + PRINT <= at && start + longest > at).map(|(start, _)| *start);
        long.or_else(|| (at.saturating_sub(PRINT - 1)..at).find(|start| self.begins(&bytes[*start..at])))
    }

    /// Whether a form begins with `part` (one to seven bytes).
    fn begins(&self, part: &[u8]) -> bool {
        self.starts.visit_prefixed(pack_left(part), 8 * part.len() as u32, &mut |_, _| true)
    }

    /// What the index holds in bytes, estimated from its containers: every trie node with its slots, every entry and the
    /// lengths a fingerprint lists (the credentials' text is the registry's, counted there).
    #[cfg(test)]
    fn footprint(&self) -> usize {
        use std::mem::size_of;
        self.heads.footprint(|lengths| 16 + lengths.len() * size_of::<(u32, u32)>())
            + self.forms.footprint(|_| 16 + size_of::<Entry>())
            + self.starts.footprint(|_| 0)
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
    Registry(Arc<Registry>),
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

#[cfg(test)]
thread_local! {
    /// Run by a scan of this thread once it holds its snapshot and before it reads it (a test parks a scan there).
    pub(crate) static SCANNING: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

impl Matcher {
    pub fn new(credentials: &[String]) -> Self {
        let mut index = Index::default();
        let mut seen: Vec<&str> = Vec::new();
        for credential in credentials.iter().filter(|c| !c.is_empty()) {
            if !seen.contains(&credential.as_str()) {
                seen.push(credential);
                index.insert(&Arc::from(credential.as_str()), seen.len() as u32 - 1);
            }
        }
        Self(Source::Own(Box::new(index)))
    }

    /// The matcher of values a caller names (`scrubOAuthSecrets(text, secretValues)`).
    pub fn of_secrets(secrets: &[&str]) -> Self {
        Self::new(&secrets.iter().map(|secret| (*secret).to_owned()).collect::<Vec<_>>())
    }

    /// The matcher of what `registry` holds whenever a text is read.
    pub fn of_registry(registry: Arc<Registry>) -> Self {
        Self(Source::Registry(registry))
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Source::Own(index) => index.is_empty(),
            Source::Registry(registry) => registry.snapshot().is_empty(),
        }
    }

    /// `source` with every credential redacted. `context` is what the text before it ended with; unless `last`, the end of
    /// `source` that may still become (a part of) a credential is not consumed and waits for the next text. Against a
    /// registry, the text is read against the index as the registry holds it now, taken in O(1); no lock is held while it is
    /// read, so no registration waits for it.
    pub fn redact(&self, source: &[u8], context: Context, last: bool) -> Redacted {
        match &self.0 {
            Source::Own(index) => index.redact(source, context, last),
            Source::Registry(registry) => {
                let index = registry.snapshot();
                #[cfg(test)]
                if let Some(park) = SCANNING.with(|hook| hook.borrow_mut().take()) {
                    park();
                }
                index.redact(source, context, last)
            }
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

// ---------------------------------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------------------------------

/// The line a value nothing holds waits in to be forgotten.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Line {
    /// A value a source yielded once and yields no more: the oldest retirement goes first.
    Retired,
    /// A value no source ever yielded: the least recently carried goes first.
    Carried,
}

/// What the registry holds of one value: its place in the index, how many sources yield it and how many exchanges in
/// flight carry it, whether a source ever yielded it, and its place in a line while nothing holds it.
struct Held {
    cred: u32,
    sources: u32,
    leases: u32,
    owned: bool,
    queued: Option<(Line, u64)>,
}

/// The values of one line, oldest first (an entry whose value was held again or queued later is stale), and how many are
/// live.
struct Queue {
    order: VecDeque<(u64, Arc<str>)>,
    live: usize,
    cap: usize,
}

impl Queue {
    fn new(cap: usize) -> Self {
        Self { order: VecDeque::new(), live: 0, cap }
    }
}

/// The registry's own state, changed under its lock by registrations alone.
struct Book {
    /// The working copy of the index; published as a new snapshot after each change.
    index: Index,
    changed: bool,
    held: HashMap<Arc<str>, Held>,
    /// What each source yields now.
    sources: HashMap<String, Vec<Arc<str>>>,
    retired: Queue,
    carried: Queue,
    seq: u64,
    free: Vec<u32>,
    next: u32,
}

impl Book {
    fn new(retired_cap: usize, carried_cap: usize) -> Self {
        Self {
            index: Index::default(),
            changed: false,
            held: HashMap::new(),
            sources: HashMap::new(),
            retired: Queue::new(retired_cap),
            carried: Queue::new(carried_cap),
            seq: 0,
            free: Vec::new(),
            next: 0,
        }
    }

    /// The registry's copy of `value`, indexed (its own entries only) when new, out of its line when it waited in one.
    fn take(&mut self, value: &str) -> Arc<str> {
        if let Some((known, held)) = self.held.get_key_value(value) {
            let known = known.clone();
            if let Some((line, _)) = held.queued {
                match line {
                    Line::Retired => self.retired.live -= 1,
                    Line::Carried => self.carried.live -= 1,
                }
                self.held.get_mut(value).expect("just found").queued = None;
            }
            return known;
        }
        let cred = self.free.pop().unwrap_or_else(|| {
            self.next += 1;
            self.next - 1
        });
        let value: Arc<str> = Arc::from(value);
        self.index.insert(&value, cred);
        self.changed = true;
        self.held.insert(value.clone(), Held { cred, sources: 0, leases: 0, owned: false, queued: None });
        value
    }

    /// Once nothing holds `value`, it waits in its line: retired when a source ever yielded it, else by its last carry.
    fn settle(&mut self, value: &Arc<str>) {
        let Some(held) = self.held.get_mut(value) else { return };
        if held.sources > 0 || held.leases > 0 || held.queued.is_some() {
            return;
        }
        self.seq += 1;
        let line = if held.owned { Line::Retired } else { Line::Carried };
        held.queued = Some((line, self.seq));
        let queue = match line {
            Line::Retired => &mut self.retired,
            Line::Carried => &mut self.carried,
        };
        queue.order.push_back((self.seq, value.clone()));
        queue.live += 1;
    }

    /// Over a line's cap, its oldest values are forgotten; a value a source yields or an exchange carries never is.
    fn evict(&mut self) {
        for (line, queue) in [(Line::Retired, &mut self.retired), (Line::Carried, &mut self.carried)] {
            while queue.live > queue.cap {
                let Some((seq, value)) = queue.order.pop_front() else { break };
                if self.held.get(&value).is_some_and(|held| held.queued == Some((line, seq))) {
                    let held = self.held.remove(&value).expect("just found");
                    self.index.remove(&value, held.cred);
                    self.changed = true;
                    self.free.push(held.cred);
                    queue.live -= 1;
                }
            }
            if queue.order.len() > 2 * queue.live + 64 {
                let held = &self.held;
                queue.order.retain(|(seq, value)| held.get(value).is_some_and(|held| held.queued == Some((line, *seq))));
            }
        }
    }

    fn keep(&mut self, source: &str, values: &[&str]) {
        let mut now: Vec<Arc<str>> = Vec::new();
        for value in values.iter().map(|value| value.trim()).filter(|value| !value.is_empty()) {
            if now.iter().any(|known| &**known == value) {
                continue;
            }
            let value = self.take(value);
            let held = self.held.get_mut(&value).expect("just taken");
            held.sources += 1;
            held.owned = true;
            now.push(value);
        }
        let before = if now.is_empty() { self.sources.remove(source) } else { self.sources.insert(source.to_owned(), now) };
        for value in before.unwrap_or_default() {
            if let Some(held) = self.held.get_mut(&value) {
                held.sources -= 1;
            }
            self.settle(&value);
        }
        self.evict();
    }

    fn lease(&mut self, values: &[String]) -> Vec<Arc<str>> {
        let mut leased: Vec<Arc<str>> = Vec::with_capacity(values.len());
        for value in values.iter().map(|value| value.trim()).filter(|value| !value.is_empty()) {
            if leased.iter().any(|known| &**known == value) {
                continue;
            }
            let value = self.take(value);
            self.held.get_mut(&value).expect("just taken").leases += 1;
            leased.push(value);
        }
        leased
    }

    fn release(&mut self, leased: &[Arc<str>]) {
        for value in leased {
            if let Some(held) = self.held.get_mut(value) {
                held.leases -= 1;
            }
            self.settle(value);
        }
        self.evict();
    }
}

/// How many values the registry holds: those a source yields or an exchange carries, the retired ones and the carried ones
/// no source yields.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Counts {
    pub held: usize,
    pub retired: usize,
    pub carried: usize,
}

/// Every credential the process read out of a source or attached to an exchange (see the module's rule). Registrations
/// change the book under its lock; scans read the published snapshot, taken in O(1), and hold nothing while they read it.
pub struct Registry {
    book: Mutex<Book>,
    published: RwLock<Arc<Index>>,
}

impl Registry {
    /// A registry keeping at most `retired_cap` retired values and `carried_cap` values no source yields.
    pub fn new(retired_cap: usize, carried_cap: usize) -> Self {
        Self { book: Mutex::new(Book::new(retired_cap, carried_cap)), published: RwLock::new(Arc::new(Index::default())) }
    }

    /// The index as the registry holds it now: one pointer, copied under a lock held for that copy alone.
    fn snapshot(&self) -> Arc<Index> {
        self.published.read().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Runs `change` on the book, then publishes its index if it changed (a pointer, under the snapshot lock for that alone).
    fn change<R>(&self, change: impl FnOnce(&mut Book) -> R) -> R {
        let mut book = self.book.lock().unwrap_or_else(PoisonError::into_inner);
        let out = change(&mut book);
        if std::mem::take(&mut book.changed) {
            let snapshot = Arc::new(book.index.clone());
            *self.published.write().unwrap_or_else(PoisonError::into_inner) = snapshot;
        }
        out
    }

    /// `source` yields `values` now: they are pinned, and what it yielded before and yields no more is retired (unless
    /// another source still yields it or an exchange carries it). Each new value costs the index entries of its own forms,
    /// whatever the registry holds; a value it holds already costs a lookup.
    pub fn keep(&self, source: &str, values: &[&str]) {
        self.change(|book| book.keep(source, values));
    }

    fn release(&self, leased: &[Arc<str>]) {
        self.change(|book| book.release(leased));
    }

    /// Whether `value` is a credential the registry holds.
    pub fn holds(&self, value: &str) -> bool {
        self.book.lock().unwrap_or_else(PoisonError::into_inner).held.contains_key(value)
    }

    pub fn counts(&self) -> Counts {
        let book = self.book.lock().unwrap_or_else(PoisonError::into_inner);
        Counts { held: book.held.len() - book.retired.live - book.carried.live, retired: book.retired.live, carried: book.carried.live }
    }

    /// The bytes the registry's index and values hold (an estimate from their containers).
    #[cfg(test)]
    pub(crate) fn footprint(&self) -> usize {
        let book = self.book.lock().unwrap_or_else(PoisonError::into_inner);
        let values: usize = book.held.keys().map(|value| 16 + value.len() + std::mem::size_of::<Held>() + 16).sum();
        book.index.footprint() + values
    }

    /// Forgets everything (a replay starts as a new process).
    fn reset(&self) {
        let mut book = self.book.lock().unwrap_or_else(PoisonError::into_inner);
        let caps = (book.retired.cap, book.carried.cap);
        *book = Book::new(caps.0, caps.1);
        *self.published.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(Index::default());
    }
}

/// The credentials one exchange carries, held while the exchange is in flight: a value its source replaces while the
/// response still streams stays a credential of that stream, whatever is retired after it. Dropped with the exchange.
pub struct Lease {
    registry: Arc<Registry>,
    values: Vec<Arc<str>>,
}

impl Lease {
    fn of(registry: &Arc<Registry>, values: &[String]) -> Self {
        let values = if values.is_empty() { Vec::new() } else { registry.change(|book| book.lease(values)) };
        Self { registry: registry.clone(), values }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if !self.values.is_empty() {
            self.registry.release(&self.values);
        }
    }
}

static REGISTRY: LazyLock<Arc<Registry>> = LazyLock::new(|| Arc::new(Registry::new(RETIRED_CAP, CARRIED_CAP)));

/// A replay starts as a new process: the registry is empty.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_registry() {
    REGISTRY.reset();
}

/// The process registry (its counts, for a test).
#[cfg(any(test, feature = "test-support"))]
pub fn registry() -> Arc<Registry> {
    REGISTRY.clone()
}

/// `source` (a key variable, a keychain entry, a configured key, an account's credential file, the exchange that handed
/// a token over) yields `values` now, read out of it before any request or text can carry them: they are credentials from
/// this moment, pinned while the source yields them; what it yielded before is retired.
pub fn keep(source: &str, values: &[&str]) {
    REGISTRY.keep(source, values);
}

/// The source of a token an exchange hands over for the account of credential `of` (a session JWT, an exchanged access
/// token): named by a hash of that credential, never its text, so one account's next token replaces its last.
pub fn derived_source(kind: &str, of: &str) -> String {
    use std::hash::Hash as _;
    use std::hash::Hasher as _;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    of.hash(&mut hasher);
    format!("{kind} {:016x}", hasher.finish())
}

/// The matcher of every credential this process read or attached, read as the registry is at each text: a response that
/// began before a credential was registered is searched for it from its next text on.
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
