#![allow(clippy::disallowed_methods, reason = "test setup: files of a scratch data dir and profile are written and read on the test thread")]

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use serde_json::Value;
use serde_json::json;

use super::*;

const PRIMARY: PetDisplay = PetDisplay { id: 1, work_area: PetRect { x: 0.0, y: 0.0, width: 1920.0, height: 1040.0 } };
const SECOND: PetDisplay = PetDisplay { id: 2, work_area: PetRect { x: 1920.0, y: 0.0, width: 1280.0, height: 1000.0 } };
const CONTENT: PetRect = PetRect { x: 100.0, y: 50.0, width: 1200.0, height: 800.0 };
const CARD: PetRect = PetRect { x: 100.0, y: 600.0, width: 1000.0, height: 90.0 };

fn composer(island: Option<f64>, span: Option<IslandSpan>) -> PetComposer {
    PetComposer { rect: CARD, island, island_span: span }
}

fn size(scale: u32) -> PetGeometry {
    pet_geometry(scale)
}

// ---- Prefs -------------------------------------------------------------------------------------

#[test]
fn an_unset_overlay_is_off_and_pinned() {
    let prefs = normalize_prefs(&json!({}));
    assert_eq!(prefs, default_prefs());
    assert!(!prefs.enabled);
    assert!(prefs.pinned);
    assert!(prefs.auto_advance && prefs.auto_close);
    assert!(!normalize_prefs(&json!({ "pinned": false })).pinned, "an explicit unpin is kept");
    assert!(normalize_prefs(&json!({ "enabled": true })).enabled, "a stored true is on");
    assert!(!normalize_prefs(&json!({ "enabled": false })).enabled, "explicit off kept");
    assert!(normalize_prefs(&json!({ "keepAbove": true })).keep_above);
}

#[test]
fn stored_prefs_malformed_fields_read_as_defaults() {
    let prefs = normalize_prefs(&json!({
        "enabled": "yes",
        "alwaysOnTop": true,
        "keepAbove": "yes",
        "positions": { "1": { "x": "a" }, "abc": { "x": 1, "y": 2 }, "7": { "x": 1.4, "y": 2 } },
    }));
    let mut expected = default_prefs();
    expected.positions.insert("7".into(), PetPoint { x: 1, y: 2 });
    assert_eq!(prefs, expected);
    assert!(!prefs.keep_above, "an older build's alwaysOnTop is not a choice");
}

#[test]
fn anything_that_is_not_an_object_reads_as_the_default() {
    for value in [json!(null), json!(3), json!("x"), json!([1, 2]), json!(true)] {
        assert_eq!(normalize_prefs(&value), default_prefs());
    }
    let prefs = normalize_prefs(&json!({ "positions": [1], "autoAdvance": false, "autoClose": false, "collapsed": true }));
    assert!(prefs.positions.is_empty());
    assert!(!prefs.auto_advance && !prefs.auto_close && prefs.collapsed);
}

#[test]
fn the_pins_are_exclusive() {
    assert!(normalize_prefs(&json!({ "pinned": false, "pinnedHere": true })).pinned_here);
    assert!(!normalize_prefs(&json!({ "pinnedHere": true })).pinned_here, "never with the composer pin");
    assert!(!normalize_prefs(&json!({ "pinned": false, "pinnedHere": "yes" })).pinned_here);
    let free = normalize_prefs(&json!({ "pinned": false, "onScreen": true }));
    assert!(free.on_screen);
    assert!(!normalize_prefs(&json!({ "onScreen": true })).on_screen, "never with the composer pin");
    let both = normalize_prefs(&json!({ "pinned": false, "pinnedHere": true, "onScreen": true }));
    assert!(both.pinned_here && !both.on_screen, "never with pin here");
}

#[test]
fn scale_keeps_the_fifteen_choices() {
    for scale in (50..=200).step_by(10) {
        assert_eq!(normalize_prefs(&json!({ "scale": scale })).scale, scale);
    }
    assert_eq!(normalize_prefs(&json!({ "scale": 150.0 })).scale, 150);
    for scale in [json!(40), json!(210), json!(155), json!("150"), json!(null), json!(true)] {
        assert_eq!(normalize_prefs(&json!({ "scale": scale })).scale, 100, "stored {scale} reads as 100");
    }
}

