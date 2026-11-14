//! `runtime/shared/model-alias.mjs`: rolling aliases name the current model, not the version released on the alias's
//! creation date. Catalog filtering and the pickers share the rule.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;

/// `isRollingModelAlias(id)`: the trimmed id ends in `-latest` (any case).
pub fn is_rolling_model_alias(id: &str) -> bool {
    js_to_lowercase(js_trim(id)).ends_with("-latest")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_latest_suffix_is_a_rolling_alias() {
        assert!(is_rolling_model_alias("claude-sonnet-latest"));
        assert!(is_rolling_model_alias("  GPT-5-LATEST \n"));
        assert!(!is_rolling_model_alias("latest"));
        assert!(!is_rolling_model_alias("gpt-5-latest-preview"));
        assert!(!is_rolling_model_alias(""));
    }
}
