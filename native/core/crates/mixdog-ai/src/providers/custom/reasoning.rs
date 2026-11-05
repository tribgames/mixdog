//! Per-model reasoning settings of user-defined (`custom-*`) providers. Pure:
//! the effective model row carries the supported effort levels and the wire
//! mapping; this module snaps a requested effort to a supported level and
//! serializes it for the provider's protocol. First-party providers never
//! route through here.
//!
//! [`ReasoningRow::effort_levels`] is the ladder input of the step-effort
//! judge: pass it as `AutoLadder::options` for a custom route.

use std::collections::BTreeMap;

use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::Protocol;
use super::invalid;

/// Ascending strength.
pub const EFFORT_LEVELS: [&str; 7] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const WIRE_FORMATS: [&str; 4] = ["standard", "deepseek", "together", "vllm"];
const MAX_WIRE_VALUE: usize = 64;
const TOGETHER_HOSTS: [&str; 2] = ["together.xyz", "together.ai"];

fn rank(level: &str) -> Option<usize> {
    EFFORT_LEVELS.iter().position(|l| *l == level)
}

pub fn is_custom_provider_name(name: &str) -> bool {
    name.starts_with("custom-")
}

/// One effort token in the custom vocabulary (`ultra` is `max`), or `None`.
pub fn normalize_effort(value: &str) -> Option<&'static str> {
    let v = value.trim().to_ascii_lowercase();
    let level = if v == "ultra" { "max" } else { v.as_str() };
    EFFORT_LEVELS.iter().find(|l| **l == level).copied()
}

/// How the endpoint spells reasoning on the Chat wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WireFormat {
    #[default]
    Standard,
    Deepseek,
    Together,
    Vllm,
}

impl WireFormat {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "standard" => Self::Standard,
            "deepseek" => Self::Deepseek,
            "together" => Self::Together,
            "vllm" => Self::Vllm,
            _ => return None,
        })
    }

    /// Extensions that exist only on the Chat wire.
    fn chat_only(self) -> bool {
        self != Self::Standard
    }
}

/// The stored `customReasoning` of a model.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CustomReasoning {
    pub wire_format: Option<WireFormat>,
    /// Canonical level to the endpoint's own value.
    pub wire_values: BTreeMap<String, String>,
    pub replay: Option<bool>,
}

/// An effort option of a model row (`reasoningOptions`).
#[derive(Debug, Clone, PartialEq)]
pub struct ReasoningOption {
    pub kind: String,
    pub values: Vec<String>,
}

/// The reasoning facts of an effective model row.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReasoningRow {
    pub reasoning_options: Vec<ReasoningOption>,
    pub reasoning_levels: Option<Vec<String>>,
    /// The catalog's reasoning field is `reasoning_content`.
    pub reasoning_content_field: bool,
    pub custom: CustomReasoning,
}

impl ReasoningRow {
    /// Supported levels declared on the row, ranked and deduplicated, or
    /// `None` when the row declares none (unknown). An explicit empty list
    /// stays empty (no reasoning). This is the ladder the step-effort judge
    /// builds from.
    pub fn effort_levels(&self) -> Option<Vec<String>> {
        let raw = self
            .reasoning_options
            .iter()
            .find(|o| o.kind.trim().eq_ignore_ascii_case("effort"))
            .map(|o| &o.values)
            .or(self.reasoning_levels.as_ref())?;
        let known: Vec<&str> = raw.iter().filter_map(|v| normalize_effort(v)).collect();
        Some(
            EFFORT_LEVELS
                .iter()
                .filter(|l| known.contains(l))
                .map(|l| (*l).to_owned())
                .collect(),
        )
    }
}

/// Snaps a requested effort onto `levels`: an exact match stays; `none` is
/// kept only when supported; otherwise the strongest supported non-`none`
/// level not stronger than the request. Never promotes.
pub fn snap_effort(levels: Option<&[String]>, effort: &str) -> Option<&'static str> {
    let requested = normalize_effort(effort)?;
    let supported: Vec<&'static str> = levels?.iter().filter_map(|l| normalize_effort(l)).collect();
    if supported.is_empty() {
        return None;
    }
    if supported.contains(&requested) {
        return Some(requested);
    }
    if requested == "none" {
        return None;
    }
    let ceiling = rank(requested)?;
    supported
        .into_iter()
        .filter(|l| *l != "none" && rank(l).is_some_and(|r| r <= ceiling))
        .max_by_key(|l| rank(l))
}

