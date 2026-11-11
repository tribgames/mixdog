//! What the home delivery asks of the rest of the daemon: the thread store, the definitions,
//! the live surface and the desktop's room host. Each is one seam the composition fills; the
//! delivery decides *when* and *what*, the seams only read and write.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use super::queue::RoutineResultQueue;
use crate::bots::live::{LiveSurface, WakeOptions, WakeTurn};

/// What a definition read proved about an agent or a room.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Present,
    /// Proven gone (archived or deleted).
    Deleted,
    /// Unreadable or unknown: never proof of anything.
    Unknown,
}

/// Whether an agent can have a home chat (`readHomeAgent`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HomeAgent {
    /// A store bot, or one the kind rule calls a bot.
    Bot,
    /// Read, and a workflow agent: it never has a chat.
    None,
    /// An unreadable file, an unparsable one, or an unmarked user copy without bot evidence.
    Unknown,
}

/// A home thread's stored record as the delivery reads it.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadSnapshot {
    /// `session.closed === true`.
    pub closed: bool,
    pub messages: Vec<Value>,
}

/// The session store, as far as the delivery posts into it.
#[async_trait]
pub trait HomeThreads: Send + Sync {
    /// `loadSession(id)`: the thread's record, `None` when it has none yet.
    async fn load(&self, id: &str) -> Result<Option<ThreadSnapshot>, String>;

    /// Appends `rows` to the thread's messages (in the live thread first, so no turn starts
    /// between the load that decided them and the push), then stores the thread
    /// (`saveSession`). `touched_at`: the thread's `updatedAt` to stamp. With no `rows` it only
    /// stores what the live thread holds, also when an earlier append pushed rows whose store
    /// failed. The delivery has already left out rows the thread holds by message id.
    async fn append(&self, id: &str, rows: Vec<Value>, touched_at: Option<i64>) -> Result<(), String>;

    /// `isSessionTurnInFlight(id)`: a turn runs in this process.
    fn turn_in_flight(&self, id: &str) -> bool;

    /// Positive evidence that session `id` was deleted: its record absent with no in-memory copy.
    /// An unreadable record is not deleted.
    async fn session_deleted(&self, id: &str) -> bool;
}

/// The agent and room definitions.
#[async_trait]
pub trait HomeDirectory: Send + Sync {
    /// `agentPresence(agentId)`: a deleted owner's results go to Mixy.
    async fn agent_presence(&self, agent_id: &str) -> Presence;

    /// The same per room id. The daemon has no room store (rooms live in the desktop host), so a
    /// composition without one answers `Unknown`: no room counts as deleted.
    async fn room_presence(&self, room_id: &str) -> Presence;

    /// `readHomeAgent`: whether the agent can have a home chat at all. `None` (proven: a workflow
    /// agent such as Reviewer) drops the rows queued for its missing home.
    async fn home_agent(&self, agent_id: &str) -> HomeAgent;

    /// Whether the representative bot exists (mixy-presence.mjs): while it does not, heartbeat
    /// reports queued for its home are dropped.
    async fn mixy_exists(&self) -> bool;
}

/// A room member's wake turn records, before it is submitted, the submission id it answers under.
pub struct WakeFollow {
    record: Arc<dyn FollowRecord>,
}

/// Where the id of the turn that answers a batch is recorded.
#[async_trait]
pub trait FollowRecord: Send + Sync {
    async fn record(&self, submission_id: &str) -> Result<(), String>;
}

/// The batch's own record in the queue file.
struct BatchRecord {
    queue: Arc<RoutineResultQueue>,
    home: String,
    batch_id: String,
}

#[async_trait]
impl FollowRecord for BatchRecord {
    async fn record(&self, submission_id: &str) -> Result<(), String> {
        let mut fields = serde_json::Map::new();
        fields.insert("follows".into(), Value::from(submission_id));
        self.queue.mark_batch(&self.home, &self.batch_id, fields).await
    }
}

impl WakeFollow {
    pub fn new(record: Arc<dyn FollowRecord>) -> Self {
        Self { record }
    }

    pub(super) fn of_batch(queue: Arc<RoutineResultQueue>, home: String, batch_id: String) -> Self {
        Self::new(Arc::new(BatchRecord { queue, home, batch_id }))
    }

    /// The batch is answered by the turn submitted as `submission_id`.
    pub async fn follow(&self, submission_id: &str) -> Result<(), String> {
        self.record.record(submission_id).await
    }
}

/// A room member's relay turn (`agentRoomHost().relay`): the desktop room host gives the member
/// one turn in its room to relay the result, with the live surface's `wake` contract.
#[async_trait]
pub trait RoomRelay: Send + Sync {
    /// `None` when the turn was refused.
    async fn relay(&self, session_id: &str, prompt: &str, options: WakeOptions, follow: WakeFollow) -> Result<Option<WakeTurn>, String>;
}

/// `setAgentHomeLiveSurface` / `agentHomeLiveSurface`: the live surface of the session service,
/// registered once it runs.
#[derive(Default)]
pub struct LiveSlot {
    surface: RwLock<Option<Arc<dyn LiveSurface>>>,
}

impl LiveSlot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn set(&self, surface: Option<Arc<dyn LiveSurface>>) {
        *self.surface.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = surface;
    }

    pub fn get(&self) -> Option<Arc<dyn LiveSurface>> {
        self.surface.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }
}

/// How a retry waits (`retryLater` of the Node options): `fire` runs once `delay` has passed.
pub trait RetryTimer: Send + Sync {
    fn arm(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>);
}

/// The daemon's retry timer: a task that sleeps.
pub struct SleepRetry;

impl RetryTimer for SleepRetry {
    fn arm(&self, delay: Duration, fire: Box<dyn FnOnce() + Send>) {
        tokio::spawn(async move {
            mixdog_rt::time::sleep(delay).await;
            fire();
        });
    }
}

/// The delivery's timings and limits (the options of `createAgentHomeDelivery`).
#[derive(Debug, Clone)]
pub struct DeliveryConfig {
    /// A busy thread is tried again after this.
    pub busy_retry: Duration,
    /// A missing thread, or a wake refused, is tried again after this.
    pub missing_retry: Duration,
    /// Waits (ms) before the 2nd, 3rd and 4th try of a relay turn that did not finish.
    pub wake_retry_delays_ms: Vec<u64>,
    /// Refused wake submissions of one batch before it is given up.
    pub wake_refusal_limit: u64,
}

impl DeliveryConfig {
    /// The values the daemon runs with.
    pub fn node() -> Self {
        Self {
            busy_retry: Duration::from_millis(1000),
            missing_retry: Duration::from_millis(60_000),
            wake_retry_delays_ms: vec![30_000, 120_000, 600_000],
            wake_refusal_limit: 10,
        }
    }
}
