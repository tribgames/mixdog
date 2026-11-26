//! Media Studio: the asset/board/defaults store, background generation jobs and the `media/`
//! service.

#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]

pub mod accounts;
pub mod adapter_http;
pub mod antigravity_image;
#[cfg(test)]
mod antigravity_image_tests;
pub mod catalog;
pub mod catalog_fetch;
pub mod catalog_http;
pub mod codex_image;
pub mod download;
pub mod gemini_image;
pub mod gemini_video;
pub mod generator;
#[cfg(test)]
mod generator_tests;
pub mod image_api;
pub mod jobs;
pub mod lanes;
pub mod ledger;
pub mod loader;
pub mod probe;
pub mod provider_layer;
pub mod public_fetch;
pub mod references;
pub mod renditions;
pub mod section;
pub mod service;
pub mod store;
pub mod tool;
pub mod transfer_source;
pub mod upstream;
pub mod usage;
pub mod variants;
pub mod xai;

pub use accounts::{AccountProbe, AccountScope, ScopedLaneSources, SelectedAccounts, StudioAccounts, media_lane_account_provider};
pub use catalog_fetch::{Auth, CatalogHttp, FetchError, FileCatalogCache, HttpFailure, HttpReply, fetch_media_model_rows, media_catalog_timeout};
pub use catalog_http::RoutedCatalogHttp;
pub use generator::{GeneratorParts, StudioGenerator, TokioPacer, ledger_account_of};
pub use jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, Reference, ResolvedMedia};
pub use ledger::{MediaUsageCall, MediaUsageLedger, QueuedLedger};
pub use loader::{CatalogCache, CatalogSource, ModelLoader, Target};
pub use probe::{AccountedProbe, AgentKeys, AgentSettings, FileAccountProbe, ProbeParts, ProviderAuth};
pub use public_fetch::RoutedPublicFetch;
pub use renditions::{Rendition, RenditionError, StillRenditions, managed_ffmpeg};
pub use service::MediaService;
pub use store::{MediaError, MediaStore};
pub use tool::{MediaGraph, MediaToolService, PinnedAccounts, StudioGraph};
pub use transfer_source::MediaAssetSource;
