//! The reference images of a media job (an edit's source pictures, a video's seed or reference list). Each one is prepared for the
//! media endpoint and model that is actually called, through the same contract as a chat request: the destination's matrix
//! chooses the stored original or rendition or refuses, every blocker is named at once, and nothing is dropped, truncated or
//! replaced. A helper holds an [`ImageReference`], which only [`References::prepare`] can make.

use std::sync::Arc;

use base64::Engine as _;
use mixdog_core_api::domain::image_supply::NoSupply;
use mixdog_core_api::domain::image_supply::PrepareFailure;
use mixdog_core_api::domain::image_supply::installed;
use mixdog_core_api::domain::image_supply::prepare_intent;
use mixdog_image_egress::Body;
use mixdog_image_egress::ImageIntent;
use mixdog_image_egress::ImageSource;
use mixdog_image_egress::NotSent;
use mixdog_image_egress::Origin;
use mixdog_image_egress::Plan;
use mixdog_image_egress::Role;
use mixdog_image_egress::StoredImageId;
use mixdog_image_egress::route::RouteFacts;
use mixdog_image_egress::route::Vision;
use mixdog_image_egress::route::WireBranch;
use mixdog_image_egress::route::resolve;
use serde_json::Value;

use super::download::AdapterError;
use super::lanes::LaneError;

/// How a job names one reference image.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReferenceSource {
    /// Base64 (or a base64 `data:` URL) of the picture's bytes; the type is read from the bytes, never from a label.
    Base64(String),
    /// A picture the attachment store holds: 64 hex digits.
    Stored(String),
}

/// One reference image of a job, as it arrived.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Reference {
    pub source: ReferenceSource,
    /// The picture's own file name, shown when it is refused.
    pub name: String,
}

impl Reference {
    pub fn base64(data: impl Into<String>) -> Self {
        Self { source: ReferenceSource::Base64(data.into()), name: String::new() }
    }

    /// One entry of a job's `references` array: `{ base64 | ref, name? }`. Anything else is an error, never skipped.
    pub fn from_json(value: &Value) -> Option<Self> {
        let name = value.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
        let text = |key: &str| value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty());
        if value.get("base64").is_some() == value.get("ref").is_some() {
            return None;
        }
        match (text("base64"), text("ref")) {
            (Some(data), None) => Some(Self { source: ReferenceSource::Base64(data.to_owned()), name }),
            (None, Some(digest)) if digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()) => {
                Some(Self { source: ReferenceSource::Stored(digest.to_ascii_lowercase()), name })
            }
            _ => None,
        }
    }
}

/// The reference list of one job and the most the model takes.
#[derive(Clone, Debug)]
pub struct References {
    items: Vec<Reference>,
    max: usize,
}

/// What one media call is sent to: the URL it is posted to and the account it is posted as, the model and the operation. Every
/// wire branch of a helper names its own: a fallback to another endpoint or model is a new target and prepares again.
#[derive(Clone, Copy, Debug)]
pub struct Target<'a> {
    pub endpoint: &'a str,
    /// Opaque: an OAuth account id, or [`key_account`] of an API key.
    pub account: &'a str,
    pub model: &'a str,
    pub operation: &'a str,
}

/// The account an API key stands for, opaque and not the key: the first 16 hex digits of its SHA-256.
pub fn key_account(key: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(key.as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// The account a lane's credentials post as: its OAuth account where it names one, else its key's [`key_account`].
pub fn account_of(auth: &super::catalog_fetch::Auth) -> String {
    auth.account_id.clone().filter(|id| !id.is_empty()).unwrap_or_else(|| key_account(&auth.token))
}

/// A reference image prepared for one target: validated bytes of a type that endpoint takes. Only [`References::prepare`] builds
/// one.
#[derive(Clone, Debug)]
pub struct ImageReference {
    mime: &'static str,
    bytes: Arc<[u8]>,
}

impl ImageReference {
    pub fn mime(&self) -> &'static str {
        self.mime
    }

    pub fn base64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(&self.bytes)
    }

    pub fn data_url(&self) -> String {
        format!("data:{};base64,{}", self.mime, self.base64())
    }
}

/// Where reference `index` of a job sits, for a refusal that names it.
pub(crate) fn reference_origin(index: usize, reference: &Reference) -> Origin {
    Origin {
        session: "media".to_owned(),
        branch: String::new(),
        message_id: "references".to_owned(),
        role: Role::User,
        tool_call_id: None,
        part_path: vec![index as u32],
        display_name: reference.name.clone(),
        turn: 1,
        tool_label: None,
    }
}

/// The whole call refused for its reference images: every blocker named in the message and carried whole, so the job can show
/// which reference to fix and how.
fn refused(not_sent: NotSent) -> AdapterError {
    let mut error: AdapterError = LaneError { message: not_sent.message(), code: "MEDIA_REFERENCE_REFUSED", status: 400 }.into();
    error.refusal = Some(Box::new(not_sent));
    error
}

fn unavailable(why: &str) -> AdapterError {
    LaneError {
        message: format!("Nothing was sent. The reference images could not be checked just now ({why}). Try again in a moment."),
        code: "MEDIA_REFERENCE_UNAVAILABLE",
        status: 503,
    }
    .into()
}

impl References {
    pub fn new(items: Vec<Reference>, max: usize) -> Self {
        Self { items, max }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Every reference prepared for `target`, in order, or the whole call refused with every blocker named. A call with no
    /// reference needs no image and prepares nothing.
    pub async fn prepare(&self, target: &Target<'_>) -> Result<Vec<ImageReference>, AdapterError> {
        if self.items.is_empty() {
            return Ok(Vec::new());
        }
        let mut facts = RouteFacts::declared(target.endpoint, target.model, WireBranch::MediaInline, Vision::Yes);
        facts.account = target.account.to_owned();
        facts.operation = target.operation.to_owned();
        let pinned = resolve(&facts);
        let mut policy = pinned.policy().clone();
        policy.limits.max_images = Some(self.max as u32);
        let plan = Plan::new(pinned.route().clone(), policy);
        let intents: Vec<ImageIntent> = self
            .items
            .iter()
            .enumerate()
            .map(|(index, reference)| {
                let origin = reference_origin(index, reference);
                let source = match &reference.source {
                    ReferenceSource::Base64(data) if data.starts_with("data:") => ImageSource::DataUrl(data.clone()),
                    ReferenceSource::Base64(data) => ImageSource::Base64 { label: String::new(), data: data.clone() },
                    ReferenceSource::Stored(digest) => ImageSource::Stored(StoredImageId(digest.clone())),
                };
                ImageIntent { origin, source }
            })
            .collect();
        let supply = installed().unwrap_or_else(|| Arc::new(NoSupply));
        let mut batch = plan.batch(intents.iter().map(|intent| intent.origin.clone()).collect());
        for intent in &intents {
            match prepare_intent(&plan, intent, supply.as_ref()).await {
                Ok(image) => batch.accept(image),
                Err(PrepareFailure::Refused(refusal)) => batch.refuse(refusal),
                Err(PrepareFailure::Unavailable(why)) => return Err(unavailable(&why)),
            }
        }
        let sealed = batch.seal().map_err(refused)?;
        // Every reference is local bytes (base64 or a stored picture), so every image the batch holds is inline.
        Ok(sealed
            .images()
            .iter()
            .map(|image| match image.body() {
                Body::Inline { mime, bytes } => ImageReference { mime, bytes: bytes.clone() },
                other => unreachable!("an inline-only plan prepared {other:?}"),
            })
            .collect())
    }
}
