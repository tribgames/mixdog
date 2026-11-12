use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_core_api::domain::keepalive::TransportKind;

use super::*;

const KEY: &str = "long/key+value";

fn matcher(credentials: &[&str]) -> Matcher {
    Matcher::of_secrets(credentials)
}

fn utf16le(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

/// Every byte of `text` as `%u00XX`.
fn percent_u(text: &str) -> String {
    text.bytes().map(|b| format!("%u{b:04x}")).collect()
}

/// Each spelling the review found passing (item 1), inside ordinary text: the whole source span of each is one `[REDACTED]`.
#[test]
fn every_encoding_of_a_credential_is_redacted_whole() {
    let base64 = STANDARD.encode(KEY);
    let wrapped = format!("{}\r\n{}", &base64[..16], &base64[16..]);
    let forms: Vec<Vec<u8>> = vec![
        b"long%252Fkey%252Bvalue".to_vec(),
        b"long%2fkey%2Bvalue".to_vec(),
        wrapped.into_bytes(),
        br"long\/key+value".to_vec(),
        br"long\u002fkey\u002Bvalue".to_vec(),
        b"long&#47;key&#x2B;value".to_vec(),
        b"long&sol;key&plus;value".to_vec(),
        utf16le(KEY),
        // Two layers: JSON escapes of an HTML reference of a percent-escape.
        br"long\u0026#37;2Fkey+value".to_vec(),
        // `%uXXXX`, whole and mixed with percent-escapes (review 1123v item 2).
        percent_u(KEY).into_bytes(),
        b"long%u002Fkey%2bvalue".to_vec(),
        b"long%u002fkey%u002Bvalue".to_vec(),
    ];
    let scrub = matcher(&[KEY]);
    for form in forms {
        let text = [b"refused ".as_slice(), &form, b" for this account"].concat();
        let clean = scrub.redacted(&text).unwrap_or_else(|| panic!("{} passed", String::from_utf8_lossy(&form)));
        assert_eq!(String::from_utf8_lossy(&clean), "refused [REDACTED] for this account", "{}", String::from_utf8_lossy(&form));
    }
}

/// `%u0061…` for `abcdefgh`, and a form's `+` for a space (and its reading back) in both directions, whole and split at every
/// cut of a chunked text (item 2).
#[test]
fn percent_u_escapes_and_form_plus_are_read() {
    let plain = matcher(&["abcdefgh"]);
    assert_eq!(plain.redact_str(&format!("x {} y", percent_u("abcdefgh"))), "x [REDACTED] y");
    assert_eq!(plain.redact_str("x %u0061bcdefgh y %u0061%u0062%u0063%u0064%u0065%u0066%u0067%u0068 z"), "x [REDACTED] y [REDACTED] z");
    // An unfinished `%u` escape at the end of a text is not a credential yet.
    assert_eq!(plain.redact_str("x %u00"), "x %u00");
    let spaced = matcher(&["abcdefgh ijkl"]);
    for echoed in ["abcdefgh+ijkl", "abcdefgh ijkl", "abcdefgh%20ijkl", "abcdefgh%2Bijkl", "abcdefgh%u0020ijkl"] {
        assert_eq!(spaced.redact_str(&format!("x {echoed} y")), "x [REDACTED] y", "{echoed}");
    }
    let plus = matcher(&["abcdefgh+ijkl"]);
    for echoed in ["abcdefgh ijkl", "abcdefgh+ijkl", "abcdefgh%2Bijkl", "abcdefgh%20ijkl"] {
        assert_eq!(plus.redact_str(&format!("x {echoed} y")), "x [REDACTED] y", "{echoed}");
    }
    let text = format!("data: {} and {}\n\n", percent_u("abcdefgh"), "abcdefgh+ijkl");
    let scrub = Arc::new(matcher(&["abcdefgh", "abcdefgh ijkl"]));
    let whole = scrub.redact_str(&text);
    assert_eq!(whole, "data: [REDACTED] and [REDACTED]\n\n");
    for cut in 1..text.len() {
        let mut stream = Stream::new(scrub.clone());
        let mut got = stream.push(&text.as_bytes()[..cut]);
        got.extend(stream.push(&text.as_bytes()[cut..]));
        got.extend(stream.finish());
        assert_eq!(String::from_utf8(got).unwrap(), whole, "cut at {cut}");
    }
}

/// A JWT credential's segments are found one by one.
#[test]
fn each_segment_of_a_jwt_credential_is_redacted() {
    let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLWJ5dGVzLTQ1";
    let text = "a eyJzdWIiOiJ1c2VyLTEyMyJ9 b c2lnbmF0dXJlLWJ5dGVzLTQ1 c eyJhbGciOiJIUzI1NiJ9 d";
    assert_eq!(matcher(&[jwt]).redact_str(text), "a [REDACTED] b [REDACTED] c [REDACTED] d");
}

/// A redirect's `Location` repeats the key the request carried double-encoded in its query.
#[test]
fn an_encoded_credential_in_a_header_is_redacted() {
    let mut headers = vec![("location".to_owned(), "https://example.test/?key=long%252Fkey%252Bvalue&alt=sse".to_owned()), ("x-request-id".to_owned(), "req_1".to_owned())];
    matcher(&[KEY]).redact_headers(&mut headers);
    assert_eq!(headers[0].1, "https://example.test/?key=[REDACTED]&alt=sse");
    assert_eq!(headers[1].1, "req_1");
}

/// A credential shorter than eight bytes (item 2) is a whole token: redacted after `Bearer`, at the end of a header and
/// encoded in a query, never as a part of a longer word.
#[test]
fn a_short_credential_is_redacted_as_a_whole_token() {
    let scrub = matcher(&["abc1234"]);
    assert_eq!(scrub.redact_str("Bearer abc1234"), "Bearer [REDACTED]");
    assert_eq!(scrub.redact_str("token abc1234."), "token [REDACTED].");
    assert_eq!(scrub.redact_str("https://example.test/?key=abc%31234&alt=sse"), "https://example.test/?key=[REDACTED]&alt=sse");
    assert_eq!(scrub.redact_str(&format!("basic {}", URL_SAFE_NO_PAD.encode("abc1234"))), "basic [REDACTED]");
    assert_eq!(scrub.redacted(b"abc12345 xabc1234 abc1234x my-abc1234"), None);
}

/// What a request carries by provenance: its credential headers, the userinfo and key of its URL. A field named `code` (or
/// any other) of an ordinary body is no credential (item 3), so a tool result `{"code":"print(1)"}` is never redacted.
#[test]
fn a_request_names_only_what_its_transport_attached() {
    let request = WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: "https://user-7f3a:urlpassword-9c1d@example.test/v1?key=query%2Fkey-5b2e&alt=sse".into(),
        headers: vec![
            ("Authorization".into(), "Bearer header-token-1a2b3c".into()),
            ("x-goog-api-key".into(), "goog-key-4d5e6f7a".into()),
            ("sec-websocket-key".into(), "dGhlIHNhbXBsZSBub25jZQ==".into()),
            ("content-type".into(), "application/json".into()),
        ],
        body: br#"{"messages":[{"role":"tool","content":{"code":"print(1)"}}],"refresh_token":"not-a-token-request"}"#.to_vec(),
    };
    let credentials = of_request(&request);
    assert_eq!(credentials, ["header-token-1a2b3c", "goog-key-4d5e6f7a", "user-7f3a", "urlpassword-9c1d", "query/key-5b2e"]);
    assert_eq!(Matcher::new(&credentials).redacted(br#"{"code":"print(1)"} and not-a-token-request"#), None);
}

/// A token request is known by its kind (a top-level `grant_type`): its secret fields are credentials, its public ones not.
#[test]
fn a_token_request_names_its_secret_fields() {
    let form = WireRequest {
        transport: TransportKind::Http1,
        method: "POST".into(),
        url: "https://auth.example.test/oauth/token".into(),
        headers: vec![("authorization".into(), format!("Basic {}", STANDARD.encode("client-id:client-secret-9a")))],
        body: b"grant_type=authorization_code&code=auth-code-1&code_verifier=verifier-2&client_id=public-client".to_vec(),
    };
    assert_eq!(of_request(&form), ["Y2xpZW50LWlkOmNsaWVudC1zZWNyZXQtOWE=", "client-id:client-secret-9a", "client-secret-9a", "auth-code-1", "verifier-2"]);
    let json = WireRequest { body: br#"{"grant_type":"refresh_token","refresh_token":"refresh-3","client_id":"public"}"#.to_vec(), headers: Vec::new(), ..form };
    assert_eq!(of_request(&json), ["refresh-3"]);
}

/// Every cut of a chunked text: what arrives is what the whole text redacts to, and a form cut in two (an escape, a wrapped
/// base64 line, a whole token) is held until the chunk that finishes it.
#[test]
fn a_credential_split_across_chunks_is_redacted() {
    let base64 = STANDARD.encode(KEY);
    let texts = [
        "data: the key long%252Fkey%252Bvalue was refused\n\n".to_owned(),
        "data: the key long&#47;key&#x2B;value was refused\n\n".to_owned(),
        // An escape inside an escape that a cut leaves unfinished: `&#92;u0&#x3` is a `\u0` the next chunk finishes.
        "data: the key long&#92;u0&#x30;2fkey+value was refused\n\n".to_owned(),
        // A wrapped base64 line whose break is percent-encoded: a cut inside `%0d%0a` leaves the line open.
        format!("data: the key {}%0d%0a{} was refused\n\n", &base64[..16], &base64[16..]),
        format!("data: the key {}\n{} was refused\n\n", &base64[..16], &base64[16..]),
        "data: Bearer abc1234\n\n".to_owned(),
    ];
    let scrub = Arc::new(matcher(&[KEY, "abc1234"]));
    for text in &texts {
        let whole = scrub.redact_str(text);
        assert!(whole.contains(REDACTED), "{text}");
        for cut in 1..text.len() {
            let mut stream = Stream::new(scrub.clone());
            let mut got = stream.push(&text.as_bytes()[..cut]);
            got.extend(stream.push(&text.as_bytes()[cut..]));
            got.extend(stream.finish());
            assert_eq!(String::from_utf8(got).unwrap(), whole, "cut at {cut}");
        }
        let mut stream = Stream::new(scrub.clone());
        let mut got: Vec<u8> = text.as_bytes().iter().flat_map(|byte| stream.push(&[*byte])).collect();
        got.extend(stream.finish());
        assert_eq!(String::from_utf8(got).unwrap(), whole, "byte by byte");
    }
}

/// A chunk whose end cannot begin a credential is handed on whole, at once.
#[test]
fn text_with_no_credential_is_not_held() {
    let mut stream = Stream::new(Arc::new(matcher(&[KEY])));
    assert_eq!(stream.push(b"data: {\"text\":\"hello\"}\n\n"), b"data: {\"text\":\"hello\"}\n\n");
    assert_eq!(stream.push(b"event: content_block_delta\ndata: plain"), b"event: content_block_delta\ndata: plain");
}

// ---- the generated test ----------------------------------------------------------------------------------------------

/// xorshift64*: a seeded, reproducible stream.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self) -> bool {
        self.next() & 1 == 1
    }
}

/// A credential: printable ASCII with no escape introducer (`%`, `\`, `&`), blanks inside it only (a credential is trimmed).
fn credential(rng: &mut Rng) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_./+=:~!*'()<>\"#$,;?@[]^`{|} ";
    let len = 1 + rng.below(40);
    let drawn: String = (0..len).map(|_| char::from(ALPHABET[rng.below(ALPHABET.len())])).collect();
    let trimmed = drawn.trim();
    if trimmed.is_empty() { "k".to_owned() } else { trimmed.to_owned() }
}

