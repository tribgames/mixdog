//! What selects and feeds provider adapters: the API-key store, the attempt
//! sink, the cache-warm ledger and the provider registry.

pub mod accounted;
pub mod accounting;
pub mod attempt;
pub mod builder;
pub mod effective;
pub mod keys;
pub mod multiwire;
pub mod providers;
pub mod versioned;
pub mod vertex_metadata;
pub mod warm;

pub use providers::ProviderRegistry;
