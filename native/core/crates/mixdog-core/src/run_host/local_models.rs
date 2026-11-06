//! The managed local runtime as the text-only gate reads it ([`LocalModels`]): the catalog entry
//! of the model (`localProviderModelEntry`), the tool support the running server reported
//! (`localModelState(model).capabilities.tools`) and the media layer a text-only request lowers
//! its attachments through (`preparePdfTextForProvider`).

use std::sync::Arc;

use mixdog_agent::text_only::MediaText;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_core_run::run_host::route_wiring::LocalEntry;
use mixdog_protocol::{ProviderId, ThreadId};
use mixdog_services::local_provider::catalog::LOCAL_PROVIDER_ID;
use mixdog_services::local_provider::LocalProvider;
use serde_json::Value;

use super::media::{AttachmentFacts, MediaLowering};
use super::process::LocalModels;

pub struct ManagedLocalModels {
    provider: Arc<LocalProvider>,
    docs: Arc<dyn DocumentText>,
    reader: Arc<dyn AttachmentReader>,
    facts: Arc<dyn AttachmentFacts>,
}

impl ManagedLocalModels {
    pub fn new(
        provider: Arc<LocalProvider>,
        docs: Arc<dyn DocumentText>,
        reader: Arc<dyn AttachmentReader>,
        facts: Arc<dyn AttachmentFacts>,
    ) -> Self {
        Self { provider, docs, reader, facts }
    }
}

impl LocalModels for ManagedLocalModels {
    /// The model's name is read as a template would print it (`${model.name}`), so an entry
    /// without one is called `undefined` as in Node.
    fn entry(&self, model: &str) -> Option<LocalEntry> {
        let entry = self.provider.catalog.model_entry(model)?;
        Some(LocalEntry {
            name: entry.get("name").map_or_else(|| "undefined".to_owned(), mixdog_js::value_to_string),
            supports_function_calling: entry.get("supportsFunctionCalling").and_then(Value::as_bool),
        })
    }

    fn runtime_tools(&self, model: &str) -> Option<bool> {
        self.provider.catalog.state.get(model).get("capabilities")?.get("tools")?.as_bool()
    }

    /// The managed runtime takes no PDF or document block of its own (`nativePdf = false`, and
    /// `nativeDocuments` is not declared), so documents lower to text as for any text provider.
    fn media(&self, updated: &Value) -> Arc<dyn MediaText> {
        let thread = ThreadId::from(updated.get("id").and_then(Value::as_str).unwrap_or(""));
        Arc::new(MediaLowering::new(
            thread,
            self.docs.clone(),
            self.reader.clone(),
            self.facts.clone(),
            false,
            ProviderId::from(LOCAL_PROVIDER_ID),
        ))
    }
}
