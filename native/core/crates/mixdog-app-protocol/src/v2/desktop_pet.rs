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

/// A rectangle in screen px (or, for a composer card, the app's CSS px).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A point in screen px.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementPoint {
    pub x: f64,
    pub y: f64,
}

/// A size in px.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementSize {
    pub width: f64,
    pub height: f64,
}

/// A display: its id and its work area (screen px).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlacementDisplay {
    pub id: u64,
    pub work_area: PlacementRect,
}

/// The extent of the status island's pill (CSS px).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementIslandSpan {
    pub left: f64,
    pub right: f64,
    pub top: f64,
}

/// The app window's composer card (CSS px), the bottom edge of the pill above it, and the pill's extent.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PlacementComposer {
    pub rect: PlacementRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub island: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub island_span: Option<PlacementIslandSpan>,
}

/// The window's size at a pet scale: its window, sprite box and core width.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementScale {
    /// One of 50, 60, ... 200.
    pub scale: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlacementPinned {
    pub content: PlacementRect,
    pub composer: PlacementComposer,
    pub zoom: f64,
    pub scale: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlacementClamp {
    pub point: PlacementPoint,
    pub size: PlacementSize,
    pub work_area: PlacementRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PlacementClampFree {
    pub point: PlacementPoint,
    pub scale: u32,
    pub work_area: PlacementRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementHereAnchor {
    pub point: PlacementPoint,
    pub sprite: PlacementRect,
    pub content: PlacementRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementHerePosition {
    pub anchor: PetHereAnchor,
    pub content: PlacementRect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementDisplayFor {
    pub point: PlacementPoint,
    pub size: PlacementSize,
    pub displays: Vec<PlacementDisplay>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
pub struct PlacementPositionOn {
    pub display: PlacementDisplay,
    pub prefs: DesktopPetPrefs,
    pub scale: u32,
}

/// Params of `desktopPet/placement/resolve`: one of the rules that place the pet window, by `op`. Every answer is a plain
/// document: `geometry` -> `{ window, sprite, coreWidth, pinInset }`; `pinned`, `clamp`, `clampFree`, `herePosition`, `positionOn` ->
/// a point; `hereAnchor` -> the anchor; `displayFor` -> the display's id, or null for no display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DesktopPetPlacementResolveParams {
    Geometry(PlacementScale),
    Pinned(PlacementPinned),
    Clamp(PlacementClamp),
    ClampFree(PlacementClampFree),
    HereAnchor(PlacementHereAnchor),
    HerePosition(PlacementHerePosition),
    DisplayFor(PlacementDisplayFor),
    PositionOn(PlacementPositionOn),
}
