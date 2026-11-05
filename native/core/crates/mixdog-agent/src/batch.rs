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
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_rt::TaskClass;
use serde_json::json;

use mixdog_core_api::domain::tool::ToolOutput;

use crate::env::GateCall;
use crate::env::RunEvent;
use crate::env::or_cancelled;
use crate::limits;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;
use crate::run::AgentError;
use crate::run::Run;
use crate::tools::CallEnv;
use crate::tools::CallFuture;
use crate::tools::Executed;
use crate::tools::arg_shape;
use crate::tools::call_signature;
use crate::tools::conflicts;
use crate::tools::execute_call;
use crate::tools::failure_signature;
use crate::tools::intra_turn_duplicates;

const CROSS_TURN_CAP: usize = 500;
/// Tools that are not edits or progress even though they are not read-only.
const NON_PROGRESS_TOOLS: [&str; 9] = [
    "Skill", "recall", "agent", "task", "cwd", "session", "load_tool", "tool_search", "todo",
];

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

type EditGroup = Arc<Mutex<(u32, u32)>>;

/// One assistant turn issuing N `edit` calls with the same file and
/// `old_string` (not replace-all) and N distinct `new_string`s is
/// unambiguous as a whole: the k-th call takes the k-th occurrence. Members
/// run in order; an ambiguity-rejected member re-runs once with the remaining
/// count.
fn edit_groups(calls: &[ToolCall]) -> HashMap<String, EditGroup> {
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
    let mut executed = execute_call(call.clone(), Arc::clone(&env)).await;
    let Some(group) = group else {
        return executed;
    };
    let remaining = {
        let g = group.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        g.0.saturating_sub(g.1)
    };
    if remaining >= 1 && executed.conflict {
        let mut retry = call;
        if remaining >= 2
            && let Some(args) = retry.arguments.as_object_mut()
        {
            args.insert("editOccurrence".into(), json!({ "expected": remaining }));
        }
        let rerun = execute_call(retry, env).await;
        if !rerun.failed {
            executed = rerun;
        }
    }
    if !executed.failed {
        group.lock().unwrap_or_else(std::sync::PoisonError::into_inner).1 += 1;
    }
    executed
}

#[allow(clippy::large_enum_variant)]
enum Decision {
    Skip(AgentMessage),
    Run,
}

impl Run {
    pub(crate) fn call_env(&self) -> Arc<CallEnv> {
        Arc::new(CallEnv {
            tools: self.tools.clone(),
            gate: Arc::clone(&self.env.gate),
            hooks: self.env.hooks.clone(),
            observer: Arc::clone(&self.env.observer),
            guards: Arc::clone(&self.env.guards),
            tool_env: self.tool_env.clone(),
            cancel: self.cancel.clone(),
        })
    }

    fn requires_read_body(&self, name: &str) -> bool {
        self.config.read_body_required && name == "read"
    }

    /// Starts a read-only call the moment the provider streams it, when
    /// nothing in the batch could answer it differently: no limit, no guard
    /// near firing, no duplicate, receipt or cached body. A call that did not
    /// start here is decided by the serial batch.
    pub(crate) fn try_eager(&mut self, call: &ToolCall) {
        if !self.config.eager_dispatch
            || self.turn_limit_noticed
            || self.config.limits.is_some_and(|l| l.max_tool_calls.is_some() || l.wrap_up_at_ms.is_some())
            || call.id.is_empty()
            || self.eager.contains_key(&call.id)
        {
            return;
        }
        let name = self.tools.canonical(&call.name);
        if !self.tools.read_only(&name) {
            return;
        }
        let exec = ToolCall { name: name.clone(), ..call.clone() };
        let gate_call = GateCall::new(name.clone(), call.arguments.clone());
        if self.env.gate.pre_dispatch_deny(&gate_call).is_some() || self.carry.repeat.could_fire(0) {
            return;
        }
        if self.tools.dedup_eligible(&name) {
            let sig = call_signature(&name, &call.arguments);
            if !self.eager_sigs.insert(sig.clone())
                || self.cross_turn.has(&sig)
                || self.env.reuse.as_ref().is_some_and(|r| r.lookup(&exec, false).is_some())
            {
                return;
            }
        }
        let env = self.call_env();
        let id = call.id.clone();
        let handle = mixdog_rt::spawn("agent.eager", TaskClass::Work, async move {
            execute_call(exec, env).await
        });
        self.eager.insert(id, handle);
    }

