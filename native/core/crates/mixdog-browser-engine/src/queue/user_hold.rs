//! Owner: s4-engine-queue
//! Local user input on a page outranks the agent (`command-queue-local-input.ts`, the agent half): a takeover aborts the
//! agent commands queued or running on that page and keeps new ones out until the person has been quiet for a moment.
//! Serializing the person's own input stays in the host.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_rt::CancelSource;
use mixdog_rt::time::Instant;

pub use mixdog_app_protocol::v2::browser_engine::HostBrowserUserInputParams as UserInputParams;

use super::key::QueueKey;
use super::queue::QueueError;

/// How long a page stays held after the person's last input.
pub const LOCAL_INPUT_QUIET: Duration = Duration::from_millis(1_000);

/// The text an interrupted agent command fails with, and the cancel reason that makes the queue report it.
pub const LOCAL_INPUT_TAKEOVER: &str =
    "Browser command interrupted by local user input. An earlier action may have completed; do not replay it. Wait until the user is idle, then observe the page again.";

struct Hold {
    held: bool,
    until: Instant,
}

#[derive(Default)]
struct State {
    next_id: u64,
    holds: HashMap<String, Hold>,
    /// The agent commands of each hold key a takeover aborts.
    agents: HashMap<String, Vec<(u64, CancelSource)>>,
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The pages a person holds, and the agent commands running on them.
pub struct UserHold {
    state: Arc<Mutex<State>>,
    quiet: Duration,
}

/// An agent command registered with [`UserHold::register`]; dropping it takes it out again.
#[must_use]
pub struct AgentGuard {
    state: Arc<Mutex<State>>,
    key: String,
    id: u64,
}

impl Default for UserHold {
    fn default() -> Self {
        Self::with_quiet(LOCAL_INPUT_QUIET)
    }
}

fn epoch_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX))
}

impl UserHold {
    pub fn new() -> Self {
        Self::default()
    }

    /// A hold whose quiet period after the last input is `quiet`.
    pub fn with_quiet(quiet: Duration) -> Self {
        Self { state: Arc::default(), quiet }
    }

    /// `host/browser/userInput`: the person holds the page (`held`, every input renews the quiet period, and `until` (epoch
    /// milliseconds) is when the host knows the hold ends), or lets go (the page stays out of reach for the quiet period).
    /// Either way the agent commands on the page are aborted with [`LOCAL_INPUT_TAKEOVER`].
    pub fn on_user_input(&self, params: UserInputParams) {
        let now = Instant::now();
        let mut until = now + self.quiet;
        if let Some(host_until) = params.until {
            let ahead = u64::try_from(host_until.saturating_sub(epoch_ms())).unwrap_or(0);
            if let Some(later) = now.checked_add(Duration::from_millis(ahead)) {
                until = until.max(later);
            }
        }
        let aborted = {
            let mut state = lock(&self.state);
            state.holds.insert(params.page_id.clone(), Hold { held: params.held, until });
            state.agents.get(&params.page_id).map(|agents| agents.iter().map(|(_, source)| source.clone()).collect::<Vec<_>>())
        };
        for source in aborted.into_iter().flatten() {
            source.cancel(LOCAL_INPUT_TAKEOVER);
        }
    }

    /// The host's claim ended: no page is held any more.
    pub fn host_gone(&self) {
        lock(&self.state).holds.clear();
    }

    /// `takeoverError`: what an agent command on `key` is refused with right now; a quiet, released hold is forgotten instead.
    pub fn takeover_error(&self, key: &QueueKey) -> Result<(), QueueError> {
        let mut state = lock(&self.state);
        let Some(hold) = state.holds.get(key.hold_key()) else {
            return Ok(());
        };
        if hold.held || Instant::now() < hold.until {
            return Err(QueueError::LocalInput);
        }
        state.holds.remove(key.hold_key());
        Ok(())
    }

    /// Registers an agent command's cancel source on its key, so a takeover aborts it.
    pub fn register(&self, key: &QueueKey, source: &CancelSource) -> AgentGuard {
        let mut state = lock(&self.state);
        state.next_id += 1;
        let id = state.next_id;
        state.agents.entry(key.hold_key().to_string()).or_default().push((id, source.clone()));
        AgentGuard { state: self.state.clone(), key: key.hold_key().to_string(), id }
    }
}