/// `%u00XX`, the escape of JavaScript's `escape()`.
fn percent_u_layer(rng: &mut Rng, bytes: &[u8]) -> Vec<u8> {
    bytes.iter().flat_map(|b| if !b.is_ascii_alphanumeric() || rng.below(4) == 0 { format!("%u{b:04x}").into_bytes() } else { vec![*b] }).collect()
}

/// A form encoder's space as `+`, or a form decoder's `+` as a space.
fn form_layer(rng: &mut Rng, bytes: &[u8]) -> Vec<u8> {
    let encode = rng.chance();
    bytes.iter().map(|b| match (b, encode) {
        (b' ', true) => b'+',
        (b'+', false) => b' ',
        (b, _) => *b,
    }).collect()
}

fn percent_layer(rng: &mut Rng, bytes: &[u8]) -> Vec<u8> {
    let lower = rng.chance();
    bytes
        .iter()
        .flat_map(|b| if *b == b'%' || !b.is_ascii_alphanumeric() || rng.below(4) == 0 {
            let hex = if lower { format!("%{b:02x}") } else { format!("%{b:02X}") };
            hex.into_bytes()
        } else {
            vec![*b]
        })
        .collect()
}

fn json_layer(rng: &mut Rng, bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .flat_map(|b| match b {
            b'"' => b"\\\"".to_vec(),
            b'\\' => b"\\\\".to_vec(),
            b'/' if rng.chance() => b"\\/".to_vec(),
            b if *b < 0x20 || *b >= 0x80 || rng.below(4) == 0 => format!("\\u{:04x}", b).into_bytes(),
            b => vec![*b],
        })
        .collect()
}

