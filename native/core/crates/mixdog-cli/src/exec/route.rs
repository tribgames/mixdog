//! The explicit route every exec names (`validateExplicitPristineRoute`): both provider and model,
//! no host fallback.

use mixdog_js::js_trim;

const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `clean(value)`: `String(value ?? '').trim()`.
pub fn clean(value: Option<&str>) -> &str {
    js_trim(value.unwrap_or(""))
}

/// The refusal text of a route that does not name provider and model, or names an unknown effort.
pub fn validate_explicit_route(provider: Option<&str>, model: Option<&str>, effort: Option<&str>) -> Result<(), String> {
    if clean(provider).is_empty() || clean(model).is_empty() {
        return Err("mixdog exec requires both --provider <name> and --model <name>; host route fallback is disabled".into());
    }
    let selected = clean(effort).to_lowercase();
    if !selected.is_empty() && !EFFORTS.contains(&selected.as_str()) {
        let shown = serde_json::to_string(clean(effort)).expect("a string serializes");
        return Err(format!("invalid --effort {shown}; expected low, medium, high, xhigh, or max"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_names_provider_and_model() {
        let missing = "mixdog exec requires both --provider <name> and --model <name>; host route fallback is disabled";
        assert_eq!(validate_explicit_route(None, Some("m"), None).unwrap_err(), missing);
        assert_eq!(validate_explicit_route(Some("p"), Some("\u{feff} "), None).unwrap_err(), missing);
        assert!(validate_explicit_route(Some("p"), Some("m"), Some(" HIGH ")).is_ok());
    }

    #[test]
    fn an_unknown_effort_is_refused_with_its_json_form() {
        assert_eq!(
            validate_explicit_route(Some("p"), Some("m"), Some(" ultra\"")).unwrap_err(),
            "invalid --effort \"ultra\\\"\"; expected low, medium, high, xhigh, or max"
        );
    }
}
