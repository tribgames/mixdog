//! `runtime/shared/time-format.mjs`: the compact elapsed-time labels every surface shares (`42s`, `9m 23s`, `1h 2m 3s`,
//! `1d 3h 20m`; one formatter, in `mixdog-tui-style`) and the local and UTC timestamp labels.

use mixdog_js::time::Tz;
use mixdog_js::time::local_fields_in;
use mixdog_js::time::local_offset_ms_in;
use mixdog_js::time::local_zone;
pub use mixdog_tui_style::time_format::DurationOptions;
pub use mixdog_tui_style::time_format::format_duration;
pub use mixdog_tui_style::time_format::format_elapsed;

/// `toISOString()` of a valid time value; empty for an invalid one (`formatUtcTimestamp`).
pub fn format_utc_timestamp(ms: f64) -> String {
    let Some(fields) = local_fields_in(Tz::UTC, ms) else { return String::new() };
    let year = if (0..=9999).contains(&fields.year) {
        format!("{:04}", fields.year)
    } else {
        format!("{}{:06}", if fields.year < 0 { '-' } else { '+' }, fields.year.unsigned_abs())
    };
    format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        fields.month, fields.day, fields.hour, fields.minute, fields.second, fields.millisecond
    )
}

/// What `localTimestampParts` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalTimestampParts {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// `HH:MM:SS`.
    pub time: String,
    pub time_zone: String,
    /// `UTC+hh:mm` (a zone with no offset reads `UTC+00:00`).
    pub offset: String,
    /// The instant as an ISO string.
    pub utc: String,
}

/// `normalizeUtcOffset` of an offset in milliseconds, east positive: `UTC+09:00`, seconds dropped.
fn utc_offset_label(offset_ms: i64) -> String {
    let sign = if offset_ms < 0 { '-' } else { '+' };
    let minutes = offset_ms.abs() / 60_000;
    format!("UTC{sign}{:02}:{:02}", minutes / 60, minutes % 60)
}

/// `localTimestampParts(value, { timeZone })` of a time value: `None` for an invalid one. `time_zone` is an IANA name; the
/// process's local zone when absent. A name the zone table does not know falls back to UTC, as the `catch` of Node does.
pub fn local_timestamp_parts(ms: f64, time_zone: Option<&str>) -> Option<LocalTimestampParts> {
    let utc = format_utc_timestamp(ms);
    if utc.is_empty() {
        return None;
    }
    let (zone, label) = match time_zone {
        Some(name) => match name.parse::<Tz>() {
            Ok(zone) => (Some(zone), name.to_owned()),
            Err(_) => (None, "UTC".to_owned()),
        },
        None => {
            let zone = local_zone();
            (Some(zone), zone.name().to_owned())
        }
    };
    let Some(zone) = zone else {
        return Some(LocalTimestampParts {
            date: utc[..10].to_owned(),
            time: utc[11..19].to_owned(),
            time_zone: label,
            offset: "UTC+00:00".to_owned(),
            utc,
        });
    };
    let fields = local_fields_in(zone, ms)?;
    Some(LocalTimestampParts {
        date: format!("{:04}-{:02}-{:02}", fields.year, fields.month, fields.day),
        time: format!("{:02}:{:02}:{:02}", fields.hour, fields.minute, fields.second),
        time_zone: label,
        offset: utc_offset_label(local_offset_ms_in(zone, ms)),
        utc,
    })
}

/// `formatLocalAndUtcTimestamp(value, options)`: two lines, `Local: <date> <time> <zone> (<offset>)` and `UTC: <ISO>`.
pub fn format_local_and_utc_timestamp(ms: f64, time_zone: Option<&str>) -> String {
    match local_timestamp_parts(ms, time_zone) {
        Some(parts) => format!("Local: {} {} {} ({})\nUTC: {}", parts.date, parts.time, parts.time_zone, parts.offset, parts.utc),
        None => String::new(),
    }
}

/// `formatRecallTimestamp(value, options)`: the local minute plus the offset (`2026-11-15 09:30 +09:00`), unambiguous
/// across zones without restating the instant three ways.
pub fn format_recall_timestamp(ms: f64, time_zone: Option<&str>) -> String {
    match local_timestamp_parts(ms, time_zone) {
        Some(parts) => format!("{} {} {}", parts.date, &parts.time[..5], parts.offset.trim_start_matches("UTC")),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTANT: f64 = 1_794_735_000_000.0;

    #[test]
    fn utc_timestamps_are_iso_strings() {
        assert_eq!(format_utc_timestamp(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(format_utc_timestamp(f64::NAN), "");
        assert_eq!(format_utc_timestamp(-1.0), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn local_parts_follow_the_named_zone() {
        let parts = local_timestamp_parts(INSTANT, Some("Asia/Seoul")).expect("valid");
        assert_eq!(parts.time_zone, "Asia/Seoul");
        assert_eq!(parts.offset, "UTC+09:00");
        assert_eq!(parts.utc, format_utc_timestamp(INSTANT));
        let utc = local_timestamp_parts(INSTANT, Some("UTC")).expect("valid");
        assert_eq!(utc.offset, "UTC+00:00");
        assert_eq!(utc.date, parts.utc[..10]);
        let west = local_timestamp_parts(0.0, Some("America/New_York")).expect("valid");
        assert_eq!((west.date.as_str(), west.time.as_str(), west.offset.as_str()), ("1969-12-31", "19:00:00", "UTC-05:00"));
    }

    #[test]
    fn an_unknown_zone_falls_back_to_utc() {
        let parts = local_timestamp_parts(0.0, Some("Not/AZone")).expect("valid");
        assert_eq!((parts.time_zone.as_str(), parts.offset.as_str(), parts.time.as_str()), ("UTC", "UTC+00:00", "00:00:00"));
        assert_eq!(local_timestamp_parts(f64::NAN, Some("UTC")), None);
    }

    #[test]
    fn the_two_line_and_recall_labels_read_as_documented() {
        assert_eq!(format_local_and_utc_timestamp(0.0, Some("Asia/Seoul")), "Local: 1970-01-01 09:00:00 Asia/Seoul (UTC+09:00)\nUTC: 1970-01-01T00:00:00.000Z");
        assert_eq!(format_recall_timestamp(0.0, Some("Asia/Seoul")), "1970-01-01 09:00 +09:00");
        assert_eq!(format_recall_timestamp(0.0, Some("America/New_York")), "1969-12-31 19:00 -05:00");
        assert_eq!(format_recall_timestamp(f64::NAN, None), "");
        assert_eq!(format_local_and_utc_timestamp(f64::NAN, None), "");
    }
}
