use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use mixdog_core_api::domain::ext::{ExtCall, ExtFrame, ExtPool};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::runtime_hooks::RuntimeHooks;

/// How long one sweep may hold its host call. In Node the listing ran in the core's own process and could not outlive it; here it
/// is a call to a worker, and a worker that takes the call and never answers would keep its slot for good. The bound is the one a
/// maintenance job gets (`mixdog-rt` `exec.rs`); when it passes, the call is dropped and the pool tells the worker to stop.
const SWEEP_LIMIT: Duration = Duration::from_secs(600);

/// Node's beginBoot sweeps on each runtime creation, not each worker launch.
pub(crate) struct OfficeStartup {
    inner: Arc<dyn RuntimeHooks>,
    pool: Arc<dyn ExtPool>,
    data_dir: String,
    sweeps: Arc<Sweeps>,
}

/// One sweep at a time, and none after one that did not finish: sessions starting together would each queue a host call for the
/// same idempotent listing, and a host that cannot start would log its failure at every session start where Node's swallowed
/// sweep logged nothing.
#[derive(Default)]
struct Sweeps {
    running: AtomicBool,
    given_up: AtomicBool,
}

impl OfficeStartup {
    pub(crate) fn new(inner: Arc<dyn RuntimeHooks>, pool: Arc<dyn ExtPool>, data_dir: String) -> Arc<Self> {
        Arc::new(Self { inner, pool, data_dir, sweeps: Arc::default() })
    }
}

async fn sweep(pool: Arc<dyn ExtPool>, call: ExtCall) -> bool {
    let Ok(mut stream) = pool.call(call) else {
        return false;
    };
    while let Some(frame) = stream.next().await {
        if matches!(frame, ExtFrame::Done(_)) {
            return true;
        }
    }
    false
}

impl RuntimeHooks for OfficeStartup {
    fn started(&self, thread: &ThreadId) {
        let sweeps = self.sweeps.clone();
        if !sweeps.given_up.load(Ordering::Acquire) && !sweeps.running.swap(true, Ordering::AcqRel) {
            let pool = self.pool.clone();
            let call = ExtCall {
                thread: thread.clone(),
                method: "office.sweepJournals".into(),
                params: serde_json::json!({ "dataDir": self.data_dir }),
                paths: Vec::new(),
            };
            mixdog_rt::spawn("office-journal-sweep", mixdog_rt::TaskClass::Work, async move {
                #[cfg(test)]
                let thread = call.thread.clone();
                let finished = matches!(tokio::time::timeout(SWEEP_LIMIT, sweep(pool, call)).await, Ok(true));
                if !finished {
                    sweeps.given_up.store(true, Ordering::Release);
                }
                sweeps.running.store(false, Ordering::Release);
                #[cfg(test)]
                if finished {
                    let _ = completions().send(thread);
                }
            });
        }
        self.inner.started(thread);
    }

    fn stopped(&self, thread: &ThreadId) {
        self.inner.stopped(thread);
    }
}

#[cfg(test)]
#[path = "office_startup_unit_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) fn completions() -> &'static tokio::sync::broadcast::Sender<ThreadId> {
    static EVENTS: std::sync::OnceLock<tokio::sync::broadcast::Sender<ThreadId>> = std::sync::OnceLock::new();
    EVENTS.get_or_init(|| tokio::sync::broadcast::channel(16).0)
}
