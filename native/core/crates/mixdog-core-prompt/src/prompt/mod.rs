//! The session system prompt.
//!
//! Where it lives: the session stores no messages for it. Its four system messages are
//! four string-valued **header fields** ([`blocks`]), one copy each:
//!
//! | header field     | system message                          | request role / `cacheTier` |
//! |------------------|-----------------------------------------|----------------------------|
//! | `promptBase`     | BP1 base rules (shared tools + route)   | system, none               |
//! | `promptStable`   | BP2 meta + skills + deferred manifest   | system, none               |
//! | `bp3CoreContext` | BP3 core (workflow, role, memory)       | system, `tier3`            |
//! | `promptEnv`      | `# Session` block + environment tail    | system, `env`              |
//!
//! A field is present exactly when its message exists. [`blocks::request_system_messages`]
//! is the one function that turns a header into a request's system messages; a route change or
//! re-root is one `thread/header/patch` carrying the changed fields.
//!
//! * [`blocks`]: the layout, the request function, the adapter to the `messages` array
//!   shape that the `run_host` rewriters (`deferred_manifest`, `rules`) work on.
//! * [`migrate`]: 1.4.5 `messages` to the fields.
//! * [`compose`]: the four blocks from their slices.
//! * [`session`]: the session system composition and the creation / reset steps around it.
//! * [`sources`]: what the composition reads from outside the session (agent files,
//!   startup observations, instruction files).
//! * [`source_files`]: the file reads behind them, taken on the I/O lane as an owned snapshot.

pub mod blocks;
pub mod compose;
pub mod migrate;
pub mod notice;
pub mod probes;
pub mod real_sources;
pub mod settings;
pub mod source_files;
pub mod sources;

#[cfg(test)]
mod real_sources_tests;
