//! Destination policy: what one resolved route accepts as image input.

use crate::origin::{Role, SourceForm};

/// What a request is sent to. Anything not named here is `Unknown`, which advertises no support.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Column {
    /// Gemini native vision.
    Gemini,
    /// Anthropic Messages.
    Messages,
    /// OpenAI Responses.
    Responses,
    /// Chat-compatible vision.
    Chat,
    /// Inline-only vision, including protobuf and media endpoints.
    Inline,
    /// No supported image input.
    None,
}

/// Container types the pipeline recognises.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ImageKind {
    Png,
    Jpeg,
    Webp,
    Gif,
    Avif,
    Tiff,
    Svg,
    Heic,
    Bmp,
    Ico,
}

impl ImageKind {
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Webp => "image/webp",
            ImageKind::Gif => "image/gif",
            ImageKind::Avif => "image/avif",
            ImageKind::Tiff => "image/tiff",
            ImageKind::Svg => "image/svg+xml",
            ImageKind::Heic => "image/heic",
            ImageKind::Bmp => "image/bmp",
            ImageKind::Ico => "image/x-icon",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ImageKind::Png => "PNG",
            ImageKind::Jpeg => "JPEG",
            ImageKind::Webp => "WebP",
            ImageKind::Gif => "GIF",
            ImageKind::Avif => "AVIF",
            ImageKind::Tiff => "TIFF",
            ImageKind::Svg => "SVG",
            ImageKind::Heic => "HEIC",
            ImageKind::Bmp => "BMP",
            ImageKind::Ico => "ICO",
        }
    }
}

/// Identity of the resolved route. A request is prepared and sent against exactly one key; a different key is a new plan.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct RouteKey {
    /// Provider instance and endpoint.
    pub endpoint: String,
    /// Opaque tenant or account id.
    pub account: String,
    /// Resolved deployment or model.
    pub model: String,
    /// Wire branch inside the provider (chat, router, edit, video, ...).
    pub wire_branch: String,
    pub operation: String,
    pub capability_revision: u32,
}

/// Per-route image limits, each as the destination declares it. `None` is a limit the destination declares none of: nothing is
/// refused for it here, and the provider judges.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Limits {
    /// Images in one request.
    pub max_images: Option<u32>,
    /// Longest edge of one image, in pixels.
    pub max_edge: Option<u32>,
    /// Base64 length of one image (the providers that state a size limit measure the encoded text).
    pub max_image_base64: Option<u64>,
}

impl Limits {
    const NONE: Self = Self { max_images: None, max_edge: None, max_image_base64: None };
}

/// The base64 length of `bytes` encoded bytes (padded).
pub fn base64_len(bytes: u64) -> u64 {
    bytes.div_ceil(3) * 4
}

/// What the destination takes as image input. `InputImagePolicy::unknown()` takes none.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct InputImagePolicy {
    pub column: Column,
    pub vision: bool,
    /// Kinds the route accepts unchanged.
    pub accepted: Vec<ImageKind>,
    /// Accepted kinds the route takes only as a single picture: an animated one of these is refused, never flattened.
    pub still_only: Vec<ImageKind>,
    /// Source forms the wire can carry (stored references resolve to inline, so `Stored` needs `Inline`).
    pub forms: Vec<SourceForm>,
    pub roles: Vec<Role>,
    /// Links this wire accepts (scheme/form) when immutable-content evidence exists.
    pub links: bool,
    /// Provider file ids this wire accepts when issuer evidence matches.
    pub file_ids: bool,
    pub limits: Limits,
}

/// One destination column as its provider declares it. Formats are the provider's documented input types; a limit is one the
/// provider documents (and which 1.4.5 already met, see each row), never a cap of this app's own.
struct Row {
    column: Column,
    accepted: &'static [ImageKind],
    still_only: &'static [ImageKind],
    roles: &'static [Role],
    links: bool,
    file_ids: bool,
    limits: Limits,
}

use ImageKind::{Gif, Heic, Jpeg, Png, Webp};
const ALL_ROLES: &[Role] = &[Role::User, Role::Assistant, Role::Tool];

