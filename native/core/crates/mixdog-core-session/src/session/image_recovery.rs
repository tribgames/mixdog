//! The local actions that fix an image refusal: continue without selected images, replace an image with a file the store holds,
//! continue in a new branch without prior context, and undo each. They edit the session's persisted projection overlay
//! ([`super::image_overlay_store`]) and nothing else: no model is called, no summary made, no blob read, and the transcript keeps
//! every original record. The next request of the session is projected through the overlay, so a repair survives restart, forks,
//! summaries, a spent send's re-issue and every later turn.
//!
//! A session's actions arrive one at a time (the session actor serializes them), so a load, an edit and an atomic save is the
//! whole of an action.

use std::path::Path;

use mixdog_core_api::domain::image_overlay::ImageOverlay;
use mixdog_core_api::domain::image_overlay::PartKey;
use mixdog_core_api::domain::image_overlay::stable_message_id;
use mixdog_image_egress::origin::RECORDED_FORM;
use serde_json::Value;
use serde_json::json;

use super::image_overlay_store::OverlayError;
use super::image_overlay_store::load;
use super::image_overlay_store::save;

/// One recovery action, addressed by the stable ids of the images or messages it concerns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// "Continue without selected images": the named images leave every projection (the person has confirmed, naming them).
    ContinueWithout(Vec<PartKey>),
    /// "Replace image": a file already imported into the attachment store stands in the same position.
    ReplaceWithStored {
        key: PartKey,
        reference: String,
        mime_type: String,
        name: String,
    },
    /// Put the named images back.
    Undo(Vec<PartKey>),
    /// "Continue in a new branch without prior context": the history before `from_message` leaves every projection.
    NewBranchWithoutContext {
        from_message: String,
    },
    UndoNewBranch,
}

/// The conversation as image choices address it: each message's id ([`stable_message_id`], the id it is sent under) and how
/// many content parts its stored row holds, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct History {
    messages: Vec<(String, usize)>,
    latest_prompt: Option<usize>,
}

impl History {
    /// From the stored rows, in order (what `ModelContext::read_from(0)` reads).
    pub fn of(rows: &[(mixdog_core_api::ids::ItemId, Value)]) -> Self {
        let messages = rows
            .iter()
            .enumerate()
            .map(|(index, (_, row))| {
                let id = stable_message_id(row.pointer("/meta/transcript/messageId").and_then(Value::as_str), index);
                (id, row.get("content").and_then(Value::as_array).map_or(0, Vec::len))
            })
            .collect();
        let latest_prompt = rows.iter().rposition(|(_, row)| row.get("role").and_then(Value::as_str) == Some("user"));
        Self { messages, latest_prompt }
    }

    /// The id of the latest message the person wrote: a new start begins there.
    pub fn latest_prompt(&self) -> Option<&str> {
        self.latest_prompt.map(|index| self.messages[index].0.as_str())
    }

    /// The id of the `index`-th message.
    pub fn id(&self, index: usize) -> &str {
        &self.messages[index].0
    }

    /// Every message's id, in order.
    pub fn ids(&self) -> Vec<String> {
        self.messages.iter().map(|(id, _)| id.clone()).collect()
    }

    /// Whether a new start from the latest prompt leaves the `index`-th message out.
    pub fn before_latest_prompt(&self, index: usize) -> bool {
        self.latest_prompt.is_some_and(|latest| index < latest)
    }

    fn holds(&self, key: &PartKey) -> bool {
        self.messages.iter().any(|(id, parts)| *id == key.message_id && (key.part == RECORDED_FORM || (key.part as usize) < *parts))
    }

    fn has_message(&self, id: &str) -> bool {
        self.messages.iter().any(|(message, _)| message == id)
    }
}

