//! The live view's wire contract with a paired phone (`apps/desktop/src/shared/remote-webrtc.ts`,
//! version 1): the signals both ends exchange over the E2EE relay, the messages on the
//! `mixdog-input` data channel, and the validators that decide what a phone may say. Every check,
//! its order and its error text are Node's (`tests/live_view_signals.rs` replays the recorded
//! outcomes), so a malformed message is refused with the same words and a message that passes
//! carries the same normalized fields.
//!
//! Numbers are JSON numbers read as doubles, as JavaScript reads them; lengths count UTF-16
//! units.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::config::Candidate;
use super::config::IceServer;
use super::config::MAX_ICE_SERVERS;
use super::config::MAX_ICE_URLS;
use super::config::RemoteCertificate;

pub const VERSION: u64 = 1;
/// The encrypted push carrying a [`DesktopSignal`] to one phone.
pub const SIGNAL_EVENT: &str = "browserRemoteWebrtc";
/// The client-bound call carrying a [`ClientSignal`].
pub const SIGNAL_METHOD: &str = "browserRemoteWebrtcSignal";
/// Direct first, TURN as the fallback: every candidate type is tried.
pub const ICE_TRANSPORT_POLICY: &str = "all";

const MAX_SDP_LENGTH: usize = 65_536;
const MAX_CANDIDATE_LENGTH: usize = 1_024;
const MAX_ICE_TEXT: usize = 512;
const MAX_CODECS: usize = 32;
const MAX_REASON_DETAIL: usize = 200;
const MAX_PIXEL_DIMENSION: f64 = 4_096.0;
const MIN_CSS_DIMENSION: f64 = 200.0;
const MAX_CSS_DIMENSION: f64 = 3_840.0;
const MIN_SCALE: f64 = 0.5;
const MAX_SCALE: f64 = 4.0;
const MAX_PAGE_CSS_DIMENSION: f64 = 16_384.0;
const MAX_PAGE_SCALE: f64 = 32.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
/// Text a remote page input may carry (`MAX_REMOTE_BROWSER_TEXT`).
const MAX_REMOTE_BROWSER_TEXT: usize = 2_000;

/// A refused message: Node's `TypeError` text.
pub type Refusal = String;

fn fail<T>(what: &str) -> Result<T, Refusal> {
    Err(format!("remote webrtc {what} is invalid."))
}

// ---- JavaScript value semantics ------------------------------------------------------------------

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `\s` of a JavaScript regular expression.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

const JS_SPACE_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `Number.isSafeInteger` of a JSON value.
fn safe_integer(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER).then_some(number)
}

/// A JSON number that is a number (never a string), as `typeof value === 'number'` and finite.
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

/// A number as a JSON value: an integral one is written as an integer, as `JSON.stringify` does.
pub fn num_json(number: f64) -> Value {
    num(number)
}

fn num(number: f64) -> Value {
    if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER {
        json!(number as i64)
    } else {
        json!(number)
    }
}

/// `String(value)`.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

// ---- field readers (Node's `record`, `positiveInteger`, ...) --------------------------------------

type Fields = Map<String, Value>;

fn record<'a>(value: &'a Value, what: &str) -> Result<&'a Fields, Refusal> {
    match value {
        Value::Object(fields) => Ok(fields),
        _ => fail(what),
    }
}

fn field<'a>(input: &'a Fields, name: &str) -> &'a Value {
    static ABSENT: Value = Value::Null;
    // Absent and null differ only where Node tells `undefined` from `null`; those sites use `input.get`.
    input.get(name).unwrap_or(&ABSENT)
}

fn positive_integer(value: &Value, what: &str) -> Result<u64, Refusal> {
    match safe_integer(value) {
        Some(n) if n >= 1.0 => Ok(n as u64),
        _ => fail(what),
    }
}

fn bounded_number(value: &Value, min: f64, max: f64, what: &str) -> Result<f64, Refusal> {
    match finite(value) {
        Some(n) if n >= min && n <= max => Ok(n),
        _ => fail(what),
    }
}

fn bounded_integer(value: &Value, min: f64, max: f64, what: &str) -> Result<u64, Refusal> {
    if safe_integer(value).is_none() {
        return fail(what);
    }
    bounded_number(value, min, max, what).map(|n| n as u64)
}

fn bounded_text(value: &Value, max: usize, what: &str) -> Result<String, Refusal> {
    match value {
        Value::String(text) if utf16_len(text) <= max => Ok(text.clone()),
        _ => fail(what),
    }
}

static OPAQUE_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,256}$").expect("opaque id"));
static CONNECTION_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{16,64}$").expect("connection id"));
static DOCUMENT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^p[1-9][0-9]*:[0-9]+$").expect("document id"));
static PAGE_DOCUMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^p[0-9]+:[0-9]+$").expect("page document"));
static CODEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^video/[A-Za-z0-9.+-]{1,32}$").expect("codec"));
static ICE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^(?:stuns?|turns?):[^{JS_SPACE_CLASS}]+$")).expect("ice url"));
static FINGERPRINT_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"^a=fingerprint:([^{JS_SPACE_CLASS}]+) ([^{JS_SPACE_CLASS}]+)[{JS_SPACE_CLASS}]*$")).expect("fingerprint line")
});
static MDNS_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,4}local$").expect("mdns name")
});

fn opaque_id(value: &Value, what: &str) -> Result<String, Refusal> {
    match value {
        Value::String(text) if OPAQUE_ID.is_match(text) => Ok(text.clone()),
        _ => fail(what),
    }
}

// ---- identity and geometry ----------------------------------------------------------------------

/// What is streamed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Browser { session_id: String },
    Screen { screen_id: String },
}

impl Source {
    /// One key per source, for maps keyed by viewer.
    pub fn key(&self) -> String {
        match self {
            Self::Browser { session_id } => format!("browser:{session_id}"),
            Self::Screen { screen_id } => format!("screen:{screen_id}"),
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Browser { session_id } => Some(session_id),
            Self::Screen { .. } => None,
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Browser { session_id } => json!({ "kind": "browser", "sessionId": session_id }),
            Self::Screen { screen_id } => json!({ "kind": "screen", "screenId": screen_id }),
        }
    }

    pub fn parse(value: &Value) -> Result<Self, Refusal> {
        let input = record(value, "source")?;
        match field(input, "kind").as_str() {
            Some("browser") => Ok(Self::Browser { session_id: opaque_id(field(input, "sessionId"), "session id")? }),
            Some("screen") => Ok(Self::Screen { screen_id: opaque_id(field(input, "screenId"), "screen id")? }),
            _ => fail("source"),
        }
    }
}

