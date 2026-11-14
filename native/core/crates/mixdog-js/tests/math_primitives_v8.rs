//! Recorded outputs of the pinned installed V8, including payload bits of NaNs.
use mixdog_js::math;
use serde_json::Value;

fn number(h: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(h.as_str().expect("hex"), 16).expect("binary64"))
}

#[test]
fn primitives_equal_the_pinned_v8_oracle() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!(
        "../../fixtures/js-math-primitives/golden.json"
    ))
    .expect("golden");
    assert_eq!(golden["v8"], "12.4.254.21-node.33");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 30_000);
    let mut mismatches = Vec::new();
    for (at, case) in cases.iter().enumerate() {
        let name = case[0].as_str().expect("name");
        let x = number(&case[1][0]);
        let answer = match name {
            "abs" => math::abs(x),
            "floor" => math::floor(x),
            "ceil" => math::ceil(x),
            "sqrt" => math::sqrt(x),
            "log" => math::ln(x),
            "min" => math::min(x, number(&case[1][1])),
            "max" => math::max(x, number(&case[1][1])),
            "acos" => math::acos(x),
            "asin" => math::asin(x),
            "atan" => math::atan(x),
            "atan2" => math::atan2(x, number(&case[1][1])),
            "sin" => math::sin(x),
            "cos" => math::cos(x),
            "tan" => math::tan(x),
            _ => panic!("unknown function {name}"),
        };
        let expected = number(&case[2]);
        if answer.to_bits() != expected.to_bits() {
            mismatches.push(format!(
                "{at} {name}{}: got {:016x}, want {:016x}",
                case[1],
                answer.to_bits(),
                expected.to_bits()
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} mismatches:\n{}",
        mismatches.len(),
        mismatches
            .iter()
            .take(100)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn random_samples_use_v8s_grid_and_range() {
    // Range/grid are invariant tests; no probabilistic distribution threshold can make this flaky.
    for _ in 0..4096 {
        let value = math::random();
        assert!((0.0..1.0).contains(&value));
        assert_eq!((value * 4_503_599_627_370_496.0).fract(), 0.0);
    }
}
