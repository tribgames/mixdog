//! Local provider: the serialized inference queue with idle unload, per-model context settings,
//! shared model installations and the `localProvider/` service.

#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]

pub mod assets;
pub mod catalog;
pub mod change;
pub mod context;
pub mod gguf;
pub mod hardware;
pub mod hugging_face;
pub mod installations;
pub mod installed_models;
pub mod model_state;
pub mod provider;
pub mod registered_models;
pub mod request_queue;
pub mod server_process;
pub mod service;
pub mod setup_actions;
#[cfg(test)]
mod extract_twin_tests;
#[cfg(test)]
mod process_twin_tests;
#[cfg(test)]
mod send_queue_replay_tests;
#[cfg(test)]
mod twin_tests;

pub use installations::Installations;
pub use provider::{LocalProvider, Parts, ProviderError};
pub use request_queue::{RequestQueue, Unload};
pub use service::{LocalProviderService, LocalProviderSettings};
pub use setup_actions::LocalModelSetupActions;
