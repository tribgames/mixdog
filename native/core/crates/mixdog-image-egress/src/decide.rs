//! The destination matrix as one pure function over stored facts: original, stored rendition, or refusal.

use crate::origin::{Origin, SourceForm};
use crate::policy::{ImageKind, InputImagePolicy};
use crate::refusal::{Reason, Refusal};

/// Facts the importer recorded for one validated original (never derived from supplied metadata).
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ImageFacts {
    pub(crate) kind: ImageKind,
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Frames or pages; 1 for a single picture.
    pub(crate) frames: u32,
    pub(crate) encoded_len: u64,
    /// Kind, size and encoded length of the stored rendition (PNG, or JPEG for a converted HEIC), when the importer made one.
    pub(crate) rendition: Option<RenditionFacts>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RenditionFacts {
    pub(crate) kind: ImageKind,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) encoded_len: u64,
}

impl ImageFacts {
    /// Only [`crate::manifest::Manifest::facts`] builds facts: they exist because an import validated the bytes.
    pub(crate) fn from_manifest(kind: ImageKind, width: u32, height: u32, frames: u32, encoded_len: u64, rendition: Option<RenditionFacts>) -> Self {
        Self { kind, width, height, frames, encoded_len, rendition }
    }

    /// Facts for a test double; absent from release builds of every crate.
    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test(kind: ImageKind, width: u32, height: u32, frames: u32, encoded_len: u64, png: Option<(u32, u32, u64)>) -> Self {
        Self::for_test_with(kind, width, height, frames, encoded_len, png.map(|(w, h, l)| (ImageKind::Png, w, h, l)))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn for_test_with(kind: ImageKind, width: u32, height: u32, frames: u32, encoded_len: u64, rendition: Option<(ImageKind, u32, u32, u64)>) -> Self {
        Self::from_manifest(kind, width, height, frames, encoded_len, rendition.map(|(k, w, h, l)| RenditionFacts::from_rendition(k, w, h, l)))
    }

    pub fn kind(&self) -> ImageKind {
        self.kind
    }

    pub fn frames(&self) -> u32 {
        self.frames
    }

    pub fn rendition(&self) -> Option<RenditionFacts> {
        self.rendition
    }
}

impl RenditionFacts {
    pub(crate) fn from_rendition(kind: ImageKind, width: u32, height: u32, encoded_len: u64) -> Self {
        Self { kind, width, height, encoded_len }
    }

    pub fn kind(&self) -> ImageKind {
        self.kind
    }

    pub fn encoded_len(&self) -> u64 {
        self.encoded_len
    }
}

/// What to put on the wire for an image whose bytes the store holds.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Choice {
    Original,
    /// The stored rendition: PNG for AVIF, TIFF, SVG, still GIF and oversize stills, JPEG for an oversize JPEG and a HEIC.
    Rendition,
}

fn fits(policy: &InputImagePolicy, width: u32, height: u32, len: u64) -> bool {
    let l = policy.limits;
    l.max_edge.is_none_or(|edge| width.max(height) <= edge) && l.max_image_base64.is_none_or(|max| crate::policy::base64_len(len) <= max)
}

fn refuse(origin: &Origin, reason: Reason) -> Refusal {
    Refusal::new(origin.clone(), reason)
}

/// Decide for an image with local bytes (inline, data URL or stored). Count and aggregate limits are checked by the batch.
pub fn decide_local(origin: &Origin, facts: &ImageFacts, policy: &InputImagePolicy) -> Result<Choice, Refusal> {
    if !policy.vision {
        return Err(refuse(origin, Reason::NoVision));
    }
    if !policy.takes_role(origin.role) {
        return Err(refuse(origin, Reason::RoleNotAccepted));
    }
    let kind = facts.kind;
    let multi = facts.frames > 1;
    if matches!(kind, ImageKind::Bmp | ImageKind::Ico) {
        return Err(refuse(origin, Reason::UnsupportedKind(kind)));
    }
    if policy.takes_kind(kind) && policy.takes_frames(kind, facts.frames) {
        if fits(policy, facts.width, facts.height, facts.encoded_len) {
            return Ok(Choice::Original);
        }
        if multi {
            return Err(refuse(origin, Reason::TooLarge));
        }
        return rendition_choice(origin, facts, policy, Reason::TooLarge);
    }
    if multi {
        return Err(refuse(origin, Reason::Animated(kind)));
    }
    rendition_choice(origin, facts, policy, Reason::UnsupportedKind(kind))
}

fn rendition_choice(origin: &Origin, facts: &ImageFacts, policy: &InputImagePolicy, none: Reason) -> Result<Choice, Refusal> {
    match facts.rendition {
        Some(r) if policy.takes_kind(r.kind) && fits(policy, r.width, r.height, r.encoded_len) => Ok(Choice::Rendition),
        _ => Err(refuse(origin, none)),
    }
}

/// How a pointer (link or provider file id) is carried.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pointer {
    /// Send the native pointer.
    Native,
    /// A locally owned validated original exists: resolve it and decide as local bytes.
    UseLocal,
}

/// Decide for a link or provider file id. `trusted` is evidence of immutable content with accepted MIME and size (links) or a
/// live matching issuer/account/endpoint receipt (file ids); `local` is the owned original, when one is associated.
pub fn decide_pointer(origin: &Origin, form: SourceForm, policy: &InputImagePolicy, trusted: bool, local: Option<&ImageFacts>) -> Result<Pointer, Refusal> {
    if !policy.vision {
        return Err(refuse(origin, Reason::NoVision));
    }
    if !policy.takes_role(origin.role) {
        return Err(refuse(origin, Reason::RoleNotAccepted));
    }
    let (carried, reason) = match form {
        SourceForm::Link => (policy.links && policy.takes_form(form), Reason::MutableLink),
        SourceForm::FileId => (policy.file_ids && policy.takes_form(form), Reason::UnverifiedFileId),
        _ => return Err(refuse(origin, Reason::SourceFormNotCarried)),
    };
    if carried && trusted {
        return Ok(Pointer::Native);
    }
    if local.is_some() {
        return Ok(Pointer::UseLocal);
    }
    Err(refuse(
        origin,
        if carried {
            reason
        } else if form == SourceForm::Link {
            Reason::SourceFormNotCarried
        } else {
            reason
        },
    ))
}
