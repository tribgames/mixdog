//! `pruneCompactedOffloads` (`compaction-runner.mjs:470`) after a manual compaction, on the actor, as Node with the
//! prune-after-save fix (`node-fix-prune-after-save.patch`) does it.
//!
//! The prune starts only once the compaction is durable: the commit's ack is sent when the store acknowledged the
//! batch (`release`), and a batch that failed, a commit the conversation moved past (nothing is written) or an actor
//! that ended first never sends it (`compaction_rows`), so a stored transcript that still names a sidecar never
//! outlives it. A prune a running turn stopped runs once that turn has ended (`run_deferred_prune`): a close keeps every
//! sidecar and only a delete purges them, so a session that never compacts again would keep them for its whole life.

use super::*;

impl SessionActor {
    /// `pruneCompactedOffloads(session)`: a session that is not idle (`isSessionCompactionBlocked`) is not pruned now;
    /// else its old sidecars are listed off the actor (`pruneOffloadSession`'s `readdir`, while the session takes
    /// messages as Node's does), and `prune_listed` decides.
    pub(super) fn prune_offloads(&mut self, told: oneshot::Sender<()>) {
        if self.compaction_blocked() {
            self.defer_prune();
            return drop(told.send(()));
        }
        self.prune_deferred = false;
        let (engine, thread, jobs) = (self.deps.compaction.clone(), self.id.clone(), self.jobs_tx.clone());
        tokio::spawn(async move {
            let candidates = engine.offload_candidates(&thread).await;
            if candidates.is_empty() {
                return drop(told.send(()));
            }
            // An actor that is gone drops `told`, which answers the commit as well.
            let _ = jobs.send(JobDone::PruneListed(candidates, told));
        });
    }

    /// The listed sidecars: what the session references now (its kept transcript, what waits in its queue, and every
    /// record accepted and not yet released) is read and the engine deletes the candidates none of it reaches. The
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
            // Node's `[session.messages, session.liveTurnMessages, pending]`: idle, there are no live turn messages.
            let transcripts = mixdog_js::json_stringify(&json!([transcript, Value::Null, queued, unreleased]));
            self.deps.compaction.prune_offloads(&self.id, candidates, transcripts).await;
        }
        let _ = told.send(());
    }

    /// A prune a running turn stopped waits for the turn's end; a closing or deleted thread's never runs.
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
