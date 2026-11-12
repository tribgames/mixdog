//! The tool batch of one assistant turn: the serial decision of what each call
//! is (a guard's answer, a cached body, or a run), concurrent execution, the
//! in-order recording that feeds the next decision, and the ordered commit.
//!
//! Decisions and recording are serial in call order, exactly as the model
//! issued the calls: a guard sees every earlier call's recorded outcome. A
//! decision waits for earlier outcomes only when they could change it, so
//! independent calls still run together. Read-only calls may start while the
//! provider is still streaming ([`Run::try_eager`]).

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use futures::StreamExt;
use futures::stream::FuturesUnordered;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_rt::TaskClass;

use mixdog_core_api::domain::tool::ToolOutput;

use crate::env::GateCall;
use crate::env::RunEvent;
use crate::env::or_cancelled;
use crate::limits;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::native_search::parse_native_tool_search;
use crate::message::ToolKind;
use crate::run::AgentError;
use crate::run::Run;
use crate::tools::CallEnv;
use crate::tools::CallFuture;
use crate::tools::ToolSet;
use crate::tools::Executed;
use crate::tools::Projection;
use crate::barriers::is_mutation;
use crate::tools::arg_shape;
use crate::tools::call_signature;
use crate::tools::execute_call;
use crate::tools::failure_signature;
use crate::tools::intra_turn_duplicates;

const CROSS_TURN_CAP: usize = 500;
/// Tools that are not edits or progress even though they are not read-only.
const NON_PROGRESS_TOOLS: [&str; 9] = [
    "Skill", "recall", "agent", "task", "cwd", "session", "load_tool", "tool_search", "todo",
];

/// A call started while the response streams.
pub(crate) struct EagerStarted {
    id: String,
    read_only: bool,
}

struct Receipt {
    count: u32,
    first_iteration: u32,
    tool_use_id: String,
}

/// Cross-turn identical read-only call receipts: signature → where the body
/// was delivered. Insertion-ordered; the oldest is dropped past the cap.
#[derive(Default)]
pub(crate) struct CrossTurn {
    entries: Vec<(String, Receipt)>,
    pub(crate) stub_total: u32,
    pub(crate) edit_count: u32,
}

impl CrossTurn {
    fn find(&mut self, sig: &str) -> Option<&mut Receipt> {
        self.entries.iter_mut().find(|(s, _)| s == sig).map(|(_, r)| r)
    }

