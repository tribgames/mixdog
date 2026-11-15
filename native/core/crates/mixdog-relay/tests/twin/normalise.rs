//! Masks only what differs by nature between two runs of the same scenario, and compares everything else as it is.
//!
//! Masked: `Date` header values; random identifiers (UUIDs and hexadecimal runs of 32 or more characters), mapped by
//! first appearance to `<id:N>`; the values a scenario captured (pair codes, claim ids, tickets), shown as `<$name>`;
//! the port and the scratch directory of each run; times (epoch milliseconds or seconds, and ISO dates, within 400
//! days of the run start), shown as a delta from the run start and compared with a tolerance; ES256 JWTs, whose
//! signature is verified against the scenario's keys and whose claims other than `exp`, `iat` and `nbf` stay in the
//! text; the P-256 key material of the VAPID file the relay generates in its data directory; the encrypted body of a web push request (its length stays). In the relay's log lines, the 8-hex phone id prefix after `client=` and `phone:`, and the milliseconds of `lived=` and `loop-p50=`/`loop-p99=`/`loop-max=`. A hexadecimal run that is the SHA-256 of a
//! placed file or of an answer body (an ETag, an index digest) is not random and stays as it is.
//!
//! Not masked: header names and their order, every byte of a body, close codes and reasons.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use regex::Regex;
use serde_json::{Map, Value};

const DAY_MS: i64 = 86_400_000;
const WINDOW_MS: i64 = 400 * DAY_MS;
const TIME_KEYS: [&str; 3] = ["exp", "iat", "nbf"];

/// What the harness knows about one run that the normaliser needs.
#[derive(Debug, Clone, Default)]
pub struct Masks {
    pub ports: Vec<u16>,
    /// The scratch directory of the run, in every spelling it may be printed in.
    pub roots: Vec<String>,
    /// The run start, epoch milliseconds.
    pub t0_ms: i64,
    /// Every value a step captured, by variable name.
    pub captured: Vec<(String, String)>,
    /// Lowercase hexadecimal SHA-256 digests that are content, not randomness.
    pub known_digests: HashSet<String>,
}

/// The events of one run and the masks of its run.
#[derive(Debug, Clone, Default)]
pub struct Transcript {
    pub events: Vec<Value>,
    pub masks: Masks,
}

struct Normaliser<'a> {
    masks: &'a Masks,
    ids: HashMap<String, usize>,
    errors: Vec<String>,
    keys: Vec<VerifyingKey>,
    captured: Vec<(&'a str, &'a str)>,
    re_ids: Regex,
    re_jwt: Regex,
    re_digits: Regex,
    re_iso: Regex,
    re_port: Option<Regex>,
    re_relay_log: Regex,
}

