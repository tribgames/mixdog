//! What the request builder needs to know about a model: the family test and the
//! budget-only contract of the Gemini 2.5 models are Node's own rules over the
//! wire id (`gemini-family.mjs`, `gemini-thinking.mjs`); the levels a model
//! declares come from the catalog.

use std::sync::LazyLock;

use mixdog_js::JsRegex;

/// `GEMINI_FAMILY`.
static GEMINI_FAMILY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:^|/)gemini-", "i"));

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

/// `isGeminiFamilyModel`: an id in the Gemini wire family (`gemini-4-argon`,
/// `models/gemini-3.1-pro`, `google/gemini-3-pro`). It names the family only, never a generation,
/// and is the one test every route uses (a Gemini model behind an OpenAI-compatible gateway
/// included).
pub fn is_gemini_family_model(model: &str) -> bool {
    GEMINI_FAMILY.is_match(model)
}

pub trait ModelTraits: Send + Sync {
    /// The Gemini wire family. An Antigravity gateway also serves other
    /// families, which reject the Gemini-only request fields.
    fn is_gemini_family(&self, model: &str) -> bool;
    fn thinking(&self, model: &str) -> ThinkingControl;
}

/// The wire id of a bare model (`/^models\//i` removed).
fn bare(model: &str) -> &str {
    match model.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("models/") => &model[7..],
        _ => model,
    }
}

/// `budgetSpec`: Gemini 2.5 models take `thinkingBudget` only (`thinkingLevel` is unsupported).
/// Documented ranges: 2.5 Pro 128-32768 (cannot disable), 2.5 Flash 0-24576, 2.5 Flash-Lite
/// 0 or 512-24576; -1 is dynamic thinking for all of them.
fn budget_spec(model: &str) -> Option<BudgetSpec> {
    let id = bare(model).to_lowercase();
    let tail = id.strip_prefix("gemini-2.5")?;
    if !(tail.is_empty() || tail.starts_with('-')) {
        return None;
    }
    let spec = |name: &str, min, max, can_disable, efforts: [i64; 4]| BudgetSpec {
        name: name.to_owned(),
        min,
        max,
        can_disable,
        efforts: ["minimal", "low", "medium", "high"].iter().map(|l| (*l).to_owned()).zip(efforts).collect(),
    };
    Some(if id.starts_with("gemini-2.5-pro") {
        spec("Gemini 2.5 Pro", 128, 32768, false, [128, 1024, 8192, 32768])
    } else if id.starts_with("gemini-2.5-flash-lite") {
        spec("Gemini 2.5 Flash-Lite", 512, 24576, true, [512, 1024, 8192, 24576])
    } else {
        spec("Gemini 2.5 Flash", 0, 24576, true, [0, 1024, 8192, 24576])
    })
}

/// A Google-served model's traits. The family is the wire id's (`isGeminiFamilyModel`), never
/// the catalog's word, so an uncatalogued Claude or GPT-OSS model behind an Antigravity gateway
/// is not Gemini; a 2.5 model's thinking is the mandatory budget-only contract; the levels of
/// any other model are the first of sources (the providers that serve
/// Gemini models: gemini, ertex-ai, ntigravity-oauth) whose row states it. A model whose
/// ladder no source declares is left to the server.
pub struct CatalogGoogleTraits(pub Vec<std::sync::Arc<dyn crate::catalog::ModelTraits>>);

impl ModelTraits for CatalogGoogleTraits {
    fn is_gemini_family(&self, model: &str) -> bool {
        is_gemini_family_model(model)
    }

    fn thinking(&self, model: &str) -> ThinkingControl {
        use crate::catalog::Thinking;
        if let Some(spec) = budget_spec(model) {
            return ThinkingControl::Budget(spec);
        }
        match self.0.iter().map(|t| t.thinking(bare(model))).find(|t| matches!(t, Thinking::Levels(_))) {
            Some(Thinking::Levels(levels)) => ThinkingControl::Levels(levels),
            _ => ThinkingControl::Unspecified,
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::ModelRequest;
    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_protocol::ProviderId;
    use serde_json::Value;

    use super::*;
    use crate::providers::google::request::Dialect;
    use crate::providers::google::request::build_request;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../../fixtures/google-traits/golden.json")).expect("fixture")
    }

    /// Node's real `isGeminiFamilyModel` over ids the catalog never describes.
    #[test]
    fn the_family_is_the_wire_ids_and_not_the_catalogs() {
        let traits = CatalogGoogleTraits(Vec::new());
        for case in golden()["families"].as_array().unwrap() {
            let model = case["model"].as_str().unwrap();
            assert_eq!(traits.is_gemini_family(model), case["isGemini"].as_bool().unwrap(), "{model:?}");
        }
    }

    /// Node's real `geminiThinkingConfig`: a 2.5 model is budget-only with an empty catalog
    /// (`gemini-2.5-pro` at effort `low` is `{"thinkingBudget":1024}`, never a `thinkingLevel`),
    /// and every other case gives Node's config or Node's error text.
    #[test]
    fn a_gemini_2_5_model_takes_the_budget_only_contract() {
        let traits = CatalogGoogleTraits(Vec::new());
        let dialect = Dialect {
            owner: ProviderId::from("gemini"),
            system_role: Some("system"),
            function_ids: true,
            family_gated: false,
            default_tool_mode: None,
            omit_ignored_sampling: false,
        };
        let cases = golden()["configs"].as_array().unwrap().clone();
        assert!(cases.len() > 100);
        for case in cases {
            let model = case["model"].as_str().unwrap();
            let options = &case["options"];
            let mut request = ModelRequest {
                model: model.into(),
                messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
                tools: Vec::new(),
                options: RequestOptions { effort: options["effort"].as_str().map(str::to_owned), ..RequestOptions::default() },
            };
            let mut parameters = serde_json::Map::new();
            for key in ["thinkingLevel", "thinkingBudget"] {
                if !options[key].is_null() {
                    parameters.insert(key.into(), options[key].clone());
                }
            }
            if !parameters.is_empty() {
                request.options.model_parameters = Some(Value::Object(parameters));
            }
            let got = build_request(&request, &dialect, &traits);
            let what = format!("{model} {options}");
            match case.get("error") {
                Some(error) => assert_eq!(got.unwrap_err().message, error.as_str().unwrap(), "{what}"),
                None => {
                    let body = got.unwrap_or_else(|e| panic!("{what}: {e:?}"));
                    let config = body.get("generationConfig").and_then(|g| g.get("thinkingConfig")).cloned().unwrap_or(Value::Null);
                    assert_eq!(config, case["config"], "{what}");
                }
            }
        }
    }
}