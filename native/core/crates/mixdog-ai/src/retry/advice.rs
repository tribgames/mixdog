//! Server retry advice from typed sources (PW §3.4). Adapters call these once
//! while classifying a failed response and store the result in
//! `ProviderError::retry_after`. Zero or negative advice is no advice. Reset
//! times of quota windows are never retry advice, and prose is never parsed.

use std::time::Duration;
use std::time::SystemTime;

use serde_json::Value;

/// Case-insensitive header lookup.
pub fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
}

fn positive(millis: f64) -> Option<Duration> {
    (millis.is_finite() && millis > 0.0).then(|| Duration::from_millis(millis.ceil() as u64))
}

/// Precedence: `retry-after-ms`, `retry-after` in seconds, `retry-after` as
/// an HTTP date relative to `now`.
pub fn from_headers(headers: &[(String, String)], now: SystemTime) -> Option<Duration> {
    if let Some(ms) = header(headers, "retry-after-ms").and_then(|v| v.parse::<f64>().ok())
        && let Some(advice) = positive(ms)
    {
        return Some(advice);
    }
    let value = header(headers, "retry-after")?;
    if let Ok(seconds) = value.parse::<f64>() {
        return positive(seconds * 1000.0);
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let at: SystemTime = date.with_timezone(&chrono::Utc).into();
    at.duration_since(now).ok().filter(|d| !d.is_zero())
}

/// Google `RetryInfo.retryDelay`: a `"12.5s"` string or `{seconds, nanos}`.
pub fn google_retry_delay(delay: &Value) -> Option<Duration> {
    match delay {
        Value::String(text) => {
            let seconds = text.trim().strip_suffix('s')?.parse::<f64>().ok()?;
            positive(seconds * 1000.0)
        }
        Value::Object(fields) => {
            let number = |key: &str| match fields.get(key)? {
                Value::Number(n) => n.as_f64(),
                Value::String(s) => s.parse::<f64>().ok(),
                _ => None,
            };
            let seconds = number("seconds").unwrap_or(0.0);
            let nanos = number("nanos").unwrap_or(0.0);
            positive(seconds * 1000.0 + nanos / 1_000_000.0)
        }
        _ => None,
    }
}

/// Typed JSON `resets_in_seconds` / `reset_in_seconds` of an error body.
pub fn resets_in(error: &Value) -> Option<Duration> {
    ["resets_in_seconds", "reset_in_seconds"]
        .iter()
        .find_map(|key| error.get(*key)?.as_f64())
        .and_then(|seconds| positive(seconds * 1000.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn millisecond_header_wins_over_seconds() {
        let h = headers(&[("Retry-After", "9"), ("retry-after-ms", "1500.2")]);
        assert_eq!(
            from_headers(&h, SystemTime::UNIX_EPOCH),
            Some(Duration::from_millis(1501))
        );
    }

    #[test]
    fn seconds_round_up_and_zero_is_no_advice() {
        let now = SystemTime::UNIX_EPOCH;
        assert_eq!(
            from_headers(&headers(&[("retry-after", "0.0011")]), now),
            Some(Duration::from_millis(2))
        );
        assert_eq!(from_headers(&headers(&[("retry-after", "0")]), now), None);
        assert_eq!(from_headers(&headers(&[("retry-after", "-3")]), now), None);
    }

    #[test]
    fn http_date_is_relative_to_now() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(784_111_717);
        let h = headers(&[("retry-after", "Sun, 06 Nov 1994 08:49:37 GMT")]);
        assert_eq!(from_headers(&h, now), Some(Duration::from_secs(60)));
        assert_eq!(
            from_headers(&h, now + Duration::from_secs(61)),
            None,
            "a date in the past is no advice"
        );
    }

    #[test]
    fn google_retry_info_shapes() {
        assert_eq!(
            google_retry_delay(&json!("12.5s")),
            Some(Duration::from_millis(12_500))
        );
        assert_eq!(
            google_retry_delay(&json!({"seconds": "3", "nanos": 500_000_000})),
            Some(Duration::from_millis(3_500))
        );
        assert_eq!(google_retry_delay(&json!("soon")), None);
    }

    #[test]
    fn typed_reset_seconds_only() {
        assert_eq!(
            resets_in(&json!({"resets_in_seconds": 30})),
            Some(Duration::from_secs(30))
        );
        assert_eq!(resets_in(&json!({"message": "try again in 30 seconds"})), None);
    }
}