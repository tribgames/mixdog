//! The delegated-approval host (`runtime/shared/delegated-approval-host.mjs`): which chats hand a
//! session work, the copies of that session's requests those chats show, and when each copy is
//! offered or withdrawn. Node keeps the registry on `globalThis`; here one host is built by the
//! composition root and shared (it is also the [`Handoffs`] the report-watch store keeps in step
//! with, see `compose-seams.md`).
//!
//! A request stays ONE request: the asking session's queue owns it and its waiter, the other chats
//! hold copies whose answer is forwarded to that owner, and every copy is withdrawn when the owner
//! settles. Registry calls never run a queue callback under the lock: a queue may call back in.

use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use mixdog_services::bots::delivery::queue::Handoffs;
use serde_json::Value;

#[cfg(test)]
mod tests;

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
    handoff: Option<(CopyFor, Vec<(String, Delegated, u64)>)>,
}

#[derive(Default)]
struct Registry {
    queues: Vec<Arc<dyn ApprovalQueue>>,
    pending: Vec<Pending>,
    opener: Option<Arc<dyn SessionOpener>>,
    handoffs: Vec<Handoff>,
    ended: Vec<String>,
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
            if registry.ended.contains(&run_id) {
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
        let steps = {
            let mut registry = self.lock();
            if !registry.ended.iter().any(|ended| ended == run_id) {
                registry.ended.push(run_id.to_owned());
            }
            let Some(at) = registry.handoffs.iter().position(|held| held.run_id == run_id) else { return };
            let task = registry.handoffs.remove(at).session_id;
            sync_copies(&mut registry, &task)
        };
        self.run(steps);
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
        tokio::spawn(async move {
            // `.catch(() => {})`: a chat that cannot be opened shows nothing.
            if opener.open(&copy.session_id).await.is_ok() && host.still(&current, &copy) {
                host.offer_to(&copy);
            }
        });
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
