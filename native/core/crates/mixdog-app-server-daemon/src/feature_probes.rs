//! The machine facts the feature gates read (`FeatureProbes`): which desktop bridges are up
//! (`builtin-features.mjs` reads the bridge discovery files; the composition's one copy of them is
//! `BridgeFeatures`) and whether a `git` executable is on PATH (`gitExecutablePresent`, remembered
//! for 30 seconds per PATH value, `path-executable.mjs:115`). The PATH walk reads directories, so it
//! runs as a job on the interactive lane; a job that cannot run is a typed failure, never "no git".

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core::run_host::workflow_surface::FeatureFacts;
use mixdog_core::run_host::workflow_surface::FeatureProbes;
use mixdog_core_api::domain::command::which;
use mixdog_core_session::session::thread_switches::SurfaceFailure;
use mixdog_rt::InteractiveIo;

use crate::compose_domains::EnvReader;
use crate::compose_mcp::BridgeFeatures;

const GIT_PRESENCE_TTL_MS: i64 = 30_000;

pub struct HostFeatureProbes {
    bridges: Arc<dyn BridgeFeatures>,
    lane: InteractiveIo,
    env: EnvReader,
    clock: Arc<dyn mixdog_agent::env::Clock>,
    /// `{ pathValue, at, present }` of the last walk.
    git: Mutex<Option<(String, i64, bool)>>,
}

impl HostFeatureProbes {
    pub fn new(bridges: Arc<dyn BridgeFeatures>, lane: InteractiveIo, env: EnvReader, clock: Arc<dyn mixdog_agent::env::Clock>) -> Self {
        Self { bridges, lane, env, clock, git: Mutex::new(None) }
    }

    fn remembered(&self, path: &str) -> Option<bool> {
        let now = self.clock.now_ms();
        let memo = self.git.lock().unwrap_or_else(PoisonError::into_inner);
        memo.as_ref().filter(|(key, at, _)| key == path && now - at < GIT_PRESENCE_TTL_MS).map(|(_, _, present)| *present)
    }
}

#[async_trait]
impl FeatureProbes for HostFeatureProbes {
    async fn read(&self) -> Result<FeatureFacts, SurfaceFailure> {
        let path = (self.env)("PATH").unwrap_or_default();
        let git = match self.remembered(&path) {
            Some(present) => present,
            None => {
                let present = mixdog_core_base::support::on_lane(self.lane, &mixdog_rt::CancellationToken::new(), |_| which("git", None, None).is_some())
                    .await
                    .map_err(|error| SurfaceFailure(format!("looking for git on PATH: {error}")))?;
                *self.git.lock().unwrap_or_else(PoisonError::into_inner) = Some((path, self.clock.now_ms(), present));
                present
            }
        };
        // A bridge whose tool this core did not register (`computer` with no helper) is not up. The tool-deny gate still lets a
        // `MIXDOG_FEATURE_*` override outrank this fact, which allows a tool that does not exist.
        let up = |feature: &str| self.bridges.present(feature) && self.bridges.registered(feature);
        Ok(FeatureFacts { browser: up("browser"), computer: up("computer"), terminal: up("terminal"), visualize: up("visualize"), git })
    }
}