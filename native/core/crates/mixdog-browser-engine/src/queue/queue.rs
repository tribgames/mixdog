//! Owner: s4-engine-queue
//! What may run at the same time (`command-queue.ts`). Gestures on one page serialize behind each other, named background
//! pages get their own queue so independent research runs in parallel, and observations overlap freely: a write still waits
//! for the reads already in flight, so it never lands mid-observation.
//!
//! A command's own ceiling ([`Deadline`]) stands still while it has a [`UserWait`] open (an approval card) and stops it with
//! a timeout otherwise; a person's input on its page ([`UserHold`]) aborts it, queued or running, and keeps new ones out.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use mixdog_rt::CancelSource;
use mixdog_rt::CancelView;

use super::barrier::Ledger;
use super::key::QueueKey;
use super::user_hold::LOCAL_INPUT_TAKEOVER;
use super::user_hold::UserHold;
use super::user_wait::UserWait;
use super::user_wait::bounded;
use crate::limits::COMMAND_TIMEOUT;

/// Whether a command only observes the page (reads overlap) or may change it (a write is alone on its page).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Read,
    Write,
}

impl Kind {
    /// `Read` for the pure observations ([`crate::limits::is_read_only_action`]); everything else is a write.
    pub fn of_action(action: &str) -> Self {
        if crate::limits::is_read_only_action(&action.trim().to_lowercase()) { Self::Read } else { Self::Write }
    }
}

/// Why a queued command ended without a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueError {
    /// The caller cancelled it (or a deadline cancelled it), with the reason it gave.
    Cancelled { reason: Option<Arc<str>> },
    /// It ran past its ceiling, in running time (not counting time the person was asked).
    TimedOut { label: String, millis: u128 },
    /// A person's input on the page interrupted it, or holds the page.
    LocalInput,
}

impl QueueError {
    /// The error a cancelled command reports: the takeover text means a person, anything else the caller's own reason.
    pub fn from_reason(reason: Option<Arc<str>>) -> Self {
        match reason {
            Some(text) if &*text == LOCAL_INPUT_TAKEOVER => Self::LocalInput,
            reason => Self::Cancelled { reason },
        }
    }
}

impl fmt::Display for QueueError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled { reason: Some(reason) } => out.write_str(reason),
            Self::Cancelled { reason: None } => out.write_str("browser command cancelled"),
            Self::TimedOut { label, millis } => write!(out, "{label} timed out after {millis}ms"),
            Self::LocalInput => out.write_str(LOCAL_INPUT_TAKEOVER),
        }
    }
}

impl std::error::Error for QueueError {}

/// The ceiling of one command and how its timeout reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Deadline {
    pub label: String,
    pub ceiling: Duration,
}

impl Deadline {
    /// The whole-command ceiling ([`COMMAND_TIMEOUT`]) of `browser <action>`.
    pub fn command(action: &str) -> Self {
        let action = action.trim();
        Self { label: format!("browser {}", if action.is_empty() { "command" } else { action }), ceiling: COMMAND_TIMEOUT }
    }
}

/// What a running command is handed: its cancellation and the clock its waits on the person are recorded on.
pub struct RunContext {
    /// Fires when the caller cancels, a person takes the page over, or the ceiling passes; carries the reason.
    pub cancel: CancelView,
    /// Open a wait around anything the command waits on the person for, so the ceiling does not count that time.
    pub user_wait: UserWait,
}

/// The command queue of the engine: one lane per [`QueueKey`], shared by every clone.
#[derive(Clone, Default)]
pub struct CommandQueue {
    ledger: Ledger,
    hold: Arc<UserHold>,
}

impl CommandQueue {
    pub fn new(hold: Arc<UserHold>) -> Self {
        Self { ledger: Ledger::new(), hold }
    }

    /// The person's holds this queue refuses agent commands by.
    pub fn hold(&self) -> &Arc<UserHold> {
        &self.hold
    }