/// Every message of one peer connection carries it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectionRef {
    pub source: Source,
    pub connection_id: String,
    pub generation: u64,
}

impl ConnectionRef {
    fn put(&self, into: &mut Fields) {
        into.insert("v".into(), json!(VERSION));
        into.insert("source".into(), self.source.to_json());
        into.insert("connectionId".into(), json!(self.connection_id));
        into.insert("generation".into(), json!(self.generation));
    }
}

fn source_ref(input: &Fields) -> Result<Source, Refusal> {
    if safe_integer(field(input, "v")) != Some(VERSION as f64) {
        return fail("version");
    }
    Source::parse(field(input, "source"))
}

fn connection_id(value: &Value) -> Result<String, Refusal> {
    match value {
        Value::String(text) if CONNECTION_ID.is_match(text) => Ok(text.clone()),
        _ => fail("connection id"),
    }
}

fn connection_ref(input: &Fields) -> Result<ConnectionRef, Refusal> {
    let source = source_ref(input)?;
    let connection_id = connection_id(field(input, "connectionId"))?;
    let generation = positive_integer(field(input, "generation"), "generation")?;
    Ok(ConnectionRef { source, connection_id, generation })
}

/// The page geometry main locks when a source's stream starts.
#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    pub generation: u64,
    pub css_width: u64,
    pub css_height: u64,
    pub device_scale_factor: f64,
    pub pixel_width: u64,
    pub pixel_height: u64,
}

impl Geometry {
    pub fn to_json(&self) -> Value {
        json!({
            "generation": self.generation,
            "cssWidth": self.css_width,
            "cssHeight": self.css_height,
            "deviceScaleFactor": num(self.device_scale_factor),
            "pixelWidth": self.pixel_width,
            "pixelHeight": self.pixel_height,
        })
    }

    pub fn parse(value: &Value) -> Result<Self, Refusal> {
        let input = record(value, "geometry")?;
        let scale = bounded_number(field(input, "deviceScaleFactor"), 0.0, MAX_PAGE_SCALE, "geometry scale")?;
        if scale == 0.0 {
            return fail("geometry scale");
        }
        Ok(Self {
            generation: positive_integer(field(input, "generation"), "geometry generation")?,
            css_width: bounded_integer(field(input, "cssWidth"), 1.0, MAX_PAGE_CSS_DIMENSION, "geometry width")?,
            css_height: bounded_integer(field(input, "cssHeight"), 1.0, MAX_PAGE_CSS_DIMENSION, "geometry height")?,
            device_scale_factor: scale,
            pixel_width: even_pixels(field(input, "pixelWidth"), "geometry pixel width")?,
            pixel_height: even_pixels(field(input, "pixelHeight"), "geometry pixel height")?,
        })
    }
}

fn even_pixels(value: &Value, what: &str) -> Result<u64, Refusal> {
    let pixels = bounded_integer(value, 2.0, MAX_PIXEL_DIMENSION, what)?;
    if pixels % 2 != 0 {
        return fail(what);
    }
    Ok(pixels)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Resize {
    FitClient { css_width: u64, css_height: u64, device_scale_factor: f64 },
    Page,
}

impl Resize {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Page => json!({ "mode": "page" }),
            Self::FitClient { css_width, css_height, device_scale_factor } => json!({
                "mode": "fit-client",
                "cssWidth": css_width,
                "cssHeight": css_height,
                "deviceScaleFactor": num(*device_scale_factor),
            }),
        }
    }

    fn parse(value: &Value) -> Result<Self, Refusal> {
        let input = record(value, "resize")?;
        match field(input, "mode").as_str() {
            Some("page") => Ok(Self::Page),
            Some("fit-client") => Ok(Self::FitClient {
                css_width: bounded_integer(field(input, "cssWidth"), MIN_CSS_DIMENSION, MAX_CSS_DIMENSION, "resize width")?,
                css_height: bounded_integer(field(input, "cssHeight"), MIN_CSS_DIMENSION, MAX_CSS_DIMENSION, "resize height")?,
                device_scale_factor: bounded_number(field(input, "deviceScaleFactor"), MIN_SCALE, MAX_SCALE, "resize scale")?,
            }),
            _ => fail("resize mode"),
        }
    }
}

// ---- fingerprints, SDP, candidates ---------------------------------------------------------------

/// A DTLS certificate fingerprint as SDP `a=fingerprint` carries it: lower-case algorithm,
/// upper-case colon-separated hex.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub algorithm: String,
    pub value: String,
}

impl Fingerprint {
    pub fn to_json(&self) -> Value {
        json!({ "algorithm": self.algorithm, "value": self.value })
    }

    fn key(&self) -> String {
        format!("{} {}", self.algorithm, self.value)
    }

    pub fn parse(value: &Value) -> Result<Self, Refusal> {
        let input = record(value, "fingerprint")?;
        let algorithm = field(input, "algorithm").as_str().map(str::to_lowercase).unwrap_or_default();
        let bytes = match algorithm.as_str() {
            "sha-256" => 32,
            "sha-384" => 48,
            "sha-512" => 64,
            _ => return fail("fingerprint algorithm"),
        };
        let hex = field(input, "value").as_str().map(str::to_uppercase).unwrap_or_default();
        let shaped = hex.len() == bytes * 3 - 1
            && hex.bytes().enumerate().all(|(i, b)| if i % 3 == 2 { b == b':' } else { matches!(b, b'0'..=b'9' | b'A'..=b'F') });
        if !shaped {
            return fail("fingerprint value");
        }
        Ok(Self { algorithm, value: hex })
    }
}

fn fingerprints(value: &Value) -> Result<Vec<Fingerprint>, Refusal> {
    match value {
        Value::Array(items) if (1..=3).contains(&items.len()) => items.iter().map(Fingerprint::parse).collect(),
        _ => fail("fingerprints"),
    }
}

/// The `a=fingerprint` attributes of an SDP, session and media level, deduplicated.
pub fn sdp_fingerprints(sdp: &str) -> Result<Vec<Fingerprint>, Refusal> {
    let mut found: Vec<Fingerprint> = Vec::new();
    for line in sdp.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(captures) = FINGERPRINT_LINE.captures(line) else { continue };
        let entry = Fingerprint::parse(&json!({ "algorithm": &captures[1], "value": &captures[2] }))?;
        match found.iter_mut().find(|known| known.key() == entry.key()) {
            Some(known) => *known = entry,
            None => found.push(entry),
        }
    }
    Ok(found)
}

