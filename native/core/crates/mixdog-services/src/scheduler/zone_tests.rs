//! The schedule zone resolver against what `Intl.DateTimeFormat` does: every expected value below is from a Node
//! v22.20.0 run (ICU 77.1, CLDR 47, tzdata 2025b) of `new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName:
//! 'longOffset' })` over the spelling at the six instants of `INSTANTS`; `None` is a spelling `Intl` refused (RangeError).

use chrono::{DateTime, Offset, TimeZone, Utc};

use super::cron::CronExpr;
use super::zone::{ScheduleZone, resolve};

/// 2025-01-15T12:00Z, 2025-07-15T12:00Z, 2025-04-27T06:59:59Z, 2025-04-27T07:00:00Z, 2025-10-26T05:59:59Z, 2025-10-26T06:00:00Z.
const INSTANTS: [&str; 6] =
    ["2025-01-15T12:00:00Z", "2025-07-15T12:00:00Z", "2025-04-27T06:59:59Z", "2025-04-27T07:00:00Z", "2025-10-26T05:59:59Z", "2025-10-26T06:00:00Z"];

/// A spelling, and the offset in seconds east of UTC `Intl` gave at each instant (`None`: refused).
const INTL: &[(&str, Option<[i32; 6]>)] = &[
    ("utc", Some([0, 0, 0, 0, 0, 0])),
    ("UTC", Some([0, 0, 0, 0, 0, 0])),
    ("asia/seoul", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("ASIA/SEOUL", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("Asia/Seoul", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("US/Pacific", Some([-28800, -25200, -25200, -25200, -25200, -25200])),
    ("us/pacific", Some([-28800, -25200, -25200, -25200, -25200, -25200])),
    ("EST", Some([-18000, -18000, -18000, -18000, -18000, -18000])),
    ("est", Some([-18000, -18000, -18000, -18000, -18000, -18000])),
    ("gmt", Some([0, 0, 0, 0, 0, 0])),
    ("Etc/GMT-14", Some([50400, 50400, 50400, 50400, 50400, 50400])),
    ("America/New_York", Some([-18000, -14400, -14400, -14400, -14400, -14400])),
    ("Europe/London", Some([0, 3600, 3600, 3600, 0, 0])),
    ("Australia/Lord_Howe", Some([39600, 37800, 37800, 37800, 39600, 39600])),
    ("Asia/Kolkata", Some([19800, 19800, 19800, 19800, 19800, 19800])),
    ("Asia/Katmandu", Some([20700, 20700, 20700, 20700, 20700, 20700])),
    ("+09:00", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("+0900", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("+09", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("-03:30", Some([-12600, -12600, -12600, -12600, -12600, -12600])),
    ("-0330", Some([-12600, -12600, -12600, -12600, -12600, -12600])),
    ("-03", Some([-10800, -10800, -10800, -10800, -10800, -10800])),
    ("+00:00", Some([0, 0, 0, 0, 0, 0])),
    ("-00:00", Some([0, 0, 0, 0, 0, 0])),
    ("+0000", Some([0, 0, 0, 0, 0, 0])),
    ("+00", Some([0, 0, 0, 0, 0, 0])),
    ("+14:00", Some([50400, 50400, 50400, 50400, 50400, 50400])),
    ("-23:59", Some([-86340, -86340, -86340, -86340, -86340, -86340])),
    ("+23", Some([82800, 82800, 82800, 82800, 82800, 82800])),
    ("+0930", Some([34200, 34200, 34200, 34200, 34200, 34200])),
    ("\u{2212}03:00", Some([-10800, -10800, -10800, -10800, -10800, -10800])),
    ("+05:45", Some([20700, 20700, 20700, 20700, 20700, 20700])),
    ("PST", Some([-28800, -25200, -25200, -25200, -25200, -25200])),
    ("CST", Some([-21600, -18000, -18000, -18000, -18000, -18000])),
    ("ACT", Some([34200, 34200, 34200, 34200, 34200, 34200])),
    ("AET", Some([39600, 36000, 36000, 36000, 39600, 39600])),
    ("AGT", Some([-10800, -10800, -10800, -10800, -10800, -10800])),
    ("ART", Some([7200, 10800, 10800, 10800, 10800, 10800])),
    ("AST", Some([-32400, -28800, -28800, -28800, -28800, -28800])),
    ("BET", Some([-10800, -10800, -10800, -10800, -10800, -10800])),
    ("BST", Some([21600, 21600, 21600, 21600, 21600, 21600])),
    ("CAT", Some([7200, 7200, 7200, 7200, 7200, 7200])),
    ("CNT", Some([-12600, -9000, -9000, -9000, -9000, -9000])),
    ("CTT", Some([28800, 28800, 28800, 28800, 28800, 28800])),
    ("EAT", Some([10800, 10800, 10800, 10800, 10800, 10800])),
    ("ECT", Some([3600, 7200, 7200, 7200, 3600, 3600])),
    ("IET", Some([-18000, -14400, -14400, -14400, -14400, -14400])),
    ("IST", Some([19800, 19800, 19800, 19800, 19800, 19800])),
    ("JST", Some([32400, 32400, 32400, 32400, 32400, 32400])),
    ("MIT", Some([46800, 46800, 46800, 46800, 46800, 46800])),
    ("NET", Some([14400, 14400, 14400, 14400, 14400, 14400])),
    ("NST", Some([46800, 43200, 43200, 43200, 46800, 46800])),
    ("PLT", Some([18000, 18000, 18000, 18000, 18000, 18000])),
    ("PNT", Some([-25200, -25200, -25200, -25200, -25200, -25200])),
    ("PRT", Some([-14400, -14400, -14400, -14400, -14400, -14400])),
    ("SST", Some([39600, 39600, 39600, 39600, 39600, 39600])),
    ("VST", Some([25200, 25200, 25200, 25200, 25200, 25200])),
    ("pst", Some([-28800, -25200, -25200, -25200, -25200, -25200])),
    ("Canada/East-Saskatchewan", Some([-21600, -21600, -21600, -21600, -21600, -21600])),
    ("US/Pacific-New", Some([-28800, -25200, -25200, -25200, -25200, -25200])),
    ("SystemV/AST4", Some([-14400, -14400, -14400, -14400, -14400, -14400])),
    ("SystemV/AST4ADT", Some([-14400, -10800, -10800, -10800, -14400, -14400])),
    ("SystemV/CST6", Some([-21600, -21600, -21600, -21600, -21600, -21600])),
    ("SystemV/CST6CDT", Some([-21600, -18000, -21600, -21600, -18000, -18000])),
    ("SystemV/EST5", Some([-18000, -18000, -18000, -18000, -18000, -18000])),
    ("SystemV/EST5EDT", Some([-18000, -14400, -18000, -14400, -14400, -18000])),
    ("SystemV/HST10", Some([-36000, -36000, -36000, -36000, -36000, -36000])),
    ("SystemV/MST7", Some([-25200, -25200, -25200, -25200, -25200, -25200])),
    ("SystemV/MST7MDT", Some([-25200, -21600, -25200, -25200, -21600, -21600])),
    ("SystemV/PST8", Some([-28800, -28800, -28800, -28800, -28800, -28800])),
    ("SystemV/PST8PDT", Some([-28800, -25200, -28800, -28800, -25200, -25200])),
    ("SystemV/YST9", Some([-32400, -32400, -32400, -32400, -32400, -32400])),
    ("SystemV/YST9YDT", Some([-32400, -28800, -32400, -32400, -28800, -28800])),
    ("systemv/est5edt", Some([-18000, -14400, -18000, -14400, -14400, -18000])),
    ("Mars/Olympus", None),
    ("+24:00", None),
    ("-24:00", None),
    ("+9", None),
    ("+9:00", None),
    ("+09:60", None),
    ("+09:00:00", None),
    ("UTC+9", None),
    ("GMT+9", None),
    ("Z", None),
    ("UT", None),
    ("Local", None),
    ("Etc/Unknown", None),
    ("Etc/GMT+14", None),
    ("SystemV/YST9ADT", None),
    ("09:00", None),
    ("+ 09:00", None),
    ("+1", None),
    ("+123", None),
];

fn utc(text: &str) -> DateTime<Utc> {
    text.parse().unwrap()
}

/// A spelling is valid exactly when `Intl` accepted it, and the zone it resolves to has the offset `Intl` gave at each instant.
#[test]
fn the_resolver_accepts_what_intl_accepts_with_the_offsets_intl_gives() {
    for (spelling, expected) in INTL {
        let resolved = resolve(spelling);
        let Some(offsets) = expected else {
            assert!(resolved.is_none(), "Intl refused {spelling:?}");
            continue;
        };
        let zone = resolved.unwrap_or_else(|| panic!("Intl accepted {spelling:?}"));
        for (instant, want) in INSTANTS.iter().zip(offsets) {
            assert_eq!(zone.offset_from_utc_datetime(&utc(instant).naive_utc()).fix().local_minus_utc(), *want, "{spelling:?} at {instant}");
        }
    }
}

/// Every one of the 597 tzdata names `Intl` accepts is accepted too, in any letter case.
#[test]
fn every_tzdata_name_resolves_in_any_case() {
    for zone in chrono_tz::TZ_VARIANTS {
        let name = zone.name();
        assert_eq!(resolve(name), Some(ScheduleZone::Named(zone)), "{name}");
        assert!(resolve(&name.to_ascii_lowercase()).is_some() && resolve(&name.to_ascii_uppercase()).is_some(), "{name}");
    }
}

/// A fixed offset and a `SystemV` rule zone run a cron in their own wall time.
#[test]
fn a_cron_runs_in_a_fixed_offset_and_in_a_rule_zone() {
    let daily = CronExpr::parse("0 9 * * *").unwrap();
    let plus9 = resolve("+09:00").unwrap();
    assert_eq!(daily.next_after(utc("2025-01-01T09:00:00Z"), plus9), Some(utc("2025-01-02T00:00:00Z")));
    let rule = resolve("SystemV/EST5EDT").unwrap();
    // 02:30 on 2025-04-27 does not exist (02:00 standard becomes 03:00 daylight): that day does not fire.
    let skipped = CronExpr::parse("30 2 * * *").unwrap();
    assert_eq!(skipped.next_after(utc("2025-04-26T12:00:00Z"), rule), Some(utc("2025-04-28T06:30:00Z")));
    // 01:30 on 2025-10-26 happens twice: it fires at the first, the daylight one.
    let twice = CronExpr::parse("30 1 * * *").unwrap();
    assert_eq!(twice.next_after(utc("2025-10-25T12:00:00Z"), rule), Some(utc("2025-10-26T05:30:00Z")));
}
