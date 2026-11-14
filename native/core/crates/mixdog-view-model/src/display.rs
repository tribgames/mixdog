//! Display helpers: the model, context, time, usage and statusline labels every surface shares, and the tool-card line.
//! Ported from `runtime/shared/{time-format, model-display, model-alias, provider-display-name, context-measurement,
//! context-inspection, quiet-progress, skill-mentions, clean}.mjs`, `runtime/shared/statusline/*`,
//! `ui/{session-stats, tool-card}.mjs` and `session-runtime/services/usage-dashboard-model.mjs`.

mod coerce;

pub mod clean;
pub mod context_inspection;
pub mod context_measurement;
pub mod model_alias;
pub mod model_display;
pub mod provider_display_name;
pub mod quiet_progress;
pub mod session_stats;
pub mod skill_mentions;
pub mod statusline_format;
pub mod statusline_segments;
pub mod time_format;
pub mod tool_card;
pub mod usage_dashboard;
