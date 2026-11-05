//! `GET {base}/models` rows of the OpenAI-compatible family
//! (`openai-compat-models.mjs`) and the per-model facts the codecs read. A
//! capability is `Option`: unknown stays unknown and the codec then omits the
//! optional request field rather than guessing from the model id.

use std::collections::HashMap;
use std::sync::Arc;

use arc_swap::ArcSwap;
use mixdog_protocol::JsonValue;

use super::profile::Wire;

/// Effort vocabulary, weakest to strongest (`CUSTOM_EFFORT_LEVELS`).
pub const EFFORT_LEVELS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/// One effort token in the shared vocabulary (`ultra` is `max`), or `None`.
pub fn normalize_effort(value: &str) -> Option<&'static str> {
    let v = mixdog_js::js_trim(value).to_lowercase();
    let v = if v == "ultra" { "max" } else { v.as_str() };
    EFFORT_LEVELS.iter().copied().find(|level| *level == v)
}

/// A requested effort folded onto the levels a gateway declares for a model
/// (`normalizeOpencodeGoReasoningEffort`): exact, `max`/`xhigh` onto `max`,
/// `high`/`medium`/`low` onto `high`; otherwise none.
pub fn fold_declared_effort(requested: &str, levels: &[&str]) -> Option<String> {
    if levels.is_empty() {
        return None;
    }
    let effort = mixdog_js::js_trim(requested).to_lowercase();
    if levels.contains(&effort.as_str()) {
        return Some(effort);
    }
    if matches!(effort.as_str(), "max" | "xhigh") && levels.contains(&"max") {
        return Some("max".into());
    }
    if matches!(effort.as_str(), "high" | "medium" | "low") && levels.contains(&"high") {
        return Some("high".into());
    }
    None
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct CompatModelInfo {
    pub id: String,
    pub display_name: Option<String>,
    pub context_window: Option<u32>,
    pub output_tokens: Option<u32>,
    pub created: Option<i64>,
    /// `chat`, `completion`, `non_chat`, `embedding`, … when the listing says.
    pub mode: Option<String>,
    /// The slug an alias currently points at (capability lookup only).
    pub alias_target: Option<String>,
    /// Effort levels the endpoint declares, in vocabulary order; empty when
    /// it declares none.
    pub reasoning_levels: Vec<&'static str>,
    /// The listing says the model reasons (a declared level other than
    /// `none`, or an explicit capability flag). `None` = not said.
    pub supports_reasoning: Option<bool>,
    /// Wires a row declares (`supported_endpoints`); `None` = not declared.
    pub endpoints: Option<Vec<Wire>>,
    /// What the model can emit (`text`, `audio`, `image`, …) as the listing or
    /// the catalog (models.dev `modalities.output`) states it; `None` = not said.
    pub output_modalities: Option<Vec<String>>,
}

fn positive(value: Option<&JsonValue>) -> Option<u32> {
    let n = value?.as_f64()?;
    (n.is_finite() && n >= 1.0).then(|| n.min(f64::from(u32::MAX)) as u32)
}

fn first_positive(item: &JsonValue, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| positive(item.get(key)))
}

/// Effort levels and reasoning support an endpoint declares for a row.
fn effort_info(item: &JsonValue) -> (Vec<&'static str>, Option<bool>) {
    let caps = item.get("capabilities");
    let declared = [
        item.get("reasoning_efforts"),
        item.get("reasoning_levels"),
        item.get("reasoningLevels"),
        caps.and_then(|c| c.get("reasoning_efforts")),
        caps.and_then(|c| c.get("reasoning_effort")),
    ]
    .into_iter()
    .flatten()
    .find_map(JsonValue::as_array);
    if let Some(rows) = declared {
        let named: Vec<&'static str> = rows
            .iter()
            .filter_map(|row| row.as_str().or_else(|| row.get("value").and_then(JsonValue::as_str)))
            .filter_map(normalize_effort)
            .collect();
        let levels: Vec<&'static str> = EFFORT_LEVELS
            .iter()
            .copied()
            .filter(|level| named.contains(level))
            .collect();
        if levels.is_empty() {
            return (Vec::new(), None);
        }
        let reasons = levels.iter().any(|level| *level != "none");
        return (levels, Some(reasons));
    }
    let flag = item.get("supports_reasoning_effort") == Some(&JsonValue::Bool(true))
        || caps.and_then(|c| c.get("reasoning_effort")) == Some(&JsonValue::Bool(true))
        || caps.and_then(|c| c.get("reasoning_efforts")) == Some(&JsonValue::Bool(true));
    (Vec::new(), flag.then_some(true))
}

