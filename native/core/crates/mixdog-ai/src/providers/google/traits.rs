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