    fn remove(&mut self, sig: &str) {
        self.entries.retain(|(s, _)| s != sig);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    fn has(&self, sig: &str) -> bool {
        self.entries.iter().any(|(s, _)| s == sig)
    }
}

/// A successfully executed tool that represents real edit or progress.
/// A result a tool marked partial (`meta.complete == false`: a federated
/// section failed or a cap cut the scan) must never be reused; a tool that says
/// nothing is whole.
fn output_is_complete(output: &ToolOutput) -> bool {
    output
        .meta
        .as_ref()
        .and_then(|meta| meta.get("complete"))
        .and_then(|complete| complete.as_bool())
        .unwrap_or(true)
}

/// The `meta` object a tool left for the call's trace row under `key` (Node's `resultTelemetry` / `localSearchTelemetry`).
fn output_meta(output: Option<&ToolOutput>, key: &str) -> Option<serde_json::Value> {
    output?.meta.as_ref()?.get(key).cloned()
}

fn is_edit_progress(name: &str, read_only: bool) -> bool {
    if read_only {
        return false;
    }
    let bare = if name.starts_with("mcp__") {
        name.rsplit("__").next().unwrap_or(name)
    } else {
        name
    };
    if matches!(bare, "apply_patch" | "shell" | "bash" | "bash_session") {
        return true;
    }
    !NON_PROGRESS_TOOLS.contains(&bare)
}

fn dedup_stub(name: &str, first_iteration: u32, stuck: bool) -> String {
    let mut s = format!(
        "[cross-turn-dedup] `{name}` already ran in iteration {first_iteration}; result unchanged, already in context."
    );
    if stuck {
        s.push_str(" No new evidence; use the existing result or report it unresolved.");
    }
    s
}

pub(crate) type EditGroup = Arc<Mutex<(u32, u32)>>;

/// A streamed edit's group retry (`retryAmbiguousEdit`) and its place at the file lock. Node's retry reaches the lock once the
/// batch is at the call (every call before it collected) and the streamed run has settled as ambiguous, whichever comes later:
/// the same-file edit that settlement lets go (`barriers.mjs:96`) reaches the lock first, unless the batch was already waiting
/// for the call, whose resumption is queued ahead of that edit's barrier.
pub(crate) struct Settle {
    /// The call's file (`None`: not an edit, or one that names no file).
    key: Option<String>,
    locks: crate::barriers::EditLocks,
    /// The batch is at the call and its group has occurrences left.
    retry_due: bool,
    /// The streamed run settled as an ambiguous edit.
    ambiguous: bool,
    /// The retry's place at the lock, once it reached it.
    turn: Option<crate::barriers::EditTurn>,
}

pub(crate) type SettleSlot = Arc<Mutex<Settle>>;

impl Settle {
    fn reach_lock(&mut self, st: &mut crate::barriers::LockState) {
        if self.retry_due
            && self.ambiguous
            && self.turn.is_none()
            && let Some(key) = &self.key
        {
            self.turn = Some(st.take(key));
        }
    }
}

/// `settle_gate`: Node acts on a streamed edit's ambiguous settlement in a later turn of its event loop than every response
/// byte already received, so the settlement finds the batch at the call when the response ended in those bytes, and lets
/// the edits behind it go first when the response is still waiting for more. The core's run settles on another thread at
/// any instant; it waits until the stream is waiting for bytes it has not received (open) or, once the response is
/// complete, until the batch has taken its place at its first call (open again).
///
/// Settles a streamed call when its task ends, by finishing or by being dropped (a cancel, a panic), before its barrier
/// lets the calls behind it go.
struct Settler {
    id: String,
    slot: SettleSlot,
    /// The run settled as an ambiguous edit.
    ambiguous: bool,
    finished: tokio::sync::watch::Sender<bool>,
}

impl Drop for Settler {
    fn drop(&mut self) {
        {
            let mut s = self.slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            s.ambiguous = self.ambiguous;
            let locks = s.locks.clone();
            // The retry's place (when the batch already waits for the call) and the places of the edits the barrier is about
            // to let go are taken here, in one step, before `finished` wakes them (`EditLocks::settle`).
            locks.settle(&self.id, |st| s.reach_lock(st));
        }
        self.finished.send_replace(true);
    }
}

/// The batch answered the call without its run: no retry is due, and a place the retry took is given up.
fn passed(slots: &HashMap<String, SettleSlot>, id: &str) {
    if let Some(slot) = slots.get(id) {
        let mut s = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        s.retry_due = false;
        s.turn = None;
    }
}

/// One assistant turn issuing N `edit` calls with the same file and
/// `old_string` (not replace-all) and N distinct `new_string`s is
/// unambiguous as a whole: the k-th call takes the k-th occurrence. Members
/// run in order; an ambiguity-rejected member re-runs once with the remaining
/// count.
pub(crate) fn edit_groups(calls: &[ToolCall]) -> HashMap<String, EditGroup> {
    let mut counts: HashMap<String, (u32, HashSet<String>)> = HashMap::new();
    for call in calls.iter().filter(|c| c.name == "edit") {
        let Some(a) = call.arguments.as_object() else {
            continue;
        };
        let (Some(file), Some(old)) = (
            a.get("file_path").and_then(|v| v.as_str()),
            a.get("old_string").and_then(|v| v.as_str()),
        ) else {
            continue;
        };
        let replace_all = match a.get("replace_all") {
            Some(v) => v.as_bool() == Some(true) || v.to_string().trim_matches('"').eq_ignore_ascii_case("true"),
            None => false,
        };
        if old.is_empty() || replace_all {
            continue;
        }
        let entry = counts.entry(format!("{file}\u{0}{old}")).or_default();
        entry.0 += 1;
        entry.1.insert(a.get("new_string").and_then(|v| v.as_str()).unwrap_or("").to_owned());
    }
    counts
        .into_iter()
        .filter(|(_, (total, news))| *total >= 2 && news.len() as u32 == *total)
        .map(|(key, (total, _))| (key, Arc::new(Mutex::new((total, 0)))))
        .collect()
}

fn edit_key(call: &ToolCall) -> Option<String> {
    if call.name != "edit" {
        return None;
    }
    let a = call.arguments.as_object()?;
    Some(format!(
        "{}\u{0}{}",
        a.get("file_path")?.as_str()?,
        a.get("old_string")?.as_str()?
    ))
}

async fn run_one(call: ToolCall, env: Arc<CallEnv>, group: Option<EditGroup>) -> Executed {
    let executed = execute_call(call.clone(), Arc::clone(&env)).await;
    retry_in_group(call, env, group, executed).await
}

/// `retryAmbiguousEdit` (`tool-batch/execute-call.mjs:229`): run after a call's result is in, whether it ran in the batch or
/// streamed ahead of it (`executeToolCall` calls it after `executeLive` either way).
pub(crate) async fn retry_in_group(call: ToolCall, env: Arc<CallEnv>, group: Option<EditGroup>, mut executed: Executed) -> Executed {
    let Some(group) = group else {
        return executed;
    };
    let remaining = {
        let g = group.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        g.0.saturating_sub(g.1)
    };
    if remaining >= 1 && executed.conflict {
        let occurrence = (remaining >= 2).then_some(mixdog_core_api::domain::tool::EditOccurrence { expected: remaining });
        let rerun = crate::tools::execute_call_occupying(call, env, occurrence).await;
        // Node traces every run, the retry whether it succeeded or not (`rerunAmbiguousEdit`'s `finally`).
        let intervals: Vec<(i64, i64)> = executed.intervals().into_iter().chain(rerun.intervals()).collect();
        if !rerun.failed {
            // Node keeps the first run's start and takes the retry's end.
            let span = executed.tool_ms + rerun.tool_ms;
            executed = rerun;
            executed.tool_ms = span;
        }
        executed.execution_intervals = intervals;
    }
    if !executed.failed {
        group.lock().unwrap_or_else(std::sync::PoisonError::into_inner).1 += 1;
    }
    executed
}

/// `getToolKind(name)` (`session/loop/tool-helpers.mjs`): the skill tools, then `apply_patch` / `code_graph`
/// (builtin), the `mcp__` prefix, a tool the session runs that is not a builtin (an internal tool: Node's scope
/// provider registers the deferred tools too, so one reached through the registry, as `browser`, is internal), else builtin.
fn trace_tool_kind(tools: &ToolSet, name: &str) -> &'static str {
    if matches!(name, "Skill" | "skills_list" | "skill_view") {
        "skill"
    } else if matches!(name, "apply_patch" | "code_graph") {
        "builtin"
    } else if name.starts_with("mcp__") {
        "mcp"
    } else if tools.resolve(name).is_some() && !tools.builtin_names().contains(&name) {
        "internal"
    } else {
        "builtin"
    }
}

#[allow(clippy::large_enum_variant)]
enum Decision {
    Skip(AgentMessage),
    Run,
}

/// `isSingleCallPerTurnTool` (`session/loop/tool-helpers.mjs:55`): of these only the first call of an
/// assistant turn runs. A constant of the loop, not a setting.
pub(crate) fn is_single_call_per_turn_tool(name: &str) -> bool {
    name == "computer"
}
impl Run {
    /// The batch is at `call` (`executeBatchCall`): its group retry is due if its group has occurrences left.
    pub(crate) fn reach_call(&self, call: &ToolCall, groups: &HashMap<String, EditGroup>) {
        if let Some(slot) = self.eager_settles.get(&call.id) {
            let due = edit_key(call).and_then(|k| groups.get(&k)).is_some_and(|g| {
                let g = g.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                g.0 > g.1
            });
            let mut s = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            s.retry_due = due;
            let locks = s.locks.clone();
            locks.with(|st| s.reach_lock(st));
        }
    }

