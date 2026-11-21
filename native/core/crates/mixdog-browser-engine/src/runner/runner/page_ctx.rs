use super::*;
use crate::actions::flow::WaitReport;
use crate::actions::forms::FormContext;
use crate::actions::forms::Mutation;
use crate::actions::forms::StoredLoginFill;
use crate::actions::ref_mutation::mutate_ref;
use crate::actions::sequence::StepRunner;
use crate::actions::target::ActionContext;
use crate::actions::target::ActionPage;
use crate::actions::target::adopt_resolved_targets;
use crate::refs::ref_actions::RefActions;
use crate::refs::reply_recovery::FreshSnapshot;
use crate::refs::reply_recovery::RecoveryFailure;
use crate::refs::reply_recovery::RecoveryHost;
use crate::refs::reply_recovery::RefRecoveryContext;
use crate::refs::reply_recovery::decorate_recovery;
use crate::refs::reply_recovery::with_ref_recovery;
use crate::refs::target_resolve::ResolvedTarget;
use crate::settle::settle::PageProbe;
use crate::settle::settle::PageState;
use crate::settle::settle::StepKind;
use mixdog_browser_policy::timing::Phase;

/// The page a command works on, with everything the actions read of it. Cheap to clone.
#[derive(Clone)]
pub(super) struct PageCtx {
    pub(super) inner: Arc<Inner>,
    pub(super) slot: Arc<PageSlot>,
    pub(super) page_id: String,
    pub(super) thread: ThreadId,
    /// The session's turn this command runs in.
    pub(super) turn: u64,
    pub(super) cancel: CancelView,
    pub(super) user_wait: UserWait,
    pub(super) timer: Arc<CommandTimer>,
    /// A hidden offscreen page: its screenshots are captured as the host captures a page nobody sees.
    pub(super) background: bool,
}

impl PageProbe for PageCtx {
    fn state(&self) -> PageState {
        let facts = self.page_facts();
        let now = wall_clock_ms();
        self.inner.ports.mirror.with_ledgers(&self.page_id, |ledgers| PageState::from_facts(&facts, &ledgers.network, now)).unwrap_or_else(|| PageState {
            loading: facts.loading,
            url: facts.url.clone(),
            destroyed: !facts.alive,
            dialog: facts.pending_dialog.as_ref().map(|dialog| dialog.kind.clone()),
            ..PageState::default()
        })
    }

    fn stop_loading(&self) {
        let host = self.inner.host.clone();
        let params = HostBrowserPageStopParams { page_id: self.page_id.clone() };
        // A stop that fails or hangs changes nothing the cancelled command is told: its answer is not waited for. The command's own
        // token is already cancelled, so the request rides a token of its own.
        mixdog_rt::spawn("browser-page-stop", mixdog_rt::TaskClass::Work, async move {
            let _ = host.page_stop(params, &CancellationToken::new()).await;
        });
    }
}

// what the actions ask of the page

#[async_trait]
impl RecoveryHost for PageCtx {
    async fn page_url(&self) -> Result<String, HostCallError> {
        Ok(self.page_facts().url)
    }

    fn dialog_text(&self) -> Option<String> {
        self.page_facts().pending_dialog.map(|dialog| blocking_dialog_reply(&dialog, false, &|text: &str| self.redact(text)).text)
    }

    async fn fresh_snapshot(&self) -> Result<FreshSnapshot, HostCallError> {
        let params = self.snapshot_params(&json!({"action": "snapshot"}));
        let result = self.timer.phase(Phase::Snapshot, self.host().snapshot(params, self.token())).await?;
        let refs = RefSet::from_payload(&result.snapshot_id, &result.payload).with_document(&result.document_id, result.revision);
        {
            let mut state = self.state_lock();
            state.refs = Some(refs.clone());
            state.grounding = None;
            state.scroll_y = Some(result.payload.scroll_y);
        }
        Ok(FreshSnapshot { refs, report: self.format_snapshot_text(&result) })
    }
}

#[async_trait]
impl ActionPage for PageCtx {
    fn recovery_host(&self) -> &dyn RecoveryHost {
        self
    }

    fn facts(&self) -> PageFacts {
        self.page_facts()
    }

    fn precondition(&self) -> Precondition {
        self.page_precondition()
    }

    fn ref_set(&self) -> Option<RefSet> {
        self.latest_refs()
    }

