//! The helper's foreground-lease asks relayed to the desktop's lease owner (`backend/foreground-lock-host.ts`).
//!
//! Windows grants the foreground lock only to a process that may set the foreground, which while the user works in a Mixdog
//! window is the desktop, so the desktop owns the lease and the core only carries the ask there and the answer back.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::ids::Method;
use mixdog_protocol::ProcessHandle;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use super::computer_backend::Pending;

/// The prefix of a helper's lease line (`MixForegroundLock.cs:336`).
pub(super) const LINE_MARKER: &str = "@@MIXDOG_FGLOCK@@";
/// The prefix of the answers on the helper's stdin (`foreground-lock-host.ts` `FOREGROUND_LOCK_REPLY_PREFIX`).
const REPLY_MARKER: &str = "@@MIXDOG_FGLOCK_REPLY@@";
const METHOD: &str = "host/computer/foregroundLease";
/// The largest id the helper numbers an action or ask with (`foreground-lock-host.ts` `MAX_ID`).
const MAX_ID: f64 = 2_147_483_647.0;
/// No lease holds every other app's foreground changes for longer (`MAX_HOLD_MS`).
const MAX_HOLD_MS: f64 = 1000.0;
/// The most `answer_by` may be: 2^52 (`parseLeaseLine`).
const MAX_ANSWER_BY: f64 = 4_503_599_627_370_496.0;
/// The helper waits 250 ms for an answer (`lease.rs` `ANSWER_TIMEOUT_MS`) and the desktop owner 400 ms for its lease thread
/// (`computer-lease.ts` `ANSWER_WAIT_MS`), so an ask left longer than this is answered without it instead of holding the
/// helper's next ask (its release, the next action's acquire) behind it.
const ASK_TIMEOUT: Duration = Duration::from_millis(500);
/// Facts kept for actions whose reply never came, before the oldest are dropped (`MAX_FACTS`).
const MAX_FACTS: usize = 256;

const ACK_ANSWERS: [&str; 6] = ["locked", "refused", "busy", "quarantined", "expired", "unavailable"];
const RELEASE_OUTCOMES: [&str; 4] = ["released", "unknown", "failed", "none"];

/// One well-formed ask of the helper (`parseLeaseLine`).
#[derive(Debug, PartialEq)]
enum Ask {
    Acquire { action: u32, seq: u32, hold_ms: u32, answer_by: f64 },
    Release { action: u32, seq: u32, lease: u32 },
}

impl Ask {
    fn action(&self) -> u32 {
        match self {
            Self::Acquire { action, .. } | Self::Release { action, .. } => *action,
        }
    }

    /// The `host/computer/foregroundLease` params; a number the op does not use is 0.
    fn params(&self, instance: &str) -> Value {
        match *self {
            Self::Acquire { action, seq, hold_ms, answer_by } => {
                json!({"op": "acquire", "instance": instance, "action": action, "seq": seq, "holdMs": hold_ms, "answerBy": answer_by, "lease": 0})
            }
            Self::Release { action, seq, lease } => {
                json!({"op": "release", "instance": instance, "action": action, "seq": seq, "holdMs": 0, "answerBy": 0, "lease": lease})
            }
        }
    }
}

/// An integer in `min..=MAX_ID` (`boundedId`).
fn bounded_id(value: Option<&Value>, min: f64) -> Option<u32> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number >= min && number <= MAX_ID).then_some(number as u32)
}

/// A well-formed request line, or None for anything else (`parseLeaseLine`).
fn parse(body: &str) -> Option<Ask> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = value.as_object()?;
    let action = bounded_id(message.get("action"), 1.0)?;
    let seq = bounded_id(message.get("seq"), 1.0)?;
    match message.get("op")?.as_str()? {
        "acquire" => {
            let hold_ms = message.get("hold_ms").and_then(Value::as_f64).filter(|hold| hold.fract() == 0.0).unwrap_or(0.0);
            if !(1.0..=MAX_HOLD_MS).contains(&hold_ms) {
                return None;
            }
            let answer_by = message.get("answer_by")?.as_f64().filter(|by| by.is_finite() && (0.0..=MAX_ANSWER_BY).contains(by))?;
            Some(Ask::Acquire { action, seq, hold_ms: hold_ms as u32, answer_by })
        }
        "release" => Some(Ask::Release { action, seq, lease: bounded_id(message.get("lease"), 0.0)? }),
        _ => None,
    }
}

