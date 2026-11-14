//! Params and results of the desktop pet's settings methods (desktop-pet-store.ts `DesktopPetPrefs`).

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

/// Params of `desktopPet/state/read`: none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetStateReadParams {}

/// Params of `desktopPet/state/write`: the settings document. Anything malformed in it is stored as the default for that field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetStateWriteParams {
    pub prefs: JsonValue,
}

/// A saved free-floating window position (screen px).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PetPoint {
    pub x: i64,
    pub y: i64,
}

/// Where a pinned-here window stands relative to the app window's content bounds: its top-left `dx` from the left edge (or,
/// `right`, from the right edge, positive leftward), and `dy` from the top (or, `bottom`, the bottom).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PetHereAnchor {
    pub right: bool,
    pub bottom: bool,
    pub dx: i64,
    pub dy: i64,
    /// Measured against the composer card instead of the content bounds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer: Option<bool>,
}

/// The pet's per-device settings, as `desktop-pet.json` stores them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetPrefs {
    pub enabled: bool,
    pub keep_above: bool,
    pub collapsed: bool,
    pub auto_advance: bool,
    pub auto_close: bool,
    pub pinned: bool,
    pub pinned_here: bool,
    pub on_screen: bool,
    /// One of 50, 60, ... 200.
    pub scale: u32,
    /// Saved free-floating window positions by display id.
    pub positions: BTreeMap<String, PetPoint>,
    pub here_anchor: Option<PetHereAnchor>,
}

/// Params of `desktopPet/state/changed`: the stored settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetStateChangedParams {
    pub prefs: DesktopPetPrefs,
}
