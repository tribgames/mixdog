//! The view model of the terminal UI: the projections that turn tool calls, results, errors and session state into the rows and
//! lines a surface draws, ported from the Node `shared/` and `tui/` modules. Values stay `serde_json::Value`s, so a row has the
//! shape Node builds.

pub mod card_model;
pub mod display;
pub mod errors;
pub mod results;
pub mod tool_contract;
pub mod tool_primitives;
pub mod tool_status;
pub mod tool_surface;
pub mod tool_work_units;
