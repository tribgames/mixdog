//! `feature_effects`: what the tool-module setters trigger (`builtinFeatureAdapters` and
//! `localProviderAdapters` of `session-runtime/boot/apis.mjs`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_ai::catalog::ProviderReadiness;
use mixdog_ai::providers::local::PROVIDER_ID;
use mixdog_ai::registry::ProviderRegistry;
use mixdog_core_config::config::Config;
use mixdog_core_config::tool_modules::FeatureEffects;
use serde_json::Value;

use super::caches::ContextStatusCaches;
use super::office_fonts::NOTO_FONTS;
use super::office_fonts::OfficeFonts;

pub struct DaemonFeatureEffects {
    fonts: Arc<OfficeFonts>,
    config: Config,
    readiness: Arc<ProviderReadiness>,
    registry: Arc<ProviderRegistry>,
    context_status: Arc<dyn ContextStatusCaches>,
}

impl DaemonFeatureEffects {
    pub fn new(
        fonts: Arc<OfficeFonts>,
        config: Config,
        readiness: Arc<ProviderReadiness>,
        registry: Arc<ProviderRegistry>,
        context_status: Arc<dyn ContextStatusCaches>,
    ) -> Arc<Self> {
        Arc::new(Self { fonts, config, readiness, registry, context_status })
    }
}

#[async_trait]
impl FeatureEffects for DaemonFeatureEffects {
    /// Failures are ignored, as `prepareOfficeFonts?.().catch?.(() => {})` does: each face keeps
    /// its own result and none is thrown.
    async fn prepare_office_fonts(&self) {
        drop(self.fonts.prepare(&NOTO_FONTS).await);
    }

    async fn sync_local_provider_registry(&self, enabled: bool) {
        self.readiness.invalidate_provider_caches(false);
        if !enabled {
            self.registry.disable(PROVIDER_ID);
            return;
        }
        let providers = self.config.agent().get("providers").and_then(Value::as_object).cloned().unwrap_or_default();
        if let Err(error) = self.readiness.ensure_providers_ready(Some(providers)).await {
            tracing::warn!("[providers] mixdog-local init after enabling failed: {}", error.message);
        }
    }

    fn invalidate_context_status_cache(&self) {
        self.context_status.invalidate_all();
    }

    /// The core builds a session's tool surface from its sources on every call; no copy of it is
    /// kept before the session exists, so there is nothing to drop (decisions.md, domain seams).
    fn invalidate_pre_session_tool_surface(&self) {}
}