/// The one table of destination facts.
///
/// * Gemini (Gemini API and Vertex AI Gemini, image understanding): PNG, JPEG, WebP, HEIC/HEIF. 1.4.5 sent every inline image as
///   it was (`normalizeContentForGeminiParts`) with no limit of its own; the request-size limit Google states for inline data has
///   changed between releases, so none is applied here.
/// * Messages (Anthropic, direct and through Vertex AI): JPEG, PNG, GIF, WebP. 5 MB of base64 per image (Anthropic's stated
///   limit on Vertex AI and Bedrock, and the `API_IMAGE_MAX_BASE64_SIZE` 1.4.5 fitted every image under in
///   `prepareAnthropicImages`); 2000 px per edge, the limit Anthropic states for a request of more than 20 images, applied to
///   every request so that crossing 20 images never changes an earlier image's bytes (1.4.5 kept every image inside its 1568 px
///   box for the same reason). The image count and request size Anthropic states depend on the model and have changed, so none
///   is applied.
/// * Responses (OpenAI): PNG, JPEG, WebP and non-animated GIF; 1.4.5 sent every image as it was.
/// * Chat (OpenAI-compatible chat routes, Vertex AI open models, local runtimes with vision): no formats or limits declared
///   beyond the OpenAI image types; 1.4.5 sent every image as it was, GIF and animations included.
/// * Inline (Cursor, Devin, media endpoints): PNG, JPEG, WebP, the types every one of them takes; only the person's and a tool
///   result's images, since an assistant turn is lowered to text there.
const TABLE: [Row; 5] = [
    Row { column: Column::Gemini, accepted: &[Png, Jpeg, Webp, Heic], still_only: &[], roles: ALL_ROLES, links: true, file_ids: false, limits: Limits::NONE },
    Row {
        column: Column::Messages,
        accepted: &[Png, Jpeg, Gif, Webp],
        still_only: &[],
        roles: ALL_ROLES,
        links: true,
        file_ids: true,
        limits: Limits { max_images: None, max_edge: Some(2000), max_image_base64: Some(5 * 1024 * 1024) },
    },
    Row {
        column: Column::Responses,
        accepted: &[Png, Jpeg, Gif, Webp],
        still_only: &[Gif],
        roles: ALL_ROLES,
        links: true,
        file_ids: true,
        limits: Limits::NONE,
    },
    Row { column: Column::Chat, accepted: &[Png, Jpeg, Gif, Webp], still_only: &[], roles: ALL_ROLES, links: true, file_ids: false, limits: Limits::NONE },
    Row {
        column: Column::Inline,
        accepted: &[Png, Jpeg, Webp],
        still_only: &[],
        roles: &[Role::User, Role::Tool],
        links: false,
        file_ids: false,
        limits: Limits::NONE,
    },
];

/// The tightest edge and base64 length any destination declares: a rendition made at import within both reaches every one.
pub const fn tightest_limits() -> (u32, u64) {
    let (mut edge, mut base64) = (u32::MAX, u64::MAX);
    let mut index = 0;
    while index < TABLE.len() {
        if let Some(max) = TABLE[index].limits.max_edge
            && max < edge
        {
            edge = max;
        }
        if let Some(max) = TABLE[index].limits.max_image_base64
            && max < base64
        {
            base64 = max;
        }
        index += 1;
    }
    (edge, base64)
}

impl InputImagePolicy {
    /// No advertised support: every image is refused.
    pub fn unknown() -> Self {
        Self {
            column: Column::None,
            vision: false,
            accepted: Vec::new(),
            still_only: Vec::new(),
            forms: Vec::new(),
            roles: Vec::new(),
            links: false,
            file_ids: false,
            limits: Limits::NONE,
        }
    }

    /// The policy of a destination column, from [`TABLE`].
    pub fn for_column(column: Column) -> Self {
        let Some(row) = TABLE.iter().find(|row| row.column == column) else { return Self::unknown() };
        let mut forms = vec![SourceForm::Inline, SourceForm::DataUrl, SourceForm::Stored];
        if row.links {
            forms.push(SourceForm::Link);
        }
        if row.file_ids {
            forms.push(SourceForm::FileId);
        }
        Self {
            column,
            vision: true,
            accepted: row.accepted.to_vec(),
            still_only: row.still_only.to_vec(),
            forms,
            roles: row.roles.to_vec(),
            links: row.links,
            file_ids: row.file_ids,
            limits: row.limits,
        }
    }

    pub fn takes_kind(&self, kind: ImageKind) -> bool {
        self.accepted.contains(&kind)
    }

    /// Whether `kind` is taken with `frames` frames or pages as it is.
    pub fn takes_frames(&self, kind: ImageKind, frames: u32) -> bool {
        frames <= 1 || !self.still_only.contains(&kind)
    }

    pub fn takes_role(&self, role: Role) -> bool {
        self.roles.contains(&role)
    }

    pub fn takes_form(&self, form: SourceForm) -> bool {
        self.forms.contains(&form)
    }
}