#[test]
fn positions_keep_display_ids_and_round_like_javascript() {
    let prefs = normalize_prefs(&json!({
        "positions": {
            "3": { "x": 2.5, "y": -2.5 },
            "12345678901234567890": { "x": 1, "y": 1 },
            "123456789012345678901": { "x": 1, "y": 1 },
            "": { "x": 1, "y": 1 },
            "-1": { "x": 1, "y": 1 },
            "4": null,
            "5": { "x": 1 },
        },
    }));
    let keys: Vec<&str> = prefs.positions.keys().map(String::as_str).collect();
    assert_eq!(keys, ["12345678901234567890", "3"]);
    assert_eq!(prefs.positions["3"], PetPoint { x: 3, y: -2 }, "Math.round: halves go up");
}

#[test]
fn a_here_anchor_is_kept_only_for_pin_here_and_only_when_well_formed() {
    let anchor = json!({ "right": true, "bottom": false, "dx": 10.4, "dy": 20.6, "composer": true });
    let kept = normalize_prefs(&json!({ "pinned": false, "pinnedHere": true, "hereAnchor": anchor }));
    assert_eq!(kept.here_anchor, Some(PetHereAnchor { right: true, bottom: false, dx: 10, dy: 21, composer: Some(true) }));
    assert_eq!(normalize_prefs(&json!({ "hereAnchor": anchor })).here_anchor, None, "pinned: none");
    assert_eq!(normalize_prefs(&json!({ "pinned": false, "hereAnchor": anchor })).here_anchor, None, "free: none");
    let plain = json!({ "right": false, "bottom": true, "dx": 1, "dy": 2, "composer": "yes" });
    let free = |value: Value| normalize_prefs(&json!({ "pinned": false, "pinnedHere": true, "hereAnchor": value })).here_anchor;
    assert_eq!(free(plain), Some(PetHereAnchor { right: false, bottom: true, dx: 1, dy: 2, composer: None }));
    assert_eq!(free(json!({ "right": 1, "bottom": true, "dx": 1, "dy": 2 })), None);
    assert_eq!(free(json!({ "right": true, "bottom": true, "dx": "1", "dy": 2 })), None);
    assert_eq!(free(json!({ "right": true, "bottom": true, "dx": 100_001, "dy": 2 })), None);
    assert!(free(json!({ "right": true, "bottom": true, "dx": 100_000, "dy": -100_000 })).is_some());
    assert_eq!(free(json!(null)), None);
    assert_eq!(free(json!("x")), None);
}

#[test]
fn prefs_serialize_in_the_stores_shape() {
    let value = serde_json::to_value(default_prefs()).unwrap();
    assert_eq!(
        value,
        json!({
            "enabled": false, "keepAbove": false, "collapsed": false, "autoAdvance": true, "autoClose": true,
            "pinned": true, "pinnedHere": false, "onScreen": false, "scale": 100, "positions": {}, "hereAnchor": null,
        })
    );
    let mut prefs = default_prefs();
    prefs.here_anchor = Some(PetHereAnchor { right: true, bottom: true, dx: 1, dy: 2, composer: Some(true) });
    assert_eq!(serde_json::to_value(&prefs).unwrap()["hereAnchor"], json!({ "right": true, "bottom": true, "dx": 1, "dy": 2, "composer": true }));
}

#[test]
fn a_missing_or_damaged_file_reads_as_the_default() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_prefs(&dir.path().join("none.json")), default_prefs());
    let damaged = dir.path().join("damaged.json");
    std::fs::write(&damaged, "{ not json").unwrap();
    assert_eq!(read_prefs(&damaged), default_prefs());
    let stored = dir.path().join("stored.json");
    std::fs::write(&stored, r#"{"enabled":true,"scale":150}"#).unwrap();
    let prefs = read_prefs(&stored);
    assert!(prefs.enabled);
    assert_eq!(prefs.scale, 150);
}

// ---- Placement ---------------------------------------------------------------------------------

