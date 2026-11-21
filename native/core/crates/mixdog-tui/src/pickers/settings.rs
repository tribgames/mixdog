//! The settings pickers: Settings (rows from one snapshot, toggles, listed cyclers, navigation), Update, Auto-clear, Profile and Developer.
//!
//! Each picker is a [`PickerController`]: the panel it painted is data ([`panel::Panel`]) and the keys on it are its methods,
//! which find the row by its `value`. A write's ack and the repaint after it run as plain steps after the store call, each guarded by
//! the claim it was bound to ([`host::Own::defer`]), so a write acking after Esc never re-opens the dismissed panel. [`open`] is what the
//! application's opener for [`Opener::Settings`], [`Opener::AutoClear`], [`Opener::Profile`], [`Opener::Update`] and
//! [`Opener::Developer`] calls; a picker that returns to Settings (`returnTo`) re-opens it through the host's opener the same way.
//!
//! The options of the pickers it opens (`returnTo: "settings"`, `returnLabel`, `returnOnNestedCancel`, `onAfterSelect: "settings"`,
//! `handoffPanel`, `continueLabel`, `continueDescription`, `onCancel: "settings"`) name the picker to come back to.

pub mod auto_clear;
pub mod developer;
pub mod host;
pub mod navigation;
pub mod panel;
pub mod picker;
pub mod profile;
pub mod rows;
pub mod toggles;
pub mod update;

use mixdog_tui_style::time_format::{DurationOptions, format_duration};
use serde_json::{Value, json};

use self::host::PickerHost;
use self::panel::Panel;
use crate::slash::host::{Opener, Tone};
use crate::slash::notices::truthy;

/// The key handlers of the picker on screen.
pub trait PickerController {
    /// The panel it last painted.
    fn panel(&self) -> &Panel;
    /// `onLeft(item)` on the row `value`.
    fn left(&mut self, _host: &mut dyn PickerHost, _value: &str) {}
    /// `onRight(item)`.
    fn right(&mut self, _host: &mut dyn PickerHost, _value: &str) {}
    /// `onSelect(value, item)`.
    fn select(&mut self, _host: &mut dyn PickerHost, _value: &str) {}
    /// `confirmBar.onConfirm(button)`.
    fn confirm(&mut self, _host: &mut dyn PickerHost, _button: &str) {}
    /// `onCancel()`.
    fn cancel(&mut self, host: &mut dyn PickerHost);
}

/// What an opener call came to.
pub enum Opening {
    /// The opener is not one of the settings pickers.
    NotMine,
    /// The open was abandoned (a newer one took the surface, or Esc came first) or failed with a notice: nothing is on screen.
    Closed,
    /// The picker the application keeps until another surface replaces it.
    Open(Box<dyn PickerController>),
}

fn boxed<P: PickerController + 'static>(picker: Option<P>) -> Option<Box<dyn PickerController>> {
    picker.map(|picker| Box::new(picker) as Box<dyn PickerController>)
}

/// The opener of a settings picker: `options` is what the opener was called with (`{}` for none).
pub fn open(host: &mut dyn PickerHost, opener: Opener, options: &Value) -> Opening {
    let opened = match opener {
        Opener::Settings => boxed(picker::open_settings_picker(host, options)),
        Opener::AutoClear => boxed(auto_clear::open_auto_clear_picker(host, options)),
        Opener::Profile => boxed(profile::open_profile_picker(host, options)),
        Opener::Update => boxed(update::open_update_picker(host, options)),
        Opener::Developer => boxed(developer::open_developer_picker(host, options)),
        _ => return Opening::NotMine,
    };
    opened.map_or(Opening::Closed, Opening::Open)
}

/// The Settings picker's state that outlives one panel (the refs of `App` Node's per-render factory read: the build
/// ticket, the heavy-read cache, the live refresh and the heavy-read gate).
#[derive(Clone, Debug, Default)]
pub struct SettingsState {
    request: u64,
    heavy_cache: Option<HeavyCache>,
    /// The epoch the live refresh is bound to (`settingsLiveRefreshRef`); `None` before the first paint.
    live_refresh: Option<u64>,
    gate: HeavyGate,
}

/// The MCP, plugin and skill status of the last build.
#[derive(Clone, Debug, PartialEq)]
pub struct HeavyCache {
    pub mcp: Value,
    pub plugins: Value,
    pub skills: Value,
}

/// The one heavy read in flight, the single follow-up owed to changes that arrived meanwhile, and the heavy reads that wrote the
/// cache.
#[derive(Clone, Copy, Debug, Default)]
struct HeavyGate {
    running: bool,
    queued: bool,
    fresh_writes: u64,
}

/// `formatDuration(ms)` of the pickers.
fn duration_text(ms: &Value) -> String {
    format_duration(mixdog_js::to_number(ms), DurationOptions::default())
}

/// The wrap-around step through a list of `len` entries from `current` (0 when unknown): the index of the next entry.
fn cycled_index(len: usize, current: Option<usize>, direction: i64) -> usize {
    let len = len as i64;
    ((current.unwrap_or(0) as i64 + direction + len) % len) as usize
}

/// `e?.message || e` of a failed store call is its text already.
fn report(host: &mut dyn PickerHost, prefix: &str, error: &str, tone: Tone) {
    host.push_notice(&format!("{prefix}: {error}"), tone);
}

/// A store call's answer that was a thing (`undefined`, `null`, `false`, `0` and `''` are none).
fn answered(result: &Result<Value, String>) -> Option<&Value> {
    result.as_ref().ok().filter(|value| truthy(value))
}

/// `host.open(opener, options)`; a failure is a notice.
fn open_panel(host: &mut dyn PickerHost, opener: Opener, options: Value) {
    if let Err(error) = host.open(opener, options) {
        host.push_notice(&format!("panel failed to open: {error}"), Tone::Error);
    }
}

/// The options of an opener that is told to come back to Settings.
fn returning() -> Value {
    json!({"returnTo": "settings"})
}
