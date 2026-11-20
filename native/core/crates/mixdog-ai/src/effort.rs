//! The single effort ladder: which efforts a route offers, how a requested
//! effort is coerced onto them, and how a rejected level steps down.
//! Ports `runtime-core/effort.mjs` (`normalizeEffortInput`,
//! `normalizeSavedEffort`, `effortOptionsFor`, `coerceEffortFor`,
//! `effortItemsFor`) and, from `effort-rejection.mjs`, `nearestAcceptedEffort`
//! and `clampEffortOpts`. Rows are the catalog's JSON model rows; what an
//! endpoint rejected arrives as a [`RejectionEntry`] the caller read from its
//! store, so nothing here touches the disk.

use std::collections::BTreeSet;

use mixdog_js::value_to_string;
use serde_json::Value;

use crate::providers::custom::reasoning::ReasoningOption;
use crate::providers::custom::reasoning::ReasoningRow;
use crate::providers::custom::reasoning::snap_effort;
use crate::service::admin_route::clean;
use crate::service::admin_route::truthy;

/// Every effort name a session may carry, weakest first (`ALL_EFFORT_LEVELS`,
/// and the rejection store's `EFFORT_ORDER`).
pub const ALL_EFFORT_LEVELS: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/// Per-provider request fields that can carry the effort next to `effort`.
const EFFORT_OPT_KEYS: [&str; 3] = ["xaiReasoningEffort", "openRouterReasoningEffort", "deepseekReasoningEffort"];

/// Last-resort ladder of a provider whose endpoint publishes no effort metadata.
fn provider_options(provider: &str) -> Option<&'static [&'static str]> {
    Some(match provider {
        "openai" => &["none", "low", "medium", "high", "xhigh"],
        // xAI Grok 4.6+: reasoning cannot be disabled.
        "xai" => &["low", "medium", "high", "xhigh"],
        "mimo-oauth" => &["minimal", "low", "medium", "high"],
        "command-code-oauth" => &["low", "medium", "high"],
        _ => return None,
    })
}

/// The ladder of a model family when its catalog row declares none.
fn family_options(family: &str) -> Option<&'static [&'static str]> {
    Some(match family {
        "opus" | "fable" | "mythos" => &["low", "medium", "high", "xhigh", "max"],
        "sonnet" => &["low", "medium", "high"],
        "haiku" => &[],
        "gpt-5.5" | "gpt-5.4" | "gpt-5.2" | "gpt-5" | "gpt-mini" => &["none", "low", "medium", "high", "xhigh"],
        "gpt-nano" => &["none", "low", "medium", "high"],
        "gpt-codex" => &["none", "low", "medium", "high"],
        "grok" => &["low", "medium", "high", "xhigh"],
        _ => return None,
    })
}

/// The levels to try, in order, when the requested one is not offered.
fn fallbacks(effort: &str) -> &'static [&'static str] {
    match effort {
        "ultra" => &["ultra", "max", "xhigh", "high", "medium", "low", "minimal"],
        "max" => &["max", "xhigh", "high", "medium", "low", "minimal"],
        "xhigh" => &["xhigh", "high", "medium", "low", "minimal"],
        "high" => &["high", "medium", "low", "minimal"],
        "medium" => &["medium", "low", "minimal"],
        "low" => &["low", "minimal"],
        "minimal" => &["minimal", "low", "medium", "high", "xhigh", "max"],
        "none" => &["none"],
        _ => &[],
    }
}

fn label(level: &str) -> Option<&'static str> {
    Some(match level {
        "none" => "None",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "Extra High",
        "max" => "Max",
        "ultra" => "Ultra",
        _ => return None,
    })
}

/// The efforts Auto may choose for a model, ascending: `low` up to the tier below the top (`none` and
/// `minimal` switch thinking off, `max`/`ultra` are reserved for an explicit choice). Empty when the
/// route's options hold none of them: Auto then has nothing to move along, so it neither judges nor is
/// offered, and the saved effort is what a request uses. One rule for the judge and for what the UI shows.
pub fn auto_effort_ladder<S: AsRef<str>>(options: &[S]) -> Vec<&'static str> {
    let supported: Vec<String> = options.iter().map(|o| mixdog_js::js_trim(o.as_ref()).to_lowercase()).collect();
    ["low", "medium", "high", "xhigh"].into_iter().filter(|level| supported.iter().any(|s| s == level)).collect()
}

