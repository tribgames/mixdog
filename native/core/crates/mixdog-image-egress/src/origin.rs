//! Raw, unprepared image intents: where an image sits in a request and what form it arrived in.

/// The role of the message an image sits in.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Role {
    User,
    Assistant,
    Tool,
    System,
}

impl Role {
    pub fn label(self) -> &'static str {
        match self {
            Role::User => "your message",
            Role::Assistant => "an assistant message",
            Role::Tool => "a tool result",
            Role::System => "a system message",
        }
    }
}

/// Stable identity of one image occurrence in a request; recovery actions address images by it. Two origins are equal when they
/// name the same occurrence: the display fields (name, turn, tool label) are what is shown, never part of the identity.
#[derive(Clone, Debug)]
pub struct Origin {
    pub session: String,
    pub branch: String,
    pub message_id: String,
    pub role: Role,
    pub tool_call_id: Option<String>,
    /// Path of the part inside the message (indices, outermost first); keeps a non-first tool image distinct.
    pub part_path: Vec<u32>,
    /// Original file name, or empty when the image had none.
    pub display_name: String,
    /// One-based turn number shown to the user.
    pub turn: u32,
    /// Tool name for a tool result, shown in refusal text.
    pub tool_label: Option<String>,
}

impl Origin {
    fn identity(&self) -> (&str, &str, &str, Role, Option<&str>, &[u32]) {
        (&self.session, &self.branch, &self.message_id, self.role, self.tool_call_id.as_deref(), &self.part_path)
    }
}

impl PartialEq for Origin {
    fn eq(&self, other: &Self) -> bool {
        self.identity() == other.identity()
    }
}

impl Eq for Origin {}

impl std::hash::Hash for Origin {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.identity().hash(state);
    }
}

/// The second `part_path` index of an image that sits in the provider's recorded form of a message (its replay envelope, ordered
/// blocks or Gemini metadata) rather than in its content: `[message, RECORDED_FORM, n]`, the `n`-th such image. The message's
/// content parts are `[message, part]`, with `part` the part's position in the stored message.
pub const RECORDED_FORM: u32 = u32::MAX;

impl Origin {
    /// Whether the image sits in the provider's recorded form of its message ([`RECORDED_FORM`]).
    pub fn in_recorded_form(&self) -> bool {
        self.part_path.get(1) == Some(&RECORDED_FORM)
    }

    /// Stable string id: equal for equal origins, never containing a name or URL.
    pub fn stable_id(&self) -> String {
        let path: Vec<String> = self.part_path.iter().map(u32::to_string).collect();
        format!("{}/{}/{}/{}", self.session, self.branch, self.message_id, path.join("."))
    }

    /// Plain place description for a refusal: the name, or role, turn and ordinal.
    pub fn describe(&self) -> String {
        let place = match (&self.tool_label, self.role) {
            (Some(tool), Role::Tool) => format!("in tool result '{tool}', turn {}", self.turn),
            _ => format!("in {}, turn {}", self.role.label(), self.turn),
        };
        let ordinal = self.part_path.last().map_or(1, |i| i + 1);
        if self.display_name.is_empty() { format!("image {ordinal} {place}") } else { format!("`{}` {place}", self.display_name) }
    }
}

/// Handle to an image the attachment store owns.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct StoredImageId(pub String);

/// The form an image arrived in. Never an already-prepared value.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ImageSource {
    /// Bytes held in memory; the type is sniffed, any supplied label is ignored.
    Inline(Vec<u8>),
    /// A `data:` URL, split and decoded strictly during preparation.
    DataUrl(String),
    /// Base64 text with the label it arrived with; the label is never trusted, the sniffed type is.
    Base64 { label: String, data: String },
    /// A remote link.
    Link(String),
    /// A provider file id issued by `issuer`.
    ProviderFileId { issuer: String, id: String },
    /// A reference into the attachment store.
    Stored(StoredImageId),
}

impl ImageSource {
    pub fn form(&self) -> SourceForm {
        match self {
            ImageSource::Inline(_) => SourceForm::Inline,
            ImageSource::DataUrl(_) | ImageSource::Base64 { .. } => SourceForm::DataUrl,
            ImageSource::Link(_) => SourceForm::Link,
            ImageSource::ProviderFileId { .. } => SourceForm::FileId,
            ImageSource::Stored(_) => SourceForm::Stored,
        }
    }
}

/// Source forms, the rows of the destination matrix.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum SourceForm {
    Inline,
    DataUrl,
    Link,
    FileId,
    Stored,
}

/// One intended image occurrence.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ImageIntent {
    pub origin: Origin,
    pub source: ImageSource,
}
