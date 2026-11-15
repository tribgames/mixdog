//! Exact library outputs, including UTF-16 units, exceptions, Date milliseconds and numeric bits.
//! A raw lone-surrogate mismatch is deliberately not normalised away: Value::Text must eventually
//! preserve these intermediates for concatenation and CODE to match the original engine.
use mixdog_js::time::{Tz, with_local_zone};
use mixdog_office_base::twin;
use mixdog_xlsx_formula::{ErrorValue, Failure, Value, library};
use serde_json::{Value as Json, json};

fn decode(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap()),
        Json::String(s) => Value::Text(s.clone()),
        Json::Array(a) => Value::Array(a.iter().map(decode).collect()),
        Json::Object(o) => {
            if o.contains_key("undefined") {
                Value::Undefined
            } else if let Some(e) = o.get("error") {
                Value::Error(ErrorValue::from_message(e.as_str().unwrap()).unwrap())
            } else if let Some(d) = o.get("date") {
                Value::Date(d.as_f64().unwrap())
            } else {
                panic!("unrecognised input {v}")
            }
        }
    }
}
fn encode(v: Value) -> Json {
    match v {
        Value::Undefined => json!({"undefined":true}),
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::Error(e) => json!({"error":e.message()}),
        Value::Number(n) => json!({"numberBits":format!("{:016x}",n.to_bits())}),
        Value::Date(n) => json!({"dateBits":format!("{:016x}",n.to_bits())}),
        Value::Text(s) => json!({"text":s,"utf16":s.encode_utf16().collect::<Vec<_>>()}),
        Value::Utf16(units) => json!({"text":String::from_utf16_lossy(&units),"utf16":units}),
        Value::Array(a) => Json::Array(a.into_iter().map(encode).collect()),
    }
}
fn equal(want: &Json, got: &Json) -> bool {
    // Preserve every recorded bit, including NaN sign/payload. An unresolved
    // representation or arithmetic difference remains a visible replay failure.
    want == got
}
fn replay(golden: &Json) {
    let mut differences = Vec::new();
    for (i, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let args: Vec<_> = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        let function = library()
            .resolve(name)
            .unwrap_or_else(|| panic!("missing registration {name}"));
        let zone: Tz = case["zone"].as_str().unwrap().parse().unwrap();
        let got = with_local_zone(zone, || match function(&args) {
            Ok(v) => encode(v),
            Err(Failure::Thrown(message)) => json!({"thrown":message}),
            Err(e) => panic!("{name}: unexpected refusal {e}"),
        });
        let want = case
            .get("value")
            .cloned()
            .unwrap_or_else(|| json!({"thrown":case["thrown"]}));
        if !equal(&want, &got) {
            differences.push(format!(
                "case {i} {name} {:?}: want {want}, got {got}",
                case["args"]
            ));
        }
    }
    struct Empty;
    impl mixdog_xlsx_formula::Context for Empty {
        fn sheet(&self) -> &str {
            "Sheet1"
        }
        fn value(&mut self, _: &str, _: &str) -> Result<Value, Failure> {
            Ok(Value::Null)
        }
    }
    for case in golden["engine"].as_array().unwrap() {
        let formula = case["formula"].as_str().unwrap();
        let got = with_local_zone(Tz::UTC, || {
            mixdog_xlsx_formula::evaluate_formula(formula, &mut Empty)
        });
        match got {
            Ok(value) => {
                let encoded = encode(value.clone());
                if !equal(&case["value"], &encoded) {
                    differences.push(format!(
                        "engine {formula}: want {}, got {encoded}",
                        case["value"]
                    ));
                }
                // Original xmlEncode escapes only ASCII punctuation. Keep raw
                // units through that operation, then model JSZip's Buffer.from.
                let mut xml = Vec::new();
                for unit in mixdog_xlsx_formula::coerce::to_js_utf16(&value) {
                    let escaped = match unit {
                        38 => Some("&amp;"),
                        60 => Some("&lt;"),
                        62 => Some("&gt;"),
                        34 => Some("&quot;"),
                        39 => Some("&apos;"),
                        _ => None,
                    };
                    if let Some(text) = escaped {
                        xml.extend(text.encode_utf16());
                    } else {
                        xml.push(unit);
                    }
                }
                let xml = Value::from_utf16(xml);
                if !equal(&case["xml"], &encode(xml.clone())) {
                    differences.push(format!(
                        "engine XML units {formula}: want {}, got {:?}",
                        case["xml"], xml
                    ));
                }
                let bytes = xml.text_to_utf8_lossy().unwrap();
                let hex: String = bytes
                    .as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if case["xmlUtf8"] != hex {
                    differences.push(format!(
                        "engine XML UTF8 {formula}: want {}, got {hex}",
                        case["xmlUtf8"]
                    ));
                }
            }
            Err(error) => differences.push(format!("engine {formula}: unexpected {error:?}")),
        }
    }
    assert!(
        differences.is_empty(),
        "{} twin differences:\n{}",
        differences.len(),
        differences.join("\n")
    );
}
#[test]
fn twin_text_date() {
    replay(&twin::load_golden("office-text-date"));
}
#[test]
fn clock_exports_use_the_current_local_calendar() {
    let now = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64
    };
    for zone in [Tz::UTC, Tz::Asia__Seoul, Tz::America__New_York] {
        with_local_zone(zone, || {
            let before = now();
            let Value::Date(t) = library().resolve("NOW").unwrap()(&[]).unwrap() else {
                panic!("NOW must return Date")
            };
            let after = now();
            assert!(before <= t && t <= after);
            let Value::Date(t) = library().resolve("TODAY").unwrap()(&[]).unwrap() else {
                panic!("TODAY must return Date")
            };
            let f = mixdog_js::time::local_fields(t).unwrap();
            assert_eq!((f.hour, f.minute, f.second, f.millisecond), (0, 0, 0, 0));
            let current = mixdog_js::time::local_fields(after).unwrap();
            assert_eq!(
                (f.year, f.month, f.day),
                (current.year, current.month, current.day)
            );
        });
    }
}
#[test]
#[ignore = "runs the original Node formulajs installation; set MIXDOG_NODE_TREE"]
fn twin_live_text_date() {
    let tree = twin::node_source_root();
    let raw = twin::run_recorder(
        "benchmarks/rust-core/recorders/record-office-text-date.mjs",
        &tree,
    );
    let golden: Json = serde_json::from_str(&raw).unwrap();
    assert_eq!(golden, twin::load_golden("office-text-date"));
    replay(&golden);
}

#[test]
fn corrective_fixture_keeps_exact_nan_bits_and_bounded_resource_errors() {
    let golden = twin::load_golden("office-text-date");
    assert_eq!(golden["v8MaxStringUnits"], (1u64 << 29) - 24);
    assert!(golden["correctiveRegressions"].as_array().unwrap().len() >= 30);
    assert_eq!(golden["sharedDateStringCases"].as_array().unwrap().len(), 4);
    assert!(!equal(
        &json!({"numberBits":"7ff8000000000000"}),
        &json!({"numberBits":"fff8000000000000"})
    ));
    assert!(!equal(
        &json!({"dateBits":"7ff8000000000000"}),
        &json!({"dateBits":"fff8000000000000"})
    ));
    let overflow = golden["correctiveRegressions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| &golden["cases"][case["case"].as_u64().unwrap() as usize])
        .filter(|case| case["name"] == "REPT" && case.get("thrown").is_some())
        .collect::<Vec<_>>();
    assert_eq!(overflow.len(), 2);
    for case in overflow {
        assert_eq!(case["thrown"], "Invalid string length");
    }
}