fn html_layer(rng: &mut Rng, bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .flat_map(|b| match b {
            b'&' => b"&amp;".to_vec(),
            b'/' if rng.chance() => b"&sol;".to_vec(),
            b if *b < 0x80 && (!b.is_ascii_alphanumeric() || rng.below(4) == 0) => {
                if rng.chance() { format!("&#{b};").into_bytes() } else { format!("&#x{b:X};").into_bytes() }
            }
            b => vec![*b],
        })
        .collect()
}

fn utf16_layer(rng: &mut Rng, bytes: &[u8]) -> Vec<u8> {
    let le = rng.chance();
    bytes.iter().flat_map(|b| if le { [*b, 0] } else { [0, *b] }).collect()
}

/// The credential under up to three random layers, its base64 first when the draw says so.
fn encoded(rng: &mut Rng, secret: &str) -> (Vec<u8>, Vec<&'static str>) {
    let mut names = Vec::new();
    let mut bytes = secret.as_bytes().to_vec();
    // A form encoding of the credential itself, before anything else is done to it.
    if rng.chance() {
        bytes = form_layer(rng, &bytes);
        names.push("form");
    }
    if rng.chance() {
        let mut text = if rng.chance() { STANDARD.encode(&bytes) } else { URL_SAFE_NO_PAD.encode(&bytes) };
        if text.len() > 32 && rng.chance() {
            let width = 16 + rng.below(text.len() - 16);
            let break_with = if rng.chance() { "\n" } else { "\r\n" };
            text = format!("{}{break_with}{}", &text[..width], &text[width..]);
        }
        bytes = text.into_bytes();
        names.push("base64");
    }
    for _ in 0..rng.below(4) {
        let (name, layer): (&str, fn(&mut Rng, &[u8]) -> Vec<u8>) =
            [("percent", percent_layer as fn(&mut Rng, &[u8]) -> Vec<u8>), ("json", json_layer), ("html", html_layer), ("utf16", utf16_layer), ("percent-u", percent_u_layer)][rng.below(5)];
        bytes = layer(rng, &bytes);
        names.push(name);
    }
    (bytes, names)
}