/// The row a non-Anthropic route's effort ladder is read from (`autoEffortModel`): the provider's stored row of the
/// model (`getCachedModelInfo`) with its id set to the model, or a bare `{ id }` when the listing kept none. The judge and
/// the model rows' `autoEffortCapable` / `effortOptions` both read the ladder from this one row.
pub fn ladder_row(model: &str, stored: Option<serde_json::Map<String, Value>>) -> Value {
    let mut row = stored.unwrap_or_default();
    row.insert("id".into(), Value::from(model));
    Value::Object(row)
}

/// An Anthropic route's ladder row (`autoEffortModel`): its id with the levels its wire builder accepts
/// (`anthropicEffortLevelsFor`), declared authoritatively: a provider row never replaces them, and an empty list does not fall
/// back to a family ladder.
pub fn anthropic_ladder_row(model: &str, levels: Vec<String>) -> Value {
    serde_json::json!({ "id": model, "reasoningLevels": levels, "customReasoning": true })
}

/// A route's own Auto flag: only an explicit `false` opts out, absent means on. The judge and the labels both ask this.
pub fn route_auto_effort_on(flag: Option<&Value>) -> bool {
    flag != Some(&Value::Bool(false))
}

/// The store key of a route's rejections (`provider:model`, the model lower-cased).
pub fn rejection_key(provider: &str, model: &str) -> String {
    format!("{}:{}", mixdog_js::js_trim(provider), mixdog_js::js_trim(model).to_lowercase())
}

/// `effort-rejections.json` (`{version: 1, models: {"provider:model": {rejected, allowed}}}`) as its entries by
/// [`rejection_key`]; a missing, damaged or foreign-version file holds nothing.
pub fn parse_rejections(bytes: Option<&[u8]>) -> std::collections::HashMap<String, RejectionEntry> {
    let strings =
        |value: Option<&Value>| -> Vec<String> { value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect() };
    let mut models = std::collections::HashMap::new();
    let doc = bytes.and_then(|b| mixdog_statefile::parse_json_text(b).ok());
    if let Some(doc) = doc.filter(|d| d.get("version").and_then(Value::as_f64) == Some(1.0)) {
        for (key, entry) in doc.get("models").and_then(Value::as_object).into_iter().flatten() {
            models.insert(key.clone(), RejectionEntry { rejected: strings(entry.get("rejected")), allowed: strings(entry.get("allowed")) });
        }
    }
    models
}

/// `normalizeEffortInput`: `None` for empty / `auto`; a level, or the error text.
pub fn normalize_effort_input(value: Option<&Value>) -> Result<Option<String>, String> {
    let v = clean(value).to_lowercase();
    if v.is_empty() || v == "auto" {
        return Ok(None);
    }
    if !ALL_EFFORT_LEVELS.contains(&v.as_str()) {
        return Err(format!("effort must be one of auto, {}", ALL_EFFORT_LEVELS.join(", ")));
    }
    Ok(Some(v))
}

/// `normalizeSavedEffort`.
pub fn normalize_saved_effort(value: Option<&Value>) -> Option<String> {
    normalize_effort_input(value).ok().flatten()
}

/// Effort in wire values (`projectEffortConfiguration`): `initial_effort`
/// goes in the request's `reasoning`, each entry of `updates` becomes a
/// `configuration_update` item.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EffortProjection {
    pub initial_effort: String,
    /// Message index to the effort that takes effect there. An update on a
    /// tool result applies after its whole tool batch.
    pub updates: std::collections::BTreeMap<usize, String>,
}

impl EffortProjection {
    /// Maps a session projection (`initial`, then `changes` in transcript
    /// order, in the session's own effort names) onto the route's wire
    /// values. Consecutive changes that share a wire value collapse into none.
    /// `None` when any effort has no wire value on this route: the request
    /// then carries its per-request effort alone.
    pub fn from_session(initial: &str, changes: impl IntoIterator<Item = (usize, String)>, wire: &dyn Fn(&str) -> Option<String>) -> Option<Self> {
        let initial_effort = wire(initial)?;
        let mut current = initial_effort.clone();
        let mut updates = std::collections::BTreeMap::new();
        for (index, effort) in changes {
            let value = wire(&effort)?;
            if value != current {
                current.clone_from(&value);
                updates.insert(index, value);
            }
        }
        Some(Self { initial_effort, updates })
    }
}

/// The projection as `RequestOptions.effort_projection` carries it (the one field both the
/// Responses and the Messages adapters read), and back.
impl From<EffortProjection> for mixdog_core_api::domain::provider::EffortProjection {
    fn from(projection: EffortProjection) -> Self {
        Self { initial_effort: projection.initial_effort, updates: projection.updates }
    }
}

impl From<&mixdog_core_api::domain::provider::EffortProjection> for EffortProjection {
    fn from(projection: &mixdog_core_api::domain::provider::EffortProjection) -> Self {
        Self { initial_effort: projection.initial_effort.clone(), updates: projection.updates.clone() }
    }
}

