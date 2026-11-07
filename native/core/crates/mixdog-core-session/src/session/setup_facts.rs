//! What only the live session layer knows about a setup caller (the daemon's `SessionFacts`):
//! - `agent_mode`: `resolveSessionMode({ session: caller }).mode === 'agent'`
//!   (`setup-tool/extended-actions.mjs` `createdAgentKind`), the caller being the session record
//!   with its id; the stored `sessionMode` is not read. No session: coding mode.
//! - `mixy_name`: `mixyDisplayName()`, read anew on every call (a rename applies at once).
//! - `settings_reach_session`: `settingsReachCurrentSession()` of the caller's session, the
//!   thread-switch layer's own answer.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_config::config::DEFAULT_MIXY_NAME;
use mixdog_core_config::workflow::thread_settings::SessionSwitches;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use serde_json::Value;

use super::SessionDirectory;

pub struct SessionSetupFacts {
    directory: Arc<SessionDirectory>,
    switches: Arc<dyn SessionSwitches>,
    data_dir: PathBuf,
}

impl SessionSetupFacts {
    /// `switches` is the thread-switch layer the workflow settings use (`SessionSwitchAdapter`);
    /// `data_dir` the data dir Mixy's identity folder is under.
    pub fn new(directory: Arc<SessionDirectory>, switches: Arc<dyn SessionSwitches>, data_dir: PathBuf) -> Self {
        Self { directory, switches, data_dir }
    }

    pub async fn agent_mode(&self, thread: &ThreadId) -> bool {
        let Some(mut session) = self.directory.stored_header(thread).await else { return false };
        session.insert("id".into(), Value::String(thread.as_str().to_owned()));
        mixdog_core_run::run_host::route_chain::resolve_session_mode(&Value::Object(session)).0 == "agent"
    }

    /// `mixyDisplayName()` never fails (prompt composition calls it unguarded): a read the io lane
    /// cannot run is an unreadable manifest, the unrenamed default.
    pub async fn mixy_name(&self) -> String {
        let data_dir = self.data_dir.clone();
        let read = self
            .directory
            .deps()
            .lanes
            .io
            .submit_wait(&CancellationToken::new(), move |lane| mixdog_core_config::config::mixy_display_name(lane, &data_dir))
            .await;
        match read {
            Ok(job) => job.await.unwrap_or_else(|_| DEFAULT_MIXY_NAME.to_owned()),
            Err(_) => DEFAULT_MIXY_NAME.to_owned(),
        }
    }

    pub async fn settings_reach_session(&self, thread: &ThreadId) -> bool {
        self.switches.settings_reach(thread.as_str()).await
    }
}

#[cfg(test)]
#[path = "setup_facts_tests.rs"]
mod tests;
