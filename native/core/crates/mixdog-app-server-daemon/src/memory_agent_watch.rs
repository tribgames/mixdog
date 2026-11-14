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
}

impl RunWatch for MemoryAgentWatch {
    fn started(&self) -> RunHold {
        let info = ActivityInfo { kind: ActivityKind::SubAgent, thread_id: None, turn_id: None, title: "memory agent".into() };
        // Before the bind (a startup bug: the listener accepts only after it) the cell says so, and the run is not counted.
        match self.lifecycle.begin_work(info, MEMORY_AGENT_ACTIVITY_CHANGED) {
            Some(activity) => Box::new(activity),
            None => Box::new(()),
        }
    }
}
