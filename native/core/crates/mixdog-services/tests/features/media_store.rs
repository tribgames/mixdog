//! The media store on a real data folder: where an asset is filed, how the catalog pages, what is remembered about a clip, and
//! what becomes of a damaged boards or catalog file.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use mixdog_services::media::store::{Marks, MediaError, MediaStore};
use serde_json::{Map, Value, json};

struct Rig {
    dir: tempfile::TempDir,
    store: MediaStore,
    clock: Arc<AtomicI64>,
}

/// 2030-03-04 12:00 UTC.
const NOON: i64 = 1_898_078_400_000;

fn rig() -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(AtomicI64::new(NOON));
    let counter = Arc::new(AtomicU64::new(0));
    let (now, ids) = (clock.clone(), counter);
    let marks = Marks { now: Arc::new(move || now.load(Ordering::SeqCst)), id: Arc::new(move || format!("id-{}", ids.fetch_add(1, Ordering::SeqCst) + 1)) };
    let store = MediaStore::with_marks(dir.path(), mixdog_rt::testing::tokens().durability_io, marks);
    Rig { dir, store, clock }
}

impl Rig {
    fn save(&self, kind: &str, lane: &str, model: &str, mime: &str) -> Value {
        self.clock.fetch_add(1, Ordering::SeqCst);
        self.store.save_asset(kind, lane, model, "a prompt", json!({"aspectRatio": "1:1"}), mime, b"bytes", Map::new()).unwrap()
    }

    fn media(&self) -> PathBuf {
        self.dir.path().join("media")
    }

    fn assets(&self) -> Vec<Value> {
        self.store.list_assets(Some(200.0), None, None, "").unwrap()["assets"].as_array().unwrap().clone()
    }
}

fn id(entry: &Value) -> &str {
    entry["id"].as_str().unwrap()
}

#[test]
fn an_asset_is_filed_by_kind_provider_model_and_day_under_its_own_id_with_the_extension_of_its_mime() {
    let r = rig();
    let image = r.save("image", "gemini", "gemini-2.5-flash-image", "image/png");
    assert_eq!(image["id"], "id-1");
    let file = image["file"].as_str().unwrap();
    assert!(file.starts_with("images/gemini/gemini-2.5-flash-image/") && file.ends_with("/id-1.png"), "{file}");
    let day = file.split('/').nth(3).unwrap();
    assert_eq!(day.len(), 10, "a date folder: {day}");
    let written = r.media().join("assets").join(file);
    assert_eq!(std::fs::read(&written).unwrap(), b"bytes");
    let clip = r.save("video", "xai", "grok/imagine", "video/mp4");
    assert!(clip["file"].as_str().unwrap().starts_with("videos/xai/grok-imagine/") && clip["file"].as_str().unwrap().ends_with(".mp4"), "{clip}");
    assert!(r.save("image", "xai", "m", "image/jpeg")["file"].as_str().unwrap().ends_with(".jpg"));
    assert!(r.save("image", "xai", "m", "image/webp")["file"].as_str().unwrap().ends_with(".webp"));
    assert!(r.save("image", "xai", "m", "application/x-other")["file"].as_str().unwrap().ends_with(".bin"));
    assert_eq!((image["bytes"].clone(), image["kind"].clone(), image["options"].clone()), (json!(5), json!("image"), json!({"aspectRatio": "1:1"})));
}

#[test]
fn a_folder_name_never_holds_a_path_separator_a_reserved_name_or_a_dot_at_its_end() {
    let r = rig();
    let odd = r.save("image", "a/b\\c:d", "con", "image/png");
    assert!(odd["file"].as_str().unwrap().starts_with("images/a-b-c-d/unknown-model/"), "{odd}");
    let dotted = r.save("image", "  prov.  ", "COM3", "image/png");
    assert!(dotted["file"].as_str().unwrap().starts_with("images/prov/unknown-model/"), "{dotted}");
    let blank = r.save("image", "", "com0", "image/png");
    assert!(blank["file"].as_str().unwrap().starts_with("images/unknown-provider/com0/"), "{blank}");
    assert!(r.assets().iter().all(|a| !a["file"].as_str().unwrap().contains("..")));
}

