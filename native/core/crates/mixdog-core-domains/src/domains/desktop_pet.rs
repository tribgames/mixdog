//! The desktop pet's per-device settings and the rules that place its window (desktop-pet-store.ts).
//!
//! - `desktopPet/state/read` answers the stored prefs, every field normalized: anything malformed reads as the default
//!   for that field. `desktopPet/state/write` normalizes what it is given the same way, stores it and announces it
//!   (`desktopPet/state/changed`). The file is `<D>/desktop/desktop-pet.json`, written atomically.
//! - The first read of a data dir without that file copies the Electron profile's `desktop-pet.json` into it, once: one
//!   way, the old file kept, nothing overwritten (the file the profile move of generation 2 deliberately never opens).
//! - The placement rules (pinned above the message box, free, saved per display, clamped to a work area) are plain
//!   functions of rectangles, for the window controller that places the pet.

#![allow(clippy::disallowed_methods, reason = "every file read here is the body of a job of a durability-io lane")]

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_app_protocol::v2::desktop_pet::DesktopPetPrefs;
use mixdog_app_protocol::v2::desktop_pet::DesktopPetStateReadParams;
use mixdog_app_protocol::v2::desktop_pet::DesktopPetStateWriteParams;
use mixdog_app_protocol::v2::desktop_pet::PetHereAnchor;
use mixdog_app_protocol::v2::desktop_pet::PetPoint;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_base::support::wrong_method;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneTokens;
use mixdog_statefile::Opts;
use mixdog_statefile::Published;
use serde_json::Value;

const DOMAIN: &str = "desktopPet";

/// The pet's file under the data dir, and its name in the Electron profile.
pub const STATE_FILE: &str = "desktop/desktop-pet.json";
pub const LEGACY_FILE: &str = "desktop-pet.json";

// ---- Shared constants (shared/desktop-pet.ts) --------------------------------------------------

/// The bot's size choices, in percent of the 100% sprite box.
pub const SCALE_MIN: u32 = 50;
pub const SCALE_MAX: u32 = 200;
pub const SCALE_STEP: u32 = 10;
pub const SCALE_DEFAULT: u32 = 100;

/// The status island above the composer: its pill's height and its gap above the card.
pub const ISLAND_PILL_HEIGHT: f64 = 34.0;
pub const ISLAND_GAP: f64 = 12.0;
/// How far above a wide island pill's top edge the pinned bot's feet stand.
pub const ON_ISLAND_GAP: f64 = 2.0;
/// The 100% window, the sprite box in it (`left` from its left, `bottom` from its bottom, `size` square), and the room
/// above the box for the bubble and the quick message's hop.
pub const WINDOW_WIDTH: f64 = 512.0;
pub const WINDOW_HEIGHT: f64 = 336.0;
pub const SPRITE_LEFT: f64 = 228.0;
pub const SPRITE_BOTTOM: f64 = 8.0;
pub const SPRITE_SIZE: f64 = 56.0;
pub const CORE_WIDTH: f64 = 384.0;
const BUBBLE_ROOM: f64 = 148.0;

/// How far inside the work area's edges the default spot sits.
pub const MARGIN: f64 = 16.0;
/// How far inside the composer card's right edge the pinned sprite box's right edge sits.
pub const PIN_INSET: f64 = 2.0;

/// The bound of a here-anchor's offsets.
const ANCHOR_LIMIT: f64 = 100_000.0;

/// `Math.round`: halves go toward +infinity.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

// ---- Prefs -------------------------------------------------------------------------------------

/// Off unless explicitly turned on; pinned unless explicitly unpinned.
pub fn default_prefs() -> DesktopPetPrefs {
    DesktopPetPrefs {
        enabled: false,
        keep_above: false,
        collapsed: false,
        auto_advance: true,
        auto_close: true,
        pinned: true,
        pinned_here: false,
        on_screen: false,
        scale: SCALE_DEFAULT,
        positions: BTreeMap::new(),
        here_anchor: None,
    }
}

fn read_here_anchor(value: &Value) -> Option<PetHereAnchor> {
    let object = value.as_object()?;
    let right = object.get("right")?.as_bool()?;
    let bottom = object.get("bottom")?.as_bool()?;
    let dx = object.get("dx")?.as_f64().filter(|n| n.abs() <= ANCHOR_LIMIT)?;
    let dy = object.get("dy")?.as_f64().filter(|n| n.abs() <= ANCHOR_LIMIT)?;
    let composer = (object.get("composer") == Some(&Value::Bool(true))).then_some(true);
    Some(PetHereAnchor { right, bottom, dx: js_round(dx) as i64, dy: js_round(dy) as i64, composer })
}

