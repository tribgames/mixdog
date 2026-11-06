//! Media Studio: the asset/board/defaults store, background generation jobs and the `media/`
//! service.

#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]

pub mod jobs;
pub mod service;
pub mod store;

pub use jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, Reference, ResolvedMedia};
pub use service::MediaService;
pub use store::{MediaError, MediaStore};
