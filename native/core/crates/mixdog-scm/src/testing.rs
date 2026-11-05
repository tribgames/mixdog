//! Test support: the real `ProcessManager` (WP-PROC's `LocalProcessManager`) on the test lane
//! tokens, so the engine is exercised against the real `git` and a recorded `gh` shim.

use std::sync::Arc;

use mixdog_core_api::domain::process::ProcessManager;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::ProcessConfig;

pub struct TestProcesses;

impl TestProcesses {
    pub fn shared() -> Arc<dyn ProcessManager> {
        Arc::new(LocalProcessManager::new(
            mixdog_rt::testing::tokens().spawn_io,
            ProcessConfig::default(),
        ))
    }
}