fn is_display_id(id: &str) -> bool {
    (1..=20).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit())
}

/// Anything malformed reads as the default for that field.
pub fn normalize_prefs(value: &Value) -> DesktopPetPrefs {
    let raw = value.as_object();
    let field = |name: &str| raw.and_then(|object| object.get(name));
    let flag = |name: &str| field(name) == Some(&Value::Bool(true));
    let unless_off = |name: &str| field(name) != Some(&Value::Bool(false));
    let mut positions = BTreeMap::new();
    if let Some(stored) = field("positions").and_then(Value::as_object) {
        for (id, point) in stored {
            let x = point.get("x").and_then(Value::as_f64);
            let y = point.get("y").and_then(Value::as_f64);
            if let (true, Some(x), Some(y)) = (is_display_id(id), x, y) {
                positions.insert(id.clone(), PetPoint { x: js_round(x) as i64, y: js_round(y) as i64 });
            }
        }
    }
    let pinned = unless_off("pinned");
    let pinned_here = !pinned && flag("pinnedHere");
    let scale = field("scale")
        .and_then(Value::as_f64)
        .and_then(|n| (SCALE_MIN..=SCALE_MAX).step_by(SCALE_STEP as usize).find(|s| f64::from(*s) == n))
        .unwrap_or(SCALE_DEFAULT);
    DesktopPetPrefs {
        enabled: flag("enabled"),
        keep_above: flag("keepAbove"),
        collapsed: flag("collapsed"),
        auto_advance: unless_off("autoAdvance"),
        auto_close: unless_off("autoClose"),
        pinned,
        pinned_here,
        on_screen: !pinned && !flag("pinnedHere") && flag("onScreen"),
        scale,
        positions,
        here_anchor: if pinned_here { field("hereAnchor").and_then(read_here_anchor) } else { None },
    }
}

/// `readDesktopPetPrefs`: a file that is missing, unreadable or not JSON reads as the default.
pub fn read_prefs(path: &Path) -> DesktopPetPrefs {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map_or_else(default_prefs, |value| normalize_prefs(&value))
}

/// `writeDesktopPetPrefs`: `JSON.stringify(prefs, null, 2)` and a newline, written atomically.
pub fn write_prefs(lane: &InLane<DurabilityIo>, path: &Path, prefs: &DesktopPetPrefs) -> Result<(), String> {
    let value = serde_json::to_value(prefs).map_err(|error| error.to_string())?;
    mixdog_statefile::write_json(lane, path, &value, &Opts::default()).map(drop).map_err(|error| format!("{}: {error}", path.display()))
}

/// Copies the profile's pet file to `target` when `target` does not exist yet: the bytes as they are, create-only, the
/// source left in place. `true` when it copied. A missing or unreadable source copies nothing.
pub fn import_legacy(lane: &InLane<DurabilityIo>, target: &Path, legacy: &Path) -> Result<bool, String> {
    if target.exists() {
        return Ok(false);
    }
    let Ok(bytes) = std::fs::read(legacy) else { return Ok(false) };
    let published = mixdog_statefile::write_file(lane, target, &bytes, &Opts { create_only: true, ..Opts::default() })
        .map_err(|error| format!("{}: {error}", target.display()))?;
    Ok(published == Published::Written)
}

// ---- Placement ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetPos {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetDisplay {
    pub id: u64,
    pub work_area: PetRect,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IslandSpan {
    pub left: f64,
    pub right: f64,
    pub top: f64,
}

/// The app window's composer card in its CSS px, with the bottom edge of the status island's pill above it (`None`: no
/// pill) and that pill's extent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetComposer {
    pub rect: PetRect,
    pub island: Option<f64>,
    pub island_span: Option<IslandSpan>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpriteBox {
    pub left: f64,
    pub bottom: f64,
    pub size: f64,
}

/// The window and sprite box for a bot at some scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PetGeometry {
    pub window: PetSize,
    pub sprite: SpriteBox,
    pub core_width: f64,
}

/// `desktopPetGeometry`: only the sprite scales; the window keeps the 100% room for the bubble, the quick message and the
/// menu. The box is a multiple of 4px.
pub fn pet_geometry(scale: u32) -> PetGeometry {
    let base = SPRITE_SIZE;
    let size = 4.0 * js_round((base / 4.0) * (f64::from(scale) / 100.0));
    let room = size.max(base);
    let height = WINDOW_HEIGHT.max(SPRITE_BOTTOM + room + BUBBLE_ROOM);
    PetGeometry {
        window: PetSize { width: WINDOW_WIDTH - base + room, height },
        sprite: SpriteBox { left: SPRITE_LEFT, bottom: SPRITE_BOTTOM, size },
        core_width: CORE_WIDTH - base / 2.0 + size / 2.0,
    }
}

