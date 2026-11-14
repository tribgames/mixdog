//! Secret detection and redaction for every string that leaves the browser host: page text, URLs, network bodies, dialog
//! messages and errors (`redaction.ts`). Nothing here knows about pages or CDP: callers pass text in and get safe text out.

use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::utf16_len;
use url::Url;

const SECRET_KEYS: &str = r"access[_-]?token|api[_-]?key|apikey|authorization|id[_-]?token|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token";

/// Credential shapes recognised anywhere in text, with the marker each one is replaced by.
static TOKEN_REDACTIONS: LazyLock<Vec<(JsRegex, &'static str)>> = LazyLock::new(|| {
    [
        (r"\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}", "i", "[REDACTED_AUTH]"),
        (r"\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b", "", "[REDACTED_KEY]"),
        (r"\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b", "", "[REDACTED_GITHUB_TOKEN]"),
        (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", "", "[REDACTED_GITHUB_TOKEN]"),
        (r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "", "[REDACTED_SLACK_TOKEN]"),
        (r"\bAKIA[0-9A-Z]{16}\b", "", "[REDACTED_AWS_KEY]"),
        (r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b", "", "[REDACTED_JWT]"),
    ]
    .into_iter()
    .map(|(pattern, flags, marker)| (JsRegex::new_static(pattern, flags), marker))
    .collect()
});

static URL_CREDENTIALS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(https?://)([^/\s:@]+):([^@\s/]+)@", "i"));

static QUERY_SECRET: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"([?&](?:access[_-]?token|api[_-]?key|apikey|auth|authorization|code|id[_-]?token|key|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token)=)[^&#\s]*",
        "i",
    )
});

static ASSIGNED_SECRET: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        &format!(
            r##"((?:"|')?(?:{SECRET_KEYS})(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|\[REDACTED(?:_[A-Z_]+| STORED CREDENTIAL)?\]|[^,\s;&}}\]\r\n]+)"##
        ),
        "i",
    )
});

static COOKIE_LINE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^((?:set-)?cookie\s*:\s*).+$", "im"));

static SECRET_PARAMETER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!("^(?:{SECRET_KEYS})$"), "i"));

static REDACTED_PARAMETER: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"(?:access[_-]?token|api[_-]?key|apikey|auth|authorization|id[_-]?token|key|password|passwd|refresh[_-]?token|secret|session[_-]?(?:id|token)|token)",
        "i",
    )
});

/// `decodeURIComponent`: `None` where it throws (a `%` not followed by two hexadecimal digits, or bytes that are not UTF-8).
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digits = bytes.get(index + 1..index + 3)?;
            if !digits.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The text, and up to two further decodings of it (`+` read as a space first), stopping at the first that changes nothing.
fn decoded_url_candidates(raw: &str) -> Vec<String> {
    let mut values = vec![raw.to_owned()];
    for _ in 0..2 {
        let current = &values[values.len() - 1];
        let Some(decoded) = decode_uri_component(&current.replace('+', "%20")) else { break };
        if decoded == *current {
            break;
        }
        values.push(decoded);
    }
    values
}

/// Whether an agent-supplied URL carries a credential: a token shape in the URL or in its decoded forms, a secret-named query
/// parameter with a value, or a `code` parameter of eight or more characters.
pub fn url_contains_secret(raw: &str) -> bool {
    if decoded_url_candidates(raw).iter().any(|candidate| TOKEN_REDACTIONS.iter().any(|(pattern, _)| pattern.is_match(candidate))) {
        return true;
    }
    // The caller owns URL syntax validation; the raw token detection above still applies to what does not parse.
    let Ok(parsed) = Url::parse(raw) else { return false };
    parsed.query_pairs().any(|(key, value)| {
        !value.is_empty() && (SECRET_PARAMETER.is_match(&key) || (key.to_lowercase() == "code" && utf16_len(&value) >= 8))
    })
}

/// A `Set-Cookie` or `Cookie` header line (`Name: value`) with its whole value replaced; every such line of a multi-line text.
pub fn redact_set_cookie(text: &str) -> String {
    COOKIE_LINE.replace_all_with(text, |caps| format!("{}[REDACTED]", caps.get(1).unwrap_or_default()))
}