fn civil_days(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Epoch milliseconds of `2026-01-02T03:04:05.678Z`.
fn iso_ms(text: &str) -> Option<i64> {
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let fraction = match text.get(19..)?.strip_prefix('.') {
        Some(rest) => {
            let digits = rest.trim_end_matches('Z');
            format!("{digits:0<3}").get(..3)?.parse::<i64>().ok()?
        }
        None => 0,
    };
    Some(((civil_days(year, month, day) * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + fraction)
}

fn replace_token(text: &str, needle: &str, with: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(needle) {
        out.push_str(&rest[..at]);
        let after = rest[at + needle.len()..].chars().next();
        let bounded = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        if bounded(out.chars().next_back()) && bounded(after) {
            out.push_str(with);
        } else {
            out.push_str(needle);
        }
        rest = &rest[at + needle.len()..];
    }
    out.push_str(rest);
    out
}

/// Replaces the matches of `re` that stand alone (no alphanumeric neighbour) and for which `f` answers.
fn replace_standing(re: &Regex, text: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for found in re.find_iter(text) {
        let before = text[..found.start()].chars().next_back();
        let after = text[found.end()..].chars().next();
        let standing = before.is_none_or(|c| !c.is_alphanumeric()) && after.is_none_or(|c| !c.is_alphanumeric());
        if let Some(with) = standing.then(|| f(found.as_str())).flatten() {
            out.push_str(&text[last..found.start()]);
            out.push_str(&with);
            last = found.end();
        }
    }
    out.push_str(&text[last..]);
    out
}

fn mask_date_headers(headers: Value) -> Value {
    let Value::Array(list) = headers else { return headers };
    Value::Array(
        list.into_iter()
            .map(|pair| match pair {
                Value::Array(mut parts)
                    if parts.len() == 2 && parts[0].as_str().is_some_and(|n| n.eq_ignore_ascii_case("date")) =>
                {
                    parts[1] = Value::String("<date>".to_owned());
                    Value::Array(parts)
                }
                other => other,
            })
            .collect(),
    )
}

/// The data directory file the relay writes its own VAPID key pair to on first start: the key material is random by nature
/// (the public key and the `x`, `y` and `d` of the private JWK), the rest of the file (version, key type, curve, layout) stays.
fn mask_generated_vapid_file(file: Value) -> Value {
    static KEY: OnceLock<Regex> = OnceLock::new();
    let re = KEY.get_or_init(|| {
        Regex::new(r#"("(?:publicKey|x|y|d)":\s*")(?:[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{87})(")"#).expect("pattern")
    });
    let Value::Object(mut map) = file else { return file };
    if let Some(Value::String(text)) = map.get_mut("text") {
        *text = re.replace_all(text, "${1}<p256 key>${2}").into_owned();
    }
    Value::Object(map)
}

fn is_encrypted_push(map: &Map<String, Value>) -> bool {
    map.get("headers").and_then(Value::as_object).is_some_and(|headers| {
        headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("content-encoding") && v.as_str() == Some("aes128gcm"))
    })
}

impl<'a> Normaliser<'a> {
    fn new(masks: &'a Masks, vapid_public: &[String]) -> Result<Self, String> {
        let mut keys = Vec::new();
        for key in vapid_public {
            let bytes =
                URL_SAFE_NO_PAD.decode(key.trim_end_matches('=')).map_err(|e| format!("keys.vapid_public: {e}"))?;
            keys.push(VerifyingKey::from_sec1_bytes(&bytes).map_err(|e| format!("keys.vapid_public: {e}"))?);
        }
        let mut captured: Vec<(&str, &str)> =
            masks.captured.iter().filter(|(_, v)| v.len() >= 4).map(|(n, v)| (n.as_str(), v.as_str())).collect();
        captured.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(b.0)));
        captured.dedup_by(|a, b| a.1 == b.1);
        let ports: Vec<String> = masks.ports.iter().map(u16::to_string).collect();
        let re_port = (!ports.is_empty())
            .then(|| Regex::new(&format!(r":(?:{})\b", ports.join("|"))))
            .transpose()
            .map_err(|e| e.to_string())?;
        let regex = |pattern: &str| Regex::new(pattern).map_err(|e| e.to_string());
        Ok(Self {
            masks,
            ids: HashMap::new(),
            errors: Vec::new(),
            keys,
            captured,
            re_ids: regex(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}")?,
            re_jwt: regex(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")?,
            re_digits: regex(r"\d+")?,
            re_iso: regex(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z")?,
            re_port,
            re_relay_log: regex(r"(client=|phone:)[0-9a-f]{8}\b|(lived=|loop-(?:p50|p99|max)=)\d+(?:\.\d+)?ms")?,
        })
    }

    fn value(&mut self, value: Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.string(&text)),
            Value::Array(items) => Value::Array(items.into_iter().map(|item| self.value(item)).collect()),
            Value::Object(map) => {
                let encrypted = is_encrypted_push(&map);
                let mut out = Map::new();
                for (key, item) in map {
                    let item = match key.as_str() {
                        "headers" => mask_date_headers(item),
                        "webpush-vapid.json" => mask_generated_vapid_file(item),
                        "bodyBase64" if encrypted => {
                            let bytes = item
                                .as_str()
                                .and_then(|text| base64::engine::general_purpose::STANDARD.decode(text).ok());
                            Value::String(format!("<encrypted {} bytes>", bytes.map_or(0, |b| b.len())))
                        }
                        _ => item,
                    };
                    let key = self.string(&key);
                    out.insert(key, self.value(item));
                }
                Value::Object(out)
            }
            other => other,
        }
    }

    fn string(&mut self, input: &str) -> String {
        let mut text = input.to_owned();
        for root in &self.masks.roots {
            text = text.replace(root.as_str(), "<root>");
        }
        if let Some(port) = &self.re_port {
            // A colon after a quote is a JSON key (`"bytes":49152`), not a host's port.
            text = port.replace_all(&text, "${1}:<port>").into_owned();
        }
        if text.contains("eyJ") {
            text = self.jwts(&text);
        }
        for (name, value) in self.captured.clone() {
            if text.contains(value) {
                text = replace_token(&text, value, &format!("<${name}>"));
            }
        }
        text = self
            .re_relay_log
            .replace_all(&text, |found: &regex::Captures<'_>| match (found.get(1), found.get(2)) {
                (Some(key), _) => format!("{}<client8>", key.as_str()),
                (_, Some(key)) => format!("{}<ms>", key.as_str()),
                (None, None) => String::new(),
            })
            .into_owned();
        text = self.identifiers(&text);
        self.times(&text)
    }

    fn identifiers(&mut self, text: &str) -> String {
        let re = self.re_ids.clone();
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for found in re.find_iter(text) {
            out.push_str(&text[last..found.start()]);
            last = found.end();
            let matched = found.as_str();
            if self.masks.known_digests.contains(&matched.to_ascii_lowercase()) {
                out.push_str(matched);
                continue;
            }
            let next = self.ids.len() + 1;
            let number = *self.ids.entry(matched.to_owned()).or_insert(next);
            out.push_str(&format!("<id:{number}>"));
        }
        out.push_str(&text[last..]);
        out
    }

    fn times(&self, text: &str) -> String {
        let t0 = self.masks.t0_ms;
        let marked = replace_standing(&self.re_digits, text, |digits| {
            let number: i64 = digits.parse().ok()?;
            let millis = match digits.len() {
                13 => number,
                10 => number * 1000,
                _ => return None,
            };
            ((millis - t0).abs() <= WINDOW_MS).then(|| format!("\u{27e6}t:{}\u{27e7}", millis - t0))
        });
        self.re_iso
            .replace_all(&marked, |found: &regex::Captures| {
                match iso_ms(&found[0]).filter(|millis| (millis - t0).abs() <= WINDOW_MS) {
                    Some(millis) => format!("\u{27e6}t:{}\u{27e7}", millis - t0),
                    None => found[0].to_owned(),
                }
            })
            .into_owned()
    }

    fn jwts(&mut self, text: &str) -> String {
        let re = self.re_jwt.clone();
        re.replace_all(text, |found: &regex::Captures| self.jwt(&found[0])).into_owned()
    }

    /// Verifies the token and shows its header algorithm and its claims other than the times.
    fn jwt(&mut self, token: &str) -> String {
        let parts: Vec<&str> = token.split('.').collect();
        let decode = |part: &str| URL_SAFE_NO_PAD.decode(part).ok();
        let object =
            |part: &str| decode(part).and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok());
        let (Some(header), Some(claims)) = (object(parts[0]), parts.get(1).and_then(|p| object(p))) else {
            self.errors.push("a JWT-shaped string whose header or claims are not JSON".to_owned());
            return "<jwt malformed>".to_owned();
        };
        let algorithm = header.get("alg").and_then(Value::as_str).unwrap_or("").to_owned();
        if algorithm != "ES256" {
            self.errors.push(format!("a JWT signed with {algorithm:?}: only ES256 is verified"));
            return "<jwt unverified>".to_owned();
        }
        let signature = parts.get(2).and_then(|p| decode(p)).and_then(|bytes| Signature::from_slice(&bytes).ok());
        let message = format!("{}.{}", parts[0], parts[1]);
        let verified =
            signature.is_some_and(|sig| self.keys.iter().any(|key| key.verify(message.as_bytes(), &sig).is_ok()));
        if !verified {
            self.errors.push("a JWT whose ES256 signature no key of the scenario verifies".to_owned());
        }
        if let Some(exp) = claims.get("exp").and_then(Value::as_i64) {
            let millis = exp * 1000;
            if millis < self.masks.t0_ms - 120_000 || millis > self.masks.t0_ms + WINDOW_MS {
                self.errors.push(format!("a JWT whose exp {exp} is outside the run"));
            }
        }
        let shown: BTreeMap<&String, &Value> =
            claims.iter().filter(|(k, _)| !TIME_KEYS.contains(&k.as_str())).collect();
        format!("<jwt ES256 {}>", serde_json::to_string(&shown).unwrap_or_default())
    }
}

