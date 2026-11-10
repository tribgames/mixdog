use std::sync::Arc;

use mixdog_core_api::domain::ext::{ExtCall, ExtFrame, ExtPool};
use mixdog_core_api::ids::ThreadId;
use mixdog_core_session::session::runtime_hooks::RuntimeHooks;

/// Node's beginBoot sweeps on each runtime creation, not each worker launch.
pub(crate) struct OfficeStartup {
    inner: Arc<dyn RuntimeHooks>,
    pool: Arc<dyn ExtPool>,
    data_dir: String,
}

impl OfficeStartup {
    pub(crate) fn new(inner: Arc<dyn RuntimeHooks>, pool: Arc<dyn ExtPool>, data_dir: String) -> Arc<Self> {
        Arc::new(Self { inner, pool, data_dir })
    }
}

impl RuntimeHooks for OfficeStartup {
    fn started(&self, thread: &ThreadId) {
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
            if let Ok(mut stream) = pool.call(call) {
                while let Some(frame) = stream.next().await {
                    if matches!(frame, ExtFrame::Done(_)) {
                        #[cfg(test)]
                        let _ = completions().send(thread);
                        break;
                    }
                }
            }
        });
        self.inner.started(thread);
    }

    fn stopped(&self, thread: &ThreadId) {
        self.inner.stopped(thread);
    }
}

#[cfg(test)]
pub(crate) fn completions() -> &'static tokio::sync::broadcast::Sender<ThreadId> {
    static EVENTS: std::sync::OnceLock<tokio::sync::broadcast::Sender<ThreadId>> = std::sync::OnceLock::new();
    EVENTS.get_or_init(|| tokio::sync::broadcast::channel(16).0)
}
