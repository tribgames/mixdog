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

use crate::barriers::{invalidates_reuse, is_mutation, uses_result_cache};
use crate::env::GateCall;
use crate::env::ReuseKind;
use crate::env::ReuseWrite;
use crate::env::RunEvent;
use crate::env::or_cancelled;
use crate::limits;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;
use crate::native_search::{NativeDefinitions, parse_native_tool_search};
use crate::run::AgentError;
use crate::run::Run;
use crate::tools::CallEnv;
use crate::tools::CallFuture;
use crate::tools::Executed;
use crate::tools::Projection;
use crate::tools::ToolSet;
use crate::tools::arg_shape;
use crate::tools::call_signature;
use crate::tools::failure_signature;
use crate::tools::intra_turn_duplicates;
use mixdog_core_api::domain::common::AbsPath;

/// A call started while the response streams.
pub(crate) struct EagerStarted {
    id: String,
    read_only: bool,
}

/// A successfully executed tool that represents real edit or progress.
/// A result a tool marked partial (`meta.complete == false`: a federated
/// section failed or a cap cut the scan) must never be reused; a tool that says
/// nothing is whole.
fn output_is_complete(output: &ToolOutput) -> bool {
    output.meta.as_ref().and_then(|meta| meta.get("complete")).and_then(|complete| complete.as_bool()).unwrap_or(true)
}

/// The `meta` object a tool left for the call's trace row under `key`.
fn output_meta(output: Option<&ToolOutput>, key: &str) -> Option<serde_json::Value> {
    output?.meta.as_ref()?.get(key).cloned()
}

pub(crate) type EditGroup = Arc<Mutex<(u32, u32)>>;
/// The result-reuse writes, the outputs and the reuse kinds of a batch's calls, each by call index.
type CacheRefs<'a> = (&'a mut [Option<Box<dyn ReuseWrite>>], &'a [Option<ToolOutput>], &'a [Option<ReuseKind>]);

/// A streamed edit's group retry and its place at the file lock. The retry reaches the lock once the
/// batch is at the call (every call before it collected) and the streamed run has settled as ambiguous, whichever comes later:
/// the same-file edit that settlement lets go reaches the lock first, unless the batch was already waiting
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
        let (Some(file), Some(old)) = (a.get("file_path").and_then(|v| v.as_str()), a.get("old_string").and_then(|v| v.as_str())) else {
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
    Some(format!("{}\u{0}{}", a.get("file_path")?.as_str()?, a.get("old_string")?.as_str()?))
}

async fn run_one(call: ToolCall, env: Arc<CallEnv>, cwd: AbsPath, group: Option<EditGroup>) -> Executed {
    let executed = crate::tools::execute_call_at(call.clone(), Arc::clone(&env), cwd, None).await;
    retry_in_group(call, env, group, executed).await
}