/// The test's own decoders, each applied wherever it can be, to a fixed point.
fn decoded(text: &[u8]) -> Vec<u8> {
    let mut current = text.to_vec();
    for _ in 0..12 {
        let mut next = Vec::with_capacity(current.len());
        let mut i = 0;
        while i < current.len() {
            let rest = &current[i..];
            let hex_at = |at: usize| rest.get(at).and_then(|b| (*b as char).to_digit(16));
            if rest.starts_with(b"%u") && let Some(unit) = rest.get(2..6).and_then(|d| u32::from_str_radix(std::str::from_utf8(d).ok()?, 16).ok()) {
                next.extend(char::from_u32(unit).unwrap_or('\u{FFFD}').to_string().into_bytes());
                i += 6;
            } else if rest[0] == b'%' && let (Some(h), Some(l)) = (hex_at(1), hex_at(2)) {
                next.push((h * 16 + l) as u8);
                i += 3;
            } else if rest.starts_with(b"\\u") && let Some(unit) = rest.get(2..6).and_then(|d| u32::from_str_radix(std::str::from_utf8(d).ok()?, 16).ok()) {
                next.extend(char::from_u32(unit).unwrap_or('\u{FFFD}').to_string().into_bytes());
                i += 6;
            } else if rest[0] == b'\\' && rest.len() > 1 && b"/\\\"".contains(&rest[1]) {
                next.push(rest[1]);
                i += 2;
            } else if rest[0] == b'&' && let Some(end) = rest.iter().take(12).position(|b| *b == b';') {
                let name = std::str::from_utf8(&rest[1..end]).unwrap_or("");
                let value = match name {
                    "amp" => Some(u32::from(b'&')),
                    "sol" => Some(u32::from(b'/')),
                    _ if name.starts_with("#x") || name.starts_with("#X") => u32::from_str_radix(&name[2..], 16).ok(),
                    _ if name.starts_with('#') => name[1..].parse().ok(),
                    _ => None,
                };
                match value.and_then(char::from_u32) {
                    Some(c) => {
                        next.extend(c.to_string().into_bytes());
                        i += end + 1;
                    }
                    None => {
                        next.push(rest[0]);
                        i += 1;
                    }
                }
            } else if rest[0] == 0 {
                i += 1;
            } else {
                next.push(rest[0]);
                i += 1;
            }
        }
        if next == current {
            break;
        }
        current = next;
    }
    current
}

