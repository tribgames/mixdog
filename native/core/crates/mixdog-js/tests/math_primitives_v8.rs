//! The Math primitives: results at the specified special values, and the grid Math.random draws from.
use mixdog_js::math;
#[cfg(node_twin)]
use serde_json::Value;

#[cfg(node_twin)]
fn number(h: &Value) -> f64 {
    f64::from_bits(u64::from_str_radix(h.as_str().expect("hex"), 16).expect("binary64"))
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


#[cfg(node_twin)]
#[test]
fn primitives_equal_the_recorded_answers() {
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
fn rounding_and_roots_keep_the_sign_of_zero_and_nan_outside_the_domain() {
    assert!(math::abs(-0.0).is_sign_positive());
    assert_eq!(math::abs(-3.5), 3.5);
    assert_eq!(math::floor(-0.5), -1.0);
    assert!(math::floor(-0.0).is_sign_negative());
    assert!(math::ceil(-0.5).is_sign_negative() && math::ceil(-0.5) == 0.0, "ceil(-0.5) is -0");
    assert_eq!(math::ceil(1.0000000000000002), 2.0);
    assert!(math::sqrt(-1.0).is_nan());
    assert!(math::sqrt(-0.0).is_sign_negative());
    assert_eq!(math::sqrt(2.0), 1.4142135623730951);
    assert_eq!(math::sqrt(f64::INFINITY), f64::INFINITY);
}

#[test]
fn inverse_trigonometry_follows_the_specified_domain_and_quadrants() {
    use std::f64::consts::{FRAC_PI_2, PI};
    assert!(math::acos(2.0).is_nan() && math::asin(-1.5).is_nan());
    assert_eq!(math::acos(1.0), 0.0);
    assert_eq!(math::asin(1.0), FRAC_PI_2);
    assert_eq!(math::atan(f64::INFINITY), FRAC_PI_2);
    assert_eq!(math::atan2(1.0, 0.0), FRAC_PI_2);
    assert_eq!(math::atan2(0.0, -0.0), PI);
    assert_eq!(math::atan2(-0.0, -0.0), -PI);
    assert!(math::atan2(-0.0, 0.0).is_sign_negative());
    assert_eq!(math::atan2(1.0, -1.0), 2.356194490192345);
}

#[test]
fn trigonometry_reproduces_the_well_known_double_precision_results() {
    use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};
    assert!(math::sin(-0.0).is_sign_negative());
    assert_eq!(math::sin(PI), 1.2246467991473532e-16);
    assert_eq!(math::cos(0.0), 1.0);
    assert_eq!(math::cos(FRAC_PI_2), 6.123233995736766e-17);
    assert_eq!(math::tan(FRAC_PI_4), 0.9999999999999999);
    assert!(math::sin(f64::INFINITY).is_nan() && math::cos(f64::NEG_INFINITY).is_nan() && math::tan(f64::INFINITY).is_nan());
}