#[test]
fn the_bot_scales_50_to_200_only_the_sprite_grows() {
    let hundred = size(100);
    assert_eq!(hundred.window, PetSize { width: 512.0, height: 336.0 });
    assert_eq!(hundred.sprite, SpriteBox { left: 228.0, bottom: 8.0, size: 56.0 });
    assert_eq!(hundred.core_width, 384.0);
    assert_eq!(size(50).sprite.size, 28.0);
    assert_eq!(size(50).window, PetSize { width: 512.0, height: 336.0 }, "smaller: the 100% window");
    assert_eq!(size(150).sprite.size, 84.0);
    assert_eq!(size(200).sprite, SpriteBox { left: 228.0, bottom: 8.0, size: 112.0 });
    assert_eq!(size(200).window, PetSize { width: 568.0, height: 336.0 });
    for scale in (50..=200).step_by(10) {
        let PetGeometry { window, sprite, core_width } = size(scale);
        assert_eq!(sprite.size % 4.0, 0.0, "{scale}%: whole quarter art pixels");
        assert!((sprite.size - 56.0 * f64::from(scale) / 100.0).abs() <= 2.0, "{scale}%: about {scale}% of 56px");
        assert!(window.width - (sprite.left + sprite.size) - 8.0 - 4.0 >= 200.0, "{scale}%: right menu room");
        assert!(sprite.left - 8.0 - 4.0 >= 200.0, "{scale}%: left menu room");
        let centre = sprite.left + sprite.size / 2.0;
        assert!(centre - 120.0 >= 0.0 && centre + 120.0 <= core_width && core_width <= window.width, "{scale}%: quick message");
        assert!(window.height - sprite.bottom - sprite.size >= 212.0 - 8.0 - 56.0, "{scale}%: bubble room");
    }
}

#[test]
fn the_menu_fits_in_the_window_at_every_scale() {
    // nine items and the Size row at 28px, three 5px dividers, 6px insets and hairlines: 309px, in 328px of room.
    for scale in (50..=200).step_by(10) {
        assert!(size(scale).window.height >= 328.0 + 2.0 * 4.0, "{scale}%");
    }
}

#[test]
fn clamp_pet_position_keeps_the_whole_window_inside_the_work_area() {
    let window = size(100).window;
    assert_eq!(clamp_pet_position(PetPos { x: -10.0, y: 9999.0 }, window, PRIMARY.work_area), PetPos { x: 0.0, y: 1040.0 - window.height });
    assert_eq!(clamp_to_range(5.0, 10.0, 0.0), 10.0, "an empty range resolves to min");
    assert_eq!(clamp_to_range(50.0, 0.0, 10.0), 10.0);
    assert_eq!(clamp_to_range(-5.0, 0.0, 10.0), 0.0);
}

#[test]
fn the_default_spot_is_the_bottom_right_inside_the_margin() {
    let window = size(100).window;
    assert_eq!(
        default_pet_position(PRIMARY.work_area, window),
        PetPos { x: 1920.0 - window.width - MARGIN, y: 1040.0 - window.height - MARGIN }
    );
}

#[test]
fn pinned_the_feet_stand_on_the_island_line_and_the_right_just_inside_the_card() {
    for scale in (50..=200).step_by(10) {
        let geometry = size(scale);
        let PetGeometry { window, sprite, .. } = geometry;
        let at = pinned_pet_position(CONTENT, &composer(None, None), 1.0, &geometry);
        assert_eq!(at.y + (window.height - sprite.bottom), CONTENT.y + CARD.y - 12.0, "{scale}%: no island, the pill's bottom would be 12px above");
        assert_eq!(at.x + sprite.left + sprite.size, CONTENT.x + CARD.x + CARD.width - PIN_INSET, "{scale}%: right inside the card");
        let on_pill = pinned_pet_position(CONTENT, &composer(Some(588.0), None), 1.0, &geometry);
        assert_eq!(on_pill.y + (window.height - sprite.bottom), CONTENT.y + 588.0, "{scale}%: the pill's real bottom");
    }
}