/// Fails unless the SDP names exactly the fingerprints sent beside it.
pub fn assert_sdp_fingerprints(sdp: &str, declared: &[Fingerprint]) -> Result<(), Refusal> {
    let in_sdp: Vec<String> = sdp_fingerprints(sdp)?.iter().map(Fingerprint::key).collect();
    let mut sent: Vec<String> = declared.iter().map(Fingerprint::key).collect();
    let mut seen = in_sdp.clone();
    sent.sort();
    sent.dedup();
    seen.sort();
    seen.dedup();
    if seen.is_empty() || seen.len() != sent.len() || sent.iter().any(|key| !seen.contains(key)) {
        return Err("remote webrtc fingerprint-mismatch: SDP and signaled fingerprints differ.".into());
    }
    Ok(())
}

/// The connected peer's certificate is one the E2EE channel delivered.
pub fn certificate_matches(declared: &[Fingerprint], certificate: &RemoteCertificate) -> bool {
    let value = json!({ "algorithm": certificate.fingerprint_algorithm, "value": certificate.fingerprint });
    Fingerprint::parse(&value).is_ok_and(|actual| declared.iter().any(|entry| entry.key() == actual.key()))
}

/// `certificate` as the sender reports it, any JSON: the match is false for anything that is not
/// a record of a known algorithm and a well-formed fingerprint.
pub fn certificate_value_matches(declared: &[Fingerprint], certificate: &Value) -> bool {
    let Ok(stats) = record(certificate, "certificate") else { return false };
    let value = json!({ "algorithm": stats.get("fingerprintAlgorithm"), "value": stats.get("fingerprint") });
    Fingerprint::parse(&value).is_ok_and(|actual| declared.iter().any(|entry| entry.key() == actual.key()))
}

/// An SDP blob as signaled: at most 64 KiB, starting `v=0`, never ice-lite.
pub(crate) fn parse_sdp(value: &Value) -> Result<String, Refusal> {
    let text = bounded_text(value, MAX_SDP_LENGTH, "sdp")?;
    if !text.starts_with("v=0") {
        return fail("sdp");
    }
    // `/^a=ice-lite\b/mu`: a line start follows \n, \r, U+2028 and U+2029.
    let ice_lite = text.split(['\n', '\r', '\u{2028}', '\u{2029}']).any(|line| {
        line.strip_prefix("a=ice-lite")
            .is_some_and(|rest| !rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'))
    });
    if ice_lite {
        return fail("sdp ice-lite");
    }
    Ok(text)
}

fn ipv4_address(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| (1..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()) && part.parse::<u32>().is_ok_and(|n| n <= 255))
}

fn ipv6_address(text: &str) -> bool {
    if !(2..=45).contains(&text.len()) || !text.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.') {
        return false;
    }
    let tail = &text[text.rfind(':').map_or(0, |i| i + 1)..];
    let embedded = tail.contains('.');
    if embedded && !ipv4_address(tail) {
        return false;
    }
    let hex = if embedded { format!("{}0:0", &text[..text.len() - tail.len()]) } else { text.to_owned() };
    let halves: Vec<&str> = hex.split("::").collect();
    if halves.len() > 2 {
        return false;
    }
    let groups: Vec<&str> = halves.iter().flat_map(|half| if half.is_empty() { Vec::new() } else { half.split(':').collect() }).collect();
    if !groups.iter().all(|group| (1..=4).contains(&group.len()) && group.bytes().all(|b| b.is_ascii_hexdigit())) {
        return false;
    }
    if halves.len() == 2 { groups.len() < 8 } else { groups.len() == 8 }
}

fn candidate_address(text: &str) -> bool {
    ipv4_address(text) || ipv6_address(text) || MDNS_NAME.is_match(text)
}

fn digits(text: &str, max_len: usize) -> Option<u64> {
    ((1..=max_len).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())).then(|| text.parse().ok()).flatten()
}

fn no_space(token: &str) -> bool {
    !token.is_empty() && !token.chars().any(js_space)
}

/// Whether `line` is one well-formed RFC 8839 candidate attribute value of type host, srflx,
/// prflx or relay: component 1-256, 32-bit priority, an IPv4/IPv6 address or mDNS `.local`
/// name, ports up to 65535, `tcptype` exactly on TCP. The empty end-of-candidates line is not
/// a candidate line.
pub fn is_candidate_line(line: &str) -> bool {
    let tokens: Vec<&str> = line.split(' ').collect();
    let Some(foundation) = tokens
        .first()
        .and_then(|t| t.get(..10).filter(|head| head.eq_ignore_ascii_case("candidate:")).map(|_| &t[10..]))
    else {
        return false;
    };
    if tokens.len() < 8 || !(1..=32).contains(&foundation.len()) || !foundation.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/') {
        return false;
    }
    let (Some(component), Some(priority), Some(port)) = (digits(tokens[1], 3), digits(tokens[3], 10), digits(tokens[5], 5)) else {
        return false;
    };
    let transport = tokens[2];
    if !(transport.eq_ignore_ascii_case("udp") || transport.eq_ignore_ascii_case("tcp")) {
        return false;
    }
    let address = tokens[4];
    if !no_space(address) || !tokens[6].eq_ignore_ascii_case("typ") {
        return false;
    }
    if !["host", "srflx", "prflx", "relay"].iter().any(|kind| tokens[7].eq_ignore_ascii_case(kind)) {
        return false;
    }
    let mut at = 8;
    let mut related = None;
    if tokens.get(at).is_some_and(|t| t.eq_ignore_ascii_case("raddr")) {
        let (Some(related_address), Some(rport)) = (tokens.get(at + 1), tokens.get(at + 2).zip(tokens.get(at + 3)).filter(|(name, _)| name.eq_ignore_ascii_case("rport")).and_then(|(_, p)| digits(p, 5))) else {
            return false;
        };
        if !no_space(related_address) {
            return false;
        }
        related = Some((*related_address, rport));
        at += 4;
    }
    let extensions = &tokens[at..];
    if extensions.len() % 2 != 0 {
        return false;
    }
    let mut tcp_types: Vec<String> = Vec::new();
    for pair in extensions.chunks(2) {
        let (name, value) = (pair[0], pair[1]);
        let name_ok = {
            let mut chars = name.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && name.len() <= 32
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        };
        let reserved = ["raddr", "rport", "typ"].iter().any(|word| name.eq_ignore_ascii_case(word));
        let value_ok = (1..=256).contains(&value.len()) && value.bytes().all(|b| (0x21..=0x7e).contains(&b));
        if !name_ok || reserved || !value_ok {
            return false;
        }
        if name.eq_ignore_ascii_case("tcptype") {
            tcp_types.push(value.to_lowercase());
        }
    }
    let tcp_fits = if transport.eq_ignore_ascii_case("tcp") {
        tcp_types.len() == 1 && ["active", "passive", "so"].contains(&tcp_types[0].as_str())
    } else {
        tcp_types.is_empty()
    };
    tcp_fits
        && (1..=256).contains(&component)
        && priority <= 0xffff_ffff
        && candidate_address(address)
        && port <= 65_535
        && related.is_none_or(|(related_address, rport)| candidate_address(related_address) && rport <= 65_535)
}

