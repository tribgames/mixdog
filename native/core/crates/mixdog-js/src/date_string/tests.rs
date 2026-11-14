use super::*;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!(
        "../../fixtures/js-date-string/golden.json"
    ))
    .unwrap()
}
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

#[test]
fn data_versions_and_coverage_are_explicit() {
    assert_eq!(DATA["icu"], "77.1");
    assert_eq!(DATA["cldr"], "47.0");
    assert_eq!(DATA["tz"], chrono_tz::IANA_TZDB_VERSION);
    assert_eq!(DATA["locales"].as_object().unwrap().len(), 526);
    assert_eq!(DATA["zoneNames"].as_object().unwrap().len(), 639);
    let g = golden();
    assert!(g["dates"].as_array().unwrap().len() > 3800);
    assert!(g["names"].as_array().unwrap().len() > 4000);
}
