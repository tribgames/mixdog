use mixdog_protocol::ProviderId;
use serde::Deserialize;
use serde::Serialize;

/// Where a field value came from; a higher layer overrides a lower one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum MetadataSource {
    #[default]
    Native,
    ModelsDev,
    LiteLlm,
    Override,
}

/// Tri-state capability: unknown is not false. Unknown omits the optional
/// request field and shows "capability unknown" in the picker.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    #[default]
    Unknown,
    Yes,
    No,
}

/// Cost per million tokens; each rate may be absent.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Rates {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

/// Documented `thinkingBudget` range of a budget-only model.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSpec {
    pub name: String,
    pub min: i64,
    pub max: i64,
    pub can_disable: bool,
    /// Effort level → budget.
    pub efforts: Vec<(String, i64)>,
}

/// How a model's thinking is controlled, as its source states it.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Thinking {
    /// Nothing declared: wire-vocabulary values pass and the server decides.
    #[default]
    Unspecified,
    Levels(Vec<String>),
    Budget(BudgetSpec),
}

pub use mixdog_core_api::domain::provider::CustomReasoning;
pub use mixdog_core_api::domain::provider::ParameterOption;
pub use mixdog_core_api::domain::provider::ParameterValue;
pub use mixdog_core_api::domain::provider::PickerFields;
pub use mixdog_core_api::domain::provider::ReasoningOption;
pub use mixdog_core_api::domain::provider::ServiceTier;

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRecord {
    /// The picker's row fields, as the adapter listed them.
    #[serde(default)]
    pub picker: PickerFields,
    /// Out of the picker; saved routes on it keep resolving.
    #[serde(default)]
    pub hidden: bool,
    /// The effort the provider's own listing names as the model's default
    /// (`defaultEffort`); the picker selects it when the route's ladder has it.
    #[serde(default)]
    pub default_effort: Option<String>,
    /// The kind of model the listing states (`chat`, `embedding`, …).
    #[serde(default)]
    pub mode: Option<String>,
    /// When the provider created the model (epoch seconds, as listed).
    #[serde(default)]
    pub created: Option<i64>,
    /// The model a routing alias resolves to.
    #[serde(default)]
    pub alias_target: Option<String>,
    /// Wire family the source assigns (for example `gemini`, `claude`).
    #[serde(default)]
    pub family: Option<String>,
    #[serde(default)]
    pub thinking: Thinking,
    /// The models.dev SDK package (`npm`) serving the model; names its wire.
    #[serde(default)]
    pub npm: Option<String>,
    /// Output modalities as the source states them (`text`, `image`, ...).
    /// Empty means not stated, which is not "no text".
    #[serde(default)]
    pub output_modalities: Vec<String>,
    pub id: String,
    pub provider: ProviderId,
    pub display_name: Option<String>,
    pub context_window: Option<u64>,
    pub output_tokens: Option<u64>,
    pub rates: Rates,
    pub vision: Capability,
    pub function_calling: Capability,
    pub reasoning: Capability,
    pub fast_mode: Capability,
    /// Effort levels the model accepts, as the source states them.
    pub reasoning_efforts: Vec<String>,
    /// Source of the limits and rates.
    pub source: MetadataSource,
}

impl ModelRecord {
    pub fn new(provider: ProviderId, id: impl Into<String>) -> Self {
        Self {
            picker: PickerFields::default(),
            hidden: false,
            default_effort: None,
            mode: None,
            created: None,
            alias_target: None,
            family: None,
            thinking: Thinking::Unspecified,
            npm: None,
            output_modalities: Vec::new(),
            id: id.into(),
            provider,
            display_name: None,
            context_window: None,
            output_tokens: None,
            rates: Rates::default(),
            vision: Capability::Unknown,
            function_calling: Capability::Unknown,
            reasoning: Capability::Unknown,
            fast_mode: Capability::Unknown,
            reasoning_efforts: Vec::new(),
            source: MetadataSource::Native,
        }
    }

    /// Fills what this record does not state from `other`: the provider's own
    /// limits and capabilities win; the metadata catalog fills gaps only.
    pub fn fill_gaps_from(&mut self, other: &ModelRecord) {
        fn gap<T: Clone>(slot: &mut Option<T>, value: &Option<T>) {
            if slot.is_none() {
                slot.clone_from(value);
            }
        }
        fn flag(slot: &mut Capability, value: Capability) {
            if *slot == Capability::Unknown {
                *slot = value;
            }
        }
        gap(&mut self.display_name, &other.display_name);
        gap(&mut self.family, &other.family);
        gap(&mut self.npm, &other.npm);
        if self.output_modalities.is_empty() {
            self.output_modalities.clone_from(&other.output_modalities);
        }
        if self.thinking == Thinking::Unspecified {
            self.thinking.clone_from(&other.thinking);
        }
        gap(&mut self.context_window, &other.context_window);
        gap(&mut self.output_tokens, &other.output_tokens);
        gap(&mut self.rates.input, &other.rates.input);
        gap(&mut self.rates.output, &other.rates.output);
        gap(&mut self.rates.cache_read, &other.rates.cache_read);
        gap(&mut self.rates.cache_write, &other.rates.cache_write);
        flag(&mut self.vision, other.vision);
        flag(&mut self.function_calling, other.function_calling);
        flag(&mut self.fast_mode, other.fast_mode);
        // No reasoning ladder when the model is known not to reason.
        flag(&mut self.reasoning, other.reasoning);
        if self.reasoning_efforts.is_empty() && self.reasoning != Capability::No {
            self.reasoning_efforts.clone_from(&other.reasoning_efforts);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_fills_gaps_and_never_overrides_native() {
        let mut native = ModelRecord::new("p".into(), "m");
        native.context_window = Some(200_000);
        native.reasoning = Capability::No;
        let mut overlay = ModelRecord::new("p".into(), "m");
        overlay.context_window = Some(1);
        overlay.output_tokens = Some(64_000);
        overlay.rates.input = Some(3.0);
        overlay.reasoning = Capability::Yes;
        overlay.reasoning_efforts = vec!["high".into()];
        native.fill_gaps_from(&overlay);
        assert_eq!(native.context_window, Some(200_000));
        assert_eq!(native.output_tokens, Some(64_000));
        assert_eq!(native.rates.input, Some(3.0));
        assert_eq!(native.reasoning, Capability::No);
        assert!(native.reasoning_efforts.is_empty());
    }
}