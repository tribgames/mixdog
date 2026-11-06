//! Replays what Node's `listModels` recorded (`providers/local-models`): the
//! rows the managed runtime reports installed are the listing, field for field.
//! What the runtime reports installed is the services crate's own test.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;

use super::listing::InstalledModels;
use super::listing::LocalListing;
use crate::providers::listing_row::testing::fixture;
use mixdog_core_api::domain::provider::ModelListing;

struct Rows(Vec<Value>);

#[async_trait]
impl InstalledModels for Rows {
    async fn installed(&self) -> Result<Vec<Value>, ProviderError> {
        Ok(self.0.clone())
    }
}

#[tokio::test]
async fn every_recorded_case_lists_the_installed_rows() {
    let recorded = fixture("local-models/cases.json");
    let mut seen_rows = 0;
    for (name, case) in recorded["cases"].as_object().unwrap() {
        let expected = case["expected"].as_array().unwrap();
        let records = LocalListing::new(Arc::new(Rows(expected.clone()))).list_models().await.unwrap();
        assert_eq!(records.len(), expected.len(), "{name}");
        for (record, row) in records.iter().zip(expected) {
            seen_rows += 1;
            assert_eq!(record.raw.as_ref(), Some(row), "{name}");
            assert_eq!(record.id, row["id"].as_str().unwrap());
            assert_eq!(record.display_name.as_deref(), row["display"].as_str());
            assert_eq!(record.context_window, row["contextWindow"].as_u64());
            assert_eq!(record.supports_reasoning, row["supportsReasoning"].as_bool());
            assert_eq!(record.supports_images, Some(false));
            assert_eq!(record.mode.as_deref(), Some("chat"));
        }
    }
    assert!(seen_rows > 0, "the recording has installed rows");
}
