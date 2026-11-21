//! Slash commands, the prompt palettes and the prompt submit routing, as functions over [`host::SlashHost`].

pub mod commands;
pub mod dispatch;
pub mod host;
pub mod notices;
pub mod palette;
pub mod parsers;
pub mod store_service_call;
pub mod submit;
pub mod text_entry;
pub mod ui_open;
pub mod workflow_cycle;

pub use dispatch::run_slash_command;
pub use dispatch::session::{BTW_USAGE_HINT, STOP_CANCEL, STOP_CONFIRM, stop_prompt_cancel, stop_prompt_select};
pub use submit::on_submit;
