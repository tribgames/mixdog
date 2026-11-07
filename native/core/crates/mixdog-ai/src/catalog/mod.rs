//! The model catalog (PW §9, #327).
//!
//! Reads are one `ArcSwap` load of an immutable snapshot; refresh never runs on
//! the read path. The set of sources is built from the *full* provider
//! configuration, secrets included ([`FullProviderConfig`]): a redacted copy
//! is a different type that cannot be turned into sources, so a provider that
//! needs its key to list models can never be built without it.

mod facts;
mod failures;
mod listing;
mod lookup;
mod modelsdev;
mod modelsdev_source;
mod pricing;
mod readiness;
mod record;
mod rosters;
mod sanitize;
mod service;
mod sources;
mod store;
mod traits;

pub use failures::CatalogFailureStore;
pub use failures::Failure as CatalogFailure;
pub use listing::ListingLookup;
pub use listing::enrich_listed;
pub use listing::keep_native;
pub use lookup::seed_display_name;
pub use lookup::seed_roster;
pub use modelsdev::ModelsDev;
pub use modelsdev_source::LITELLM_CACHE_FILE;
pub use modelsdev_source::MODELS_DEV_CACHE_FILE;
pub use modelsdev_source::ModelsDevSource;
pub use modelsdev_source::REFRESH_AFTER;
pub use pricing::CatalogPricing;
pub use pricing::ColdCatalog;
pub use pricing::Media;
pub use pricing::PricedUsage;
pub use pricing::PricingCatalog;
pub use pricing::UsageArgs;
pub use readiness::CacheDrop;
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
pub use record::CustomReasoning;
pub use record::ParameterOption;
pub use record::ParameterValue;
pub use record::PickerFields;
pub use record::ReasoningOption;
pub use record::ServiceTier;
pub use record::MetadataSource;
pub use record::ModelRecord;
pub use record::Rates;
pub use sanitize::Context as SanitizeContext;
pub use sanitize::sanitize_model_list;
pub use sanitize::stale_months;
pub use service::CatalogService;
pub use sources::FullProviderConfig;
pub use sources::ModelSource;
pub use sources::ProviderEntry;
pub use sources::SourceFactory;
pub use sources::build_sources;
pub use store::Ask;
pub use store::CatalogSnapshot;
pub use store::LIST_DEADLINE;
pub use store::ProviderCatalog;
pub use store::ProviderStatus;
pub use store::RETRY_AFTER_MS;
pub use store::RefreshOutcome;#[cfg(test)]
mod failures_tests;