    pub(crate) fn call_env(&self) -> Arc<CallEnv> {
        Arc::new(CallEnv {
            tools: self.tools.clone(),
            gate: Arc::clone(&self.env.gate),
            hooks: self.env.hooks.clone(),
            observer: Arc::clone(&self.env.observer),
            guards: Arc::clone(&self.env.guards),
            tool_env: self.tool_env.clone(),
            cancel: self.cancel.clone(),
            signal: self.config.signal.clone().unwrap_or_else(|| crate::cancel::Cancel::from_token(&self.cancel)),
            clock: Arc::clone(&self.env.clock),
            mcp: self.env.mcp.clone(),
            prepared: false,
        })
    }

    fn requires_read_body(&self, name: &str) -> bool {
        self.config.read_body_required && name == "read"
    }

    /// Starts a read-only call the moment the provider streams it, when
    /// nothing in the batch could answer it differently: no limit, no guard
    /// near firing, no duplicate, receipt or cached body. A call that did not
    /// start here is decided by the serial batch.
    pub(crate) async fn try_eager(&mut self, call: &ToolCall) {
        if self.turn_limit_noticed
            || self.config.limits.is_some_and(|l| l.max_tool_calls.is_some() || l.wrap_up_at_ms.is_some())
            || call.id.is_empty()
            || self.eager_started.iter().any(|e| e.id == call.id)
        {
            return;
        }
        let canonical = ToolCall { name: self.tools.canonical(&call.name), ..call.clone() };
        // A call whose arguments did not parse is not projected (it names no target).
        let invalid_args = crate::tools::is_invalid_args_marker(&call.arguments);
        // A streamed `call_tool` is admitted, ordered and run as its target; one that names no tool is
        // answered by the serial batch.
        let (exec, bridged) = if invalid_args {
            (canonical, false)
        } else {
            match self.tools.project(&self.tool_env.thread_id, &canonical) {
                Projection::Plain => (canonical, false),
                Projection::Target(target) => (target, true),
                Projection::Refused(_) => return,
            }
        };
        let name = exec.name.clone();
        // The single-call slot is taken before anything can refuse the call (`admit`, `admission.mjs:55`): an invalid
        // first `computer` call still leaves no slot for a later one.
        if is_single_call_per_turn_tool(&name) {
            match self.eager_single.get(&name) {
                Some(first) if *first != call.id => return,
                Some(_) => {}
                None => {
                    self.eager_single.insert(name.clone(), call.id.clone());
                }
            }
        }
        // Never admitted for an eager run (`admit`): the batch answers it with the retry notice.
        if invalid_args {
            return;
        }
        let gate_call = GateCall::new(name.clone(), exec.arguments.clone());
        if self.env.gate.pre_dispatch_deny(&gate_call).is_some() || self.carry.repeat.could_fire(0) {
            return;
        }
        // Admission classifies a call by the session's tool list plus the definitions of bridged targets
        // (`bridgeClassificationTools`, `tool-call-resolution.mjs:90`): a deferred tool called by its name is not on it.
        let dedup = self.tools.dedup_eligible(&name) && (bridged || self.tools.get(&name).is_some());
        if dedup {
            let sig = call_signature(&name, &exec.arguments);
            if !self.eager_sigs.insert(sig.clone()) {
                return;
            }
            if let Some(reuse) = self.env.reuse.clone()
                && reuse.lookup(&exec, false).await.is_some()
            {
                return;
            }
        }
        let mut env = self.call_env();
        let id = call.id.clone();
        let (observer, early_id) = (Arc::clone(&self.env.observer), id.clone());
        // Every executable call starts as it streams, a write, an MCP call or one that asks for approval included
        // (`isParallelDispatchable`, `loop/tool-helpers.mjs:52`); a call that one of Node's barriers holds back
        // waits for the calls it depends on (`eager-dispatch/barriers.mjs`).
        let cwd = self.tool_env.cwd.as_path().to_path_buf();
        let preceding = self.barriers.preceding_for(&name, &exec.arguments, &cwd);
        // A call with nothing to wait for reaches `prepareToolCall`'s refresh before the stream goes on (Node runs it in
        // the eager start's own microtasks, `call-prep.mjs:70`), so the tool phase projects the batch against the
        // snapshot that refresh left.
        if preceding.none()
            && let Some(mcp) = &self.env.mcp
            && crate::env::or_cancelled(&self.cancel, mcp.refresh()).await.is_some()
        {
            Arc::get_mut(&mut env).expect("a call's own environment").prepared = true;
        }
        let (finished, done) = tokio::sync::watch::channel(false);
        let key = crate::barriers::is_edit(&name).then(|| crate::barriers::edit_path_key(&exec.arguments, &cwd)).flatten();
        let locks = self.barriers.locks.clone();
        let slot: SettleSlot = Arc::new(Mutex::new(Settle {
            key: key.clone(),
            locks: locks.clone(),
            retry_due: false,
            ambiguous: false,
            turn: None,
        }));
        self.eager_settles.insert(id.clone(), Arc::clone(&slot));
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.barriers.register(&id, &name, &exec.arguments, &cwd, done, failed.clone());
        // An edit reaches its file's lock the moment its barriers let it go (`withEditTargetLock`): its place is taken by the
        // settlement that lets it go, not when its task is next polled.
        let place = key.as_deref().map(|key| locks.enqueue(key, preceding.ids()));
        let mut settler = Settler { id: id.clone(), slot, ambiguous: false, finished };
        let mut gate = self.settle_gate.subscribe();
        let handle = mixdog_rt::spawn("agent.eager", TaskClass::Work, async move {
            let dispatch_started_at = env.clock.now_ms();
            let executed = match preceding.wait(&exec.name).await {
                Some(text) => crate::tools::stamp_timing(Executed::skipped(&exec.id, text), dispatch_started_at, env.clock.as_ref()),
                None => {
                    #[cfg(feature = "test-support")]
                    if let Some(key) = &key {
                        crate::test_hooks::edit_start(key, &exec.id).await;
                    }
                    let mut turn = place.map(|place| {
                        place.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take().expect("the settlement that let the edit go handed it its place")
                    });
                    if let Some(turn) = &mut turn {
                        turn.ready().await;
                    }
                    execute_call(exec, env).await
                }
            };
            if executed.conflict {
                #[cfg(feature = "test-support")]
                if let Some(key) = &key {
                    crate::test_hooks::at_gate(key, &early_id, *gate.borrow());
                }
                // A closed gate: the run is gone, and nothing waits for the order.
                let _ = gate.wait_for(|open| *open).await;
            }
            failed.store(executed.failed, std::sync::atomic::Ordering::Release);
            // The instant this streamed call settles, whatever consumes it later (call order) or nothing does.
            observer.event(RunEvent::EarlyResult(early_result(&early_id, &executed)));
            settler.ambiguous = executed.conflict;
            drop(settler);
            executed
        });
        self.eager_started.push(EagerStarted { id: id.clone(), read_only: self.tools.read_only(&name) });
        self.eager.insert(id, handle);
    }

