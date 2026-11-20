//! Media Studio: the asset/board/defaults store, background generation jobs and the `media/`
//! service.

#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]

pub mod accounts;
pub mod catalog;
pub mod jobs;
pub mod lanes;
pub mod catalog_fetch;
pub mod catalog_http;
pub mod loader;
pub mod probe;
pub mod upstream;
pub mod download;
pub mod usage;
pub mod adapter_http;
pub mod references;
pub mod image_api;
pub mod xai;
pub mod codex_image;
pub mod provider_layer;
pub mod gemini_image;
pub mod antigravity_image;
pub mod gemini_video;
pub mod ledger;
pub mod generator;
#[cfg(test)]
mod generator_tests;
pub mod renditions;
pub mod section;
pub mod service;
pub mod store;
pub mod tool;
pub mod transfer_source;
pub mod variants;
pub mod public_fetch;

pub use transfer_source::MediaAssetSource;
pub use jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, Reference, ResolvedMedia};
pub use renditions::{Rendition, RenditionError, StillRenditions, managed_ffmpeg};
pub use service::MediaService;
pub use catalog_fetch::{Auth, CatalogHttp, FetchError, FileCatalogCache, HttpFailure, HttpReply, fetch_media_model_rows, media_catalog_timeout};
pub use catalog_http::RoutedCatalogHttp;
pub use probe::{AccountedProbe, AgentKeys, AgentSettings, FileAccountProbe, ProbeParts, ProviderAuth};
pub use loader::{CatalogCache, CatalogSource, ModelLoader, Target};
pub use ledger::{MediaUsageCall, MediaUsageLedger, QueuedLedger};
pub use generator::{GeneratorParts, StudioGenerator, TokioPacer, ledger_account_of};
pub use store::{MediaError, MediaStore};
pub use accounts::{AccountProbe, AccountScope, ScopedLaneSources, SelectedAccounts, StudioAccounts, media_lane_account_provider};
pub use tool::{MediaGraph, MediaToolService, PinnedAccounts, StudioGraph};
pub use public_fetch::RoutedPublicFetch;
