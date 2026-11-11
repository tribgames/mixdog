//! `pruneCompactedOffloads` (`compaction-runner.mjs:470`) after a durable manual compaction, on the actor.

use super::*;

impl SessionActor {
    /// `pruneCompactedOffloads(session)` over the sidecars already listed as old: skipped unless the session is
    /// idle (`isSessionCompactionBlocked`); else what the session references now (its kept transcript, what waits
    /// in its queue, and every record accepted and not yet released) is read and the engine deletes the candidates
    /// none of it reaches. The run loop awaits this with nothing else handled: no message joins the session and no
    /// turn starts on it from the idle check to the last delete, so a sidecar a message names when it is deleted
    /// was never one the session held.
    pub(super) async fn prune_offloads(&mut self, candidates: Vec<std::path::PathBuf>, told: oneshot::Sender<()>) {
        if !self.compaction_blocked()
            && let Ok(rows) = super::super::run::read_context(&self.deps.store, &self.deps.lanes, &self.id).await
        {
            let transcript: Vec<Value> = rows.into_iter().map(|(_, row)| row).collect();
            let queued: Vec<Value> = self.projected.queue.iter().map(|queued| queued.entry.clone()).collect();
            let unreleased: Vec<Value> = self.outbox.records().filter_map(|record| serde_json::to_value(record).ok()).collect();
            // Node's `[session.messages, session.liveTurnMessages, pending]`: idle, there are no live turn messages.
            let transcripts = mixdog_js::json_stringify(&json!([transcript, Value::Null, queued, unreleased]));
            self.deps.compaction.prune_offloads(&self.id, candidates, transcripts).await;
        }
        let _ = told.send(());
    }
}