/// What an endpoint rejected for one provider and model
/// (`effort-rejections.json`): levels it refused, and the list it named.
#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct RejectionEntry {
    pub rejected: Vec<String>,
    /// Empty when the endpoint named no list.
    pub allowed: Vec<String>,
}

impl RejectionEntry {
    /// `rejectedEffortLevelsSync`: the refused levels, plus every level
    /// outside the named list.
    pub fn levels(&self) -> BTreeSet<String> {
        let mut out: BTreeSet<String> = self.rejected.iter().cloned().collect();
        if !self.allowed.is_empty() {
            out.extend(ALL_EFFORT_LEVELS.iter().filter(|l| !self.allowed.iter().any(|a| a == *l)).map(|l| (*l).to_owned()));
        }
        out
    }
}

/// The reasoning facts of a JSON row as `customEffortLevels` reads them.
pub fn reasoning_row(model: &Value) -> ReasoningRow {
    let effort_option = model
        .get("reasoningOptions")
        .and_then(Value::as_array)
        .and_then(|options| options.iter().find(|o| value_to_string(o.get("type").unwrap_or(&Value::Null)).trim().eq_ignore_ascii_case("effort")));
    let strings = |values: &Vec<Value>| -> Vec<String> {
        values.iter().map(|v| v.as_str().map_or_else(|| if v.is_null() { String::new() } else { value_to_string(v) }, str::to_owned)).collect()
    };
    ReasoningRow {
        // An effort option without a values array does not count: the row's
        // `reasoningLevels` decide.
        reasoning_options: effort_option
            .and_then(|o| o.get("values")?.as_array())
            .map(|values| ReasoningOption { kind: "effort".to_owned(), values: strings(values) })
            .into_iter()
            .collect(),
        reasoning_levels: model.get("reasoningLevels").and_then(Value::as_array).map(strings),
        ..ReasoningRow::default()
    }
}

/// `customEffortLevels(model)`: the levels a custom row declares, or `None`.
pub fn custom_levels(model: &Value) -> Option<Vec<String>> {
    reasoning_row(model).effort_levels()
}

fn lower_clean(v: &Value) -> String {
    clean(Some(v)).to_lowercase()
}

fn catalog_values(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for v in values {
        if v.is_empty() || !seen.insert(v.clone()) {
            continue;
        }
        if ALL_EFFORT_LEVELS.contains(&v.as_str()) {
            out.push(v);
        }
    }
    out
}

fn catalog_effort_options(provider: &str, model: &Value) -> Vec<String> {
    // Custom-provider rows declare their levels authoritatively: no
    // family/provider fallback.
    if truthy(model.get("customReasoning")) {
        return custom_levels(model).unwrap_or_default();
    }
    let family = clean(model.get("family")).to_lowercase();
    let option_values: Vec<String> = model
        .get("reasoningOptions")
        .and_then(Value::as_array)
        .and_then(|options| options.iter().find(|o| lower_clean(o.get("type").unwrap_or(&Value::Null)) == "effort"))
        .and_then(|o| o.get("values")?.as_array())
        .map(|values| values.iter().map(lower_clean).filter(|v| !v.is_empty()).collect())
        .unwrap_or_default();
    let declared: Vec<String> = model
        .get("reasoningLevels")
        .and_then(Value::as_array)
        .map(|values| values.iter().map(lower_clean).filter(|v| !v.is_empty()).collect())
        .unwrap_or_default();
    // Catalog first: declared values are trusted as they are; the provider and
    // family lists are fallbacks for catalog-empty models.
    if !option_values.is_empty() {
        return catalog_values(option_values);
    }
    if !declared.is_empty() {
        return catalog_values(declared);
    }
    if let Some(list) = family_options(&family) {
        return list.iter().map(|s| (*s).to_owned()).collect();
    }
    provider_options(provider).map_or_else(Vec::new, |list| list.iter().map(|s| (*s).to_owned()).collect())
}

/// `effortOptionsFor`: the efforts a route offers, minus the levels its
/// endpoint rejected. `rejected` applies only to a row with an id.
pub fn effort_options_for(provider: &str, model: &Value, rejected: Option<&RejectionEntry>) -> Vec<String> {
    let options = catalog_effort_options(provider, model);
    let has_id = truthy(model.get("id"));
    match rejected.map(RejectionEntry::levels).filter(|set| has_id && !set.is_empty()) {
        Some(set) => options.into_iter().filter(|level| !set.contains(level)).collect(),
        None => options,
    }
}

