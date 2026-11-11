//! `pruneCompactedOffloads` (`compaction-runner.mjs:470`) after a manual compaction, on the actor, as Node with the
//! prune-after-save fix (`node-fix-prune-after-save.patch`) does it.
//!
//! The prune starts only once the compaction is durable: the commit's ack is sent when the store acknowledged the
//! batch (`release`), and a batch that failed, a commit the conversation moved past (nothing is written) or an actor
//! that ended first never sends it (`compaction_rows`), so a stored transcript that still names a sidecar never
//! outlives it. A prune a running turn stopped runs once that turn has ended (`run_deferred_prune`). Nothing of a
//! prune is remembered anywhere else: every open of the thread reconciles its tool-result directory with what is
//! stored then (`reconcile_offloads`, Node's `reconcileOffloadsOnResume`), so a prune a close, a stopped process or
//! an unreadable archive kept from finishing happens at the next open. A close keeps every sidecar and only a delete
//! purges them: without it, a session that never compacts again would keep them for its whole life.

use super::*;

/// A session's `offloadForks`: the ids of the sessions holding a copy of its conversation.
fn offload_forks(header: &mixdog_store::schema::record::Header) -> Vec<String> {
    header.get("offloadForks").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).collect()
}

/// The stored transcripts of the sessions holding a copy of `own`'s conversation (`forks`, its `offloadForks`: a
/// clear's fork, an inheritance's heir, recorded by `carry_into`), and of their own copies, each read once: every one
/// names `own`'s sidecars. A copy that cannot be read keeps nothing.
async fn copy_transcripts(deps: Arc<SessionDeps>, own: ThreadId, forks: Vec<String>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::from([own.as_str().to_owned()]);
    let mut pending: std::collections::VecDeque<String> = forks.into();
    let mut out = Vec::new();
    while let Some(fork) = pending.pop_front() {
        if !seen.insert(fork.clone()) {
            continue;
        }
        let thread = ThreadId::from(fork);
        let (store, read) = (deps.store.clone(), thread.clone());
        if let Ok(Ok(header)) = mixdog_core_base::support::on_lane(deps.lanes.io, &CancellationToken::new(), move |lane| store.read_header(lane, &read)).await {
            pending.extend(offload_forks(&header));
        }
        if let Ok(rows) = super::super::run::read_context(&deps.store, &deps.lanes, &thread).await {
            out.push(Value::Array(rows.into_iter().map(|(_, row)| row).collect()));
        }
    }
    out
}

impl SessionActor {
    /// `pruneCompactedOffloads(session)`: a session that is not idle (`isSessionCompactionBlocked`) is not pruned now;
    /// else its sidecars are listed off the actor (`pruneOffloadSession`'s `readdir`, while the session takes
    /// messages as Node's does), and `prune_listed` decides. `told` once the prune ran or was left to the turn's end.
    pub(super) fn prune_offloads(&mut self, told: oneshot::Sender<()>) {
        if self.compaction_blocked() {
            self.defer_prune();
            let _ = told.send(());
            return;
        }
        self.prune_deferred = false;
        let (engine, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let candidates = engine.offload_candidates(&thread).await;
            if candidates.is_empty() {
                let _ = told.send(());
                return;
            }
            // An actor that is gone drops `told`, which answers the commit as well.
            let _ = jobs.send(JobDone::PruneListed(candidates, told));
        });
    }

    /// The thread is open: its tool-result directory is reconciled with what is stored now, as every prune
    /// (`reconcileOffloadsOnResume`).
    pub(super) fn reconcile_offloads(&mut self) {
        let (told, _) = oneshot::channel();
        self.prune_offloads(told);
    }

    /// The listed sidecars: what the session references now (its kept transcript, what waits in its queue, every
    /// record accepted and not yet released, and the stored copies of its conversation in other sessions) is read and
    /// the engine deletes the candidates none of it reaches. The decision is this actor's: a thread it let go (closed,
    /// or its actor ended while the listing ran) is never pruned by it, as Node's prune of a session whose writer
    /// claim it let go deletes nothing (`sessionWriterHeldHere`). The
    /// run loop awaits this with nothing else handled: no message joins the session and no turn starts on it from
    /// the read to the last delete, so a sidecar a message names when it is deleted was never one the session held.
    /// A turn that started while the listing ran stops the prune: what it holds and has not committed is not read
    /// (Node reads `session.liveTurnMessages`), so its sidecars are left to a later prune, as Node leaves an in-flight
    /// turn's.
    pub(super) async fn prune_listed(&mut self, candidates: Vec<std::path::PathBuf>, told: oneshot::Sender<()>) {
        if self.compaction_blocked() {
            self.defer_prune();
        } else if let Ok(rows) = super::super::run::read_context(&self.deps.store, &self.deps.lanes, &self.id).await {
            let transcript: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
            let queued: Vec<Value> = self.projected.queue.iter().map(|queued| queued.entry.clone()).collect();
            let unreleased: Vec<Value> = self.outbox.records().filter_map(|record| serde_json::to_value(record).ok()).collect();
            // Node's `[session.messages, session.liveTurnMessages, pending, ...copies]`: idle, there are no live turn
            // messages.
            let mut lists = vec![json!(transcript), Value::Null, json!(queued), json!(unreleased)];
            lists.extend(copy_transcripts(self.deps.clone(), self.id.clone(), offload_forks(&self.projected.header)).await);
            let transcripts = mixdog_js::json_stringify(&Value::Array(lists));
            self.deps.compaction.prune_offloads(&self.id, candidates, transcripts).await;
        }
        let _ = told.send(());
    }

    /// A prune a running turn stopped waits for the turn's end; a closing or deleted thread's waits for the next open
    /// (a delete purges every sidecar).
    fn defer_prune(&mut self) {
        if self.ui_busy() {
            self.prune_deferred = true;
        }
    }

    /// A turn ended (`run_ended`): the prune it stopped runs now if the session is idle, as Node's runs on the
    /// activity pulse of the turn's settle.
    pub(super) fn run_deferred_prune(&mut self) {
        if self.prune_deferred && !self.compaction_blocked() {
            let (told, _) = oneshot::channel();
            self.prune_offloads(told);
        }
    }
}
