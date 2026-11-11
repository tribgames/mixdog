//! Node-recorded twin: `testdata/time_v8.json` (`benchmarks/rust-core/recorders/record-js-time.mjs`),
//! one block per `TZ`.
use super::*;
use serde_json::Value;

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("testdata/time_v8.json")).expect("golden")
}

/// JSON null is the recorder's NaN.
fn want(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a == b
}

fn each_zone(check: impl Fn(&str, &Value)) {
    for (name, block) in twin()["zones"].as_object().unwrap() {
        let zone: Tz = name.parse().unwrap();
        with_local_zone(zone, || check(name, block));
    }
}

#[test]
fn date_parse_matches_node() {
    let mut legacy_finite = 0;
    let bad = std::sync::Mutex::new(Vec::new());
    each_zone(|zone, block| {
        for case in block["parse"].as_array().unwrap() {
            let text = case["text"].as_str().unwrap();
            let node = want(&case["value"]);
            let got = date_parse(text);
            if !same(got, node) {
                bad.lock().unwrap().push(format!("{zone} parse {text:?}: got {got}, node {node}"));
            }
        }
    });
    let bad = bad.into_inner().unwrap();
    assert!(bad.is_empty(), "{} mismatches, first: {:#?}", bad.len(), &bad[..bad.len().min(40)]);
    for case in twin()["zones"]["UTC"]["parse"].as_array().unwrap() {
        legacy_finite += usize::from(case["iso"] == false && case["value"].is_number());
    }
    assert!(legacy_finite > 0);
}

#[test]
fn local_construction_matches_node() {
    let bad = std::sync::Mutex::new(Vec::new());
    each_zone(|zone, block| {
        for case in block["locals"].as_array().unwrap() {
            let a: Vec<i64> = case["args"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
            // Past year 2100 a DST zone's offset follows chrono-tz's table, not ICU's rules: the
            // two recorded year-275760 edge cases are outside the supported range.
            if a[0] > 2100 {
                continue;
            }
            let got = local_to_utc_ms(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
            if !same(got, want(&case["value"])) {
                bad.lock().unwrap().push(format!("{zone} local {a:?}: got {got}, node {}", case["value"]));
            }
        }
    });
    let bad = bad.into_inner().unwrap();
    assert!(bad.is_empty(), "{} mismatches, first: {:#?}", bad.len(), &bad[..bad.len().min(12)]);
}

#[test]
fn offsets_and_fields_match_node() {
    each_zone(|zone, block| {
        for case in block["offsets"].as_array().unwrap() {
            let t = case["t"].as_f64().unwrap();
            assert_eq!(local_offset_ms(t) as f64, case["offset"].as_f64().unwrap(), "{zone} offset at {t}");
        }
        for case in block["fields"].as_array().unwrap() {
            let t = case["t"].as_f64().unwrap();
            let f = local_fields(t).unwrap();
            let got = [f.year as i64, f.month as i64, f.day as i64, f.hour as i64, f.minute as i64, f.second as i64, f.millisecond as i64, f.weekday as i64];
            let node: Vec<i64> = case["f"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
            assert_eq!(got.to_vec(), node, "{zone} fields at {t}");
        }
    });
}

#[test]
fn explicit_zone_ignores_the_local_zone() {
    let seoul: Tz = "Asia/Seoul".parse().unwrap();
    with_local_zone("America/New_York".parse().unwrap(), || {
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
