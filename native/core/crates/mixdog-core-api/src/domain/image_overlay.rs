//! Local recovery for image refusals as a persisted projection overlay. The transcript is never edited: the overlay names
//! image parts by stable id, and every request built from the history is projected through it, so the repair survives restart,
//! forks, summaries, reissue and later turns. No model, no summary, no read of the bad blob is needed to apply or undo it.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::provider::{Content, ContentPart, ImageSource, Message, Role};

/// The id a conversation's `index`-th message is addressed by in image choices: its recorded id, or its place for a message
/// recorded without one. Sending and the restore check both name images by it, so a choice made from either applies to both.
pub fn stable_message_id(recorded: Option<&str>, index: usize) -> String {
    recorded.map_or_else(|| format!("#{index}"), str::to_owned)
}

/// Stable address of one image part: the message id and the part's index path inside it.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct PartKey {
    pub message_id: String,
    pub part: u32,
}

impl PartKey {
    fn id(&self) -> String {
        format!("{}\u{1f}{}", self.message_id, self.part)
    }

    fn parse(id: &str) -> Option<Self> {
        let (message_id, part) = id.rsplit_once('\u{1f}')?;
        Some(Self { message_id: message_id.to_owned(), part: part.parse().ok()? })
    }
}

/// What replaces an image part.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Edit {
    /// The user chose "Continue without selected images": the part is left out of every projection.
    Omit,
    /// The user chose "Replace image": an imported local file stands in the same position.
    Replace(ImageSource),
    /// "Replace image" with a file the attachment store already holds (imported through the one importer): no bytes live in
    /// the overlay, only the reference.
    ReplaceStored { reference: String, mime_type: String, name: String },
}

/// A tool result whose call was cut away has no legal place on the wire.
fn reject_orphaned_tool_results(ids: &[String], messages: &[Message]) -> Result<(), Unrepresentable> {
    for (id, message) in ids.iter().zip(messages) {
        if message.role == Role::Tool
            && let Some(call) = &message.tool_call_id
            && !messages.iter().any(|m| m.tool_calls.iter().any(|c| &c.id == call))
        {
            return Err(Unrepresentable { message_id: id.clone() });
        }
    }
    Ok(())
}

/// Whether `part` is an image occurrence the overlay can edit (the one definition image preparation uses).
fn is_image_part(part: &ContentPart) -> bool {
    super::prepared_request::image_part(part).is_some()
}

/// The overlay of one session branch.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct ImageOverlay {
    edits: BTreeMap<PartKey, Edit>,
    /// "Continue in a new branch without prior context": messages before this one leave every projection (system and
    /// developer messages stay). The transcript keeps them.
    cut_before: Option<String>,
}

/// The projected history cannot be sent: a required structure would be left without content the wire can represent.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Unrepresentable {
    pub message_id: String,
}

impl ImageOverlay {
    pub fn is_empty(&self) -> bool {
        self.edits.is_empty() && self.cut_before.is_none()
    }

    pub fn omit(&mut self, key: PartKey) {
        self.edits.insert(key, Edit::Omit);
    }

    pub fn replace(&mut self, key: PartKey, image: ImageSource) {
        self.edits.insert(key, Edit::Replace(image));
    }

    pub fn replace_stored(&mut self, key: PartKey, reference: String, mime_type: String, name: String) {
        self.edits.insert(key, Edit::ReplaceStored { reference, mime_type, name });
    }

    /// Every part the overlay edits, with its edit, in a stable order.
    pub fn edits(&self) -> impl Iterator<Item = (&PartKey, &Edit)> {
        self.edits.iter()
    }

    /// The message a new context starts at, when one was chosen.
    pub fn new_context_at(&self) -> Option<&str> {
        self.cut_before.as_deref()
    }

    /// Undo one edit; the original part is back in every later projection.
    pub fn undo(&mut self, key: &PartKey) -> bool {
        self.edits.remove(key).is_some()
    }

    pub fn start_new_context_at(&mut self, message_id: String) {
        self.cut_before = Some(message_id);
    }

    /// Whether the conversation's `index`-th message is left out by a new context: it sits before the message the new context
    /// starts at. `ids` are the conversation's ids in order, as [`stable_message_id`] gives them.
    pub fn cuts(&self, ids: &[String], index: usize) -> bool {
        self.cut_before.as_ref().and_then(|id| ids.iter().position(|m| m == id)).is_some_and(|cut| index < cut)
    }

    pub fn undo_new_context(&mut self) -> bool {
        self.cut_before.take().is_some()
    }

    pub fn edit(&self, key: &PartKey) -> Option<&Edit> {
        self.edits.get(key)
    }

