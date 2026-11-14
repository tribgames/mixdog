//! Raw UTF-16 is compared before explicit UTF-8/XML output. No surrogate equivalence rule.
use mixdog_xlsx_formula::coerce::{js_strict_equals, parse_string, to_js_number, to_js_utf16};
use mixdog_xlsx_formula::{Context, Failure, Value, evaluate_formula, library};
use serde_json::{Value as Json, json};
fn bytes_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn encode(v: &Value) -> Json {
    if let Some(units) = v.text_units() {
        // Explicit Buffer.from(str, "utf8") output boundary; never fed back into evaluation.
        let output = v.text_to_utf8_lossy().unwrap();
        let xml = output
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;");
        return json!({"t":"text","units":units,"utf8":bytes_hex(output.as_bytes()),"xmlUtf8":bytes_hex(xml.as_bytes())});
    }
    match v {
        Value::Undefined => json!({"t":"undefined"}),
        Value::Null => json!({"t":"null"}),
        Value::Number(n) => json!({"t":"number","bits":format!("{:016x}",n.to_bits())}),
        Value::Bool(b) => json!({"t":"bool","value":b}),
        Value::Date(ms) => if ms.is_finite() {
            json!({"t":"date","milliseconds":*ms as i64})
        } else {
            json!({"t":"date","milliseconds":null})
        },
        Value::Error(e) => json!({"t":"error","value":e.message()}),
        Value::Array(a) => json!({"t":"array","items":a.iter().map(encode).collect::<Vec<_>>()}),
        _ => panic!("unexpected {v:?}"),
    }
}
fn decode(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::String(s) => Value::text(s),
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap()),
        Json::Array(a) => Value::Array(a.iter().map(decode).collect()),
        Json::Object(_) => Value::from_utf16(
            v["units"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u16)
                .collect(),
        ),
    }
}
struct Empty;
impl Context for Empty {
    fn sheet(&self) -> &str {
        "S"
    }
    fn value(&mut self, _: &str, _: &str) -> Result<Value, Failure> {
        Ok(Value::Null)
    }
}
#[test]
fn raw_strings_recombine_and_remain_javascript_strings() {
    let high = Value::from_utf16(vec![0xd83d]);
    let low = Value::from_utf16(vec![0xde00]);
    assert!(high.is_text());
    assert!(matches!(high, Value::Utf16(_)));
    assert!(to_js_number(&high).is_nan());
    assert_eq!(parse_string(&high), high);
    assert!(js_strict_equals(&high, &Value::from_utf16(vec![0xd83d])));
    assert_eq!(
        to_js_utf16(&Value::Array(vec![high.clone(), low.clone()])),
        vec![0xd83d, 44, 0xde00]
    );
    assert_eq!(
        Value::from_utf16([to_js_utf16(&high), to_js_utf16(&low)].concat()),
        Value::text("😀")
    );
    assert_eq!(
        high.text_to_utf8_lossy().unwrap().as_bytes(),
        [0xef, 0xbf, 0xbd]
    );
}
#[test]
fn original_utf16_library_engine_and_xml_boundaries_match() {
    let golden: Json = serde_json::from_str(include_str!("utf16-reference.json")).unwrap();
    let mut differences = Vec::new();
    for case in golden["formulas"].as_array().unwrap() {
        let formula = case["formula"].as_str().unwrap();
        let got = mixdog_js::time::with_local_zone(mixdog_js::time::Tz::UTC, || {
            evaluate_formula(formula, &mut Empty).map(|v| encode(&v))
        });
        if got.as_ref().ok() != Some(&case["value"]) {
            differences.push(format!("{formula}: expected {} got {got:?}", case["value"]))
        }
    }
    for case in golden["library"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let args: Vec<_> = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        let got = mixdog_js::time::with_local_zone(mixdog_js::time::Tz::UTC, || {
            library().resolve(name).expect(name)(&args).map(|v| encode(&v))
        });
        if got.as_ref().ok() != Some(&case["value"]) {
            differences.push(format!(
                "{name} {args:?}: expected {} got {got:?}",
                case["value"]
            ))
        }
    }
    assert!(
        differences.is_empty(),
        "{} differences:\n{}",
        differences.len(),
        differences.join("\n")
    );
}

#[test]
fn datedif_raw_unknown_unit_preserves_original_date_error_order() {
    let call = library().resolve("DATEDIF").unwrap();
    let raw = Value::from_utf16(vec![0xd800]);
    assert_eq!(call(&[Value::text("bad"), Value::text("2024-01-01"), raw.clone()]),
        Err(Failure::thrown("start_date.getFullYear is not a function")));
    assert_eq!(call(&[Value::text("2024-01-01"), Value::text("bad"), raw.clone()]),
        Err(Failure::thrown("end_date.getFullYear is not a function")));
    assert_eq!(call(&[Value::text("2024-01-01"), Value::text("2024-01-02"), raw]), Ok(Value::Undefined));
}
