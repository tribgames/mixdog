//! The restore-time gate on sending: a restored session's history may hold images no verdict has been recorded for (legacy inline
//! base64, bare attachment references). They are imported into the image vault in the background, with progress, before the
//! session sends; an image that cannot be imported is named for repair, never skipped. Importing writes no history record: a
//! verdict is keyed by the image's bytes, so the rows stay as they are and rolling back loses nothing.

use std::sync::Mutex;

use mixdog_core_api::domain::image_overlay::ImageOverlay;
use mixdog_core_api::domain::image_overlay::PartKey;
use mixdog_core_api::ids::ItemId;
use mixdog_image_vault::migration::ItemResult;
use mixdog_image_vault::migration::LegacyImage;
use mixdog_image_vault::migration::LegacySource;
use mixdog_image_vault::migration::Progress;
use mixdog_image_vault::migration::Report;
use mixdog_image_vault::vault::ImportError;
use serde_json::Value;

use mixdog_core_api::domain::image_overlay::stable_message_id;

/// Where an image of the history sits, in the terms its image choices use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    /// The message's id in image choices.
    pub message_id: String,
    /// The message's place in the conversation.
    pub index: usize,
    /// The image's part in the message; `None` for an image nested inside a part (a tool result recorded inside another
    /// message), which no choice about one part can address.
    pub part: Option<u32>,
    /// Whether starting again from the latest prompt leaves it out.
    pub before_latest_prompt: bool,
}

/// The information the gate needs to interpret a migration verdict, even if the import job was dropped.
pub(super) struct PendingImage {
    pub(super) key: String,
    name: String,
    place: Place,
}

/// An image the restore check could not take: where it is, the sentence that names it, and the fixes that work for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepairImage {
    pub place: Place,
    pub sentence: String,
}

impl RepairImage {
    /// The fixes that can succeed for this image: a part can be replaced or left out; starting again works when it sits
    /// before the latest prompt.
    fn actions(&self) -> Vec<&'static str> {
        let mut actions = Vec::new();
        if self.place.part.is_some() {
            actions.extend(["replace", "continueWithout"]);
        }
        if self.place.before_latest_prompt {
            actions.push("newBranchWithoutContext");
        }
        actions
    }
}

/// Where the gate stands.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum GateState {
    /// Sending is open: a new session, or every image of the history has a verdict or a choice.
    #[default]
    Ready,
    Checking {
        done: usize,
        total: usize,
    },
    /// Images that could not be imported and that no choice covers.
    Repair(Vec<RepairImage>),
}

impl GateState {
    /// The state as the interface shows it: `ready`, `checking` with its progress, or `repair` with each image that could not
    /// be checked, its place, its sentence and the fixes that work for it.
    pub fn to_json(&self) -> Value {
        match self {
            GateState::Ready => serde_json::json!({ "state": "ready" }),
            GateState::Checking { done, total } => serde_json::json!({ "state": "checking", "done": done, "total": total }),
            GateState::Repair(images) => {
                let images: Vec<Value> = images
                    .iter()
                    .map(|image| {
                        serde_json::json!({
                            "messageId": image.place.message_id,
                            "part": image.place.part,
                            "message": image.sentence,
                            "actions": image.actions(),
                        })
                    })
                    .collect();
                serde_json::json!({ "state": "repair", "images": images })
            }
        }
    }
}

/// Whether a choice already covers the image: it is left out or replaced, or a new start leaves its message out.
pub fn covered(overlay: &ImageOverlay, ids: &[String], place: &Place) -> bool {
    overlay.cuts(ids, place.index) || place.part.is_some_and(|part| overlay.edit(&PartKey { message_id: place.message_id.clone(), part }).is_some())
}

#[derive(Default)]
pub struct ImageGate {
    state: Mutex<GateState>,
    changed: tokio::sync::Notify,
}

impl ImageGate {
    fn state_lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set(&self, state: GateState) {
        *self.state_lock() = state;
        self.changed.notify_waiters();
    }

    pub fn state(&self) -> GateState {
        self.state_lock().clone()
    }