#[test]
fn pinned_a_wide_island_puts_the_feet_on_its_top_and_a_narrow_one_or_none_keeps_the_line() {
    let box_right = CARD.x + CARD.width - PIN_INSET;
    for scale in [50, 100, 200] {
        let geometry = size(scale);
        let PetGeometry { window, sprite, .. } = geometry;
        let feet = |c: &PetComposer, zoom: f64| pinned_pet_position(CONTENT, c, zoom, &geometry).y + (window.height - sprite.bottom);
        let right = |c: &PetComposer| pinned_pet_position(CONTENT, c, 1.0, &geometry).x + sprite.left + sprite.size;
        let span = |left: f64, right: f64| composer(Some(588.0), Some(IslandSpan { left, right, top: 554.0 }));
        // Narrow, centred: clear of the box.
        assert_eq!(feet(&span(500.0, 800.0), 1.0), CONTENT.y + 588.0, "{scale}%: narrow island, baseline");
        // Ends just short of the box's left edge: touching is not overlapping.
        assert_eq!(feet(&span(400.0, box_right - sprite.size), 1.0), CONTENT.y + 588.0, "{scale}%: touching");
        // Wide: its right end runs under the box, the bot stands on its top.
        let wide = span(320.0, box_right - sprite.size + 10.0);
        assert_eq!(feet(&wide, 1.0), CONTENT.y + 554.0 - 2.0, "{scale}%: feet on the island top");
        assert_eq!(right(&wide), CONTENT.x + box_right - sprite.size + 10.0 - PIN_INSET, "{scale}%: at the island's right end");
        // An island reaching the card's right: never past the card.
        assert_eq!(right(&span(320.0, CARD.x + CARD.width)), CONTENT.x + box_right, "{scale}%: never past the card");
        // A short island under the box: the sprite stays over it, from its left end.
        let short = span(box_right - sprite.size - 20.0, box_right - sprite.size + 10.0);
        assert_eq!(right(&short) - sprite.size, CONTENT.x + box_right - sprite.size - 20.0 + PIN_INSET, "{scale}%: kept over a short island");
        // Zoomed: the overlap and the top in the app's CSS px.
        assert!((feet(&span(320.0, 1200.0), 1.25) - (CONTENT.y + 554.0 * 1.25 - 2.0)).abs() <= 1.0, "{scale}%: zoomed");
        // No island: a stale span is ignored.
        let stale = composer(None, Some(IslandSpan { left: 320.0, right: 1000.0, top: 554.0 }));
        assert_eq!(feet(&stale, 1.0), CONTENT.y + CARD.y - 12.0, "{scale}%: no island");
    }
}

#[test]
fn free_the_bot_reaches_both_side_edges_and_the_top_at_every_scale() {
    for scale in (50..=200).step_by(10) {
        let geometry = size(scale);
        let PetGeometry { window, sprite, .. } = geometry;
        let work = PRIMARY.work_area;
        let far_left = clamp_free_pet_position(PetPos { x: -5000.0, y: 500.0 }, &geometry, work);
        assert_eq!(far_left.x + sprite.left, work.x, "{scale}%: the box reaches the left edge");
        let far_right = clamp_free_pet_position(PetPos { x: 9000.0, y: 500.0 }, &geometry, work);
        assert_eq!(far_right.x + sprite.left + sprite.size, work.x + work.width, "{scale}%: the box reaches the right edge");
        let top = clamp_free_pet_position(PetPos { x: 500.0, y: -5000.0 }, &geometry, work);
        assert_eq!(top.y + window.height - sprite.bottom - sprite.size, work.y, "{scale}%: the box reaches the top");
        let bottom = clamp_free_pet_position(PetPos { x: 500.0, y: 9000.0 }, &geometry, work);
        assert_eq!(bottom.y + window.height, work.y + work.height, "{scale}%: the window's bottom on the work area's");
    }
}

