//! The refusal protocol: why an image cannot be sent, in plain words, and what the user can do about it locally.

use crate::origin::Origin;
use crate::policy::ImageKind;

/// Local actions that fix a refusal without calling a model.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum RecoveryAction {
    /// Import a local file in place of the named image.
    ReplaceImage,
    /// Drop the named images from the projection after explicit confirmation.
    ContinueWithout,
    /// Start a new branch of the same session without prior context.
    NewBranchWithoutContext,
}

/// Why one image occurrence cannot be sent to the resolved route.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Reason {
    NoVision,
    RoleNotAccepted,
    UnsupportedKind(ImageKind),
    /// Animated or multipage, and the route cannot take the whole image.
    Animated(ImageKind),
    TooLarge,
    OverCount { limit: u32 },
    MutableLink,
    UnverifiedFileId,
    /// This wire has no form for the source (for example a link on an inline-only endpoint).
    SourceFormNotCarried,
    /// The stored original, or its needed rendition, is missing or fails its integrity check.
    Missing,
    Corrupt,
    MalformedDataUrl,
    /// Permanent refusal recorded at import with its short text.
    ImportRefused(String),
}

/// One blocker: the image, the reason, the message shown and the local actions that work.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Refusal {
    pub origin: Origin,
    pub reason: Reason,
    pub actions: Vec<RecoveryAction>,
}

impl Refusal {
    /// The actions are the ones that work for where the image sits: an image in the provider's recorded form of a message has no
    /// part of its own to put a file in, so it can only be left out (which leaves that recorded form out with it).
    pub fn new(origin: Origin, reason: Reason) -> Self {
        let actions = if origin.in_recorded_form() {
            vec![RecoveryAction::ContinueWithout]
        } else {
            vec![RecoveryAction::ReplaceImage, RecoveryAction::ContinueWithout]
        };
        Self { origin, reason, actions }
    }

    fn clause(&self) -> String {
        let place = self.origin.describe();
        match &self.reason {
            Reason::NoVision => format!("This model cannot read images, so {place} cannot be sent."),
            Reason::RoleNotAccepted => format!("This model does not accept images in this position ({place})."),
            Reason::UnsupportedKind(kind) => format!("{place} is a {} image. This model cannot read it.", kind.label()),
            Reason::Animated(kind) => {
                format!("{place} is an animated or multi-page {} image, which this model cannot read in full.", kind.label())
            }
            Reason::TooLarge => format!("{place} is too large for this model and cannot be reduced further."),
            Reason::OverCount { limit } => format!("{place} is past the {limit} images this model takes in one request."),
            Reason::MutableLink => format!("This model cannot use the image link in {place}."),
            Reason::UnverifiedFileId => format!("This model cannot open {place}, because the picture is kept by another service, not on this computer."),
            Reason::SourceFormNotCarried => format!("This model cannot take the way {place} was attached."),
            Reason::Missing => format!("The stored file for {place} is missing."),
            Reason::Corrupt => format!("The stored file for {place} is damaged."),
            Reason::MalformedDataUrl => format!("{place} is not a valid image."),
            Reason::ImportRefused(text) => format!("{place} was refused when attached: {text}"),
        }
    }

    /// The sentence naming the image and the actions that work. Never carries a URL, credential or file id.
    pub fn message(&self) -> String {
        let replace = match self.reason {
            Reason::MutableLink => "Replace the link with an image file",
            Reason::UnverifiedFileId => "Replace it with an image file",
            _ => "Replace that image with PNG or JPEG",
        };
        let mut actions = Vec::new();
        for action in &self.actions {
            match action {
                RecoveryAction::ReplaceImage => actions.push(replace.to_string()),
                RecoveryAction::ContinueWithout => actions.push("continue without it".to_string()),
                RecoveryAction::NewBranchWithoutContext => actions.push("start again from your last message, leaving out the earlier conversation".to_string()),
            }
        }
        match actions.len() {
            0 => self.clause(),
            1 => format!("{} {}.", self.clause(), actions[0]),
            _ => format!("{} {}, or {}.", self.clause(), actions[..actions.len() - 1].join(", "), actions[actions.len() - 1]),
        }
    }
}

/// Typed result of a request that left nothing on the wire. Kept outside accounting and retry.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NotSent {
    pub blockers: Vec<Refusal>,
    /// Whether starting again from the last message without the earlier conversation is offered: only where that leaves every
    /// blocker out, which the sender of the request decides ([`NotSent::offer_new_context`]).
    pub new_context_offered: bool,
}

impl NotSent {
    /// `blockers` must not be empty.
    pub fn new(blockers: Vec<Refusal>) -> Self {
        debug_assert!(!blockers.is_empty());
        Self { blockers, new_context_offered: false }
    }

    /// Offer the new start when every blocker sits in a message before `first_kept`, the message it would start from (the
    /// first `part_path` index is the message's place in the request).
    pub fn offer_new_context(&mut self, first_kept: usize) {
        self.new_context_offered = self.blockers.iter().all(|blocker| blocker.origin.part_path.first().is_some_and(|&message| (message as usize) < first_kept));
    }

    /// "Nothing was sent." followed by every blocker's message.
    pub fn message(&self) -> String {
        let mut text = String::from("Nothing was sent.");
        for blocker in &self.blockers {
            text.push(' ');
            text.push_str(&blocker.message());
        }
        text
    }
}