    fn restore_ref_set(&self, set: RefSet) {
        self.state_lock().refs = Some(set);
    }

    fn join_minted(&self, resolved: &[ResolvedTarget]) {
        self.register_minted(resolved);
    }

    fn adopt_snapshot(&self, snapshot_id: &str) -> Option<RefSet> {
        let observation = self.inner.store.snapshot(&self.page_id, snapshot_id)?;
        let mut state = self.state_lock();
        state.refs = Some(observation.refs.clone());
        state.grounding = None;
        state.scroll_y = Some(observation.scroll_y);
        Some(observation.refs.clone())
    }

    fn invalidate_interaction(&self) {
        self.invalidate();
    }

    /// The change judgement compares the observation's own scroll position, so a scroll needs nothing recorded.
    fn record_scroll(&self) {}

    fn visual_grounding(&self) -> Option<VisualGrounding> {
        self.state_lock().grounding.clone()
    }

    fn drop_visual_grounding(&self) {
        self.state_lock().grounding = None;
    }

    /// The page's observation revision now, read through the host without a snapshot (one would retire the refs the agent holds). A host
    /// that cannot answer leaves the grounding judged by its age and its page alone.
    async fn document_revision(&self, cancel: &CancellationToken) -> Option<u32> {
        let params = HostBrowserRevisionParams { page_id: self.page_id.clone() };
        self.host().revision(params, cancel).await.ok().map(|answer| answer.revision)
    }

    fn format_snapshot(&self, snapshot: &HostBrowserSnapshotResult) -> String {
        self.format_snapshot_text(snapshot)
    }

    fn timer(&self) -> Option<&CommandTimer> {
        Some(&*self.timer)
    }
}

/// `wait` ends with the page as the runner's snapshot reply puts it.
pub(super) struct WaitSnapshot<'a> {
    pub(super) page: &'a PageCtx,
    pub(super) command: &'a Value,
}

#[async_trait]
impl WaitReport for WaitSnapshot<'_> {
    async fn snapshot(&self) -> Result<ToolReply, observe::ActionError> {
        self.page.snapshot_reply(self.command, &ReplyOptions::default()).await.map_err(RunError::into_observe)
    }
}

/// The steps of a `sequence`: each one is a command of its own on the same page, timed as step `index`.
pub(super) struct SequenceSteps<'a> {
    pub(super) page: &'a PageCtx,
}

#[async_trait]
impl StepRunner for SequenceSteps<'_> {
    async fn run_step(&self, index: u32, step: Value, _cancel: &CancelView) -> Result<crate::settle::settle::StepResult, ActionError> {
        let Some(action) = Action::parse(&text_of(step.get("action"))) else {
            return Err(ActionError::Failed("a step names no action of the contract".to_owned()));
        };
        let expected = crate::settle::postcondition::normalize(step.get("expect")).map_err(|error| ActionError::Failed(error.to_string()))?;
        let reply = match self.page.timer.step(index, self.page.dispatch(action, step, expected, false)).await {
            Ok(reply) => reply,
            Err(RunError::Reply(reply)) => *reply,
            Err(error) => return Err(error.into_action()),
        };
        let outcome = match reply.outcome {
            Some(ReplyOutcome::Blocked) => StepKind::Blocked,
            Some(ReplyOutcome::Inconclusive) => StepKind::Inconclusive,
            _ => StepKind::Completed,
        };
        Ok(crate::settle::settle::StepResult { outcome, text: reply.text })
    }

    async fn observe(&self, _cancel: &CancelView) -> Result<String, ActionError> {
        match self.page.snapshot_reply(&json!({"action": "snapshot"}), &ReplyOptions::default()).await {
            Ok(reply) => Ok(reply.text),
            Err(RunError::Reply(reply)) => Ok(reply.text),
            Err(error) => Err(error.into_action()),
        }
    }
}

/// What the form handlers drive the page through.
pub(super) struct FormCtx<'a> {
    pub(super) page: &'a PageCtx,
    pub(super) command: &'a Value,
    pub(super) recovery: &'a mut RefRecoveryContext,
    pub(super) baseline: &'a mut Option<RefSet>,
    pub(super) expected: &'a Option<Postcondition>,
    pub(super) preexisting: bool,
    pub(super) report_baseline: &'a Option<RefSet>,
}