    /// Runs `work` on `key` once the work ahead of it is done: a `Read` behind the writes ahead, a `Write` also behind the
    /// reads in flight. `parent` is the caller's cancellation. The work is dropped, so its host calls are abandoned, when the
    /// command is cancelled or reaches its ceiling; the key stays represented by what ran before it.
    pub async fn run<T, F, Fut>(&self, key: &QueueKey, kind: Kind, deadline: &Deadline, parent: &CancelSource, work: F) -> Result<T, QueueError>
    where
        F: FnOnce(RunContext) -> Fut,
        Fut: Future<Output = T>,
    {
        self.hold.takeover_error(key)?;
        let admission = self.ledger.admit(key.lane(), kind == Kind::Read);
        let source = parent.child();
        let signal = source.view();
        let _agent = self.hold.register(key, &source);
        if admission.wait(&signal).await.is_err() {
            return Err(QueueError::from_reason(signal.reason()));
        }
        if signal.is_cancelled() {
            return Err(QueueError::from_reason(signal.reason()));
        }
        let user_wait = UserWait::new();
        let running = work(RunContext { cancel: signal.clone(), user_wait: user_wait.clone() });
        let outcome = bounded(running, deadline.ceiling, &deadline.label, &signal, Some(&user_wait)).await;
        if let Err(QueueError::TimedOut { millis, .. }) = &outcome {
            source.cancel(format!("browser command exceeded {millis}ms"));
        }
        outcome
    }

    /// Whether `key`'s lane has work in flight or ahead of it.
    pub fn is_busy(&self, key: &QueueKey) -> bool {
        self.ledger.is_busy(key.lane())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::user_hold::UserInputParams;
    use mixdog_app_protocol::v2::browser_engine::BrowserUserInputReason;
    use mixdog_rt::CancellationToken;
    use mixdog_rt::time;
    use std::sync::Mutex;
    use tokio::task::yield_now;

    fn lane(name: &str, page: Option<&str>) -> QueueKey {
        QueueKey::new(name, page.map(str::to_string))
    }

    fn deadline() -> Deadline {
        Deadline::command("test")
    }

    async fn settle() {
        for _ in 0..30 {
            yield_now().await;
        }
    }

    fn input(page: &str, held: bool) -> UserInputParams {
        UserInputParams { page_id: page.into(), seq: 1, held, until: None, reason: BrowserUserInputReason::Pointer }
    }

    fn log() -> Arc<Mutex<Vec<String>>> {
        Arc::default()
    }

    fn push(log: &Arc<Mutex<Vec<String>>>, entry: &str) {
        log.lock().expect("log").push(entry.to_string());
    }

    fn entries(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        log.lock().expect("log").clone()
    }

    #[tokio::test]
    async fn writes_serialize_on_their_page_without_delaying_independent_pages() {
        let queue = CommandQueue::default();
        let started = log();
        let gate = CancellationToken::new();
        let command = |lane_name: &'static str, name: &'static str| {
            let (queue, started, gate) = (queue.clone(), started.clone(), gate.clone());
            async move {
                queue
                    .run(&lane(lane_name, None), Kind::Write, &deadline(), &CancelSource::new(), |_| async move {
                        push(&started, name);
                        if name == "a:first" {
                            gate.cancelled().await;
                        }
                    })
                    .await
            }
        };
        let driver = async {
            settle().await;
            assert_eq!(entries(&started), ["a:first", "b:independent"]);
            gate.cancel();
        };
        let (first, second, independent, ()) = tokio::join!(command("a", "a:first"), command("a", "a:second"), command("b", "b:independent"), driver);
        assert!(first.is_ok() && second.is_ok() && independent.is_ok());
        assert_eq!(entries(&started), ["a:first", "b:independent", "a:second"]);
    }

    #[tokio::test]
    async fn reads_overlap_and_a_write_waits_for_the_reads_in_flight() {
        let queue = CommandQueue::default();
        let events = log();
        let gate = CancellationToken::new();
        let command = |kind: Kind, name: &'static str| {
            let (queue, events, gate) = (queue.clone(), events.clone(), gate.clone());
            async move {
                queue
                    .run(&lane("foreground", None), kind, &deadline(), &CancelSource::new(), |_| async move {
                        push(&events, &format!("start {name}"));
                        if name != "write" {
                            gate.cancelled().await;
                        }
                        push(&events, &format!("end {name}"));
                    })
                    .await
            }
        };
        let driver = async {
            settle().await;
            assert_eq!(entries(&events), ["start read 1", "start read 2"], "the write is behind both reads");
            gate.cancel();
        };
        let (a, b, c, ()) = tokio::join!(command(Kind::Read, "read 1"), command(Kind::Read, "read 2"), command(Kind::Write, "write"), driver);
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        let all = entries(&events);
        assert_eq!(all[all.len() - 2..], ["start write", "end write"]);
    }