fn is_together(base_url: &str) -> bool {
    let Some(host) = Url::parse(base_url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)) else {
        return false;
    };
    TOGETHER_HOSTS.iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}

/// The effective Chat wire format of a row: its declared extension, else
/// `together` on Together AI's own base URL, else `standard`.
pub fn wire_format(row: &ReasoningRow, base_url: &str) -> WireFormat {
    match row.custom.wire_format {
        Some(declared) if declared.chat_only() => declared,
        _ if is_together(base_url) => WireFormat::Together,
        _ => WireFormat::Standard,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Thinking {
    On,
    Off,
}

/// What a request carries for its effort.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub level: Option<&'static str>,
    /// Extra request-body fields.
    pub fields: Map<String, Value>,
    pub thinking: Option<Thinking>,
    /// Prior turns' reasoning goes back under `reasoning_content`.
    pub replay: bool,
}

pub fn resolve(protocol: &Protocol, row: &ReasoningRow, effort: Option<&str>, base_url: &str) -> Resolved {
    let empty = Resolved {
        level: None,
        fields: Map::new(),
        thinking: None,
        replay: false,
    };
    let chat = *protocol == Protocol::OpenaiChat;
    if row.custom.wire_format.is_some_and(WireFormat::chat_only) && !chat {
        return empty;
    }
    let format = if chat { wire_format(row, base_url) } else { WireFormat::Standard };
    let levels = row.effort_levels();
    let level = effort.and_then(|e| snap_effort(levels.as_deref(), e));
    let thinking = level.map(|l| if l == "none" { Thinking::Off } else { Thinking::On });
    let value: Option<String> = level.map(|l| {
        row.custom
            .wire_values
            .get(l)
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .unwrap_or(l)
            .to_owned()
    });
    let mut fields = Map::new();
    if let (Some(level), Some(value)) = (level, value) {
        match protocol {
            Protocol::OpenaiChat => match format {
                WireFormat::Deepseek => {
                    if level == "none" {
                        fields.insert("thinking".into(), json!({"type": "disabled"}));
                    } else {
                        fields.insert("thinking".into(), json!({"type": "enabled"}));
                        fields.insert("reasoning_effort".into(), json!(value));
                    }
                }
                // `reasoning.enabled` toggles hybrid models (those that can
                // be turned off); `reasoning_effort` sets the others' depth.
                WireFormat::Together => {
                    if level == "none" {
                        fields.insert("reasoning".into(), json!({"enabled": false}));
                    } else {
                        fields.insert("reasoning_effort".into(), json!(value));
                        if levels.as_ref().is_some_and(|l| l.iter().any(|x| x == "none")) {
                            fields.insert("reasoning".into(), json!({"enabled": true}));
                        }
                    }
                }
                // vLLM switches thinking through the chat template.
                WireFormat::Vllm => {
                    fields.insert("chat_template_kwargs".into(), json!({"enable_thinking": level != "none"}));
                    if level != "none" {
                        fields.insert("reasoning_effort".into(), json!(value));
                    }
                }
                WireFormat::Standard => {
                    fields.insert("reasoning_effort".into(), json!(value));
                }
            },
            Protocol::OpenaiResponses => {
                fields.insert("reasoning".into(), json!({"effort": value}));
            }
            Protocol::Anthropic => {
                if level == "none" {
                    fields.insert("thinking".into(), json!({"type": "disabled"}));
                } else {
                    fields.insert("thinking".into(), json!({"type": "adaptive"}));
                    fields.insert("output_config".into(), json!({"effort": value}));
                }
            }
        }
    }
    // An explicit replay flag wins over the catalog's reasoning field.
    let flag = row.custom.replay.unwrap_or(row.reasoning_content_field);
    Resolved {
        level,
        fields,
        thinking,
        replay: chat && flag && thinking != Some(Thinking::Off),
    }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Canonical level for `raw` (alias-aware), or `None` when unknown.
pub fn canonical_level(raw: &str) -> Option<&'static str> {
    normalize_effort(raw)
}

fn normalize_levels(raw: &Value, label: &str) -> Result<Vec<&'static str>, ProviderError> {
    let Some(items) = raw.as_array() else {
        return Err(invalid(format!("{label} must be an array")));
    };
    let mut seen: Vec<&'static str> = Vec::new();
    for entry in items {
        let level = entry
            .as_str()
            .and_then(canonical_level)
            .ok_or_else(|| invalid(format!("{label} has unknown level: {entry}")))?;
        if seen.contains(&level) {
            return Err(invalid(format!("{label} has duplicate level: {level}")));
        }
        seen.push(level);
    }
    seen.sort_by_key(|l| rank(l));
    Ok(seen)
}

