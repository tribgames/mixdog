use super::*;
use crate::actions::diagnostics;
use crate::actions::forms;
use crate::actions::navigation::NavigateCall;
use crate::actions::navigation::NavigateOutcome;
use crate::actions::observe::LocateInput;
use crate::actions::observe::ShotPorts;
use crate::actions::observe::SnapshotPlan;
use crate::actions::target::ActionContext;
use crate::actions::target::ActionOutput;
use crate::actions::target::adopt_resolved_targets;
use crate::actions::target::snapshot_of_ref;
use crate::actions::upload::UploadTarget;
use crate::approval::classify::origin_of_url;
use crate::ledger::ingest::PageLedgers;
use crate::limits::CUSTOM_DROPDOWN_POLL;
use crate::limits::CUSTOM_DROPDOWN_TIMEOUT;
use crate::limits::DIALOG_TOLERANT_ACTIONS;
use crate::limits::READ_MAX_CHARS;
use crate::limits::SNAPSHOT_MAX_ELEMENTS;
use crate::limits::SNAPSHOT_TEXT_CHARS;
use crate::limits::SNAPSHOT_TOOL_MAX_ELEMENTS;
use crate::refs::access::ActionabilityReason;
use crate::refs::ref_actions::RefActions;
use crate::refs::reply_recovery::RefRecoveryContext;
use crate::refs::reply_recovery::decorate_recovery;
use crate::refs::target_resolve::ResolvedTarget;
use crate::refs::target_resolve::TargetContext;
use crate::refs::target_resolve::TargetError;
use crate::refs::target_resolve::resolve_targets;
use crate::reply::reply::EffectBaseline;
use crate::reply::reply::ReplyContext;
use crate::reply::reply::ReplyEffect;
use crate::reply::reply::ReplyPage;
use crate::reply::reply::ReplyRequest;
use crate::reply::reply::SnapshotCapture;
use crate::reply::reply::build_reply;
use crate::reply::reply::page_report_text;
use crate::reply::screenshot::ImageOutput;
use crate::reply::screenshot::ScreenshotInput;
use crate::reply::screenshot::attach_screenshot;
use crate::reply::screenshot::read_capture;
use crate::reply::snapshot_format::SnapshotDiagnostics;
use crate::reply::snapshot_format::SnapshotExtras;
use crate::reply::snapshot_format::format_snapshot;
use crate::settle::actionability::ACTIONABILITY_TIMEOUT;
use crate::settle::actionability::ActionabilityError;
use crate::settle::actionability::ProbeFailure;
use crate::settle::actionability::wait_for_actionable;
use crate::settle::reply_wait::ReplyWaitOptions;
use crate::settle::reply_wait::await_reply_ready;
use crate::settle::reply_wait::postcondition_matches_page;
use crate::settle::settle::AfterAction;
use crate::settle::settle::SettlePolicy;
use crate::settle::settle::StepKind;
use crate::settle::settle::settle_after_action;
use crate::settle::settle::step_settle_result;
use mixdog_browser_policy::timing::Phase;

impl PageCtx {
    pub(super) fn host(&self) -> &dyn BrowserHost {
        &*self.inner.host
    }

    pub(super) fn session(&self) -> &str {
        self.thread.as_str()
    }

    pub(super) fn token(&self) -> &CancellationToken {
        self.cancel.token()
    }

