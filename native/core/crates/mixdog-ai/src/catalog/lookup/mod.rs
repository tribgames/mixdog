//! The model-metadata lookup of Node's `model-catalog.mjs`, ported layer by
//! layer: LiteLLM and models.dev overlays, the providers' live rosters,
//! verified corrections, offline seeds and the vendor-row guess. Pure over
//! resident tables; the sources fill the tables when the catalog refreshes.

mod projection;
mod rates;
mod registry;
mod resolve;
#[cfg(test)]
pub(super) mod fixtures;
#[cfg(test)]
mod tests;

pub use projection::project_litellm;
pub use rates::Obj;
pub use rates::RATE_KEYS;
pub use projection::project_models_dev;
pub use registry::ANTIGRAVITY_FALLBACK;
pub use registry::models_dev_provider_id;
pub use registry::seed_display_name;
pub use registry::seed_roster;
pub use resolve::Lookup;
pub use resolve::enrich_model;
