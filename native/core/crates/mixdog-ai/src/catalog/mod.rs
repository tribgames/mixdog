//! The model catalog (PW §9, #327).
//!
//! Reads are one `ArcSwap` load of an immutable snapshot; refresh never runs on
//! the read path. The set of sources is built from the *full* provider
//! configuration, secrets included ([`FullProviderConfig`]): a redacted copy
//! is a different type that cannot be turned into sources, so a provider that
//! needs its key to list models can never be built without it.

mod facts;
mod lookup;
mod modelsdev;
mod modelsdev_source;
mod pricing;
mod readiness;
mod record;
mod rosters;
mod service;
mod sources;
mod store;
mod traits;

pub use modelsdev::ModelsDev;
pub use modelsdev_source::LITELLM_CACHE_FILE;
pub use modelsdev_source::MODELS_DEV_CACHE_FILE;
pub use modelsdev_source::ModelsDevSource;
pub use modelsdev_source::REFRESH_AFTER;
pub use pricing::ColdCatalog;
pub use pricing::Media;
pub use pricing::PricedUsage;
pub use pricing::PricingCatalog;
pub use pricing::UsageArgs;
pub use readiness::ProviderReadiness;
pub use readiness::Ready;
pub use readiness::is_known_provider;
pub use record::BudgetSpec;
pub use rosters::CachedWindows;
pub use rosters::RosterSnapshot;
pub use record::Thinking;
pub use traits::CatalogTraits;
pub use traits::ModelTraits;
pub use record::Capability;
pub use record::MetadataSource;
pub use record::ModelRecord;
pub use record::Rates;
pub use service::CatalogService;
pub use sources::FullProviderConfig;
pub use sources::ModelSource;
pub use sources::ProviderEntry;
pub use sources::SourceFactory;
pub use sources::build_sources;
pub use store::CatalogSnapshot;
pub use store::ProviderCatalog;
pub use store::RefreshOutcome;