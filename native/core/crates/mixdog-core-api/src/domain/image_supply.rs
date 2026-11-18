//! Where the transport layer gets the verdict and the bytes of an image it has to send. The attachment store implements it; the
//! provider layer only asks. A send reads recorded verdicts and stored bytes and never decodes an image of its own.

use std::sync::Arc;
use std::sync::RwLock;

use async_trait::async_trait;
use mixdog_image_egress::Body;
use mixdog_image_egress::Choice;
use mixdog_image_egress::ImageIntent;
use mixdog_image_egress::ImageSource;
use mixdog_image_egress::Manifest;
use mixdog_image_egress::Origin;
use mixdog_image_egress::Outcome;
use mixdog_image_egress::Plan;
use mixdog_image_egress::PreparedImage;
use mixdog_image_egress::Reason;
use mixdog_image_egress::Refusal;
use mixdog_image_egress::SourceForm;
use mixdog_image_egress::decide_local;

/// Why the supply could not answer for one image.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SupplyError {
    /// The stored original or the rendition the verdict names is gone.
    Missing,
    /// What is stored fails its integrity check.
    Corrupt,
    /// The text is not base64 of an image-sized payload (no bytes to key a verdict by).
    NotAnImage(String),
    /// The store could not answer now (queue full, cancelled, storage failing); the send is not made, nothing is claimed
    /// about the image.
    Unavailable(String),
}

#[async_trait]
pub trait ImageSupply: Send + Sync {
    /// The verdict of an inline base64 image (imported once, keyed by the digest of its bytes).
    async fn inline(&self, base64: &str) -> Result<Manifest, SupplyError>;
    /// The verdict of a stored attachment reference (64 hex digits).
    async fn stored(&self, reference: &str) -> Result<Manifest, SupplyError>;
    /// The verified stored bytes of the original or of the rendition `choice` names.
    async fn bytes(&self, manifest: &Manifest, choice: Choice) -> Result<Arc<[u8]>, SupplyError>;
}

/// Why one occurrence could not be prepared.
#[derive(Debug)]
pub enum PrepareFailure {
    /// The destination (or the store's verdict) refuses this image; the refusal names it and an action that works.
    Refused(Refusal),
    /// The store could not answer now; nothing is claimed about the image.
    Unavailable(String),
}

fn refuse(origin: &Origin, reason: Reason) -> PrepareFailure {
    PrepareFailure::Refused(Refusal::new(origin.clone(), reason))
}

fn from_supply(origin: &Origin, error: SupplyError) -> PrepareFailure {
    match error {
        SupplyError::Missing => refuse(origin, Reason::Missing),
        SupplyError::Corrupt => refuse(origin, Reason::Corrupt),
        SupplyError::NotAnImage(_) => refuse(origin, Reason::MalformedDataUrl),
        SupplyError::Unavailable(why) => PrepareFailure::Unavailable(why),
    }
}

/// The payload of a `data:` URL that carries base64, split once and not otherwise read; any other form is malformed.
pub fn data_url_payload(url: &str) -> Option<&str> {
    let (meta, payload) = url.get(5..)?.split_once(',')?;
    meta.to_ascii_lowercase().ends_with(";base64").then_some(payload)
}

/// Prepare one occurrence for `plan`: its verdict and stored bytes from `supply`, the matrix's choice, the sealed image. Every
/// egress (a model request, a media helper's reference) prepares an image through this one function.
pub async fn prepare_intent(plan: &Plan, intent: &ImageIntent, supply: &dyn ImageSupply) -> Result<PreparedImage, PrepareFailure> {
    let mut origin = intent.origin.clone();
    let manifest: Manifest = match &intent.source {
        ImageSource::Link(url) => {
            return match plan.prepare_pointer(&origin, SourceForm::Link, Body::Link(url.clone()), false, None) {
                Ok(Ok(image)) => Ok(image),
                Ok(Err(())) => Err(refuse(&origin, Reason::MutableLink)),
                Err(refusal) => Err(PrepareFailure::Refused(refusal)),
            };
        }
        ImageSource::ProviderFileId { issuer, id } => {
            return match plan.prepare_pointer(&origin, SourceForm::FileId, Body::FileId { issuer: issuer.clone(), id: id.clone() }, false, None) {
                Ok(Ok(image)) => Ok(image),
                Ok(Err(())) => Err(refuse(&origin, Reason::UnverifiedFileId)),
                Err(refusal) => Err(PrepareFailure::Refused(refusal)),
            };
        }
        // Held in memory by the caller: nothing sends bytes it never imported.
        ImageSource::Inline(_) => return Err(refuse(&origin, Reason::SourceFormNotCarried)),
        ImageSource::Base64 { data, .. } => supply.inline(data).await.map_err(|e| from_supply(&origin, e))?,
        ImageSource::DataUrl(url) => {
            let Some(payload) = data_url_payload(url) else { return Err(refuse(&origin, Reason::MalformedDataUrl)) };
            supply.inline(payload).await.map_err(|e| from_supply(&origin, e))?
        }
        ImageSource::Stored(id) => supply.stored(&id.0).await.map_err(|e| from_supply(&origin, e))?,
    };
    if origin.display_name.is_empty() {
        origin.display_name = manifest.name.clone();
    }
    let facts = match &manifest.outcome {
        Outcome::Refused { text } => return Err(refuse(&origin, Reason::ImportRefused(text.clone()))),
        Outcome::Accepted { .. } => manifest.facts().expect("an accepted manifest has facts"),
    };
    let choice = decide_local(&origin, &facts, plan.policy()).map_err(PrepareFailure::Refused)?;
    let (original, rendition) = match choice {
        Choice::Original => (supply.bytes(&manifest, Choice::Original).await.map_err(|e| from_supply(&origin, e))?, None),
        Choice::Rendition => (Arc::from(Vec::new()), Some(supply.bytes(&manifest, Choice::Rendition).await.map_err(|e| from_supply(&origin, e))?)),
    };
    plan.prepare_local(&origin, &facts, original, rendition).map_err(PrepareFailure::Refused)
}

/// The supply before the host installs one: it can judge nothing, so no stored or inline image is prepared.
pub struct NoSupply;

#[async_trait]
impl ImageSupply for NoSupply {
    async fn inline(&self, _: &str) -> Result<Manifest, SupplyError> {
        Err(SupplyError::Unavailable("the image store is not ready".to_owned()))
    }
    async fn stored(&self, _: &str) -> Result<Manifest, SupplyError> {
        Err(SupplyError::Unavailable("the image store is not ready".to_owned()))
    }
    async fn bytes(&self, _: &Manifest, _: Choice) -> Result<Arc<[u8]>, SupplyError> {
        Err(SupplyError::Unavailable("the image store is not ready".to_owned()))
    }
}

static SUPPLY: RwLock<Option<Arc<dyn ImageSupply>>> = RwLock::new(None);

/// Install the process's image supply (the host does once its attachment store exists; a test installs a double).
pub fn install(supply: Arc<dyn ImageSupply>) {
    *SUPPLY.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(supply);
}

/// The installed supply; `None` before the host installs one, when no image can be judged and every image is refused.
pub fn installed() -> Option<Arc<dyn ImageSupply>> {
    SUPPLY.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}