    #[tokio::test]
    async fn a_person_taking_over_cancels_active_and_queued_commands_on_that_page_only() {
        let queue = CommandQueue::default();
        let key = lane("session:owner:foreground", Some("p1"));
        let started = CancellationToken::new();
        let events = log();
        let (active_deadline, active_parent) = (deadline(), CancelSource::new());
        let active = queue.run(&key, Kind::Write, &active_deadline, &active_parent, |context| {
            let (started, events) = (started.clone(), events.clone());
            async move {
                push(&events, "wait");
                started.cancel();
                context.cancel.cancelled().await;
                context.cancel.reason()
            }
        });
        let queued = async {
            started.cancelled().await;
            queue.run(&key, Kind::Write, &deadline(), &CancelSource::new(), |_| async { push(&events, "click") }).await
        };
        let person = async {
            settle().await;
            queue.hold().on_user_input(input("p1", true));
        };
        let (active, queued, ()) = tokio::join!(active, queued, person);
        // The running command saw the takeover as its cancel reason; the queued one never started.
        assert_eq!(active.expect("the running command returned").as_deref(), Some(LOCAL_INPUT_TAKEOVER));
        assert_eq!(queued, Err(QueueError::LocalInput));
        assert_eq!(entries(&events), ["wait"]);
        assert!(!queue.is_busy(&key));
        assert!(
            queue.run(&key, Kind::Write, &deadline(), &CancelSource::new(), |_| async {}).await.unwrap_err().to_string().contains("observe the page again")
        );
        // An independent background page and another session's page run.
        let other = lane("session:owner:background:research", Some("p2"));
        assert_eq!(queue.run(&other, Kind::Write, &deadline(), &CancelSource::new(), |_| async { 1 }).await, Ok(1));
        let session = lane("session:other:foreground", Some("p7"));
        assert_eq!(queue.run(&session, Kind::Write, &deadline(), &CancelSource::new(), |_| async { 2 }).await, Ok(2));
    }

    #[tokio::test]
    async fn after_the_person_lets_go_the_page_is_open_again_once_quiet() {
        let queue = CommandQueue::new(Arc::new(UserHold::with_quiet(Duration::from_millis(40))));
        let key = lane("foreground", Some("p1"));
        queue.hold().on_user_input(input("p1", true));
        let refused = queue.run(&key, Kind::Read, &deadline(), &CancelSource::new(), |_| async {}).await;
        assert_eq!(refused, Err(QueueError::LocalInput));
        queue.hold().on_user_input(input("p1", false));
        let refused = queue.run(&key, Kind::Write, &deadline(), &CancelSource::new(), |_| async {}).await;
        assert_eq!(refused, Err(QueueError::LocalInput));
        time::sleep(Duration::from_millis(60)).await;
        assert_eq!(queue.run(&key, Kind::Read, &deadline(), &CancelSource::new(), |_| async { 3 }).await, Ok(3));
    }

