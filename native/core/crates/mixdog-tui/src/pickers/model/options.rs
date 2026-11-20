//! Pure model and route label, ordering and picker-row helpers (`src/tui/app/model-options.mjs`).
//!
//! Model records are the JSON objects the store lists (`{ provider, id, display, effortOptions, fastCapable, ... }`); every
//! function reads them the way the Node code did, a missing or non-text field reading as empty.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use mixdog_js::math::{round, to_fixed};
use mixdog_js::{JsRegex, js_sort_by, js_to_lowercase, js_trim, locale_compare, number_to_string, to_number_of, value_to_string};
use mixdog_tui_style::{Key, theme_color};
use mixdog_tui_widgets::picker::{MetaPart, PickerItem};
use mixdog_view_model::display::model_alias::is_rolling_model_alias;
use mixdog_view_model::display::model_display::{display_model_name, effort_display_label};
use mixdog_view_model::errors::error_presentation::describe_error;
use serde_json::{Value, json};

pub use mixdog_view_model::display::provider_display_name::provider_display_name;

use crate::pickers::common::{PanelItem, PickerHost};
use crate::slash::notices::truthy;

/// The provider whose route can carry the Daybreak Blue access program (`DAYBREAK_PROVIDER`).
const DAYBREAK_PROVIDER: &str = "openai-oauth";
/// The model parameter that turns Daybreak Blue on (`DAYBREAK_PARAMETER_ID`).
pub const DAYBREAK_PARAMETER_ID: &str = "daybreak";
/// OpenRouter's routing parameter (`OPENROUTER_SORT_PARAMETER`).
pub const OPENROUTER_SORT_PARAMETER: &str = "providerSort";

fn re(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "")
}

static CLAUDE_VERSION: LazyLock<JsRegex> = LazyLock::new(|| re(r"^claude-[a-z]+-(\d+)(?:[-.](\d+))?"));
static COMPACT_VERSION: LazyLock<JsRegex> = LazyLock::new(|| re(r"(?:^|[-_])(?:o|gpt|grok|qwen|llama|mistral|gemma|phi|glm)(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?"));
static GENERIC_VERSION: LazyLock<JsRegex> = LazyLock::new(|| re(r"(?:^|[-_v])(\d+)(?:\.(\d+))?(?:\.(\d{1,3}))?"));
static DATED_ID: LazyLock<JsRegex> = LazyLock::new(|| re(r"(?:^|-)(\d{4})(\d{2})(\d{2})(?:$|-)"));
static CLAUDE_ID: LazyLock<JsRegex> = LazyLock::new(|| re(r"^claude-[a-z]+-"));
static CLAUDE_FAMILY: LazyLock<JsRegex> = LazyLock::new(|| re(r"^claude-([a-z]+)"));
static FIRST_WORDS: LazyLock<JsRegex> = LazyLock::new(|| re(r"^[a-z]+(?:-[a-z]+)?"));
static CLAUDE_FOUR: LazyLock<JsRegex> = LazyLock::new(|| re(r"^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)"));

/// `String(x || '')`: the text of a field, empty when it is absent or falsy.
pub fn text_of(value: Option<&Value>) -> String {
    match value {
        Some(v) if truthy(v) => value_to_string(v),
        _ => String::new(),
    }
}

/// `String(model?.field || '')`.
fn field_text(model: &Value, key: &str) -> String {
    text_of(model.get(key))
}

/// `Number(x) || 0`.
fn number_or_zero(text: &str) -> f64 {
    let n = mixdog_js::string_to_number(text);
    if n.is_nan() { 0.0 } else { n }
}

fn field_truthy(model: &Value, key: &str) -> bool {
    model.get(key).is_some_and(truthy)
}

/// `parsedModelVersion(id)`: Claude ids give `[major, minor]`, compact vendor ids and any other id the numbers they carry.
pub fn parsed_model_version(id: &str) -> Vec<f64> {
    let text = js_to_lowercase(id);
    if let Some(claude) = CLAUDE_VERSION.captures(&text) {
        let part = |at| claude.get(at).map_or(0.0, number_or_zero);
        return vec![part(1), part(2)];
    }
    let version = COMPACT_VERSION.captures(&text).or_else(|| GENERIC_VERSION.captures(&text));
    let Some(version) = version else { return Vec::new() };
    (1..=3).filter_map(|at| version.get(at)).map(number_or_zero).collect()
}

