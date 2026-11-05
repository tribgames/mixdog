//! What request builders need to know about a model and cannot read from the
//! wire. The catalog supplies it; no adapter infers it from the model name.

use std::sync::Arc;

use mixdog_protocol::ProviderId;

use super::record::ModelRecord;
use super::record::Thinking;
use crate::providers::compat::profile::Wire;
use crate::providers::compat::wire_route::wire_of_package;
use super::store::ProviderCatalog;

pub trait ModelTraits: Send + Sync {
    /// The wire family of `model`; `None` when the catalog does not state it.
    fn family(&self, model: &str) -> Option<String>;
    /// Unknown models are [`Thinking::Unspecified`].
    fn thinking(&self, model: &str) -> Thinking;
    /// The wire models.dev assigns the model through its SDK package: the
    /// `catalog_wire` input of `resolve_wire`. `None` when the catalog has
    /// no row or no package for it, so a gateway model without a row falls
    /// through to the later tiers.
    fn catalog_wire(&self, _model: &str) -> Option<Wire> {
        None
    }
    /// False only when the catalog states output modalities and text is not
    /// among them (image, embedding, speech models): such a model is left out
    /// of the picker. Unstated modalities keep the model.
    fn outputs_text(&self, _model: &str) -> bool {
        true
    }
}

/// [`ModelTraits`] read from the catalog snapshot of one provider. Each call
/// is one atomic load; it never waits on a refresh.
pub struct CatalogTraits {
    catalog: Arc<ProviderCatalog>,
    provider: ProviderId,
}

impl CatalogTraits {
    pub fn new(catalog: Arc<ProviderCatalog>, provider: ProviderId) -> Self {
        Self { catalog, provider }
    }
}

impl CatalogTraits {
    fn record<R>(&self, model: &str, read: impl FnOnce(&ModelRecord) -> R) -> Option<R> {
        let snapshot = self.catalog.snapshot();
        snapshot
            .models_of(&self.provider)
            .iter()
            .find(|record| record.id == model)
            .map(read)
    }
}

impl ModelTraits for CatalogTraits {
    fn catalog_wire(&self, model: &str) -> Option<Wire> {
        self.record(model, |r| r.npm.clone())
            .flatten()
            .map(|package| wire_of_package(Some(&package)))
    }

    fn outputs_text(&self, model: &str) -> bool {
        self.record(model, |r| {
            r.output_modalities.is_empty() || r.output_modalities.iter().any(|m| m == "text")
        })
        .unwrap_or(true)
    }

    fn family(&self, model: &str) -> Option<String> {
        let snapshot = self.catalog.snapshot();
        snapshot
            .models_of(&self.provider)
            .iter()
            .find(|record| record.id == model)
            .and_then(|record| record.family.clone())
    }

    fn thinking(&self, model: &str) -> Thinking {
        let snapshot = self.catalog.snapshot();
        snapshot
            .models_of(&self.provider)
            .iter()
            .find(|record| record.id == model)
            .map(|record| record.thinking.clone())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogSnapshot;
    use crate::catalog::ModelRecord;

    #[test]
    fn traits_come_from_the_catalog_record() {
        let mut record = ModelRecord::new("g".into(), "gemini-x");
        record.family = Some("gemini".into());
        record.thinking = Thinking::Levels(vec!["low".into(), "high".into()]);
        let mut snapshot = CatalogSnapshot::default();
        snapshot.models.insert("g".into(), vec![record]);
        let traits = CatalogTraits::new(Arc::new(ProviderCatalog::new(snapshot)), "g".into());
        assert_eq!(traits.family("gemini-x").as_deref(), Some("gemini"));
        assert_eq!(
            traits.thinking("gemini-x"),
            Thinking::Levels(vec!["low".into(), "high".into()])
        );
        assert_eq!(traits.family("unknown"), None);
        assert_eq!(traits.catalog_wire("gemini-x"), None);
        assert!(traits.outputs_text("unknown"));
    }

    #[test]
    fn models_dev_facts_feed_the_wire_and_the_picker() {
        let mut chat = ModelRecord::new("g".into(), "gpt-x");
        chat.npm = Some("@ai-sdk/openai".into());
        chat.output_modalities = vec!["text".into()];
        let mut image = ModelRecord::new("g".into(), "img-x");
        image.output_modalities = vec!["image".into()];
        let mut snapshot = CatalogSnapshot::default();
        snapshot.models.insert("g".into(), vec![chat, image]);
        let traits = CatalogTraits::new(Arc::new(ProviderCatalog::new(snapshot)), "g".into());
        assert_eq!(traits.catalog_wire("gpt-x"), Some(Wire::Responses));
        assert!(traits.outputs_text("gpt-x"));
        assert!(!traits.outputs_text("img-x"));
        assert_eq!(traits.catalog_wire("img-x"), None);
        assert_eq!(traits.thinking("unknown"), Thinking::Unspecified);
    }
}