/// What the relay's task is told, in the order the helper said it.
enum Message {
    Ask(Ask),
    Gone,
}

/// One helper's relay. It answers on the helper's stdin directly, never through the backend's turn gate, which the request that
/// asked holds.
pub(super) struct Relay {
    pending: Pending,
    /// None where there is no runtime to run the asks on: they are dropped.
    inbox: Option<mpsc::UnboundedSender<Message>>,
    /// The desktop owner's facts per action, the last it gave (`foreground_lock.host` of the action's reply).
    facts: Facts,
}

/// The owner's facts by action id, in the order they came.
type Facts = Arc<Mutex<Vec<(i64, Value)>>>;

impl Relay {
    /// The relay of the helper `handle` runs under `manager`, whose requests in flight are `pending`.
    pub(super) fn new(manager: Arc<dyn ProcessManager>, handle: ProcessHandle, pending: Pending, desktop: Option<Arc<dyn HostChannel>>) -> Self {
        let facts = Facts::default();
        let inbox = tokio::runtime::Handle::try_current().ok().map(|runtime| {
            let (send, receive) = mpsc::unbounded_channel();
            runtime.spawn(serve(receive, manager, handle, desktop, facts.clone()));
            send
        });
        Self { pending, inbox, facts }
    }

    /// The owner's facts for `action`, once: the reply of that action carries them (`worker-pool.ts` `takeFacts`).
    pub(super) fn take_facts(&self, action: i64) -> Option<Value> {
        let mut facts = self.facts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let at = facts.iter().position(|(id, _)| *id == action)?;
        Some(facts.remove(at).1)
    }

    /// One lease line, without its prefix. A line that is not a well-formed ask of a request in flight is ignored, never a
    /// failure of the request (`handle`: `!worker.owns(line.action)`).
    pub(super) fn on_line(&self, body: &str) {
        let Some(ask) = parse(body) else { return };
        let in_flight = self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains_key(&i64::from(ask.action()));
        if let (true, Some(inbox)) = (in_flight, &self.inbox) {
            let _ = inbox.send(Message::Ask(ask));
        }
    }
}

impl Drop for Relay {
    /// The helper is gone: a lease it holds ends now (`workerGone`).
    fn drop(&mut self) {
        if let Some(inbox) = &self.inbox {
            let _ = inbox.send(Message::Gone);
        }
    }
}

/// Answers the helper's asks one at a time, as they came.
async fn serve(
    mut inbox: mpsc::UnboundedReceiver<Message>,
    manager: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    desktop: Option<Arc<dyn HostChannel>>,
    facts: Facts,
) {
    let mut asked = false;
    while let Some(message) = inbox.recv().await {
        match message {
            Message::Ask(ask) => {
                asked = true;
                let answer = ask_desktop(desktop.as_ref(), ask.params(&handle.0)).await;
                if let Answer::Result(result) = &answer
                    && let Some(given) = result.get("facts").filter(|given| given.is_object())
                {
                    file(&facts, i64::from(ask.action()), given.clone());
                }
                let line = reply(&ask, answer);
                let _ = manager.write_stdin(&handle, line.into_bytes()).await;
            }
            Message::Gone => {
                if asked {
                    let gone = json!({"op": "gone", "instance": handle.0, "action": 0, "seq": 0, "holdMs": 0, "answerBy": 0, "lease": 0});
                    let _ = ask_desktop(desktop.as_ref(), gone).await;
                }
                return;
            }
        }
    }
}

/// Keeps `given` as the facts of `action`, the last one winning.
fn file(facts: &Facts, action: i64, given: Value) {
    let mut facts = facts.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    facts.retain(|(id, _)| *id != action);
    facts.push((action, given));
    if facts.len() > MAX_FACTS {
        facts.remove(0);
    }
}