/// `releaseTime(m)`: the release date, else the creation stamp (seconds or milliseconds), else the date in the id; 0 for none.
pub fn release_time(model: &Value) -> f64 {
    if field_truthy(model, "releaseDate") {
        let t = mixdog_js::time::date_parse(&value_to_string(&model["releaseDate"]));
        if t.is_finite() {
            return t;
        }
    }
    let created = to_number_of(model.get("created"));
    if created.is_finite() && created > 0.0 {
        return if created < 1_000_000_000_000.0 { created * 1000.0 } else { created };
    }
    let id = field_text(model, "id");
    let Some(dated) = DATED_ID.captures(&id) else { return 0.0 };
    let parsed =
        mixdog_js::time::date_parse(&format!("{}-{}-{}", dated.get(1).unwrap_or_default(), dated.get(2).unwrap_or_default(), dated.get(3).unwrap_or_default()));
    if parsed.is_nan() { 0.0 } else { parsed }
}

/// `isClaudeModel(m)`.
pub fn is_claude_model(model: &Value) -> bool {
    let provider = js_to_lowercase(&field_text(model, "provider"));
    let id = js_to_lowercase(&field_text(model, "id"));
    provider.contains("anthropic") && CLAUDE_ID.is_match(&id)
}

/// `modelVersion(m)`: the version of the id, else of the display name.
pub fn model_version(model: &Value) -> Vec<f64> {
    let from_id = parsed_model_version(&field_text(model, "id"));
    if !from_id.is_empty() {
        return from_id;
    }
    let display = if field_truthy(model, "display") { field_text(model, "display") } else { field_text(model, "name") };
    parsed_model_version(&display)
}

/// `compareModelVersion(a, b)`: newest first; a model without a version sorts last.
pub fn compare_model_version(a: &Value, b: &Value) -> f64 {
    let va = model_version(a);
    let vb = model_version(b);
    if va.is_empty() && vb.is_empty() {
        return 0.0;
    }
    if va.is_empty() {
        return 1.0;
    }
    if vb.is_empty() {
        return -1.0;
    }
    for at in 0..va.len().max(vb.len()) {
        let delta = vb.get(at).copied().unwrap_or(0.0) - va.get(at).copied().unwrap_or(0.0);
        if delta != 0.0 && !delta.is_nan() {
            return delta;
        }
    }
    0.0
}

fn display_or_id(model: &Value) -> String {
    if field_truthy(model, "display") { field_text(model, "display") } else { field_text(model, "id") }
}

