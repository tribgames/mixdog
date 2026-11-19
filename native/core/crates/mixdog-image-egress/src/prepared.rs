//! Sealed prepared images. Fields are private, there is no `Deserialize`, no `Default` and no constructor from a string or raw
//! bytes outside [`Plan`]: a prepared image exists only after the matrix accepted it for this plan's route.

use std::collections::HashMap;
use std::sync::Arc;

use crate::decide::{Choice, ImageFacts, Pointer, decide_local, decide_pointer};
use crate::origin::{Origin, SourceForm};
use crate::policy::{InputImagePolicy, RouteKey};
use crate::refusal::{NotSent, Reason, Refusal};

/// The pinned route and its policy. Preparation and transport both take their endpoint and credentials from the one plan;
/// failover, account rotation or a model change builds a new plan.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Plan {
    route: RouteKey,
    policy: InputImagePolicy,
}

/// How a prepared image goes on the wire.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Body {
    /// Validated bytes of `mime`, sent inline (base64 or data URL or binary, as the wire spells it).
    Inline { mime: &'static str, bytes: Arc<[u8]> },
    /// A link this wire carries and the evidence covers.
    Link(String),
    /// A provider file id of the matching issuer.
    FileId { issuer: String, id: String },
}

/// One accepted image occurrence, bound to the plan that accepted it.
///
/// A prepared image cannot be built outside this module, from a literal, a string, raw bytes or `Default`:
///
/// ```compile_fail,E0451
/// use mixdog_image_egress::{Body, Origin, PreparedImage, RouteKey};
/// fn forge(origin: Origin, route: RouteKey) -> PreparedImage {
///     PreparedImage { origin, body: Body::Link("https://example.com/a.png".into()), route }
/// }
/// ```
///
/// ```compile_fail,E0277
/// fn needs_default<T: Default>() {}
/// needs_default::<mixdog_image_egress::PreparedImage>();
/// ```
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PreparedImage {
    origin: Origin,
    body: Body,
    route: RouteKey,
}

impl PreparedImage {
    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    pub fn body(&self) -> &Body {
        &self.body
    }
}

impl Plan {
    pub fn new(route: RouteKey, policy: InputImagePolicy) -> Self {
        Self { route, policy }
    }

    pub fn route(&self) -> &RouteKey {
        &self.route
    }

    pub fn policy(&self) -> &InputImagePolicy {
        &self.policy
    }

    /// Prepare an image whose validated bytes the store holds. `original` and `rendition` must be the stored bytes the facts
    /// describe; a length that disagrees with the facts is a corrupt store, refused.
    pub fn prepare_local(
        &self,
        origin: &Origin,
        facts: &ImageFacts,
        original: Arc<[u8]>,
        rendition: Option<Arc<[u8]>>,
    ) -> Result<PreparedImage, Refusal> {
        let choice = decide_local(origin, facts, &self.policy)?;
        let (mime, bytes, expect) = match (choice, rendition) {
            (Choice::Original, _) => (facts.kind.mime(), original, facts.encoded_len),
            (Choice::Rendition, Some(rendition)) => {
                let made = facts.rendition.map_or((crate::policy::ImageKind::Png, 0), |r| (r.kind, r.encoded_len));
                (made.0.mime(), rendition, made.1)
            }
            (Choice::Rendition, None) => return Err(Refusal::new(origin.clone(), Reason::Missing)),
        };
        if bytes.len() as u64 != expect {
            return Err(Refusal::new(origin.clone(), Reason::Corrupt));
        }
        Ok(PreparedImage { origin: origin.clone(), body: Body::Inline { mime, bytes }, route: self.route.clone() })
    }

    /// Prepare a link or provider file id. `Ok(Err(local))` means the caller must resolve the owned original and use
    /// [`Plan::prepare_local`]; no network resolution happens here.
    pub fn prepare_pointer(
        &self,
        origin: &Origin,
        form: SourceForm,
        value: Body,
        trusted: bool,
        local: Option<&ImageFacts>,
    ) -> Result<Result<PreparedImage, ()>, Refusal> {
        match decide_pointer(origin, form, &self.policy, trusted, local)? {
            Pointer::Native => Ok(Ok(PreparedImage { origin: origin.clone(), body: value, route: self.route.clone() })),
            Pointer::UseLocal => Ok(Err(())),
        }
    }

    /// Start a batch that must account for every origin in `expected`, in this order.
    pub fn batch(&self, expected: Vec<Origin>) -> BatchBuilder {
        BatchBuilder { plan: self.clone(), expected, got: HashMap::new(), refusals: Vec::new() }
    }
}

/// Collects one result per intended occurrence and seals them, or returns every blocker.
pub struct BatchBuilder {
    plan: Plan,
    expected: Vec<Origin>,
    got: HashMap<Origin, PreparedImage>,
    refusals: Vec<Refusal>,
}

impl BatchBuilder {
    pub fn accept(&mut self, image: PreparedImage) {
        if image.route != self.plan.route || !self.expected.contains(&image.origin) || self.got.contains_key(&image.origin) {
            // An image from another plan, of an unexpected origin, or a second answer for one occurrence is a caller bug; it
            // blocks the batch instead of being dropped.
            self.refusals.push(Refusal::new(image.origin.clone(), Reason::Corrupt));
            return;
        }
        self.got.insert(image.origin.clone(), image);
    }

    pub fn refuse(&mut self, refusal: Refusal) {
        self.refusals.push(refusal);
    }

    /// Seal: every expected origin accounted for exactly once, and the count within the plan's limit.
    pub fn seal(mut self) -> Result<PreparedBatch, NotSent> {
        for origin in &self.expected {
            if !self.got.contains_key(origin) && !self.refusals.iter().any(|r| r.origin.as_ref() == origin) {
                self.refusals.push(Refusal::new(origin.clone(), Reason::Missing));
            }
        }
        if let Some(limit) = self.plan.policy.limits.max_images
            && self.expected.len() as u64 > u64::from(limit)
        {
            let over = self.expected.iter().skip(limit as usize).cloned().collect::<Vec<_>>();
            for origin in over {
                if self.refusals.iter().any(|r| *r.origin == origin) {
                    continue;
                }
                self.refusals.push(Refusal::new(origin, Reason::OverCount { limit }));
            }
        }
        if !self.refusals.is_empty() {
            return Err(NotSent::new(self.refusals));
        }
        let mut images = Vec::with_capacity(self.expected.len());
        for origin in &self.expected {
            if let Some(image) = self.got.remove(origin) {
                images.push(image);
            }
        }
        Ok(PreparedBatch { route: self.plan.route, images })
    }
}

/// All images of one request, prepared against one route, in request order. Only [`BatchBuilder::seal`] makes one:
///
/// ```compile_fail,E0451
/// use mixdog_image_egress::{PreparedBatch, RouteKey};
/// fn forge(route: RouteKey) -> PreparedBatch {
///     PreparedBatch { route, images: Vec::new() }
/// }
/// ```
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PreparedBatch {
    route: RouteKey,
    images: Vec<PreparedImage>,
}

impl PreparedBatch {
    pub fn route(&self) -> &RouteKey {
        &self.route
    }

    pub fn images(&self) -> &[PreparedImage] {
        &self.images
    }

    /// The prepared image of `origin`, if the batch holds it.
    pub fn get(&self, origin: &Origin) -> Option<&PreparedImage> {
        self.images.iter().find(|image| &image.origin == origin)
    }

    /// Whether the batch was sealed against `plan`; transport refuses a batch that was not.
    pub fn matches(&self, plan: &Plan) -> bool {
        self.route == plan.route
    }
}