/// How the desktop's owner answered one ask.
enum Answer {
    /// Its `host/computer/foregroundLease` result.
    Result(Value),
    /// No desktop serves Computer: no lease owner exists.
    Unserved,
    /// The desktop did not answer: an error, or past the wait.
    Lost,
}

async fn ask_desktop(desktop: Option<&Arc<dyn HostChannel>>, params: Value) -> Answer {
    let Some(desktop) = desktop.filter(|desktop| desktop.serves(HostCapability::Computer)) else { return Answer::Unserved };
    match mixdog_rt::time::timeout(ASK_TIMEOUT, desktop.request(HostCapability::Computer, Method(METHOD), params)).await {
        Ok(Ok(result)) => Answer::Result(result),
        _ => Answer::Lost,
    }
}

/// The helper's reply line to `ask` (`foreground-lock-host.ts` `answer` and `released`). An acquire the desktop cannot lease
/// for is `unavailable` with no lease; a release whose owner is gone held nothing (`none`), and one that went unanswered is
/// `unknown`.
fn reply(ask: &Ask, answer: Answer) -> String {
    match *ask {
        Ask::Acquire { action, seq, .. } => {
            let granted = match &answer {
                Answer::Result(result) if result["kind"] == "ack" => {
                    let lease = result["lease"].as_u64().filter(|lease| (*lease as f64) <= MAX_ID);
                    let said = result["answer"].as_str().filter(|said| ACK_ANSWERS.contains(said));
                    let deadline = result["deadlineAt"].as_f64().filter(|at| at.is_finite()).unwrap_or(0.0);
                    lease.zip(said).map(|(lease, said)| (lease, said, deadline))
                }
                _ => None,
            };
            let (lease, said, deadline) = granted.unwrap_or((0, "unavailable", 0.0));
            format!("{REPLY_MARKER}ack {action} {seq} {lease} {said} {deadline:.3}\n")
        }
        Ask::Release { action, seq, lease } => {
            let outcome = match &answer {
                Answer::Result(result) if result["kind"] == "released" => {
                    result["outcome"].as_str().filter(|outcome| RELEASE_OUTCOMES.contains(outcome)).unwrap_or("unknown")
                }
                Answer::Lost => "unknown",
                _ => "none",
            };
            format!("{REPLY_MARKER}released {action} {seq} {lease} {outcome}\n")
        }
    }
}

