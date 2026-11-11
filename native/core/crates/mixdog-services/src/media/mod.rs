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
pub mod catalog_fetch;
pub mod catalog_http;
pub mod loader;
pub mod probe;
#[cfg(test)]
mod catalog_fetch_twin_tests;
#[cfg(test)]
mod loader_twin_tests;
#[cfg(test)]
mod probe_twin_tests;
pub mod upstream;
#[cfg(test)]
mod upstream_twin_tests;
pub mod download;
#[cfg(test)]
mod download_twin_tests;
pub mod usage;
#[cfg(test)]
mod usage_twin_tests;
pub mod adapter_http;
pub mod image_api;
#[cfg(test)]
mod image_api_twin_tests;
pub mod xai;
#[cfg(test)]
mod xai_twin_tests;
pub mod codex_image;
#[cfg(test)]
mod codex_image_twin_tests;
pub mod provider_layer;
#[cfg(test)]
mod provider_layer_twin_tests;
pub mod gemini_image;
#[cfg(test)]
mod gemini_image_twin_tests;
pub mod antigravity_image;
#[cfg(test)]
mod antigravity_image_twin_tests;
pub mod gemini_video;
#[cfg(test)]
mod gemini_video_twin_tests;
pub mod ledger;
#[cfg(test)]
mod ledger_twin_tests;
pub mod generator;
#[cfg(test)]
mod generator_tests;
pub mod renditions;
pub mod section;
pub mod service;
pub mod store;
pub mod tool;
#[cfg(test)]
mod tool_twin_tests;
#[cfg(test)]
mod feature_tools_node_cases;
pub mod transfer_source;
pub mod variants;
pub mod public_fetch;

pub use transfer_source::MediaAssetSource;
pub use jobs::{GeneratedMedia, GenerationRequest, MediaFailure, MediaGenerator, MediaJobs, Reference, ResolvedMedia};
pub use renditions::{Rendition, RenditionError, StillRenditions};
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
