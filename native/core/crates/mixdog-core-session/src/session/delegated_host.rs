// Transparent names for existing callback/record shapes; no ownership or ordering change.
type DelegatedHandoff = (CopyFor, Vec<(String, Delegated, u64)>);

use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use mixdog_services::bots::delivery::queue::Handoffs;
use serde_json::Value;

/// The arguments a copy's answer carries to the owner (`finishToolApproval(id, approved, reason,
/// device, answers, reply, extra)` without the id); `None` is `undefined`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Answered {
    pub approved: bool,
    pub reason: String,
    pub device: String,
    pub answers: Option<Value>,
    pub reply: Option<Value>,
    pub extra: Option<Value>,
}

/// `answer(...finishArgs) → boolean` of a delegated request: forwards a copy's answer to its owner;
/// false when the owner had already settled it.
pub type Answer = Arc<dyn Fn(&Answered) -> bool + Send + Sync>;
/// `copyFor(chat, { title })`: the request as that chat shows it.
pub type CopyFor = Arc<dyn Fn(&str, &str) -> Value + Send + Sync>;

/// `{ id, sessionId, request, answer }`: `session_id` is the conversation that shows it.
#[derive(Clone)]
pub struct Delegated {
    pub id: String,
    pub session_id: String,
    pub request: Value,
    pub answer: Answer,
}

/// One session runtime's approval queue (`registerApprovalQueue`).
pub trait ApprovalQueue: Send + Sync {
    fn session_id(&self) -> String;
    fn disposed(&self) -> bool;
    fn offer(&self, delegated: &Delegated);
    /// `result`: `{ approved, device, record }`, which lets a copy say who answered.
    fn withdraw(&self, id: &str, result: Option<&Value>);
}

/// `open(sessionId)`: brings a session's runtime up, so a chat that is not loaded can show the copy.
#[async_trait]
pub trait SessionOpener: Send + Sync {
    async fn open(&self, session_id: &str) -> Result<(), String>;
}

struct Handoff {
    run_id: String,
    session_id: String,
    surface_session_id: String,
    title: String,
}

struct Pending {
    serial: u64,
    asked: Delegated,
    /// `delegateToHandoffs`: the request as each chat shows it, and the copies now held.
    handoff: Option<DelegatedHandoff>,
}

#[derive(Default)]
struct Registry {
    queues: Vec<Arc<dyn ApprovalQueue>>,
    pending: Vec<Pending>,
    opener: Option<Arc<dyn SessionOpener>>,
    handoffs: Vec<Handoff>,
    /// The run ids whose hand-off ended, with the session the work was handed to when the end or the note of it says.
    ended: Vec<(String, Option<String>)>,
    serial: u64,
}

/// What `syncHandoffCopies` decided, run after the lock is released and in this order.
enum Step {
    Withdraw { chat: String, id: String },
    Deliver { copy: Delegated, serial: u64, asked_serial: u64 },
}

#[derive(Default)]
pub struct DelegatedApprovalHost {
    registry: Mutex<Registry>,
    /// The deferred offers still running, for the tests to await.
    #[cfg(feature = "test-support")]
    deferred: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// The report-watch store's [`Handoffs`] over the one host: a watch added is `noteHandoff`, a watch
/// gone is `endHandoff` (`RoutineResultQueue::new(.., handoffs)`).
pub struct HostHandoffs(Arc<DelegatedApprovalHost>);

impl HostHandoffs {
    pub fn new(host: Arc<DelegatedApprovalHost>) -> Arc<Self> {
        Arc::new(Self(host))
    }
}

impl Handoffs for HostHandoffs {
    fn note(&self, watch: &Value) {
        self.0.note_handoff(watch);
    }

    fn end(&self, run_id: &str) {
        self.0.end_handoff(run_id);
    }

    fn end_watch(&self, watch: &Value) {
        match (watch.get("runId"), watch.get("taskSessionId")) {
            (Some(run_id), Some(task)) if !falsy(Some(run_id)) && !falsy(Some(task)) => self.0.end_handoff_of(&js_string(run_id), Some(js_string(task))),
            (Some(run_id), _) if !falsy(Some(run_id)) => self.0.end_handoff(&js_string(run_id)),
            _ => {}
        }
    }
}

/// A JS falsy `Value` (`!value`).
fn falsy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number == 0.0 || number.is_nan()),
        Some(_) => false,
    }
}

