//! Prompt history persistence, redaction and archive display.

use super::*;

impl SessionActor {
    pub(super) fn load_persisted_prompts(&mut self) {
        let prompts = self.deps.prompts.clone();
        let jobs = self.jobs_tx.clone();
        let cwd = self.cwd();
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "prompt-history-load",
            // Never cancelled: nothing ends the load early; the actor takes its answer whenever it comes.
            &CancellationToken::new(),
            move |lane| prompts.load(lane, &cwd),
            move |loaded| match loaded {
                Ok(list) => drop(jobs.send(JobDone::PromptPersisted(list))),
                Err(error) => tracing::warn!("the persisted prompt history was not read: {error:?}"),
            },
        );
    }

    /// `appendPromptHistory(cwd, text)` for a user-submitted prompt, off the actor.
    pub(super) fn persist_prompt(&mut self, prompt: String) {
        if prompt_history::key(&prompt).is_empty() {
            return;
        }
        let next = self.prompt_appends.push(prompt);
        self.run_prompt_step(next);
    }

    pub(super) fn run_prompt_step(&mut self, next: prompt_history::Next) {
        match next {
            prompt_history::Next::Idle => {}
            prompt_history::Next::Flush(batch) => self.flush_prompts(batch),
            prompt_history::Next::Wait { epoch, delay } => {
                #[cfg(any(test, feature = "test-support"))]
                self.cell.prompt_timers.fetch_add(1, SeqCst);
                let jobs = self.jobs_tx.downgrade();
                // The wait starts as it is armed, as Node's `setTimeout` does, not when the task first runs.
                let due = mixdog_rt::time::sleep(delay);
                drop(tokio::spawn(async move {
                    due.await;
                    let Some(jobs) = jobs.upgrade() else { return };
                    let _ = jobs.send(JobDone::PromptRetryDue(epoch));
                }));
            }
        }
    }

    /// Appends `batch` (oldest first) to the persisted history, stopping at the first that does not
    /// land. What did not land comes back to the queue, which retries it on Node's backoff: a prompt
    /// is not lost because the lane refused the job or the write failed. A job that never ran
    /// (`JobDropped`) wrote nothing, so retrying it duplicates nothing.
    pub(super) fn flush_prompts(&mut self, batch: Vec<String>) {
        let (prompts, jobs, cwd, lanes) = (self.deps.prompts.clone(), self.jobs_tx.clone(), self.cwd(), self.deps.lanes);
        let (marks, thread) = (self.deps.sensitive.clone(), self.id.clone());
        drop(mixdog_rt::spawn("prompt-history-append", TaskClass::Work, async move {
            let kept = batch.clone();
            let submitted = lanes
                .durability
                .submit_wait(&CancellationToken::new(), move |lane| {
                    let mut list = None;
                    for (at, text) in batch.iter().enumerate() {
                        // A value the thread marked sensitive is stored as the marker, as in its log.
                        let done = prompts.append(lane, &cwd, &marks.redact_text(&thread, text));
                        list = Some(done.list);
                        if !done.written {
                            return (list, batch[at..].to_vec());
                        }
                    }
                    (list, Vec::new())
                })
                .await;
            let (list, unwritten) = match submitted {
                Ok(job) => job.await.unwrap_or((None, kept)),
                Err(_) => (None, kept),
            };
            let _ = jobs.send(JobDone::PromptFlushed { list, unwritten });
        }));
    }

    /// A mark: the cwd's persisted prompt history keeps the marked values as the marker, entries written before included.
    /// The lists the thread holds go the same way, so the history a client is sent after the mark carries the marker only.
    /// A prompt list with this thread's marks applied.
    pub(super) fn redacted_prompts(&self, list: &[String]) -> Vec<String> {
        list.iter().map(|text| self.deps.sensitive.redact_text(&self.id, text)).collect()
    }

    /// The session's prompt list (newest first) with the marks applied; oldest first into `recompute`, so two entries the
    /// marker made equal keep the newer one.
    pub(super) fn redacted_session_prompts(&self, list: &[String]) -> Vec<String> {
        prompt_history::recompute(&self.redacted_prompts(list).into_iter().rev().collect::<Vec<_>>())
    }

    pub(super) fn redact_prompts(&mut self) {
        let (prompts, cwd, marks, thread) = (self.deps.prompts.clone(), self.cwd(), self.deps.sensitive.clone(), self.id.clone());
        let session = self.redacted_session_prompts(&self.acked.prompt_session);
        let persisted = self.redacted_prompts(&self.acked.prompt_persisted);
        if session != self.acked.prompt_session {
            self.accept_view(Change::PromptSession { session, publish: true }, Vec::new());
        }
        if persisted != self.acked.prompt_persisted {
            self.accept_view(Change::PromptPersisted(persisted), Vec::new());
        }
        // The mark's rewrite of the persisted history waits out a full lane; it is not lost to one.
        mixdog_core_base::support::lane_job(
            self.deps.lanes.durability,
            "prompt-history-redact",
            // Never cancelled: the mark's rewrite of the persisted history must happen.
            &CancellationToken::new(),
            move |lane| prompts.redact(lane, &cwd, &|text| marks.redact_text(&thread, text)),
            |done| {
                if let Err(error) = done {
                    tracing::warn!("the persisted prompt history was not rewritten for a mark: {error:?}");
                }
            },
        );
    }

    pub(super) fn recompute_prompts(&mut self, publish: bool) {
        let deps = self.deps.clone();
        let jobs = self.jobs_tx.clone();
        let thread = self.id.clone();
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "prompt-history-recompute",
            // Never cancelled: nothing ends the recompute early; the actor takes its answer whenever it comes.
            &CancellationToken::new(),
            move |lane| {
                let rows = deps.store.user_rows(lane, &thread).ok()?;
                let texts: Vec<String> = rows.iter().filter_map(|row| row.prompt_text().map(str::to_owned)).collect();
                Some(prompt_history::recompute(&texts))
            },
            move |read| match read {
                Ok(Some(session)) => drop(jobs.send(JobDone::PromptSession { session, publish })),
                Ok(None) => {}
                Err(error) => tracing::warn!("the session's prompt history was not recomputed: {error:?}"),
            },
        );
    }

    /// The session part over the remaining lineage after a history mutation.
    /// Reads which rows of the window the compactions took out of the model context, as the index says of a reopened
    /// window (`ThreadStore::window_archived`): the one verdict, so a live row and its reopened copy show the same.
    pub(super) fn mark_archived(&mut self) {
        let deps = self.deps.clone();
        let jobs = self.jobs_tx.clone();
        let thread = self.id.clone();
        mixdog_core_base::support::lane_job(
            self.deps.lanes.io,
            "compaction-archived-rows",
            // Never cancelled: nothing ends the read early; the actor takes its answer whenever it comes.
            &CancellationToken::new(),
            move |lane| deps.store.window_archived(lane, &thread),
            move |read| match read {
                Ok(Ok(ordinals)) => drop(jobs.send(JobDone::Archived(ordinals))),
                Ok(Err(error)) => tracing::warn!("the rows a compaction took out of the context were not read, so they show as live until a reopen: {error:?}"),
                Err(error) => tracing::warn!("the rows a compaction took out of the context were not read, so they show as live until a reopen: {error:?}"),
            },
        );
    }

    /// The rows in view of the records `ordinals` show `archived`; a client hears each as its item, completed again.
    pub(super) fn show_archived(&mut self, ordinals: Vec<u64>) {
        // The acked window: a row has its record's ordinal once it is acked, and only an acked row is older than the compaction.
        let notes: Vec<Note> = self
            .acked
            .window
            .iter()
            .filter(|row| row.ordinal.is_some_and(|ordinal| ordinals.contains(&ordinal)))
            .filter(|row| !super::super::view::meta(&row.item).ext.contains_key("archived"))
            .map(|row| {
                let mut item = (*row.item).clone();
                super::super::view::meta_mut(&mut item).ext.insert("archived".into(), Value::Bool(true));
                // A positioned subscription is sent no row by this: the ranges it holds are read again once the
                // compaction is stored (`units.rs`), in the actor's window or not.
                Note::new("item/completed", &ItemNotificationParams { thread_id: self.id.clone(), turn_id: TurnId::from(""), item, room_view: None })
            })
            .collect();
        if notes.is_empty() {
            return;
        }
        self.accept_view(Change::Archived(ordinals), notes);
    }
}
