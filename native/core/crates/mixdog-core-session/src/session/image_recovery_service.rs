//! `thread/imageRecovery`: the local fixes of an image refusal and the state of the restore check of a conversation's images, as
//! one method. It edits the conversation's persisted projection overlay ([`super::image_recovery`]) and re-runs the restore check
//! ([`super::image_gate`]); it calls no model, writes no history record and reads no stored blob. A choice that cannot be saved
//! is answered in words and changes nothing.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::ImageRecoveryAction;
use mixdog_app_protocol::v2::params::ImageRecoveryTarget;
use mixdog_app_protocol::v2::params::ThreadImageRecoveryParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::domain::image_overlay::PartKey;
use mixdog_core_api::domain::image_supply::installed;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_image_egress::Outcome;
use serde_json::Value;

use super::SessionDirectory;
use super::image_overlay_store::OverlayError;
use super::image_recovery::Action;
use super::image_recovery::History;
use super::image_recovery::apply;
use super::image_recovery::state_json;

pub const IMAGE_RECOVERY: &str = "thread/imageRecovery";

pub struct ImageRecoveryService {
    directory: Arc<SessionDirectory>,
    data_dir: PathBuf,
    ops: OpScopes,
}

fn keys(targets: Vec<ImageRecoveryTarget>) -> Vec<PartKey> {
    targets.into_iter().map(|target| PartKey { message_id: target.message_id, part: target.part }).collect()
}

/// The sentence a failed load or save is answered with; every one names a next step that works in that state.
fn overlay_message(error: OverlayError) -> String {
    match error {
        OverlayError::BadSession => "This conversation cannot keep image choices. Continue in a new conversation.".to_owned(),
        OverlayError::Unreadable(_) => {
            "The image choices saved for this conversation could not be read. Start again from your last message, leaving out the earlier conversation, to make them again.".to_owned()
        }
        OverlayError::Io(_) => "The image choice could not be saved. Try again.".to_owned(),
        OverlayError::Unaddressed => "Nothing was changed: that image or message is not in this conversation, or there was nothing to undo.".to_owned(),
    }
}

impl ImageRecoveryService {
    pub fn new(directory: Arc<SessionDirectory>, data_dir: PathBuf, ops: OpScopes) -> Self {
        Self { directory, data_dir, ops }
    }

    /// The picture the person chose, attached through the attachment store's own import: checked, converted where its type needs
    /// it, kept. The reference of what is kept is what stands in the image's place.
    async fn attach(&self, image: ImageRecoveryTarget, data: &str, name: String) -> Result<Action, CoreError> {
        let supply = installed().ok_or_else(|| failed("session", "The image store is not ready yet. Try again in a moment."))?;
        let manifest = supply.inline(data).await.map_err(|_| failed("session", format!("{name} could not be attached. Choose another picture.")))?;
        match manifest.outcome {
            Outcome::Refused { text } => Err(failed("session", format!("{name} cannot be used: {text} Choose another picture."))),
            Outcome::Accepted { kind, .. } => Ok(Action::ReplaceWithStored {
                key: PartKey { message_id: image.message_id, part: image.part },
                reference: manifest.original,
                mime_type: kind.mime().to_owned(),
                name,
            }),
        }
    }

    /// The conversation's messages under the ids its image choices address them by (the ids they are sent under).
    async fn history(&self, thread: &ThreadId) -> Result<History, CoreError> {
        let deps = self.directory.deps();
        let context = super::run::ModelContext {
            store: deps.store.clone(),
            sensitive: deps.sensitive.clone(),
            lanes: deps.lanes,
            thread: thread.clone(),
            input: ItemId::from(String::new()),
        };
        Ok(History::of(&context.read_from(0).await?))
    }

    async fn run(&self, thread: &ThreadId, action: ImageRecoveryAction) -> Result<Value, CoreError> {
        // A choice is always paired with the history it is checked against: each arm that makes one reads it.
        let change: Option<(Action, History)> = match action {
            ImageRecoveryAction::State => None,
            ImageRecoveryAction::RecheckHistory => {
                self.directory.recheck_image_gate(thread);
                None
            }
            ImageRecoveryAction::ContinueWithout { images } => Some((Action::ContinueWithout(keys(images)), self.history(thread).await?)),
            ImageRecoveryAction::Replace { image, data, name } => Some((self.attach(image, &data, name).await?, self.history(thread).await?)),
            ImageRecoveryAction::Undo { images } => Some((Action::Undo(keys(images)), self.history(thread).await?)),
            // The new start begins at the latest message the person wrote, so the prompt that was refused is kept and everything
            // before it is left out of what is sent.
            ImageRecoveryAction::NewBranchWithoutContext => {
                let history = self.history(thread).await?;
                let from = history.latest_prompt().ok_or_else(|| failed("session", "This conversation has no message to start again from yet."))?.to_owned();
                Some((Action::NewBranchWithoutContext { from_message: from }, history))
            }
            ImageRecoveryAction::UndoNewBranch => Some((Action::UndoNewBranch, self.history(thread).await?)),
        };
        let changed = change.is_some();
        let (dir, session) = (self.data_dir.clone(), thread.as_str().to_owned());
        let overlay = mixdog_core_base::support::on_lane_wait(self.directory.deps().lanes.io, &mixdog_rt::CancellationToken::new(), move |_| match change {
            Some((action, history)) => apply(&dir, &session, &history, action),
            None => super::image_overlay_store::load(&dir, &session),
        })
        .await
        .map_err(|_| failed("session", "The image choice could not be applied. Try again."))?;
        let mut answer = match overlay {
            Ok(overlay) => state_json(&overlay),
            // Asking for the state of choices that cannot be read answers that, so the one fix that works (a new start, which
            // replaces them) can be offered; any other choice is refused with the same advice.
            Err(OverlayError::Unreadable(_)) if !changed => serde_json::json!({ "edits": [], "newContextAt": null, "choicesUnreadable": true }),
            Err(error) => return Err(failed("session", overlay_message(error))),
        };
        // A choice can cover an image the restore check could not take: the check runs again with the choice, so a conversation
        // the check held shut opens once every such image is covered.
        let shut = self.directory.handle(thread).is_some_and(|handle| handle.image_gate.state() != super::image_gate::GateState::Ready);
        if changed && shut {
            self.directory.recheck_image_gate(thread);
        }
        let gate = self.directory.handle(thread).map_or(super::image_gate::GateState::Ready, |handle| handle.image_gate.state());
        answer["gate"] = gate.to_json();
        Ok(answer)
    }
}

#[async_trait]
impl DomainService for ImageRecoveryService {
    fn methods(&self) -> &'static [&'static str] {
        &[IMAGE_RECOVERY]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            IMAGE_RECOVERY => {
                let params: ThreadImageRecoveryParams = decode(&req)?;
                let thread = params.thread_id.ok_or_else(|| invalid("threadId", "the thread to act on"))?;
                // Every action sets or clears a choice, so a replay of a recorded one is the same action again.
                self.ops.run(&req, None, || self.run(&thread, params.action.clone()), || self.run(&thread, params.action.clone())).await
            }
            other => Err(wrong_method("thread image recovery", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
