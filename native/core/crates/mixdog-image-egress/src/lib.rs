//! Leaf contract for every image that leaves the app for a model or media provider: raw intents, the destination policy,
//! the matrix decision, the refusal protocol with its local recovery actions, and the sealed prepared batch.

pub mod admission;
pub mod decide;
pub mod manifest;
pub mod origin;
pub mod policy;
pub mod prepared;
pub mod refusal;
pub mod route;

pub use decide::{Choice, ImageFacts, Pointer, RenditionFacts, decide_local, decide_pointer};
pub use manifest::{Manifest, Outcome, Rendition};
pub use origin::{ImageIntent, ImageSource, Origin, Role, SourceForm, StoredImageId};
pub use policy::{Column, ImageKind, InputImagePolicy, Limits, RouteKey};
pub use prepared::{BatchBuilder, Body, Plan, PreparedBatch, PreparedImage};
pub use refusal::{NotSent, Reason, RecoveryAction, Refusal};

#[cfg(test)]
mod tests;