#[test]
fn a_prompt_is_kept_only_to_four_thousand_characters_and_the_caller_may_add_fields() {
    let r = rig();
    let mut meta = Map::new();
    meta.insert("durationSeconds".into(), json!(6));
    let saved = r.store.save_asset("video", "xai", "m", &"x".repeat(5000), json!({}), "video/mp4", b"v", meta).unwrap();
    assert_eq!(saved["prompt"].as_str().map(str::len), Some(4000));
    assert_eq!(saved["durationSeconds"], 6);
}

#[test]
fn the_catalog_pages_newest_first_with_a_default_of_sixty_and_a_ceiling_of_two_hundred() {
    let r = rig();
    for _ in 0..5 {
        r.save("image", "gemini", "m", "image/png");
    }
    let first = r.store.list_assets(Some(2.0), None, None, "").unwrap();
    assert_eq!((first["total"].clone(), first["assets"][0]["id"].clone(), first["assets"][1]["id"].clone()), (json!(5), json!("id-5"), json!("id-4")));
    let second = r.store.list_assets(Some(2.0), Some(2.0), None, "").unwrap();
    assert_eq!((second["assets"][0]["id"].clone(), second["assets"].as_array().unwrap().len()), (json!("id-3"), 2));
    let tail = r.store.list_assets(Some(2.0), Some(4.0), None, "").unwrap();
    assert_eq!(tail["assets"].as_array().unwrap().len(), 1);
    assert_eq!(r.store.list_assets(None, None, None, "").unwrap()["assets"].as_array().unwrap().len(), 5);
    assert_eq!(
        r.store.list_assets(Some(0.0), Some(-3.0), None, "").unwrap()["assets"].as_array().unwrap().len(),
        5,
        "no limit is the default one, a negative offset the start"
    );
    assert_eq!(r.store.list_assets(Some(500.0), None, None, "").unwrap()["assets"].as_array().unwrap().len(), 5);
    assert_eq!(r.store.list_assets(Some(-5.0), None, None, "").unwrap()["assets"].as_array().unwrap().len(), 1, "a negative limit is one");
    assert_eq!(r.store.list_assets(None, None, Some("video"), "").unwrap()["total"], 0);
}

#[test]
fn a_probed_duration_is_remembered_once_and_zero_or_a_repeat_writes_nothing() {
    let r = rig();
    let clip = r.save("video", "xai", "m", "video/mp4");
    let index = r.media().join("index.json");
    r.store.remember_duration(id(&clip), 0).unwrap();
    assert!(r.assets()[0].get("durationSeconds").is_none());
    r.store.remember_duration(id(&clip), 7).unwrap();
    assert_eq!(r.assets()[0]["durationSeconds"], 7);
    let after = std::fs::read(&index).unwrap();
    r.store.remember_duration(id(&clip), 7).unwrap();
    r.store.remember_duration("unknown", 9).unwrap();
    assert_eq!(std::fs::read(&index).unwrap(), after, "nothing is rewritten for the same duration or an unknown asset");
    r.store.remember_duration(id(&clip), 9).unwrap();
    assert_eq!(r.assets()[0]["durationSeconds"], 9);
}

#[cfg(unix)]
#[test]
fn a_duration_that_cannot_be_written_fails_and_leaves_the_catalog_as_it_was() {
    use std::os::unix::fs::PermissionsExt;
    let r = rig();
    let clip = r.save("video", "xai", "m", "video/mp4");
    let media = r.media();
    std::fs::set_permissions(&media, std::fs::Permissions::from_mode(0o500)).unwrap();
    let outcome = r.store.remember_duration(id(&clip), 7);
    std::fs::set_permissions(&media, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(outcome.is_err());
    assert!(r.assets()[0].get("durationSeconds").is_none(), "the cached catalog is not ahead of the disk");
}

#[test]
fn a_catalog_file_of_nul_bytes_is_set_aside_and_the_last_good_one_comes_back() {
    let r = rig();
    r.save("image", "gemini", "m", "image/png");
    r.save("image", "gemini", "m", "image/png");
    let index = r.media().join("index.json");
    std::fs::write(&index, vec![0u8; 64]).unwrap();
    let fresh = MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io);
    let page = fresh.list_assets(None, None, None, "").unwrap();
    assert_eq!(page["total"], 1, "the backup holds the catalog as it was before the last save");
    let aside: Vec<String> = std::fs::read_dir(r.media())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("index.json.corrupt-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
}

#[test]
fn a_catalog_with_no_good_backup_starts_empty_after_setting_the_damaged_one_aside() {
    let r = rig();
    std::fs::create_dir_all(r.media()).unwrap();
    std::fs::write(r.media().join("index.json"), b"{not json").unwrap();
    assert_eq!(r.store.list_assets(None, None, None, "").unwrap()["total"], 0);
    assert!(std::fs::read_dir(r.media()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("index.json.corrupt-")));
    let saved = r.save("image", "gemini", "m", "image/png");
    assert_eq!(r.assets().iter().map(|a| id(a).to_owned()).collect::<Vec<_>>(), vec![id(&saved).to_owned()]);
    std::fs::write(r.media().join("index.json"), json!({"version": 2, "assets": "nope"}).to_string()).unwrap();
    assert_eq!(
        MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io).list_assets(None, None, None, "").unwrap()["total"],
        0,
        "a catalog that is not a list is damaged too"
    );
}

