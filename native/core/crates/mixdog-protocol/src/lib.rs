//! Core domain types shared by every Mixdog core crate and, through
//! `mixdog-app-protocol`, by every client: ids, transcript items, approval
//! decisions, the `Section` shape of pushed state, blob references and
//! config paths. Wire field names are camelCase.

pub mod approval;
pub mod blob;
pub mod config;
pub mod ids;
pub mod item;
pub mod json;
pub mod section;
pub mod text_class;
pub mod thread;
pub mod tool_modules;

pub use approval::*;
pub use blob::*;
pub use config::*;
pub use ids::*;
pub use item::*;
pub use json::*;
pub use section::*;
pub use thread::*;
pub use tool_modules::*;
