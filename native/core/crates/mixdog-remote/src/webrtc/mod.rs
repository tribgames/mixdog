//! WebRTC for remote access, fully in Rust (SPEC §4.7): the MXT carrier data channels, the
//! live-view video with its input channel, the VP8 encoder and the frame sources.
//!
//! Connections run as tasks on RT-W; video encoding runs on the `webrtc-media` thread executor
//! (one thread per active track), so a slow peer or encoder never delays the core's control or
//! session work. The video codec is VP8 only.

pub mod capture;
pub mod carrier;
pub mod config;
pub mod convert;
pub mod encoder;
pub mod input_order;
pub mod liveview;
mod peer;
pub mod sources;
pub mod track;

#[cfg(test)]
mod interop;
#[cfg(test)]
mod tests;
