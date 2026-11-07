//! Two production seams of the agent tool's assembly (`mixdog_agent::agent_tool::assemble`):
//!
//! - [`ModelListCatalog`]: `AgentParts.catalog`, Node's `listProviderModels`
//!   (`boot/tools.mjs:98,123` -> `collectProviderModels`, `provider-models.mjs:161`) as the
//!   agent tool's `resolveRequestedModel` (`agent-tool/model-select.mjs:85`) calls it. It is the
//!   rows of the `model/list` service (`ModelListService::rows`), mapped to `ModelRow`.
//! - [`LateBoardNotifier`]: the `TaskNotifier` of `JobBoard::new`. A finished agent job reaches
//!   its owner as `notifySessionCompletion(owner, text, meta)` (`boot/infrastructure.mjs:146`);
//!   the session directory is that delivery (`impl TaskNotifier for SessionDirectory`), and the
//!   board is built before the directory exists, so it goes through the late directory.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::model_select::{ListOptions, ModelCatalog, ModelRow};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::ai_admin::model_list::ModelListService;
use mixdog_tools::exec::TaskNotifier;
use serde_json::Value;

use super::compose_parts::LateDirectory;
use super::late::Bound;

/// `ModelCatalog` over the `model/list` rows. `ListOptions.provider` scopes a forced refresh to
/// the providers it names, as Node's `collectProviderModels({ force, provider })` does.
pub struct ModelListCatalog(pub Arc<ModelListService>);

/// `{ provider, id, display, catalogComplete }` of a `collectProviderModels` row.
fn model_row(row: &Value) -> ModelRow {
    let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    ModelRow {
        provider: text("provider"),
        id: text("id"),
        display: text("display"),
        catalog_complete: row.get("catalogComplete") == Some(&Value::Bool(true)),
    }
}

#[async_trait]
impl ModelCatalog for ModelListCatalog {
    async fn list(&self, options: ListOptions) -> Result<Vec<ModelRow>, String> {
        Ok(self.0.rows_for(options.force, options.quick, options.provider.as_deref()).await?.iter().map(model_row).collect())
    }
}

/// The board's `TaskNotifier` through the late directory. The directory is bound once after
/// `TurnPath::new`; the composition verifies this cell (`verify_bound`) before the listener
/// accepts, and no job can finish before then, so a read of the verified cell expects it.
pub struct LateBoardNotifier(pub Arc<LateDirectory>);

impl Bound for LateBoardNotifier {
    fn cell(&self) -> &'static str {
        "agent board notifier"
    }

    fn is_bound(&self) -> bool {
        self.0.is_bound()
    }
}

#[async_trait]
impl TaskNotifier for LateBoardNotifier {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        let directory = self.0.directory().expect("the agent board notifier is verified bound before jobs run");
        directory.finished(owner, surface, task_id, status, notification).await;
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_model_row_keeps_what_the_picker_matches_on() {
        let row = model_row(&json!({ "provider": "p", "id": "m", "display": "M", "catalogComplete": true, "other": 1 }));
        assert_eq!(row, ModelRow { provider: "p".into(), id: "m".into(), display: "M".into(), catalog_complete: true });
        assert!(!model_row(&json!({ "provider": "p", "id": "m" })).catalog_complete);
    }

    #[test]
    fn an_unbound_directory_is_reported_by_the_cell() {
        let cell = LateBoardNotifier(Arc::new(LateDirectory::default()));
        assert_eq!(crate::run_host::late::require(&[&cell]).unwrap_err().cell, "agent board notifier");
    }
}