/// The `candidate` member of a signal: `null` is the end of all candidates, an absent member is
/// invalid.
fn candidate_member(input: &Fields) -> Result<Option<Candidate>, Refusal> {
    match input.get("candidate") {
        Some(value) => parse_candidate(value),
        None => fail("candidate"),
    }
}

/// A signaled `RTCIceCandidateInit`: `None` is the end of all candidates.
pub fn parse_candidate(value: &Value) -> Result<Option<Candidate>, Refusal> {
    if value.is_null() {
        return Ok(None);
    }
    let input = record(value, "candidate")?;
    let line = bounded_text(field(input, "candidate"), MAX_CANDIDATE_LENGTH, "candidate")?;
    if !line.is_empty() && !is_candidate_line(&line) {
        return fail("candidate");
    }
    let nullable = |name: &str| input.get(name).filter(|v| !v.is_null());
    let sdp_mid = nullable("sdpMid").map(|v| bounded_text(v, 32, "candidate mid")).transpose()?;
    let sdp_mline_index = nullable("sdpMLineIndex").map(|v| bounded_integer(v, 0.0, 255.0, "candidate line")).transpose()?;
    let username_fragment = nullable("usernameFragment").map(|v| bounded_text(v, 256, "candidate ufrag")).transpose()?;
    if sdp_mid.is_none() && sdp_mline_index.is_none() {
        return fail("candidate");
    }
    Ok(Some(Candidate { candidate: line, sdp_mid, sdp_mline_index: sdp_mline_index.map(|n| n as u16), username_fragment }))
}

pub fn candidate_json(candidate: &Option<Candidate>) -> Value {
    match candidate {
        None => Value::Null,
        Some(c) => json!({
            "candidate": c.candidate,
            "sdpMid": c.sdp_mid,
            "sdpMLineIndex": c.sdp_mline_index,
            "usernameFragment": c.username_fragment,
        }),
    }
}

/// A signaled ICE server list (empty allowed, at most [`MAX_ICE_SERVERS`]).
pub fn parse_ice_servers(value: &Value) -> Result<Vec<IceServer>, Refusal> {
    let Value::Array(items) = value else { return fail("ice servers") };
    if items.len() > MAX_ICE_SERVERS {
        return fail("ice servers");
    }
    items
        .iter()
        .map(|entry| {
            let input = record(entry, "ice server")?;
            let urls: Vec<Value> = match input.get("urls") {
                Some(Value::Array(urls)) => urls.clone(),
                Some(other) => vec![other.clone()],
                None => vec![Value::Null],
            };
            if urls.is_empty() || urls.len() > MAX_ICE_URLS {
                return fail("ice server urls");
            }
            let urls = urls
                .iter()
                .map(|url| {
                    let text = bounded_text(url, MAX_ICE_TEXT, "ice server url")?;
                    if !ICE_URL.is_match(&text) {
                        return fail("ice server url");
                    }
                    Ok(text)
                })
                .collect::<Result<Vec<_>, _>>()?;
            let username = input.get("username").map(|v| bounded_text(v, MAX_ICE_TEXT, "ice username")).transpose()?;
            let credential = input.get("credential").map(|v| bounded_text(v, MAX_ICE_TEXT, "ice credential")).transpose()?;
            Ok(IceServer { urls, username, credential })
        })
        .collect()
}

pub fn ice_servers_json(servers: &[IceServer]) -> Value {
    Value::Array(
        servers
            .iter()
            .map(|server| {
                let mut out = Map::new();
                out.insert("urls".into(), json!(server.urls));
                if let Some(username) = &server.username {
                    out.insert("username".into(), json!(username));
                }
                if let Some(credential) = &server.credential {
                    out.insert("credential".into(), json!(credential));
                }
                Value::Object(out)
            })
            .collect(),
    )
}

// ---- transport state machine -----------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportState {
    Relay,
    Negotiating,
    Connected,
    Promoting,
    Webrtc,
    Demoting,
    Cooldown,
    Closed,
}

impl TransportState {
    pub const ALL: [Self; 8] = [
        Self::Relay,
        Self::Negotiating,
        Self::Connected,
        Self::Promoting,
        Self::Webrtc,
        Self::Demoting,
        Self::Cooldown,
        Self::Closed,
    ];