    /// Eager results of a dead attempt are dropped before the next attempt. A read is wound down; a write that started
    /// is not stopped, as Node leaves it (its cancel token ends it with the run).
    pub(crate) fn drop_eager(&mut self) {
        self.settle_gate.send_replace(true);
        for (id, handle) in self.eager.drain() {
            if self.eager_started.iter().any(|e| e.id == id && e.read_only) {
                handle.abort();
            }
        }
        self.eager_settles.clear();
        self.eager_sigs.clear();
        self.eager_started.clear();
        self.barriers.clear();
        self.eager_single.clear();
        self.streamed_ids.clear();
    }

    /// The batch is over, or its turn was cancelled. A started call no listed call consumed (the provider ran a
    /// text-recovered call and then returned the native call that repeats it, or the cancel ended the batch first) is
    /// left to finish and tell the host it settled: Node stops none of them (a call waiting for its hook, its approval or
    /// a barrier ends itself with the abort's text, `execute_gated`), and its result is never stored.
    fn release_eager(&mut self) {
        self.settle_gate.send_replace(true);
        self.eager.clear();
        self.eager_settles.clear();
        self.eager_sigs.clear();
        self.eager_started.clear();
        self.barriers.clear();
        self.eager_single.clear();
        self.streamed_ids.clear();
    }

    /// Whether the stream of the request in flight handed this complete call over (Node's `relayWitness.dispatchedToolCallIds`,
    /// `send-instrumentation.mjs:146`: every call given to `onToolCall`, admitted for an eager run or not).
    pub(crate) fn stream_dispatched(&self, id: &str) -> bool {
        self.streamed_ids.contains(id)
    }

    /// What one call is, in Node's order: surface denial, one-per-turn tools,
    /// intra-turn twin, cross-turn receipt, repeat-failure guards.
    #[allow(clippy::too_many_arguments)]
    async fn decide(
        &mut self,
        call: &ToolCall,
        dup_of: Option<&String>,
        single_of: Option<&String>,
        ct_sig: Option<&str>,
        sig: &str,
        shape_sig: &str,
        unprojected: Option<&String>,
    ) -> Decision {
        // A `call_tool` that names no tool answers its wire id with the bridge error; it never meets a guard.
        if let Some(text) = unprojected {
            return Decision::Skip(AgentMessage::tool_text(&call.id, text.clone(), ToolKind::Error));
        }
        if crate::tools::is_invalid_args_marker(&call.arguments) {
            return Decision::Run;
        }
        let gate_call = GateCall::new(call.name.clone(), call.arguments.clone());
        if let Some(text) = self.env.gate.pre_dispatch_deny(&gate_call) {
            return Decision::Skip(AgentMessage::tool_text(&call.id, text, ToolKind::Error));
        }
        if let Some(first) = single_of {
            return Decision::Skip(AgentMessage::tool_text(
                &call.id,
                format!(
                    "[computer-call-cardinality] Only the first Computer Use call in an assistant turn is executed (tool_use_id={first}). This call was not executed. Inspect the first call's fresh result, then issue at most one next computer call; use sequence only for a deterministic same-window focus chain."
                ),
                ToolKind::Error,
            ));
        }
        if let Some(why) = self.dropped_tools.get(&call.name) {
            return Decision::Skip(AgentMessage::tool_text(&call.id, format!("Error: {why}"), ToolKind::Error));
        }
        let body_required = self.requires_read_body(&call.name);
        if let Some(first) = dup_of
            && !body_required
        {
            return Decision::Skip(AgentMessage::tool_text(
                &call.id,
                format!(
                    "[intra-turn-dedup] identical read-only `{}` call was already executed in this same assistant turn as tool_use_id={first}. The first call's tool_result is in context immediately above; skipping re-execution to save tokens. If you needed a different slice of the file, narrow the next call (different path / offset / limit / pattern) so it has a distinct signature.",
                    call.name
                ),
                ToolKind::Skipped,
            ));
        }
        if let Some(ct) = ct_sig
            && !body_required
            && let Some(stub) = self.cross_turn_stub(call, ct).await
        {
            return Decision::Skip(AgentMessage::tool_text(&call.id, stub, ToolKind::Skipped));
        }
        match self.carry.repeat.skip(&call.name, sig, shape_sig) {
            Some(text) => Decision::Skip(AgentMessage::tool_text(&call.id, text, ToolKind::Error)),
            None => Decision::Run,
        }
    }