fn ordering_number(order: std::cmp::Ordering) -> f64 {
    match order {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// `compareModelRecency(a, b)`: the picker's order. Claude models by latest flag, version, then release time; any other model
/// by release date when both have one, then version, then latest flag, then release time; the display name last.
pub fn compare_model_recency(a: &Value, b: &Value) -> f64 {
    let by_name = || ordering_number(locale_compare(&display_or_id(a), &display_or_id(b)));
    if is_claude_model(a) && is_claude_model(b) {
        let (la, lb) = (field_truthy(a, "latest"), field_truthy(b, "latest"));
        if la != lb {
            return if la { -1.0 } else { 1.0 };
        }
        let version_delta = compare_model_version(a, b);
        if version_delta != 0.0 {
            return version_delta;
        }
        let (ta, tb) = (release_time(a), release_time(b));
        if ta != tb {
            return tb - ta;
        }
        return by_name();
    }
    let (ta, tb) = (release_time(a), release_time(b));
    let version_delta = compare_model_version(a, b);
    // Release dates win only when both sides have one; sparse OAuth catalogs must not sink undated (often newest) models
    // below dated/latest ones.
    if ta > 0.0 && tb > 0.0 && ta != tb {
        return tb - ta;
    }
    if version_delta != 0.0 {
        return version_delta;
    }
    let (la, lb) = (field_truthy(a, "latest"), field_truthy(b, "latest"));
    if la != lb {
        return if la { -1.0 } else { 1.0 };
    }
    if ta != tb {
        return tb - ta;
    }
    by_name()
}

/// `modelFamily(m)`: the Claude family, the catalog's family, or the first words of the id.
pub fn model_family(model: &Value) -> String {
    let id_or_display = if field_truthy(model, "id") { field_text(model, "id") } else { field_text(model, "display") };
    let text = js_to_lowercase(&id_or_display);
    if let Some(claude) = CLAUDE_FAMILY.captures(&text) {
        return claude.get(1).unwrap_or_default().to_owned();
    }
    if field_truthy(model, "family") {
        return js_to_lowercase(&field_text(model, "family"));
    }
    FIRST_WORDS.find(&text).map_or_else(|| "model".to_owned(), |found| text[found].to_owned())
}

/// `modelContextWindow(m)`: the catalog's window, else the one the Claude 5 and 4.6-4.8 lines are known to have; 0 for none.
pub fn model_context_window(model: &Value) -> f64 {
    let raw = to_number_of(model.get("contextWindow"));
    let n = if raw.is_finite() && raw > 0.0 { raw } else { 0.0 };
    if n > 0.0 {
        return n;
    }
    let id = js_to_lowercase(&field_text(model, "id"));
    let version = parsed_model_version(&id);
    if is_claude_model(model) {
        if version.first().copied().unwrap_or(0.0) >= 5.0 {
            return 1_000_000.0;
        }
        if CLAUDE_FOUR.is_match(&id) {
            return 1_000_000.0;
        }
    }
    0.0
}

/// `ToInt32`, as the bitwise operators of JavaScript apply it.
fn to_int32(n: f64) -> i32 {
    if !n.is_finite() {
        return 0;
    }
    let wrapped = n.trunc().rem_euclid(4_294_967_296.0);
    (wrapped as u32) as i32
}

/// `formatContextWindow(tokens)`: `1M Context`, `128k Context`; exact powers of two read in 1024-based units (a Gemini window
/// of 1_048_576 reads `1M`, not `1.049M`); empty for no window.
pub fn format_context_window(tokens: f64) -> String {
    let n = tokens;
    if !n.is_finite() || n <= 0.0 {
        return String::new();
    }
    let unit: f64 = if n >= 1024.0 && (to_int32(n) & to_int32(n - 1.0)) == 0 { 1024.0 } else { 1000.0 };
    let mega = unit * unit;
    if n >= mega {
        let m = n / mega;
        let label = if m.fract() == 0.0 {
            to_fixed(m, 0)
        } else {
            let fixed = to_fixed(m, 3);
            let trimmed = fixed.trim_end_matches('0');
            trimmed.strip_suffix('.').unwrap_or(trimmed).to_owned()
        };
        return format!("{label}M Context");
    }
    format!("{}k Context", number_to_string(round(n / unit)))
}

/// `modelFamilyLimit(provider, family)`: how many versions of a family the picker keeps.
pub fn model_family_limit(provider: &str, family: &str) -> usize {
    if !js_to_lowercase(provider).contains("anthropic") {
        return 8;
    }
    if family == "opus" { 3 } else { 1 }
}

/// `normalizeModelOptions(models)`: each provider's models newest first, limited per family (rolling `-latest` aliases are
/// never limited), the provider's rows sorted again as a whole.
pub fn normalize_model_options(models: &[Value]) -> Vec<Value> {
    let mut providers: Vec<(String, Vec<(String, Vec<Value>)>)> = Vec::new();
    for model in models {
        if !field_truthy(model, "provider") || !field_truthy(model, "id") {
            continue;
        }
        let provider = field_text(model, "provider");
        let at = providers.iter().position(|(name, _)| *name == provider).unwrap_or_else(|| {
            providers.push((provider.clone(), Vec::new()));
            providers.len() - 1
        });
        let families = &mut providers[at].1;
        let family = model_family(model);
        let slot = families.iter().position(|(name, _)| *name == family).unwrap_or_else(|| {
            families.push((family.clone(), Vec::new()));
            families.len() - 1
        });
        families[slot].1.push(model.clone());
    }
    let mut normalized = Vec::new();
    for (provider, families) in providers {
        let mut provider_models: Vec<Value> = Vec::new();
        for (family, mut group) in families {
            let limit = model_family_limit(&provider, &family);
            js_sort_by(&mut group, compare_model_recency);
            // Version limits must not hide rolling routes, even when several vendors' "~..." IDs share the fallback family.
            let mut versions = 0;
            provider_models.extend(group.into_iter().filter(|model| {
                if is_rolling_model_alias(&field_text(model, "id")) {
                    return true;
                }
                let keep = versions < limit;
                versions += 1;
                keep
            }));
        }
        js_sort_by(&mut provider_models, compare_model_recency);
        normalized.extend(provider_models);
    }
    normalized
}

/// The names setup gives providers, by provider id.
pub type ProviderNames = BTreeMap<String, String>;

/// `resolveProviderDisplayName(provider, providerNames)`: a custom provider reads by the name setup gave it.
pub fn resolve_provider_display_name(provider: &str, names: Option<&ProviderNames>) -> String {
    let trimmed = js_trim(provider);
    if trimmed.starts_with("custom-") {
        if let Some(name) = names.and_then(|names| names.get(trimmed)).filter(|name| !name.is_empty()) {
            return name.clone();
        }
    }
    provider_display_name(provider)
}

/// The rows of one group of provider setup entries (`setup[group]`).
fn setup_entries<'a>(setup: &'a Value, group: &str) -> impl Iterator<Item = &'a Value> {
    setup.get(group).and_then(Value::as_array).into_iter().flatten()
}

