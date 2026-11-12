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
    ];
    let scrub = matcher(&[KEY]);
    for form in forms {
        let text = [b"refused ".as_slice(), &form, b" for this account"].concat();
        let clean = scrub.redacted(&text).unwrap_or_else(|| panic!("{} passed", String::from_utf8_lossy(&form)));
        assert_eq!(String::from_utf8_lossy(&clean), "refused [REDACTED] for this account", "{}", String::from_utf8_lossy(&form));
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

/// A credential: printable ASCII with no escape introducer (`%`, `\`, `&`) and no blank.
fn credential(rng: &mut Rng) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_./+=:~!*'()<>\"#$,;?@[]^`{|}";
    let len = 1 + rng.below(40);
    (0..len).map(|_| char::from(ALPHABET[rng.below(ALPHABET.len())])).collect()
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
            [("percent", percent_layer as fn(&mut Rng, &[u8]) -> Vec<u8>), ("json", json_layer), ("html", html_layer), ("utf16", utf16_layer)][rng.below(4)];
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
            if rest[0] == b'%' && let (Some(h), Some(l)) = (hex_at(1), hex_at(2)) {
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
