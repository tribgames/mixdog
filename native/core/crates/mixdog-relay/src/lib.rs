//! The relay server: the Rust port of `apps/relay`. It pairs a phone or browser with a desktop leg and forwards their
//! frames, serves the renderer and the install pages, and sends feedback mail and push notifications.
//!
//! The areas below are filled in by the tasks of the relay track; `config`, `ids`, `close_codes`, `rate_limit`, `js` and
//! `logline` are the shared ground every area builds on. JSON and JavaScript string rules live in [`js`] only.

pub mod close_codes;
pub mod config;
pub mod diagnostics;
pub mod feedback;
pub mod hook;
pub mod http1;
pub mod ice;
pub mod ids;
pub mod js;
pub mod legs;
pub mod logline;
pub mod mail;
pub mod media;
pub mod native_push;
pub mod net;
pub mod pages;
pub mod pairing;
pub mod rate_limit;
pub mod server;
pub mod store;
pub mod tools;
pub mod web;
pub mod web_push;
pub mod ws;