#[test]
fn the_display_holding_the_centre_else_the_nearest() {
    let window = size(100).window;
    let displays = [PRIMARY, SECOND];
    let on_second = PetPos { x: 2000.0, y: 100.0 };
    assert_eq!(display_for_pet_position(on_second, window, &displays).map(|d| d.id), Some(2));
    assert_eq!(display_for_pet_position(PetPos { x: 100.0, y: 100.0 }, window, &displays).map(|d| d.id), Some(1));
    // Past every display: the nearest by centre distance.
    assert_eq!(display_for_pet_position(PetPos { x: 5000.0, y: 100.0 }, window, &displays).map(|d| d.id), Some(2));
    assert_eq!(display_for_pet_position(PetPos { x: -4000.0, y: 100.0 }, window, &displays).map(|d| d.id), Some(1));
    assert!(display_for_pet_position(on_second, window, &[]).is_none());
}

#[test]
fn a_saved_spot_is_restored_clamped_per_display_else_the_default_corner() {
    let geometry = size(100);
    let mut prefs = default_prefs();
    assert_eq!(
        pet_position_on(&PRIMARY, &prefs, &geometry),
        clamp_free_pet_position(default_pet_position(PRIMARY.work_area, geometry.window), &geometry, PRIMARY.work_area)
    );
    prefs.positions.insert("1".into(), PetPoint { x: 300, y: 200 });
    assert_eq!(pet_position_on(&PRIMARY, &prefs, &geometry), PetPos { x: 300.0, y: 200.0 });
    assert_eq!(
        pet_position_on(&SECOND, &prefs, &geometry),
        clamp_free_pet_position(default_pet_position(SECOND.work_area, geometry.window), &geometry, SECOND.work_area),
        "the second display has no saved spot"
    );
    prefs.positions.insert("1".into(), PetPoint { x: -9000, y: 9000 });
    let clamped = pet_position_on(&PRIMARY, &prefs, &geometry);
    assert_eq!(clamped, clamp_free_pet_position(PetPos { x: -9000.0, y: 9000.0 }, &geometry, PRIMARY.work_area));
}

#[test]
fn the_here_anchor_keeps_the_distance_from_the_nearest_corner() {
    let sprite_at = |x: f64, y: f64| PetRect { x, y, width: 56.0, height: 56.0 };
    // Left, top.
    let top_left = pet_here_anchor(PetPos { x: 150.5, y: 80.0 }, sprite_at(150.0, 80.0), CONTENT);
    assert_eq!(top_left, PetHereAnchor { right: false, bottom: false, dx: 51, dy: 30, composer: None });
    // Right, bottom: offsets from the right and bottom edges, positive inward.
    let bottom_right = pet_here_anchor(PetPos { x: 1200.0, y: 800.0 }, sprite_at(1200.0, 800.0), CONTENT);
    assert_eq!(bottom_right, PetHereAnchor { right: true, bottom: true, dx: 100, dy: 50, composer: None });
    for anchor in [top_left, bottom_right] {
        let moved = PetRect { x: CONTENT.x + 40.0, y: CONTENT.y + 25.0, width: 1300.0, height: 700.0 };
        let at = pet_here_position(&anchor, moved);
        let back = pet_here_anchor(at, PetRect { x: at.x, y: at.y, width: 56.0, height: 56.0 }, moved);
        assert_eq!((back.right, back.dx, back.dy), (anchor.right, anchor.dx, anchor.dy));
    }
    assert_eq!(pet_here_position(&top_left, CONTENT), PetPos { x: 151.0, y: 80.0 });
    assert_eq!(pet_here_position(&bottom_right, CONTENT), PetPos { x: 1200.0, y: 800.0 });
}

// ---- The service -------------------------------------------------------------------------------

struct Rig {
    root: tempfile::TempDir,
    service: DesktopPetService,
    heard: Arc<Mutex<Vec<DesktopPetPrefs>>>,
}