    /// A receipt is only an in-context receipt, not a freshness proof:
    /// reference it only while the same cached body remains reusable.
    async fn cross_turn_stub(&mut self, call: &ToolCall, ct_sig: &str) -> Option<String> {
        let iterations = self.iterations;
        let (first_iteration, tool_use_id) = {
            let prior = self.cross_turn.find(ct_sig)?;
            if prior.first_iteration >= iterations {
                return None;
            }
            (prior.first_iteration, prior.tool_use_id.clone())
        };
        let hit = match self.env.reuse.clone() {
            Some(reuse) => reuse.lookup(call, false).await,
            None => None,
        };
        let valid = hit.is_some_and(|hit| !tool_use_id.is_empty() && hit.first_tool_use_id == tool_use_id);
        if !valid {
            self.cross_turn.remove(ct_sig);
            return None;
        }
        if let Some(prior) = self.cross_turn.find(ct_sig) {
            prior.count += 1;
        }
        self.cross_turn.stub_total += 1;
        Some(dedup_stub(&call.name, first_iteration, self.cross_turn.stub_total >= 5))
    }

    /// Bookkeeping once a call has its result, in call order.
    /// Returns whether the body is a cache candidate (stored after the batch's
    /// budgets, so cache and transcript receive the same body).
    async fn record_executed(&mut self, call: &ToolCall, executed: &Executed, sigs: (String, String), later_mutation: bool) -> bool {
        self.carry
            .repeat
            .record(executed.failed, sigs.0, sigs.1, executed.arg_failure);
        let read_only = self.tools.read_only(&call.name);
        if let Some(reuse) = self.env.reuse.clone() {
            reuse.after_call(call, executed.failed).await;
        }
        // A body that predates a later mutation of the batch is not cached.
        let cacheable = self.env.reuse.is_some()
            && !executed.failed
            && executed.cache_hit.is_none()
            && !later_mutation
            && executed.output.as_ref().is_none_or(output_is_complete)
            && executed.message.tool_kind == Some(ToolKind::Normal);
        if executed.failed {
            return cacheable;
        }
        if self.tools.dedup_eligible(&call.name) {
            let sig = call_signature(&call.name, &call.arguments);
            let tool_use_id = executed.cache_hit.clone().unwrap_or_else(|| call.id.clone());
            let iterations = self.iterations;
            let same = self.cross_turn.find(&sig).is_some_and(|r| r.tool_use_id == tool_use_id);
            if !same {
                self.cross_turn.remove(&sig);
                self.cross_turn.entries.push((
                    sig,
                    Receipt { count: 1, first_iteration: iterations, tool_use_id },
                ));
                if self.cross_turn.entries.len() > CROSS_TURN_CAP {
                    self.cross_turn.entries.remove(0);
                }
            }
        } else if is_edit_progress(&call.name, read_only) {
            self.cross_turn.clear();
            self.cross_turn.edit_count += 1;
        }
        cacheable
    }

    /// The execution view (`resolveExecutionToolCalls`): typo aliases and case variants canonicalized,
    /// and a `call_tool` of a bridge session replaced by its target, so that every layer below sees the
    /// target itself. The wire calls stay what the transcript holds. Also, per call, whether it was
    /// bridged and the refusal of a `call_tool` that names no usable target.
    pub(crate) fn execution_view(&self, wire_calls: &[ToolCall]) -> (Vec<ToolCall>, Vec<bool>, Vec<Option<String>>) {
        let n = wire_calls.len();
        let mut unprojected: Vec<Option<String>> = vec![None; n];
        let mut bridged = vec![false; n];
        let mut calls: Vec<ToolCall> = Vec::with_capacity(n);
        for (index, wire) in wire_calls.iter().enumerate() {
            let canonical = ToolCall { name: self.tools.canonical(&wire.name), ..wire.clone() };
            calls.push(match self.tools.project(&self.tool_env.thread_id, &canonical) {
                Projection::Plain => canonical,
                Projection::Target(target) => {
                    bridged[index] = true;
                    target
                }
                Projection::Refused(text) => {
                    unprojected[index] = Some(text);
                    canonical
                }
            });
        }
        (calls, bridged, unprojected)
    }

