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

/// The prunes of a session: they run off its actor one at a time and end before it does.
#[derive(Default)]
pub(super) struct Prunes {
    running: Option<Prune>,
    /// Asked for while one ran: one more prune runs once it ends, and tells them all.
    waiting: Vec<oneshot::Sender<()>>,
}

/// The prune under way, from its listing to its deletes.
struct Prune {
    /// Fired when the session leaves memory or closes, or its actor is dropped: no delete not granted yet is made.
    cancel: CancellationToken,
    /// Its deletes were granted ([`SessionActor::prune_grant`]): until it ends no message is taken and no turn starts.
    holds: bool,
    told: Vec<oneshot::Sender<()>>,
}

impl Drop for Prune {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// What the session holds besides its stored transcript, as a prune judges by it: its header (the transcript's system
/// blocks), its queue with a start waiting at the gate and a request whose receipt is being read, and the records it has
/// not released.
pub(crate) struct Held {
    header: Arc<Header>,
    queued: Vec<Value>,
    unreleased: Vec<Value>,
}

impl Held {
    /// Node's `[session.messages, session.liveTurnMessages, pending]` over `rows`, the stored transcript: no turn runs, so
    /// there are no live turn messages.
    fn lists(self, rows: Vec<(mixdog_core_api::ids::ItemId, Value)>) -> String {
        let lists = vec![json!(node_messages(&self.header, rows)), Value::Null, json!(self.queued), json!(self.unreleased)];
        mixdog_js::json_stringify(&Value::Array(lists))
    }
}

/// Reports the prune's end to its actor however its task ends, a panic included: the actor never waits on a prune that is gone.
struct PruneEnding(Option<mpsc::UnboundedSender<JobDone>>);

impl PruneEnding {
    /// The listing answered: the prune goes on with `candidates`, or ends with none.
    fn listed(mut self, candidates: Vec<std::path::PathBuf>) {
        if !candidates.is_empty()
            && let Some(jobs) = self.0.take()
        {
            let _ = jobs.send(JobDone::PruneListed(candidates));
        }
    }
}

impl Drop for PruneEnding {
    fn drop(&mut self) {
        if let Some(jobs) = self.0.take() {
            let _ = jobs.send(JobDone::Pruned);
        }
    }
}

/// A prune off the actor: `candidates` against `held` and the stored transcript, then against what [`judged`] reads under the
/// actor's grant; the sessions whose reference set was not known are read after.
async fn prune(
    deps: Arc<SessionDeps>,
    thread: ThreadId,
    jobs: mpsc::UnboundedSender<JobDone>,
    candidates: Vec<std::path::PathBuf>,
    held: Held,
    cancel: CancellationToken,
) {
    let rows = tokio::select! {
        biased;
        () = cancel.cancelled() => return,
        rows = super::super::run::read_context(&deps.store, &deps.lanes, &thread) => rows,
    };
    let Ok(rows) = rows else { return };
    let (unknown_tx, unknown) = oneshot::channel();
    let copies = Box::pin(judged(deps.clone(), thread.clone(), jobs.clone(), cancel.clone(), unknown_tx));
    deps.compaction.prune_offloads(&thread, candidates, held.lists(rows), copies).await;
    if let Ok(unknown) = unknown.await {
        scan_unknown(&deps, &thread, unknown, &jobs, &cancel).await;
    }
}

/// What the engine judges the deletes by besides what the prune gave it (`OffloadCopies`), awaited only once an old sidecar
/// none of that keeps remains: every copy's stored transcript, then, under the actor's grant, what the session holds and
/// stores at that moment. `None` deletes nothing: a copy cannot be read or is not known yet (`unknown` takes those sessions),
/// the prune was cancelled, or the actor refused.
async fn judged(
    deps: Arc<SessionDeps>,
    thread: ThreadId,
    jobs: mpsc::UnboundedSender<JobDone>,
    cancel: CancellationToken,
    unknown: oneshot::Sender<Vec<(String, i64)>>,
) -> Option<String> {
    let copies = tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        copies = copy_transcripts(&deps, &thread, unknown) => copies,
    }?;
    let (grant, granted) = oneshot::channel();
    jobs.send(JobDone::PruneGrant(grant)).ok()?;
    let held = granted.await.ok().flatten()?;
    let rows = tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        rows = super::super::run::read_context(&deps.store, &deps.lanes, &thread) => rows.ok(),
    }?;
    Some(format!("{}{copies}", held.lists(rows)))
}

