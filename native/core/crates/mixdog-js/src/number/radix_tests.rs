use super::*;
use serde_json::Value;
fn float(bits: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(bits, 16).unwrap())
}
fn golden() -> Value {
    serde_json::from_str(include_str!("radix-golden.json")).unwrap()
}
#[test]
fn every_radix_string_equals_node_22_20() {
    let g = golden();
    assert_eq!(g["oracle"]["node"], "v22.20.0");
    let rows = g["stringify"].as_array().unwrap();
    assert!(rows.len() > 10_000);
    let mut errors = Vec::new();
    for row in rows {
        let n = float(row["number"].as_str().unwrap());
        let r = float(row["radix"].as_str().unwrap());
        let got = number_to_radix(n, r);
        let expected = if let Some(e) = row.get("error") {
            Err(e.as_str().unwrap().to_owned())
        } else {
            Ok(row["value"].as_str().unwrap().to_owned())
        };
        if got != expected {
            errors.push(format!(
                "number={} radix={r:?}: expected={expected:?}, got={got:?}",
                row["number"]
            ));
        }
    }
    assert!(
        errors.is_empty(),
        "{} mismatches:\n{}",
        errors.len(),
        errors.into_iter().take(20).collect::<Vec<_>>().join("\n")
    );
}
#[test]
fn every_parse_int_equals_node_including_generic_chunk_rounding() {
    let g = golden();
    let rows = g["parse"].as_array().unwrap();
    assert!(rows.len() > 2500);
    let mut errors = Vec::new();
    for row in rows {
        let text = row["text"].as_str().unwrap();
        let radix = float(row["radix"].as_str().unwrap());
        let got = format!("{:016x}", parse_int_radix(text, radix).to_bits());
        if got != row["bits"].as_str().unwrap() {
            errors.push(format!(
                "{text:?}, radix={radix:?}: expected={}, got={got}",
                row["bits"]
            ));
        }
    }
    assert!(
        errors.is_empty(),
        "{} mismatches:\n{}",
        errors.len(),
        errors.into_iter().take(20).collect::<Vec<_>>().join("\n")
    );
    let witnesses = g["chunkWitnesses"].as_array().unwrap();
    assert!(witnesses.len() >= 10);
    for row in witnesses {
        assert_ne!(row["bits"], row["naive"]);
        let got = parse_int_radix(
            row["text"].as_str().unwrap(),
            row["radix"].as_f64().unwrap(),
        );
        assert_eq!(
            format!("{:016x}", got.to_bits()),
            row["bits"].as_str().unwrap()
        );
    }
}
#[test]
fn radix_conversion_rules_and_validation_order_are_distinct() {
    assert!(number_to_radix(f64::NAN, 0.0).is_err());
    assert!(number_to_radix(1.0, f64::NAN).is_err());
    assert_eq!(number_to_radix(35.0, 36.9).unwrap(), "z");
    assert_eq!(parse_int_radix("11", 4_294_967_298.0), 3.0);
    assert!(number_to_radix(11.0, 4_294_967_298.0).is_err());
    assert_eq!(parse_int_radix("0x10", f64::NAN), 16.0);
    assert_eq!(
        parse_int_radix("-000junk", 10.0).to_bits(),
        (-0.0f64).to_bits()
    );
    assert!(parse_int_radix("-0x", 0.0).is_nan());
}