/// Whether the credential is in `text` under any decoding the test knows: as it is after the decoders, or as the bytes
/// of a base64 run (line breaks taken out) at any of the four character offsets. A short credential counts as a whole
/// token, and in base64 as a whole run.
fn holds(text: &[u8], secret: &str) -> bool {
    let mut forms = vec![secret.to_owned()];
    if secret.contains(' ') {
        forms.push(secret.replace(' ', "+"));
    }
    if secret.contains('+') && !secret.starts_with('+') && !secret.ends_with('+') {
        forms.push(secret.replace('+', " "));
    }
    forms.iter().any(|form| holds_form(text, form))
}

fn holds_form(text: &[u8], secret: &str) -> bool {
    let plain = decoded(text);
    let n = secret.len();
    let whole = n < WHOLE_TOKEN_BELOW;
    let contains = |hay: &[u8]| {
        hay.windows(n).enumerate().any(|(at, w)| {
            w == secret.as_bytes() && (!whole || ((at == 0 || !is_word(hay[at - 1])) && hay.get(at + n).is_none_or(|b| !is_word(*b))))
        })
    };
    if contains(&plain) {
        return true;
    }
    let joined: Vec<u8> = plain.iter().copied().filter(|b| *b != b'\r' && *b != b'\n').collect();
    joined.split(|b| !is_base64(*b)).any(|run| {
        if whole {
            return [STANDARD_NO_PAD, URL_SAFE_NO_PAD].iter().any(|engine| engine.decode(run).is_ok_and(|bytes| bytes == secret.as_bytes()));
        }
        (0..4.min(run.len())).any(|skip| {
            let run: Vec<u8> = run[skip..].iter().map(|b| match b {
                b'-' => b'+',
                b'_' => b'/',
                other => *other,
            }).collect();
            let usable = run.len() / 4 * 4 + if run.len() % 4 >= 2 { run.len() % 4 } else { 0 };
            STANDARD_NO_PAD.decode(&run[..usable]).is_ok_and(|bytes| contains(&bytes))
        })
    })
}

fn words(rng: &mut Rng) -> String {
    const WORDS: [&str; 10] = ["hello", "%41%42", "&amp;", "\\u0041", "a\\/b", "QUJD", "x=y&z", "data:", "refused", "\u{e9}t\u{e9}"];
    (0..1 + rng.below(4)).map(|_| WORDS[rng.below(WORDS.len())]).collect::<Vec<_>>().join(" ")
}

/// Random credentials under random compositions of the encodings (up to three layers on top of an optional base64): the
/// scrubbed text holds the credential under no decoding the test knows; a text that holds another credential comes back
/// byte for byte.
#[test]
fn generated_encodings_never_leave_the_credential_and_never_touch_other_text() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for round in 0..3000 {
        let secret = credential(&mut rng);
        let scrub = matcher(&[&secret]);
        let (form, layers) = encoded(&mut rng, &secret);
        let text = [words(&mut rng).as_bytes(), b" ", &form, b" ", words(&mut rng).as_bytes()].concat();
        let clean = scrub.redact(&text, Context::default(), true).out;
        assert!(!holds(&clean, &secret), "round {round}: {secret:?} under {layers:?} left in {:?}", String::from_utf8_lossy(&clean));
        let other = credential(&mut rng);
        let (form, _) = encoded(&mut rng, &other);
        let text = [words(&mut rng).as_bytes(), b" ", &form, b" ", words(&mut rng).as_bytes()].concat();
        if !holds(&text, &secret) {
            assert_eq!(scrub.redacted(&text), None, "round {round}: {secret:?} found in {:?}", String::from_utf8_lossy(&text));
        }
    }
}