impl Drop for AgentGuard {
    fn drop(&mut self) {
        let mut state = lock(&self.state);
        if let Some(agents) = state.agents.get_mut(&self.key) {
            agents.retain(|(id, _)| *id != self.id);
            if agents.is_empty() {
                state.agents.remove(&self.key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_app_protocol::v2::browser_engine::BrowserUserInputReason;
    use mixdog_rt::time;

    fn input(page: &str, held: bool, until: Option<i64>) -> UserInputParams {
        UserInputParams { page_id: page.into(), seq: 1, held, until, reason: BrowserUserInputReason::Pointer }
    }

    fn page(id: &str) -> QueueKey {
        QueueKey::new("foreground", Some(id.into()))
    }

    #[tokio::test]
    async fn a_held_page_refuses_agent_commands_until_released_and_quiet() {
        let hold = UserHold::with_quiet(Duration::from_millis(40));
        assert_eq!(hold.takeover_error(&page("p1")), Ok(()));
        hold.on_user_input(input("p1", true, None));
        assert_eq!(hold.takeover_error(&page("p1")), Err(QueueError::LocalInput));
        assert_eq!(hold.takeover_error(&page("p2")), Ok(()), "another page is not held");
        time::sleep(Duration::from_millis(60)).await;
        assert_eq!(hold.takeover_error(&page("p1")), Err(QueueError::LocalInput), "held is held however long it is quiet");
        hold.on_user_input(input("p1", false, None));
        assert_eq!(hold.takeover_error(&page("p1")), Err(QueueError::LocalInput), "released, but not yet quiet");
        time::sleep(Duration::from_millis(60)).await;
        assert_eq!(hold.takeover_error(&page("p1")), Ok(()));
        assert!(lock(&hold.state).holds.is_empty(), "a quiet, released hold is forgotten");
    }

    #[tokio::test]
    async fn the_host_may_name_when_the_hold_ends() {
        let hold = UserHold::with_quiet(Duration::from_millis(1));
        hold.on_user_input(input("p1", false, Some(epoch_ms() + 80)));
        time::sleep(Duration::from_millis(20)).await;
        assert_eq!(hold.takeover_error(&page("p1")), Err(QueueError::LocalInput), "past the quiet period, before `until`");
        time::sleep(Duration::from_millis(100)).await;
        assert_eq!(hold.takeover_error(&page("p1")), Ok(()));
    }

    #[test]
    fn an_input_aborts_the_agents_of_that_page_only() {
        let hold = UserHold::new();
        let (here, there, other) = (CancelSource::new(), CancelSource::new(), CancelSource::new());
        let _a = hold.register(&page("p1"), &here);
        let _b = hold.register(&page("p1"), &there);
        let _c = hold.register(&page("p2"), &other);
        hold.on_user_input(input("p1", true, None));
        assert_eq!(here.reason().as_deref(), Some(LOCAL_INPUT_TAKEOVER));
        assert_eq!(there.reason().as_deref(), Some(LOCAL_INPUT_TAKEOVER));
        assert!(!other.view().is_cancelled());
    }

    #[test]
    fn a_registration_ends_with_its_guard() {
        let hold = UserHold::new();
        let source = CancelSource::new();
        drop(hold.register(&page("p1"), &source));
        assert!(lock(&hold.state).agents.is_empty());
        hold.on_user_input(input("p1", true, None));
        assert!(!source.view().is_cancelled());
    }

    #[test]
    fn the_host_going_away_frees_every_page() {
        let hold = UserHold::new();
        hold.on_user_input(input("p1", true, None));
        hold.host_gone();
        assert_eq!(hold.takeover_error(&page("p1")), Ok(()));
    }

    #[tokio::test]
    async fn the_quiet_period_runs_on_the_core_timers() {
        let hold = UserHold::with_quiet(Duration::from_millis(30));
        hold.on_user_input(input("p1", false, None));
        assert!(hold.takeover_error(&page("p1")).is_err());
        time::sleep(Duration::from_millis(50)).await;
        assert!(hold.takeover_error(&page("p1")).is_ok());
    }
}
