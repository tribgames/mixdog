//! `money` and `compactNumber` of `session-runtime/services/usage-dashboard-model.mjs`: how the usage dashboard writes an
//! amount and a count.

use mixdog_js::math::to_fixed;
use mixdog_js::to_number_of;
use serde_json::Value;

/// `money(value)`: a dollar amount with the places its size needs (`$0`, `$12`, `$1.50`, `$0.123`, `$0.0042`); `N/A` for
/// a value that is not a finite number.
pub fn money(value: Option<&Value>) -> String {
    let n = to_number_of(value);
    if !n.is_finite() {
        return "N/A".to_owned();
    }
    if n == 0.0 {
        return "$0".to_owned();
    }
    let digits = if n >= 10.0 {
        0
    } else if n >= 1.0 {
        2
    } else if n >= 0.01 {
        3
    } else {
        4
    };
    format!("${}", to_fixed(n, digits))
}

/// `compactNumber(value)`: a count as `12K`, `1.5M`, `42`, `3.5`, `0.25`; empty for a value that is not a finite number.
pub fn compact_number(value: Option<&Value>) -> String {
    let n = to_number_of(value);
    if !n.is_finite() {
        return String::new();
    }
    let magnitude = n.abs();
    if magnitude >= 1_000_000.0 {
        return format!("{}M", to_fixed(n / 1_000_000.0, if n >= 10_000_000.0 { 0 } else { 1 }));
    }
    if magnitude >= 1_000.0 {
        return format!("{}K", to_fixed(n / 1_000.0, if n >= 10_000.0 { 0 } else { 1 }));
    }
    if magnitude >= 10.0 {
        return to_fixed(n, 0);
    }
    if magnitude >= 1.0 {
        return to_fixed(n, 1);
    }
    to_fixed(n, 2)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn money_of(value: Value) -> String {
        money(Some(&value))
    }

    fn compact_of(value: Value) -> String {
        compact_number(Some(&value))
    }

    #[test]
    fn money_takes_the_places_its_size_needs() {
        assert_eq!(money_of(json!(0)), "$0");
        assert_eq!(money_of(json!(1234.5)), "$1235");
        assert_eq!(money_of(json!(12.4)), "$12");
        assert_eq!(money_of(json!(1.5)), "$1.50");
        assert_eq!(money_of(json!(0.1234)), "$0.123");
        assert_eq!(money_of(json!(0.00421)), "$0.0042");
        assert_eq!(money_of(json!(0.01)), "$0.010");
        assert_eq!(money_of(json!("2.5")), "$2.50");
    }

    #[test]
    fn money_is_not_available_for_a_value_that_is_not_a_number() {
        assert_eq!(money_of(json!("abc")), "N/A");
        assert_eq!(money(None), "N/A");
        assert_eq!(money_of(json!(null)), "$0");
        assert_eq!(money_of(json!(-5)), "$-5.0000");
    }

    #[test]
    fn counts_read_compactly_across_magnitudes() {
        assert_eq!(compact_of(json!(0)), "0.00");
        assert_eq!(compact_of(json!(0.256)), "0.26");
        assert_eq!(compact_of(json!(3.54)), "3.5");
        assert_eq!(compact_of(json!(42)), "42");
        assert_eq!(compact_of(json!(999)), "999");
        assert_eq!(compact_of(json!(1000)), "1.0K");
        assert_eq!(compact_of(json!(1500)), "1.5K");
        assert_eq!(compact_of(json!(12_345)), "12K");
        assert_eq!(compact_of(json!(1_500_000)), "1.5M");
        assert_eq!(compact_of(json!(25_000_000)), "25M");
        assert_eq!(compact_of(json!(-25_000_000)), "-25.0M");
        assert_eq!(compact_of(json!("x")), "");
        assert_eq!(compact_number(None), "");
    }
}
