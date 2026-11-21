//! What a proxied media answer may say at the relay origin. Desktop-supplied metadata is forwarded, not trusted: an HTML or SVG
//! asset must never become an active document at this origin and the leg must not set arbitrary headers (cookies, CSP overrides).
//! Everything outside the allow-list is dropped.

use serde_json::Value;

use crate::js;

/// The headers the desktop may set, by their lower-case name, and how the relay writes them (`MEDIA_PASS_HEADERS`).
const PASS_HEADERS: [(&str, &str); 8] = [
    ("content-type", "Content-Type"),
    ("content-length", "Content-Length"),
    ("content-range", "Content-Range"),
    ("accept-ranges", "Accept-Ranges"),
    ("cache-control", "Cache-Control"),
    ("etag", "ETag"),
    ("last-modified", "Last-Modified"),
    ("vary", "Vary"),
];

/// Content types that would be an active document at the relay origin (`MEDIA_ACTIVE_TYPE`, a prefix match).
const ACTIVE_TYPES: [&str; 8] =
    ["text/html", "application/xhtml", "image/svg", "text/xml", "application/xml", "text/javascript", "application/javascript", "application/ecmascript"];

const OCTET_STREAM: &str = "application/octet-stream";

/// `/^[\x20-\x7e]{min,max}$/`.
fn printable_ascii(text: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&text.len()) && text.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// `safeMediaContentType`: a value that is not printable ASCII of 1 to 200 characters, or whose media type is an active one,
/// becomes `application/octet-stream`; any other value is kept as written.
fn safe_content_type(value: &str) -> String {
    if !printable_ascii(value, 1, 200) {
        return OCTET_STREAM.to_owned();
    }
    let base = js::js_trim(value.split(';').next().unwrap_or_default()).to_ascii_lowercase();
    if base.is_empty() || ACTIVE_TYPES.iter().any(|active| base.starts_with(active)) {
        return OCTET_STREAM.to_owned();
    }
    value.to_owned()
}

/// The headers of a proxied answer, in write order: the forced ones (no scripts, no framing, no sniffing), then the allow-listed
/// ones the desktop supplied. A header supplied twice under different spellings is written once, with the last value; an array,
/// an object, a null, a value of more than 4096 characters or one that is not printable ASCII is dropped.
pub fn media_response_headers(supplied: Option<&Value>) -> Vec<(&'static str, String)> {
    let mut headers: Vec<(&'static str, String)> = vec![
        ("Content-Security-Policy", "default-src 'none'; sandbox".to_owned()),
        ("X-Content-Type-Options", "nosniff".to_owned()),
        ("Content-Disposition", "attachment".to_owned()),
        ("Cross-Origin-Resource-Policy", "same-origin".to_owned()),
        ("Referrer-Policy", "no-referrer".to_owned()),
        ("Content-Type", OCTET_STREAM.to_owned()),
    ];
    let Some(Value::Object(source)) = supplied else { return headers };
    for (key, value) in source {
        let Some(&(_, name)) = PASS_HEADERS.iter().find(|(lower, _)| *lower == key.to_ascii_lowercase()) else { continue };
        if matches!(value, Value::Null | Value::Array(_) | Value::Object(_)) {
            continue;
        }
        let text = mixdog_js::value_to_string(value);
        if !printable_ascii(&text, 0, 4096) {
            continue;
        }
        let text = if name == "Content-Type" { safe_content_type(&text) } else { text };
        match headers.iter_mut().find(|(existing, _)| *existing == name) {
            Some(slot) => slot.1 = text,
            None => headers.push((name, text)),
        }
    }
    headers
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn value<'a>(headers: &'a [(&'static str, String)], name: &str) -> Option<&'a str> {
        headers.iter().find(|(existing, _)| *existing == name).map(|(_, text)| text.as_str())
    }

    #[test]
    fn desktop_media_metadata_cannot_make_the_relay_origin_serve_active_content() {
        let headers = media_response_headers(Some(&json!({
            "content-type": "image/svg+xml",
            "content-length": 12,
            "set-cookie": "session=stolen",
            "content-security-policy": "default-src *",
        })));
        assert_eq!(value(&headers, "Content-Type"), Some("application/octet-stream"));
        assert_eq!(value(&headers, "Content-Length"), Some("12"));
        assert_eq!(value(&headers, "Set-Cookie"), None);
        assert_eq!(value(&headers, "X-Content-Type-Options"), Some("nosniff"));
        assert_eq!(value(&headers, "Content-Disposition"), Some("attachment"));
        assert_eq!(value(&headers, "Content-Security-Policy"), Some("default-src 'none'; sandbox"));
        assert_eq!(value(&headers, "Cross-Origin-Resource-Policy"), Some("same-origin"));
        assert_eq!(value(&headers, "Referrer-Policy"), Some("no-referrer"));
        let passthrough = media_response_headers(Some(&json!({ "content-type": "video/mp4", "accept-ranges": "bytes" })));
        assert_eq!(value(&passthrough, "Content-Type"), Some("video/mp4"));
        assert_eq!(value(&passthrough, "Accept-Ranges"), Some("bytes"));
    }

    #[test]
    fn every_active_type_is_neutralised_whatever_its_case_or_parameters() {
        for kind in [
            "text/html; charset=utf-8",
            "TEXT/HTML",
            " text/html",
            "application/xhtml+xml",
            "image/svg+xml",
            "text/xml",
            "application/xml",
            "text/javascript",
            "application/javascript",
            "application/ecmascript",
            "",
            "caf\u{e9}/x",
        ] {
            let headers = media_response_headers(Some(&json!({ "Content-Type": kind })));
            assert_eq!(value(&headers, "Content-Type"), Some("application/octet-stream"), "{kind:?}");
        }
        let kept = media_response_headers(Some(&json!({ "content-type": "image/png; foo=bar" })));
        assert_eq!(value(&kept, "Content-Type"), Some("image/png; foo=bar"));
    }

    #[test]
    fn values_that_are_not_plain_text_are_dropped_and_the_last_spelling_wins() {
        let long = "x".repeat(4097);
        let headers = media_response_headers(Some(&json!({
            "etag": ["a"],
            "vary": { "a": 1 },
            "cache-control": null,
            "last-modified": long,
            "content-range": "bytes 0-1/2\r\nSet-Cookie: x",
            "ETag": "\"a\"",
            "etag ": "\"ignored\"",
            "Etag": "\"b\"",
        })));
        assert_eq!(value(&headers, "ETag"), Some("\"b\""));
        for dropped in ["Vary", "Cache-Control", "Last-Modified", "Content-Range"] {
            assert_eq!(value(&headers, dropped), None, "{dropped}");
        }
        assert_eq!(headers.iter().filter(|(name, _)| *name == "ETag").count(), 1);
        let max = media_response_headers(Some(&json!({ "vary": "y".repeat(4096) })));
        assert_eq!(value(&max, "Vary").map(str::len), Some(4096));
    }

    #[test]
    fn anything_but_an_object_supplies_nothing() {
        for supplied in [None, Some(json!(null)), Some(json!([["content-type", "video/mp4"]])), Some(json!("x"))] {
            let headers = media_response_headers(supplied.as_ref());
            assert_eq!(headers.len(), 6);
            assert_eq!(value(&headers, "Content-Type"), Some("application/octet-stream"));
        }
    }
}
