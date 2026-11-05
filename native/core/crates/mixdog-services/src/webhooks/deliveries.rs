//! Delivery identity: the sender's id bound to the digest of the authenticated body.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::signature::Headers;

pub fn extract_delivery_id(headers: &Headers) -> Option<&str> {
    ["x-github-delivery", "x-delivery-id", "x-request-id"]
        .into_iter()
        .find_map(|h| headers.get(h).map(String::as_str).filter(|v| !v.is_empty()))
}

pub fn content_delivery_id(raw_body: &[u8]) -> String {
    let digest = Sha256::digest(raw_body);
    format!("body-sha256-{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// The claim identity. Keying on the digest alone would suppress two distinct deliveries of
/// identical content forever; binding the sender's id keeps replays of one captured
/// delivery duplicates while repeated legitimate payloads stay distinct.
pub fn delivery_id(headers: &Headers, raw_body: &[u8]) -> String {
    let digest = content_delivery_id(raw_body);
    match extract_delivery_id(headers) {
        Some(source) => format!("{}:{digest}", mixdog_js::slice_utf16(source, 120)),
        None => digest,
    }
}

pub fn headers_summary(headers: &Headers) -> Value {
    let mut summary = Map::new();
    let non_empty = |name: &str| headers.get(name).filter(|v| !v.is_empty());
    if let Some(event) = non_empty("x-github-event") {
        summary.insert("event_type".into(), event.clone().into());
    }
    if let Some(id) = extract_delivery_id(headers) {
        summary.insert("delivery_id".into(), id.into());
    }
    let signed = ["x-hub-signature-256", "x-signature-256", "stripe-signature", "sentry-hook-signature"]
        .into_iter()
        .any(|h| non_empty(h).is_some());
    summary.insert("signature_present".into(), signed.into());
    if let Some(ct) = non_empty("content-type") {
        summary.insert("content_type".into(), ct.clone().into());
    }
    Value::Object(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> Headers {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn id_binds_sender_id_to_the_body_digest() {
        let empty_digest = "body-sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(delivery_id(&h(&[]), b""), empty_digest);
        assert_eq!(delivery_id(&h(&[("x-github-delivery", "d1")]), b""), format!("d1:{empty_digest}"));
        assert_eq!(delivery_id(&h(&[("x-request-id", "r")]), b"").split(':').next(), Some("r"));
    }

    #[test]
    fn summary_reports_signature_presence_without_values() {
        let s = headers_summary(&h(&[("x-github-event", "push"), ("x-hub-signature-256", "sha256=x"), ("content-type", "application/json")]));
        assert_eq!(
            s,
            serde_json::json!({"event_type":"push","signature_present":true,"content_type":"application/json"})
        );
        assert_eq!(headers_summary(&h(&[])), serde_json::json!({"signature_present":false}));
    }
}