    /// Close sending until [`Self::finish`]. Until the history has been read for its images the gate is `Checking` with no
    /// total ([`Self::scanned`]).
    pub fn begin(&self) {
        self.set(GateState::Checking { done: 0, total: 0 });
    }

    pub fn progress(&self, progress: Progress) {
        self.set(GateState::Checking { done: progress.done, total: progress.total });
    }

    /// Returns once the history has been read for its images: a history with none has opened the gate, one with images is
    /// checking them with a total. A send waits for this answer instead of being refused while it is not known yet.
    pub async fn scanned(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !matches!(self.state(), GateState::Checking { total: 0, .. }) {
                return;
            }
            changed.await;
        }
    }

    /// Open sending when every image has a verdict; else name the ones that need repair (a cancelled or interrupted run
    /// included: running it again finishes it).
    pub(super) fn finish(&self, items: &[PendingImage], report: &Report) {
        let mut unresolved = Vec::new();
        for (key, result) in &report.results {
            let Some(item) = items.iter().find(|item| item.key == *key) else { continue };
            let name = &item.name;
            let sentence = match result {
                ItemResult::Done(_) => continue,
                ItemResult::Failed(ImportError::Storage(_) | ImportError::Missing(_)) => format!("{name}: its stored file could not be read."),
                ItemResult::Failed(ImportError::Invalid(text)) => format!("{name}: {text}"),
                ItemResult::Failed(ImportError::Transient(_)) | ItemResult::NotRun => format!("{name}: checking it was interrupted."),
            };
            unresolved.push(RepairImage { place: item.place.clone(), sentence });
        }
        self.set(if unresolved.is_empty() { GateState::Ready } else { GateState::Repair(unresolved) });
    }

    /// The sentence a send is refused with while the gate is shut; `None` when it is open. It offers only the fixes that work
    /// for every image it names.
    pub fn refusal(&self) -> Option<String> {
        match self.state() {
            GateState::Ready => None,
            GateState::Checking { total: 0, .. } => {
                Some("Nothing was sent. The images in this conversation are being checked before it can send. Try again in a moment.".to_owned())
            }
            GateState::Checking { done, total } => {
                Some(format!("Nothing was sent. {done} of {total} images in this conversation are checked. Try again in a moment."))
            }
            GateState::Repair(images) => {
                let names: Vec<&str> = images.iter().map(|image| image.sentence.as_str()).collect();
                let all = |action: &str| images.iter().all(|image| image.actions().contains(&action));
                let fix = match (all("replace"), all("newBranchWithoutContext")) {
                    (true, true) => " Replace them, continue without them, or start again from your last message, leaving out the earlier conversation.",
                    (true, false) => " Replace them or continue without them.",
                    (false, true) => " Start again from your last message, leaving out the earlier conversation.",
                    (false, false) => " Fix each one with the choices shown beside it.",
                };
                Some(format!("Nothing was sent. These earlier images could not be checked: {}{fix}", names.join(" ")))
            }
        }
    }
}

/// A restore scan retains image sources, not the text and tool results of pages already checked.
#[derive(Default)]
pub(super) struct ImageScan {
    count: usize,
    latest_prompt: Option<usize>,
    cut_seen: bool,
    imports: Vec<LegacyImage>,
    pending: Vec<PendingImage>,
}

impl ImageScan {
    pub(super) fn page(&mut self, rows: Vec<(ItemId, Value)>, overlay: &ImageOverlay) {
        for (id, mut row) in rows {
            self.row(&id, &mut row, overlay);
        }
    }

    fn row(&mut self, id: &ItemId, row: &mut Value, overlay: &ImageOverlay) {
        let index = self.count;
        self.count += 1;
        if row.get("role").and_then(Value::as_str) == Some("user") {
            self.latest_prompt = Some(index);
        }
        let message_id = stable_message_id(row.pointer("/meta/transcript/messageId").and_then(Value::as_str), index);
        if !self.cut_seen && overlay.new_context_at() == Some(message_id.as_str()) {
            self.cut_seen = true;
            self.pending.clear();
            self.imports.clear();
        }
        let mut found = Vec::new();
        walk(row, id.as_str(), index + 1, &mut String::new(), &mut found);
        for image in found {
            let path = image.key.split_once('#').map_or("", |(_, path)| path);
            let part = path.strip_prefix("/content/").and_then(|rest| rest.parse::<u32>().ok());
            let place = Place { message_id: message_id.clone(), index, part, before_latest_prompt: false };
            if !covered(overlay, &[], &place) {
                self.pending.push(PendingImage { key: image.key.clone(), name: image.name.clone(), place });
                self.imports.push(image);
            }
        }
    }

