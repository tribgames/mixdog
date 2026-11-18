use super::*;
#[cfg(node_twin)]
fn timestamp(value: &Value) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| match value.as_str().unwrap() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            s => s.parse().unwrap(),
        })
}

#[test]
fn current_process_entry_uses_regional_locale_and_existing_zone_override() {
    let locale = crate::default_locale::default_locale_id();
    for zone in [
        crate::time::Tz::UTC,
        crate::time::Tz::America__New_York,
        crate::time::Tz::Asia__Seoul,
    ] {
        crate::time::with_local_zone(zone, || {
            for time in [0.0, -1.0, 1719792000000.0, -0.5] {
                assert_eq!(
                    date_to_string(time),
                    format_date(time, zone.name(), locale, clock_seconds(), false)
                );
            }
        });
    }
    assert_eq!(date_to_string(f64::NAN), "Invalid Date");
}


#[cfg(node_twin)]
fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!(
        "../../fixtures/js-date-string/golden.json"
    ))
    .unwrap()
}
#[cfg(node_twin)]
#[test]
fn all_recorded_date_strings_and_localized_names_match_node() {
    let g = golden();
    assert_eq!(g["oracle"]["icu"], "77.1");
    assert_eq!(g["oracle"]["tz"], "2025b");
    let locale = string(&g["oracle"]["defaultLocale"]);
    let now = int(&g["referenceNow"]);
    let mut failures = Vec::new();
    for (i, row) in g["dates"].as_array().unwrap().iter().enumerate() {
        let got = format_date(
            timestamp(&row["time"]),
            string(&row["zone"]),
            locale,
            now,
            false,
        );
        if got != string(&row["value"]) {
            failures.push(format!(
                "date {i} {} {}: want {}, got {got}",
                row["zone"], row["time"], row["value"]
            ))
        }
    }
    for (i, row) in g["names"].as_array().unwrap().iter().enumerate() {
        let (z, canonical) = zone(string(&row["zone"]));
        let got = display_name(
            z,
            canonical,
            string(&row["locale"]),
            row["daylight"].as_bool().unwrap(),
            now,
        );
        if got != string(&row["value"]) {
            failures.push(format!(
                "name {i} {} {} daylight={}: want {}, got {got}",
                row["locale"], row["zone"], row["daylight"], row["value"]
            ))
        }
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
#[test]
fn data_versions_and_coverage_are_explicit() {
    assert_eq!(DATA["icu"], "77.1");
    assert_eq!(DATA["cldr"], "47.0");
    assert_eq!(DATA["tz"], chrono_tz::IANA_TZDB_VERSION);
    assert_eq!(DATA["locales"].as_object().unwrap().len(), 526);
    assert_eq!(DATA["zoneNames"].as_object().unwrap().len(), 639);
}

#[cfg(node_twin)]
#[test]
fn the_recording_covers_thousands_of_dates_and_names() {
    let g = golden();
    assert!(g["dates"].as_array().unwrap().len() > 3800);
    assert!(g["names"].as_array().unwrap().len() > 4000);
}

#[test]
fn a_date_prints_as_weekday_month_day_year_time_offset_and_zone_name() {
    let print = |time: f64, zone: &str| format_date(time, zone, "en-US", 1_700_000_000, false);
    assert_eq!(print(0.0, "UTC"), "Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)");
    assert_eq!(print(0.0, "Asia/Seoul"), "Thu Jan 01 1970 09:00:00 GMT+0900 (Korean Standard Time)");
    assert_eq!(print(1_719_835_200_000.0, "America/New_York"), "Mon Jul 01 2024 08:00:00 GMT-0400 (Eastern Daylight Time)");
    assert_eq!(print(1_704_110_400_000.0, "America/New_York"), "Mon Jan 01 2024 07:00:00 GMT-0500 (Eastern Standard Time)");
}

#[test]
fn a_negative_year_and_the_time_before_the_epoch_are_written_with_their_own_fields() {
    let print = |time: f64| format_date(time, "UTC", "en-US", 1_700_000_000, false);
    assert_eq!(print(-1.0), "Wed Dec 31 1969 23:59:59 GMT+0000 (Coordinated Universal Time)");
}

#[test]
fn an_invalid_time_prints_invalid_date() {
    assert_eq!(date_to_string(f64::NAN), "Invalid Date");
}
