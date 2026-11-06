//! Model capabilities the Messages request depends on. They come from the
//! model catalog (`/v1/models` `capabilities`, `max_input_tokens`,
//! `max_tokens`); the codec never infers them from a model id.

use std::sync::Arc;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelCaps {
    /// `thinking.types.adaptive`: the model takes `thinking: {type: adaptive}`.
    pub adaptive_thinking: bool,
    /// `thinking.types.enabled`: the model takes a manual `budget_tokens`.
    pub manual_thinking: bool,
    /// Effort levels the model advertises (`capabilities.effort`), lowercase.
    pub effort_levels: Vec<String>,
    /// A catalog row states the ladder, possibly empty: a stated empty ladder is a model that takes
    /// no effort, where no statement leaves the gates to the release-generation floor.
    pub ladder_stated: bool,
    /// Declared output limit (`max_tokens`).
    pub max_output_tokens: Option<u32>,
    pub fast_mode: bool,
    /// The context window the shared catalog (models.dev / LiteLLM) states for
    /// the model; the listing prefers a window the row states itself.
    pub context_window: Option<u64>,
    /// The model writes tool preambles as progress-update thinking blocks.
    pub thinking_display_updates: bool,
}

impl ModelCaps {
    pub fn supports_effort(&self) -> bool {
        !self.effort_levels.is_empty()
    }

    pub(crate) fn has_level(&self, level: &str) -> bool {
        self.effort_levels.iter().any(|l| l == level)
    }
}

/// Catalog view: capabilities of a model id, `None` when the catalog does not
/// describe it.
pub type CapsLookup = Arc<dyn Fn(&str) -> Option<ModelCaps> + Send + Sync>;