    /// Project `messages` (with their stable ids, in parallel) through the overlay. Tool results keep their call id; an
    /// image-only user or assistant message without tool calls is omitted whole; sibling parts and metadata stay. A message
    /// whose parts lost one records where each remaining part is stored ([`Message::stored_parts`]), so every later choice
    /// names the part the transcript keeps. A message with any image choice is encoded from its content alone: its recorded
    /// form ([`Message::clear_recorded_form`]) holds the images as they were recorded, and leaving out the recorded form is itself
    /// the choice for an image found only there (the part [`mixdog_image_egress::origin::RECORDED_FORM`]).
    pub fn apply(&self, ids: &mut Vec<String>, messages: &mut Vec<Message>) -> Result<(), Unrepresentable> {
        assert_eq!(ids.len(), messages.len(), "one stable id per message");
        let mut out_ids = Vec::with_capacity(ids.len());
        let mut out = Vec::with_capacity(messages.len());
        let cut = self.cut_before.as_ref().and_then(|id| ids.iter().position(|m| m == id));
        // Cloned so a failed projection leaves the caller's history as it was.
        for (index, (id, mut message)) in ids.iter().cloned().zip(messages.iter().cloned()).enumerate() {
            if let Some(cut) = cut
                && index < cut
                && !matches!(message.role, Role::System | Role::Developer)
            {
                continue;
            }
            if self.edits.keys().any(|key| key.message_id == id) {
                message.clear_recorded_form();
            }
            if !self.project_parts(&id, &mut message)? {
                continue;
            }
            out_ids.push(id);
            out.push(message);
        }
        if cut.is_some() {
            reject_orphaned_tool_results(&out_ids, &out)?;
        }
        *ids = out_ids;
        *messages = out;
        Ok(())
    }

    /// Applies the image choices to one message's parts; `false` when the message is left out whole.
    fn project_parts(&self, id: &str, message: &mut Message) -> Result<bool, Unrepresentable> {
        let Content::Parts(parts) = &mut message.content else { return Ok(true) };
        let before = parts.len();
        let mut kept = Vec::with_capacity(before);
        let mut stored = Vec::with_capacity(before);
        for (ordinal, part) in parts.drain(..).enumerate() {
            let key = PartKey { message_id: id.to_owned(), part: ordinal as u32 };
            let edited = match (is_image_part(&part), self.edits.get(&key)) {
                (true, Some(Edit::Omit)) => continue,
                (true, Some(Edit::Replace(image))) => ContentPart::Image(image.clone()),
                (true, Some(Edit::ReplaceStored { reference, mime_type, name })) => ContentPart::File {
                    source: super::provider::BinarySource::AttachmentRef(reference.clone()),
                    mime_type: mime_type.clone(),
                    filename: Some(name.clone()).filter(|n| !n.is_empty()),
                    text: None,
                },
                _ => part,
            };
            kept.push(edited);
            stored.push(ordinal as u32);
        }
        let emptied = kept.is_empty() && before > 0;
        if kept.len() < before {
            message.stored_parts = stored;
        }
        *parts = kept;
        if emptied {
            message.stored_parts = Vec::new();
            match message.role {
                Role::Tool => message.content = Content::Text(String::new().into()),
                Role::Assistant if !message.tool_calls.is_empty() => message.content = Content::Text(String::new().into()),
                Role::User | Role::Assistant => return Ok(false),
                Role::System | Role::Developer => return Err(Unrepresentable { message_id: id.to_owned() }),
            }
        }
        Ok(true)
    }

    pub fn to_json(&self) -> Value {
        let edits: Vec<Value> = self
            .edits
            .iter()
            .map(|(key, edit)| match edit {
                Edit::Omit => json!({ "part": key.id(), "op": "omit" }),
                Edit::Replace(ImageSource::Base64 { data, mime_type, width, height }) => {
                    json!({ "part": key.id(), "op": "replace", "data": data, "mime": mime_type, "width": width, "height": height })
                }
                Edit::ReplaceStored { reference, mime_type, name } => {
                    json!({ "part": key.id(), "op": "replaceStored", "ref": reference, "mime": mime_type, "name": name })
                }
                // A link or provider id is never a replacement the person picked: a file is.
                Edit::Replace(_) => json!({ "part": key.id(), "op": "omit" }),
            })
            .collect();
        json!({ "version": 1, "edits": edits, "cutBefore": self.cut_before })
    }