/// The anchor of a window at `point` (sprite box `sprite` inside it, both screen px) against `content`: the corner
/// nearest the sprite's centre.
pub fn pet_here_anchor(point: PetPos, sprite: PetRect, content: PetRect) -> PetHereAnchor {
    let right = sprite.x + sprite.width / 2.0 > content.x + content.width / 2.0;
    let bottom = sprite.y + sprite.height / 2.0 > content.y + content.height / 2.0;
    PetHereAnchor {
        right,
        bottom,
        dx: js_round(if right { content.x + content.width - point.x } else { point.x - content.x }) as i64,
        dy: js_round(if bottom { content.y + content.height - point.y } else { point.y - content.y }) as i64,
        composer: None,
    }
}

/// The window's top-left for `anchor` against `content` (screen px).
pub fn pet_here_position(anchor: &PetHereAnchor, content: PetRect) -> PetPos {
    let (dx, dy) = (anchor.dx as f64, anchor.dy as f64);
    PetPos {
        x: if anchor.right { content.x + content.width - dx } else { content.x + dx },
        y: if anchor.bottom { content.y + content.height - dy } else { content.y + dy },
    }
}

/// The line (CSS px) the pinned bot's visible feet stand on: the pill's bottom edge, or where it would be.
pub fn pet_island_line(composer: &PetComposer) -> f64 {
    composer.island.unwrap_or(composer.rect.y - ISLAND_GAP)
}

/// The pinned window's spot: the sprite box's bottom on the island line, its right edge `PIN_INSET` inside the card's. A
/// pill running under the sprite box puts the bot on top of it, kept over the island and inside the card's span.
/// `content` is the app window's content bounds (screen px), `zoom` the app's zoom factor.
pub fn pinned_pet_position(content: PetRect, composer: &PetComposer, zoom: f64, geometry: &PetGeometry) -> PetPos {
    let PetGeometry { window, sprite, .. } = geometry;
    let card = composer.rect;
    let left = content.x + card.x * zoom;
    let right = content.x + (card.x + card.width) * zoom;
    let rest_right = right - PIN_INSET;
    let span = if composer.island.is_some() { composer.island_span } else { None };
    let overlaps = span.is_some_and(|span| content.x + span.left * zoom < rest_right && content.x + span.right * zoom > rest_right - sprite.size);
    let mut box_right = rest_right;
    let mut line = content.y + pet_island_line(composer) * zoom;
    if let (true, Some(span)) = (overlaps, span) {
        let island_left = content.x + span.left * zoom;
        let island_right = content.x + span.right * zoom;
        box_right = (island_right - PIN_INSET).min(rest_right);
        box_right = box_right.max((island_left + PIN_INSET + sprite.size).min(rest_right));
        box_right = box_right.max(left + PIN_INSET + sprite.size);
        line = content.y + span.top * zoom - ON_ISLAND_GAP;
    }
    PetPos { x: js_round(box_right - sprite.left - sprite.size), y: js_round(line - (window.height - sprite.bottom)) }
}

/// Bottom-right of a work area, a little inside the margin.
pub fn default_pet_position(work_area: PetRect, size: PetSize) -> PetPos {
    PetPos { x: work_area.x + work_area.width - size.width - MARGIN, y: work_area.y + work_area.height - size.height - MARGIN }
}

/// `value` within [min, max]; an empty range (max < min) resolves to min.
pub fn clamp_to_range(value: f64, min: f64, max: f64) -> f64 {
    min.max(max).min(min.max(value))
}

/// The whole window inside the work area.
pub fn clamp_pet_position(point: PetPos, size: PetSize, work_area: PetRect) -> PetPos {
    PetPos {
        x: js_round(clamp_to_range(point.x, work_area.x, work_area.x + work_area.width - size.width)),
        y: js_round(clamp_to_range(point.y, work_area.y, work_area.y + work_area.height - size.height)),
    }
}

