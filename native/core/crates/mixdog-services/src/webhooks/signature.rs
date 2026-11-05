//! Webhook signature headers and HMAC verification (GitHub, Sentry, Stripe, generic).

use std::collections::HashMap;

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// Lower-cased header names to values.
pub type Headers = HashMap<String, String>;

/// (parser, header, prefix) in the order unparsed requests are probed.
const SIGNATURE_HEADERS: [(&str, &str, &str); 4] = [
    ("github", "x-hub-signature-256", "sha256="),
    ("sentry", "sentry-hook-signature", ""),
    ("stripe", "stripe-signature", ""),
    ("generic", "x-signature-256", "sha256="),
];

/// Stripe's documented replay window, either side of the clock.
const STRIPE_TOLERANCE_MS: i64 = 5 * 60 * 1000;

fn signature_in(headers: &Headers, header: &str, prefix: &str) -> Option<String> {
    let raw = headers.get(header).filter(|v| !v.is_empty())?;
    Some(if prefix.is_empty() { raw.clone() } else { raw.replacen(prefix, "", 1) })
}

/// The signature value to verify: the configured parser's header first, then any known one.
pub fn extract_signature(headers: &Headers, parser: Option<&str>) -> Option<String> {
    if let Some((_, header, prefix)) = SIGNATURE_HEADERS.iter().find(|(p, ..)| Some(*p) == parser)
        && let Some(sig) = signature_in(headers, header, prefix)
    {
        return Some(sig);
    }
    SIGNATURE_HEADERS.iter().find_map(|(_, header, prefix)| signature_in(headers, header, prefix))
}

/// Decodes leading hex pairs and stops at the first invalid one, so a crafted header
/// yields a short digest that simply fails the length check.
fn lenient_hex(text: &str) -> Vec<u8> {
    let nibble = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    text.as_bytes()
        .chunks_exact(2)
        .map_while(|pair| Some(nibble(pair[0])? << 4 | nibble(pair[1])?))
        .collect()
}

fn mac_matches(secret: &str, parts: &[&[u8]], provided_hex: &str) -> bool {
    let provided = lenient_hex(provided_hex);
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else { return false };
    for part in parts {
        mac.update(part);
    }
    // `verify_slice` compares in constant time and rejects a wrong length.
    mac.verify_slice(&provided).is_ok()
}

/// The lower-case hex HMAC-SHA256 of `data`, as a sender signs a delivery.
pub fn hmac_hex(secret: &str, data: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(data);
    mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// First `key` followed by at least one char satisfying `ok`, as the captured run.
fn capture<'a>(text: &'a str, key: &str, ok: impl Fn(char) -> bool) -> Option<&'a str> {
    text.match_indices(key).find_map(|(i, _)| {
        let rest = &text[i + key.len()..];
        let len = rest.find(|c: char| !ok(c)).unwrap_or(rest.len());
        (len > 0).then(|| &rest[..len])
    })
}

pub fn verify_signature(secret: &str, raw_body: &[u8], signature: &str, parser: Option<&str>, now_ms: i64) -> bool {
    if parser == Some("stripe") {
        // Stripe signs `{t}.{payload}`; both fields are required and `t` must be fresh,
        // or a captured pair would replay forever.
        let v1 = capture(signature, "v1=", |c| matches!(c, 'a'..='f' | '0'..='9'));
        let t = capture(signature, "t=", |c| c.is_ascii_digit());
        let (Some(v1), Some(t)) = (v1, t) else { return false };
        let Ok(ts) = t.parse::<i64>() else { return false };
        if ts.saturating_mul(1000).abs_diff(now_ms) as i64 > STRIPE_TOLERANCE_MS {
            return false;
        }
        let prefix = format!("{t}.");
        return mac_matches(secret, &[prefix.as_bytes(), raw_body], v1);
    }
    mac_matches(secret, &[raw_body], signature)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_mac(secret: &str, data: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(data);
        mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn headers(pairs: &[(&str, &str)]) -> Headers {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn github_header_prefix_is_stripped() {
        let h = headers(&[("x-hub-signature-256", "sha256=abc")]);
        assert_eq!(extract_signature(&h, Some("github")).as_deref(), Some("abc"));
        assert_eq!(extract_signature(&h, None).as_deref(), Some("abc"));
        assert_eq!(extract_signature(&headers(&[]), Some("github")), None);
    }

    #[test]
    fn hmac_of_the_body_verifies() {
        let body = br#"{"a":1}"#;
        let sig = hex_mac("s3cret", body);
        assert!(verify_signature("s3cret", body, &sig, Some("github"), 0));
        assert!(!verify_signature("other", body, &sig, Some("github"), 0));
        assert!(!verify_signature("s3cret", b"{}", &sig, None, 0));
        assert!(!verify_signature("s3cret", body, "zz", None, 0));
        assert!(!verify_signature("s3cret", body, &sig[..10], None, 0));
    }

    #[test]
    fn stripe_signs_timestamp_and_enforces_the_window() {
        let body = b"payload";
        let now_ms = 1_700_000_000_000;
        let t = now_ms / 1000;
        let sig = format!("t={t},v1={}", hex_mac("k", format!("{t}.payload").as_bytes()));
        assert!(verify_signature("k", body, &sig, Some("stripe"), now_ms));
        assert!(!verify_signature("k", body, &sig, Some("stripe"), now_ms + 6 * 60 * 1000));
        assert!(!verify_signature("k", body, &sig, Some("stripe"), now_ms - 6 * 60 * 1000));
        assert!(!verify_signature("k", body, &format!("v1={}", hex_mac("k", body)), Some("stripe"), now_ms));
    }
}
