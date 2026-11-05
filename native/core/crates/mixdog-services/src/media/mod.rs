//! Media Studio: the asset/board/defaults store, background generation jobs and the `media/`
//! service.

pub mod jobs;
pub mod service;
pub mod store;

pub use jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, Reference, ResolvedMedia};
pub use service::MediaService;
pub use store::{MediaError, MediaStore};
