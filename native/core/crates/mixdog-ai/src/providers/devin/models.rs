//! Devin model catalog rows from `GetCliModelConfigs`.
//!
//! Every enabled, visible uid is a model keyed by its wire uid; the uids that
//! are effort tiers of one model collapse into one row (`families`), which
//! routes each effort to the uid that serves it.

use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::math;
use mixdog_js::string_to_number;

use super::families::Cost;
use super::families::Lane;
use super::families::Spec;
use super::families::collapse_all;
use super::families::collect_lane;
use super::schema::CliModelConfigs;
use super::schema::ClientModelConfig;
use super::schema::display;

/// The cost dimensions' `ModelDimensionKind` values.
const COST: u64 = 1;
const COST_FUZZY: u64 = 2;

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
    /// The wire uid of a request without an effort.
    pub uid: String,
    /// The efforts of a collapsed family, `none` for its thinking-off route.
    pub reasoning_levels: Vec<String>,
    /// Each level's wire uid: its effort route, else `uid`.
    pub effort_uids: Vec<(String, String)>,
    pub default_effort: Option<String>,
    /// No wire uid serves the family with thinking off.
    pub requires_effort: bool,
}

impl ModelRow {
    /// The wire uid a request for `model_id` at `effort` goes to
    /// (`devinWireUid`): the row's effort route, else its default uid.
    pub fn wire_uid(row: Option<&ModelRow>, model_id: &str, effort: Option<&str>) -> String {
        effort
            .filter(|e| !e.is_empty())
            .and_then(|effort| row?.effort_uids.iter().find(|(level, _)| level == effort))
            .map(|(_, uid)| uid.as_str())
            .filter(|uid| !uid.is_empty())
            .or_else(|| row.map(|r| r.uid.as_str()).filter(|uid| !uid.is_empty()))
            .unwrap_or(model_id)
            .to_owned()
    }
}

static COST_DENOMINATOR: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static("(\\d+(?:\\.\\d+)?)\\s*([kmb])?", "i"));

fn cost_denominator_tokens(denominator: &str) -> f64 {
    let Some(caps) = COST_DENOMINATOR.captures(denominator) else { return 1_000_000.0 };
    let scale = match caps.get(2).map(str::to_lowercase).as_deref() {
        Some("k") => 1_000.0,
        Some("m") => 1_000_000.0,
        Some("b") => 1_000_000_000.0,
        _ => 1.0,
    };
    let tokens = string_to_number(caps.get(1).unwrap_or("")) * scale;
    if tokens > 0.0 { tokens } else { 1_000_000.0 }
}

/// Per-million-token rates from cost dimensions. Composite configs append
/// their components' cards after a `Sidekick` marker; reading stops there.
fn model_cost(config: &ClientModelConfig) -> Cost {
    let mut cost = Cost::default();
    for dimension in &config.dimensions {
        let label = js_trim(&dimension.label).to_lowercase();
        if label == "sidekick" {
            break;
        }
        if dimension.kind != COST && dimension.kind != COST_FUZZY {
            continue;
        }
        // Float32 values: round off the noise at sub-cent precision.
        let per_million =
            math::round(dimension.value * 1_000_000.0 / cost_denominator_tokens(&dimension.denominator) * 1e6) / 1e6;
        match label.as_str() {
            "input" => cost.input = per_million,
            "cached input" => cost.cache_read = per_million,
            "output" => cost.output = per_million,
            _ => {}
        }
    }
    cost
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

/// Catalog rows for the account, sorted by id. Each enabled, visible uid
/// becomes a model; effort siblings collapse into one logical model. The
/// account's default uid marks the default row and, when it is one effort tier
/// of a family, that family's default effort and uid.
pub fn normalize_models(configs: &CliModelConfigs) -> Vec<ModelRow> {
    let account_default = js_trim(&configs.default_model_uid);
    let mut seen = HashSet::new();
    let mut specs = Vec::new();
    let mut lanes: Vec<Lane> = Vec::new();
    for config in &configs.configs {
        if config.disabled {
            continue;
        }
        // Requested for completeness, never surfaced.
        if matches!(config.display_option, display::QUICK_REVIEW | display::INTERNAL_DEFAULT) {
            continue;
        }
        let uid = js_trim(&config.model_uid);
        if uid.is_empty() || is_fusion_pairing(uid) || !seen.insert(uid.to_owned()) {
            continue;
        }
        let router = is_router(config);
        // Harness-less routers need AssignModel; harness-backed composites
        // are themselves chat uids.
        let assign_model_router = router && config.harness_uids.is_empty();
        let images = if config.has_features {
            config.info_supports_images
        } else {
            config.supports_images
        };
        specs.push(Spec {
            id: uid.to_owned(),
            name: match js_trim(&config.label) {
                "" => uid.to_owned(),
                label => label.to_owned(),
            },
            description: js_trim(&config.description).to_owned(),
            reasoning: config.supports_thinking,
            images: images && !IMAGE_BLIND_UIDS.contains(&uid),
            // Router configs ship no features; Cascade serves only
            // tool-calling models.
            supports_tools: if config.has_features { config.supports_tool_calls } else { true },
            supports_parallel_tool_calls: config.supports_parallel_tool_calls,
            cost: model_cost(config),
            context_window: positive(config.max_tokens).unwrap_or(DEFAULT_CONTEXT_WINDOW),
            max_tokens: positive(config.info_max_output_tokens).unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS),
            router: assign_model_router,
            request_model_id: None,
            thinking: None,
            is_provider_default: uid == account_default,
        });
        // A router dispatches; it is never an effort tier of a family.
        if !router {
            collect_lane(&mut lanes, config, uid);
        }
    }
    let mut rows: Vec<ModelRow> = collapse_all(specs, lanes, account_default).into_iter().map(into_row).collect();
    rows.sort_by(|a, b| locale_compare(&a.id, &b.id));
    rows
}

fn into_row(spec: Spec) -> ModelRow {
    let uid = spec.request_model_id.clone().unwrap_or_else(|| spec.id.clone());
    let mut row = ModelRow {
        context_window: spec.context_window,
        max_output_tokens: spec.max_tokens,
        supports_vision: spec.images,
        supports_tools: spec.supports_tools,
        supports_parallel_tool_calls: spec.supports_parallel_tool_calls,
        reasoning: spec.reasoning,
        router: spec.router,
        is_default: spec.is_provider_default,
        reasoning_levels: Vec::new(),
        effort_uids: Vec::new(),
        default_effort: None,
        requires_effort: false,
        id: spec.id,
        name: spec.name,
        description: spec.description,
        uid,
    };
    if let Some(thinking) = spec.thinking.filter(|t| !t.efforts.is_empty()) {
        let routing = thinking.effort_routing.unwrap_or_default();
        // Efforts whose member the account does not serve run on the default uid.
        let levels = routing.contains_key("off").then_some("off").into_iter().chain(thinking.efforts.iter().map(String::as_str));
        for level in levels {
            let name = if level == "off" { "none" } else { level };
            let uid = routing.get(level).cloned().unwrap_or_else(|| row.uid.clone());
            row.reasoning_levels.push(name.to_owned());
            row.effort_uids.push((name.to_owned(), uid));
        }
        row.default_effort = thinking.default_level;
        row.requires_effort = thinking.requires_effort;
    }
    row
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
