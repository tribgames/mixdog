//! Timestamps as the agent tool shows them: `new Date(ms).toISOString()` and the elapsed label
//! of `elapsedFromStamps`.

use mixdog_js::time::date_parse;
use mixdog_js::js_trim;

/// `new Date(ms).toISOString()` for a valid epoch-millisecond time.
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Civil-from-days (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem % 3_600_000 / 60_000,
        rem % 60_000 / 1000,
        rem % 1000
    )
}

fn format_elapsed_ms(ms: f64) -> String {
    if !ms.is_finite() || ms < 0.0 {
        return String::new();
    }
    let total = (ms / 1000.0).floor() as u64;
    if total < 60 {
        return format!("{total}s");
    }
    let (min, sec) = (total / 60, total % 60);
    if min < 60 {
        return if sec > 0 { format!("{min}m{sec}s") } else { format!("{min}m") };
    }
    let (hr, rem) = (min / 60, min % 60);
    if rem > 0 { format!("{hr}h{rem}m") } else { format!("{hr}h") }
}

/// `elapsedFromStamps`: `3m12s`, with ` (running)` while unfinished; `None` for no valid start.
pub fn elapsed_from_stamps(started_at: &str, finished_at: &str, now_ms: i64) -> Option<String> {
    let start = date_parse(js_trim(started_at));
    if !start.is_finite() {
        return None;
    }
    let finish = date_parse(js_trim(finished_at));
    let end = if finish.is_finite() { finish } else { now_ms as f64 };
    let label = format_elapsed_ms(end - start);
    if label.is_empty() {
        return None;
    }
    Some(if finish.is_finite() { label } else { format!("{label} (running)") })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_ms(1_793_925_139_716), "2026-11-06T00:32:19.716Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_from_ms(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn elapsed_labels() {
        let at = |s: i64| iso_from_ms(s * 1000);
        assert_eq!(elapsed_from_stamps(&at(0), &at(192), 0).as_deref(), Some("3m12s"));
        assert_eq!(elapsed_from_stamps(&at(0), &at(7200), 0).as_deref(), Some("2h"));
        assert_eq!(elapsed_from_stamps(&at(0), "", 59_000).as_deref(), Some("59s (running)"));
        assert_eq!(elapsed_from_stamps("nope", "", 5), None);
        assert_eq!(elapsed_from_stamps(&at(10), &at(5), 0), None);
    }
}