    /// Eager results of a dead attempt or an unused call are dropped; the
    /// tools were read-only, and their tokens wind them down.
    pub(crate) fn drop_eager(&mut self) {
        for (_, handle) in self.eager.drain() {
            handle.abort();
        }
        self.eager_sigs.clear();
    }

    pub(crate) fn eager_dispatched(&self, id: &str) -> bool {
        self.eager.contains_key(id)
    }

    /// What one call is, in Node's order: surface denial, one-per-turn tools,
    /// intra-turn twin, cross-turn receipt, repeat-failure guards.
    #[allow(clippy::too_many_arguments)]
    fn decide(
        &mut self,
        call: &ToolCall,
        dup_of: Option<&String>,
        single_of: Option<&String>,
        ct_sig: Option<&str>,
        sig: &str,
        shape_sig: &str,
    ) -> Decision {
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
            && let Some(stub) = self.cross_turn_stub(call, ct)
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
    fn cross_turn_stub(&mut self, call: &ToolCall, ct_sig: &str) -> Option<String> {
        let iterations = self.iterations;
        let (first_iteration, tool_use_id) = {
            let prior = self.cross_turn.find(ct_sig)?;
            if prior.first_iteration >= iterations {
                return None;
            }
            (prior.first_iteration, prior.tool_use_id.clone())
        };
        let valid = self
            .env
            .reuse
            .as_ref()
            .and_then(|r| r.lookup(call, false))
            .is_some_and(|hit| !tool_use_id.is_empty() && hit.first_tool_use_id == tool_use_id);
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
    fn record_executed(&mut self, call: &ToolCall, executed: &Executed, sigs: (String, String), later_mutation: bool) -> bool {
        self.carry
            .repeat
            .record(executed.failed, sigs.0, sigs.1, executed.arg_failure);
        let read_only = self.tools.read_only(&call.name);
        if let Some(reuse) = &self.env.reuse {
            reuse.after_call(call, executed.failed);
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

    pub(crate) async fn process_tool_batch(&mut self, wire_calls: &[ToolCall], allowed: u64) -> Result<(), AgentError> {
        let n = wire_calls.len();
        // The execution view: typo aliases and case variants canonicalized.
        let calls: Vec<ToolCall> = wire_calls
            .iter()
            .map(|c| ToolCall { name: self.tools.canonical(&c.name), ..c.clone() })
            .collect();
        let dups = intra_turn_duplicates(&calls, &self.tools);
        let mut single_first: HashMap<String, String> = HashMap::new();
        let mut single_of: Vec<Option<String>> = vec![None; n];
        for (i, c) in calls.iter().enumerate() {
            if c.id.is_empty() || !self.config.single_call_tools.contains(&c.name) {
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
        let specs: Vec<Option<ToolSpec>> = calls
            .iter()
            .map(|c| self.tools.get(&c.name).map(|t| t.spec().clone()))
            .collect();
        let wrap_up = self.turn_limits().and_then(|l| l.wrap_up_at_ms);
        let cwd = self.tool_env.cwd.as_path().to_path_buf();

        let mut staged: Vec<Option<AgentMessage>> = vec![None; n];
        let mut executed: Vec<Option<Executed>> = (0..n).map(|_| None).collect();
        let mut sigs: Vec<(String, String)> = vec![(String::new(), String::new()); n];
        let mut evaluated = vec![false; n];
        let mut finished = vec![false; n];
        let mut started = vec![false; n];
        let mut ready: Vec<bool> = vec![false; n];
        let mut recorded = 0usize;
        let mut was_executed = vec![false; n];
        let mut cacheable = vec![false; n];
        let mut outputs: Vec<Option<ToolOutput>> = (0..n).map(|_| None).collect();
        let mut follow_ups: Vec<AgentMessage> = Vec::new();
        let env = self.call_env();
        let mut running: FuturesUnordered<CallFuture> = FuturesUnordered::new();
        let mut aborted = false;

        loop {
            // 1. Decide, in call order.
            for j in 0..n {
                if evaluated[j] {
                    continue;
                }
                let call = &calls[j];
                if (j as u64) >= allowed || wrap_up.is_some_and(|at| self.env.clock.now_ms() >= at) {
                    staged[j] = Some(limits::refusal(&call.id));
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
                match self.decide(call, dups.get(&j), single_of[j].as_ref(), ct_sig.as_deref(), &sig, &shape_sig) {
                    Decision::Skip(message) => {
                        staged[j] = Some(message);
                        finished[j] = true;
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
                        self.record_executed(&calls[recorded], &result, sig_pair, later_mutation);
                    outputs[recorded] = result.output.take();
                    was_executed[recorded] = true;
                    follow_ups.extend(result.follow_ups.iter().cloned());
                    staged[recorded] = Some(result.message);
                }
                recorded += 1;
            }
            if recorded == n {
                break;
            }
            // 3. Start what is ready and not held back by an earlier conflicting call.
            for j in 0..n {
                if !ready[j] || started[j] {
                    continue;
                }
                let blocked = (0..j).any(|i| {
                    !finished[i]
                        && match (&specs[i], &specs[j]) {
                            (Some(a), Some(b)) => conflicts(a, b),
                            _ => false,
                        }
                });
                if blocked {
                    continue;
                }
                started[j] = true;
                let call = calls[j].clone();
                if let Some(reuse) = &self.env.reuse
                    && let Some(hit) = reuse.lookup(&call, true)
                {
                    let mut served =
                        Executed::error(&call.id, String::new());
                    served.message = AgentMessage::tool_text(&call.id, hit.content, ToolKind::CacheHit);
                    served.failed = false;
                    served.cache_hit = Some(hit.first_tool_use_id);
                    executed[j] = Some(served);
                    finished[j] = true;
                    continue;
                }
                // A streamed read-only result is only usable when no earlier
                // call of the batch could have changed what it read.
                let eager = self.eager.remove(&call.id);
                let eager = eager.filter(|_| (0..j).all(|i| specs[i].as_ref().is_none_or(|s| s.parallel_safe)));
                if let Some(handle) = eager {
                    let id = call.id.clone();
                    running.push(Box::pin(async move {
                        let result = handle.await.unwrap_or_else(|_| {
                            Executed::error(&id, "Error: tool task failed".to_owned())
                        });
                        (j, result)
                    }));
                } else {
                    let group = edit_key(&call).and_then(|k| groups.get(&k).cloned());
                    let env = Arc::clone(&env);
                    running.push(Box::pin(async move { (j, run_one(call, env, group).await) }));
                }
            }
            if running.is_empty() {
                // Everything left was decided without a run.
                if (0..n).all(|k| finished[k]) {
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
                    executed[idx] = Some(result);
                    finished[idx] = true;
                }
            }
        }
        drop(running);
        self.drop_eager();

        if aborted {
            // Commit what finished; the interruption closes the rest.
            for i in 0..n {
                if let Some(result) = executed[i].take() {
                    staged[i] = Some(result.message);
                }
            }
        }
        if !aborted {
            self.finalize_results(&calls, &mut staged, &was_executed, &cacheable, &outputs).await;
        }
        // Results commit in the assistant's call order.
        for message in staged.into_iter().flatten() {
            if let (Some(id), Some(kind)) = (message.tool_call_id(), message.tool_kind) {
                self.emit(RunEvent::ToolResult { call_id: id.to_owned(), kind });
            }
            self.push(message);
        }
        if aborted {
            return Err(AgentError::Aborted);
        }
        for message in follow_ups {
            self.push(message);
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
                ));
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
        cacheable: &[bool],
        outputs: &[Option<ToolOutput>],
    ) {
        let indices: Vec<usize> = (0..calls.len())
            .filter(|i| executed[*i] && staged[*i].is_some())
            .collect();
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
        if let Some(reuse) = &self.env.reuse {
            for i in indices.into_iter().filter(|i| cacheable[*i]) {
                if let (Some(m), Some(output)) = (&staged[i], &outputs[i]) {
                    reuse.store(&calls[i], &m.text(), &calls[i].id, output);
                }
            }
        }
    }}