/// The text with credentials in URLs, token shapes, secret-named query parameters and assignments, and cookie lines replaced.
pub fn redact_browser_text(value: &str) -> String {
    let mut text = URL_CREDENTIALS
        .replace_all_with(value, |caps| format!("{}{}:***@", caps.get(1).unwrap_or_default(), caps.get(2).unwrap_or_default()));
    // Consume the complete auth value before an assignment can remove just its scheme and leave an opaque credential behind.
    for (pattern, marker) in TOKEN_REDACTIONS.iter() {
        text = pattern.replace_all_with(&text, |_| (*marker).to_owned());
    }
    text = QUERY_SECRET.replace_all_with(&text, |caps| format!("{}[REDACTED]", caps.get(1).unwrap_or_default()));
    text = ASSIGNED_SECRET.replace_all_with(&text, |caps| format!("{}[REDACTED]", caps.get(1).unwrap_or_default()));
    redact_set_cookie(&text)
}

/// Every occurrence of a stored credential replaced, never by more characters than it had (a short secret becomes a mask of its
/// own length, a long one the marker).
pub fn redact_known_secrets(value: &str, secrets: &[String]) -> String {
    const MARKER: &str = "[REDACTED STORED CREDENTIAL]";
    let marker_length = utf16_len(MARKER);
    let mut redacted = value.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        let length = utf16_len(secret);
        let mask = "*".repeat(length);
        let mut replacement = if mask == *secret { "\u{2022}".repeat(length) } else { mask };
        if length >= marker_length && secret != MARKER {
            replacement = MARKER.to_owned();
        }
        redacted = redacted.replace(secret.as_str(), &replacement);
    }
    redacted
}

/// What a caller sends out for a text: the patterns of [`redact_browser_text`], then the stored credentials of the page.
pub fn redact_text(value: &str, known: &[String]) -> String {
    redact_known_secrets(&redact_browser_text(value), known)
}

/// A URL with its user and password and every secret-named query value replaced; the result goes through
/// [`redact_browser_text`] as well. What does not parse as a URL is redacted as text.
pub fn redact_url(value: &str) -> String {
    let Ok(mut parsed) = Url::parse(value) else { return redact_browser_text(value) };
    if !parsed.username().is_empty() {
        let _ = parsed.set_username("[REDACTED]");
    }
    if parsed.password().is_some_and(|password| !password.is_empty()) {
        let _ = parsed.set_password(Some("[REDACTED]"));
    }
    let secret = |key: &str| key.to_lowercase() == "code" || REDACTED_PARAMETER.is_match(key);
    let pairs: Vec<(String, String)> = parsed.query_pairs().map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
    if pairs.iter().any(|(key, _)| secret(key)) {
        // `URLSearchParams.set`: the first pair of a name takes the marker, its later pairs are dropped.
        let mut seen = HashSet::new();
        let mut kept = Vec::with_capacity(pairs.len());
        for (key, value) in pairs {
            if !secret(&key) {
                kept.push((key, value));
            } else if seen.insert(key.clone()) {
                kept.push((key, "[REDACTED]".to_owned()));
            }
        }
        parsed.query_pairs_mut().clear().extend_pairs(kept);
    }
    redact_browser_text(parsed.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_follows_decode_uri_component() {
        assert_eq!(decode_uri_component("a%20b").as_deref(), Some("a b"));
        assert_eq!(decode_uri_component("%zz"), None);
        assert_eq!(decode_uri_component("%+1"), None);
        assert_eq!(decode_uri_component("%C0%80"), None);
        assert_eq!(decode_uri_component("%E2%82%AC").as_deref(), Some("\u{20ac}"));
        assert_eq!(decode_uri_component("%2"), None);
    }

    #[test]
    fn a_secret_is_never_amplified_and_a_repeat_is_stable() {
        let known = ["a".to_owned(), "*".to_owned()];
        let source = "a password can be short: a";
        let out = redact_known_secrets(source, &known);
        assert!(!out.contains('a') && utf16_len(&out) <= utf16_len(source));
        let once = redact_browser_text("Authorization: Bearer MIXDOG_SYNTHETIC_ONLY_0123456789");
        assert_eq!(once, "Authorization: [REDACTED]");
        assert_eq!(redact_browser_text(&once), once);
    }
}