/// `coerceEffortFor`: `effort` if the route offers it, else the nearest
/// fallback it does; `None` when none applies.
pub fn coerce_effort_for(provider: &str, model: &Value, effort: &str, rejected: Option<&RejectionEntry>) -> Option<String> {
    if effort.is_empty() {
        return None;
    }
    if truthy(model.get("customReasoning")) {
        return snap_effort(custom_levels(model).as_deref(), effort).map(str::to_owned);
    }
    let allowed = effort_options_for(provider, model, rejected);
    if allowed.is_empty() {
        return None;
    }
    if allowed.iter().any(|l| l == effort) {
        return Some(effort.to_owned());
    }
    fallbacks(effort).iter().find(|c| allowed.iter().any(|l| l == **c)).map(|c| (*c).to_owned())
}

/// One entry of the effort picker.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct EffortItem {
    pub value: String,
    pub label: String,
    pub description: String,
}

/// `effortItemsFor`.
pub fn effort_items_for(provider: &str, model: &Value, active: Option<&str>, rejected: Option<&RejectionEntry>) -> Vec<EffortItem> {
    effort_options_for(provider, model, rejected)
        .into_iter()
        .map(|value| EffortItem {
            label: label(&value).map_or_else(|| value.clone(), str::to_owned),
            description: if active == Some(value.as_str()) { "current".to_owned() } else { String::new() },
            value,
        })
        .collect()
}

/// `nearestAcceptedEffort`: the nearest lower level not in `rejected`; with
/// `allow_higher` (the accepted set is known) the lowest open one when nothing
/// lower is left.
pub fn nearest_accepted_effort(requested: &str, rejected: &BTreeSet<String>, allow_higher: bool) -> Option<&'static str> {
    let from = ALL_EFFORT_LEVELS.iter().position(|l| *l == requested)?;
    let open: Vec<(usize, &'static str)> =
        ALL_EFFORT_LEVELS.iter().copied().enumerate().filter(|(index, level)| *index != from && !rejected.contains(*level)).collect();
    let lower = open.iter().rev().find(|(index, _)| *index < from).map(|(_, level)| *level);
    lower.or_else(|| if allow_higher { open.first().map(|(_, level)| *level) } else { None })
}

fn level_of(value: Option<&Value>) -> Option<&'static str> {
    let text = match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => value_to_string(other),
    };
    let level = mixdog_js::js_trim(&text).to_lowercase();
    ALL_EFFORT_LEVELS.iter().copied().find(|l| *l == level)
}

/// `clampEffortOpts`: `opts` with a level already known to be rejected stepped
/// down; unchanged otherwise. `levels` limits the ladder to what the wire
/// accepts; `entry` is the store's record for the route, if any.
pub fn clamp_effort_opts(opts: &Value, config_effort: Option<&Value>, levels: Option<&[&str]>, entry: Option<&RejectionEntry>) -> Value {
    let effort = match opts.get("effort") {
        None | Some(Value::Null) => config_effort,
        some => some,
    };
    let Some(requested) = level_of(effort) else { return opts.clone() };
    if levels.is_some_and(|l| !l.contains(&requested)) {
        return opts.clone();
    }
    let mut rejected = entry.map(RejectionEntry::levels).unwrap_or_default();
    if let Some(levels) = levels {
        rejected.extend(ALL_EFFORT_LEVELS.iter().filter(|l| !levels.contains(l)).map(|l| (*l).to_owned()));
    }
    if !rejected.contains(requested) {
        return opts.clone();
    }
    let allow_higher = entry.is_some_and(|e| !e.allowed.is_empty());
    let Some(level) = nearest_accepted_effort(requested, &rejected, allow_higher) else { return opts.clone() };
    let mut next = opts.as_object().cloned().unwrap_or_default();
    next.insert("effort".to_owned(), Value::from(level));
    for key in EFFORT_OPT_KEYS {
        if opts.get(key).is_some() {
            next.insert(key.to_owned(), Value::from(level));
        }
    }
    Value::Object(next)
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn a_projection_collapses_changes_that_share_a_wire_value() {
        let wire = |e: &str| Some(if e == "ultra" { "max" } else { e }.to_owned());
        let projection = EffortProjection::from_session("low", [(2, "max".to_owned()), (4, "ultra".to_owned()), (6, "low".to_owned())], &wire).unwrap();
        assert_eq!(projection.initial_effort, "low");
        assert_eq!(projection.updates.into_iter().collect::<Vec<_>>(), [(2, "max".to_owned()), (6, "low".to_owned())]);
        assert!(EffortProjection::from_session("low", [(1, "high".to_owned())], &|e| (e != "high").then(|| e.to_owned())).is_none());
    }
}