    pub const fn name(self) -> &'static str {
        match self {
            Self::Relay => "relay",
            Self::Negotiating => "negotiating",
            Self::Connected => "connected",
            Self::Promoting => "promoting",
            Self::Webrtc => "webrtc",
            Self::Demoting => "demoting",
            Self::Cooldown => "cooldown",
            Self::Closed => "closed",
        }
    }

    pub fn transitions(self) -> &'static [Self] {
        use TransportState::*;
        match self {
            Relay => &[Negotiating, Closed],
            Negotiating => &[Connected, Cooldown, Closed],
            Connected => &[Promoting, Cooldown, Closed],
            Promoting => &[Webrtc, Demoting, Closed],
            Webrtc => &[Demoting, Closed],
            Demoting => &[Cooldown, Closed],
            Cooldown => &[Negotiating, Relay, Closed],
            Closed => &[],
        }
    }

    pub fn can_move_to(self, to: Self) -> bool {
        self.transitions().contains(&to)
    }

    /// JPEG frames are produced in every live state but `webrtc`.
    pub fn jpeg_active(self) -> bool {
        !matches!(self, Self::Webrtc | Self::Closed)
    }

    /// Which path's page input is dispatched; none while a barrier is open past the point of no
    /// return (`demoting`) or after close.
    pub fn input_owner(self) -> Option<&'static str> {
        match self {
            Self::Webrtc => Some("channel"),
            Self::Demoting | Self::Closed => None,
            _ => Some("relay"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    ViewerLeft,
    Superseded,
    Unsupported,
    TurnUnavailable,
    NegotiationTimeout,
    IceFailed,
    DtlsFailed,
    FingerprintMismatch,
    MediaTimeout,
    ChannelFailed,
    SenderFailed,
    Unauthorized,
    ProtocolError,
}

impl CloseReason {
    const ALL: [Self; 13] = [
        Self::ViewerLeft,
        Self::Superseded,
        Self::Unsupported,
        Self::TurnUnavailable,
        Self::NegotiationTimeout,
        Self::IceFailed,
        Self::DtlsFailed,
        Self::FingerprintMismatch,
        Self::MediaTimeout,
        Self::ChannelFailed,
        Self::SenderFailed,
        Self::Unauthorized,
        Self::ProtocolError,
    ];

    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::ViewerLeft => "viewer-left",
            Self::Superseded => "superseded",
            Self::Unsupported => "unsupported",
            Self::TurnUnavailable => "turn-unavailable",
            Self::NegotiationTimeout => "negotiation-timeout",
            Self::IceFailed => "ice-failed",
            Self::DtlsFailed => "dtls-failed",
            Self::FingerprintMismatch => "fingerprint-mismatch",
            Self::MediaTimeout => "media-timeout",
            Self::ChannelFailed => "channel-failed",
            Self::SenderFailed => "sender-failed",
            Self::Unauthorized => "unauthorized",
            Self::ProtocolError => "protocol-error",
        }
    }

    pub fn from_wire(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.wire_name() == name)
    }

    fn parse(value: &Value) -> Result<Self, Refusal> {
        value.as_str().and_then(Self::from_wire).map_or_else(|| fail("close reason"), Ok)
    }
}

// ---- signals ---------------------------------------------------------------------------------

/// The largest video the phone wants, in device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoLimit {
    pub max_width: u64,
    pub max_height: u64,
}

/// A phone's signal, as the service receives it from the relay.
#[derive(Clone, Debug, PartialEq)]
pub enum ClientSignal {
    Ready { source: Source, receive_codecs: Vec<String>, video_limit: Option<VideoLimit> },
    GeometryAck { source: Source, geometry_generation: u64 },
    ResizeRequest { source: Source, resize: Resize },
    Answer { connection: ConnectionRef, sdp: String, fingerprints: Vec<Fingerprint> },
    Candidate { connection: ConnectionRef, candidate: Option<Candidate> },
    MediaReady { connection: ConnectionRef, document_id: Option<String>, geometry_generation: u64, pixel_width: u64, pixel_height: u64 },
    PromoteAck { connection: ConnectionRef, input_epoch: u64 },
    DemoteAck { connection: ConnectionRef, input_epoch: u64 },
    Close { connection: ConnectionRef, reason: CloseReason, detail: Option<String> },
}