    /// `None` when the document is not a version-1 overlay; the caller reports it instead of guessing.
    pub fn from_json(value: &Value) -> Option<Self> {
        if value.get("version")?.as_u64()? != 1 {
            return None;
        }
        let mut overlay = Self::default();
        for edit in value.get("edits")?.as_array()? {
            let key = PartKey::parse(edit.get("part")?.as_str()?)?;
            match edit.get("op")?.as_str()? {
                "omit" => overlay.omit(key),
                "replace" => overlay.replace(
                    key,
                    ImageSource::Base64 {
                        data: edit.get("data")?.as_str()?.to_owned(),
                        mime_type: edit.get("mime")?.as_str()?.to_owned(),
                        width: edit.get("width").and_then(Value::as_u64).map(|n| n as u32),
                        height: edit.get("height").and_then(Value::as_u64).map(|n| n as u32),
                    },
                ),
                "replaceStored" => overlay.replace_stored(
                    key,
                    edit.get("ref")?.as_str()?.to_owned(),
                    edit.get("mime")?.as_str()?.to_owned(),
                    edit.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
                ),
                _ => return None,
            }
        }
        overlay.cut_before = value.get("cutBefore").and_then(Value::as_str).map(str::to_owned);
        Some(overlay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::provider::ToolCall;

    fn img(tag: &str) -> ContentPart {
        ContentPart::Image(ImageSource::Base64 { data: tag.into(), mime_type: "image/png".into(), width: None, height: None })
    }

    fn history() -> (Vec<String>, Vec<Message>) {
        let user = Message::new(Role::User, Content::Parts(vec![ContentPart::Text("compare".into(), None), img("u0")]));
        let mut assistant = Message::new(Role::Assistant, Content::Text("looking".into()));
        assistant.tool_calls.push(ToolCall { id: "c1".into(), name: "Read".into(), arguments: Value::Null, native_type: None });
        let mut tool = Message::new(Role::Tool, Content::Parts(vec![img("t0"), img("t1")]));
        tool.tool_call_id = Some("c1".into());
        let only_image = Message::new(Role::User, Content::Parts(vec![img("solo")]));
        (vec!["m0".into(), "m1".into(), "m2".into(), "m3".into()], vec![user, assistant, tool, only_image])
    }

    fn key(m: &str, part: u32) -> PartKey {
        PartKey { message_id: m.into(), part }
    }

    #[test]
    fn omitting_keeps_siblings_call_pairing_and_drops_only_image_only_messages() {
        let (mut ids, mut msgs) = history();
        let mut overlay = ImageOverlay::default();
        for k in [key("m0", 1), key("m2", 0), key("m2", 1), key("m3", 0)] {
            overlay.omit(k);
        }
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert_eq!(ids, vec!["m0", "m1", "m2"], "image-only user message is omitted, nothing else");
        assert!(matches!(&msgs[0].content, Content::Parts(p) if p.len() == 1 && matches!(p[0], ContentPart::Text(..))));
        assert_eq!(msgs[2].tool_call_id.as_deref(), Some("c1"));
        assert_eq!(msgs[2].content, Content::Text(String::new().into()), "a legal empty tool result stays");
        assert_eq!(msgs[1].tool_calls.len(), 1);
    }

    #[test]
    fn a_non_first_tool_image_can_be_dropped_alone() {
        let (mut ids, mut msgs) = history();
        let mut overlay = ImageOverlay::default();
        overlay.omit(key("m2", 1));
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert!(matches!(&msgs[2].content, Content::Parts(p) if p.len() == 1 && p[0] == img("t0")));
    }

    #[test]
    fn replace_keeps_position_and_undo_restores_the_original() {
        let (mut ids, mut msgs) = history();
        let mut overlay = ImageOverlay::default();
        let new = ImageSource::Base64 { data: "new".into(), mime_type: "image/png".into(), width: None, height: None };
        overlay.replace(key("m2", 0), new.clone());
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert!(matches!(&msgs[2].content, Content::Parts(p) if p[0] == ContentPart::Image(new.clone()) && p[1] == img("t1")));
        assert!(overlay.undo(&key("m2", 0)));
        let (mut ids, mut msgs) = history();
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert!(matches!(&msgs[2].content, Content::Parts(p) if p[0] == img("t0")));
    }

    #[test]
    fn new_context_cuts_history_without_deleting_it_and_flags_an_orphaned_result() {
        let (mut ids, mut msgs) = history();
        let mut overlay = ImageOverlay::default();
        overlay.start_new_context_at("m3".into());
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert_eq!(ids, vec!["m3"]);
        // Cutting between a call and its result cannot be represented.
        let (mut ids, mut msgs) = history();
        let mut overlay = ImageOverlay::default();
        overlay.start_new_context_at("m2".into());
        assert_eq!(overlay.apply(&mut ids, &mut msgs), Err(Unrepresentable { message_id: "m2".into() }));
        assert!(overlay.undo_new_context());
        assert!(overlay.is_empty());
    }

    #[test]
    fn a_stored_image_reference_is_edited_like_an_inline_image_and_replaced_by_a_stored_file() {
        let stored = |r: &str| ContentPart::File {
            source: crate::domain::provider::BinarySource::AttachmentRef(r.into()),
            mime_type: "image/png".into(),
            filename: Some("scan.png".into()),
            text: None,
        };
        let mut tool = Message::new(Role::Tool, Content::Parts(vec![stored("a"), ContentPart::Text("x".into(), None), stored("b")]));
        tool.tool_call_id = Some("c1".into());
        let mut assistant = Message::new(Role::Assistant, Content::Text(String::new().into()));
        assistant.tool_calls.push(ToolCall { id: "c1".into(), name: "Read".into(), arguments: Value::Null, native_type: None });
        let history = || (vec!["a0".to_owned(), "t0".to_owned()], vec![assistant.clone(), tool.clone()]);
        let mut overlay = ImageOverlay::default();
        overlay.omit(key("t0", 0));
        overlay.replace_stored(key("t0", 2), "c".repeat(64), "image/jpeg".into(), "new.jpg".into());
        let (mut ids, mut msgs) = history();
        overlay.apply(&mut ids, &mut msgs).unwrap();
        let Content::Parts(parts) = &msgs[1].content else { panic!("parts") };
        assert_eq!(parts.len(), 2, "the omitted reference is gone, the text and the replacement stay in order");
        assert!(
            matches!(&parts[1], ContentPart::File { source: crate::domain::provider::BinarySource::AttachmentRef(r), mime_type, filename, .. } if *r == "c".repeat(64) && mime_type == "image/jpeg" && filename.as_deref() == Some("new.jpg"))
        );
        assert_eq!(ImageOverlay::from_json(&overlay.to_json()), Some(overlay));
    }

    #[test]
    fn a_later_choice_addresses_the_image_where_the_transcript_keeps_it_after_an_earlier_one_closed_a_gap() {
        let row =
            || (vec!["m".to_owned()], vec![Message::new(Role::User, Content::Parts(vec![img("a"), ContentPart::Text("t".into(), None), img("b"), img("c")]))]);
        let mut overlay = ImageOverlay::default();
        overlay.omit(key("m", 0));
        let (mut ids, mut msgs) = row();
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert_eq!(msgs[0].stored_parts, vec![1, 2, 3], "the projection shows parts 1, 2 and 3 of the stored message");
        // A refusal of `c` therefore names stored part 3, and replacing part 3 replaces `c`, never `b`.
        let new = ImageSource::Base64 { data: "new".into(), mime_type: "image/png".into(), width: None, height: None };
        overlay.replace(key("m", 3), new.clone());
        let (mut ids, mut msgs) = row();
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert!(matches!(&msgs[0].content, Content::Parts(p) if p[1] == img("b") && p[2] == ContentPart::Image(new.clone())));
        // With nothing left out the parts are where they are stored.
        let mut only_replace = ImageOverlay::default();
        only_replace.replace(key("m", 2), new);
        let (mut ids, mut msgs) = row();
        only_replace.apply(&mut ids, &mut msgs).unwrap();
        assert!(msgs[0].stored_parts.is_empty());
    }

    #[test]
    fn an_image_choice_leaves_the_recorded_form_of_its_message_out_and_only_of_that_message() {
        let recorded = |content: Content| {
            let mut message = Message::new(Role::Assistant, content);
            message.assistant_blocks = Some(json!([{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "x" } }]));
            message.gemini_metadata = Some(json!({ "textParts": [] }));
            message
        };
        let history = || {
            (
                vec!["a1".to_owned(), "a2".to_owned()],
                vec![recorded(Content::Parts(vec![ContentPart::Text("t".into(), None), img("p")])), recorded(Content::Text("x".into()))],
            )
        };
        let mut overlay = ImageOverlay::default();
        overlay.omit(key("a1", 1));
        let (mut ids, mut msgs) = history();
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert!(msgs[0].assistant_blocks.is_none() && msgs[0].gemini_metadata.is_none(), "the omitted image cannot come back through it");
        assert!(msgs[1].assistant_blocks.is_some(), "another message keeps its recorded form");
        // An image found only in the recorded form is left out by leaving out the recorded form.
        let mut overlay = ImageOverlay::default();
        overlay.omit(key("a2", mixdog_image_egress::origin::RECORDED_FORM));
        let (mut ids, mut msgs) = history();
        overlay.apply(&mut ids, &mut msgs).unwrap();
        assert!(msgs[1].assistant_blocks.is_none());
        assert_eq!(msgs[1].content, Content::Text("x".into()), "its content stays");
    }

    #[test]
    fn json_round_trip_survives_restart_and_rejects_other_versions() {
        let mut overlay = ImageOverlay::default();
        overlay.omit(key("m1", 2));
        overlay.replace(key("m2", 0), ImageSource::Base64 { data: "x".into(), mime_type: "image/png".into(), width: Some(3), height: None });
        overlay.start_new_context_at("m9".into());
        assert_eq!(ImageOverlay::from_json(&overlay.to_json()), Some(overlay));
        assert!(ImageOverlay::from_json(&json!({ "version": 2, "edits": [] })).is_none());
    }
}