    pub(crate) async fn process_tool_batch(&mut self, wire_calls: &[ToolCall], allowed: u64) -> Result<(), AgentError> {
        let n = wire_calls.len();
        let (calls, bridged, unprojected) = self.execution_view(wire_calls);
        let dups = intra_turn_duplicates(&calls, &self.tools);
        let mut single_first: HashMap<String, String> = HashMap::new();
        let mut single_of: Vec<Option<String>> = vec![None; n];
        for (i, c) in calls.iter().enumerate() {
            if c.id.is_empty() || !is_single_call_per_turn_tool(&c.name) {
                continue;
            }
            match single_first.get(&c.name) {
                None => {
                    single_first.insert(c.name.clone(), c.id.clone());
                }
                Some(first) => single_of[i] = Some(first.clone()),
            }
        }
        let groups = edit_groups(&calls);
        let wrap_up = self.turn_limits().and_then(|l| l.wrap_up_at_ms);
        let cwd = self.tool_env.cwd.as_path().to_path_buf();

        let mut staged: Vec<Option<AgentMessage>> = vec![None; n];
        let mut executed: Vec<Option<Executed>> = (0..n).map(|_| None).collect();
        let mut sigs: Vec<(String, String)> = vec![(String::new(), String::new()); n];
        let mut evaluated = vec![false; n];
        let mut finished = vec![false; n];
        let mut started = vec![false; n];
        // Calls answered without a run (a denial, a stub, a guard, a refused call_tool): Node records no mutation for them,
        // so a read streamed ahead of one stays usable.
        let mut skipped = vec![false; n];
        let mut ready: Vec<bool> = vec![false; n];
        let mut recorded = 0usize;
        let mut was_executed = vec![false; n];
        let mut tool_ms = vec![0i64; n];
        let mut intervals: Vec<Vec<(i64, i64)>> = vec![Vec::new(); n];
        let mut cacheable = vec![false; n];
        let mut outputs: Vec<Option<ToolOutput>> = (0..n).map(|_| None).collect();
        let mut follow_ups: Vec<AgentMessage> = Vec::new();
        let env = self.call_env();
        let mut running: FuturesUnordered<CallFuture> = FuturesUnordered::new();
        // The calls whose streamed run already told the host (`EarlyResult`); the rest tell it as they settle.
        let mut streamed: HashSet<usize> = HashSet::new();
        let mut aborted = false;
        // The call Node's serial loop is at: every call before it is collected.
        let (reach_tx, reach_rx) = tokio::sync::watch::channel(0usize);
        let mut reached: Option<usize> = None;

        loop {
            // 1. Decide, in call order.
            for j in 0..n {
                if evaluated[j] {
                    continue;
                }
                let call = &calls[j];
                if (j as u64) >= allowed || wrap_up.is_some_and(|at| self.env.clock.now_ms() >= at) {
                    staged[j] = Some(limits::refusal(&call.id));
                    passed(&self.eager_settles, &call.id);
                    evaluated[j] = true;
                    finished[j] = true;
                    continue;
                }
                let sig = failure_signature(&call.name, &call.arguments, &cwd);
                let shape_sig = format!("{}:{}", call.name, arg_shape(&call.arguments));
                let ct_sig = self
                    .tools
                    .dedup_eligible(&call.name)
                    .then(|| call_signature(&call.name, &call.arguments));
                // Earlier outcomes not recorded yet could change this decision.
                let unrecorded = j - recorded;
                let mutation_pending = (recorded..j)
                    .any(|i| !self.tools.read_only(&calls[i].name))
                    && ct_sig.as_deref().is_some_and(|s| self.cross_turn.has(s));
                if unrecorded > 0 && (self.carry.repeat.could_fire(unrecorded) || mutation_pending) {
                    break;
                }
                evaluated[j] = true;
                match self.decide(call, dups.get(&j), single_of[j].as_ref(), ct_sig.as_deref(), &sig, &shape_sig, unprojected[j].as_ref()).await {
                    Decision::Skip(message) => {
                        staged[j] = Some(message);
                        passed(&self.eager_settles, &call.id);
                        finished[j] = true;
                        skipped[j] = true;
                    }
                    Decision::Run => {
                        sigs[j] = (sig, shape_sig);
                        ready[j] = true;
                    }
                }
            }
            // 2. Record finished outcomes in call order.
            while recorded < n && finished[recorded] {
                if let Some(mut result) = executed[recorded].take() {
                    let later_mutation = (recorded + 1..n).any(|k| !self.tools.read_only(&calls[k].name));
                    let sig_pair = std::mem::take(&mut sigs[recorded]);
                    cacheable[recorded] =
                        self.record_executed(&calls[recorded], &result, sig_pair, later_mutation).await;
                    outputs[recorded] = result.output.take();
                    was_executed[recorded] = true;
                    tool_ms[recorded] = result.tool_ms;
                    intervals[recorded] = result.intervals();
                    follow_ups.extend(result.follow_ups.iter().cloned());
                    staged[recorded] = Some(result.message);
                }
                recorded += 1;
            }
            if recorded == n {
                break;
            }
            if evaluated[recorded] && !finished[recorded] && reached != Some(recorded) {
                reached = Some(recorded);
                self.reach_call(&calls[recorded], &groups);
                reach_tx.send_replace(recorded);
            }
            // 3. Start what is ready. The first live call starts the rest of the batch, as a provider that streamed
            // nothing leaves it to the batch (`startEagerRun`, `tool-batch/execute-call.mjs:112`): the calls after it do not
            // wait for the guards to learn what the calls before it came to, and run together but for Node's barriers.
            // A call no eager run took (a guard, a cached body, a streamed read thrown away) is run in its turn, once every
            // call before it is done (`executeSerially`).
            for j in 0..n {
                if !ready[j] || started[j] {
                    continue;
                }
                for k in j..n {
                    if !dups.contains_key(&k) {
                        self.try_eager(&wire_calls[k]).await;
                    }
                }
                let call = calls[j].clone();
                // A streamed read is only usable when no earlier call of the batch could have changed what it read.
                // Classified by the session's tools and the definitions of the batch's bridged targets (`bridgeClassificationTools`):
                // a deferred tool called by its name is not on the list, so it is never thrown away.
                let read_only = self.tools.get(&call.name).is_some_and(|t| t.spec().annotations.read_only_hint == Some(true))
                    || (bridged[j] && self.tools.read_only(&call.name));
                let kept = self.eager.contains_key(&call.id)
                    && (!read_only || (0..j).all(|i| skipped[i] || !is_mutation(&calls[i].name, &calls[i].arguments)));
                if !kept && !(0..j).all(|i| finished[i]) {
                    continue;
                }
                started[j] = true;
                let hit = match self.env.reuse.clone() {
                    Some(reuse) => reuse.lookup(&call, true).await,
                    None => None,
                };
                if let Some(hit) = hit {
                    let mut served =
                        Executed::error(&call.id, String::new());
                    served.message = AgentMessage::tool_text(&call.id, hit.content, ToolKind::CacheHit);
                    served.failed = false;
                    served.cache_hit = Some(hit.first_tool_use_id);
                    passed(&self.eager_settles, &call.id);
                    executed[j] = Some(served);
                    finished[j] = true;
                    continue;
                }
                let eager = self.eager.remove(&call.id);
                // A streamed result thrown away is not announced again by its re-run: Node's serial path never notifies.
                if eager.is_some() {
                    streamed.insert(j);
                }
                // A write is never run twice: only a streamed read is thrown away, and only when it may be stale.
                let eager = eager.filter(|_| kept);
                let group = edit_key(&call).and_then(|k| groups.get(&k).cloned());
                if let Some(handle) = eager {
                    streamed.insert(j);
                    let id = call.id.clone();
                    let env = Arc::clone(&env);
                    let slot = self.eager_settles.get(&id).cloned();
                    let mut reach = reach_rx.clone();
                    running.push(Box::pin(async move {
                        let result = handle.await.unwrap_or_else(|_| {
                            Executed::error(&id, "Error: tool task failed".to_owned())
                        });
                        // A group member is collected, and retried at its place at the file lock, once the batch is at it
                        // (`plan.mjs:61-64`, `executeBatchCall`).
                        let mut turn = None;
                        if group.is_some() {
                            let _ = reach.wait_for(|at| *at >= j).await;
                            if let Some(slot) = slot {
                                let mut s = slot.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                                turn = s.turn.take();
                                #[cfg(feature = "test-support")]
                                if let (Some(turn), Some(key)) = (&turn, &s.key) {
                                    crate::test_hooks::retry_queued(key, &id, turn.waits());
                                }
                            }
                        }
                        if let Some(turn) = &mut turn {
                            turn.ready().await;
                        }
                        (j, retry_in_group(call, env, group, result).await)
                    }));
                } else {
                    let env = Arc::clone(&env);
                    running.push(Box::pin(async move { (j, run_one(call, env, group).await) }));
                }
            }
            if running.is_empty() {
                // Everything decided so far was answered without a run; the calls after it are decided next,
                // once the outcomes before them are recorded.
                if (0..n).all(|k| !evaluated[k] || finished[k]) {
                    continue;
                }
                break;
            }
            match or_cancelled(&self.cancel, running.next()).await {
                None => {
                    aborted = true;
                    break;
                }
                Some(None) => break,
                Some(Some((idx, result))) => {
                    // Node starts every executable call through the eager dispatcher, which tells the host the instant
                    // it settles (`notifyEarlyResult`), a failed run included; one early-result path feeds the UI's
                    // live row and the interrupted-turn finalizer. A call decided without a run (stub, cache hit,
                    // refusal) never reaches this arm.
                    // (Node answers an unparsed call in its turn, instantly: `markInstant`, no early notice.)
                    if !streamed.contains(&idx) && !crate::tools::is_invalid_args_marker(&calls[idx].arguments) {
                        self.emit(RunEvent::EarlyResult(early_result(&calls[idx].id, &result)));
                    }
                    executed[idx] = Some(result);
                    finished[idx] = true;
                }
            }
        }
        self.release_eager();
        // A cancelled batch commits nothing: Node checks the abort after each call (`processToolBatch`, `tool-batch.mjs:36`) and throws
        // before `flushBatch`, so the results staged so far never reach the transcript; the host's interruption closes the turn from
        // what the calls told it as they settled (`EarlyResult`). Node awaits the call it was taking before that check, and that call's
        // tool goes on; here the turn ends at once (as Node's turn does, the recording's `turnEnded`) and the calls in flight are left
        // to settle on their own, as the eager runs are (`release_eager`).
        if aborted {
            if !running.is_empty() {
                mixdog_rt::spawn("agent.batch.cancelled", TaskClass::Work, async move { while running.next().await.is_some() {} });
            }
            return Err(AgentError::Aborted);
        }
        drop(running);

        self.finalize_results(&calls, &mut staged, &was_executed, &tool_ms, &mut intervals, &cacheable, &outputs).await;
        // Results commit in the assistant's call order.
        for message in staged.into_iter().flatten() {
            if let (Some(id), Some(kind)) = (message.tool_call_id(), message.tool_kind) {
                self.emit(RunEvent::ToolResult { call_id: id.to_owned(), kind });
            }
            self.push(message).await?;
        }
        for message in follow_ups {
            self.push(message).await?;
        }
        // PostToolBatch: the whole batch resolved; a blocking decision injects
        // its reason as a system note for the next send.
        if let Some(hooks) = self.env.hooks.clone()
            && n > 0
            && let Some(reason) = hooks.after_batch(n).await
        {
            let reason = mixdog_js::js_trim(&reason);
            if !reason.is_empty() {
                self.push(AgentMessage::sourced(
                    Source::Hook,
                    format!("<system-reminder>\n{reason}\n</system-reminder>"),
                ))
                .await?;
            }
        }
        Ok(())
    }