/// `levels` (canonical) ties every key to a declared level; `None` skips the tie.
fn normalize_wire_values(
    raw: &Value,
    label: &str,
    levels: Option<&[&str]>,
) -> Result<BTreeMap<String, String>, ProviderError> {
    let Some(object) = raw.as_object() else {
        return Err(invalid(format!("{label}.wireValues must be an object")));
    };
    let mut by_rank: BTreeMap<usize, (&'static str, String)> = BTreeMap::new();
    for (key, value) in object {
        let level = canonical_level(key).ok_or_else(|| invalid(format!("{label}.wireValues has unknown level: {key}")))?;
        if levels.is_some_and(|l| !l.contains(&level)) {
            return Err(invalid(format!("{label}.wireValues level {level} is not in levels")));
        }
        let at = rank(level).unwrap_or_default();
        if by_rank.contains_key(&at) {
            return Err(invalid(format!("{label}.wireValues has duplicate level: {level}")));
        }
        let text = value
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty() && t.chars().count() <= MAX_WIRE_VALUE)
            .ok_or_else(|| invalid(format!("{label}.wireValues.{level} must be 1-{MAX_WIRE_VALUE} characters")))?;
        by_rank.insert(at, (level, text.to_owned()));
    }
    Ok(by_rank.into_values().map(|(l, v)| (l.to_owned(), v)).collect())
}

/// The stored reasoning config of a provider or model: `levels`,
/// `wireFormat`, `wireValues`, `replay`; anything else is refused.
pub fn normalize_config(
    raw: &Value,
    label: &str,
    protocol: &Protocol,
) -> Result<(Option<Vec<&'static str>>, CustomReasoning), ProviderError> {
    let Some(object) = raw.as_object() else {
        return Err(invalid(format!("{label} must be an object")));
    };
    if let Some(key) = object.keys().find(|k| !["levels", "wireFormat", "wireValues", "replay"].contains(&k.as_str())) {
        return Err(invalid(format!("{label} has unknown field: {key}")));
    }
    let levels = object
        .get("levels")
        .map(|v| normalize_levels(v, &format!("{label}.levels")))
        .transpose()?;
    let mut config = CustomReasoning::default();
    if let Some(value) = object.get("wireFormat") {
        let text = value.as_str().map(str::trim).unwrap_or_default();
        let format = WireFormat::parse(text)
            .ok_or_else(|| invalid(format!("{label}.wireFormat is invalid: {value}")))?;
        if format == WireFormat::Deepseek && *protocol != Protocol::OpenaiChat {
            return Err(invalid(format!("{label}.wireFormat 'deepseek' requires protocol 'openai-chat'")));
        }
        config.wire_format = Some(format);
    }
    if let Some(values) = object.get("wireValues") {
        config.wire_values = normalize_wire_values(values, label, levels.as_deref())?;
    }
    if let Some(replay) = object.get("replay") {
        config.replay = Some(replay.as_bool().ok_or_else(|| invalid(format!("{label}.replay must be a boolean")))?);
    }
    Ok((levels, config))
}

