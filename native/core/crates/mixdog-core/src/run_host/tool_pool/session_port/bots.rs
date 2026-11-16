//! Bot world interfaces retained by the session port's composed state.

use async_trait::async_trait;
use serde_json::Value;

/// A bot as `listBots` gives it: a contact agent with its display name, off the roster or not.
#[derive(Clone, Debug)]
pub struct BotRow {
    pub id: String,
    pub name: String,
    pub disabled: bool,
}

/// The state `session bots` reads besides the catalog: the bots, the routines (`channelSetup`'s schedules then webhooks), the
/// held requests of unattended runs (`pendingHeldRequests`) and the report watches of task turns (`agentTaskWatches`), each as
/// Node's rows (camelCase objects).
#[async_trait]
pub trait BotWorld: Send + Sync {
    async fn bots(&self) -> Result<Vec<BotRow>, String>;
    /// The routine rows, each stamped with its `kind` (`schedule` or `webhook`).
    async fn routines(&self) -> Result<Vec<Value>, String>;
    async fn held_requests(&self) -> Result<Vec<Value>, String>;
    async fn task_watches(&self) -> Result<Vec<Value>, String>;
}