    #[tokio::test]
    async fn a_command_cancelled_before_dispatch_is_released_at_once_and_never_runs() {
        let queue = CommandQueue::default();
        let key = lane("foreground", None);
        let release = CancellationToken::new();
        let dispatches = log();
        let (previous_deadline, previous_parent) = (deadline(), CancelSource::new());
        let previous = queue.run(&key, Kind::Write, &previous_deadline, &previous_parent, |_| async {
            release.cancelled().await;
            push(&dispatches, "previous");
        });
        let caller = CancelSource::new();
        let cancelled = async {
            settle().await;
            let pending_deadline = deadline();
            let pending = queue.run(&key, Kind::Write, &pending_deadline, &caller, |_| async { push(&dispatches, "unexpected") });
            let cancelling = async {
                settle().await;
                caller.cancel("fixture cancelled");
            };
            let (outcome, ()) = tokio::join!(pending, cancelling);
            assert_eq!(outcome, Err(QueueError::Cancelled { reason: Some("fixture cancelled".into()) }));
            assert!(entries(&dispatches).is_empty(), "nothing dispatched while behind the previous one");
            let (next_deadline, next_parent) = (deadline(), CancelSource::new());
            let next = queue.run(&key, Kind::Write, &next_deadline, &next_parent, |_| async { push(&dispatches, "next") });
            let releasing = async {
                settle().await;
                assert!(entries(&dispatches).is_empty(), "the next one still waits for the previous");
                release.cancel();
            };
            let (next, ()) = tokio::join!(next, releasing);
            next
        };
        let (previous, next) = tokio::join!(previous, cancelled);
        assert!(previous.is_ok() && next.is_ok());
        assert_eq!(entries(&dispatches), ["previous", "next"]);
    }

    #[tokio::test]
    async fn the_ceiling_stops_at_its_limit_and_stands_still_while_the_person_is_asked() {
        let queue = CommandQueue::default();
        let key = lane("foreground", None);
        let short = Deadline { label: "browser click".into(), ceiling: Duration::from_millis(40) };
        let stuck = queue.run(&key, Kind::Write, &short, &CancelSource::new(), |_| std::future::pending::<()>()).await;
        assert_eq!(stuck, Err(QueueError::TimedOut { label: "browser click".into(), millis: 40 }));
        assert!(!queue.is_busy(&key), "the key is free once the command ended");
        let asked = queue
            .run(&key, Kind::Write, &short, &CancelSource::new(), |context| async move {
                let asking = context.user_wait.begin();
                time::sleep(Duration::from_millis(90)).await;
                drop(asking);
                "answered"
            })
            .await;
        assert_eq!(asked, Ok("answered"));
    }

    #[tokio::test]
    async fn the_timeout_cancels_the_work_it_was_waiting_on() {
        let queue = CommandQueue::default();
        let short = Deadline { label: "browser wait".into(), ceiling: Duration::from_millis(30) };
        let seen = Arc::new(Mutex::new(None));
        let recorded = seen.clone();
        let error = queue
            .run(&lane("foreground", None), Kind::Write, &short, &CancelSource::new(), |context| async move {
                *recorded.lock().expect("seen") = Some(context.cancel);
                std::future::pending::<()>().await;
            })
            .await;
        assert!(matches!(error, Err(QueueError::TimedOut { .. })));
        let cancel = seen.lock().expect("seen").take().expect("the work started");
        assert_eq!(cancel.reason().as_deref(), Some("browser command exceeded 30ms"));
    }

    #[test]
    fn the_kind_of_an_action_follows_the_read_only_set() {
        assert_eq!(Kind::of_action(" Read "), Kind::Read);
        assert_eq!(Kind::of_action("snapshot"), Kind::Write);
        assert_eq!(Kind::of_action("click"), Kind::Write);
        assert_eq!(Deadline::command("").label, "browser command");
        assert_eq!(Deadline::command("click").ceiling, COMMAND_TIMEOUT);
    }
}