/// The events with their masks applied, or what could not be verified.
pub fn normalise(transcript: &Transcript, vapid_public: &[String]) -> Result<Vec<Value>, String> {
    let mut normaliser = Normaliser::new(&transcript.masks, vapid_public)?;
    let events: Vec<Value> = transcript.events.iter().cloned().map(|event| normaliser.value(event)).collect();
    if normaliser.errors.is_empty() { Ok(events) } else { Err(normaliser.errors.join("; ")) }
}

fn string_equal(a: &str, b: &str, tolerance_ms: u64) -> bool {
    if a == b {
        return true;
    }
    static MARKER: OnceLock<Regex> = OnceLock::new();
    let marker = MARKER.get_or_init(|| Regex::new("\u{27e6}t:(-?\\d+)\u{27e7}").expect("the marker pattern"));
    let deltas = |text: &str| -> Vec<i64> { marker.captures_iter(text).filter_map(|c| c[1].parse().ok()).collect() };
    let (left, right) = (deltas(a), deltas(b));
    if left.is_empty() || left.len() != right.len() {
        return false;
    }
    let template = |text: &str| marker.replace_all(text, "\u{27e6}t\u{27e7}").into_owned();
    template(a) == template(b) && left.iter().zip(&right).all(|(x, y)| x.abs_diff(*y) <= tolerance_ms)
}