impl FormCtx<'_> {
    pub(super) fn action_context(&mut self) -> ActionContext<'_> {
        ActionContext {
            host: self.page.host(),
            page: self.page,
            command: self.command,
            cancel: &self.page.cancel,
            recovery: &mut *self.recovery,
            effect_baseline: &mut *self.baseline,
        }
    }

    pub(super) fn options(&self) -> ReplyOptions {
        ReplyOptions {
            expected: self.expected.clone(),
            preexisting: self.preexisting,
            settle_action: true,
            baseline: self.baseline.clone(),
            report_baseline: self.report_baseline.clone(),
        }
    }
}

#[async_trait]
impl FormContext for FormCtx<'_> {
    fn command(&self) -> &Value {
        self.command
    }

    fn cancel(&self) -> &CancelView {
        &self.page.cancel
    }

    fn ref_actions(&self) -> RefActions {
        self.page.ref_actions()
    }

    async fn action_ref(&mut self) -> Result<Option<String>, RefError> {
        let mut cx = self.action_context();
        crate::actions::target::action_ref(&mut cx).await.map_err(action_to_ref)
    }

    async fn resolve_target_refs(&mut self, targets: &[Value]) -> Result<Vec<String>, RefError> {
        let resolved = self.page.resolve_targets(targets).await.map_err(action_to_ref)?;
        let mut cx = self.action_context();
        adopt_resolved_targets(&mut cx, &resolved);
        Ok(resolved.into_iter().map(|target| target.ref_id).collect())
    }

    async fn mutate_ref(&mut self, source_ref: &str, operation: Mutation, editable: bool) -> Result<(), RefError> {
        let mut cx = self.action_context();
        mutate_ref(&mut cx, source_ref, editable, operation).await.map_err(action_to_ref)
    }

    async fn list_select_options(&mut self, source_ref: &str) -> Result<crate::refs::control_state::SelectOptions, RefError> {
        let actions = self.page.ref_actions();
        let page = self.page;
        with_ref_recovery(page.recovery_host(), &mut *self.recovery, source_ref, |candidate| {
            let actions = actions.clone();
            async move { actions.list_select_options(&candidate).await.map_err(ref_to_host) }
        })
        .await
        .map_err(|error| match error {
            RecoveryFailure::Host(error) => RefError::Host(error),
            RecoveryFailure::Message(message) => RefError::Failed(message),
        })
    }

    async fn fill_stored(&mut self, account: &str) -> Result<StoredLoginFill, RefError> {
        // The desktop holds the vault: it matches the account to the page's origin and writes the password into the page itself.
        let params =
            HostBrowserCredentialsFillParams { page_id: self.page.page_id.clone(), account: account.to_owned(), expect: Some(self.page.page_precondition()) };
        let filled = self.page.host().credentials_fill(params, self.page.token()).await.map_err(RefError::Host)?;
        Ok(StoredLoginFill { password_filled: filled.password_filled, reason: filled.reason })
    }

    fn invalidate_interaction(&mut self) {
        self.page.invalidate();
    }

    async fn action_snapshot(&mut self) -> Result<ToolReply, RefError> {
        let options = self.options();
        match self.page.settled(self.command, &options).await {
            Ok(reply) => Ok(reply),
            Err(RunError::Reply(reply)) => Ok(*reply),
            Err(error) => Err(error.into_ref()),
        }
    }

    fn decorate_recovery(&self, reply: ToolReply) -> ToolReply {
        ToolReply { text: decorate_recovery(&reply.text, &*self.recovery), ..reply }
    }

    async fn observation_after_failure(&mut self) -> Result<String, RefError> {
        // `{ action: 'snapshot', maxChars: command.maxChars }`: the caller's budget bounds the recovery snapshot too.
        let mut observe = json!({"action": "snapshot"});
        if let Some(max_chars) = self.command().get("maxChars") {
            observe["maxChars"] = max_chars.clone();
        }
        match self.page.snapshot_reply(&observe, &ReplyOptions::default()).await {
            Ok(reply) => Ok(reply.text),
            Err(RunError::Reply(reply)) => Ok(reply.text),
            Err(RunError::Cancelled(_)) => Err(RefError::Host(HostCallError::Cancelled)),
            Err(error) => Ok(format!("Fresh observation failed: {}", error.message())),
        }
    }
}
