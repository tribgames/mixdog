//! The channels' config hot reload (`config-reload-watch.mjs`): a change of the sections the channels runtime reads
//! (`channels`: webhook, events, …; `voice`) reloads it, whoever wrote the file: this process or another one (the
//! external edit reaches the document through [`super::ConfigWatcher`]). A change of any other section restarts no
//! listener. Reloads are not awaited one by one, as Node's: they overlap, and the runtime applies the newest
//! (`ChannelRuntime::reload_runtime`).

use std::sync::Arc;

use mixdog_services::channels::ChannelLifecycle;
use serde_json::Value;
use tokio::task::JoinHandle;

use super::Config;

/// Keeps the follow alive; dropping it stops it (`watch.stop()`), a reload already started runs on.
pub struct ChannelConfigFollow {
    task: JoinHandle<()>,
}

impl Drop for ChannelConfigFollow {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// `channelsConfigSnapshot`: the two sections, an absent one as null.
fn snapshot(config: &Config) -> Value {
    Value::Array(vec![config.get("channels").unwrap_or(Value::Null), config.get("voice").unwrap_or(Value::Null)])
}

impl ChannelConfigFollow {
    /// `watch.start()`: the sections as they stand now are the applied ones.
    pub fn start(config: Config, channels: Arc<dyn ChannelLifecycle>) -> Self {
        let mut changes = config.changes();
        changes.mark_unchanged();
        let mut applied = snapshot(&config);
        let task = tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let next = snapshot(&config);
                if next == applied {
                    continue;
                }
                applied = next;
                let channels = channels.clone();
                tokio::spawn(async move {
                    let _ = channels.reload_config().await;
                });
            }
        });
        Self { task }
    }
}