impl Rig {
    fn new(profile: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        for dir in ["data", "profile"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        let heard = Arc::new(Mutex::new(Vec::new()));
        let sink = heard.clone();
        let named = profile.then(|| root.path().join("profile"));
        let service = DesktopPetService::new(
            root.path().join("data"),
            Arc::new(move || named.clone()),
            Arc::new(move |prefs| sink.lock().unwrap().push(prefs.clone())),
            &mixdog_rt::testing::tokens(),
        );
        Self { root, service, heard }
    }

    fn file(&self) -> std::path::PathBuf {
        self.root.path().join("data").join(STATE_FILE)
    }

    fn legacy(&self) -> std::path::PathBuf {
        self.root.path().join("profile").join(LEGACY_FILE)
    }

    async fn read(&self) -> Value {
        value(&self.service, request("desktopPet/state/read", json!({}), None)).await.unwrap()
    }

    async fn write(&self, prefs: Value) -> Value {
        value(&self.service, request("desktopPet/state/write", json!({ "prefs": prefs }), None)).await.unwrap()
    }
}

#[tokio::test]
async fn read_answers_the_default_with_no_file() {
    let rig = Rig::new(false);
    assert_eq!(rig.read().await, serde_json::to_value(default_prefs()).unwrap());
    assert!(!rig.file().exists(), "a read creates nothing");
}

#[tokio::test]
async fn write_normalizes_stores_and_announces() {
    let rig = Rig::new(false);
    let answer = rig.write(json!({ "enabled": true, "scale": 120, "pinned": false, "pinnedHere": true, "bogus": 1 })).await;
    assert_eq!(answer["enabled"], json!(true));
    assert_eq!(answer["scale"], json!(120));
    assert_eq!(answer["pinnedHere"], json!(true));
    assert!(answer.get("bogus").is_none());
    let text = std::fs::read_to_string(rig.file()).unwrap();
    assert!(text.ends_with('\n') && text.contains("\n  \"enabled\": true"), "two-space JSON and a newline");
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), answer);
    assert_eq!(rig.read().await, answer, "a read returns what was written");
    let heard = rig.heard.lock().unwrap();
    assert_eq!(heard.len(), 1, "one announcement per write, none per read");
    assert!(heard[0].enabled && heard[0].pinned_here);
}

#[tokio::test]
async fn write_of_malformed_prefs_stores_the_defaults_for_those_fields() {
    let rig = Rig::new(false);
    let answer = rig.write(json!({ "enabled": "yes", "scale": 155 })).await;
    assert_eq!(answer, serde_json::to_value(default_prefs()).unwrap());
    let refused = rig.service.call(request("desktopPet/state/write", json!({}), None)).await;
    assert!(refused.is_err(), "no prefs member is a params error");
}