/// The cost on a streaming path: 1 MiB of event stream in 16 KiB chunks, five credentials, one pass per chunk with the
/// automaton built once. The figures are printed (`--nocapture`); the text, holding none of them, arrives unchanged.
#[test]
fn a_megabyte_stream_with_five_credentials() {
    let credentials: Vec<String> = (0..5).map(|i| format!("credential-{i}-7f3a9c1d2e4b6a80")).collect();
    let scrub = Arc::new(Matcher::new(&credentials));
    let event = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"the quick brown fox \\u00e9 jumps\"}}\n\n";
    let text: Vec<u8> = event.as_bytes().iter().copied().cycle().take(1 << 20).collect();
    let started = std::time::Instant::now();
    let mut stream = Stream::new(scrub);
    let mut out = Vec::with_capacity(text.len());
    let chunks = text.chunks(16 * 1024);
    let count = chunks.len();
    for chunk in chunks {
        out.extend(stream.push(chunk));
    }
    out.extend(stream.finish());
    let spent = started.elapsed();
    assert!(out == text, "the stream holds no credential");
    println!("1 MiB in {count} chunks, five credentials: {spent:?} in all, {:?} per chunk", spent / count as u32);
}

// ---- the registry ------------------------------------------------------------------------------------------------------

fn shared(cap: usize) -> Arc<std::sync::RwLock<Registry>> {
    Arc::new(std::sync::RwLock::new(Registry::new(cap)))
}

/// What a slot holds now is pinned: however many values are retired after them, a static key and the current token of
/// every account stay. Over the cap the oldest retired value goes first, and a value a slot holds again is pinned again.
#[test]
fn the_registry_drops_only_the_oldest_retired_values_over_its_cap() {
    let mut registry = Registry::new(4);
    registry.keep("https://static.test x-api-key", &["static-key-0001"]);
    registry.keep("account a", &["access-a-0", "refresh-a-0"]);
    for i in 1..=3 {
        registry.keep("account b", &[&format!("access-b-{i}")]);
    }
    // The refresh keeps the refresh token: only the access token retires.
    registry.keep("account a", &["access-a-1", "refresh-a-0"]);
    for i in 4..=6 {
        registry.keep("account b", &[&format!("access-b-{i}")]);
    }
    // Retired in turn: b-1, b-2, a-0, b-3, b-4, b-5; the cap keeps the last four.
    assert_eq!(registry.counts(), (4, 4));
    for gone in ["access-b-1", "access-b-2"] {
        assert!(!registry.holds(gone), "{gone}");
    }
    for kept in ["static-key-0001", "refresh-a-0", "access-a-1", "access-b-6", "access-a-0", "access-b-3", "access-b-4", "access-b-5"] {
        assert!(registry.holds(kept), "{kept}");
    }
    registry.keep("account c", &["access-a-0"]);
    assert_eq!(registry.counts(), (5, 3), "a retired value held again is pinned again");
    let scrub = Matcher::of_registry(Arc::new(std::sync::RwLock::new(registry)));
    assert_eq!(scrub.redact_str("key static-key-0001 and access-b-3, not access-b-1"), "key [REDACTED] and [REDACTED], not access-b-1");
}

/// A credential the registry holds is found in the text of any later exchange, in any encoding, the retired one of a
/// refreshed token included.
#[test]
fn the_registry_finds_an_old_credential_in_any_encoding() {
    let registry = shared(RETIRED_CAP);
    registry.write().unwrap().keep("account", &["old-credential-of-a-refreshed-token", "key/with+chars-77aa"]);
    registry.write().unwrap().keep("account", &["the-new-credential-of-the-token"]);
    let scrub = Matcher::of_registry(registry);
    assert_eq!(scrub.redact_str("previous value old-credential-of-a-refreshed-token"), "previous value [REDACTED]");
    assert_eq!(scrub.redact_str("key%2Fwith%2Bchars-77aa and key&#47;with&#43;chars-77aa"), "[REDACTED] and [REDACTED]");
    assert_eq!(scrub.redacted(b"nothing of the kind"), None);
}

/// A credential at least this long: one a random text of the generated test does not hold by chance.
fn long_credential(rng: &mut Rng) -> String {
    loop {
        let drawn = credential(rng);
        if drawn.len() >= 12 {
            return drawn;
        }
    }
}