/// Provider-native chat-ness: Together `type`, OpenRouter output modalities,
/// Mistral `capabilities`. `None` when the listing says nothing.
fn native_mode(item: &JsonValue) -> Option<String> {
    let kind = item
        .get("type")
        .and_then(JsonValue::as_str)
        .map(|t| mixdog_js::js_trim(t).to_lowercase());
    match kind.as_deref() {
        Some("chat") => return Some("chat".into()),
        Some("language" | "code") => return Some("completion".into()),
        Some(
            k @ ("embedding" | "embeddings" | "image" | "audio" | "rerank" | "moderation" | "video"
            | "transcribe"),
        ) => return Some(k.to_owned()),
        _ => {}
    }
    if let Some(outputs) = item
        .get("architecture")
        .and_then(|a| a.get("output_modalities"))
        .and_then(JsonValue::as_array)
        && !outputs.is_empty()
        && !outputs.iter().any(|m| m.as_str() == Some("text"))
    {
        return Some("non_chat".into());
    }
    match item.get("capabilities").and_then(|c| c.get("completion_chat")) {
        Some(JsonValue::Bool(true)) => Some("chat".into()),
        Some(JsonValue::Bool(false)) => Some("non_chat".into()),
        _ => None,
    }
}

/// The wires a row declares in `supported_endpoints` (`/chat/completions`,
/// `/messages`, `/responses`, with an optional `provider/` or `v1/` prefix).
fn declared_wires(item: &JsonValue) -> Option<Vec<Wire>> {
    let declared = item.get("supported_endpoints")?.as_array()?;
    let mut wires = Vec::new();
    for endpoint in declared {
        let text = endpoint.as_str().unwrap_or_default();
        let path = text.trim_start_matches('/');
        let path = path.strip_prefix("provider/").unwrap_or(path);
        let path = path.strip_prefix("v1/").unwrap_or(path);
        let wire = match path {
            "chat/completions" => Wire::Chat,
            "messages" => Wire::Messages,
            "responses" => Wire::Responses,
            _ => continue,
        };
        if !wires.contains(&wire) {
            wires.push(wire);
        }
    }
    Some(wires)
}

/// `architecture.output_modalities` (OpenRouter) or `modalities.output`.
fn output_modalities(item: &JsonValue) -> Option<Vec<String>> {
    let list = item
        .get("architecture")
        .and_then(|a| a.get("output_modalities"))
        .or_else(|| item.get("modalities").and_then(|m| m.get("output")))?
        .as_array()?;
    Some(list.iter().filter_map(|m| m.as_str().map(str::to_owned)).collect())
}

/// Rows of a `/models` body: `{data:[…]}` or a bare array.
pub fn parse_models(body: &JsonValue) -> Vec<CompatModelInfo> {
    let rows = body
        .get("data")
        .and_then(JsonValue::as_array)
        .or_else(|| body.as_array());
    rows.into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("id")?.as_str().filter(|id| !id.is_empty())?.to_owned();
            let (reasoning_levels, supports_reasoning) = effort_info(item);
            let output_tokens = first_positive(
                item,
                &["max_output_tokens", "output_tokens", "maxOutputTokens"],
            )
            .or_else(|| positive(item.get("top_provider").and_then(|t| t.get("max_completion_tokens"))));
            let context_window = first_positive(
                item,
                &[
                    "context_window",
                    "max_context_window",
                    "max_input_tokens",
                    "max_model_len",
                    "context_length",
                    "max_context_length",
                ],
            )
            .or_else(|| positive(item.get("top_provider").and_then(|t| t.get("context_length"))))
            .or_else(|| positive(item.get("contextWindow")));
            let alias_target = item.get("alias_target").and_then(|a| {
                a.as_str()
                    .or_else(|| a.get("slug").and_then(JsonValue::as_str))
                    .map(str::to_owned)
            });
            let display_name = ["display_name", "name"]
                .iter()
                .find_map(|key| item.get(key).and_then(JsonValue::as_str))
                .map(|name| mixdog_js::js_trim(name).to_owned())
                .filter(|name| !name.is_empty());
            Some(CompatModelInfo {
                id,
                display_name,
                context_window,
                output_tokens,
                created: item.get("created").and_then(JsonValue::as_i64),
                mode: native_mode(item),
                alias_target,
                reasoning_levels,
                supports_reasoning,
                endpoints: declared_wires(item),
                output_modalities: output_modalities(item),
            })
        })
        .collect()
}

impl CompatModelInfo {
    /// Whether the model can serve a text chat turn. A listing that states no
    /// kind says nothing against it.
    pub fn serves_chat(&self) -> bool {
        // A model that cannot emit text serves no text turn.
        if self
            .output_modalities
            .as_ref()
            .is_some_and(|m| !m.is_empty() && !m.iter().any(|x| x == "text"))
        {
            return false;
        }
        !matches!(
            self.mode.as_deref(),
            Some(
                "non_chat" | "embedding" | "embeddings" | "image" | "audio" | "rerank"
                    | "moderation" | "video" | "transcribe"
            )
        )
    }

