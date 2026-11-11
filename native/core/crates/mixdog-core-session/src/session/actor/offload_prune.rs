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

/// A session's messages as Node's `session.messages` holds them: its system prompt (the leading `system` messages,
/// which the core keeps in the header's prompt blocks, `SystemBlocks::from_header`, as the migration moves them
/// there) and its model rows since the newest compaction (`read_context`, the conversation the model is sent). Node's
/// `messages` holds nothing else.
fn node_messages(header: &mixdog_store::schema::record::Header, rows: Vec<(mixdog_core_api::ids::ItemId, Value)>) -> Vec<Value> {
    let system = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(header).node_messages();
    system.into_iter().chain(rows.into_iter().map(|(_, row)| row)).collect()
}

/// `offloadCopies`: the stored messages of the sessions whose reference set names `own` (the copies of its
/// conversation, and the copies of those: one catalog read, no session between them needed, so a copy whose source
/// was deleted counts), read when the prune asks for them (`OffloadCopies`). A copy deleted since names nothing. A
/// session the catalog or the store cannot read (whether it names `own` is not known then), or a copy still being made
/// (its rows not stored yet), answers `None`: nothing is deleted, and the skip says why.
async fn copy_transcripts(deps: Arc<SessionDeps>, own: ThreadId) -> Option<String> {
    let skipped = |why: String| {
        tracing::warn!(thread = own.as_str(), "offload prune skipped: {why}");
        None
    };
    let copies = match deps.store.copies_of(&own).await {
        Ok(copies) => copies,
        Err(error) => return skipped(format!("the copies of the conversation could not be listed: {error:?}")),
    };
    let mut out = Vec::new();
    for copy in copies {
        let thread = ThreadId::from(copy);
        let (store, read) = (deps.store.clone(), thread.clone());
        let header = match mixdog_core_base::support::on_lane(deps.lanes.io, &CancellationToken::new(), move |lane| store.read_header(lane, &read)).await {
            Ok(Ok(header)) => header,
            Ok(Err(mixdog_core_api::CoreError::ThreadNotFound { .. })) => continue,
            Ok(Err(error)) => return skipped(format!("the session {} cannot be read: {error:?}", thread.as_str())),
            Err(_) => return skipped(format!("the session {} was not read", thread.as_str())),
        };
        if mixdog_store::summary::is_deleted(&header) {
            continue;
        }
        match super::super::run::read_context(&deps.store, &deps.lanes, &thread).await {
            Ok(rows) => out.push(Value::Array(node_messages(&header, rows))),
            Err(error) => return skipped(format!("the session {} cannot be read: {error:?}", thread.as_str())),
        }
    }
    Some(mixdog_js::json_stringify(&Value::Array(out)))
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

    /// The listed sidecars: what the session references now (Node's `[session.messages, liveTurnMessages, pending,
    /// ...copies]`: its system prompt, held in the header's prompt blocks, and its model rows since the newest
    /// compaction (`node_messages`); no live turn messages, being idle; what waits in its queue and every record
    /// accepted and not yet released; and, once an old sidecar none of that keeps remains, the stored copies of its
    /// conversation in other sessions) is read and the engine deletes the candidates none of it reaches. A
    /// reference is text: a sidecar whose path or file name occurs in these (or in an archive they reach) is kept, as
    /// Node's `pruneOffloadSession` matches; text elsewhere (a room log, memory) keeps nothing. The decision is this actor's: a thread it let go (closed,
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
            let transcript = node_messages(&self.projected.header, rows);
            let queued: Vec<Value> = self.projected.queue.iter().map(|queued| queued.entry.clone()).collect();
            let unreleased: Vec<Value> = self.outbox.records().filter_map(|record| serde_json::to_value(record).ok()).collect();
            // Node's `[session.messages, session.liveTurnMessages, pending, ...copies]`: idle, there are no live turn
            // messages.
            let lists = vec![json!(transcript), Value::Null, json!(queued), json!(unreleased)];
            let transcripts = mixdog_js::json_stringify(&Value::Array(lists));
            let copies = Box::pin(copy_transcripts(self.deps.clone(), self.id.clone()));
            self.deps.compaction.prune_offloads(&self.id, candidates, transcripts, copies).await;
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