/// The display a window at `point` belongs to: the one holding its centre, else the nearest by centre distance.
pub fn display_for_pet_position(point: PetPos, size: PetSize, displays: &[PetDisplay]) -> Option<&PetDisplay> {
    let cx = point.x + size.width / 2.0;
    let cy = point.y + size.height / 2.0;
    if let Some(inside) = displays.iter().find(|d| {
        let a = d.work_area;
        cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height
    }) {
        return Some(inside);
    }
    let mut best = None;
    let mut distance = f64::INFINITY;
    for display in displays {
        let a = display.work_area;
        let d = (a.x + a.width / 2.0 - cx).hypot(a.y + a.height / 2.0 - cy);
        if d < distance {
            distance = d;
            best = Some(display);
        }
    }
    best
}

/// A free (or pinned-here) window's spot (its unflipped top-left) inside the work area by the bot itself: its sprite box
/// reaches the left, right and top edges, the window's transparent room running past the screen there; at the bottom the
/// box keeps its margin under the feet.
pub fn clamp_free_pet_position(point: PetPos, geometry: &PetGeometry, work_area: PetRect) -> PetPos {
    let PetGeometry { window, sprite, .. } = geometry;
    let above = window.height - sprite.bottom - sprite.size;
    let boxed = clamp_pet_position(
        PetPos { x: point.x + sprite.left, y: point.y + above },
        PetSize { width: sprite.size, height: sprite.size + sprite.bottom },
        work_area,
    );
    PetPos { x: boxed.x - sprite.left, y: boxed.y - above }
}

/// Where the pet window opens on `display`: its saved spot there (clamped), else the default corner.
pub fn pet_position_on(display: &PetDisplay, prefs: &DesktopPetPrefs, geometry: &PetGeometry) -> PetPos {
    let saved = prefs.positions.get(&display.id.to_string()).map(|p| PetPos { x: p.x as f64, y: p.y as f64 });
    clamp_free_pet_position(saved.unwrap_or_else(|| default_pet_position(display.work_area, geometry.window)), geometry, display.work_area)
}

// ---- The service -------------------------------------------------------------------------------

pub struct DesktopPetService {
    file: PathBuf,
    /// The Electron profile's pet file, when a profile is known (read when the data dir has no pet file yet).
    legacy: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
    /// Told the stored prefs after each write (`desktopPet/state/changed`).
    changed: Arc<dyn Fn(&DesktopPetPrefs) + Send + Sync>,
    durability: DurabilityIo,
    /// One read or write at a time: the first read's import and a write never race.
    one: Arc<Mutex<()>>,
}

impl DesktopPetService {
    /// `data` is `<D>`; `profile` answers the Electron profile directory once it is known.
    pub fn new(
        data: PathBuf,
        profile: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>,
        changed: Arc<dyn Fn(&DesktopPetPrefs) + Send + Sync>,
        tokens: &LaneTokens,
    ) -> Self {
        let legacy: Arc<dyn Fn() -> Option<PathBuf> + Send + Sync> = Arc::new(move || profile().map(|dir| dir.join(LEGACY_FILE)));
        Self { file: data.join(STATE_FILE), legacy, changed, durability: tokens.durability_io, one: Arc::new(Mutex::new(())) }
    }
}

fn reply<T: serde::Serialize>(answer: &T) -> Result<Reply, CoreError> {
    serde_json::to_value(answer).map(Reply::Value).map_err(|error| failed(DOMAIN, error.to_string()))
}

#[async_trait]
impl DomainService for DesktopPetService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let file = self.file.clone();
        let one = self.one.clone();
        match req.method.as_str() {
            "desktopPet/state/read" => {
                let _params: DesktopPetStateReadParams = decode(&req)?;
                let legacy = (self.legacy)();
                let prefs = on_lane_wait(self.durability, &req.ctx.cancel, move |lane| {
                    let _one = one.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Some(legacy) = legacy {
                        import_legacy(lane, &file, &legacy)?;
                    }
                    Ok::<_, String>(read_prefs(&file))
                })
                .await?
                .map_err(|error| failed(DOMAIN, error))?;
                reply(&prefs)
            }
            "desktopPet/state/write" => {
                let params: DesktopPetStateWriteParams = decode(&req)?;
                let prefs = normalize_prefs(&params.prefs);
                let stored = prefs.clone();
                on_lane_wait(self.durability, &req.ctx.cancel, move |lane| {
                    let _one = one.lock().unwrap_or_else(PoisonError::into_inner);
                    write_prefs(lane, &file, &stored)
                })
                .await?
                .map_err(|error| failed(DOMAIN, error))?;
                (self.changed)(&prefs);
                reply(&prefs)
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["desktopPet/state/read", "desktopPet/state/write"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "desktop_pet_tests.rs"]
mod tests;