fn equal(a: &Value, b: &Value, tolerance_ms: u64) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => string_equal(x, y, tolerance_ms),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| equal(p, q, tolerance_ms))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| equal(v, w, tolerance_ms)))
        }
        _ => a == b,
    }
}

fn shown(event: Option<&Value>) -> String {
    let Some(event) = event else { return "(no event)".to_owned() };
    let text = event.to_string();
    if text.len() > 1500 { format!("{}...", text.chars().take(1500).collect::<String>()) } else { text }
}

/// The first event where the two normalised transcripts differ, each side printed with its step.
pub fn first_difference(a_name: &str, a: &[Value], b_name: &str, b: &[Value], tolerance_ms: u64) -> Option<String> {
    let at = (0..a.len().max(b.len())).find(|&i| match (a.get(i), b.get(i)) {
        (Some(x), Some(y)) => !equal(x, y, tolerance_ms),
        _ => true,
    })?;
    let step = |event: Option<&Value>| event.and_then(|e| e.get("step")).map_or("-".to_owned(), Value::to_string);
    Some(format!(
        "event {at} differs\n  {a_name} (step {}): {}\n  {b_name} (step {}): {}",
        step(a.get(at)),
        shown(a.get(at)),
        step(b.get(at)),
        shown(b.get(at))
    ))
}

#[cfg(test)]
mod tests {
    use p256::ecdsa::SigningKey;
    use p256::ecdsa::signature::Signer;
    use serde_json::json;

    use super::*;