    /// Budgets of the batch's executed results, then the cache writes: the
    /// per-tool and per-message offload, inline-image compaction, and the
    /// reusable bodies handed to the cache exactly as the transcript holds
    /// them.
    async fn finalize_results(
        &mut self,
        calls: &[ToolCall],
        staged: &mut [Option<AgentMessage>],
        executed: &[bool],
        tool_ms: &[i64],
        intervals: &mut [Vec<(i64, i64)>],
        cacheable: &[bool],
        outputs: &[Option<ToolOutput>],
    ) {
        let indices: Vec<usize> = (0..calls.len())
            .filter(|i| executed[*i] && staged[*i].is_some())
            .collect();
        // `classifyExecuted` (`execute-call.mjs:17-20,187-194`): a call that returned text reading as an error (the
        // delegated-agent, skill and MCP tools answer `Error: …` instead of failing) is an error call, decided on the tool's
        // own return before anything below rewrites it; that kind stays the result's through the offload, the failure log,
        // the cache write and the transcript (`finalize.mjs:174-177,238,292`). Only a text return is read: a structured one
        // (parts, an image among them) is normal (`classifyResultKind` of a non-string, result-classification.mjs:75).
        for i in &indices {
            if let Some(m) = staged[*i].as_mut()
                && m.tool_kind == Some(ToolKind::Normal)
                && let Content::Text(text) = &m.message.content
                && crate::result_kind::classify_result_kind(text, &calls[*i].name) == crate::result_kind::ResultKind::Error
            {
                m.tool_kind = Some(ToolKind::Error);
            }
        }
        // A loading tool's native tool-search payload becomes the message's, and its summary the
        // result (`finalizeBatchResults` parses before anything is offloaded or cached).
        for i in &indices {
            if let Some(m) = staged[*i].as_mut()
                && let Content::Text(text) = &m.message.content
                && let Some(native) = parse_native_tool_search(&calls[*i].name, text)
                && let Some(summary) = native.get("summary").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
            {
                m.message.native_tool_search = Some(native);
                m.message.content = Content::Text(summary);
            }
        }
        if let Some(store) = self.env.artifacts.clone() {
            let mut entries: Vec<crate::offload::BatchEntry> = indices
                .iter()
                .filter_map(|i| {
                    let m = staged[*i].as_ref()?;
                    Some(crate::offload::BatchEntry {
                        tool: calls[*i]
                            .name
                            .strip_prefix("mcp__plugin_mixdog_mixdog__")
                            .unwrap_or(&calls[*i].name)
                            .to_owned(),
                        kind: m.tool_kind,
                        content: m.message.content.clone(),
                    })
                })
                .collect();
            crate::offload::offload_batch(store.as_ref(), &mut entries).await;
            for (i, entry) in indices.iter().zip(entries) {
                if let Some(m) = staged[*i].as_mut() {
                    m.message.content = entry.content;
                }
            }
        }
        if let Some(images) = self.env.images.clone() {
            for i in &indices {
                if let Some(m) = staged[*i].as_mut() {
                    m.message.content = crate::offload::compact_images(images.as_ref(), &m.message.content).await;
                }
            }
        }
        // `postProcessCompleted` (`finalize.mjs:170-177`), per call in call order: `traceCompleted` (the call's trace rows and,
        // for an error call, its failure row, on the result the transcript holds) and then `writeCaches` (a normal call's
        // reusable body).
        for i in indices {
            let Some(m) = &staged[i] else {
                continue;
            };
            let error = m.tool_kind == Some(ToolKind::Error);
            if let Some(log) = &self.env.failures {
                log.tool(crate::env::TracedCall {
                    iteration: self.iterations,
                    tool_call_id: calls[i].id.clone(),
                    tool_name: calls[i].name.clone(),
                    tool_kind: trace_tool_kind(&self.tools, &calls[i].name),
                    tool_ms: tool_ms[i],
                    tool_args: calls[i].arguments.clone(),
                    model: self.model.clone(),
                    result_kind: if error { "error" } else { "normal" },
                    result: trace_result(&m.message.content),
                    result_text: trace_text(&m.message.content),
                    timing: m.tool_timing,
                    execution_intervals: std::mem::take(&mut intervals[i]),
                    result_telemetry: output_meta(outputs[i].as_ref(), "resultTelemetry"),
                    local_search: output_meta(outputs[i].as_ref(), "localSearchTelemetry"),
                });
            }
            if !error
                && cacheable[i]
                && let (Some(reuse), Some(output)) = (&self.env.reuse, &outputs[i])
            {
                reuse.store(&calls[i], &m.text(), &calls[i].id, output).await;
            }
        }
    }}