    pub(super) fn finish(mut self) -> (Vec<LegacyImage>, Vec<PendingImage>) {
        for image in &mut self.pending {
            image.place.before_latest_prompt = self.latest_prompt.is_some_and(|latest| image.place.index < latest);
        }
        (self.imports, self.pending)
    }
}

fn walk(value: &mut Value, row: &str, turn: usize, path: &mut String, found: &mut Vec<LegacyImage>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                let at = path.len();
                path.push_str(&format!("/{index}"));
                walk(item, row, turn, path, found);
                path.truncate(at);
            }
        }
        Value::Object(map) => {
            if matches!(map.get("type").and_then(Value::as_str), Some("image" | "input_image")) {
                let source = match map.get_mut("data") {
                    Some(Value::String(data)) if !data.is_empty() => Some(LegacySource::Base64(std::mem::take(data))),
                    _ => match map.get_mut("attachmentRef") {
                        Some(Value::String(reference)) if super::prompt_submission::is_attachment_ref(reference) => {
                            Some(LegacySource::BlobRef(std::mem::take(reference)))
                        }
                        _ => None,
                    },
                };
                if let Some(source) = source {
                    let name = match map.get("filename").and_then(Value::as_str).filter(|name| !name.is_empty()) {
                        Some(name) => name.to_owned(),
                        None => {
                            format!("the image in message {turn} (part {})", found.iter().filter(|image| image.key.starts_with(&format!("{row}#"))).count() + 1)
                        }
                    };
                    found.push(LegacyImage { key: format!("{row}#{path}"), name, source });
                }
                return;
            }
            for (key, item) in map {
                let at = path.len();
                path.push_str(&format!("/{key}"));
                walk(item, row, turn, path, found);
                path.truncate(at);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use mixdog_image_vault::vault::ImportError;
    use serde_json::json;

    use super::*;

    fn row(id: &str, content: Value) -> (ItemId, Value) {
        (ItemId::from(id.to_owned()), json!({ "role": "user", "content": content }))
    }

    fn history_images(rows: Vec<(ItemId, Value)>, overlay: &ImageOverlay) -> (Vec<LegacyImage>, Vec<PendingImage>) {
        let mut scan = ImageScan::default();
        // Exercise cut points and latest prompts that arrive on a later page than the image.
        for row in rows {
            scan.page(vec![row], overlay);
        }
        scan.finish()
    }

    #[test]
    fn every_image_part_of_every_role_is_found_with_its_place() {
        let reference = "a".repeat(64);
        let rows = vec![
            row("r1", json!([{ "type": "text", "text": "hi" }, { "type": "image", "data": "AAAA", "mimeType": "image/png" }])),
            (
                ItemId::from("r2"),
                json!({ "role": "tool", "meta": { "transcript": { "messageId": "tool-message" } }, "content": [
                { "type": "tool_result", "content": [{ "type": "text", "text": "x" }, { "type": "input_image", "attachmentRef": reference, "filename": "scan.png" }] }
            ] }),
            ),
            row("r3", json!([{ "type": "image", "attachmentRef": "short" }, { "type": "image", "data": "" }])),
        ];
        let (found, pending) = history_images(rows, &ImageOverlay::default());
        assert_eq!(found.len(), 2, "a part with no bytes and no valid reference holds nothing to import");
        assert_eq!(
            found[0],
            LegacyImage { key: "r1#/content/1".into(), name: "the image in message 1 (part 1)".into(), source: LegacySource::Base64("AAAA".into()) }
        );
        assert_eq!(pending[0].place, Place { message_id: "#0".into(), index: 0, part: Some(1), before_latest_prompt: true });
        assert_eq!(found[1], LegacyImage { key: "r2#/content/0/content/1".into(), name: "scan.png".into(), source: LegacySource::BlobRef(reference) });
        assert_eq!(pending[1].place, Place { message_id: "tool-message".into(), index: 1, part: None, before_latest_prompt: true });
    }

    fn item(part: Option<u32>, before_latest_prompt: bool) -> PendingImage {
        PendingImage { key: "k".into(), name: "scan.png".into(), place: Place { message_id: "m1".into(), index: 0, part, before_latest_prompt } }
    }

    #[tokio::test]
    async fn a_send_waits_for_the_history_scan_and_not_for_the_import() {
        let gate = std::sync::Arc::new(ImageGate::default());
        gate.begin();
        let waiting = tokio::spawn({
            let gate = gate.clone();
            async move { gate.scanned().await }
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished(), "the history is still being read");
        gate.progress(Progress { done: 0, total: 3 });
        waiting.await.unwrap();
        assert!(gate.refusal().unwrap().contains("0 of 3"), "images to import shut sending with their progress");
        gate.begin();
        gate.finish(&[], &Report { results: Vec::new(), cancelled: false });
        gate.scanned().await;
        assert_eq!(gate.refusal(), None, "a history with no image opens at once");
    }

    #[test]
    fn the_gate_shuts_sending_while_checking_and_offers_only_fixes_that_work() {
        let gate = ImageGate::default();
        assert_eq!(gate.refusal(), None, "a new session sends");
        gate.begin();
        assert!(gate.refusal().unwrap().contains("being checked"));
        gate.progress(Progress { done: 2, total: 5 });
        assert!(gate.refusal().unwrap().contains("2 of 5"));
        let broken = Report { results: vec![("k".into(), ItemResult::Failed(ImportError::Storage("os error 2".into())))], cancelled: false };
        gate.finish(&[item(Some(0), false)], &broken);
        let said = gate.refusal().unwrap();
        assert!(said.contains("scan.png: its stored file could not be read.") && said.ends_with("Replace them or continue without them."), "{said}");
        assert!(!said.contains("os error"), "{said}");
        assert_eq!(gate.state().to_json()["images"][0]["actions"], serde_json::json!(["replace", "continueWithout"]));
        gate.finish(&[item(None, true)], &broken);
        assert!(gate.refusal().unwrap().ends_with("Start again from your last message, leaving out the earlier conversation."));
        assert_eq!(gate.state().to_json()["images"][0]["actions"], serde_json::json!(["newBranchWithoutContext"]));
        gate.finish(&[item(Some(0), true)], &Report { results: vec![("k".into(), ItemResult::NotRun)], cancelled: true });
        assert!(gate.refusal().unwrap().contains("interrupted"));
        gate.finish(&[], &Report { results: Vec::new(), cancelled: false });
        assert_eq!(gate.state(), GateState::Ready);
    }

    #[test]
    fn a_choice_covers_an_image_by_its_part_or_by_a_new_start_after_it() {
        let rows = || {
            vec![
                row("old", json!([{ "type": "image", "data": "old" }])),
                row("cut", json!([{ "type": "text", "text": "start here" }])),
                row("kept", json!([{ "type": "image", "data": "omitted" }, { "type": "image", "data": "kept" }])),
            ]
        };
        let mut overlay = ImageOverlay::default();
        overlay.start_new_context_at("#1".into());
        overlay.omit(PartKey { message_id: "#2".into(), part: 0 });
        let (found, pending) = history_images(rows(), &overlay);
        assert_eq!(
            found,
            vec![LegacyImage { key: "kept#/content/1".into(), name: "the image in message 3 (part 2)".into(), source: LegacySource::Base64("kept".into()) }]
        );
        assert_eq!(pending[0].place, Place { message_id: "#2".into(), index: 2, part: Some(1), before_latest_prompt: false });

        overlay.start_new_context_at("missing".into());
        let (found, _) = history_images(rows(), &overlay);
        assert_eq!(found.iter().map(|image| image.key.as_str()).collect::<Vec<_>>(), ["old#/content/0", "kept#/content/1"]);
    }
}