/// `loadProviderDisplayNames(store)`: the names of the setup rows, best effort (a missing or failing setup gives none).
pub fn load_provider_display_names(host: &mut dyn PickerHost) -> ProviderNames {
    let Ok(setup) = host.store_call("getProviderSetup", json!([])) else { return ProviderNames::new() };
    let mut names = ProviderNames::new();
    for group in ["api", "oauth", "local"] {
        for entry in setup_entries(&setup, group).filter(|entry| entry.is_object()) {
            let id = first_text(entry, &["id", "provider"]);
            let name = first_text(entry, &["name", "label"]);
            if !id.is_empty() && !name.is_empty() {
                names.insert(id, name);
            }
        }
    }
    names
}

/// `String(entry.a || entry.b || '').trim()`.
fn first_text(entry: &Value, keys: &[&str]) -> String {
    let found = keys.iter().filter_map(|key| entry.get(*key)).find(|value| truthy(value));
    js_trim(&found.map(value_to_string).unwrap_or_default()).to_owned()
}

/// Provider names for the picker (`catalogProviderDisplayNames`): custom rows' own `providerName` first, then the setup names
/// over them (setup wins). Works when setup is missing or failed.
pub fn catalog_provider_display_names(models: &[Value], setup_names: &ProviderNames) -> ProviderNames {
    let mut names = ProviderNames::new();
    for model in models {
        let provider = js_trim(&field_text(model, "provider")).to_owned();
        let name = js_trim(&field_text(model, "providerName")).to_owned();
        if provider.starts_with("custom-") && !name.is_empty() {
            names.insert(provider, name);
        }
    }
    names.extend(setup_names.iter().map(|(id, name)| (id.clone(), name.clone())));
    names
}

/// A provider whose model list failed, with the reason and what to do about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogFailure {
    pub id: String,
    pub text: String,
}

/// `loadProviderCatalogFailures(store)`: one entry per setup row whose model list failed.
pub fn load_provider_catalog_failures(host: &mut dyn PickerHost) -> Vec<CatalogFailure> {
    let Ok(setup) = host.store_call("getProviderSetup", json!([])) else { return Vec::new() };
    let mut failures = Vec::new();
    for group in ["api", "oauth", "local"] {
        for entry in setup_entries(&setup, group) {
            let Some(failure) = entry.get("catalogError").filter(|failure| failure.get("message").is_some_and(truthy)) else {
                continue;
            };
            let presented =
                describe_error(Some(&json!({"message": failure["message"], "errorKind": failure.get("errorKind").cloned().unwrap_or(Value::Null)})), None);
            let text = [presented.summary, presented.recovery].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
            failures.push(CatalogFailure { id: field_text(entry, "id").trim().to_owned(), text });
        }
    }
    failures
}

/// `buildCatalogFailureItems(failures, models, providerNames)`: provider-list rows for failed providers that have no model
/// rows, so an empty provider says why instead of being absent.
pub fn build_catalog_failure_items(failures: &[CatalogFailure], models: &[Value], names: Option<&ProviderNames>) -> Vec<PanelItem> {
    failures
        .iter()
        .filter(|failure| !failure.id.is_empty() && !models.iter().any(|model| field_text(model, "provider") == failure.id))
        .map(|failure| {
            let mut item = PickerItem::new(&format!("provider-failed:{}", failure.id), &resolve_provider_display_name(&failure.id, names));
            item.marker = "!".to_owned();
            item.marker_color = Some(theme_color(Key::Error));
            item.description.clone_from(&failure.text);
            PanelItem::new(item, json!({"_action": "catalog-failed", "_failure": failure.text}))
        })
        .collect()
}

