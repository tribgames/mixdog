//! The setup `status` tool's `providers` domain: the `StatusReader` over [`ProvidersStatus`], which
//! holds Node's answer (`SETUP_STATUS_READERS.providers`). Register it with
//! `SetupService::with_status`, built over the one `ProviderSetup`, the one `ProviderAdmin` (as
//! `ProviderRoster`) and the quota auto-resume switch.

use async_trait::async_trait;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_domains::domains::ai_admin::provider_status::ProvidersStatus;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;

pub struct ProvidersStatusReader(ProvidersStatus);

impl ProvidersStatusReader {
    pub fn new(status: ProvidersStatus) -> Self {
        Self(status)
    }
}

#[async_trait]
impl StatusReader for ProvidersStatusReader {
    fn domains(&self) -> &'static [&'static str] {
        &["providers"]
    }

    async fn read(&self, _domain: &str, detail: bool, _thread: &ThreadId) -> Result<Value, PortError> {
        self.0.read(detail).await
    }
}
