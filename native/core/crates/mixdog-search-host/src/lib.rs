//! The search helper process: the wire between the core and the helper, the core's supervisor of it, and the helper's
//! serve loop.
//!
//! The core runs no walk or text search of its own files, as Node's core ran none: one helper per core
//! (`current_exe() search-worker`, started through `mixdog_spawn::owned`, its frames those of the code graph helper,
//! `mixdog_graph_host::frame`) runs every one on `mixdog_workspace::localfs`'s engine, its scheduler, heap limit, deadlines
//! and cancellation included, and streams each one's results back as they are found, so what a broad search holds is the
//! helper's, never the core's. It exits after an idle deadline, so its memory returns to the operating system.
//!
//! It is not the code graph helper: that one answers one query at a time and is killed when its query is cancelled,
//! while searches run many at once, each streaming, each cancelled alone, and a search's crash must not take the graphs.
//!
//! - [`wire`]: the messages.
//! - [`worker`]: the helper's serve loop.
//! - [`SearchHost`]: the core's supervisor of the helper, the `Searches` of its file service.

mod link;
mod stream;
mod supervisor;
pub mod wire;
pub mod worker;

pub use mixdog_spawn::owned::OwnedCommand;
pub use supervisor::*;