/// Apply `action` to the session's overlay and save it atomically; the overlay as saved. Every image or message the action
/// names must be one of `history`'s, and an undo must have something to undo: otherwise nothing is saved and the action is
/// [`OverlayError::Unaddressed`]. A damaged overlay file is never overwritten by an edit of it; a new start is the one action
/// that replaces it, since it makes everything the file said moot.
pub fn apply(data_dir: &Path, session: &str, history: &History, action: Action) -> Result<ImageOverlay, OverlayError> {
    let mut overlay = match (&action, load(data_dir, session)) {
        (_, Ok(overlay)) => overlay,
        (Action::NewBranchWithoutContext { .. }, Err(OverlayError::Unreadable(_))) => ImageOverlay::default(),
        (_, Err(error)) => return Err(error),
    };
    let addressed = match &action {
        Action::ContinueWithout(keys) => !keys.is_empty() && keys.iter().all(|key| history.holds(key)),
        Action::ReplaceWithStored { key, .. } => history.holds(key),
        Action::Undo(keys) => !keys.is_empty() && keys.iter().all(|key| overlay.edit(key).is_some()),
        Action::NewBranchWithoutContext { from_message } => history.has_message(from_message),
        Action::UndoNewBranch => overlay.new_context_at().is_some(),
    };
    if !addressed {
        return Err(OverlayError::Unaddressed);
    }
    match action {
        Action::ContinueWithout(keys) => keys.into_iter().for_each(|key| overlay.omit(key)),
        Action::ReplaceWithStored { key, reference, mime_type, name } => overlay.replace_stored(key, reference, mime_type, name),
        Action::Undo(keys) => {
            for key in keys {
                overlay.undo(&key);
            }
        }
        Action::NewBranchWithoutContext { from_message } => overlay.start_new_context_at(from_message),
        Action::UndoNewBranch => {
            overlay.undo_new_context();
        }
    }
    save(data_dir, session, &overlay)?;
    Ok(overlay)
}

/// A refused send as the interface needs it to offer the fixes: every blocker with the ids the actions above take, the sentence
/// that names it, and whether a new start is offered. `part` is the image's position in the stored message (not in the
/// message as projected for the send), or [`mixdog_image_egress::origin::RECORDED_FORM`] for an image of its recorded form.
pub fn refusal_json(refusal: &mixdog_image_egress::NotSent) -> Value {
    use mixdog_image_egress::RecoveryAction;
    let blockers: Vec<Value> = refusal
        .blockers
        .iter()
        .map(|blocker| {
            let actions: Vec<&str> = blocker
                .actions
                .iter()
                .map(|action| match action {
                    RecoveryAction::ReplaceImage => "replace",
                    RecoveryAction::ContinueWithout => "continueWithout",
                    RecoveryAction::NewBranchWithoutContext => "newBranchWithoutContext",
                })
                .collect();
            json!({
                "messageId": blocker.origin.message_id,
                "part": blocker.origin.part_path[1],
                "name": blocker.origin.display_name,
                "message": blocker.message(),
                "actions": actions,
            })
        })
        .collect();
    json!({ "blockers": blockers, "newContextOffered": refusal.new_context_offered, "message": refusal.message() })
}

