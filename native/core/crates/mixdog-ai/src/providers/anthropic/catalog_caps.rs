//! [`CatalogCaps`]: the Anthropic model capabilities the codec reads (`anthropic-effort.mjs`) over the catalog,
//! with Node's release-generation floor for an id no catalog describes.

use std::collections::BTreeSet;
use std::sync::Arc;

use mixdog_protocol::ProviderId;
use serde_json::{json, Value};

use super::{CapsLookup, ModelCaps};
use crate::catalog::CatalogService;
use crate::claude_floors::{claude_generation, ADAPTIVE_FLOOR, MANUAL_REJECTED_FLOOR, MAX_FLOOR, XHIGH_FLOOR};
use crate::registry::keys::Environment;

const LEVEL_ORDER: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];
const CONTROL_KEYS: [&str; 3] = ["supported", "enabled", "default"];

/// `_effortLevelsOf(reasoningOptions)`, in the canonical low-to-max order.
fn ladder_of(options: Option<&Value>) -> Vec<String> {
    let first = options.and_then(Value::as_array).into_iter().flatten().find(|o| {
        o.get("type").map(|t| mixdog_js::js_trim(&mixdog_js::value_to_string(t)).to_lowercase()) == Some("effort".to_owned())
    });
    let mut levels: Vec<String> = first
        .and_then(|o| o.get("values"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| mixdog_js::js_trim(&mixdog_js::value_to_string(v)).to_lowercase())
        .filter(|v| !v.is_empty() && !CONTROL_KEYS.contains(&v.as_str()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let rank = |l: &str| LEVEL_ORDER.iter().position(|o| *o == l).unwrap_or(LEVEL_ORDER.len());
    levels.sort_by_key(|l| rank(l));
    levels
}

/// `normalizeClaudeModelId`.
fn normalized(model: &str) -> String {
    model.to_lowercase().replace('.', "-")
}

/// `_catalogKeys`: a dated id and its bare alias describe the same model.
fn keys_of(model: &str) -> Vec<String> {
    let id = normalized(model);
    if id.is_empty() {
        return Vec::new();
    }
    let undated = match id.len().checked_sub(9) {
        Some(cut) if id.is_char_boundary(cut) && id[cut..].starts_with('-') && id[cut + 1..].bytes().all(|b| b.is_ascii_digit()) => id[..cut].to_owned(),
        _ => id.clone(),
    };
    if undated == id { vec![id] } else { vec![id, undated] }
}

/// What the Anthropic catalog states of a model (`_catalogEntry`).
struct Entry {
    levels: Vec<String>,
    /// `thinkingTypes.enabled`.
    manual: Option<bool>,
    /// `thinkingTypes.adaptive`.
    adaptive: Option<bool>,
}

/// The Anthropic model capabilities the codec reads (`anthropic-effort.mjs`), in Node's order for
/// one model: the live roster index (the subscription route's listed rows), then the shared
/// catalog, then the release-generation floor for an id no catalog describes. A listed row that
/// states an empty effort ladder is a model that takes no effort, and its own `thinkingTypes`
/// flags decide the thinking kind; the floor decides only where the catalog is silent.
#[derive(Clone)]
pub struct CatalogCaps {
    catalog: Arc<CatalogService>,
    /// `MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT`.
    always_effort: bool,
}

impl CatalogCaps {
    pub fn new(catalog: Arc<CatalogService>, env: &dyn Environment) -> Self {
        let always = env.var("MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT").map(|v| mixdog_js::js_trim(&v).to_lowercase());
        Self { catalog, always_effort: matches!(always.as_deref(), Some("1" | "true" | "yes" | "on")) }
    }

    pub fn lookup(self) -> CapsLookup {
        Arc::new(move |model| self.caps(model))
    }

    /// `setModelEffortCapabilities` + `_catalogEntry`: the index over the listed rows (rows that
    /// state no ladder skipped; a bare alias shared by several rows keeps the richer ladder), the
    /// shared catalog's ladder for an id the index does not hold.
    fn entry(&self, model: &str) -> Option<Entry> {
        let wanted = keys_of(model);
        let snapshot = self.catalog.snapshot();
        let mut index: std::collections::HashMap<String, Entry> = std::collections::HashMap::new();
        for record in snapshot.models_of(&ProviderId::from("anthropic-oauth")) {
            if !record.efforts_stated {
                continue;
            }
            let levels = ladder_of(Some(&json!(record.picker.reasoning_options)));
            for key in keys_of(&record.id) {
                if index.get(&key).is_some_and(|e| !e.levels.is_empty()) && levels.is_empty() {
                    continue;
                }
                index.insert(key, Entry { levels: levels.clone(), manual: record.thinking_enabled, adaptive: record.thinking_adaptive });
            }
        }
        if let Some(entry) = wanted.iter().find_map(|key| index.remove(key)) {
            return Some(entry);
        }
        let id = normalized(model);
        let levels = self.catalog.sync_meta(&id, "anthropic").map(|meta| ladder_of(meta.get("reasoningOptions"))).unwrap_or_default();
        (!levels.is_empty()).then_some(Entry { levels, manual: None, adaptive: None })
    }

    pub fn caps(&self, model: &str) -> Option<ModelCaps> {
        let generation = claude_generation(model);
        let at_least = |floor: f64| generation.is_some_and(|g| g >= floor);
        let id = normalized(model);
        let meta = self.catalog.sync_meta(&id, "anthropic");
        let entry = self.entry(model);
        let mut effort_levels = entry.as_ref().map(|e| e.levels.clone());
        let floor_levels = || {
            let mut levels = ["low", "medium", "high"].map(str::to_owned).to_vec();
            if at_least(XHIGH_FLOOR) {
                levels.push("xhigh".into());
            }
            if at_least(MAX_FLOOR) {
                levels.push("max".into());
            }
            levels
        };
        // `modelSupportsEffort`: the switch enables it whatever the ladder, floor-gated top tiers
        // only where no ladder is advertised.
        let levels = match effort_levels.take() {
            Some(l) if l.is_empty() && self.always_effort => vec!["low".to_owned(), "medium".into(), "high".into()],
            Some(l) => l,
            None if self.always_effort || at_least(ADAPTIVE_FLOOR) => floor_levels(),
            None => Vec::new(),
        };
        if levels.is_empty() && generation.is_none() && meta.is_none() && entry.is_none() {
            return None;
        }
        let positive = |key: &str| meta.as_ref().and_then(|m| m.get(key)).and_then(Value::as_f64).filter(|n| *n > 0.0);
        Some(ModelCaps {
            // `_usesAdaptiveThinking`: a declared `adaptive` flag, else the generation floor.
            adaptive_thinking: self.always_effort || entry.as_ref().and_then(|e| e.adaptive).unwrap_or_else(|| at_least(ADAPTIVE_FLOOR)),
            // `isAnthropicAdaptiveOnlyModel`: a declared `enabled` flag, else the generation.
            manual_thinking: entry.as_ref().and_then(|e| e.manual).unwrap_or_else(|| !at_least(MANUAL_REJECTED_FLOOR)),
            ladder_stated: entry.is_some(),
            effort_levels: levels,
            max_output_tokens: positive("outputTokens").map(|n| n as u32),
            fast_mode: self.catalog.supports_anthropic_fast_mode(&id),
            context_window: positive("contextWindow").map(|n| n as u64),
            thinking_display_updates: crate::claude_floors::emits_progress_updates(model),
        })
    }
    /// `anthropicEffortLevelsFor(model)`: the levels the wire builder sends unchanged (reserved
    /// `max` excluded); none for a model without adaptive effort.
    pub fn effort_levels_for(&self, model: &str) -> Vec<String> {
        let Some(caps) = self.caps(model).filter(|c| c.supports_effort() && c.adaptive_thinking) else { return Vec::new() };
        let mut levels = vec!["low".to_owned(), "medium".into(), "high".into()];
        if caps.effort_levels.iter().any(|l| l == "xhigh") {
            levels.push("xhigh".into());
        }
        levels
    }

    /// `anthropicEffortLevelsFor(model).length === 0`: the fact the cache warmer reads of a
    /// request (`WarmRequest::effort_levels_empty`).
    pub fn effort_levels_empty(&self, model: &str) -> bool {
        self.effort_levels_for(model).is_empty()
    }
}