#[tokio::test]
async fn the_profiles_file_is_copied_once_one_way_and_kept() {
    let rig = Rig::new(true);
    std::fs::write(rig.legacy(), r#"{"enabled":true,"scale":150,"alwaysOnTop":true}"#).unwrap();
    let first = rig.read().await;
    assert_eq!(first["enabled"], json!(true));
    assert_eq!(first["scale"], json!(150));
    assert_eq!(first["keepAbove"], json!(false), "an older build's alwaysOnTop is not read");
    assert!(rig.legacy().exists(), "the old file is kept");
    assert!(rig.file().exists(), "the core's copy is made");
    // Idempotent: a second read changes nothing; the profile's file changed later is not read again.
    let copy = std::fs::read(rig.file()).unwrap();
    std::fs::write(rig.legacy(), r#"{"enabled":false}"#).unwrap();
    assert_eq!(rig.read().await, first);
    assert_eq!(std::fs::read(rig.file()).unwrap(), copy);
    // One way: a write reaches the core's file only.
    rig.write(json!({ "enabled": false })).await;
    assert_eq!(std::fs::read_to_string(rig.legacy()).unwrap(), r#"{"enabled":false}"#);
}

#[tokio::test]
async fn an_existing_core_file_is_never_overwritten_by_the_import() {
    let rig = Rig::new(true);
    rig.write(json!({ "enabled": true, "scale": 70 })).await;
    std::fs::write(rig.legacy(), r#"{"enabled":false,"scale":200}"#).unwrap();
    let read = rig.read().await;
    assert_eq!(read["scale"], json!(70));
    assert_eq!(read["enabled"], json!(true));
}

#[tokio::test]
async fn without_a_profile_or_a_profile_file_nothing_is_imported() {
    let none = Rig::new(false);
    std::fs::write(none.legacy(), r#"{"enabled":true}"#).unwrap();
    assert_eq!(none.read().await["enabled"], json!(false));
    assert!(!none.file().exists());
    let empty = Rig::new(true);
    assert_eq!(empty.read().await["enabled"], json!(false));
    assert!(!empty.file().exists());
}

#[tokio::test]
async fn a_damaged_profile_file_is_copied_and_reads_as_the_default() {
    let rig = Rig::new(true);
    std::fs::write(rig.legacy(), "{ nope").unwrap();
    assert_eq!(rig.read().await, serde_json::to_value(default_prefs()).unwrap());
}

#[tokio::test]
async fn another_method_is_not_this_services() {
    let rig = Rig::new(false);
    assert!(rig.service.call(request("desktopPet/other", json!({}), None)).await.is_err());
    assert_eq!(rig.service.methods(), &["desktopPet/state/read", "desktopPet/state/write", "desktopPet/placement/resolve"]);
}

// ---- The placement method ----------------------------------------------------------------------

#[test]
fn the_placement_method_answers_each_rule_as_the_function_does() {
    let ask = |params: Value| resolve_placement(serde_json::from_value(params).expect("placement params"));
    let rect = |r: PetRect| json!({ "x": r.x, "y": r.y, "width": r.width, "height": r.height });
    let point = |p: PetPos| json!({ "x": p.x, "y": p.y });
    let geometry = ask(json!({ "op": "geometry", "scale": 150 }));
    assert_eq!(geometry["window"]["width"], json!(size(150).window.width));
    assert_eq!(geometry["sprite"]["size"], json!(size(150).sprite.size));
    assert_eq!(geometry["coreWidth"], json!(size(150).core_width));
    let pinned = ask(json!({ "op": "pinned", "content": rect(CONTENT), "composer": { "rect": rect(CARD), "island": 580.0 }, "zoom": 1.25, "scale": 100 }));
    assert_eq!(pinned, point(pinned_pet_position(CONTENT, &composer(Some(580.0), None), 1.25, &size(100))));
    let at = PetPos { x: -40.0, y: 2000.0 };
    let free = ask(json!({ "op": "clampFree", "point": point(at), "scale": 100, "workArea": rect(PRIMARY.work_area) }));
    assert_eq!(free, point(clamp_free_pet_position(at, &size(100), PRIMARY.work_area)));
    let boxed = ask(json!({ "op": "clamp", "point": point(at), "size": { "width": 384.0, "height": 336.0 }, "workArea": rect(PRIMARY.work_area) }));
    assert_eq!(boxed, point(clamp_pet_position(at, PetSize { width: 384.0, height: 336.0 }, PRIMARY.work_area)));
    let sprite = PetRect { x: 900.0, y: 700.0, width: 56.0, height: 56.0 };
    let anchor = ask(json!({ "op": "hereAnchor", "point": point(at), "sprite": rect(sprite), "content": rect(CONTENT) }));
    let expected = pet_here_anchor(at, sprite, CONTENT);
    assert_eq!(anchor, serde_json::to_value(&expected).unwrap());
    assert_eq!(ask(json!({ "op": "herePosition", "anchor": anchor, "content": rect(CONTENT) })), point(pet_here_position(&expected, CONTENT)));
    let displays = json!([{ "id": 1, "workArea": rect(PRIMARY.work_area) }, { "id": 2, "workArea": rect(SECOND.work_area) }]);
    assert_eq!(ask(json!({ "op": "displayFor", "point": { "x": 2100.0, "y": 100.0 }, "size": { "width": 512.0, "height": 336.0 }, "displays": displays })), json!(2));
    assert_eq!(ask(json!({ "op": "displayFor", "point": { "x": 0.0, "y": 0.0 }, "size": { "width": 512.0, "height": 336.0 }, "displays": [] })), Value::Null);
    let prefs = serde_json::to_value(default_prefs()).unwrap();
    let on = ask(json!({ "op": "positionOn", "display": { "id": 1, "workArea": rect(PRIMARY.work_area) }, "prefs": prefs, "scale": 100 }));
    assert_eq!(on, point(pet_position_on(&PRIMARY, &default_prefs(), &size(100))));
}
