//! The pending worktree intent of a Lead (Node `worktree-intents.mjs`): armed at creation (the
//! New task default or an explicit choice) or by `requestWorktree`, and provisioned at the
//! start of the next turn (or at once, for a New Task's first send); plus `selectBranch`.

use super::*;

impl Inner {
    /// The pending intent that applies to `session`'s next turn, if any.
    fn intent_for(&self, session: &str, view: &SessionView) -> Option<Intent> {
        let intent = self.intent(session)?;
        if is_bound(&read_session_workspace(view.workspace.as_ref())) {
            self.set_intent(session, None);
            return None;
        }
        // A creation-time intent belongs to a new task: never to a resumed conversation.
        if intent.armed || !view.has_messages { Some(intent) } else { None }
    }

    /// Create and enter the worktree `intent` asks for now: its txId is fixed on first use
    /// (`submission_id`, else a fresh one) so a retry reuses the same worktree, and the prompt
    /// text names an unnamed one. A settled intent is consumed.
    async fn provision_intent(
        self: &Arc<Self>,
        session: &str,
        mut intent: Intent,
        submission_id: &str,
        prompt: &str,
        mut options: Options,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let tx_id = match intent.tx_id.clone().filter(|t| !t.is_empty()) {
            Some(tx) => tx,
            None => match submission_id.trim() {
                "" => new_tx_id(),
                given => given.to_owned(),
            },
        };
        intent.tx_id = Some(tx_id.clone());
        self.set_intent(session, Some(intent.clone()));
        options.tx_id = tx_id;
        options.name_hint = Some(prompt.to_owned()).filter(|p| !p.is_empty());
        let result = self.run_worktree(session, intent.name.clone(), options, cancel).await?;
        self.set_intent(session, None);
        Ok(result)
    }

    pub(super) async fn prepare_turn_workspace(
        self: &Arc<Self>,
        session: &str,
        start: TurnStart,
        cancel: &CancellationToken,
    ) -> Result<Option<JsonValue>, ScmFailure> {
        let view = self.hosted(session)?;
        if let Some(stored) = read_session_workspace(view.workspace.as_ref()).filter(|w| w.state == TransitionState::Recovery) {
            return Err(errors::missing(None, stored.worktree_id.clone(), Some(stored.cwd.clone())));
        }
        let mut result = None;
        if let Some(intent) = self.intent_for(session, &view) {
            let options = Options {
                confirm_large: intent.confirm_large || start.confirm_large,
                own_turn: true,
                ..Options::default()
            };
            match self.provision_intent(session, intent.clone(), &start.submission_id, &start.prompt, options, cancel).await {
                Ok(provisioned) => result = Some(provisioned),
                // The settings default never blocks a task outside a git repository.
                Err(failure) if !intent.explicit && failure.code() == Some(errors::WORKTREE_UNSUPPORTED_REPO) => {
                    self.set_intent(session, None);
                    return Ok(None);
                }
                Err(failure) => return Err(failure),
            }
        }
        self.host.run_pending_setup(session, cancel).await?;
        Ok(result)
    }

    /// Re-enter the retained worktree now, or arm the lazy creation for the next message.
    /// `provision` creates and enters right away, so typed failures (large repository, disk,
    /// busy) reach the sender while its draft is still unsent. A creation decides the project
    /// folder's uncommitted changes: without `carry_changes` it refuses with
    /// WORKTREE_DIRTY_CHOICE; `leave` starts at HEAD and leaves them.
    pub(super) async fn request_worktree(
        self: &Arc<Self>,
        session: &str,
        input: RequestWorktree,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let name_hint = valid_name(input.name.as_deref())?;
        if input.carry_changes.as_deref().is_some_and(|c| !CARRY_CHOICES.contains(&c)) {
            return Err(plain(format!("carryChanges must be one of {}.", CARRY_CHOICES.join(", "))));
        }
        let current = self.workspace(session)?;
        assert_revision(current.revision, input.expected_revision)?;
        if current.is_bound() {
            return Ok(json!({ "revision": current.revision, "workspace": current.to_value(), "pending": false }));
        }
        if self.ops.session_worktree(session, cancel).await?.is_some() {
            let options = Options { expected_revision: input.expected_revision, own_turn, ..Options::default() };
            let entered = self.run_worktree(session, None, options, cancel).await?;
            return Ok(with_fields(entered, vec![("pending", json!(false))]));
        }
        let prior = self.intent(session);
        let intent = Intent {
            name: name_hint.or_else(|| prior.as_ref().and_then(|p| p.name.clone())),
            confirm_large: input.confirm_large || prior.as_ref().is_some_and(|p| p.confirm_large),
            explicit: true,
            armed: true,
            tx_id: prior.as_ref().and_then(|p| p.tx_id.clone()),
        };
        self.set_intent(session, Some(intent.clone()));
        if input.provision {
            let options = Options {
                expected_revision: input.expected_revision,
                changes: Some(input.carry_changes.clone().unwrap_or_else(|| "ask".into())),
                own_turn,
                confirm_large: intent.confirm_large,
                ..Options::default()
            };
            return match self.provision_intent(session, intent, &input.tx_id, &input.prompt, options, cancel).await {
                Ok(provisioned) => Ok(with_fields(provisioned, vec![("pending", json!(false))])),
                Err(failure) => {
                    // A refused move (uncommitted changes to decide, busy, …) is never re-armed
                    // for the next turn, where nobody could answer it.
                    self.set_intent(session, prior);
                    Err(failure)
                }
            };
        }
        let workspace = self.workspace(session)?;
        Ok(json!({ "revision": workspace.revision, "workspace": workspace.to_value(), "pending": true }))
    }

    /// Run in `branch`'s checkout; a selected branch settles the session's location, so no
    /// worktree intent stays armed.
    pub(super) async fn select_branch(
        self: &Arc<Self>,
        session: &str,
        input: SelectBranch,
        own_turn: bool,
        cancel: &CancellationToken,
    ) -> Result<JsonValue, ScmFailure> {
        let current = self.workspace(session)?;
        if current.branch.as_deref() == Some(input.branch.as_str()) && current.worktree_id.is_some() {
            assert_revision(current.revision, input.expected_revision)?;
            self.set_intent(session, None);
            return Ok(json!({ "revision": current.revision, "workspace": current.to_value() }));
        }
        let options = Options {
            expected_revision: input.expected_revision,
            confirm_large: input.confirm_large,
            own_turn,
            tx_id: input.tx_id.trim().to_owned(),
            ..Options::default()
        };
        let result = self.run_branch(session, &input.branch, input.create, options, cancel).await?;
        self.set_intent(session, None);
        Ok(result)
    }
}
