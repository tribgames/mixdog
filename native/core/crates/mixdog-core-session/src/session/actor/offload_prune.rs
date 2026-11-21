use super::*;

fn node_messages(header: &mixdog_store::schema::record::Header, rows: Vec<(mixdog_core_api::ids::ItemId, Value)>) -> Vec<Value> {
    let system = mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(header).node_messages();
    system.into_iter().chain(rows.into_iter().map(|(_, row)| row)).collect()
}

/// The stored messages of session `thread` (`node_messages`), `None` for one deleted or gone, or why it cannot be
/// read.
async fn stored_messages(deps: &SessionDeps, thread: &ThreadId) -> Result<Option<Vec<Value>>, String> {
    let (store, read) = (deps.store.clone(), thread.clone());
    let header = match mixdog_core_base::support::on_lane(deps.lanes.io, &CancellationToken::new(), move |lane| store.read_header(lane, &read)).await {
        Ok(Ok(header)) => header,
        Ok(Err(mixdog_core_api::CoreError::ThreadNotFound { .. })) => return Ok(None),
        Ok(Err(error)) => return Err(format!("the session {} cannot be read: {error:?}", thread.as_str())),
        Err(_) => return Err(format!("the session {} was not read", thread.as_str())),
    };
    if mixdog_store::summary::is_deleted(&header) {
        return Ok(None);
    }
    match super::super::run::read_context(&deps.store, &deps.lanes, thread).await {
        Ok(rows) => Ok(Some(node_messages(&header, rows))),
        Err(error) => Err(format!("the session {} cannot be read: {error:?}", thread.as_str())),
    }
}

/// How many sessions whose reference set is unknown one pass reads (Node's `OFFLOAD_CHECK_BATCH`).
pub(crate) const OFFLOAD_SCAN_BATCH: usize = 32;

async fn copy_transcripts(deps: Arc<SessionDeps>, own: ThreadId, jobs: mpsc::UnboundedSender<JobDone>) -> Option<String> {
    let skipped = |why: String| {
        tracing::warn!(thread = own.as_str(), "offload prune skipped: {why}");
        None
    };
    let found = match deps.store.copies_of(&own).await {
        Ok(found) => found,
        Err(error) => return skipped(format!("the copies of the conversation could not be listed: {error:?}")),
    };
    if let Some(session) = found.unreadable {
        deps.notices.offload_prune_blocked(&session);
        return skipped(format!("the session {session} cannot be read"));
    }
    if let Some((first, _)) = found.unknown.first() {
        let why = format!("the reference set of the session {first} is not known ({} such sessions): they are read first", found.unknown.len());
        tokio::spawn(scan_unknown(deps.clone(), own.clone(), found.unknown, jobs));
        return skipped(why);
    }
    let mut out = Vec::new();
    for copy in found.copies {
        match stored_messages(&deps, &ThreadId::from(copy.clone())).await {
            Ok(Some(messages)) => out.push(Value::Array(messages)),
            Ok(None) => {}
            Err(why) => {
                deps.notices.offload_prune_blocked(&copy);
                return skipped(why);
            }
        }
    }
    Some(mixdog_js::json_stringify(&Value::Array(out)))
}

async fn scan_unknown(deps: Arc<SessionDeps>, own: ThreadId, unknown: Vec<(String, i64)>, jobs: mpsc::UnboundedSender<JobDone>) {
    let before = unknown.len();
    for (session, ordinal) in unknown.into_iter().take(OFFLOAD_SCAN_BATCH) {
        match stored_messages(&deps, &ThreadId::from(session.clone())).await {
            Ok(Some(messages)) => {
                let named = mixdog_store::offload_sources::named_in(&serde_json::to_string(&messages).unwrap_or_default());
                let sources = mixdog_store::offload_sources::transcript_sources(named, &session);
                if let Err(error) = deps.store.record_offload_scan(&session, ordinal, sources).await {
                    tracing::warn!(thread = own.as_str(), "the reference set of the session {session} could not be stored: {error:?}");
                }
            }
            Ok(None) => {}
            Err(why) => {
                deps.notices.offload_prune_blocked(&session);
                tracing::warn!(thread = own.as_str(), "offload prune blocked: {why}");
            }
        }
    }
    if deps.store.copies_of(&own).await.is_ok_and(|after| after.unknown.len() < before) {
        let (told, _) = oneshot::channel();
        let _ = jobs.send(JobDone::PruneOffloads(told));
    }
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
            let copies = Box::pin(copy_transcripts(self.deps.clone(), self.id.clone(), self.jobs_tx.clone()));
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
