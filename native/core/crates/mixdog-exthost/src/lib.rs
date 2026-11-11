//! The extension host (RL §11; D5, D-L2): a pool of Node worker processes for the office tool and
//! pdf.js, behind the [`ExtPool`](mixdog_core_api::domain::ext::ExtPool) contract.
//!
//! - Each worker serves one call at a time over a framed stdio pipe ([`frame`]); a worker's
//!   chunks flow under a per-call byte window the consumer re-grants as it takes them.
//! - The dispatcher keeps a FIFO per thread, serves threads round-robin, caps one thread's calls
//!   in flight at ⌈W/2⌉ and answers `Overloaded` beyond a global pending cap.
//! - A worker that holds state for a thread (office sessions live in the worker's memory) pins
//!   the thread to itself until it exits.
//! - HTML layout shares one headless browser owned by the core ([`RenderBrowserConfig`]).
//! - A cancelled call leaves its worker's slot occupied until the worker answers or exits; an
//!   operator ends a stuck worker with `stop_worker`. Process exit is the only crash signal.

mod browser;
mod containment;
mod document;
mod domain_browser;
mod domain_visualize;
mod host_forward;
mod image_codec;
mod exits;
mod document_text;
mod owner;
pub mod frame;
mod pool;
mod process;
mod schedule;
mod shared;
mod stream;
mod syntax;
mod visualize_panes;

pub use browser::RenderBrowser;
pub use browser::RenderBrowserConfig;
pub use document::DocumentService;
pub use document::RelayFiles;
pub use visualize_panes::VisualizePanes;
pub use domain_browser::BrowserService;
pub use domain_visualize::VisualizeService;
pub use domain_visualize::required_tab_command;
pub use exits::ExtHostError;
pub use document_text::ExtDocumentText;
pub use image_codec::ExtImageCodec;
pub use image_codec::ReadResize;
pub use image_codec::ReadResizeError;
pub use image_codec::RenditionVariant;
pub use image_codec::StillRendition;
pub use pool::CANCEL_GRACE;
pub use pool::DEFAULT_PENDING_CAP;
pub use pool::ExtHostConfig;
pub use pool::ExtHostPool;
pub use pool::worker_count;
pub use syntax::SyntaxCheck;
pub use syntax::SyntaxKind;
pub use syntax::check_syntax;
pub use frame::CALL_WINDOW_BYTES;
