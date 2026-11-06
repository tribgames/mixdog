//! The live surface of the session service (agent-home-delivery.mjs `setAgentHomeLiveSurface`,
//! daemon.mjs): what the bots module asks of the running threads. A thread open in a window
//! shows a notice at once; a cold thread picks the stored record up.

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::oneshot;

/// How a hidden wake turn ended: the turn's end status, `done` when it finished.
pub struct WakeTurn {
    pub settled: oneshot::Receiver<String>,
}

/// A hidden wake turn's identity (`{ id, hop }`).
#[derive(Clone, Debug, PartialEq)]
pub struct WakeOptions {
    /// The submission id the turn runs under (a wake batch's id).
    pub id: String,
    /// The depth of the bot-descended turns that sent the reports (`sendDepth`); 0 for work the
    /// user or a routine started.
    pub hop: u32,
}

#[async_trait]
pub trait LiveSurface: Send + Sync {
    /// Whether thread `session_id` runs a turn now (`liveSessionBusy`).
    fn busy(&self, session_id: &str) -> bool;

    /// Shows `notice` live in the thread (`pushLiveSessionNotice`); whether a window showed it.
    async fn notice(&self, session_id: &str, notice: Value) -> Result<bool, String>;

    /// Starts one hidden turn of the thread with `prompt` (a task session's result, which the
    /// agent relays in one turn). `None` when the turn was refused.
    async fn wake(&self, session_id: &str, prompt: &str, options: WakeOptions) -> Result<Option<WakeTurn>, String>;
}