/// `providerDisplayRank(provider)`: where a provider sits in the list (OpenRouter lists hundreds of models, so it stays
/// behind every other provider).
pub fn provider_display_rank(provider: &str) -> f64 {
    match js_to_lowercase(provider).as_str() {
        "default" => 0.0,
        "openai-oauth" => 10.0,
        "anthropic-oauth" => 20.0,
        "grok-oauth" => 30.0,
        "muse-code-oauth" => 33.0,
        "command-code-oauth" => 33.5,
        "mimo-oauth" => 34.0,
        "antigravity-oauth" => 31.0,
        "cursor-oauth" => 32.0,
        "devin-oauth" => 32.5,
        "opencode-go-oauth" => 34.5,
        "openai" | "openai-api" => 40.0,
        "anthropic" | "anthropic-api" => 50.0,
        "gemini" | "gemini-api" => 60.0,
        "xai" | "xai-api" => 70.0,
        "deepseek" | "deepseek-api" => 90.0,
        "mixdog-local" => 100.0,
        "openrouter" => 950.0,
        _ => 900.0,
    }
}

/// `fastDisplayLabel(enabled)`.
pub fn fast_display_label(enabled: bool) -> String {
    format!("Fast {}", if enabled { "On" } else { "Off" })
}

/// `modelDescription(m)`: the catalog description, then `Fast Available`.
pub fn model_description(model: &Value) -> String {
    let description = js_trim(&field_text(model, "description")).to_owned();
    let fast = if field_truthy(model, "fastCapable") { "Fast Available".to_owned() } else { String::new() };
    [description, fast].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")
}

fn model_record_display_name(model: &Value) -> String {
    let hint = if field_truthy(model, "display") { field_text(model, "display") } else { field_text(model, "name") };
    display_model_name(&field_text(model, "id"), &hint)
}

/// `daybreakBlueOn(modelParameters)`.
pub fn daybreak_blue_on(parameters: Option<&Value>) -> bool {
    let value = parameters.and_then(|parameters| parameters.get(DAYBREAK_PARAMETER_ID)).filter(|value| !value.is_null());
    js_to_lowercase(js_trim(&value.map(value_to_string).unwrap_or_default())) == "on"
}

/// The route's model name; Daybreak Blue reads as part of the model ("GPT-6 Sol Blue"), ahead of effort.
fn route_model_display_name(route: &Value) -> String {
    let name = display_model_name(&field_text(route, "model"), &field_text(route, "modelDisplay"));
    let blue =
        if field_text(route, "provider") == DAYBREAK_PROVIDER && daybreak_blue_on(route.get("modelParameters")) { "Blue".to_owned() } else { String::new() };
    [name, blue].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ")
}

/// The configured speed tier: Ultrafast when the fast route asks for it.
fn route_speed_label(route: &Value) -> String {
    if !field_truthy(route, "fast") {
        return String::new();
    }
    let tier = route.get("modelParameters").and_then(|parameters| parameters.get("serviceTier")).and_then(Value::as_str);
    let label = if tier == Some("ultrafast") { "Ultrafast" } else { "Fast" };
    label.to_owned()
}

/// Model, effort, then Fast or Ultrafast, dropping the empty parts.
fn route_model_details(route: &Value) -> String {
    let effort = if field_truthy(route, "effort") { effort_display_label(&field_text(route, "effort")) } else { String::new() };
    [route_model_display_name(route), effort, route_speed_label(route)].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" \u{b7} ")
}

/// `groupModelsByProvider`: the providers in list order (rank, then name, then id) and their models.
fn group_models_by_provider(models: &[Value], names: Option<&ProviderNames>) -> Vec<(String, Vec<Value>)> {
    let mut providers: Vec<(String, Vec<Value>)> = Vec::new();
    for model in models {
        let provider = field_text(model, "provider");
        match providers.iter_mut().find(|(name, _)| *name == provider) {
            Some((_, group)) => group.push(model.clone()),
            None => providers.push((provider, vec![model.clone()])),
        }
    }
    js_sort_by(&mut providers, |(a, _), (b, _)| {
        let rank = provider_display_rank(a) - provider_display_rank(b);
        if rank != 0.0 {
            return rank;
        }
        let label = ordering_number(locale_compare(&resolve_provider_display_name(a, names), &resolve_provider_display_name(b, names)));
        if label != 0.0 {
            return label;
        }
        ordering_number(locale_compare(a, b))
    });
    providers
}

