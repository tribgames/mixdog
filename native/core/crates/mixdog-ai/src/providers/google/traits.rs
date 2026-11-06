//! What the request builder needs to know about a model and cannot read from
//! the wire: the catalog supplies it (no model-name inference here).

/// Documented `thinkingBudget` range of a budget-only model.
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetSpec {
    pub name: String,
    pub min: i64,
    pub max: i64,
    pub can_disable: bool,
    /// Effort level → budget.
    pub efforts: Vec<(String, i64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ThinkingControl {
    /// The catalog declares nothing: values of the wire vocabulary pass and
    /// the server decides.
    Unspecified,
    /// `thinkingLevel` values the model accepts.
    Levels(Vec<String>),
    /// `thinkingBudget` only (no `thinkingLevel`).
    Budget(BudgetSpec),
}

pub trait ModelTraits: Send + Sync {
    /// The Gemini wire family. An Antigravity gateway also serves other
    /// families, which reject the Gemini-only request fields.
    fn is_gemini_family(&self, model: &str) -> bool;
    fn thinking(&self, model: &str) -> ThinkingControl;
}

/// The catalog's word on a Google-served model: the first of sources (the providers that serve
/// Gemini models: gemini, ertex-ai, ntigravity-oauth) whose row states it. A model whose
/// family no row states is a Gemini one (every model of those providers is, but an Antigravity
/// gateway's other families state theirs).
pub struct CatalogGoogleTraits(pub Vec<std::sync::Arc<dyn crate::catalog::ModelTraits>>);

impl ModelTraits for CatalogGoogleTraits {
    fn is_gemini_family(&self, model: &str) -> bool {
        self.0.iter().find_map(|t| t.family(model)).is_none_or(|family| family == "gemini")
    }

    fn thinking(&self, model: &str) -> ThinkingControl {
        use crate::catalog::Thinking;
        match self.0.iter().map(|t| t.thinking(model)).find(|t| *t != Thinking::Unspecified) {
            None | Some(Thinking::Unspecified) => ThinkingControl::Unspecified,
            Some(Thinking::Levels(levels)) => ThinkingControl::Levels(levels),
            Some(Thinking::Budget(spec)) => ThinkingControl::Budget(BudgetSpec {
                name: spec.name,
                min: spec.min,
                max: spec.max,
                can_disable: spec.can_disable,
                efforts: spec.efforts,
            }),
        }
    }
}