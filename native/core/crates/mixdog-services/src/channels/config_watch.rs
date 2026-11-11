//! `createConfigReloadWatch` (config-reload-watch.mjs): every installed config document (an in-process write or
//! another process's edit heard by the file watch) whose `channels` or `voice` section differs from the one last
//! applied reloads the channels runtime; other sections never restart the listeners.

use serde_json::Value;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// Runs until `cancel`. `changes` ticks after every installed document; `sections` reads the `[channels, voice]`
/// sections as they now stand.
pub fn watch_channels_config<S, F, Fut>(mut changes: watch::Receiver<u64>, sections: S, reload: F, cancel: CancellationToken) -> tokio::task::JoinHandle<()>
where
    S: Fn() -> Value + Send + 'static,
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    let mut applied = sections();
    mixdog_rt::spawn("channels-config-reload", mixdog_rt::TaskClass::Work, async move {
        loop {
            tokio::select! {
                () = cancel.cancelled() => return,
                changed = changes.changed() => if changed.is_err() { return },
            }
            let next = sections();
            if next == applied {
                continue;
            }
            applied = next;
            // Node's `.catch(() => {})`: a failed reload leaves the watch running.
            if let Err(error) = reload().await {
                tracing::warn!("mixdog channels: config reload failed: {error}");
            }
        }
    })
}