    const T0: i64 = 1_800_000_000_000;

    fn masks() -> Masks {
        Masks { ports: vec![43211], roots: vec!["C:\\tmp\\run1".to_owned()], t0_ms: T0, ..Masks::default() }
    }

    fn run(masks: Masks, events: Vec<Value>) -> Vec<Value> {
        normalise(&Transcript { events, masks }, &[]).unwrap()
    }

    #[test]
    fn relay_log_phone_prefixes_and_durations_are_masked() {
        let events = vec![
            json!({"ev": "log", "line": "[relay] phone leg closed client=1a2b3c4d code=1000 reason= lived=5ms"}),
            json!({"ev": "log", "line": "[relay] sockets 30s phones=1 buffered desktop:7c1f3a52=0B phone:d8601a87=0B loop-p50=31.6ms loop-p99=32.3ms loop-max=34.2ms"}),
        ];
        let out = run(masks(), events);
        assert_eq!(out[0]["line"], "[relay] phone leg closed client=<client8> code=1000 reason= lived=<ms>");
        assert_eq!(
            out[1]["line"],
            "[relay] sockets 30s phones=1 buffered desktop:7c1f3a52=0B phone:<client8>=0B loop-p50=<ms> loop-p99=<ms> loop-max=<ms>"
        );
    }