/// The registry changes under a stream: each round registers a random credential after its stream began (its first chunk
/// ends before the credential's encoding does), the rest arriving in random chunks, and none of its encodings leaves. The
/// registry holds 2,000 more values besides, far over the old cap of 512, the oldest retired first; a random one of them
/// (the oldest every tenth round) under random encodings is found as well.
#[test]
fn generated_encodings_registered_mid_stream_or_long_ago_never_leave() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    let registry = shared(RETIRED_CAP);
    let others: Vec<String> = (0..2000).map(|_| long_credential(&mut rng)).collect();
    for other in &others {
        registry.write().unwrap().keep("one account refreshed 2,000 times", &[other]);
    }
    let scrub = Arc::new(Matcher::of_registry(registry.clone()));
    for round in 0..1000 {
        let secret = credential(&mut rng);
        let (form, layers) = encoded(&mut rng, &secret);
        let head = words(&mut rng);
        let text = [head.as_bytes(), b" ", &form, b" ", words(&mut rng).as_bytes()].concat();
        let mut stream = Stream::new(scrub.clone());
        let mut at = rng.below(head.len() + 1);
        let mut clean = stream.push(&text[..at]);
        registry.write().unwrap().keep("the account of the round", &[&secret]);
        while at < text.len() {
            let len = 1 + rng.below(text.len() - at);
            clean.extend(stream.push(&text[at..at + len]));
            at += len;
        }
        clean.extend(stream.finish());
        assert!(!holds(&clean, &secret), "round {round}: {secret:?} under {layers:?} left in {:?}", String::from_utf8_lossy(&clean));
        let member = &others[if round % 10 == 0 { 0 } else { rng.below(others.len()) }];
        let (form, layers) = encoded(&mut rng, member);
        let text = [words(&mut rng).as_bytes(), b" ", &form, b" ", words(&mut rng).as_bytes()].concat();
        let clean = scrub.redact(&text, Context::default(), true).out;
        assert!(!holds(&clean, member), "round {round}: {member:?} under {layers:?} left in {:?}", String::from_utf8_lossy(&clean));
    }
}

/// The cost of knowing many credentials: 512 and 10,000 JWT-sized values (1.2 KiB, the most an access token takes), each
/// registered as the refresh of one account that retires the one before; one more value (what a send does before it is
/// dispatched) touches the entries of its own 28 forms whatever the registry holds; the index's size; one pass of a 1 MiB
/// stream in 16 KiB chunks. The figures are printed (`--nocapture`); the stream, holding none of them, arrives unchanged,
/// and the first value registered is still found.
#[test]
fn registries_of_512_and_10000_jwt_sized_values() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    const URL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut part = |len: usize| -> String { (0..len).map(|_| char::from(URL[rng.below(URL.len())])).collect() };
    let values: Vec<String> = (0..10_000).map(|_| format!("eyJ{}.{}.{}", part(36), part(800), part(340))).collect();
    let event = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"the quick brown fox \\u00e9 jumps\"}}\n\n";
    let text: Vec<u8> = event.as_bytes().iter().copied().cycle().take(1 << 20).collect();
    for count in [512, 10_000] {
        let registry = shared(RETIRED_CAP);
        let started = std::time::Instant::now();
        for value in &values[..count - 1] {
            registry.write().unwrap().keep("an account", &[value]);
        }
        let filled = started.elapsed();
        let before = touched();
        let started = std::time::Instant::now();
        registry.write().unwrap().keep("an account", &[&values[count - 1]]);
        let one_more = started.elapsed();
        let entries = touched() - before;
        assert_eq!(entries, 28, "one JWT: itself and its three segments, each raw and as six base64 cores");
        let footprint = registry.read().unwrap().footprint();
        let scrub = Arc::new(Matcher::of_registry(registry.clone()));
        let started = std::time::Instant::now();
        let mut stream = Stream::new(scrub.clone());
        let mut out = Vec::with_capacity(text.len());
        for chunk in text.chunks(16 * 1024) {
            out.extend(stream.push(chunk));
        }
        out.extend(stream.finish());
        let scanned = started.elapsed();
        assert!(out == text, "the stream holds no credential");
        assert_eq!(scrub.redact_str(&format!("echo {} end", values[0])), "echo [REDACTED] end");
        println!(
            "{count} JWT-sized values: registered one by one in {filled:?} ({:?} each), one more {one_more:?} touching {entries} entries, index ~{} MiB ({} bytes a value), 1 MiB in 64 chunks {scanned:?}",
            filled / (count as u32 - 1),
            footprint >> 20,
            footprint / count
        );
    }
}
