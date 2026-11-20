//! The statistics period a view names: trailing ranges, custom date and clock ranges, and what is refused.

use mixdog_ledger::LedgerError;
use mixdog_ledger::period::PeriodRequest;
use mixdog_ledger::period::resolve_usage_stats_period;

/// 2026-10-26T04:53:20Z: far from any day edge in every zone.
const NOW: i64 = 1_793_000_000_000;
const HOUR: i64 = 3_600_000;

fn request(view: &str) -> PeriodRequest {
    PeriodRequest { view: Some(view.into()), ..PeriodRequest::default() }
}

fn custom(start_day: &str, end_day: &str, start_time: Option<&str>, end_time: Option<&str>) -> PeriodRequest {
    PeriodRequest {
        start_day: Some(start_day.into()),
        end_day: Some(end_day.into()),
        start_time: start_time.map(Into::into),
        end_time: end_time.map(Into::into),
        ..request("custom")
    }
}

/// The message and kind (`RangeError` when true) of a refused request.
fn refused(request: &PeriodRequest) -> (bool, &'static str) {
    match resolve_usage_stats_period(request, NOW) {
        Err(LedgerError::Period { range, message }) => (range, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn the_default_view_is_the_last_24_hours() {
    let period = resolve_usage_stats_period(&PeriodRequest::default(), NOW).unwrap();
    assert_eq!(period["view"], "hour");
    assert_eq!(period["fromMs"], NOW - 24 * HOUR);
    assert_eq!(period["toMs"], NOW);
    assert_eq!(period["days"], 1);
    assert_eq!(period["isCurrent"], true);
}

#[test]
fn year_and_all_cover_the_whole_retained_history_up_to_now() {
    for view in ["year", "all"] {
        let period = resolve_usage_stats_period(&request(view), NOW).unwrap();
        assert_eq!((period["fromMs"].as_i64(), period["toMs"].as_i64()), (Some(0), Some(NOW)), "{view}");
        assert_eq!(period["isCurrent"], true);
        assert!(period["previousAnchor"].is_null() && period["nextAnchor"].is_null());
    }
}

#[test]
fn a_calendar_view_spans_its_days_ending_on_the_anchor_and_pages_to_its_neighbours() {
    for (view, days) in [("7d", 7), ("day", 30), ("week", 90), ("month", 365)] {
        let period = resolve_usage_stats_period(&request(view), NOW).unwrap();
        assert_eq!(period["days"], days, "{view}");
        assert_eq!(period["isCurrent"], true);
        assert!(period["nextAnchor"].is_null(), "the current window has nothing after it");
        assert!(period["previousAnchor"].is_string());
        assert_eq!(period["toMs"], NOW, "a window ending today stops at now");
    }
    let anchored = PeriodRequest { anchor: Some("2026-03-15".into()), ..request("7d") };
    let period = resolve_usage_stats_period(&anchored, NOW).unwrap();
    assert_eq!(period["anchor"], "2026-03-15");
    assert_eq!(period["endDay"], "2026-03-15");
    assert_eq!(period["startDay"], "2026-03-09");
    assert_eq!(period["previousAnchor"], "2026-03-08");
    assert_eq!(period["nextAnchor"], "2026-03-22");
    assert_eq!(period["isCurrent"], false);
}

#[test]
fn a_custom_range_is_whole_days_narrowed_by_clock_times() {
    let period = resolve_usage_stats_period(&custom("2026-01-10", "2026-01-12", None, None), NOW).unwrap();
    assert_eq!(period["days"], 3);
    assert_eq!((period["startDay"].as_str(), period["endDay"].as_str()), (Some("2026-01-10"), Some("2026-01-12")));
    assert_eq!(period["isCurrent"], false);
    // The end spans its unit whole: 09:00-18:00 keeps all of the minute 18:00, 09:00:30-09:00:40 all of that second.
    let whole = period["toMs"].as_i64().unwrap() - period["fromMs"].as_i64().unwrap();
    assert_eq!(whole, 3 * 24 * HOUR - 1, "midnight to the last millisecond of the last day, in a zone without a clock change");

    let narrowed = resolve_usage_stats_period(&custom("2026-01-10", "2026-01-10", Some("09:00"), Some("18:00")), NOW).unwrap();
    assert_eq!(narrowed["toMs"].as_i64().unwrap() - narrowed["fromMs"].as_i64().unwrap(), 9 * HOUR + 59_999);
    assert_eq!((narrowed["startTime"].as_str(), narrowed["endTime"].as_str()), (Some("09:00"), Some("18:00")));
    let seconds = resolve_usage_stats_period(&custom("2026-01-10", "2026-01-10", Some("09:00:30"), Some("09:00:40")), NOW).unwrap();
    assert_eq!(seconds["toMs"].as_i64().unwrap() - seconds["fromMs"].as_i64().unwrap(), 10_999);
}

#[test]
fn a_range_that_cannot_be_served_is_refused_with_its_reason() {
    assert_eq!(refused(&request("fortnight")), (false, "Unknown usage statistics view"));
    assert_eq!(refused(&PeriodRequest { start_day: Some("2026-03-01".into()), ..request("custom") }), (false, "Usage range requires a start and end date"));
    assert_eq!(refused(&PeriodRequest { anchor: Some("March 3".into()), ..request("day") }), (false, "Usage period anchor must be a calendar date"));
    assert_eq!(
        refused(&PeriodRequest { anchor: Some("2026-02-30".into()), ..request("day") }),
        (false, "Usage period anchor must be a valid calendar date from 1970 onward")
    );
    assert_eq!(
        refused(&PeriodRequest { anchor: Some("1969-12-31".into()), ..request("day") }),
        (false, "Usage period anchor must be a valid calendar date from 1970 onward")
    );
    assert_eq!(refused(&custom("2026-03-01", "2026-03-02", Some("9:00"), None)), (false, "Usage range start time must be a HH:MM clock time"));
    assert_eq!(refused(&custom("2026-03-01", "2026-03-02", None, Some("24:00"))), (false, "Usage range end time must be a HH:MM clock time"));
    assert_eq!(refused(&custom("2026-03-05", "2026-03-02", None, None)), (true, "Usage range start must not follow its end"));
    assert_eq!(refused(&custom("2026-03-01", "2027-03-02", None, None)), (true, "Usage range cannot include future dates"));
    assert_eq!(refused(&custom("2026-03-01", "2026-03-01", Some("18:00"), Some("09:00"))), (true, "Usage range start must not follow its end"));
    assert!(matches!(
        resolve_usage_stats_period(&request("hour"), 0),
        Err(LedgerError::Period { range: false, message: "Usage period requires a valid current time" })
    ));
}
