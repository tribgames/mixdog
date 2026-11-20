//! The model-metadata lookup over small inline tables: LiteLLM and models.dev rows, a provider's live roster, and the
//! enrichment of listed rows.

use serde_json::Value;
use serde_json::json;

use super::Lookup;
use super::enrich_model;
use super::project_litellm;
use super::project_models_dev;
use crate::catalog::Overlay;
use crate::catalog::rosters::Rosters;

struct Tables {
    litellm: Overlay,
    models_dev: Overlay,
    rosters: Rosters,
}

impl Tables {
    fn new(litellm: Value, models_dev: Value, roster_rows: Vec<Value>) -> Self {
        Self {
            litellm: Overlay::from_projected_litellm(&project_litellm(&litellm)),
            models_dev: Overlay::from_projected_models_dev(&project_models_dev(&models_dev)),
            rosters: Rosters::from_rows([("openai-oauth-models.json".to_owned(), roster_rows)]),
        }
    }

    fn lookup(&self) -> Lookup<'_> {
        Lookup { litellm: &self.litellm, models_dev: &self.models_dev, rosters: &self.rosters }
    }
}

fn close(value: &Value, want: f64) -> bool {
    value.as_f64().is_some_and(|got| (got - want).abs() < 1e-9)
}

fn litellm_table() -> Value {
    json!({
        "openai/gpt-x": {
            "max_input_tokens": 128000, "max_output_tokens": 4096, "mode": "chat",
            "input_cost_per_token": 0.0000025, "output_cost_per_token": 0.00001, "cache_read_input_token_cost": 0.00000125,
            "supports_vision": true, "supports_function_calling": true
        }
    })
}

fn models_dev_table() -> Value {
    json!({
        "openai": { "models": {
            "gpt-m": {
                "name": "GPT M (New)", "tool_call": true, "reasoning": true,
                "limit": { "context": 200000, "output": 8000 },
                "cost": { "input": 1.5, "output": 6.0, "cache_read": 0.15 },
                "modalities": { "input": ["text", "image"] }
            },
            "gpt-big": { "name": "Big", "limit": { "context": 400000, "output": 128000 }, "cost": { "input": 5.0, "output": 20.0 } }
        } }
    })
}

#[test]
fn a_litellm_row_gives_limits_prices_per_million_tokens_and_capabilities() {
    let tables = Tables::new(litellm_table(), json!({}), Vec::new());
    let meta = tables.lookup().lookup("gpt-x", "openai", None).expect("the row is known");
    assert_eq!((meta["contextWindow"].clone(), meta["outputTokens"].clone()), (json!(128000), json!(4096)));
    assert!(close(&meta["inputCostPerM"], 2.5) && close(&meta["outputCostPerM"], 10.0) && close(&meta["cacheReadCostPerM"], 1.25));
    assert_eq!(meta["pricingSource"], "litellm");
    assert_eq!((meta["supportsVision"].clone(), meta["supportsFunctionCalling"].clone()), (json!(true), json!(true)));
    assert_eq!(meta["pricingModel"], "gpt-x");
}

#[test]
fn a_models_dev_row_gives_limits_prices_in_dollars_per_million_and_a_clean_display_name() {
    let tables = Tables::new(json!({}), models_dev_table(), Vec::new());
    let meta = tables.lookup().lookup("gpt-m", "openai", None).expect("the row is known");
    assert_eq!((meta["contextWindow"].clone(), meta["outputTokens"].clone()), (json!(200000), json!(8000)));
    assert!(close(&meta["inputCostPerM"], 1.5) && close(&meta["outputCostPerM"], 6.0) && close(&meta["cacheReadCostPerM"], 0.15));
    assert_eq!(meta["pricingSource"], "models.dev");
    assert_eq!(meta["displayName"], "GPT M", "a marketing tail in brackets is dropped");
    assert_eq!(
        (meta["supportsVision"].clone(), meta["supportsReasoning"].clone(), meta["supportsPromptCaching"].clone()),
        (json!(true), json!(true), json!(true))
    );
}

#[test]
fn a_model_no_table_knows_has_no_metadata() {
    let tables = Tables::new(litellm_table(), models_dev_table(), Vec::new());
    assert!(tables.lookup().lookup("nonexistent-model", "openai", None).is_none());
}

#[test]
fn a_subscription_route_is_priced_from_the_catalog_but_sized_by_its_own_roster() {
    let roster = vec![json!({ "id": "gpt-big", "contextWindow": 272000 })];
    let tables = Tables::new(json!({}), models_dev_table(), roster);
    let meta = tables.lookup().lookup("gpt-big", "openai-oauth", None).expect("known");
    assert_eq!(meta["contextWindow"], 272000, "the roster's window wins over the catalog's 400000");
    assert!(close(&meta["inputCostPerM"], 5.0) && close(&meta["outputCostPerM"], 20.0), "the price is the catalog's");
}

#[test]
fn enrichment_adds_the_catalogs_facts_to_a_listed_row_and_keeps_the_rows_own_limits() {
    let tables = Tables::new(litellm_table(), models_dev_table(), Vec::new());
    let lookup = tables.lookup();
    let enriched = enrich_model(&lookup, &json!({ "id": "gpt-m", "provider": "openai", "contextWindow": 99000 }));
    assert_eq!(enriched["contextWindow"], 99000, "a provider-stated window stays");
    assert_eq!(enriched["outputTokens"], 8000);
    assert_eq!(enriched["display"], "GPT M");
    assert!(close(&enriched["inputCostPerM"], 1.5));
    assert_eq!(enriched["pricingProvider"], "openai");
    let unknown = json!({ "id": "mystery", "provider": "openai" });
    assert_eq!(enrich_model(&lookup, &unknown), unknown, "an unknown row comes back as it was");
    let nameless = json!({ "provider": "openai" });
    assert_eq!(enrich_model(&lookup, &nameless), nameless);
}