    #[test]
    fn identifiers_are_mapped_by_first_appearance_and_equal_structure_compares_equal() {
        let a = run(
            masks(),
            vec![
                json!({"x": "11111111-2222-3333-4444-555555555555 and 11111111-2222-3333-4444-555555555555 then aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
            ],
        );
        let other = Masks { ports: vec![50000], ..masks() };
        let b = run(
            other,
            vec![
                json!({"x": "99999999-8888-7777-6666-555555555555 and 99999999-8888-7777-6666-555555555555 then bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}),
            ],
        );
        assert_eq!(a, b);
        assert_eq!(a[0]["x"], "<id:1> and <id:1> then <id:2>");
    }

    #[test]
    fn two_different_identifiers_do_not_compare_equal_to_one_repeated() {
        let a = run(masks(), vec![json!(["1".repeat(32), "2".repeat(32)])]);
        let b = run(masks(), vec![json!(["3".repeat(32), "3".repeat(32)])]);
        assert!(first_difference("a", &a, "b", &b, 0).is_some());
    }

    #[test]
    fn captured_values_the_port_and_the_root_are_masked() {
        let mut m = masks();
        m.captured = vec![("pair".to_owned(), "123456".to_owned())];
        let out = run(
            m,
            vec![
                json!({"line": "[relay] http listening on :43211 (renderer: C:\\tmp\\run1\\renderer)", "code": "{\"code\":\"123456\"} 1234567"}),
            ],
        );
        assert_eq!(out[0]["line"], "[relay] http listening on :<port> (renderer: <root>\\renderer)");
        assert_eq!(out[0]["code"], "{\"code\":\"<$pair>\"} 1234567");
    }

    #[test]
    fn a_content_digest_stays_and_a_random_run_does_not() {
        let digest = "ab".repeat(32);
        let mut m = masks();
        m.known_digests.insert(digest.clone());
        let out = run(m, vec![json!({"etag": format!("W/\"{digest}\""), "token": "cd".repeat(32)})]);
        assert_eq!(out[0]["etag"], format!("W/\"{digest}\""));
        assert_eq!(out[0]["token"], "<id:1>");
    }

    #[test]
    fn times_near_the_run_are_compared_with_a_tolerance_and_far_ones_literally() {
        let a = run(masks(), vec![json!({"b": format!("{{\"expiresAt\":{},\"old\":1500000000000}}", T0 + 5000)})]);
        let later = Masks { t0_ms: T0 + 60_000, ..masks() };
        let b =
            run(later, vec![json!({"b": format!("{{\"expiresAt\":{},\"old\":1500000000000}}", T0 + 60_000 + 5400)})]);
        assert!(first_difference("a", &a, "b", &b, 1000).is_none());
        let c = run(masks(), vec![json!({"b": format!("{{\"expiresAt\":{},\"old\":1500000000000}}", T0 + 9000)})]);
        assert!(first_difference("a", &a, "c", &c, 1000).is_some());
        assert!(first_difference("a", &a, "c", &c, 5000).is_none());
        let seconds =
            run(masks(), vec![json!({"s": format!("{}", (T0 + 2000) / 1000), "iso": "2027-01-15T08:00:00.123Z"})]);
        assert_eq!(seconds[0]["s"], "\u{27e6}t:2000\u{27e7}");
        assert!(seconds[0]["iso"].as_str().unwrap().starts_with('\u{27e6}'));
    }

    #[test]
    fn iso_dates_convert_to_epoch_milliseconds() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2000-03-01T00:00:01.5Z"), Some(951_868_801_500));
        assert_eq!(iso_ms("nonsense"), None);
    }

    #[test]
    fn the_date_header_is_masked_and_other_headers_are_not() {
        let out = run(masks(), vec![json!({"headers": [["Date", "Mon, 01 Jan 2030 00:00:00 GMT"], ["Server", "x"]]})]);
        assert_eq!(out[0]["headers"], json!([["Date", "<date>"], ["Server", "x"]]));
    }

    #[test]
    fn header_order_and_case_are_compared() {
        let a = vec![json!({"step": 1, "headers": [["A", "1"], ["B", "2"]]})];
        let b = vec![json!({"step": 1, "headers": [["B", "2"], ["A", "1"]]})];
        let c = vec![json!({"step": 1, "headers": [["a", "1"], ["B", "2"]]})];
        assert!(first_difference("a", &a, "b", &b, 0).is_some());
        assert!(first_difference("a", &a, "c", &c, 0).is_some());
        let report = first_difference("node", &a, "rust", &b, 0).unwrap();
        assert!(report.contains("node (step 1)") && report.contains("rust (step 1)"));
    }

    fn signed(key: &SigningKey, claims: &Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"ES256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let signature: Signature = key.sign(format!("{header}.{payload}").as_bytes());
        format!("{header}.{payload}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    #[test]
    fn a_jwt_is_verified_against_the_scenario_key_then_masked() {
        let key = SigningKey::from_slice(&[7u8; 32]).unwrap();
        let public = URL_SAFE_NO_PAD.encode(VerifyingKey::from(&key).to_encoded_point(false).as_bytes());
        let claims = json!({"aud": "https://push.example", "exp": T0 / 1000 + 3600, "sub": "mailto:a@b.c"});
        let token = signed(&key, &claims);
        let transcript = Transcript { events: vec![json!({"h": format!("vapid t={token},k=abc")})], masks: masks() };
        let out = normalise(&transcript, &[public.clone()]).unwrap();
        assert_eq!(
            out[0]["h"],
            "vapid t=<jwt ES256 {\"aud\":\"https://push.example\",\"sub\":\"mailto:a@b.c\"}>,k=abc"
        );
        let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
        let forged = Transcript { events: vec![json!(signed(&other, &claims))], masks: masks() };
        assert!(normalise(&forged, &[public.clone()]).unwrap_err().contains("signature"));
        let stale = Transcript { events: vec![json!(signed(&key, &json!({"exp": 5})))], masks: masks() };
        assert!(normalise(&stale, &[public]).unwrap_err().contains("outside the run"));
    }

    #[test]
    fn an_encrypted_push_body_keeps_only_its_length() {
        let body = base64::engine::general_purpose::STANDARD.encode([1u8; 90]);
        let out = run(
            masks(),
            vec![json!({"headers": {"content-encoding": "aes128gcm"}, "bodyBytes": 90, "bodyBase64": body})],
        );
        assert_eq!(out[0]["bodyBase64"], "<encrypted 90 bytes>");
        assert_eq!(out[0]["bodyBytes"], 90);
    }
}