/// `toolTraceText(result)` (agent-trace-format.mjs:360-370), the text a failure row is cut from: a text as it is, a structured
/// result's text parts joined by newlines, its images and other parts left out.
fn trace_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                mixdog_core_api::domain::provider::ContentPart::Text(text, _) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// The result `traceAgentTool` is given: a text as a string, a structured result as its text parts (`{type, text}`; the trace
/// reads nothing else of it).
fn trace_result(content: &Content) -> serde_json::Value {
    match content {
        Content::Text(text) => serde_json::Value::String(text.clone()),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                mixdog_core_api::domain::provider::ContentPart::Text(text, _) => Some(serde_json::json!({ "type": "text", "text": text })),
                _ => None,
            })
            .collect(),
    }
}

/// `notifyEarlyResult` (`eager-dispatch/entry.mjs`): what a call that settled before the stop tells the host. The
/// model-visible text; `error` only when the call threw (`isError: !settled.ok`, the executor's `Err`). A thrown
/// call's text is its `message_for_model`, which already reads `Error: <message>` (Node's `execute-call.mjs` and
/// its early notice both write that form), so nothing is prefixed here. A tool that returned an error outcome, or a
/// gate denial the executor returns as text (`Executed.returned`), is not a thrown call.
pub(crate) fn early_result(call_id: &str, result: &Executed) -> AgentMessage {
    if result.failed && !result.returned {
        let mut early = AgentMessage::tool_text(call_id, result.message.text(), ToolKind::Error);
        early.tool_timing = result.message.tool_timing;
        return early;
    }
    let mut early = AgentMessage::tool_text(call_id, result.message.text(), ToolKind::Normal);
    early.tool_kind = None;
    early.tool_timing = result.message.tool_timing;
    early
}

#[cfg(test)]
mod early_tests {
    use super::*;
    use mixdog_core_api::domain::provider::Content;

    /// The host notice Node's eager entry gave four settled calls (`fixtures/interrupt/early-golden.json`,
    /// `record-early.mjs`): text for a returned value, `Error: <message>` and `isError` only for a thrown call.
    #[test]
    fn a_settled_call_is_noticed_as_nodes_eager_entry_notices_it() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/interrupt/early-golden.json")).unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let name = &case["name"];
            let thrown = case["isError"] == true;
            let text = case["content"].as_str().unwrap();
            let mut executed = if thrown {
                Executed::error("c1", text.to_owned())
            } else {
                Executed::error("c1", String::new())
            };
            if !thrown {
                executed.failed = false;
                executed.message = AgentMessage::tool_result("c1", Content::Text(text.to_owned()), ToolKind::Normal);
            }
            let early = early_result("c1", &executed);
            assert_eq!(early.text(), text, "{name}");
            assert_eq!(early.tool_kind == Some(ToolKind::Error), thrown, "{name}");
            assert_eq!(early.tool_call_id(), Some("c1"), "{name}");
            assert!(!early.text().starts_with("Error: Error: "), "{name}: one prefix");
        }
    }
}