/// `buildModelProviderItems(models, currentRoute, providerNames)`: one row per provider, marked when the current route's model
/// is among its models.
pub fn build_model_provider_items(models: &[Value], current_route: Option<&Value>, names: Option<&ProviderNames>) -> Vec<PanelItem> {
    group_models_by_provider(models, names)
        .into_iter()
        .map(|(provider, provider_models)| {
            let current_model = current_route
                .filter(|route| field_text(route, "provider") == provider)
                .and_then(|route| provider_models.iter().find(|model| model.get("id") == route.get("model") && model.get("id").is_some()));
            let mut item = PickerItem::new(&format!("provider:{provider}"), &resolve_provider_display_name(&provider, names));
            item.marker = if current_model.is_some() { "\u{2713}".to_owned() } else { String::new() };
            item.marker_color = Some(theme_color(Key::Success));
            item.meta = current_model.map(model_record_display_name).unwrap_or_default();
            let count = provider_models.len();
            item.description = format!("{count} model{}", if count == 1 { "" } else { "s" });
            PanelItem::new(item, json!({"_action": "open-provider", "_provider": provider}))
        })
        .collect()
}

/// `buildProviderModelItems(models, provider, currentRoute)`: one row per model of `provider`.
pub fn build_provider_model_items(models: &[Value], provider: &str, current_route: Option<&Value>) -> Vec<PanelItem> {
    models
        .iter()
        .filter(|model| field_text(model, "provider") == provider)
        .map(|model| {
            let (model_provider, id) = (field_text(model, "provider"), field_text(model, "id"));
            let current = current_route
                .is_some_and(|route| field_text(route, "provider") == model_provider && field_text(route, "model") == id && model.get("id").is_some());
            let mut item = PickerItem::new(&format!("model:{model_provider}:{id}"), &model_record_display_name(model));
            item.marker = if current { "\u{2713}".to_owned() } else { String::new() };
            item.marker_color = Some(theme_color(Key::Success));
            item.description = model_description(model);
            PanelItem::new(item, json!({"_action": "select-model", "_provider": model_provider, "_modelId": id, "_model": model}))
        })
        .collect()
}

/// `routeLabel(route, providerNames)`: `Provider · Model · Effort · Fast`, `(unset)` without a route.
pub fn route_label(route: &Value, names: Option<&ProviderNames>) -> String {
    if !field_truthy(route, "provider") || !field_truthy(route, "model") {
        return "(unset)".to_owned();
    }
    [resolve_provider_display_name(&field_text(route, "provider"), names), route_model_details(route)]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" \u{b7} ")
}

/// `routeModelLabel(route)`.
pub fn route_model_label(route: &Value) -> String {
    if field_truthy(route, "model") { route_model_details(route) } else { "(unset)".to_owned() }
}

/// `agentModelProfile(route)`.
pub fn agent_model_profile(route: &Value) -> String {
    if field_truthy(route, "model") { route_model_details(route) } else { String::new() }
}

/// `agentModelParts(route)`: the model, effort and speed columns of an agent row.
pub fn agent_model_parts(route: &Value) -> Vec<MetaPart> {
    let model = if field_truthy(route, "model") { route_model_display_name(route) } else { String::new() };
    let effort = if field_truthy(route, "effort") { effort_display_label(&field_text(route, "effort")) } else { String::new() };
    vec![MetaPart { text: model, width: 17 }, MetaPart { text: effort, width: 6 }, MetaPart { text: route_speed_label(route), width: 9 }]
}

/// `routeFromModel(model, effort)`: the route naming a model, with an effort other than `auto`.
pub fn route_from_model(model: &Value, effort: Option<&str>) -> Value {
    let mut route = json!({"provider": model.get("provider").cloned().unwrap_or(Value::Null), "model": model.get("id").cloned().unwrap_or(Value::Null)});
    if let Some(effort) = effort.filter(|effort| !effort.is_empty() && *effort != "auto") {
        route["effort"] = json!(effort);
    }
    route
}