async fn copy_transcripts(deps: &SessionDeps, own: &ThreadId, unknown: oneshot::Sender<Vec<(String, i64)>>) -> Option<String> {
    let skipped = |why: String| {
        tracing::warn!(thread = own.as_str(), "offload prune skipped: {why}");
        None
    };
    let found = match deps.store.copies_of(own).await {
        Ok(found) => found,
        Err(error) => return skipped(format!("the copies of the conversation could not be listed: {error:?}")),
    };
    if let Some(session) = found.unreadable {
        deps.notices.offload_prune_blocked(&session);
        return skipped(format!("the session {session} cannot be read"));
    }
    if let Some((first, _)) = found.unknown.first() {
        let why = format!("the reference set of the session {first} is not known ({} such sessions): they are read first", found.unknown.len());
        let _ = unknown.send(found.unknown);
        return skipped(why);
    }
    let mut out = Vec::new();
    for copy in found.copies {
        match stored_messages(deps, &ThreadId::from(copy.clone())).await {
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

/// A cancelled prune stops at the next session: the next prune reads the rest.
async fn scan_unknown(deps: &SessionDeps, own: &ThreadId, unknown: Vec<(String, i64)>, jobs: &mpsc::UnboundedSender<JobDone>, cancel: &CancellationToken) {
    let before = unknown.len();
    for (session, ordinal) in unknown.into_iter().take(OFFLOAD_SCAN_BATCH) {
        if cancel.is_cancelled() {
            return;
        }
        match stored_messages(deps, &ThreadId::from(session.clone())).await {
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
    if deps.store.copies_of(own).await.is_ok_and(|after| after.unknown.len() < before) {
        let (told, _) = oneshot::channel();
        let _ = jobs.send(JobDone::PruneOffloads(told));
    }
}

impl SessionActor {
    /// `pruneCompactedOffloads(session)`: a session that is not idle (`isSessionCompactionBlocked`) or leaves memory is not
    /// pruned now; else its sidecars are listed off the actor (`pruneOffloadSession`'s `readdir`, while the session takes
    /// messages as Node's does), and `prune_listed` decides. One asked for while a prune runs runs after it. `told` once the
    /// prune ran or was left to the turn's end; an actor that is gone drops it, which answers the commit as well.
    pub(super) fn prune_offloads(&mut self, told: oneshot::Sender<()>) {
        if self.prunes.running.is_some() {
            self.prunes.waiting.push(told);
            return;
        }
        self.begin_prune(vec![told]);
    }

    fn begin_prune(&mut self, told: Vec<oneshot::Sender<()>>) {
        if self.compaction_blocked() || self.unload_due {
            self.defer_prune();
            for told in told {
                let _ = told.send(());
            }
            return;
        }
        self.prune_deferred = false;
        let cancel = CancellationToken::new();
        self.prunes.running = Some(Prune { cancel: cancel.clone(), holds: false, told });
        let (engine, thread, ending) = (self.deps.compaction.clone(), self.id.clone(), PruneEnding(Some(self.jobs_tx.clone())));
        tokio::spawn(async move {
            let candidates = tokio::select! {
                biased;
                () = cancel.cancelled() => Vec::new(),
                candidates = engine.offload_candidates(&thread) => candidates,
            };
            ending.listed(candidates);
        });
    }

    /// The thread is open: its tool-result directory is reconciled with what is stored now, as every prune
    /// (`reconcileOffloadsOnResume`).
    pub(super) fn reconcile_offloads(&mut self) {
        let (told, _) = oneshot::channel();
        self.prune_offloads(told);
    }

    /// The prune under way listed its sidecars: what only the actor holds is taken here; the stored transcript, every copy's
    /// and the deletes are read and done off the actor, the deletes only once the actor grants them. A record released
    /// meanwhile is read from the store, which the scan reads after this.
    pub(super) fn prune_listed(&mut self, candidates: Vec<std::path::PathBuf>) {
        let Some(cancel) = self.prunes.running.as_ref().map(|prune| prune.cancel.clone()) else { return };
        if cancel.is_cancelled() || self.compaction_blocked() || self.unload_due {
            self.defer_prune();
            return self.pruned();
        }
        let held = self.prune_held();
        let (deps, thread, jobs) = (self.deps.clone(), self.id.clone(), self.jobs_tx.clone());
        let ending = PruneEnding(Some(jobs.clone()));
        tokio::spawn(async move {
            prune(deps, thread, jobs, candidates, held, cancel).await;
            drop(ending);
        });
    }

    fn prune_held(&self) -> Held {
        let queued = self.projected.queue.iter().map(|queued| queued.entry.clone());
        Held {
            header: self.projected.header.clone(),
            queued: queued.chain(self.deferred_start.as_ref().map(|start| start.body.clone())).chain(self.submission_lookup.clone()).collect(),
            unreleased: self.outbox.records().filter_map(|record| serde_json::to_value(record).ok()).collect(),
        }
    }

    /// The prune under way asks for its deletes: granted, with what the session holds now, while the session is idle and stays
    /// (`isSessionCompactionBlocked`). From then until the prune ends no message is taken and no turn starts, so the deletes
    /// are judged by the session's state as they are made. One refused waits for the turn's end.
    pub(super) fn prune_grant(&mut self, grant: oneshot::Sender<Option<Held>>) {
        let live = self.prunes.running.as_ref().is_some_and(|prune| !prune.cancel.is_cancelled());
        if !live || self.compaction_blocked() || self.unload_due {
            self.defer_prune();
            let _ = grant.send(None);
            return;
        }
        let held = self.prune_held();
        if let Some(prune) = self.prunes.running.as_mut() {
            prune.holds = true;
        }
        let _ = grant.send(Some(held));
    }

    /// The prune under way ended: it tells its waiters, and one asked for meanwhile runs.
    pub(super) fn pruned(&mut self) {
        let Some(mut prune) = self.prunes.running.take() else { return };
        for told in std::mem::take(&mut prune.told) {
            let _ = told.send(());
        }
        let waiting = std::mem::take(&mut self.prunes.waiting);
        if !waiting.is_empty() {
            self.begin_prune(waiting);
        }
    }

    /// The deletes of the prune under way were granted ([`Self::prune_grant`]).
    pub(super) fn prune_holds(&self) -> bool {
        self.prunes.running.as_ref().is_some_and(|prune| prune.holds)
    }

    pub(super) fn pruning(&self) -> bool {
        self.prunes.running.is_some()
    }

    /// The session leaves memory or closes: the prune under way is cancelled (deletes already granted are made) and those
    /// asked for are told, none run. Whether one is still under way, which the session waits for: nothing a prune holds
    /// outlives it, and a later load of the thread never prunes beside it.
    pub(super) fn end_prunes(&mut self) -> bool {
        for told in self.prunes.waiting.drain(..) {
            let _ = told.send(());
        }
        self.prunes.running.as_ref().inspect(|prune| prune.cancel.cancel()).is_some()
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
