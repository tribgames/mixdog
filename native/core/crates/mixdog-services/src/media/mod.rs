//! Media Studio: the asset/board/defaults store, background generation jobs and the `media/`
//! service.

#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]

pub mod accounts;
pub mod catalog;
pub mod jobs;
pub mod lanes;
#[cfg(test)]
mod accounts_twin_tests;
#[cfg(test)]
mod lanes_twin_tests;
pub mod renditions;
pub mod service;
pub mod store;
pub mod tool;
#[cfg(test)]
mod tool_twin_tests;
pub mod transfer_source;
pub mod variants;

pub use transfer_source::MediaAssetSource;
pub use jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, Reference, ResolvedMedia};
pub use renditions::{Rendition, RenditionError, StillRenditions};
pub use service::MediaService;
pub use store::{MediaError, MediaStore};
pub use accounts::{AccountProbe, AccountScope, ScopedLaneSources, SelectedAccounts, StudioAccounts, media_lane_account_provider};
pub use tool::{MediaGraph, MediaToolService, PinnedAccounts, StudioGraph};