#[test]
fn boards_are_named_listed_newest_first_with_their_counts_and_persist_across_stores() {
    let r = rig();
    let first = r.store.create_board(Some(&json!("  Spring   shots "))).unwrap();
    r.clock.fetch_add(10, Ordering::SeqCst);
    let second = r.store.create_board(Some(&json!("Summer"))).unwrap();
    assert_eq!((first["name"].clone(), second["id"].clone()), (json!("Spring shots"), json!("id-2")));
    let a = r.save("image", "gemini", "m", "image/png");
    assert_eq!(r.store.set_asset_board(&json!(id(&a)), &first["id"]).unwrap(), json!({"ids": ["id-3"], "boardId": "id-1"}));
    assert_eq!(r.store.set_asset_board(&json!([id(&a)]), &first["id"]).unwrap()["ids"], json!([]), "already there");
    let reopened = MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io);
    let boards = reopened.list_boards().unwrap();
    assert_eq!(boards["boards"][0]["name"], "Summer", "the newest first");
    assert_eq!((boards["boards"][1]["count"].clone(), boards["boards"][0]["count"].clone(), boards["total"].clone()), (json!(1), json!(0), json!(1)));
    assert_eq!(reopened.set_asset_board(&json!([id(&a)]), &Value::Null).unwrap(), json!({"ids": ["id-3"], "boardId": ""}));
    assert_eq!(r.store.list_assets(None, None, None, "id-1").unwrap()["total"], 0);
}

#[test]
fn a_board_name_is_one_to_one_hundred_twenty_characters_and_ids_must_be_strings() {
    let r = rig();
    assert!(matches!(r.store.create_board(Some(&json!(5))), Err(MediaError::Invalid(m)) if m == "board name must be a string"));
    assert!(matches!(r.store.create_board(Some(&json!(" \n "))), Err(MediaError::Invalid(m)) if m == "board name is required"));
    assert!(matches!(r.store.create_board(None), Err(MediaError::Invalid(_))));
    let long = r.store.create_board(Some(&json!("n".repeat(300)))).unwrap();
    assert_eq!(long["name"].as_str().map(str::len), Some(120));
    assert!(matches!(r.store.rename_board(Some(&json!("missing")), Some(&json!("x"))), Err(MediaError::BoardNotFound)));
    assert!(matches!(r.store.rename_board(Some(&json!("")), Some(&json!("x"))), Err(MediaError::Invalid(m)) if m == "board id must be a string"));
    assert!(matches!(r.store.set_asset_board(&json!([5]), &Value::Null), Err(MediaError::Invalid(m)) if m == "asset ids must be strings"));
    assert_eq!(r.store.delete_board(Some(&json!("missing"))).unwrap(), json!({"id": "missing", "removed": false}));
}

#[test]
fn a_boards_file_that_is_damaged_is_set_aside_and_the_boards_start_empty() {
    let r = rig();
    r.store.create_board(Some(&json!("Keep"))).unwrap();
    let path = r.media().join("boards.json");
    std::fs::write(&path, b"\0\0\0\0").unwrap();
    let fresh = MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io);
    let restored = fresh.list_boards().unwrap();
    assert_eq!(restored["boards"].as_array().map(Vec::len), Some(0), "the backup of a first write is the empty file it replaced: nothing to restore");
    assert!(std::fs::read_dir(r.media()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("boards.json.corrupt-")));
    let again = fresh.create_board(Some(&json!("New"))).unwrap();
    assert_eq!(fresh.list_boards().unwrap()["boards"][0]["id"], again["id"]);
    std::fs::write(&path, json!({"version": 1, "boards": {"not": "a list"}}).to_string()).unwrap();
    assert_eq!(MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io).list_boards().unwrap()["boards"], json!([]));
}