    /// Fills what this row does not state from `seed` (catalog data the
    /// provider's listing lacks).
    fn fill_from(&mut self, seed: &SeedModel) {
        if self.mode.is_none() {
            self.mode = seed.mode.map(str::to_owned);
        }
        if self.supports_reasoning.is_none() {
            self.supports_reasoning = seed.supports_reasoning;
        }
        if self.reasoning_levels.is_empty() {
            self.reasoning_levels = seed.reasoning_levels.to_vec();
        }
        if self.output_tokens.is_none() {
            self.output_tokens = seed.output_tokens;
        }
    }
}

/// A fact about a model that the provider's own listing does not carry.
/// Exact ids only; the listing's own statement always wins.
#[derive(Clone, Copy, Debug)]
pub struct SeedModel {
    pub id: &'static str,
    /// Model kind (`audio`, `chat`, …).
    pub mode: Option<&'static str>,
    /// `Some(false)`: the model rejects a reasoning-effort parameter.
    pub supports_reasoning: Option<bool>,
    /// Effort levels the model takes, in vocabulary order; empty = not said.
    pub reasoning_levels: &'static [&'static str],
    pub output_tokens: Option<u32>,
}

/// The rows the last successful listing returned, read by the codecs while a
/// request is encoded. Replaced whole; readers never wait.
#[derive(Debug)]
pub struct ModelTable {
    rows: ArcSwap<HashMap<String, Arc<CompatModelInfo>>>,
    seed: &'static [SeedModel],
}

impl Default for ModelTable {
    fn default() -> Self {
        Self::with_seed(&[])
    }
}

impl ModelTable {
    pub fn with_seed(seed: &'static [SeedModel]) -> Self {
        Self {
            rows: ArcSwap::from_pointee(HashMap::new()),
            seed,
        }
    }

    pub fn replace(&self, models: Vec<CompatModelInfo>) {
        let rows = models
            .into_iter()
            .map(|mut row| {
                if let Some(seed) = self.seed.iter().find(|s| s.id == row.id) {
                    row.fill_from(seed);
                }
                (row.id.clone(), Arc::new(row))
            })
            .collect();
        self.rows.store(Arc::new(rows));
    }

    /// Records what the metadata catalog states a model can emit, for listed
    /// rows whose own listing says nothing (the catalog fills gaps only).
    pub fn fill_output_modalities(&self, catalog: impl Fn(&str) -> Option<Vec<String>>) {
        let rows = self
            .rows
            .load()
            .iter()
            .map(|(id, row)| {
                let mut row = (**row).clone();
                if row.output_modalities.is_none() {
                    row.output_modalities = catalog(id);
                }
                (id.clone(), Arc::new(row))
            })
            .collect();
        self.rows.store(Arc::new(rows));
    }

    /// The listed row; a seeded model the listing lacks is still known.
    pub fn get(&self, id: &str) -> Option<Arc<CompatModelInfo>> {
        if let Some(row) = self.rows.load().get(id) {
            return Some(row.clone());
        }
        self.seed.iter().find(|s| s.id == id).map(|seed| {
            let mut row = CompatModelInfo {
                id: id.to_owned(),
                ..CompatModelInfo::default()
            };
            row.fill_from(seed);
            Arc::new(row)
        })
    }

    /// The listed models that can serve a chat turn, sorted by id.
    pub fn chat_models(&self) -> Vec<Arc<CompatModelInfo>> {
        let mut rows: Vec<_> = self
            .rows
            .load()
            .values()
            .filter(|row| row.serves_chat())
            .cloned()
            .collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_limits_modes_levels_and_endpoints() {
        let rows = parse_models(&json!({"data":[
            {"id":"a","context_length":128000,"top_provider":{"max_completion_tokens":4096},
             "architecture":{"output_modalities":["image"]},"reasoning_efforts":["high","ultra","bogus"]},
            {"id":"b","supported_endpoints":["/provider/v1/messages","chat/completions","/x"],"display_name":" B "},
            {"id":""}
        ]}));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].context_window, Some(128_000));
        assert_eq!(rows[0].output_tokens, Some(4096));
        assert_eq!(rows[0].mode.as_deref(), Some("non_chat"));
        assert_eq!(rows[0].reasoning_levels, ["high", "max"]);
        assert_eq!(rows[0].supports_reasoning, Some(true));
        assert_eq!(rows[1].endpoints, Some(vec![Wire::Messages, Wire::Chat]));
        assert_eq!(rows[1].display_name.as_deref(), Some("B"));
        assert_eq!(rows[1].supports_reasoning, None);
    }

    #[test]
    fn table_replaces_whole() {
        let table = ModelTable::default();
        table.replace(parse_models(&json!([{"id":"m","max_output_tokens":9}])));
        assert_eq!(table.get("m").unwrap().output_tokens, Some(9));
        table.replace(Vec::new());
        assert!(table.get("m").is_none());
    }
}
