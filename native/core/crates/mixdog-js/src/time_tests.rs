//! The `Date` time arithmetic: the local zone, `Date.parse`, and local time construction.
use super::*;

fn ny() -> Tz {
    "America/New_York".parse().unwrap()
}

fn seoul() -> Tz {
    "Asia/Seoul".parse().unwrap()
}

const HOUR: i64 = 3_600_000;

#[test]
fn explicit_zone_ignores_the_local_zone() {
    let seoul = seoul();
    with_local_zone(ny(), || {
        assert_eq!(local_offset_ms_in(seoul, 0.0), 9 * 3_600_000);
        assert_eq!(date_parse_in(seoul, "2025-03-01T00:00:00"), date_parse("2025-03-01T00:00:00Z") - 9.0 * 3_600_000.0);
        assert_eq!(local_fields_in(seoul, 0.0).unwrap().hour, 9);
    });
}

#[test]
fn override_is_scoped_to_the_call() {
    let before = local_zone();
    with_local_zone("Asia/Seoul".parse().unwrap(), || assert_eq!(local_offset_ms(0.0), 9 * 3_600_000));
    assert_eq!(local_zone(), before);
}

#[test]
fn the_offset_is_east_positive_and_follows_daylight_saving() {
    with_local_zone(ny(), || {
        let january = utc_to_ms(2024, 1, 15, 12, 0, 0, 0);
        let july = utc_to_ms(2024, 7, 15, 12, 0, 0, 0);
        assert_eq!(local_offset_ms(january), -5 * HOUR);
        assert_eq!(local_offset_ms(july), -4 * HOUR);
    });
    with_local_zone("UTC".parse().unwrap(), || assert_eq!(local_offset_ms(1e12), 0));
    assert_eq!(local_offset_ms(f64::NAN), 0);
}

#[test]
fn local_fields_are_the_wall_clock_of_the_zone() {
    with_local_zone(seoul(), || {
        let fields = local_fields(utc_to_ms(2024, 2, 29, 20, 30, 15, 250)).unwrap();
        // 2024-03-01 05:30:15.250 in Seoul, a Friday.
        assert_eq!((fields.year, fields.month, fields.day, fields.hour, fields.minute, fields.second, fields.millisecond), (2024, 3, 1, 5, 30, 15, 250));
        assert_eq!(fields.weekday, 5);
    });
    assert!(local_fields(f64::NAN).is_none());
}

#[test]
fn local_construction_skips_a_missing_hour_forward_and_takes_the_first_of_a_repeated_hour() {
    with_local_zone(ny(), || {
        // 2024-03-10 02:30 does not exist in New York: it takes the offset from before the change (-5h).
        assert_eq!(local_to_utc_ms(2024, 3, 10, 2, 30, 0, 0), utc_to_ms(2024, 3, 10, 7, 30, 0, 0));
        // 2024-11-03 01:30 happens twice: the first (-4h) is used.
        assert_eq!(local_to_utc_ms(2024, 11, 3, 1, 30, 0, 0), utc_to_ms(2024, 11, 3, 5, 30, 0, 0));
        assert_eq!(local_to_utc_ms(2024, 7, 1, 0, 0, 0, 0), utc_to_ms(2024, 7, 1, 4, 0, 0, 0));
    });
}

#[test]
fn local_construction_carries_overflowing_fields() {
    with_local_zone("UTC".parse().unwrap(), || {
        assert_eq!(local_to_utc_ms(2024, 1, 31, 24, 0, 0, 0), utc_to_ms(2024, 2, 1, 0, 0, 0, 0));
        assert_eq!(local_to_utc_ms(2024, 2, 30, 0, 0, 0, 0), utc_to_ms(2024, 3, 1, 0, 0, 0, 0));
    });
}

#[test]
fn an_iso_date_without_a_time_is_utc_and_with_a_time_but_no_offset_is_local() {
    with_local_zone(seoul(), || {
        assert_eq!(date_parse("2000-01-01"), 946_684_800_000.0);
        assert_eq!(date_parse("2000-01-01T00:00:00"), 946_684_800_000.0 - 9.0 * HOUR as f64);
        assert_eq!(date_parse("2000-01-01T00:00:00Z"), 946_684_800_000.0);
        assert_eq!(date_parse("2000-01-01T09:00:00.123+09:00"), 946_684_800_123.0);
        assert_eq!(date_parse("1970-01-01T00:00:00.5Z"), 500.0);
    });
}

#[test]
fn iso_year_forms_and_the_time_value_range() {
    assert_eq!(date_parse("1970"), 0.0);
    assert_eq!(date_parse("1970-02"), 31.0 * 86_400_000.0);
    assert_eq!(date_parse("+275760-09-13T00:00:00.000Z"), 8.64e15);
    assert!(date_parse("+275760-09-13T00:00:00.001Z").is_nan(), "beyond the largest time value");
    assert_eq!(date_parse("-000001-01-01T00:00:00Z"), utc_to_ms(-1, 1, 1, 0, 0, 0, 0));
}

#[test]
fn text_that_is_not_a_date_is_nan() {
    for text in ["", "garbage", "2000-13-01", "2000-02-32", "2000-01-01T25:00:00Z", "2000-01-01T00:60:00Z", "2000-01-01T24:00:01Z"] {
        assert!(date_parse(text).is_nan(), "{text:?}");
    }
}

// V8 checks a day only against 1..=31, then MakeDay rolls the overflow into the next month (node 22:
// Date.parse("2000-02-30T00:00:00Z") = 951868800000 = 2000-03-01Z, "2000-04-31T00:00:00Z" = 957139200000 = 2000-05-01Z,
// "2000-01-01T24:00:00Z" = 946771200000 = 2000-01-02Z). ECMA-262 leaves such strings to the implementation.
#[test]
fn a_day_past_the_end_of_its_month_rolls_into_the_next_as_v8_does() {
    for (text, ms) in [
        ("2000-02-30T00:00:00Z", 951_868_800_000.0),
        ("2000-02-30", 951_868_800_000.0),
        ("2000-04-31T00:00:00Z", 957_139_200_000.0),
        ("2000-01-01T24:00:00Z", 946_771_200_000.0),
    ] {
        assert_eq!(date_parse(text), ms, "{text:?}");
    }
}

#[test]
fn the_legacy_formats_are_read_as_local_time_unless_they_name_a_zone() {
    with_local_zone("UTC".parse().unwrap(), || {
        assert_eq!(date_parse("May 6, 2024"), utc_to_ms(2024, 5, 6, 0, 0, 0, 0));
        assert_eq!(date_parse("5/6/2024 3:04 PM"), utc_to_ms(2024, 5, 6, 15, 4, 0, 0));
        assert_eq!(date_parse("Mon, 06 May 2024 10:00:00 GMT+0900"), utc_to_ms(2024, 5, 6, 1, 0, 0, 0));
        assert_eq!(date_parse("Mon, 06 May 2024 10:00:00 GMT"), utc_to_ms(2024, 5, 6, 10, 0, 0, 0));
    });
}