#[test]
fn deleting_a_board_keeps_its_results_and_clears_their_membership() {
    let r = rig();
    let board = r.store.create_board(Some(&json!("B"))).unwrap();
    let a = r.save("image", "gemini", "m", "image/png");
    r.store.set_asset_board(&json!([id(&a)]), &board["id"]).unwrap();
    assert_eq!(r.store.delete_board(Some(&board["id"])).unwrap()["removed"], true);
    assert!(r.assets()[0].get("boardId").is_none());
    assert_eq!(r.assets().len(), 1);
}

#[test]
fn cleanup_by_age_by_missing_file_or_by_ids_takes_the_files_with_the_rows() {
    let r = rig();
    let old = r.save("image", "gemini", "m", "image/png");
    r.clock.fetch_add(10_000, Ordering::SeqCst);
    let new = r.save("video", "xai", "m", "video/mp4");
    let gone = r.save("image", "xai", "m", "image/png");
    std::fs::remove_file(r.store.asset_path(id(&gone)).unwrap().unwrap()).unwrap();
    assert_eq!(r.store.delete_assets(&json!({"missing": true, "dryRun": true})).unwrap()["ids"], json!([id(&gone)]));
    assert_eq!(r.store.delete_assets(&json!({"missing": true})).unwrap()["ids"], json!([id(&gone)]));
    let cutoff = old["createdAt"].as_i64().unwrap() + 1;
    let before = r.store.delete_assets(&json!({"before": cutoff, "kind": "image"})).unwrap();
    assert_eq!(before["ids"], json!([id(&old)]));
    assert_eq!(r.assets().len(), 1);
    assert!(r.store.asset_path(id(&new)).unwrap().is_some());
    assert_eq!(r.store.delete_assets(&json!({"ids": [id(&new), "unknown"]})).unwrap()["ids"], json!([id(&new)]));
    assert!(r.assets().is_empty());
}

#[test]
fn an_asset_name_that_leaves_the_assets_folder_resolves_to_no_file() {
    let r = rig();
    let a = r.save("image", "gemini", "m", "image/png");
    let index = r.media().join("index.json");
    let mut doc: Value = serde_json::from_slice(&std::fs::read(&index).unwrap()).unwrap();
    for escape in ["../index.json", "//server/share/x.png", "C:\\Windows\\x.png", "images/a:b.png"] {
        doc["assets"][0]["file"] = json!(escape);
        std::fs::write(&index, doc.to_string()).unwrap();
        let fresh = MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io);
        assert!(fresh.resolve_file(id(&a)).unwrap().is_none(), "{escape}");
        assert!(fresh.asset_path(id(&a)).unwrap().is_none(), "{escape}");
    }
    let _ = Path::new("");
}

#[test]
fn defaults_and_pins_survive_a_new_store_and_a_pin_remembers_its_account() {
    let r = rig();
    r.store.set_default(&json!({"kind": "image", "lane": " gemini ", "model": "m"})).unwrap();
    r.store.set_pin(&json!({"kind": "video", "lane": "xai", "model": "v", "account": "acct"})).unwrap();
    let fresh = MediaStore::new(r.dir.path(), mixdog_rt::testing::tokens().durability_io);
    assert_eq!(fresh.get_default(Some(&json!("image"))), json!({"kind": "image", "lane": "gemini", "model": "m"}));
    assert_eq!(fresh.get_pins()["video"], json!({"kind": "video", "lane": "xai", "model": "v", "account": "acct"}));
    assert_eq!(fresh.get_default(Some(&json!("audio"))), Value::Null);
    assert!(matches!(r.store.set_default(&json!({"kind": "image"})), Err(MediaError::Invalid(m)) if m == "lane is required"));
    assert!(matches!(r.store.set_pin(&json!({"kind": "audio", "lane": "x"})), Err(MediaError::Invalid(m)) if m == "kind must be one of image, video"));
    assert_eq!(MediaError::BoardNotFound.code(), "boardNotFound");
    assert_eq!(MediaError::Invalid(String::new()).code(), "invalid");
}
