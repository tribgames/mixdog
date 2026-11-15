//! The footer: the statusline text under the prompt (`src/ui/statusline.mjs`, `statusline-agents.mjs`, and the hook of
//! `src/tui/components/status-line/`). The band that paints it is `mixdog_tui_widgets::statusline`; the first row (model,
//! context share, provider quota) and the second (agents, shells, web search, memory cycle) are built here.
//!
//! * [`render`] is `renderStatusline`: it answers from caches a background job keeps and reads nothing on its own call
//!   stack. The core also serves `statusline/read`, from the same functions of `mixdog-core-session`; the render stays
//!   in-process because the first full render of a boot is timed by these caches (a request per tick would not match it),
//!   and the rules are not repeated: [`files`] only reads the files they decide on.
//! * [`text`] is the hook: the instant local line, the debounced full render, the refresh cadence and the boot schedule
//!   ([`schedule`]).
//! * [`host`] and [`io`] are what the process supplies: the catalog, the OAuth usage cache and the live agent runtimes, and
//!   the file reads.
//!
//! Node's lazy import of `ui/statusline.mjs` (its prewarm, and the retry with a doubling backoff after a failed import) has
//! nothing to do in a program that has no module to load and is not carried; the boot delay of the first full render is.

pub mod files;
pub mod host;
pub mod io;
pub mod process;
pub mod render;
pub mod schedule;
pub mod text;

pub use host::StatusHost;
pub use host::StatusPaths;
pub use io::DiskIo;
pub use io::StatusIo;
pub use render::RenderArgs;
pub use render::RendererDeps;
pub use render::StatuslineRenderer;
pub use text::FooterInputs;
pub use text::StatuslineText;