/// Shape check of a tri-state reasoning patch (`null` deletes a field): the
/// stored-override rules for every supplied value, minus the levels to
/// wireValues tie, which the caller settles after merging.
pub fn assert_patch(raw: &Value) -> Result<(), ProviderError> {
    let label = "reasoning patch";
    let Some(object) = raw.as_object() else {
        return Err(invalid(format!("{label} must be an object")));
    };
    if let Some(key) = object.keys().find(|k| !["levels", "wireFormat", "wireValues", "replay"].contains(&k.as_str())) {
        return Err(invalid(format!("{label} has unknown field: {key}")));
    }
    let supplied = |key: &str| object.get(key).filter(|v| !v.is_null());
    if let Some(levels) = supplied("levels") {
        normalize_levels(levels, &format!("{label}.levels"))?;
    }
    if let Some(format) = supplied("wireFormat")
        && format.as_str().map(str::trim).and_then(WireFormat::parse).is_none()
    {
        return Err(invalid(format!("{label}.wireFormat is invalid: {format}")));
    }
    if let Some(values) = supplied("wireValues") {
        normalize_wire_values(values, label, None)?;
    }
    if let Some(replay) = supplied("replay")
        && !replay.is_boolean()
    {
        return Err(invalid(format!("{label}.replay must be a boolean")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(levels: &[&str]) -> ReasoningRow {
        ReasoningRow {
            reasoning_levels: Some(levels.iter().map(|l| (*l).to_owned()).collect()),
            ..ReasoningRow::default()
        }
    }

    #[test]
    fn levels_are_ranked_deduplicated_and_aliased() {
        let r = row(&["high", "ultra", "low", "low", "bogus"]);
        assert_eq!(r.effort_levels().unwrap(), ["low", "high", "max"]);
        assert_eq!(ReasoningRow::default().effort_levels(), None);
        assert_eq!(row(&[]).effort_levels().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn snapping_never_promotes() {
        let levels: Vec<String> = ["none", "low", "high"].map(String::from).to_vec();
        let snap = |e| snap_effort(Some(&levels), e);
        assert_eq!(snap("high"), Some("high"));
        assert_eq!(snap("medium"), Some("low"));
        assert_eq!(snap("xhigh"), Some("high"));
        assert_eq!(snap("minimal"), None);
        assert_eq!(snap("none"), Some("none"));
        assert_eq!(snap_effort(Some(&["low".to_owned()]), "none"), None);
        assert_eq!(snap_effort(None, "low"), None);
    }

    #[test]
    fn each_protocol_serializes_its_own_fields() {
        let r = row(&["none", "low", "high"]);
        let chat = resolve(&Protocol::OpenaiChat, &r, Some("high"), "https://x.test/v1");
        assert_eq!(chat.fields["reasoning_effort"], "high");
        assert_eq!(chat.thinking, Some(Thinking::On));
        let resp = resolve(&Protocol::OpenaiResponses, &r, Some("low"), "");
        assert_eq!(resp.fields["reasoning"], json!({"effort": "low"}));
        let off = resolve(&Protocol::Anthropic, &r, Some("none"), "");
        assert_eq!(off.fields["thinking"], json!({"type": "disabled"}));
        let on = resolve(&Protocol::Anthropic, &r, Some("high"), "");
        assert_eq!(on.fields["output_config"], json!({"effort": "high"}));
    }

    #[test]
    fn chat_extensions_stay_on_the_chat_wire() {
        let mut r = row(&["none", "high"]);
        r.custom.wire_format = Some(WireFormat::Vllm);
        let chat = resolve(&Protocol::OpenaiChat, &r, Some("none"), "");
        assert_eq!(chat.fields["chat_template_kwargs"], json!({"enable_thinking": false}));
        assert!(!chat.fields.contains_key("reasoning_effort"));
        assert_eq!(resolve(&Protocol::OpenaiResponses, &r, Some("high"), ""), Resolved {
            level: None,
            fields: Map::new(),
            thinking: None,
            replay: false,
        });
        let together = resolve(&Protocol::OpenaiChat, &row(&["none", "high"]), Some("high"), "https://api.together.ai/v1");
        assert_eq!(together.fields["reasoning"], json!({"enabled": true}));
    }

    #[test]
    fn wire_values_rename_the_level_and_replay_follows_the_flag() {
        let mut r = row(&["low", "high"]);
        r.custom.wire_values.insert("high".into(), " HIGH_EFFORT ".into());
        r.reasoning_content_field = true;
        let chat = resolve(&Protocol::OpenaiChat, &r, Some("high"), "");
        assert_eq!(chat.fields["reasoning_effort"], "HIGH_EFFORT");
        assert!(chat.replay);
        r.custom.replay = Some(false);
        assert!(!resolve(&Protocol::OpenaiChat, &r, Some("high"), "").replay);
    }

    #[test]
    fn config_is_validated_like_the_product() {
        let ok = json!({"levels": ["high", "low"], "wireFormat": "vllm", "wireValues": {"high": "H"}, "replay": true});
        let (levels, config) = normalize_config(&ok, "reasoning", &Protocol::OpenaiChat).unwrap();
        assert_eq!(levels.unwrap(), ["low", "high"]);
        assert_eq!(config.wire_values["high"], "H");
        let tied = json!({"levels": ["low"], "wireValues": {"high": "H"}});
        assert!(normalize_config(&tied, "reasoning", &Protocol::OpenaiChat).is_err());
        let deepseek = json!({"wireFormat": "deepseek"});
        assert!(normalize_config(&deepseek, "reasoning", &Protocol::Anthropic).is_err());
        assert!(normalize_config(&json!({"extra": 1}), "reasoning", &Protocol::OpenaiChat).is_err());
        assert!(assert_patch(&json!({"levels": null, "replay": true})).is_ok());
        assert!(assert_patch(&json!({"replay": "yes"})).is_err());
    }
}