/// The overlay as the interface shows it: what was left out, what was replaced and where a new context starts.
pub fn state_json(overlay: &ImageOverlay) -> Value {
    use mixdog_core_api::domain::image_overlay::Edit;
    let edits: Vec<Value> = overlay
        .edits()
        .map(|(key, edit)| match edit {
            Edit::Omit => json!({ "messageId": key.message_id, "part": key.part, "choice": "continueWithout" }),
            Edit::Replace(_) => json!({ "messageId": key.message_id, "part": key.part, "choice": "replaced" }),
            Edit::ReplaceStored { name, .. } => json!({ "messageId": key.message_id, "part": key.part, "choice": "replaced", "name": name }),
        })
        .collect();
    json!({ "edits": edits, "newContextAt": overlay.new_context_at() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(message: &str, part: u32) -> PartKey {
        PartKey { message_id: message.into(), part }
    }

    /// Messages m1 to m5, each with two content parts; m4 recorded without an id is addressed as `#3`.
    fn history() -> History {
        let row = |id: Option<&str>, role: &str| {
            let mut row = json!({ "role": role, "content": [{ "type": "text", "text": "x" }, { "type": "image", "data": "AAAA" }] });
            if let Some(id) = id {
                row["meta"] = json!({ "transcript": { "messageId": id } });
            }
            row
        };
        let rows = [(Some("m1"), "user"), (Some("m2"), "assistant"), (Some("m3"), "user"), (None, "user"), (Some("m5"), "user")]
            .into_iter()
            .enumerate()
            .map(|(n, (id, role))| (mixdog_core_api::ids::ItemId::from(format!("row-{n}")), row(id, role)))
            .collect::<Vec<_>>();
        History::of(&rows)
    }

    #[test]
    fn a_choice_that_addresses_nothing_changes_nothing_and_is_an_error() {
        let data = tempfile::tempdir().unwrap();
        let h = history();
        assert_eq!(h.latest_prompt(), Some("m5"));
        for action in [
            Action::ContinueWithout(vec![key("row-0", 1)]),
            Action::ContinueWithout(vec![key("m1", 1), key("m1", 2)]),
            Action::ReplaceWithStored { key: key("gone", 0), reference: "a".repeat(64), mime_type: "image/png".into(), name: "n.png".into() },
            Action::Undo(vec![key("m1", 1)]),
            Action::NewBranchWithoutContext { from_message: "row-3".into() },
            Action::UndoNewBranch,
        ] {
            assert_eq!(apply(data.path(), "sess_a", &h, action.clone()), Err(OverlayError::Unaddressed), "{action:?}");
        }
        assert!(!data.path().join("image-overlay").join("sess_a.json").exists(), "nothing was saved");
        // A message recorded without an id is addressed by the id it is sent under.
        let overlay = apply(data.path(), "sess_a", &h, Action::NewBranchWithoutContext { from_message: stable_message_id(None, 3) }).unwrap();
        assert_eq!(overlay.new_context_at(), Some("#3"));
        assert!(apply(data.path(), "sess_a", &h, Action::ContinueWithout(vec![key("#3", 1)])).is_ok());
    }

    #[test]
    fn each_action_persists_and_undo_puts_the_original_back_across_a_restart() {
        let data = tempfile::tempdir().unwrap();
        apply(data.path(), "sess_a", &history(), Action::ContinueWithout(vec![key("m1", 1), key("m2", 0)])).unwrap();
        apply(
            data.path(),
            "sess_a",
            &history(),
            Action::ReplaceWithStored { key: key("m3", 0), reference: "a".repeat(64), mime_type: "image/png".into(), name: "new.png".into() },
        )
        .unwrap();
        // A restart is a fresh load of the file.
        let overlay = load(data.path(), "sess_a").unwrap();
        assert_eq!(overlay.edits().count(), 3);
        let state = state_json(&overlay);
        assert_eq!(state["edits"][2]["choice"], "replaced");
        assert_eq!(state["edits"][0]["choice"], "continueWithout");
        let overlay = apply(data.path(), "sess_a", &history(), Action::Undo(vec![key("m1", 1)])).unwrap();
        assert!(overlay.edit(&key("m1", 1)).is_none() && overlay.edit(&key("m2", 0)).is_some());
        apply(data.path(), "sess_a", &history(), Action::NewBranchWithoutContext { from_message: "m5".into() }).unwrap();
        assert_eq!(load(data.path(), "sess_a").unwrap().new_context_at(), Some("m5"));
        let overlay = apply(data.path(), "sess_a", &history(), Action::UndoNewBranch).unwrap();
        assert_eq!(overlay.new_context_at(), None);
        assert_eq!(overlay.edits().count(), 2, "undoing the branch leaves the image choices as they were");
    }

    #[test]
    fn a_damaged_overlay_is_not_edited_over_but_a_new_branch_always_works() {
        let data = tempfile::tempdir().unwrap();
        apply(data.path(), "sess_a", &history(), Action::ContinueWithout(vec![key("m1", 0)])).unwrap();
        let path = data.path().join("image-overlay").join("sess_a.json");
        std::fs::write(&path, b"{").unwrap();
        // An edit would lose what the file said; it is refused and the file stays for repair.
        assert!(matches!(apply(data.path(), "sess_a", &history(), Action::ContinueWithout(vec![key("m2", 0)])), Err(OverlayError::Unreadable(_))));
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        // A new context makes the old choices moot: the damaged file is replaced and the session can send again.
        let overlay = apply(data.path(), "sess_a", &history(), Action::NewBranchWithoutContext { from_message: "m5".into() }).unwrap();
        assert_eq!(overlay.new_context_at(), Some("m5"));
        assert!(load(data.path(), "sess_a").is_ok());
    }

    #[test]
    fn a_session_id_that_cannot_name_a_file_is_refused() {
        let data = tempfile::tempdir().unwrap();
        assert_eq!(apply(data.path(), "../x", &history(), Action::UndoNewBranch).unwrap_err(), OverlayError::BadSession);
    }
}
