//! DRAFT (flip, with flip-caller-2): the memory-agent runs as the lifecycle counts them. Node's daemon reads the broker's in-flight
//! dispatches as busy memory agents (`daemon.mjs:449`) and rechecks its self-shutdown when one starts or ends (`:1064`,
//! 'memory agent activity changed'). A run is a `SubAgent` activity of the lifecycle, which `serving::start` builds after `compose()`,
//! so the watch reads it through the `LateLifecycle` cell.

use std::sync::Arc;

use mixdog_core::run_host::agent_dispatch::RunHold;
use mixdog_core::run_host::agent_dispatch::RunWatch;

use crate::late_lifecycle::LateLifecycle;
use crate::lifecycle::ActivityInfo;
use crate::lifecycle::ActivityKind;
use crate::lifecycle::MEMORY_AGENT_ACTIVITY_CHANGED;

pub struct MemoryAgentWatch {
    pub lifecycle: Arc<LateLifecycle>,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl RunWatch for MemoryAgentWatch {
    fn started(&self) -> RunHold {
        match self.lifecycle.get() {
            Some(lifecycle) => Box::new(lifecycle.begin_activity_settling(
                ActivityInfo { kind: ActivityKind::SubAgent, thread_id: None, turn_id: None, title: "memory agent".into() },
                MEMORY_AGENT_ACTIVITY_CHANGED,
            )),
            // A startup bug (the listener accepts only after the bind): said, not silently left out of the busy count.
            None => {
                (self.log)("a memory agent started before the lifecycle was bound; it is not counted");
                Box::new(())
            }
        }
    }
}