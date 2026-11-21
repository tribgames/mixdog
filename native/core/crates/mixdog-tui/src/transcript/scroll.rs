//! The transcript scroll engine.
//!
//! Positions are rows scrolled up from the tail (`0` is the live tail). Every timer is the caller's: the run loop calls [`engine::TranscriptScroll::glide_tick`] every
//! [`engine::GLIDE_INTERVAL_MS`] while a glide runs, and [`coalesce::ScrollCoalescer::tick`] when its deadline passes, and
//! passes the clock in as milliseconds. The selection side of a scroll (harvest before, rebuild after) belongs to the mouse
//! module and is reached through [`engine::ScrollHost`].

pub mod activity;
pub mod anchor;
pub mod coalesce;
pub mod engine;
pub mod lock;
pub mod tuning;