/// Whether the desktop can own a foreground lease for the helper: when it serves Computer.
pub(super) fn owner_available(desktop: Option<&Arc<dyn HostChannel>>) -> bool {
    desktop.is_some_and(|desktop| desktop.serves(HostCapability::Computer))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use mixdog_core_api::CoreError;
    use mixdog_core_api::HostError;
    use mixdog_core_api::domain::common::EventSource;
    use mixdog_core_api::domain::process::ProcessError;
    use mixdog_core_api::domain::process::ProcessEvent;
    use mixdog_core_api::domain::process::ProcessInfo;
    use mixdog_core_api::domain::process::PtySize;
    use mixdog_core_api::domain::process::SpawnRequest;
    use mixdog_core_api::domain::process::SpawnedProcess;

    use super::*;

    /// A manager that keeps what is written to a helper's stdin.
    struct Stdin(mpsc::UnboundedSender<String>);

    #[async_trait]
    impl ProcessManager for Stdin {
        async fn spawn(&self, _: SpawnRequest) -> Result<SpawnedProcess, ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        fn subscribe(&self, _: &ProcessHandle, _: Option<u64>) -> Result<Box<dyn EventSource<ProcessEvent>>, ProcessError> {
            Err(ProcessError::UnknownHandle)
        }
        async fn write_stdin(&self, _: &ProcessHandle, bytes: Vec<u8>) -> Result<(), ProcessError> {
            let _ = self.0.send(String::from_utf8(bytes).expect("a text line"));
            Ok(())
        }
        fn close_stdin(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Err(ProcessError::StdinClosed)
        }
        fn resize_pty(&self, _: &ProcessHandle, _: PtySize) -> Result<(), ProcessError> {
            Err(ProcessError::NotPty)
        }
        fn kill(&self, _: &ProcessHandle) -> Result<(), ProcessError> {
            Ok(())
        }
        fn list(&self) -> Vec<ProcessInfo> {
            Vec::new()
        }
    }

    /// A desktop that answers the asks it is given, in order, and reports each one's params.
    struct Desktop {
        serving: bool,
        answers: Mutex<VecDeque<Result<Value, HostError>>>,
        asked: mpsc::UnboundedSender<Value>,
    }

    #[async_trait]
    impl HostChannel for Desktop {
        fn serves(&self, capability: HostCapability) -> bool {
            assert_eq!(capability, HostCapability::Computer);
            self.serving
        }
        async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            assert_eq!((capability, method.0), (HostCapability::Computer, METHOD));
            let _ = self.asked.send(params);
            self.answers.lock().unwrap().pop_front().expect("a scripted answer")
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    struct Rig {
        relay: Option<Relay>,
        stdin: mpsc::UnboundedReceiver<String>,
        asked: mpsc::UnboundedReceiver<Value>,
    }

    /// A relay of a helper with request 7 in flight, to a desktop that serves (or not) and answers with `answers`.
    fn rig(serving: bool, answers: Vec<Result<Value, HostError>>) -> Rig {
        let (write, stdin) = mpsc::unbounded_channel();
        let (asked_tx, asked) = mpsc::unbounded_channel();
        let desktop: Arc<dyn HostChannel> = Arc::new(Desktop { serving, answers: Mutex::new(answers.into()), asked: asked_tx });
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        pending.lock().unwrap().insert(7, Box::new(|_| {}));
        let relay = Relay::new(Arc::new(Stdin(write)), ProcessHandle("computer-1".into()), pending, Some(desktop));
        Rig { relay: Some(relay), stdin, asked }
    }

    async fn next<T>(channel: &mut mpsc::UnboundedReceiver<T>) -> T {
        mixdog_rt::time::timeout(Duration::from_secs(5), channel.recv()).await.expect("in time").expect("sent")
    }

    const ACQUIRE: &str = r#"{"op":"acquire","action":7,"seq":3,"hold_ms":200,"answer_by":5.5}"#;

    #[tokio::test]
    async fn an_acquire_is_forwarded_and_answered_on_stdin_in_the_helpers_format() {
        let ack = json!({"kind": "ack", "answer": "locked", "lease": 4, "deadlineAt": 12.3456, "facts": {"holder": "host"}});
        let released = json!({"kind": "released", "outcome": "released", "facts": {"holder": "host", "release": "released"}});
        let mut rig = rig(true, vec![Ok(ack), Ok(released)]);
        let relay = rig.relay.as_ref().unwrap();
        relay.on_line(ACQUIRE);
        assert_eq!(
            next(&mut rig.asked).await,
            json!({"op": "acquire", "instance": "computer-1", "action": 7, "seq": 3, "holdMs": 200, "answerBy": 5.5, "lease": 0})
        );
        assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@ack 7 3 4 locked 12.346\n");
        relay.on_line(r#"{"op":"release","action":7,"seq":4,"lease":4}"#);
        assert_eq!(
            next(&mut rig.asked).await,
            json!({"op": "release", "instance": "computer-1", "action": 7, "seq": 4, "holdMs": 0, "answerBy": 0, "lease": 4})
        );
        assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@released 7 4 4 released\n");
        // The last facts the owner gave for the action wait for its reply, once.
        assert_eq!(relay.take_facts(7), Some(json!({"holder": "host", "release": "released"})));
        assert_eq!(relay.take_facts(7), None);
    }

    /// Lines that are not a well-formed ask of a request in flight are dropped without a word to the desktop or the helper.
    #[tokio::test]
    async fn malformed_out_of_range_and_not_in_flight_lines_are_ignored() {
        let mut rig = rig(true, vec![Ok(json!({"kind": "ack", "answer": "refused", "lease": 0, "deadlineAt": 0}))]);
        let relay = rig.relay.as_ref().unwrap();
        for line in [
            "",
            "acquire 7 3",
            "[]",
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":200}"#,
            r#"{"op":"acquire","action":0,"seq":3,"hold_ms":200,"answer_by":1}"#,
            r#"{"op":"acquire","action":2147483648,"seq":3,"hold_ms":200,"answer_by":1}"#,
            r#"{"op":"acquire","action":7,"seq":0,"hold_ms":200,"answer_by":1}"#,
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":0,"answer_by":1}"#,
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":1001,"answer_by":1}"#,
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":2.5,"answer_by":1}"#,
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":200,"answer_by":-1}"#,
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":200,"answer_by":4503599627370497}"#,
            r#"{"op":"acquire","action":7,"seq":3,"hold_ms":200,"answer_by":"1"}"#,
            r#"{"op":"release","action":7,"seq":3,"lease":-1}"#,
            r#"{"op":"steal","action":7,"seq":3}"#,
            r#"{"op":"acquire","action":8,"seq":3,"hold_ms":200,"answer_by":1}"#,
        ] {
            relay.on_line(line);
        }
        relay.on_line(ACQUIRE);
        // The one valid ask is the first the desktop and the helper hear of.
        assert_eq!(next(&mut rig.asked).await["seq"], 3);
        assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@ack 7 3 0 refused 0.000\n");
        assert!(rig.asked.try_recv().is_err() && rig.stdin.try_recv().is_err());
    }

    #[tokio::test]
    async fn without_a_desktop_that_serves_computer_the_answer_is_unavailable() {
        let mut rig = rig(false, Vec::new());
        let relay = rig.relay.as_ref().unwrap();
        relay.on_line(ACQUIRE);
        assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@ack 7 3 0 unavailable 0.000\n");
        relay.on_line(r#"{"op":"release","action":7,"seq":4,"lease":0}"#);
        assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@released 7 4 0 none\n");
        assert!(rig.asked.try_recv().is_err());
    }

    /// A desktop error or an answer the helper could not read is `unavailable` for an acquire and `unknown` for a release.
    #[tokio::test]
    async fn a_failed_or_unreadable_desktop_answer_is_the_unavailable_ack() {
        let failure = HostError::Rpc { code: -32000, message: "x".into(), data: None };
        let mut rig = rig(true, vec![Err(failure.clone()), Ok(json!({"kind": "ack", "answer": "locked 1 x", "lease": 1})), Err(failure)]);
        let relay = rig.relay.as_ref().unwrap();
        for _ in 0..2 {
            relay.on_line(ACQUIRE);
            assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@ack 7 3 0 unavailable 0.000\n");
        }
        relay.on_line(r#"{"op":"release","action":7,"seq":4,"lease":2}"#);
        assert_eq!(next(&mut rig.stdin).await, "@@MIXDOG_FGLOCK_REPLY@@released 7 4 2 unknown\n");
    }

    /// The helper's exit tells the desktop it is gone, but only when it ever asked.
    #[tokio::test]
    async fn the_helpers_exit_sends_gone_once_it_has_asked() {
        let mut held = rig(true, vec![Ok(json!({"kind": "ack", "answer": "locked", "lease": 1, "deadlineAt": 1})), Ok(Value::Null)]);
        held.relay.as_ref().unwrap().on_line(ACQUIRE);
        next(&mut held.stdin).await;
        next(&mut held.asked).await;
        held.relay = None;
        let gone = next(&mut held.asked).await;
        assert_eq!((gone["op"].as_str(), gone["instance"].as_str()), (Some("gone"), Some("computer-1")));

        let mut silent = rig(true, Vec::new());
        silent.relay = None;
        mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        assert!(silent.asked.try_recv().is_err());
    }

    #[test]
    fn the_owner_is_available_when_the_desktop_serves_computer() {
        let (asked, _) = mpsc::unbounded_channel();
        let serving: Arc<dyn HostChannel> = Arc::new(Desktop { serving: true, answers: Mutex::default(), asked: asked.clone() });
        let absent: Arc<dyn HostChannel> = Arc::new(Desktop { serving: false, answers: Mutex::default(), asked });
        assert!(owner_available(Some(&serving)));
        assert!(!owner_available(Some(&absent)));
        assert!(!owner_available(None));
    }
}