/// `String(value)` for what a watch carries.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

impl DelegatedApprovalHost {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Returns once every deferred offer, and any it started in turn, has ended.
    #[cfg(feature = "test-support")]
    pub async fn deferred_offers(&self) {
        loop {
            let Some(offer) = self.deferred.lock().unwrap().pop() else { return };
            crate::session::testing::awaiting(|| "a deferred offer to end".to_owned(), offer).await.unwrap();
        }
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `handoffChatsOf(sessionId)`: the chats with a live hand-off to `session_id`, each once (in
    /// noting order) with the name its latest hand-off gave the session.
    pub fn handoff_chats_of(&self, session_id: &str) -> Vec<(String, String)> {
        chats_of(&self.lock(), session_id)
    }

    /// `noteHandoff`: chat `homeSessionId` handed session `taskSessionId` work (`title`: the target's
    /// name in that chat) under report watch `runId`.
    pub fn note_handoff(self: &Arc<Self>, watch: &Value) {
        let field = |name: &str| watch.get(name);
        let (run_id, task, home) = (field("runId"), field("taskSessionId"), field("homeSessionId"));
        if falsy(run_id) || falsy(task) || falsy(home) || task == home {
            return;
        }
        let (run_id, task) = (js_string(run_id.unwrap_or(&Value::Null)), js_string(task.unwrap_or(&Value::Null)));
        let steps = {
            let mut registry = self.lock();
            if let Some((_, known)) = registry.ended.iter_mut().find(|(ended, _)| *ended == run_id) {
                // A note that follows its end learns whose session the end belongs to.
                known.get_or_insert(task);
                return;
            }
            let handoff = Handoff {
                run_id: run_id.clone(),
                session_id: task.clone(),
                surface_session_id: js_string(home.unwrap_or(&Value::Null)),
                title: if falsy(field("title")) { String::new() } else { js_string(field("title").unwrap_or(&Value::Null)) },
            };
            // `Map.set` on a known key keeps its place.
            match registry.handoffs.iter().position(|held| held.run_id == run_id) {
                Some(at) => registry.handoffs[at] = handoff,
                None => registry.handoffs.push(handoff),
            }
            sync_copies(&mut registry, &task)
        };
        self.run(steps);
    }

    /// `endHandoff`: the report watch `run_id` is gone, so its hand-off ends for good.
    pub fn end_handoff(self: &Arc<Self>, run_id: &str) {
        self.end_handoff_of(run_id, None);
    }

    /// `endHandoff` of a watch that names its task session (`task`): the end is remembered until that session ends.
    pub fn end_handoff_of(self: &Arc<Self>, run_id: &str, task: Option<String>) {
        let steps = {
            let mut registry = self.lock();
            let held = registry.handoffs.iter().position(|held| held.run_id == run_id);
            let task = task.or_else(|| held.map(|at| registry.handoffs[at].session_id.clone()));
            match registry.ended.iter_mut().find(|(ended, _)| ended == run_id) {
                Some((_, known)) => *known = known.take().or(task),
                None => registry.ended.push((run_id.to_owned(), task)),
            }
            let Some(at) = held else { return };
            let task = registry.handoffs.remove(at).session_id;
            sync_copies(&mut registry, &task)
        };
        self.run(steps);
    }

    /// The session `session_id` ended: the hand-offs of work given to it that ended are no longer remembered as ended.
    pub fn session_ended(&self, session_id: &str) {
        self.lock().ended.retain(|(_, task)| task.as_deref() != Some(session_id));
    }

    #[cfg(test)]
    fn ended_held(&self) -> usize {
        self.lock().ended.len()
    }

    /// `registerApprovalQueue`: the returned handle's `unregister` is Node's returned function.
    pub fn register_queue(&self, queue: Arc<dyn ApprovalQueue>) -> QueueHandle {
        self.lock().queues.push(queue.clone());
        QueueHandle { queue }
    }

    /// `Set.delete`: whether the queue was still registered.
    pub fn unregister_queue(&self, handle: &QueueHandle) -> bool {
        let mut registry = self.lock();
        let before = registry.queues.len();
        registry.queues.retain(|held| !Arc::ptr_eq(held, &handle.queue));
        registry.queues.len() != before
    }

    /// `registerDelegatedApprovalOpener`.
    pub fn register_opener(&self, opener: Arc<dyn SessionOpener>) {
        self.lock().opener = Some(opener);
    }

    /// Clears the opener only while it is still `opener`.
    pub fn unregister_opener(&self, opener: &Arc<dyn SessionOpener>) {
        let mut registry = self.lock();
        if registry.opener.as_ref().is_some_and(|held| Arc::ptr_eq(held, opener)) {
            registry.opener = None;
        }
    }

    /// `delegateApproval`: show `delegated` in its top-level conversation, now or once it loads.
    pub fn delegate_approval(self: &Arc<Self>, delegated: Delegated) {
        let (serial, copy) = {
            let mut registry = self.lock();
            registry.serial += 1;
            let serial = registry.serial;
            let entry = Pending { serial, asked: delegated.clone(), handoff: None };
            put_pending(&mut registry, entry);
            (serial, delegated)
        };
        self.deliver(copy, Current::Plain { serial });
    }

    /// `delegateToHandoffs`: a top-level session's request that every chat handing it work shows too,
    /// now and while it waits.
    pub fn delegate_to_handoffs(self: &Arc<Self>, asked: Delegated, copy_for: CopyFor) {
        let session = asked.session_id.clone();
        let steps = {
            let mut registry = self.lock();
            registry.serial += 1;
            let serial = registry.serial;
            put_pending(&mut registry, Pending { serial, asked, handoff: Some((copy_for, Vec::new())) });
            sync_copies(&mut registry, &session)
        };
        self.run(steps);
    }

    /// `withdrawDelegatedApproval`: the owner settled `id`, so every copy goes away.
    pub fn withdraw_delegated_approval(&self, id: &str, result: Option<&Value>) {
        let queues = {
            let mut registry = self.lock();
            let Some(at) = registry.pending.iter().position(|held| held.asked.id == id) else { return };
            registry.pending.remove(at);
            registry.queues.clone()
        };
        for queue in queues {
            queue.withdraw(id, result);
        }
    }

    /// `delegatedApprovalsFor`: the pending delegated approvals (and hand-off copies) a top-level
    /// session should show.
    pub fn delegated_approvals_for(&self, session_id: &str) -> Vec<Delegated> {
        let registry = self.lock();
        registry
            .pending
            .iter()
            .filter_map(|held| match &held.handoff {
                Some((_, copies)) => copies.iter().find(|(chat, _, _)| chat == session_id).map(|(_, copy, _)| copy.clone()),
                None => (held.asked.session_id == session_id).then(|| held.asked.clone()),
            })
            .collect()
    }

    fn run(self: &Arc<Self>, steps: Vec<Step>) {
        for step in steps {
            match step {
                Step::Withdraw { chat, id } => {
                    for queue in self.live_queues_of(&chat) {
                        queue.withdraw(&id, None);
                    }
                }
                Step::Deliver { copy, serial, asked_serial } => self.deliver(copy, Current::Copy { asked_serial, serial }),
            }
        }
    }

    /// `liveQueuesOf`: queues of `session_id` still alive; disposed ones are dropped on the way.
    fn live_queues_of(&self, session_id: &str) -> Vec<Arc<dyn ApprovalQueue>> {
        let mut registry = self.lock();
        registry.queues.retain(|queue| !queue.disposed());
        registry.queues.iter().filter(|queue| queue.session_id() == session_id).cloned().collect()
    }

    /// `offerTo`: whether any live queue of the copy's chat took it.
    fn offer_to(&self, copy: &Delegated) -> bool {
        let live = self.live_queues_of(&copy.session_id);
        for queue in &live {
            queue.offer(copy);
        }
        !live.is_empty()
    }

    fn still(&self, current: &Current, copy: &Delegated) -> bool {
        let registry = self.lock();
        let Some(held) = registry.pending.iter().find(|held| held.asked.id == copy.id) else { return false };
        match (*current, &held.handoff) {
            (Current::Plain { serial }, None) => held.serial == serial,
            (Current::Copy { asked_serial, serial }, Some((_, copies))) => {
                held.serial == asked_serial && copies.iter().any(|(chat, _, held_serial)| *chat == copy.session_id && *held_serial == serial)
            }
            _ => false,
        }
    }

    /// `deliver`: offer `copy` in its chat now, or once that chat loads while it still holds.
    fn deliver(self: &Arc<Self>, copy: Delegated, current: Current) {
        if self.offer_to(&copy) {
            return;
        }
        let Some(opener) = self.lock().opener.clone() else { return };
        let host = self.clone();
        let offer = tokio::spawn(async move {
            // `.catch(() => {})`: a chat that cannot be opened shows nothing.
            if opener.open(&copy.session_id).await.is_ok() && host.still(&current, &copy) {
                host.offer_to(&copy);
            }
        });
        #[cfg(feature = "test-support")]
        self.deferred.lock().unwrap().push(offer);
        #[cfg(not(feature = "test-support"))]
        drop(offer);
    }
}

/// What must still hold for a deferred offer.
#[derive(Clone, Copy)]
enum Current {
    Plain { serial: u64 },
    Copy { asked_serial: u64, serial: u64 },
}

/// The handle `register_queue` returns.
pub struct QueueHandle {
    queue: Arc<dyn ApprovalQueue>,
}

fn chats_of(registry: &Registry, session_id: &str) -> Vec<(String, String)> {
    let mut chats: Vec<(String, String)> = Vec::new();
    for handoff in registry.handoffs.iter().filter(|handoff| handoff.session_id == session_id) {
        chats.retain(|(chat, _)| *chat != handoff.surface_session_id);
        chats.push((handoff.surface_session_id.clone(), handoff.title.clone()));
    }
    chats
}

/// `pending.set(id, …)`: a known id keeps its place.
fn put_pending(registry: &mut Registry, entry: Pending) {
    match registry.pending.iter().position(|held| held.asked.id == entry.asked.id) {
        Some(at) => registry.pending[at] = entry,
        None => registry.pending.push(entry),
    }
}

/// `syncHandoffCopies`: bring each pending request of `session_id` that hand-offs reach to exactly
/// the chats now handing it work: a new chat gets its copy, a chat whose hand-offs all ended loses
/// only its own.
fn sync_copies(registry: &mut Registry, session_id: &str) -> Vec<Step> {
    let chats = chats_of(registry, session_id);
    let mut serial = registry.serial;
    let mut steps = Vec::new();
    for held in &mut registry.pending {
        let Some((copy_for, copies)) = &mut held.handoff else { continue };
        if held.asked.session_id != session_id {
            continue;
        }
        let mut kept = Vec::new();
        for (chat, copy, copy_serial) in std::mem::take(copies) {
            if chats.iter().any(|(held_chat, _)| *held_chat == chat) {
                kept.push((chat, copy, copy_serial));
            } else {
                steps.push(Step::Withdraw { chat, id: copy.id });
            }
        }
        *copies = kept;
        for (chat, title) in &chats {
            if copies.iter().any(|(held_chat, _, _)| held_chat == chat) {
                continue;
            }
            serial += 1;
            let copy = Delegated { id: held.asked.id.clone(), session_id: chat.clone(), request: copy_for(chat, title), answer: held.asked.answer.clone() };
            copies.push((chat.clone(), copy.clone(), serial));
            steps.push(Step::Deliver { copy, serial, asked_serial: held.serial });
        }
    }
    registry.serial = serial;
    steps
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn watch(run: &str, task: &str, home: &str) -> Value {
        json!({ "runId": run, "taskSessionId": task, "homeSessionId": home })
    }

    #[tokio::test]
    async fn an_ended_hand_off_is_forgotten_with_the_task_session_whichever_order_its_end_and_note_come_in() {
        let host = DelegatedApprovalHost::new();
        let handoffs = HostHandoffs::new(host.clone());
        // Ended after it was noted.
        let (a, b) = (watch("run-a", "task-1", "chat-a"), watch("run-b", "task-2", "chat-b"));
        host.note_handoff(&a);
        host.note_handoff(&b);
        handoffs.end_watch(&a);
        handoffs.end_watch(&b);
        // Ended before it was ever noted.
        let early = watch("run-c", "task-3", "chat-c");
        handoffs.end_watch(&early);
        assert_eq!(host.ended_held(), 3);

        host.session_ended("task-1");
        host.session_ended("task-3");
        assert_eq!(host.ended_held(), 1);

        host.note_handoff(&b);
        assert!(host.handoff_chats_of("task-2").is_empty(), "an ended hand-off of a session that is still there is not noted again");

        // A note that follows an end that named no task learns it.
        host.end_handoff("run-d");
        host.note_handoff(&watch("run-d", "task-4", "chat-d"));
        host.session_ended("task-4");
        assert_eq!(host.ended_held(), 1);
    }
}
