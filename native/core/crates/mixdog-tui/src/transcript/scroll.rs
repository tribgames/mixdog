//! The transcript scroll engine (`src/tui/app/transcript-anchor-lock.mjs`, `transcript-anchor-sync.mjs`,
//! `transcript-scroll-anchor.mjs`, `use-transcript-scroll.mjs`, `use-transcript-scroll-state.mjs`, `use-transcript-follow.mjs`,
//! `use-transcript-activity.mjs`, `use-transcript-swap-reset.mjs` and the `MIXDOG_TUI_SCROLL_*` parsing of
//! `transcript-window.mjs`).
//!
//! Positions are rows scrolled up from the tail (`0` is the live tail). The Node hooks ran on React refs, timers and
//! effects; here every timer is the caller's: the run loop calls [`engine::TranscriptScroll::glide_tick`] every
//! [`engine::GLIDE_INTERVAL_MS`] while a glide runs, and [`coalesce::ScrollCoalescer::tick`] when its deadline passes, and
//! passes the clock in as milliseconds. The selection side of a scroll (harvest before, rebuild after) belongs to the mouse
//! module and is reached through [`engine::ScrollHost`].
//!
//! * [`tuning`] - the `MIXDOG_TUI_SCROLL_*` knobs and the wheel acceleration step;
//! * [`anchor`] - the reading anchor arithmetic and the bottom snap band;
//! * [`engine`] - the scroll state, follow, glide and `scrollTranscriptRows`;
//! * [`lock`] - the render-time anchor lock and the post-commit reconciliation;
//! * [`coalesce`] - the leading-edge wheel and edge-drag coalescer;
//! * [`activity`] - the agent revision key, the active-tool signature and the statusline stats projection.

pub mod activity;
pub mod anchor;
pub mod coalesce;
pub mod engine;
pub mod lock;
pub mod tuning;
