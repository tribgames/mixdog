//! Slash commands, the prompt palettes and the prompt submit routing (`src/tui/app/slash-commands.mjs`, `slash-palette.mjs`,
//! `use-slash-palette.mjs`, `skill-mention-palette.mjs`, `input-parsers.mjs`, `text-entry-policy.mjs`,
//! `store-service-call.mjs`, `workflow-cycle.mjs`, `use-workflow-tab-cycle.mjs`, `use-ui-open-request.mjs`,
//! `prompt-submit.mjs` and `slash-dispatch.mjs`, with their subdirectories), as functions over [`host::SlashHost`].
//!
//! - [`commands`]: the registry of the 31 commands, prefix matching, palette order, argument hints;
//! - [`palette`]: which palette the draft opens (slash commands, or `$skill` completion);
//! - [`parsers`]: argument parsers (MCP servers, skills, memory commands and rows);
//! - [`dispatch`]: `runSlashCommand` and the route, session and panel command tables;
//! - [`submit`]: the prompt submit routing (provider and settings prompts, slash commands, chat);
//! - [`workflow_cycle`], [`ui_open`], [`text_entry`], [`store_service_call`]: the small prompt-side policies;
//! - [`host`]: what the application provides (store calls, picker openers by name, surface claims, prompt state).

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
