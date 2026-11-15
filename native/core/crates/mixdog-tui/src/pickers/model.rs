//! The model, effort, Fast, web search, workflow, output style, agents and theme pickers, the model options they list from
//! and the catalog cache (`src/tui/app/model-options.mjs`, `model-picker.mjs` and `model-picker/*`, `route-pickers.mjs` and
//! `route-pickers/*`, `theme-effort-pickers.mjs`, `use-model-catalog-cache.mjs`).
//!
//! - [`options`]: labels, ordering and rows of models, providers and routes (pure);
//! - [`catalog`]: the UI caches, the quick-then-full load, the freshness policy, the warm-up, `clearModelCaches`;
//! - [`selection`], [`footer`]: the per-row effort, Fast, parameters and context selections and the footer under a row;
//! - [`picker`]: `openModelPicker`, the provider list and one provider's model list;
//! - [`web_search`], [`agents`], [`workflow`], [`output_style`], [`theme`]: the other pickers of the cluster;
//! - [`route_write`]: the serialized optimistic route write the store applies for every route change.

pub mod agents;
pub mod catalog;
pub mod footer;
pub mod options;
pub mod output_style;
pub mod picker;
pub mod route_write;
pub mod selection;
pub mod theme;
pub mod web_search;
pub mod workflow;

pub use picker::{ModelPickerOptions, open_model_picker};
