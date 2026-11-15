//! The global key handler and the prompt handlers (`src/tui/app/use-global-key-input.mjs`, `use-prompt-handlers.mjs` and what
//! they use: `use-prompt-state.mjs`, `use-prompt-draft-flow.mjs`, `use-prompt-queue-history.mjs`, `use-pasted-buffers.mjs`,
//! `use-prompt-hint.mjs` and their subdirectories, `src/tui/hooks/useSharedTick.mjs`). They are the callbacks the prompt editor
//! calls ([`crate::editor::PromptCallbacks`]) and the key handler that runs before it.
//!
//! The Node code is React hooks over refs and setters. Here the state the refs and setters held is [`state::PromptState`]
//! (with [`hint::PromptHint`], [`history_nav::HistoryNav`], [`interrupt::InterruptState`], [`pasted_buffers::PastedBuffers`]
//! and the exit flow [`exit::ExitFlow`]) and what the hooks reached outside it is the methods of [`host::PromptHost`] and
//! [`host::GlobalKeyHost`]. Time is an input: nothing here reads a clock or starts a timer; the owner passes the millisecond
//! and runs the timer the state reports ([`hint::PromptHint::dismiss_at`], [`exit::ExitFlow::step`],
//! [`shared_tick::SharedTick::next_delay_ms`]). A store call that Node answers with a promise is a [`host::Reply`]: when it is
//! `Pending` the owner calls the matching `finish_*` function with the answer, from the task that owns it.
//!
//! - [`global_keys`]: tool-approval keys, copy-first Ctrl+C, Ctrl+O, grid-selection moves, panel Escapes, paging;
//! - [`escape`], [`history_nav`], [`paste`], [`interrupt`]: the four handlers of the prompt input;
//! - [`draft_flow`]: keystroke-time draft sync, the text-entry cancel paths, the slash palette accept/complete/cancel;
//! - [`queue_restore`]: queued messages back into the draft;
//! - [`pasted_buffers`], [`hint`], [`state`], [`exit`], [`shared_tick`]: the state and the clocks they run on.

pub mod draft_flow;
pub mod escape;
pub mod exit;
pub mod global_keys;
pub mod hint;
pub mod history_nav;
pub mod host;
pub mod interrupt;
pub mod paste;
pub mod pasted_buffers;
pub mod queue_restore;
pub mod shared_tick;
pub mod state;

pub use host::{GlobalKeyHost, PromptHost, Reply};
pub use state::PromptState;