impl ClientSignal {
    pub fn source(&self) -> &Source {
        match self {
            Self::Ready { source, .. } | Self::GeometryAck { source, .. } | Self::ResizeRequest { source, .. } => source,
            Self::Answer { connection, .. }
            | Self::Candidate { connection, .. }
            | Self::MediaReady { connection, .. }
            | Self::PromoteAck { connection, .. }
            | Self::DemoteAck { connection, .. }
            | Self::Close { connection, .. } => &connection.source,
        }
    }

    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::Ready { .. } => "ready",
            Self::GeometryAck { .. } => "geometry-ack",
            Self::ResizeRequest { .. } => "resize-request",
            Self::Answer { .. } => "answer",
            Self::Candidate { .. } => "candidate",
            Self::MediaReady { .. } => "media-ready",
            Self::PromoteAck { .. } => "promote-ack",
            Self::DemoteAck { .. } => "demote-ack",
            Self::Close { .. } => "close",
        }
    }

    /// The signals whose order against relay input matters: they must reach the viewer behind
    /// every relay call decoded before them.
    pub fn is_barrier(&self) -> bool {
        matches!(self, Self::PromoteAck { .. } | Self::DemoteAck { .. })
    }

    pub fn parse(value: &Value) -> Result<Self, Refusal> {
        let input = record(value, "signal")?;
        match field(input, "type").as_str() {
            Some("ready") => {
                let Value::Array(codecs) = field(input, "receiveCodecs") else { return fail("receive codecs") };
                if codecs.len() > MAX_CODECS {
                    return fail("receive codecs");
                }
                let receive_codecs = codecs
                    .iter()
                    .map(|codec| match codec {
                        Value::String(text) if CODEC.is_match(text) => Ok(text.clone()),
                        _ => fail("receive codec"),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let video_limit = match input.get("videoLimit") {
                    None => None,
                    Some(limit) => {
                        let limit = record(limit, "video limit")?;
                        Some(VideoLimit {
                            max_width: bounded_integer(field(limit, "maxWidth"), 64.0, MAX_PIXEL_DIMENSION, "video limit width")?,
                            max_height: bounded_integer(field(limit, "maxHeight"), 64.0, MAX_PIXEL_DIMENSION, "video limit height")?,
                        })
                    }
                };
                Ok(Self::Ready { source: source_ref(input)?, receive_codecs, video_limit })
            }
            Some("geometry-ack") => {
                let source = source_ref(input)?;
                Ok(Self::GeometryAck { source, geometry_generation: positive_integer(field(input, "geometryGeneration"), "geometry generation")? })
            }
            Some("resize-request") => {
                let source = source_ref(input)?;
                Ok(Self::ResizeRequest { source, resize: Resize::parse(field(input, "resize"))? })
            }
            Some("answer") => {
                let sdp = parse_sdp(field(input, "sdp"))?;
                let fingerprints = fingerprints(field(input, "fingerprints"))?;
                assert_sdp_fingerprints(&sdp, &fingerprints)?;
                Ok(Self::Answer { connection: connection_ref(input)?, sdp, fingerprints })
            }
            Some("candidate") => {
                let connection = connection_ref(input)?;
                Ok(Self::Candidate { connection, candidate: candidate_member(input)? })
            }
            Some("media-ready") => {
                let connection = connection_ref(input)?;
                let screen = matches!(connection.source, Source::Screen { .. });
                let document_id = if screen {
                    if field(input, "documentId").is_null() && input.contains_key("documentId") {
                        None
                    } else {
                        return fail("document id");
                    }
                } else {
                    match field(input, "documentId") {
                        Value::String(text) if utf16_len(text) <= 64 && DOCUMENT_ID.is_match(text) => Some(text.clone()),
                        _ => return fail("document id"),
                    }
                };
                Ok(Self::MediaReady {
                    connection,
                    document_id,
                    geometry_generation: positive_integer(field(input, "geometryGeneration"), "geometry generation")?,
                    pixel_width: even_pixels(field(input, "pixelWidth"), "media width")?,
                    pixel_height: even_pixels(field(input, "pixelHeight"), "media height")?,
                })
            }
            Some(kind @ ("promote-ack" | "demote-ack")) => {
                let connection = connection_ref(input)?;
                let input_epoch = positive_integer(field(input, "inputEpoch"), "input epoch")?;
                Ok(if kind == "promote-ack" { Self::PromoteAck { connection, input_epoch } } else { Self::DemoteAck { connection, input_epoch } })
            }
            Some("close") => {
                let connection = connection_ref(input)?;
                let reason = CloseReason::parse(field(input, "reason"))?;
                let detail = input.get("detail").map(|d| bounded_text(d, MAX_REASON_DETAIL, "close detail")).transpose()?;
                Ok(Self::Close { connection, reason, detail })
            }
            _ => fail("signal type"),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        let connection = |connection: &ConnectionRef, out: &mut Fields| connection.put(out);
        let source = |source: &Source, out: &mut Fields| {
            out.insert("v".into(), json!(VERSION));
            out.insert("source".into(), source.to_json());
        };
        out.insert("type".into(), json!(self.type_name()));
        match self {
            Self::Ready { source: s, receive_codecs, video_limit } => {
                source(s, &mut out);
                out.insert("receiveCodecs".into(), json!(receive_codecs));
                if let Some(limit) = video_limit {
                    out.insert("videoLimit".into(), json!({ "maxWidth": limit.max_width, "maxHeight": limit.max_height }));
                }
            }
            Self::GeometryAck { source: s, geometry_generation } => {
                source(s, &mut out);
                out.insert("geometryGeneration".into(), json!(geometry_generation));
            }
            Self::ResizeRequest { source: s, resize } => {
                source(s, &mut out);
                out.insert("resize".into(), resize.to_json());
            }
            Self::Answer { connection: c, sdp, fingerprints } => {
                connection(c, &mut out);
                out.insert("sdp".into(), json!(sdp));
                out.insert("fingerprints".into(), Value::Array(fingerprints.iter().map(Fingerprint::to_json).collect()));
            }
            Self::Candidate { connection: c, candidate } => {
                connection(c, &mut out);
                out.insert("candidate".into(), candidate_json(candidate));
            }
            Self::MediaReady { connection: c, document_id, geometry_generation, pixel_width, pixel_height } => {
                connection(c, &mut out);
                out.insert("documentId".into(), json!(document_id));
                out.insert("geometryGeneration".into(), json!(geometry_generation));
                out.insert("pixelWidth".into(), json!(pixel_width));
                out.insert("pixelHeight".into(), json!(pixel_height));
            }
            Self::PromoteAck { connection: c, input_epoch } | Self::DemoteAck { connection: c, input_epoch } => {
                connection(c, &mut out);
                out.insert("inputEpoch".into(), json!(input_epoch));
            }
            Self::Close { connection: c, reason, detail } => {
                connection(c, &mut out);
                out.insert("reason".into(), json!(reason.wire_name()));
                if let Some(detail) = detail {
                    out.insert("detail".into(), json!(detail));
                }
            }
        }
        Value::Object(out)
    }
}

/// The desktop's signal, as the phone receives it.
#[derive(Clone, Debug, PartialEq)]
pub enum DesktopSignal {
    Geometry { source: Source, geometry: Geometry },
    Offer {
        connection: ConnectionRef,
        sdp: String,
        fingerprints: Vec<Fingerprint>,
        ice_servers: Vec<IceServer>,
        ice_transport_policy: IceTransportPolicy,
        geometry: Geometry,
        input_epoch: u64,
    },
    Candidate { connection: ConnectionRef, candidate: Option<Candidate> },
    Promote { connection: ConnectionRef, input_epoch: u64, geometry_generation: u64 },
    Demote { connection: ConnectionRef, input_epoch: u64, reason: CloseReason },
    Close { connection: ConnectionRef, reason: CloseReason, retry_after_ms: Option<u64> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IceTransportPolicy {
    All,
    Relay,
}

impl IceTransportPolicy {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Relay => "relay",
        }
    }
}

impl DesktopSignal {
    pub fn source(&self) -> &Source {
        match self {
            Self::Geometry { source, .. } => source,
            Self::Offer { connection, .. }
            | Self::Candidate { connection, .. }
            | Self::Promote { connection, .. }
            | Self::Demote { connection, .. }
            | Self::Close { connection, .. } => &connection.source,
        }
    }

    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::Geometry { .. } => "geometry",
            Self::Offer { .. } => "offer",
            Self::Candidate { .. } => "candidate",
            Self::Promote { .. } => "promote",
            Self::Demote { .. } => "demote",
            Self::Close { .. } => "close",
        }
    }

    pub fn parse(value: &Value) -> Result<Self, Refusal> {
        let input = record(value, "signal")?;
        match field(input, "type").as_str() {
            Some("geometry") => {
                let source = source_ref(input)?;
                Ok(Self::Geometry { source, geometry: Geometry::parse(field(input, "geometry"))? })
            }
            Some("offer") => {
                let sdp = parse_sdp(field(input, "sdp"))?;
                let fingerprints = fingerprints(field(input, "fingerprints"))?;
                assert_sdp_fingerprints(&sdp, &fingerprints)?;
                let connection = connection_ref(input)?;
                let ice_servers = parse_ice_servers(field(input, "iceServers"))?;
                let ice_transport_policy = match field(input, "iceTransportPolicy").as_str() {
                    Some("all") => IceTransportPolicy::All,
                    Some("relay") => IceTransportPolicy::Relay,
                    _ => return fail("ice transport policy"),
                };
                let geometry = Geometry::parse(field(input, "geometry"))?;
                let input_epoch = positive_integer(field(input, "inputEpoch"), "input epoch")?;
                Ok(Self::Offer { connection, sdp, fingerprints, ice_servers, ice_transport_policy, geometry, input_epoch })
            }
            Some("candidate") => {
                let connection = connection_ref(input)?;
                Ok(Self::Candidate { connection, candidate: candidate_member(input)? })
            }
            Some("promote") => {
                let connection = connection_ref(input)?;
                let input_epoch = positive_integer(field(input, "inputEpoch"), "input epoch")?;
                Ok(Self::Promote { connection, input_epoch, geometry_generation: positive_integer(field(input, "geometryGeneration"), "geometry generation")? })
            }
            Some("demote") => {
                let connection = connection_ref(input)?;
                let input_epoch = positive_integer(field(input, "inputEpoch"), "input epoch")?;
                Ok(Self::Demote { connection, input_epoch, reason: CloseReason::parse(field(input, "reason"))? })
            }
            Some("close") => {
                let connection = connection_ref(input)?;
                let reason = CloseReason::parse(field(input, "reason"))?;
                let retry_after_ms = input
                    .get("retryAfterMs")
                    .map(|v| bounded_integer(v, 0.0, MAX_SAFE_INTEGER, "retry after"))
                    .transpose()?;
                Ok(Self::Close { connection, reason, retry_after_ms })
            }
            _ => fail("signal type"),
        }
    }

    /// In Node's field order (`parseRemoteWebrtcDesktopSignal`, `shared/remote-webrtc.ts:1171-1215`): the source or connection
    /// first, then `type`, then the signal's own fields; the phone receives it so.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        let kind = json!(self.type_name());
        match self {
            Self::Geometry { source, geometry } => {
                out.insert("v".into(), json!(VERSION));
                out.insert("source".into(), source.to_json());
                out.insert("type".into(), kind);
                out.insert("geometry".into(), geometry.to_json());
            }
            Self::Offer { connection, sdp, fingerprints, ice_servers, ice_transport_policy, geometry, input_epoch } => {
                connection.put(&mut out);
                out.insert("type".into(), kind);
                out.insert("sdp".into(), json!(sdp));
                out.insert("fingerprints".into(), Value::Array(fingerprints.iter().map(Fingerprint::to_json).collect()));
                out.insert("iceServers".into(), ice_servers_json(ice_servers));
                out.insert("iceTransportPolicy".into(), json!(ice_transport_policy.wire_name()));
                out.insert("geometry".into(), geometry.to_json());
                out.insert("inputEpoch".into(), json!(input_epoch));
            }
            Self::Candidate { connection, candidate } => {
                connection.put(&mut out);
                out.insert("type".into(), kind);
                out.insert("candidate".into(), candidate_json(candidate));
            }
            Self::Promote { connection, input_epoch, geometry_generation } => {
                connection.put(&mut out);
                out.insert("type".into(), kind);
                out.insert("inputEpoch".into(), json!(input_epoch));
                out.insert("geometryGeneration".into(), json!(geometry_generation));
            }
            Self::Demote { connection, input_epoch, reason } => {
                connection.put(&mut out);
                out.insert("type".into(), kind);
                out.insert("inputEpoch".into(), json!(input_epoch));
                out.insert("reason".into(), json!(reason.wire_name()));
            }
            Self::Close { connection, reason, retry_after_ms } => {
                connection.put(&mut out);
                out.insert("type".into(), kind);
                out.insert("reason".into(), json!(reason.wire_name()));
                if let Some(retry) = retry_after_ms {
                    out.insert("retryAfterMs".into(), json!(retry));
                }
            }
        }
        Value::Object(out)
    }
}