/// The group retry of an ambiguous edit, run after a call's result is in, whether it ran in the batch or
/// streamed ahead of it.
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
        let intervals: Vec<(i64, i64)> = executed.intervals().into_iter().chain(rerun.intervals()).collect();
        if !rerun.failed {
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

/// The trace kind of a tool: the skill tools, then `apply_patch` / `code_graph` (builtin), the `mcp__`
/// prefix, a tool the session runs that is not a builtin (an internal tool, as `browser` reached through
/// the registry), else builtin.
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

/// Of these tools only the first call of an assistant turn runs. A constant of the loop, not a setting.
pub(crate) fn is_single_call_per_turn_tool(name: &str) -> bool {
    name == "computer"
}
impl Run {
    /// The batch is at `call`: its group retry is due if its group has occurrences left.
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
            reuse: self.env.reuse.clone(),
            tools: self.tools.clone(),
            gate: Arc::clone(&self.env.gate),
            hooks: self.env.hooks.clone(),
            observer: Arc::clone(&self.env.observer),
            guards: Arc::clone(&self.env.guards),
            tool_env: self.tool_env.clone(),
            live_cwd: self.config.live_cwd.clone(),
            cancel: self.cancel.clone(),
            signal: self.config.signal.clone().unwrap_or_else(|| crate::cancel::Cancel::from_token(&self.cancel)),
            clock: Arc::clone(&self.env.clock),
            mcp: self.env.mcp.clone(),
            prepared: false,
            native_pdf: self.provider.native_pdf(),
            sees_images: self.config.vision.as_ref().is_none_or(|vision| vision.sees_images(self.provider.id().as_str(), &self.model)),
        })
    }

    /// The session's folder now, else the turn's.
    pub(crate) fn live_cwd(&self) -> AbsPath {
        self.config.live_cwd.as_ref().and_then(|live| live()).unwrap_or_else(|| self.tool_env.cwd.clone())
    }

    fn cwd_now(&self) -> std::path::PathBuf {
        self.live_cwd().as_path().to_path_buf()
    }

    /// The call as it will run (a `call_tool` as its target) when nothing in the batch could answer it
    /// differently: no limit, no guard near firing, no duplicate, receipt or cached body; `None` leaves
    /// it to the serial batch. The single-call slot is taken before anything can refuse the call.
    async fn admit_eager(&mut self, call: &ToolCall, cwd: &AbsPath) -> Option<ToolCall> {
        if self.turn_limit_noticed
            || self.config.limits.is_some_and(|l| l.max_tool_calls.is_some() || l.wrap_up_at_ms.is_some())
            || call.id.is_empty()
            || self.eager_started.iter().any(|e| e.id == call.id)
        {
            return None;
        }
        let canonical = ToolCall { name: self.tools.canonical(&call.name), ..call.clone() };
        let invalid_args = crate::tools::is_invalid_args_marker(&call.arguments);
        let (exec, bridged) = if invalid_args {
            (canonical, false)
        } else {
            match self.tools.project(&self.tool_env.thread_id, &canonical) {
                Projection::Plain => (canonical, false),
                Projection::Target(target) => (target, true),
                Projection::Refused(_) => return None,
            }
        };
        let name = exec.name.clone();
        if is_single_call_per_turn_tool(&name) {
            match self.eager_single.get(&name) {
                Some(first) if *first != call.id => return None,
                Some(_) => {}
                None => {
                    self.eager_single.insert(name.clone(), call.id.clone());
                }
            }
        }
        if invalid_args {
            return None;
        }
        if uses_result_cache(&name) && self.barriers.has_reuse_invalidator() {
            return None;
        }
        let gate_call = GateCall::new(name.clone(), exec.arguments.clone());
        self.env.gate.refresh_policy(&gate_call).await;
        if self.env.gate.pre_dispatch_deny(&gate_call).is_some() || self.carry.repeat.could_fire(0) {
            return None;
        }
        let dedup = self.tools.dedup_eligible(&name) && (bridged || self.tools.get(&name).is_some());
        if dedup {
            let sig = call_signature(&name, &exec.arguments);
            if !self.eager_sigs.insert(sig.clone()) {
                return None;
            }
        }
        if (dedup || uses_result_cache(&name))
            && let Some(reuse) = self.env.reuse.clone()
            && let Some(invocation) = self.tools.reuse_invocation(&exec)
            && reuse.has_candidate(&invocation, cwd.as_path()).await
        {
            return None;
        }
        Some(exec)
    }

    /// Starts a read-only call the moment the provider streams it, when [`Self::admit_eager`] admits it.
    /// A call that did not start here is decided by the serial batch. `cwd` is the session's folder the
    /// caller read for this start: the calls one start takes together are prepared in order from one
    /// read, so a sibling's Project switch landing meanwhile moves none of them.
    pub(crate) async fn try_eager(&mut self, call: &ToolCall, cwd: &AbsPath) {
        let Some(exec) = self.admit_eager(call, cwd).await else { return };
        let name = exec.name.clone();
        let mut env = self.call_env();
        let id = call.id.clone();
        let (observer, early_id) = (Arc::clone(&self.env.observer), id.clone());
        let generation = observer.send_generation();
        let start_cwd = cwd.clone();
        let cwd = cwd.as_path().to_path_buf();
        let preceding = self.barriers.preceding_for(&name, &exec.arguments, &cwd);
        if preceding.none()
            && let Some(mcp) = &self.env.mcp
            && crate::env::or_cancelled(&self.cancel, mcp.refresh()).await.is_some()
        {
            Arc::get_mut(&mut env).expect("a call's own environment").prepared = true;
        }
        let waits = !preceding.ids().is_empty();
        let (finished, done) = tokio::sync::watch::channel(false);
        let key = crate::barriers::is_edit(&name).then(|| crate::barriers::edit_path_key(&exec.arguments, &cwd)).flatten();
        let locks = self.barriers.locks.clone();
        let slot: SettleSlot = Arc::new(Mutex::new(Settle { key: key.clone(), locks: locks.clone(), retry_due: false, ambiguous: false, turn: None }));
        self.eager_settles.insert(id.clone(), Arc::clone(&slot));
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.barriers.register(&id, &name, &exec.arguments, &cwd, done, failed.clone());
        let place = key.as_deref().map(|key| locks.enqueue(key, preceding.ids()));
        let mut settler = Settler { id: id.clone(), slot, ambiguous: false, finished };
        let mut gate = self.settle_gate.subscribe();
        let identity = self.trace_identity();
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
                    let cwd = if waits { env.cwd_now() } else { start_cwd };
                    crate::tools::execute_call_at(exec, env, cwd, None).await
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
            mixdog_rt::turn_trace!("[turn] {identity} phase=tool-finished call={early_id} failed={} tool_ms={}", executed.failed, executed.tool_ms);
            if executed.cache_hit.is_none() {
                observer.early_result_of(generation, early_result(&early_id, &executed));
            }
            settler.ambiguous = executed.conflict;
            drop(settler);
            executed
        });
        self.eager_started.push(EagerStarted { id: id.clone(), read_only: self.tools.read_only(&name) });
        self.eager.insert(id, handle);
    }

    /// Eager results of a dead attempt are dropped before the next attempt. A read is wound down; a write that started
    /// is not stopped (its cancel token ends it with the run).
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
    /// left to finish and tell the host it settled; its result is never stored.
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

    /// Whether the stream of the request in flight handed this complete call over, admitted for an eager run or not.
    pub(crate) fn stream_dispatched(&self, id: &str) -> bool {
        self.streamed_ids.contains(id)
    }

    /// What one call is: surface denial, one-per-turn tools,
    /// intra-turn twin and repeat-failure guards.
    #[allow(clippy::too_many_arguments, reason = "the call's per-turn lookups, each an independent guard input")]
    async fn decide(
        &mut self,
        call: &ToolCall,
        dup_of: Option<&String>,
        single_of: Option<&String>,
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
        self.env.gate.refresh_policy(&gate_call).await;
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
        if let Some(first) = dup_of
            && !uses_result_cache(&call.name)
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
        match self.carry.repeat.skip(&call.name, sig, shape_sig) {
            Some(text) => Decision::Skip(AgentMessage::tool_text(&call.id, text, ToolKind::Error)),
            None => Decision::Run,
        }
    }

    /// A failed executed call keeps its FULL command text in the stored assistant turn, so the model
    /// retries against its own draft and not the compaction marker.
    fn restore_failed_call_body(&mut self, wire_calls: &[ToolCall], call_id: &str) {
        if let Some(assistant) = self.messages.iter_mut().rev().find(|m| m.tool_calls().iter().any(|call| call.id == call_id)) {
            crate::stored_args::restore_call_body(assistant, wire_calls, call_id);
        }
    }

    /// Bookkeeping once a call has its result, in call order.
    /// Returns whether the body is a cache candidate (stored after the batch's
    /// budgets, so cache and transcript receive the same body).
    fn record_executed(&mut self, executed: &Executed, sigs: (String, String), later_mutation: bool) -> bool {
        self.carry.repeat.record(executed.failed, sigs.0, sigs.1, executed.arg_failure);
        // A body that predates a later mutation of the batch is not cached.
        executed.reuse_write.is_some()
            && !executed.failed
            && executed.cache_hit.is_none()
            && !later_mutation
            && executed.output.as_ref().is_none_or(output_is_complete)
            && executed.message.tool_kind == Some(ToolKind::Normal)
            && matches!(&executed.message.message.content, Content::Text(_))
    }

    /// The execution view: typo aliases and case variants canonicalized,
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
        let cwd = self.cwd_now();

        let mut staged: Vec<Option<AgentMessage>> = vec![None; n];
        let mut executed: Vec<Option<Executed>> = (0..n).map(|_| None).collect();
        let mut sigs: Vec<(String, String)> = vec![(String::new(), String::new()); n];
        let mut evaluated = vec![false; n];
        let mut finished = vec![false; n];
        let mut started = vec![false; n];
        let mut skipped = vec![false; n];
        let mut ready: Vec<bool> = vec![false; n];
        let mut recorded = 0usize;
        let mut was_executed = vec![false; n];
        let mut tool_ms = vec![0i64; n];
        let mut intervals: Vec<Vec<(i64, i64)>> = vec![Vec::new(); n];
        let mut writes: Vec<Option<Box<dyn ReuseWrite>>> = (0..n).map(|_| None).collect();
        let mut hits = vec![None; n];
        let mut outputs: Vec<Option<ToolOutput>> = (0..n).map(|_| None).collect();
        let mut follow_ups: Vec<AgentMessage> = Vec::new();
        let env = self.call_env();
        let mut running: FuturesUnordered<CallFuture> = FuturesUnordered::new();
        let mut streamed: HashSet<usize> = HashSet::new();
        let mut aborted = false;
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
                // Earlier outcomes not recorded yet could change this decision.
                let unrecorded = j - recorded;
                if unrecorded > 0 && self.carry.repeat.could_fire(unrecorded) {
                    break;
                }
                evaluated[j] = true;
                match self.decide(call, dups.get(&j), single_of[j].as_ref(), &sig, &shape_sig, unprojected[j].as_ref()).await {
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
                    let later_mutation =
                        (recorded + 1..n).any(|k| !self.tools.read_only(&calls[k].name) || invalidates_reuse(&calls[k].name, &calls[k].arguments));
                    let sig_pair = std::mem::take(&mut sigs[recorded]);
                    if self.record_executed(&result, sig_pair, later_mutation) {
                        writes[recorded] = result.reuse_write.take();
                    }
                    hits[recorded] = result.cache_hit.as_ref().map(|(_, kind)| *kind);
                    if result.failed {
                        self.restore_failed_call_body(wire_calls, &wire_calls[recorded].id);
                    }
                    outputs[recorded] = result.output.take();
                    was_executed[recorded] = true;
                    tool_ms[recorded] = result.tool_ms;
                    if hits[recorded].is_none() {
                        intervals[recorded] = result.intervals();
                    }
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
            // 3. Start what is ready.
            for j in 0..n {
                if !ready[j] || started[j] {
                    continue;
                }
                let started_in = self.live_cwd();
                for (k, wire_call) in wire_calls.iter().enumerate().take(n).skip(j) {
                    if !dups.contains_key(&k) {
                        self.try_eager(wire_call, &started_in).await;
                    }
                }
                let call = calls[j].clone();
                let read_only = self.tools.get(&call.name).is_some_and(|t| t.spec().annotations.read_only_hint == Some(true))
                    || (bridged[j] && self.tools.read_only(&call.name));
                let reuse_candidate = uses_result_cache(&call.name);
                let intervening = (0..j).any(|i| {
                    !skipped[i]
                        && if reuse_candidate {
                            invalidates_reuse(&calls[i].name, &calls[i].arguments)
                        } else {
                            is_mutation(&calls[i].name, &calls[i].arguments)
                        }
                });
                let kept = self.eager.contains_key(&call.id) && (!(read_only || reuse_candidate) || !intervening);
                if !kept && !(0..j).all(|i| finished[i]) {
                    continue;
                }
                started[j] = true;
                let execution_cwd = self.live_cwd();
                let eager = self.eager.remove(&call.id);
                let rerun = eager.is_some();
                if rerun {
                    streamed.insert(j);
                }
                let eager = eager.filter(|_| kept);
                let group = edit_key(&call).and_then(|k| groups.get(&k).cloned());
                if let Some(handle) = eager {
                    streamed.insert(j);
                    let id = call.id.clone();
                    let env = Arc::clone(&env);
                    let slot = self.eager_settles.get(&id).cloned();
                    let mut reach = reach_rx.clone();
                    running.push(Box::pin(async move {
                        let result = handle.await.unwrap_or_else(|_| Executed::error(&id, "Error: tool task failed".to_owned()));
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
                    let announce = !rerun && !crate::tools::is_invalid_args_marker(&call.arguments);
                    if announce {
                        streamed.insert(j);
                    }
                    let (observer, identity, id) = (Arc::clone(&self.env.observer), self.trace_identity(), call.id.clone());
                    let generation = observer.send_generation();
                    let task = mixdog_rt::spawn("agent.call", TaskClass::Work, async move {
                        let executed = run_one(call, env, execution_cwd, group).await;
                        if announce && executed.cache_hit.is_none() {
                            mixdog_rt::turn_trace!("[turn] {identity} phase=tool-finished call={id} failed={} tool_ms={}", executed.failed, executed.tool_ms);
                            observer.early_result_of(generation, early_result(&id, &executed));
                        }
                        executed
                    });
                    let id = calls[j].id.clone();
                    running.push(Box::pin(async move { (j, task.await.unwrap_or_else(|_| Executed::error(&id, "Error: tool task failed".to_owned()))) }));
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
                    if !streamed.contains(&idx) && !crate::tools::is_invalid_args_marker(&calls[idx].arguments) {
                        self.trace(
                            "tool-finished",
                            format_args!("call={} tool={} failed={} tool_ms={}", calls[idx].id, calls[idx].name, result.failed, result.tool_ms),
                        );
                        self.emit(RunEvent::EarlyResult(early_result(&calls[idx].id, &result)));
                    }
                    executed[idx] = Some(result);
                    finished[idx] = true;
                }
            }
        }
        self.release_eager();
        if aborted {
            if !running.is_empty() {
                mixdog_rt::spawn("agent.batch.cancelled", TaskClass::Work, async move { while running.next().await.is_some() {} });
            }
            return Err(AgentError::Aborted);
        }
        drop(running);

        self.finalize_results(&calls, &mut staged, &was_executed, &tool_ms, &mut intervals, (&mut writes, &outputs, &hits)).await;
        for message in staged.into_iter().flatten() {
            if let (Some(id), Some(kind)) = (message.tool_call_id(), message.tool_kind) {
                self.emit(RunEvent::ToolResult { call_id: id.to_owned(), kind });
            }
            self.push(message).await?;
        }
        for message in follow_ups {
            if message.source == Some(Source::Skill) && self.messages.iter().any(|m| m.source == Some(Source::Skill) && m.text() == message.text()) {
                continue;
            }
            self.push(message).await?;
        }
        if let Some(hooks) = self.env.hooks.clone()
            && n > 0
            && let Some(reason) = hooks.after_batch(n).await
        {
            let reason = mixdog_js::js_trim(&reason);
            if !reason.is_empty() {
                self.push(AgentMessage::sourced(Source::Hook, format!("<system-reminder>\n{reason}\n</system-reminder>"))).await?;
            }
        }
        Ok(())
    }

    /// Budgets of the batch's executed results, then the cache writes: the error kind, native
    /// tool-search payloads, offload, inline-image compaction, and the reusable text bodies
    /// handed to the cache only if still complete after offloading.
    async fn finalize_results(
        &mut self,
        calls: &[ToolCall],
        staged: &mut [Option<AgentMessage>],
        executed: &[bool],
        tool_ms: &[i64],
        intervals: &mut [Vec<(i64, i64)>],
        cache: CacheRefs<'_>,
    ) {
        let (writes, outputs, hits) = cache;
        let indices: Vec<usize> = (0..calls.len()).filter(|i| executed[*i] && staged[*i].is_some()).collect();
        classify_error_results(calls, staged, outputs, &indices);
        self.adopt_native_tool_search(calls, staged, &indices);
        self.offload_results(calls, staged, hits, &indices).await;
        self.trace_and_cache(calls, staged, tool_ms, intervals, (writes, outputs, hits), indices).await;
    }

    /// A loading tool's native tool-search payload becomes the message's, and its summary the result.
    fn adopt_native_tool_search(&self, calls: &[ToolCall], staged: &mut [Option<AgentMessage>], indices: &[usize]) {
        let mut definitions = None;
        for i in indices {
            if let Some(m) = staged[*i].as_mut()
                && let Content::Text(text) = &m.message.content
                && let Some(native) = parse_native_tool_search(&calls[*i].name, text)
                && let Some(summary) = native.get("summary").and_then(serde_json::Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
            {
                let definitions = definitions.get_or_insert_with(|| {
                    let mut seen = NativeDefinitions::default();
                    for payload in self.messages.iter().filter_map(|row| row.message.native_tool_search.as_ref()) {
                        seen.record(payload);
                    }
                    seen
                });
                m.message.native_tool_search = definitions.take_new(native);
                m.message.content = Content::Text(summary);
            }
        }
    }

    /// The per-tool and per-message offload of the executed bodies, then inline-image compaction.
    async fn offload_results(&self, calls: &[ToolCall], staged: &mut [Option<AgentMessage>], hits: &[Option<ReuseKind>], indices: &[usize]) {
        if let Some(store) = self.env.artifacts.clone() {
            let mut slots = Vec::new();
            let mut entries = Vec::new();
            for &i in indices {
                if hits[i].is_none()
                    && let Some(m) = staged[i].as_mut()
                {
                    slots.push(i);
                    entries.push(crate::offload::BatchEntry {
                        tool: calls[i].name.strip_prefix("mcp__plugin_mixdog_mixdog__").unwrap_or(&calls[i].name).to_owned(),
                        content: std::mem::replace(&mut m.message.content, Content::Text(String::new())),
                    });
                }
            }
            crate::offload::offload_batch(store.as_ref(), &mut entries).await;
            for (i, entry) in slots.into_iter().zip(entries) {
                if let Some(m) = staged[i].as_mut() {
                    m.message.content = entry.content;
                }
            }
        }
        if let Some(images) = self.env.images.clone() {
            for i in indices {
                if let Some(m) = staged[*i].as_mut() {
                    let body = std::mem::replace(&mut m.message.content, Content::Text(String::new()));
                    m.message.content = crate::offload::compact_owned_images(images.as_ref(), body).await;
                }
            }
        }
    }

    /// Per call in call order: the call's trace rows (and, for an error call, its failure row) on the
    /// result the transcript holds, then a normal call's reusable body to the cache.
    async fn trace_and_cache(
        &mut self,
        calls: &[ToolCall],
        staged: &[Option<AgentMessage>],
        tool_ms: &[i64],
        intervals: &mut [Vec<(i64, i64)>],
        cache: CacheRefs<'_>,
        indices: Vec<usize>,
    ) {
        let (writes, outputs, hits) = cache;
        for i in indices {
            let Some(m) = &staged[i] else {
                continue;
            };
            let error = m.tool_kind == Some(ToolKind::Error);
            let hit = hits[i];
            if let Some(log) = &self.env.failures {
                log.tool(crate::env::TracedCall {
                    iteration: self.iterations,
                    tool_call_id: calls[i].id.clone(),
                    tool_name: calls[i].name.clone(),
                    tool_kind: trace_tool_kind(&self.tools, &calls[i].name),
                    tool_ms: tool_ms[i],
                    tool_args: if hit.is_some() { serde_json::Value::Null } else { calls[i].arguments.clone() },
                    model: self.model.clone(),
                    result_kind: match (hit, m.tool_kind) {
                        (_, Some(ToolKind::Error)) => "error",
                        (Some(ReuseKind::Read), _) => "cache-hit",
                        (Some(ReuseKind::Scoped), _) => "scoped-cache-hit",
                        (_, Some(ToolKind::Skipped)) => "skipped",
                        _ => "normal",
                    },
                    result: if hit.is_some() { serde_json::Value::Null } else { trace_result(&m.message.content) },
                    result_text: if hit.is_some() { String::new() } else { trace_text(&m.message.content) },
                    timing: m.tool_timing,
                    execution_intervals: std::mem::take(&mut intervals[i]),
                    result_telemetry: output_meta(outputs[i].as_ref(), "resultTelemetry"),
                    local_search: output_meta(outputs[i].as_ref(), "localSearchTelemetry"),
                });
            }
            if !error
                && let Content::Text(text) = &m.message.content
                && !crate::offload::is_offloaded(text)
                && let (Some(write), Some(output)) = (writes[i].take(), &outputs[i])
            {
                write.store(text, output).await;
            }
        }
    }
}

/// A call that returned text reading as an error (the delegated-agent, skill and MCP tools answer
/// `Error: …` instead of failing) is an error call, unless the tool's own `explicit_success` says
/// otherwise; only a text return is read, a structured one is normal. The kind is set on the message
/// before anything rewrites it, so the request this turn sends and the one the next turn rebuilds from
/// the transcript are the same message.
fn classify_error_results(calls: &[ToolCall], staged: &mut [Option<AgentMessage>], outputs: &[Option<ToolOutput>], indices: &[usize]) {
    for i in indices {
        let explicit_success = outputs[*i].as_ref().is_some_and(|o| o.explicit_success);
        if let Some(m) = staged[*i].as_mut()
            && m.tool_kind == Some(ToolKind::Normal)
            && let Content::Text(text) = &m.message.content
            && !explicit_success
            && crate::result_kind::classify_result_kind(text, &calls[*i].name) == crate::result_kind::ResultKind::Error
        {
            m.tool_kind = Some(ToolKind::Error);
            m.message.is_error = true;
        }
    }
}

/// The text a failure row is cut from: a text as it is, a structured result's text parts joined by
/// newlines, its images and other parts left out.
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

/// The result the trace is given: a text as a string, a structured result as its text parts (`{type, text}`).
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

/// What a call that settled before the stop tells the host: the model-visible text; `error` only when
/// the call threw (the executor's `Err`). A thrown call's text is its `message_for_model`, which already
/// reads `Error: <message>`, so nothing is prefixed here. A tool that returned an error outcome, or a
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

    /// The notice an eager call that settled gives: the returned text as it is, and `Error: <message>` with the error kind
    /// only for a call that threw.
    #[test]
    fn a_settled_call_is_noticed_with_its_text_and_only_a_thrown_one_as_an_error() {
        let returned = {
            let mut executed = Executed::error("c1", String::new());
            executed.failed = false;
            executed.message = AgentMessage::tool_result("c1", Content::Text("done".to_owned()), ToolKind::Normal);
            early_result("c1", &executed)
        };
        assert_eq!(returned.text(), "done");
        assert_ne!(returned.tool_kind, Some(ToolKind::Error));
        assert_eq!(returned.tool_call_id(), Some("c1"));
        let thrown = early_result("c1", &Executed::error("c1", "boom".to_owned()));
        assert_eq!(thrown.text(), "boom");
        assert_eq!(thrown.tool_kind, Some(ToolKind::Error));
        assert!(!thrown.text().starts_with("Error: Error: "), "one prefix");
    }
}