    pub(super) fn settle_page(&self) -> Page<'_> {
        Page { host: self.host(), id: &self.page_id, probe: self }
    }

    /// The page's present facts, as the host last said them.
    pub(super) fn page_facts(&self) -> PageFacts {
        self.inner.store.get(&self.page_id).unwrap_or_else(|| gone_facts(&self.page_id))
    }

    pub(super) fn state_lock(&self) -> MutexGuard<'_, SlotState> {
        locked(&self.slot.state)
    }

    /// The text as the agent may read it: the patterns of `redact_browser_text`, then what the session filled into pages.
    pub(super) fn redact(&self, text: &str) -> String {
        self.inner.ports.secrets.redact(self.session(), &redact_browser_text(text))
    }

    /// The latest observation; one of a document that has since been replaced holds no refs.
    pub(super) fn latest_refs(&self) -> Option<RefSet> {
        let document_id = self.page_facts().document_id;
        let mut state = self.state_lock();
        if let Some(refs) = state.refs.as_mut() {
            refs.invalidate_on(&document_id);
        }
        state.refs.clone()
    }

    pub(super) fn page_precondition(&self) -> Precondition {
        let facts = self.page_facts();
        let origin = origin_of_url(&facts.url);
        Precondition {
            document_id: facts.document_id.clone(),
            origin: (!origin.is_empty()).then_some(origin),
            url: (!facts.url.is_empty()).then(|| facts.url.clone()),
            child_sessions: Some(facts.child_sessions.iter().map(|child| child.session_id.clone()).collect()),
            receiver_key: None,
            snapshot_id: self.latest_refs().map(|refs| refs.snapshot_id),
        }
    }

    /// The wire has no guard without a document, so a move between documents names only the document.
    pub(super) fn navigation_precondition(&self) -> Precondition {
        Precondition { document_id: self.page_facts().document_id, origin: None, url: None, child_sessions: None, receiver_key: None, snapshot_id: None }
    }

    /// The URL policy a navigation is decided under: the engine's own, or (a test build only) the one a test run names for the
    /// command (`UrlPolicyOfRun`).
    pub(super) fn urls(&self) -> mixdog_browser_policy::url_policy::UrlPolicy {
        #[cfg(feature = "test-support")]
        if let Some(named) = locked(&URL_POLICY_OF_RUN).clone() {
            return named;
        }
        self.inner.ports.urls.clone()
    }

    /// One move, decided against the document the page holds now.
    pub(super) async fn move_once(&self, action: Action, command: &Value) -> Result<NavigateOutcome, observe::ActionError> {
        let precondition = self.navigation_precondition();
        let call = NavigateCall { host: self.host(), page_id: &self.page_id, expect: &precondition, cancel: &self.cancel };
        if action == Action::Back { navigation::back(&call).await } else { navigation::navigate(&call, command, &self.urls(), wall_clock_ms()).await }
    }

    /// The move, sent once more when the host refused the document it named. The refusal sent nothing and told the page's present
    /// facts (the lane keeps them): the page replaced its document meanwhile (a tab this command opened starting its first blank load,
    /// a redirect), and a move has no earlier document to protect. A second refusal is the failure.
    pub(super) async fn moved(&self, action: Action, command: &Value) -> Result<NavigateOutcome, observe::ActionError> {
        match self.move_once(action, command).await {
            Err(observe::ActionError::Host(HostCallError::PreconditionFailed { .. })) => self.move_once(action, command).await,
            outcome => outcome,
        }
    }

    pub(super) fn invalidate(&self) {
        let mut state = self.state_lock();
        state.refs = None;
        state.grounding = None;
    }

    /// Runs `read` on the page's ledgers (a page the mirror never heard of reads empty ones).
    pub(super) fn with_ledgers<R>(&self, read: impl FnOnce(&mut PageLedgers) -> R) -> R {
        let mut pending = Some(read);
        let mut done: Option<R> = None;
        self.inner.ports.mirror.with_ledgers(&self.page_id, |ledgers| {
            if let Some(read) = pending.take() {
                done = Some(read(ledgers));
            }
        });
        match (done, pending) {
            (Some(value), _) => value,
            (None, Some(read)) => read(&mut PageLedgers::new(Arc::new(|text: &str| redact_browser_text(text)))),
            (None, None) => unreachable!("a read runs on the ledgers or on empty ones"),
        }
    }

    pub(super) fn call(&self) -> page::PageCall<'_> {
        page::PageCall { host: self.host(), page_id: &self.page_id, cancel: self.token() }
    }

    pub(super) fn observe_call<'a>(&'a self, expect: Option<&'a Precondition>) -> observe::PageCall<'a> {
        observe::PageCall { host: self.host(), page_id: &self.page_id, expect, cancel: &self.cancel }
    }

    /// One sign-in question to the host about this page. The hooks add to a command that already ran, so a host that cannot answer
    /// them (a failure of its own) says nothing; a command the caller cancelled, or a person who took the page, still ends it.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn sign_in(
        &self,
        op: BrowserSignInOp,
        action: Option<&str>,
        command: Option<Value>,
        explicit_fill: Option<bool>,
    ) -> Result<Option<HostBrowserSignInResult>, RunError> {
        let params = HostBrowserSignInParams {
            session_id: self.session().to_owned(),
            page_id: self.page_id.clone(),
            op,
            turn: i64::try_from(self.turn).ok(),
            action: action.map(str::to_owned),
            command,
            explicit_fill,
        };
        match self.host().sign_in(params, self.token()).await {
            Ok(said) => Ok(Some(said)),
            Err(error @ (HostCallError::Cancelled | HostCallError::UserInput { .. })) => Err(error.into()),
            Err(_) => Ok(None),
        }
    }

    /// Before a click, fill or type is sent (`linkedSignIn.beforeAction`): the host notes which field of a provider's sign-in the agent is
    /// about to name, from the command's own `ref`, `target`, `text` and `fields`.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn before_action(&self, action: Action, command: &Value) -> Result<(), RunError> {
        if !matches!(action, Action::Click | Action::Fill | Action::Type) {
            return Ok(());
        }
        let named: Map<String, Value> =
            ["ref", "target", "text", "fields"].into_iter().filter_map(|key| command.get(key).map(|value| (key.to_owned(), value.clone()))).collect();
        self.sign_in(BrowserSignInOp::BeforeAction, Some(action.name()), Some(Value::Object(named)), None).await?;
        Ok(())
    }

    /// After the action: a page that asks for a sign-in a saved login fits is signed in by the host once per site and turn, and its
    /// note leads a fresh observation that replaces the reply (`autoSignIn.afterCommand`); the identity a provider flow last used
    /// is a line ahead of the reply (`linkedSignIn.replyLine`). An `open` answers with its placement, the note and the line.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn after_command(
        &self,
        action: Action,
        background: bool,
        placement: Option<BrowserPlacement>,
        hints: &SignInHints,
        mut reply: ToolReply,
    ) -> Result<ToolReply, RunError> {
        let said = self.sign_in(BrowserSignInOp::AfterCommand, None, None, Some(hints.explicit_fill)).await?;
        let note = said.as_ref().and_then(|said| said.note.clone()).filter(|note| !note.is_empty());
        let line = said.as_ref().and_then(|said| said.line.clone()).filter(|line| !line.is_empty());
        if action == Action::Open && !background {
            // An open always answers with its placement: exactly one of shown or pending (a failure to place is thrown).
            let placed = placement_line(&self.page_facts(), placement)?;
            reply.text = self.redact(&[Some(placed), note, line].into_iter().flatten().collect::<Vec<_>>().join("\n\n"));
            return Ok(reply);
        }
        if let Some(note) = &note {
            let mut observe = json!({"action": "snapshot"});
            if let Some(max_chars) = &hints.max_chars {
                observe["maxChars"] = max_chars.clone();
            }
            self.invalidate();
            let after = match self.snapshot_reply(&observe, &ReplyOptions::default()).await {
                Ok(after) => after,
                Err(RunError::Reply(after)) => *after,
                Err(error) => return Err(error),
            };
            reply = ToolReply { text: format!("{note}\n\n{}", after.text), ..after };
        }
        if let Some(line) = &line {
            reply.text = format!("{line}\n\n{}", reply.text);
        }
        if note.is_some() || line.is_some() {
            reply.text = self.redact(&reply.text);
        }
        Ok(reply)
    }

    /// The session's download ledger as the host keeps it; a reply is still given when it cannot be read.
    pub(super) async fn session_downloads(&self) -> Vec<DownloadItem> {
        let params = HostBrowserDownloadsParams { session_id: self.session().to_owned(), op: BrowserDownloadsOp::List, since: None, id: None };
        self.host().downloads(params, self.token()).await.map(|answer| answer.items).unwrap_or_default()
    }

    pub(super) fn snapshot_params(&self, command: &Value) -> HostBrowserSnapshotParams {
        let query = command.get("query").and_then(Value::as_str).map(|query| mixdog_js::js_trim(query).to_owned()).filter(|query| !query.is_empty());
        let mode = if command.get("viewportOnly") == Some(&Value::Bool(true)) {
            BrowserSnapshotMode::Viewport
        } else if query.is_some() {
            BrowserSnapshotMode::Query
        } else {
            BrowserSnapshotMode::Full
        };
        let max_elements = command.get("maxElements").filter(|value| truthy(Some(value))).and_then(Value::as_f64).filter(|number| number.is_finite());
        let max_elements = max_elements.map_or(SNAPSHOT_MAX_ELEMENTS as i64, |number| number.trunc() as i64).clamp(1, SNAPSHOT_TOOL_MAX_ELEMENTS as i64);
        // An evaluate's reply keeps page text short: the script result already occupies it.
        let text_chars = if command.get("action").and_then(Value::as_str) == Some("evaluate") {
            SNAPSHOT_TEXT_CHARS as i64
        } else {
            bounded(command.get("maxChars"), SNAPSHOT_TEXT_CHARS as i64, 1, READ_MAX_CHARS as i64)
        };
        HostBrowserSnapshotParams {
            page_id: self.page_id.clone(),
            mode,
            query,
            max_elements: u32::try_from(max_elements).ok(),
            text_chars: u32::try_from(text_chars).ok(),
            frame: None,
        }
    }

    /// The snapshot as a reply shows it, for a covered element's refusal and a recovery's report.
    pub(super) fn format_snapshot_text(&self, snapshot: &HostBrowserSnapshotResult) -> String {
        let facts = self.page_facts();
        self.with_ledgers(|ledgers| {
            let mut diagnostics = SnapshotDiagnostics {
                pending_dialog: facts.pending_dialog.as_ref(),
                dismissed_dialog: None,
                pending_file_chooser: facts.pending_file_chooser.as_ref(),
                ledgers,
            };
            self.redact(&format_snapshot(&snapshot.payload, &mut diagnostics, &SnapshotExtras { downloads: &[], brief_against: None }))
        })
    }

    fn with_reply_page<R>(&self, facts: &PageFacts, downloads: &[DownloadItem], f: impl FnOnce(&mut ReplyPage<'_>) -> R) -> R {
        let mut state = self.state_lock();
        let SlotState { reply, .. } = &mut *state;
        let mut all_reports = locked(&self.inner.download_reports);
        let reports = all_reports.entry(self.session().to_owned()).or_default();
        let mut page = ReplyPage { facts, state: reply, downloads, download_reports: reports, now_ms: wall_clock_ms() };
        let out = f(&mut page);
        if page.download_reports.is_empty() {
            all_reports.remove(self.session());
        }
        out
    }

    /// What this page's reply has not said yet, without a snapshot (`reportPage`); empty when nothing is new.
    pub(super) fn page_report(&self, downloads: &[DownloadItem]) -> String {
        let facts = self.page_facts();
        let redact = |text: &str| self.redact(text);
        let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
        self.with_reply_page(&facts, downloads, |page| self.with_ledgers(|ledgers| page_report_text(&ctx, page, ledgers)))
    }

    /// The handles one command acts on its page's elements with.
    pub(super) fn ref_actions(&self) -> RefActions {
        let host: Arc<dyn BrowserHost> = self.inner.host.clone();
        let redacting = self.clone();
        let formatting = self.clone();
        let secrets = self.inner.ports.secrets.clone();
        let session = self.session().to_owned();
        RefActions {
            host,
            page_id: self.page_id.clone(),
            expect: self.page_precondition(),
            cancel: self.cancel.clone(),
            redact: Arc::new(move |text: &str| redacting.redact(text)),
            remember_secret: Arc::new(move |secret: &str| secrets.remember(&session, secret)),
            format_snapshot: Arc::new(move |snapshot: &HostBrowserSnapshotResult| formatting.format_snapshot_text(snapshot)),
            dropdown_timeout: CUSTOM_DROPDOWN_TIMEOUT,
            dropdown_poll: CUSTOM_DROPDOWN_POLL,
            timer: Some(self.timer.clone()),
        }
    }

    /// Every target resolved against ONE fresh observation, waiting out a target that matched nothing yet (`resolveTargetRefs`).
    pub(super) async fn resolve_targets(&self, raw: &[Value]) -> Result<Vec<ResolvedTarget>, ActionError> {
        let expect = self.page_precondition();
        let (host, cancel, page_id) = (self.host(), &self.cancel, self.page_id.as_str());
        let expect_ref = &expect;
        let resolved = self
            .timer
            .phase(
                Phase::Target,
                wait_for_actionable(
                    move || async move {
                        let target = TargetContext { host, page_id, expect: Some(expect_ref), cancel: cancel.token() };
                        resolve_targets(&target, raw).await.map_err(|error| match error {
                            TargetError::Missing(message) => ProbeFailure::NotActionable(ActionabilityError::new(message, ActionabilityReason::Missing)),
                            other => ProbeFailure::Other(other),
                        })
                    },
                    cancel,
                    ACTIONABILITY_TIMEOUT,
                ),
            )
            .await?;
        self.register_minted(&resolved);
        Ok(resolved)
    }

    /// The selector matches this resolution minted refs for join the page's ref set (the one the page reports against, and the
    /// snapshot's own in the store).
    pub(super) fn register_minted(&self, resolved: &[ResolvedTarget]) {
        for (snapshot_id, minted) in resolved.iter().fold(Vec::<(&str, Vec<BrowserSnapshotElement>)>::new(), |mut grouped, target| {
            if let Some(element) = &target.minted {
                match grouped.iter_mut().find(|(id, _)| *id == target.snapshot_id) {
                    Some((_, elements)) => elements.push(element.clone()),
                    None => grouped.push((target.snapshot_id.as_str(), vec![element.clone()])),
                }
            }
            grouped
        }) {
            self.inner.store.register_minted(&self.page_id, snapshot_id, &minted);
            let Some(joined) = self.inner.store.snapshot(&self.page_id, snapshot_id) else { continue };
            let mut state = self.state_lock();
            if let Some(held) = state.refs.as_mut().filter(|held| held.snapshot_id == snapshot_id && held.len() != joined.refs.len()) {
                *held = joined.refs.clone().with_observation(held.observation.as_deref());
            }
        }
    }

    // the reply

    /// The reply of a command that observed the page (`snapshotResult`): the page settled, its postcondition verified, a snapshot
    /// taken and put into words, and the screenshot the command asked for bound to it.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn snapshot_reply(&self, command: &Value, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        let action = text_of(command.get("action"));
        let blocked = |facts: &PageFacts| facts.pending_dialog.as_ref().map(|dialog| blocking_dialog_reply(dialog, true, &|text: &str| self.redact(text)));
        if let Some(reply) = blocked(&self.page_facts()) {
            return Ok(reply);
        }
        let wait_options = ReplyWaitOptions {
            settle_action: options.settle_action,
            preexisting_postcondition: options.preexisting,
            baseline_url: options.baseline.as_ref().map(|refs| refs.url.clone()),
            expected: Some(options.expected.clone()),
        };
        let wait = self
            .timer
            .phase(
                Phase::Wait,
                await_reply_ready(&self.settle_page(), &SettlePolicy::default(), command.get("settleMs"), command.get("expect"), &wait_options, &self.cancel),
            )
            .await?;
        let facts = self.page_facts();
        if let Some(reply) = blocked(&facts) {
            return Ok(reply);
        }
        if let Some(fault) = facts.fault.as_deref().filter(|fault| !fault.is_empty()) {
            return Err(RunError::Failed(format!("{fault}; navigate to reload this page or choose another tab")));
        }
        let params = self.snapshot_params(command);
        let result = self.timer.phase(Phase::Snapshot, self.host().snapshot(params, self.token())).await?;
        let refs = RefSet::from_payload(&result.snapshot_id, &result.payload)
            .with_document(&result.document_id, result.revision)
            .with_observation(result.observation.as_deref());
        {
            let mut state = self.state_lock();
            state.refs = Some(refs.clone());
            state.grounding = None;
            state.scroll_y = Some(result.payload.scroll_y);
        }
        let facts = self.page_facts();
        let downloads = self.session_downloads().await;
        let brief = command.get("brief") == Some(&Value::Bool(true));
        let brief_against = options.report_baseline.clone().or_else(|| options.baseline.clone());
        let request = ReplyRequest {
            action: &action,
            brief,
            brief_against: brief_against.as_ref(),
            effect: ReplyEffect {
                settle_ms: u64::try_from(wait.settle.as_millis()).ok(),
                expected: wait.expected.as_ref().map(|expected| describe(expected.expected())),
                postcondition_matched: wait.postcondition_matched,
                postcondition_elapsed_ms: u64::try_from(wait.postcondition_elapsed.as_millis()).unwrap_or(u64::MAX),
                preexisting_postcondition: options.preexisting,
                settle_action: options.settle_action,
                baseline: options.baseline.as_ref().map(EffectBaseline::of),
            },
        };
        let redact = |text: &str| self.redact(text);
        let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
        let capture = SnapshotCapture { payload: &result.payload, observation: result.observation.as_deref() };
        let mut reply = self.with_reply_page(&facts, &downloads, |page| {
            self.with_ledgers(|ledgers| finish_now(build_reply(&ctx, &request, page, ledgers, Some(capture), None)))
        })?;
        if command.get("includeScreenshot") == Some(&Value::Bool(true)) {
            self.attach_shot(command, &mut reply).await?;
        }
        Ok(reply)
    }

    /// The screenshot of the command, bound to the snapshot just taken; coordinate actions are then expressed in it.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn attach_shot(&self, command: &Value, reply: &mut ToolReply) -> Result<(), RunError> {
        let params = observe::screenshot_params(&self.page_id, command, self.background)?;
        let full_page = params.full_page == Some(true);
        let bound = self.latest_refs();
        let answer = self.timer.phase(Phase::Screenshot, self.host().screenshot(params, self.token())).await?;
        let capture = read_capture(&answer, full_page, &*self.inner.ports.blobs).await?;
        let latest = self.latest_refs();
        let input = ScreenshotInput {
            capture: &capture,
            bound: bound.as_ref(),
            latest: latest.as_ref(),
            output: ImageOutput::from_command(command.get("image_output").and_then(Value::as_str)),
            frame_dir: &self.inner.ports.frame_dir,
            now: std::time::Instant::now(),
        };
        attach_screenshot(&*self.inner.ports.files, reply, input).await?;
        self.state_lock().grounding = reply.grounding.clone();
        Ok(())
    }

    /// What follows a gesture: the settled snapshot reply, or, for a step of a sequence, only whether the page settled.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn settled(&self, command: &Value, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        if command.get("internalStep") != Some(&Value::Bool(true)) {
            return self.snapshot_reply(command, options).await;
        }
        let step = step_settle_result(&self.settle_page(), &SettlePolicy::default(), &self.cancel).await?;
        let outcome = match step.outcome {
            StepKind::Completed => ReplyOutcome::Completed,
            StepKind::Inconclusive => ReplyOutcome::Inconclusive,
            StepKind::Blocked => ReplyOutcome::Blocked,
        };
        Ok(ToolReply { text: step.text, outcome: Some(outcome), ..ToolReply::default() })
    }

    /// The reply of an action that is not an observation: its own lead, the recovery notes when it asked for them, the settled page.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn gesture_reply(
        &self,
        output: ActionOutput,
        command: &Value,
        recovery: &RefRecoveryContext,
        options: &ReplyOptions,
    ) -> Result<ToolReply, RunError> {
        self.timer.merge_input(&output.input);
        let mut reply = self.settled(command, options).await?;
        let text = if output.decorate_recovery { decorate_recovery(&reply.text, recovery) } else { reply.text.clone() };
        reply.text = format!("{}{text}", output.lead);
        Ok(reply)
    }

    // the actions

    /// What a page held by a dialog answers to an action that needs the page: input would queue behind the dialog and replay
    /// after handle_dialog.
    pub(super) fn dialog_block(&self, action: Action) -> Option<ToolReply> {
        if DIALOG_TOLERANT_ACTIONS.contains(&action.name()) {
            return None;
        }
        self.page_facts().pending_dialog.map(|dialog| blocking_dialog_reply(&dialog, false, &|text: &str| self.redact(text)))
    }

    /// One step of a sequence: the dialog's answer when the page is blocked, else the action.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn dispatch(
        &self,
        action: Action,
        command: Value,
        expected: Option<Postcondition>,
        has_screenshot_options: bool,
    ) -> Result<ToolReply, RunError> {
        match self.dialog_block(action) {
            Some(blocked) => Ok(blocked),
            None => self.act(action, command, expected, has_screenshot_options).await,
        }
    }

    /// `act` behind a box made in a frame that is gone when this returns (see `execute_resolved_boxed`).
    #[inline(never)]
    pub(super) fn act_boxed<'a>(
        &'a self,
        action: Action,
        command: Value,
        expected: Option<Postcondition>,
        has_screenshot_options: bool,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.act(action, command, expected, has_screenshot_options))
    }

    /// `after_command` behind a box made in a frame that is gone when this returns (see `execute_resolved_boxed`).
    #[inline(never)]
    pub(super) fn after_command_boxed<'a>(
        &'a self,
        action: Action,
        background: bool,
        placement: Option<BrowserPlacement>,
        hints: &'a SignInHints,
        reply: ToolReply,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.after_command(action, background, placement, hints, reply))
    }

    /// An upload resolves its real target before the person is asked: a `target` becomes the ref the handler then uses.
    async fn resolve_upload_target(&self, command: &mut Value, recovery: &mut RefRecoveryContext, baseline: &mut Option<RefSet>) -> Result<(), RunError> {
        let Some(target) = command.get("target").filter(|target| !target.is_null()).cloned() else { return Ok(()) };
        let resolved = self.resolve_targets(std::slice::from_ref(&target)).await?;
        let mut cx = ActionContext { host: self.host(), page: self, command, cancel: &self.cancel, recovery, effect_baseline: baseline };
        adopt_resolved_targets(&mut cx, &resolved);
        if let Some(first) = resolved.first() {
            command["ref"] = Value::String(first.ref_id.clone());
        }
        Ok(())
    }

    /// The action itself, on a page no dialog blocks for it.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn act(
        &self,
        action: Action,
        mut command: Value,
        expected: Option<Postcondition>,
        has_screenshot_options: bool,
    ) -> Result<ToolReply, RunError> {
        let internal = command.get("internalStep") == Some(&Value::Bool(true));
        let facts = self.page_facts();
        let mut recovery = RefRecoveryContext::new(self.latest_refs());
        let report_baseline = self.latest_refs();
        // The latest observation of this page is what the gesture starts from; a target resolution moves it to a fresher one.
        let mut baseline = self.latest_refs();
        let preexisting = match &expected {
            Some(condition) if action != Action::Navigate && facts.pending_dialog.is_none() => {
                postcondition_matches_page(&self.settle_page(), condition, &self.cancel).await?
            }
            _ => false,
        };
        if action == Action::Upload && !internal && !truthy(command.get("ref")) {
            self.resolve_upload_target(&mut command, &mut recovery, &mut baseline).await?;
        }
        let approved = if internal { None } else { self.inner.approve(&self.thread, &mut command, Some(self), &self.cancel, &self.user_wait).await? };
        self.before_action(action, &command).await?;
        let options = |settle_action: bool, baseline: &Option<RefSet>| ReplyOptions {
            expected: expected.clone(),
            preexisting,
            settle_action,
            baseline: baseline.clone(),
            report_baseline: report_baseline.clone(),
        };
        // Every arm that awaits is its own boxed call: a debug frame keeps a slot for each future the function builds, and the whole
        // match in this frame held about a megabyte on the stack of the worker thread (2 MB) for any action.
        match action {
            Action::Open => Ok(navigation::open(self.background)),
            Action::Snapshot => self.snapshot_boxed(&command).await,
            Action::Locate => self.locate_boxed(&command).await,
            Action::Read => self.read_boxed(&command).await,
            Action::Extract => self.extract_boxed(&command).await,
            Action::Status => Ok(self.with_ledgers(|ledgers| diagnostics::status(&facts, ledgers))),
            Action::Console => Ok(self.with_ledgers(|ledgers| diagnostics::console(ledgers, &command))?),
            Action::Network => self.network_boxed(&command).await,
            Action::Wait => self.wait_boxed(&command).await,
            Action::Navigate | Action::Back => self.navigate_boxed(action, &command, &options(true, &baseline)).await,
            Action::Evaluate => self.evaluate_boxed(&command, expected.is_some(), has_screenshot_options, &options(true, &baseline)).await,
            Action::Emulate => self.emulate_boxed(&command, &options(true, &baseline)).await,
            Action::Cookies => self.cookies_boxed(&command, &facts.url).await,
            Action::Storage => self.storage_boxed(&command).await,
            Action::Intercept => self.intercept_boxed(&command).await,
            Action::InitScript => self.init_script_boxed(&command).await,
            Action::Performance => self.performance_boxed(&command).await,
            Action::Click | Action::Hover | Action::Drag | Action::Press | Action::Scroll | Action::Sequence => {
                self.gesture_boxed(action, &command, &mut recovery, &mut baseline, &options).await
            }
            Action::Fill | Action::Type | Action::Select | Action::HandleDialog => {
                self.form_boxed(action, &command, &mut recovery, &mut baseline, &expected, preexisting, &report_baseline).await
            }
            Action::Upload => self.upload_boxed(&command, &facts, approved.as_ref(), &mut recovery, &mut baseline, &options).await,
            Action::ListTabs | Action::CloseTab | Action::Downloads | Action::Hide => {
                Err(RunError::Failed(format!("{} addresses the session, not a page", action.name())))
            }
        }
    }

    // The boxed arms of `act`: each builds its future in a frame that is gone when it returns (see `execute_resolved_boxed`).

    #[inline(never)]
    pub(super) fn snapshot_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.snapshot_action(command))
    }

    #[inline(never)]
    pub(super) fn locate_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.locate_action(command))
    }

    #[inline(never)]
    pub(super) fn network_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.network_action(command))
    }

    #[inline(never)]
    pub(super) fn navigate_boxed<'a>(&'a self, action: Action, command: &'a Value, options: &'a ReplyOptions) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.navigate_action(action, command, options))
    }

    #[inline(never)]
    pub(super) fn evaluate_boxed<'a>(
        &'a self,
        command: &'a Value,
        has_postcondition: bool,
        has_screenshot_options: bool,
        options: &'a ReplyOptions,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(self.evaluate_action(command, has_postcondition, has_screenshot_options, options))
    }

    #[inline(never)]
    pub(super) fn read_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let precondition = self.page_precondition();
            let redact = |text: &str| self.redact(text);
            Ok(observe::read(&self.observe_call(Some(&precondition)), command, &redact).await?)
        })
    }

    #[inline(never)]
    pub(super) fn extract_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let precondition = self.page_precondition();
            Ok(observe::extract(&self.observe_call(Some(&precondition)), command).await?)
        })
    }

    #[inline(never)]
    pub(super) fn wait_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let report = WaitSnapshot { page: self, command };
            Ok(self.timer.phase(Phase::Wait, flow::wait(&self.settle_page(), &self.cancel, command, &report)).await?)
        })
    }

    #[inline(never)]
    pub(super) fn emulate_boxed<'a>(&'a self, command: &'a Value, options: &'a ReplyOptions) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let input = command.as_object().cloned().unwrap_or_default();
            let applied = crate::actions::emulation::emulate(&self.call(), &input).await?;
            self.invalidate();
            let snapshot = self.settled(command, options).await?;
            Ok(emulation::configured_reply(&applied, snapshot))
        })
    }

    #[inline(never)]
    pub(super) fn cookies_boxed<'a>(&'a self, command: &'a Value, url: &'a str) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let input = command.as_object().cloned().unwrap_or_default();
            Ok(page::cookies(&self.call(), url, &input).await?)
        })
    }

    #[inline(never)]
    pub(super) fn storage_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let input = command.as_object().cloned().unwrap_or_default();
            let redact = |text: &str| self.redact(text);
            let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
            let outcome = page::storage(&self.call(), &ctx, &input).await?;
            if outcome.invalidates_refs {
                self.invalidate();
            }
            Ok::<ToolReply, RunError>(outcome.reply)
        })
    }

    #[inline(never)]
    pub(super) fn intercept_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move { Ok(page::intercept(&self.call(), &command.as_object().cloned().unwrap_or_default()).await?) })
    }

    #[inline(never)]
    pub(super) fn init_script_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move { Ok(page::init_script(&self.call(), &command.as_object().cloned().unwrap_or_default()).await?) })
    }

    #[inline(never)]
    pub(super) fn performance_boxed<'a>(&'a self, command: &'a Value) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let input = command.as_object().cloned().unwrap_or_default();
            Ok(page::performance(&self.call(), &*self.inner.ports.files, &input, || self.reload_and_settle()).await?)
        })
    }

    #[inline(never)]
    pub(super) fn gesture_boxed<'a, F>(
        &'a self,
        action: Action,
        command: &'a Value,
        recovery: &'a mut RefRecoveryContext,
        baseline: &'a mut Option<RefSet>,
        options: &'a F,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>>
    where
        F: Fn(bool, &Option<RefSet>) -> ReplyOptions + Sync,
    {
        Box::pin(async move {
            let output = {
                let mut cx =
                    ActionContext { host: self.host(), page: self, command, cancel: &self.cancel, recovery: &mut *recovery, effect_baseline: &mut *baseline };
                match action {
                    Action::Click => pointer::click(&mut cx).await,
                    Action::Hover => pointer::hover(&mut cx).await,
                    Action::Drag => pointer::drag(&mut cx).await,
                    Action::Press => pointer::press(&mut cx).await,
                    Action::Scroll => pointer::scroll(&mut cx).await,
                    _ => sequence(&mut cx, &SequenceSteps { page: self }).await,
                }
            }?;
            self.gesture_reply(output, command, recovery, &options(true, baseline)).await
        })
    }

    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn form_boxed<'a>(
        &'a self,
        action: Action,
        command: &'a Value,
        recovery: &'a mut RefRecoveryContext,
        baseline: &'a mut Option<RefSet>,
        expected: &'a Option<Postcondition>,
        preexisting: bool,
        report_baseline: &'a Option<RefSet>,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>> {
        Box::pin(async move {
            let mut form = FormCtx { page: self, command, recovery, baseline, expected, preexisting, report_baseline };
            let reply = match action {
                Action::Fill => forms::fill(&mut form).await,
                Action::Type => forms::type_text(&mut form).await,
                Action::Select => forms::select(&mut form).await,
                _ => forms::handle_dialog(&mut form).await,
            };
            Ok::<ToolReply, RunError>(reply?)
        })
    }

    #[inline(never)]
    pub(super) fn upload_boxed<'a, F>(
        &'a self,
        command: &'a Value,
        facts: &'a PageFacts,
        approved: Option<&'a Binding>,
        recovery: &'a mut RefRecoveryContext,
        baseline: &'a mut Option<RefSet>,
        options: &'a F,
    ) -> BoxedFuture<'a, Result<ToolReply, RunError>>
    where
        F: Fn(bool, &Option<RefSet>) -> ReplyOptions + Sync,
    {
        Box::pin(async move {
            let paths: Vec<String> =
                command.get("paths").and_then(Value::as_array).map(|paths| paths.iter().map(|path| text_of(Some(path))).collect()).unwrap_or_default();
            let ref_id = truthy(command.get("ref")).then(|| text_of(command.get("ref")));
            let snapshot_id =
                ref_id.as_deref().map(|id| snapshot_of_ref(id).to_owned()).or_else(|| self.latest_refs().map(|refs| refs.snapshot_id)).unwrap_or_default();
            let target = UploadTarget { page_id: &self.page_id, snapshot_id: &snapshot_id, ref_id: ref_id.as_deref() };
            let outcome = upload::upload_files(self.host(), &*self.inner.ports.files, &target, &paths, facts, approved, self.token()).await?;
            self.invalidate();
            let summary = outcome.summary();
            let output =
                ActionOutput { lead: if summary.is_empty() { String::new() } else { format!("{summary}\n\n") }, decorate_recovery: true, input: Vec::new() };
            self.gesture_reply(output, command, recovery, &options(true, baseline)).await
        })
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn snapshot_action(&self, command: &Value) -> Result<ToolReply, RunError> {
        let plan = observe::plan_snapshot(command)?;
        let precondition = self.page_precondition();
        let call = self.observe_call(Some(&precondition));
        let ports = ShotPorts { blobs: &*self.inner.ports.blobs, files: &*self.inner.ports.files, frame_dir: &self.inner.ports.frame_dir };
        match plan {
            SnapshotPlan::Semantic => self.snapshot_reply(command, &ReplyOptions::default()).await,
            SnapshotPlan::Both => {
                let mut with_screenshot = command.clone();
                with_screenshot["includeScreenshot"] = Value::Bool(true);
                self.snapshot_reply(&with_screenshot, &ReplyOptions::default()).await
            }
            SnapshotPlan::Visual => Ok(observe::visual_screenshot(&call, &ports, command, self.background).await?),
            SnapshotPlan::Pdf => Ok(observe::print_pdf(&call, &ports).await?),
            SnapshotPlan::Element => {
                let (snapshot_id, ref_id) = if truthy(command.get("ref")) {
                    let ref_id = text_of(command.get("ref"));
                    (snapshot_of_ref(&ref_id).to_owned(), ref_id)
                } else if let Some(target) = command.get("target").filter(|target| !target.is_null()) {
                    let resolved = self.resolve_targets(std::slice::from_ref(target)).await?;
                    let Some(first) = resolved.into_iter().next() else { return Err(RunError::Failed("the target resolved to nothing".to_owned())) };
                    (first.snapshot_id, first.ref_id)
                } else {
                    return Err(RunError::Failed("snapshot mode=element requires ref or target".to_owned()));
                };
                Ok(observe::element_screenshot(&call, &ports, command, &snapshot_id, &ref_id, self.background).await?)
            }
        }
    }

    /// `locate`: a semantic snapshot (the command's query cleared) and, on top of it, the visual candidates for the query.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn locate_action(&self, command: &Value) -> Result<ToolReply, RunError> {
        let mut observing = command.clone();
        if let Some(fields) = observing.as_object_mut() {
            fields.shift_remove("query");
        }
        let snapshot = self.snapshot_reply(&observing, &ReplyOptions::default()).await?;
        if self.page_facts().pending_dialog.is_some() {
            return Ok(snapshot);
        }
        let Some(refs) = self.latest_refs() else { return Err(RunError::Failed("locate could not observe the page; take a fresh snapshot".to_owned())) };
        let precondition = self.page_precondition();
        let input = LocateInput {
            page: self.observe_call(Some(&precondition)),
            blobs: &*self.inner.ports.blobs,
            command,
            snapshot,
            ref_set: &refs,
            background: self.background,
            now: std::time::Instant::now(),
        };
        let reply = observe::locate(input).await?;
        self.state_lock().grounding = reply.grounding.clone();
        Ok(reply)
    }

    /// `network`: the recorded requests, or one request's detail. The detail reads bodies from the page, so the request is copied
    /// out of the ledger first (the mirror lends its ledgers only synchronously).
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn network_action(&self, command: &Value) -> Result<ToolReply, RunError> {
        let precondition = self.page_precondition();
        let call = self.observe_call(Some(&precondition));
        let now = wall_clock_ms();
        let request_id = diagnostics::network_request_id(command);
        if request_id.is_empty() {
            return Ok(self.with_ledgers(|ledgers| diagnostics::network_list(ledgers, command, now)));
        }
        let request = self.with_ledgers(|ledgers| diagnostics::network_request(ledgers, &request_id))?;
        Ok(diagnostics::network_detail(&call, &request, command, now).await?)
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn navigate_action(&self, action: Action, command: &Value, options: &ReplyOptions) -> Result<ToolReply, RunError> {
        self.invalidate();
        match self.moved(action, command).await? {
            NavigateOutcome::Refused(text) if action == Action::Back => Ok(ToolReply::text(text)),
            NavigateOutcome::Refused(text) => Err(RunError::Failed(text)),
            NavigateOutcome::Moved(facts) => match &facts.pending_dialog {
                Some(dialog) => Ok(blocking_dialog_reply(dialog, true, &|text: &str| self.redact(text))),
                None => self.settled(command, options).await,
            },
        }
    }

    /// A reload and the settle after it (what a performance trace over a reload waits for).
    pub(super) async fn reload_and_settle(&self) -> Result<(), page::PageActionError> {
        let reload = json!({"action": "navigate", "reload": true});
        self.moved(Action::Navigate, &reload).await.map_err(|error| match error {
            observe::ActionError::Host(error) => page::PageActionError::Host(error),
            observe::ActionError::Cancelled(_) => page::PageActionError::Host(HostCallError::Cancelled),
            observe::ActionError::Failed(message) => page::PageActionError::invalid(message),
        })?;
        let after = AfterAction { require_quiet: false, previous_url: None };
        settle_after_action(&self.settle_page(), &SettlePolicy::default(), &self.cancel, None, &after).await.map_err(|error| match error {
            SettleError::Cancelled(_) => page::PageActionError::Host(HostCallError::Cancelled),
            SettleError::ConnectionLost => page::PageActionError::Host(HostCallError::ConnectionLost),
            SettleError::Failed(message) => page::PageActionError::invalid(message),
        })
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured browser failure and reply by value without boxing or changing this API")]
    pub(super) async fn evaluate_action(
        &self,
        command: &Value,
        has_postcondition: bool,
        has_screenshot_options: bool,
        options: &ReplyOptions,
    ) -> Result<ToolReply, RunError> {
        let input = command.as_object().cloned().unwrap_or_default();
        let refs = self.latest_refs();
        let request = page::EvaluateRequest {
            input: &input,
            refs: refs.as_ref(),
            precondition: Some(self.page_precondition()),
            has_postcondition,
            has_screenshot_options,
        };
        let redact = |text: &str| self.redact(text);
        let ctx = ReplyContext { redact: &redact, files: &*self.inner.ports.files };
        match page::evaluate(&self.call(), &ctx, &request).await {
            Ok(done) if done.kept_snapshot().is_some() => {
                let downloads = self.session_downloads().await;
                Ok(done.unchanged_reply(&self.page_report(&downloads)))
            }
            Ok(done) => {
                self.invalidate();
                let snapshot = self.settled(command, options).await?;
                Ok(done.changed_reply(snapshot))
            }
            Err(error) => {
                if error.refs_stale {
                    self.invalidate();
                }
                Err(error.error.into())
            }
        }
    }

    /// The frame document that would receive an upload's files now, for the approval to bind.
    pub(super) async fn upload_receiver(&self, command: &Value) -> Result<upload::Receiver, UploadError> {
        let ref_id = truthy(command.get("ref")).then(|| text_of(command.get("ref")));
        let snapshot_id =
            ref_id.as_deref().map(|id| snapshot_of_ref(id).to_owned()).or_else(|| self.latest_refs().map(|refs| refs.snapshot_id)).unwrap_or_default();
        let target = UploadTarget { page_id: &self.page_id, snapshot_id: &snapshot_id, ref_id: ref_id.as_deref() };
        upload::receiver(self.host(), &target, &self.page_facts(), self.token()).await
    }
}
