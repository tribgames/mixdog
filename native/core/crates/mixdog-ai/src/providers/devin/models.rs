//! Devin model catalog rows from `GetCliModelConfigs`.
//!
//! Every enabled, visible uid is one row keyed by its wire uid. Collapsing
//! effort siblings into one model needs the server's family metadata, which
//! this client does not decode yet; it is not inferred from uid spelling.

use std::collections::HashSet;

use super::schema::CliModelConfigs;
use super::schema::ClientModelConfig;
use super::schema::display;

pub const DEFAULT_CONTEXT_WINDOW: u64 = 200_000;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 64_000;

/// Lanes that advertise images but whose backend drops them silently.
const IMAGE_BLIND_UIDS: [&str; 3] = ["swe-1-6", "swe-1-6-fast", "swe-1-6-slow"];

#[derive(Debug, Clone, PartialEq)]
pub struct ModelRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub supports_vision: bool,
    pub supports_tools: bool,
    pub supports_parallel_tool_calls: bool,
    pub reasoning: bool,
    /// A router uid needs `AssignModel` before a chat call.
    pub router: bool,
    pub is_default: bool,
}

fn is_router(config: &ClientModelConfig) -> bool {
    config.display_option == display::MODEL_ROUTER || config.is_model_router
}

/// A Fusion pairing `fusion-<lead>-sidekick-<sidekick>` is paired by the
/// native client; served here it would run only its lead, so it is not listed.
fn is_fusion_pairing(uid: &str) -> bool {
    uid.starts_with("fusion-") && uid.find("-sidekick-").is_some_and(|at| at > "fusion-".len())
}

fn positive(value: i32) -> Option<u64> {
    u64::try_from(value).ok().filter(|v| *v > 0)
}

/// Catalog rows for the account, sorted by id.
pub fn normalize_models(configs: &CliModelConfigs) -> Vec<ModelRow> {
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    for config in &configs.configs {
        if config.disabled {
            continue;
        }
        // Requested for completeness, never surfaced.
        if matches!(config.display_option, display::QUICK_REVIEW | display::INTERNAL_DEFAULT) {
            continue;
        }
        let uid = config.model_uid.trim();
        if uid.is_empty() || is_fusion_pairing(uid) || !seen.insert(uid.to_owned()) {
            continue;
        }
        let router = is_router(config);
        // Harness-less routers need AssignModel; harness-backed composites
        // are themselves chat uids.
        let assign_model_router = router && config.harness_uids.is_empty();
        let has_features = config.supports_tool_calls
            || config.supports_thinking
            || config.supports_parallel_tool_calls
            || config.info_supports_images;
        let images = if has_features {
            config.info_supports_images
        } else {
            config.supports_images
        };
        rows.push(ModelRow {
            id: uid.to_owned(),
            name: match config.label.trim() {
                "" => uid.to_owned(),
                label => label.to_owned(),
            },
            description: config.description.trim().to_owned(),
            context_window: positive(config.max_tokens).unwrap_or(DEFAULT_CONTEXT_WINDOW),
            max_output_tokens: positive(config.info_max_output_tokens).unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS),
            supports_vision: images && !IMAGE_BLIND_UIDS.contains(&uid),
            // Router configs ship no features; Cascade serves only
            // tool-calling models.
            supports_tools: if has_features { config.supports_tool_calls } else { true },
            supports_parallel_tool_calls: config.supports_parallel_tool_calls,
            reasoning: config.supports_thinking,
            router: assign_model_router,
            is_default: uid == configs.default_model_uid.trim(),
        });
    }
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(uid: &str) -> ClientModelConfig {
        ClientModelConfig {
            model_uid: uid.to_owned(),
            display_option: display::NORMAL,
            max_tokens: 100_000,
            supports_tool_calls: true,
            ..ClientModelConfig::default()
        }
    }

    #[test]
    fn skips_disabled_internal_duplicate_and_fusion() {
        let mut disabled = config("a");
        disabled.disabled = true;
        let mut internal = config("b");
        internal.display_option = display::QUICK_REVIEW;
        let configs = CliModelConfigs {
            configs: vec![
                disabled,
                internal,
                config("c"),
                config("c"),
                config("fusion-x-sidekick-y"),
                config("fusion-only"),
            ],
            default_model_uid: "c".to_owned(),
        };
        let rows = normalize_models(&configs);
        let ids: Vec<_> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["c", "fusion-only"]);
        assert!(rows[0].is_default);
        assert_eq!(rows[0].context_window, 100_000);
        assert_eq!(rows[0].max_output_tokens, DEFAULT_MAX_OUTPUT_TOKENS);
    }

    #[test]
    fn router_without_harness_needs_assignment() {
        let mut router = config("adaptive");
        router.display_option = display::MODEL_ROUTER;
        let rows = normalize_models(&CliModelConfigs {
            configs: vec![router],
            default_model_uid: String::new(),
        });
        assert!(rows[0].router);
    }
}