// ---- the data channel ----------------------------------------------------------------------------

/// A data-channel message from the phone, as a browser source's viewer reads it.
#[derive(Clone, Debug, PartialEq)]
pub enum ChannelMessage {
    /// Page input of the viewer's current epoch and geometry.
    Input { epoch: u64, seq: u64, geometry_generation: u64, sent_at: f64, control: Value },
    /// The phone's receiver statistics (already validated), as the JSON it sent.
    Stats(Value),
    /// A screen source's message (`screen-*`): valid JSON of this contract's version, but not a
    /// browser viewer's to read.
    Screen,
}

impl ChannelMessage {
    /// Node's `parseRemoteWebrtcChannelFromClient`, for the kinds a browser source reads.
    pub fn parse(text: &str) -> Result<Self, Refusal> {
        let Ok(value) = serde_json::from_str::<Value>(text) else { return fail("channel message") };
        let input = record(&value, "channel message")?;
        if safe_integer(field(input, "v")) != Some(VERSION as f64) {
            return fail("version");
        }
        let kind = field(input, "kind");
        if kind.as_str() == Some("stats") {
            return Ok(Self::Stats(stats(field(input, "stats"))?));
        }
        if matches!(kind.as_str(), Some("screen-frame-seen" | "screen-helper-grant" | "screen-helper-install" | "screen-input")) {
            return Ok(Self::Screen);
        }
        let epoch = positive_integer(field(input, "epoch"), "input epoch")?;
        let seq = positive_integer(field(input, "seq"), "input seq")?;
        let geometry_generation = positive_integer(field(input, "geometryGeneration"), "geometry generation")?;
        let sent_at = bounded_number(field(input, "sentAt"), 0.0, MAX_SAFE_INTEGER, "input time")?;
        if kind.as_str() != Some("input") {
            return fail("channel message kind");
        }
        let control = record(field(input, "control"), "input")?;
        let page_input = ["pointer", "wheel", "text", "key", "composition", "composition-end"];
        let control_type = js_string(field(control, "type"));
        if !page_input.contains(&control_type.as_str()) {
            return fail("input type");
        }
        Ok(Self::Input { epoch, seq, geometry_generation, sent_at, control: normalize_remote_control(control)? })
    }
}

fn count(value: &Value, what: &str) -> Result<f64, Refusal> {
    bounded_number(value, 0.0, MAX_SAFE_INTEGER, what)
}

fn stats(value: &Value) -> Result<Value, Refusal> {
    let input = record(value, "stats")?;
    let label = |v: &Value| bounded_text(v, 128, "stats label");
    let mut out = Map::new();
    out.insert("connectionId".into(), json!(connection_id(field(input, "connectionId"))?));
    out.insert("generation".into(), json!(positive_integer(field(input, "generation"), "generation")?));
    out.insert("at".into(), num(count(field(input, "at"), "stats time")?));
    let optional = |out: &mut Fields, name: &str, read: &dyn Fn(&Value) -> Result<Value, Refusal>| -> Result<(), Refusal> {
        if let Some(v) = input.get(name) {
            out.insert(name.into(), read(v)?);
        }
        Ok(())
    };
    optional(&mut out, "codec", &|v| label(v).map(Value::from))?;
    optional(&mut out, "decoderImplementation", &|v| label(v).map(Value::from))?;
    for (name, what) in [("framesReceived", "frames received"), ("framesDecoded", "frames decoded"), ("framesDropped", "frames dropped"), ("totalDecodeTimeMs", "decode time")] {
        out.insert(name.into(), num(count(field(input, name), what)?));
    }
    for (name, what) in [
        ("jitterBufferDelayMs", "jitter buffer delay"),
        ("freezeCount", "freeze count"),
        ("inputRoundTripMs", "input round trip"),
        ("inputToVisibleMs", "input to visible"),
        ("frameWidth", "frame width"),
        ("frameHeight", "frame height"),
    ] {
        optional(&mut out, name, &|v| count(v, what).map(num))?;
    }
    optional(&mut out, "candidatePair", &candidate_pair)?;
    Ok(Value::Object(out))
}

fn candidate_pair(value: &Value) -> Result<Value, Refusal> {
    let input = record(value, "candidate pair")?;
    let kind = |v: &Value| -> Result<Value, Refusal> {
        match v.as_str() {
            Some(text) if ["host", "srflx", "prflx", "relay"].contains(&text) => Ok(v.clone()),
            _ => fail("candidate type"),
        }
    };
    if !matches!(field(input, "protocol").as_str(), Some("udp" | "tcp")) {
        return fail("candidate protocol");
    }
    if let Some(relay) = input.get("relayProtocol")
        && !["udp", "tcp", "tls"].contains(&js_string(relay).as_str())
    {
        return fail("relay protocol");
    }
    let mut out = Map::new();
    out.insert("localType".into(), kind(field(input, "localType"))?);
    out.insert("remoteType".into(), kind(field(input, "remoteType"))?);
    out.insert("protocol".into(), field(input, "protocol").clone());
    if let Some(relay) = input.get("relayProtocol") {
        out.insert("relayProtocol".into(), relay.clone());
    }
    for (name, what) in [("currentRoundTripTimeMs", "round trip"), ("availableOutgoingBitrate", "outgoing bitrate")] {
        if let Some(v) = input.get(name) {
            out.insert(name.into(), num(count(v, what)?));
        }
    }
    Ok(Value::Object(out))
}

/// `normalizeRemoteBrowserControl` followed by `normalizeBrowserPageControl`, for the page inputs
/// a channel carries.
fn normalize_remote_control(input: &Fields) -> Result<Value, Refusal> {
    let kind = js_string(field(input, "type"));
    let invalid = |text: &str| -> Result<Value, Refusal> { Err(text.to_owned()) };
    match field(input, "documentId") {
        Value::String(id) if utf16_len(id) <= 64 && DOCUMENT_ID.is_match(id) => {}
        _ => return invalid("remote browser document id is invalid."),
    }
    if matches!(kind.as_str(), "text" | "composition" | "composition-end")
        && !matches!(field(input, "text"), Value::String(text) if utf16_len(text) <= MAX_REMOTE_BROWSER_TEXT)
    {
        return invalid("remote browser text is invalid.");
    }
    page_control(input, &kind)
}

fn page_control(input: &Fields, kind: &str) -> Result<Value, Refusal> {
    let document_id = match field(input, "documentId") {
        Value::String(id) if PAGE_DOCUMENT.is_match(id) => id.clone(),
        _ => return Err("Browser document token is invalid.".into()),
    };
    let number = |name: &str, min: f64, max: f64| -> Result<f64, Refusal> {
        finite(field(input, name)).filter(|n| *n >= min && *n <= max).ok_or_else(|| format!("Browser {name} is invalid."))
    };
    let text = |name: &str, limit: usize| -> Result<String, Refusal> {
        match field(input, name) {
            Value::String(t) if !t.is_empty() && utf16_len(t) <= limit => Ok(t.clone()),
            _ => Err(format!("Browser {name} is invalid.")),
        }
    };
    let mut out = Map::new();
    out.insert("type".into(), json!(kind));
    out.insert("documentId".into(), json!(document_id));
    match kind {
        "text" => {
            out.insert("text".into(), json!(text("text", 32_000)?));
        }
        "key" => {
            out.insert("key".into(), json!(text("key", 64)?));
        }
        "composition" | "composition-end" => {
            let Value::String(body) = field(input, "text") else { return Err("Browser composition text is invalid.".into()) };
            if utf16_len(body) > 32_000 {
                return Err("Browser composition text is invalid.".into());
            }
            out.insert("text".into(), json!(body));
            if kind == "composition" {
                let length = utf16_len(body) as f64;
                let start = number("selectionStart", 0.0, length)?;
                let end = number("selectionEnd", start, length)?;
                if start.fract() != 0.0 || end.fract() != 0.0 {
                    return Err("Browser composition selection is invalid.".into());
                }
                out.insert("selectionStart".into(), num(start));
                out.insert("selectionEnd".into(), num(end));
            }
        }
        "pointer" => {
            let phase = field(input, "phase").as_str().filter(|p| ["mouseMoved", "mousePressed", "mouseReleased"].contains(p));
            let button = field(input, "button").as_str().filter(|b| ["none", "left", "middle", "right"].contains(b));
            let (Some(phase), Some(button)) = (phase, button) else { return Err("Browser pointer is invalid.".into()) };
            out.insert("phase".into(), json!(phase));
            out.insert("button".into(), json!(button));
            out.insert("x".into(), num(number("x", 0.0, 100_000.0)?));
            out.insert("y".into(), num(number("y", 0.0, 100_000.0)?));
            out.insert("buttons".into(), num(number("buttons", 0.0, 7.0)?));
            out.insert("modifiers".into(), num(number("modifiers", 0.0, 15.0)?));
            out.insert("clickCount".into(), num(number("clickCount", 0.0, 3.0)?));
        }
        "wheel" => {
            out.insert("x".into(), num(number("x", 0.0, 100_000.0)?));
            out.insert("y".into(), num(number("y", 0.0, 100_000.0)?));
            out.insert("deltaX".into(), num(number("deltaX", -20_000.0, 20_000.0)?));
            out.insert("deltaY".into(), num(number("deltaY", -20_000.0, 20_000.0)?));
        }
        _ => return Err("Unknown browser input.".into()),
    }
    Ok(Value::Object(out))
}
