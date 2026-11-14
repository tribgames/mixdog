//! The rendition-aware reads of the media store (`src/runtime/media/store.mjs`): `resolveMediaFile`
//! and `readMediaAsset` with a `variant`, `cacheMediaThumbnail`, and the warm-up after a save.
//! Each answers the JSON value Node answers; `Value::Null` is Node's `null`.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_exthost::RenditionVariant;
use mixdog_protocol::ThreadId;
use serde_json::{Value, json};

use super::renditions::{Priority, Request, RenditionError, StillRenditions};
use super::store::{Located, MediaError, MediaStore};

const MAX_CACHED_THUMBNAIL_BYTES: usize = 4 * 1024 * 1024;

impl From<RenditionError> for MediaError {
    fn from(error: RenditionError) -> Self {
        Self::Rendition(error.to_string())
    }
}

fn str_of<'a>(entry: &'a Value, key: &str) -> &'a str {
    entry.get(key).and_then(Value::as_str).unwrap_or("")
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `{ generate = true }`: only an absent option defaults.
fn flag(options: &Value, key: &str, default: bool) -> bool {
    options.get(key).map_or(default, truthy)
}

/// `renditionSpec`: the variant a name selects, `None` for anything else.
fn variant_of(name: &str) -> Option<RenditionVariant> {
    match name {
        "thumb" => Some(RenditionVariant::Thumb),
        "display" => Some(RenditionVariant::Display),
        _ => None,
    }
}

/// `resolveMediaFile(id, { variant = 'original', generate = true })`: the asset (or one of its
/// renditions) as a file. A host that cannot build the rendition answers `available: false` with
/// no path, never the original.
pub async fn resolve_media_file(store: &Arc<MediaStore>, renditions: &StillRenditions, thread: &ThreadId, id: &str, options: Value) -> Result<Value, MediaError> {
    let owned = id.to_owned();
    let Some(Located::Readable(mut entry)) = store.run(move |s| s.locate_file(&owned)).await?? else { return Ok(Value::Null) };
    let name = options.get("variant").map_or_else(|| "original".to_owned(), mixdog_js::value_to_string);
    if name == "original" {
        return Ok(entry);
    }
    let Some(variant) = variant_of(&name) else { return Err(MediaError::Invalid(format!("unknown media variant: {name}"))) };
    let request = Request {
        thread: thread.clone(),
        id: str_of(&entry, "id").to_owned(),
        video: str_of(&entry, "kind") == "video",
        source: PathBuf::from(str_of(&entry, "path")),
        variant,
        priority: Priority::Foreground,
        generate: flag(&options, "generate", true),
    };
    entry["variant"] = json!(name);
    let Some(rendition) = renditions.ensure_request(request).await? else {
        entry["path"] = json!("");
        entry["available"] = json!(false);
        return Ok(entry);
    };
    if let Some(seconds) = rendition.duration_seconds {
        // A duration probed while building the poster, kept so the gallery badge survives a restart.
        let owned = str_of(&entry, "id").to_owned();
        store.run(move |s| s.remember_duration(&owned, seconds)).await??;
        entry["durationSeconds"] = json!(seconds);
    }
    entry["path"] = json!(rendition.path.to_string_lossy());
    entry["mime"] = json!(rendition.mime);
    entry["bytes"] = json!(rendition.bytes);
    entry["available"] = json!(true);
    Ok(entry)
}

/// `readMediaAsset(id, { variant, allowOriginal = false, generate = true })`: the same file with
/// its base64. A rendition that cannot be built is empty unless the caller allows the original,
/// which then comes back marked `downgraded`.
pub async fn read_media_asset(store: &Arc<MediaStore>, renditions: &StillRenditions, thread: &ThreadId, id: &str, options: Value) -> Result<Value, MediaError> {
    let allow_original = flag(&options, "allowOriginal", false);
    let mut file = resolve_media_file(store, renditions, thread, id, options).await?;
    if file.is_null() {
        return Ok(Value::Null);
    }
    let available = file.get("available").and_then(Value::as_bool) == Some(true);
    if available {
        let path = PathBuf::from(str_of(&file, "path"));
        file["base64"] = json!(inline(store, path).await?);
        return Ok(file);
    }
    if !allow_original {
        file["base64"] = json!("");
        return Ok(file);
    }
    let mut original = resolve_media_file(store, renditions, thread, id, json!({"variant": "original"})).await?;
    if original.is_null() {
        return Ok(Value::Null);
    }
    original["downgraded"] = json!(true);
    let path = PathBuf::from(str_of(&original, "path"));
    original["base64"] = json!(inline(store, path).await?);
    Ok(original)
}

async fn inline(store: &Arc<MediaStore>, path: PathBuf) -> Result<String, MediaError> {
    store.run(move |_| MediaStore::inline_base64(&path)).await?
}

/// `Buffer.from(text, 'base64')`: both alphabets, characters outside them skipped, `=` ends it.
fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut count) = (0u32, 0u32);
    for c in text.chars() {
        let sextet = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        bits = (bits << 6) | sextet;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            (bits, count) = (0, 0);
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => {}
    }
    out
}

/// `cacheMediaThumbnail(id, { base64, mime, durationSeconds })`: keeps a bounded thumbnail made by
/// Chromium when the native codecs miss. Null for an unknown asset; `available: false` when the
/// payload is missing, too big, or of a type the cache does not hold.
pub async fn cache_media_thumbnail(store: &Arc<MediaStore>, renditions: &StillRenditions, id: &str, input: Value) -> Result<Value, MediaError> {
    // The payload checks need nothing of the asset, so they run first.
    let prepared = Thumbnail::of(&input);
    drop(input);
    let owned = id.to_owned();
    let Some(entry) = store.run(move |s| s.get_asset(&owned)).await?? else { return Ok(Value::Null) };
    let unavailable = json!({"id": id, "available": false});
    let Some(Thumbnail { buffer, mime, seconds }) = prepared else { return Ok(unavailable) };
    let entry_id = str_of(&entry, "id").to_owned();
    let Some(rendition) = renditions.cache(&entry_id, RenditionVariant::Thumb, &mime, buffer).await? else { return Ok(unavailable) };
    if seconds != 0 {
        store.run(move |s| s.remember_duration(&entry_id, seconds)).await??;
    }
    let mut out = json!({"id": id, "available": true, "variant": "thumb", "mime": rendition.mime, "bytes": rendition.bytes});
    if seconds != 0 {
        out["durationSeconds"] = json!(seconds);
    }
    Ok(out)
}

/// A thumbnail payload that passed the size checks.
struct Thumbnail {
    buffer: Vec<u8>,
    mime: String,
    seconds: i64,
}

impl Thumbnail {
    fn of(input: &Value) -> Option<Self> {
        let text = input.get("base64").and_then(Value::as_str).unwrap_or("");
        if text.is_empty() || mixdog_js::utf16_len(text) > (MAX_CACHED_THUMBNAIL_BYTES * 4).div_ceil(3) + 8 {
            return None;
        }
        let buffer = node_base64(text);
        if buffer.is_empty() || buffer.len() > MAX_CACHED_THUMBNAIL_BYTES {
            return None;
        }
        let mime = match input.get("mime") {
            Some(mime) if truthy(mime) => mixdog_js::value_to_string(mime),
            _ => "image/jpeg".to_owned(),
        }
        .to_lowercase();
        // `Math.max(0, Math.round(Number(x) || 0))`
        let number = mixdog_js::to_number_of(input.get("durationSeconds"));
        let seconds = if number.is_finite() { (number + 0.5).floor().max(0.0) as i64 } else { 0 };
        Some(Self { buffer, mime, seconds })
    }
}

/// The warm-up after a save: the first gallery paint should not be the one that pays for the
/// tile, so it is built now, in the background, off the caller's path.
pub fn prewarm(store: Arc<MediaStore>, renditions: StillRenditions, id: String, video: bool) {
    tokio::spawn(async move {
        let owned = id.clone();
        let Ok(Ok(Some(source))) = store.run(move |s| s.asset_path(&owned)).await else { return };
        let request = Request { thread: ThreadId("media".to_owned()), id, video, source, variant: RenditionVariant::Thumb, priority: Priority::Background, generate: true };
        drop(renditions.ensure_request(request).await);
    });
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use mixdog_exthost::ExtImageCodec;
    use serde_json::Map;

    use super::super::renditions::tests::{Host, scripted, webp};
    use super::*;

    struct Rig {
        _dir: tempfile::TempDir,
        store: Arc<MediaStore>,
        renditions: StillRenditions,
        host: Arc<Host>,
        thread: ThreadId,
    }

    fn rig(answer: Result<Value, mixdog_core_api::domain::ext::ExtError>) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let lane = mixdog_rt::testing::tokens().durability_io;
        let store = Arc::new(MediaStore::new(dir.path(), lane));
        let host = scripted(answer, Duration::ZERO);
        let renditions = StillRenditions::new(Arc::new(ExtImageCodec::new(host.clone())), lane, store.renditions_dir());
        Rig { _dir: dir, store, renditions, host, thread: ThreadId("t".to_owned()) }
    }

    async fn save(rig: &Rig, kind: &str) -> String {
        let (kind, mime) = (kind.to_owned(), if kind == "video" { "video/mp4" } else { "image/png" });
        let saved = rig.store.run(move |s| s.save_asset(&kind, "gemini", "m", "p", json!({}), mime, b"original bytes", Map::new())).await.unwrap().unwrap();
        saved["id"].as_str().unwrap().to_owned()
    }

    async fn resolve(rig: &Rig, id: &str, options: Value) -> Result<Value, MediaError> {
        resolve_media_file(&rig.store, &rig.renditions, &rig.thread, id, options).await
    }

    #[tokio::test]
    async fn resolving_a_variant_gives_the_rendition_file_or_says_it_is_unavailable() {
        let rig = rig(webp("AQID"));
        let id = save(&rig, "image").await;
        let original = resolve(&rig, &id, json!({})).await.unwrap();
        assert_eq!((original["variant"].as_str(), original["available"].as_bool(), original["mime"].as_str()), (Some("original"), Some(true), Some("image/png")));
        let thumb = resolve(&rig, &id, json!({"variant": "thumb"})).await.unwrap();
        assert_eq!((thumb["variant"].as_str(), thumb["available"].as_bool(), thumb["mime"].as_str(), thumb["bytes"].as_u64()), (Some("thumb"), Some(true), Some("image/webp"), Some(3)));
        assert_eq!(std::fs::read(thumb["path"].as_str().unwrap()).unwrap(), [1, 2, 3]);
        assert_eq!(thumb["path"].as_str().map(|p| p.replace('\\', "/")).unwrap().rsplit_once("/renditions/").map(|(_, tail)| tail.to_owned()), Some(format!("thumb/{id}.webp")));
        assert_eq!(rig.host.calls.lock().unwrap().len(), 1);
        // Not generating serves the cache and nothing else: the display size is not there.
        let display = resolve(&rig, &id, json!({"variant": "display", "generate": false})).await.unwrap();
        assert_eq!((display["variant"].as_str(), display["path"].as_str(), display["available"].as_bool(), display["mime"].as_str()), (Some("display"), Some(""), Some(false), Some("image/png")));
        assert_eq!(rig.host.calls.lock().unwrap().len(), 1);
        // `generate: 0` is falsy too; the cached size is still served.
        assert_eq!(resolve(&rig, &id, json!({"variant": "thumb", "generate": 0})).await.unwrap()["available"], json!(true));
        // Unknown asset: null. Unknown variant: Node's error text, whatever was given.
        assert_eq!(resolve(&rig, "nope", json!({"variant": "thumb"})).await.unwrap(), Value::Null);
        for (given, shown) in [(json!("huge"), "huge"), (json!(null), "null"), (json!(5), "5"), (json!(""), "")] {
            let error = resolve(&rig, &id, json!({"variant": given})).await.unwrap_err();
            assert!(matches!(&error, MediaError::Invalid(m) if *m == format!("unknown media variant: {shown}")), "{error:?}");
        }
    }

    #[tokio::test]
    async fn a_rendition_the_host_cannot_make_is_unavailable_and_a_video_has_no_still_step() {
        let none = rig(Ok(json!({"ok": null})));
        let id = save(&none, "image").await;
        let thumb = resolve(&none, &id, json!({"variant": "thumb"})).await.unwrap();
        assert_eq!((thumb["path"].as_str(), thumb["available"].as_bool()), (Some(""), Some(false)));
        let video = save(&none, "video").await;
        let calls = none.host.calls.lock().unwrap().len();
        let poster = resolve(&none, &video, json!({"variant": "thumb"})).await.unwrap();
        assert_eq!(poster["available"].as_bool(), Some(false));
        assert_eq!(none.host.calls.lock().unwrap().len(), calls, "a poster is ffmpeg's, never the image host's");
        // A host that cannot answer is an error, not "unavailable".
        let down = rig(Err(mixdog_core_api::domain::ext::ExtError::Overloaded));
        let id = save(&down, "image").await;
        let error = resolve(&down, &id, json!({"variant": "thumb"})).await.unwrap_err();
        assert!(matches!(error, MediaError::Rendition(_)), "{error:?}");
        assert_eq!(error.code(), "renditionFailed");
    }

    #[tokio::test]
    async fn reading_a_variant_inlines_it_and_the_original_only_when_allowed() {
        let rig = rig(webp("AQID"));
        let id = save(&rig, "image").await;
        let read = |options: Value| {
            let (store, renditions, thread, id) = (rig.store.clone(), rig.renditions.clone(), rig.thread.clone(), id.clone());
            async move { read_media_asset(&store, &renditions, &thread, &id, options).await.unwrap() }
        };
        assert_eq!(read(json!({"variant": "thumb"})).await["base64"], json!("AQID"));
        assert_eq!(read(json!({})).await["base64"], json!("b3JpZ2luYWwgYnl0ZXM="));
        assert_eq!(read(json!({"variant": "display", "generate": false})).await["base64"], json!(""));
        let downgraded = read(json!({"variant": "display", "generate": false, "allowOriginal": true})).await;
        assert_eq!((downgraded["downgraded"].as_bool(), downgraded["variant"].as_str(), downgraded["base64"].as_str()), (Some(true), Some("original"), Some("b3JpZ2luYWwgYnl0ZXM=")));
        assert_eq!(read_media_asset(&rig.store, &rig.renditions, &rig.thread, "nope", json!({})).await.unwrap(), Value::Null);
    }

    #[tokio::test]
    async fn a_browser_made_thumbnail_is_cached_with_its_duration_and_refused_when_unusable() {
        let rig = rig(webp("AQID"));
        let id = save(&rig, "video").await;
        let cache = |input: Value| {
            let (store, renditions, id) = (rig.store.clone(), rig.renditions.clone(), id.clone());
            async move { cache_media_thumbnail(&store, &renditions, &id, input).await.unwrap() }
        };
        assert_eq!(cache_media_thumbnail(&rig.store, &rig.renditions, "nope", json!({"base64": "AQID"})).await.unwrap(), Value::Null);
        let kept = cache(json!({"base64": "AQID", "mime": "IMAGE/WEBP", "durationSeconds": 3.5})).await;
        assert_eq!(kept, json!({"id": id, "available": true, "variant": "thumb", "mime": "image/webp", "bytes": 3, "durationSeconds": 4}));
        let stored = rig.store.run({ let id = id.clone(); move |s| s.get_asset(&id) }).await.unwrap().unwrap().unwrap();
        assert_eq!(stored["durationSeconds"], json!(4));
        // No mime means jpeg; a duration that is no number is no duration.
        let jpeg = cache(json!({"base64": "AQID", "durationSeconds": "soon"})).await;
        assert_eq!(jpeg, json!({"id": id, "available": true, "variant": "thumb", "mime": "image/jpeg", "bytes": 3}));
        let refused = json!({"id": id, "available": false});
        for input in [json!({}), json!(null), json!({"base64": ""}), json!({"base64": "!!!"}), json!({"base64": "AQID", "mime": "image/gif"}), json!({"base64": 5})] {
            assert_eq!(cache(input.clone()).await, refused, "{input}");
        }
        // A payload over the 4 MiB cap is refused before it is decoded.
        assert_eq!(cache(json!({"base64": "A".repeat(5_600_000)})).await, refused);
        assert_eq!(rig.host.calls.lock().unwrap().len(), 0, "a browser thumbnail never asks the host");
    }

    #[tokio::test]
    async fn deleting_an_asset_removes_its_renditions() {
        let rig = rig(webp("AQID"));
        let (keep, drop_one) = (save(&rig, "image").await, save(&rig, "image").await);
        let mut paths = Vec::new();
        for id in [&keep, &drop_one] {
            for variant in ["thumb", "display"] {
                let file = resolve(&rig, id, json!({"variant": variant})).await.unwrap();
                paths.push((id.clone(), std::path::PathBuf::from(file["path"].as_str().unwrap())));
            }
        }
        assert!(paths.iter().all(|(_, p)| p.exists()));
        let owned = drop_one.clone();
        rig.store.run(move |s| s.delete_asset(&owned)).await.unwrap().unwrap();
        for (id, path) in &paths {
            assert_eq!(path.exists(), *id == keep, "{}", path.display());
        }
        // Bulk deletion cleans up the same way.
        rig.store.run(|s| s.delete_assets(&json!({"all": true}))).await.unwrap().unwrap();
        assert!(paths.iter().all(|(_, p)| !p.exists()));
    }

    #[tokio::test]
    async fn a_saved_asset_gets_its_tile_built_in_the_background() {
        let rig = rig(webp("AQID"));
        let id = save(&rig, "image").await;
        prewarm(rig.store.clone(), rig.renditions.clone(), id.clone(), false);
        let tile = rig.store.renditions_dir().join("thumb").join(format!("{id}.webp"));
        for _ in 0..100 {
            if tile.exists() {
                break;
            }
            mixdog_rt::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(std::fs::read(&tile).unwrap(), [1, 2, 3]);
    }

    #[test]
    fn base64_decodes_as_node_does() {
        // Expected values are Node's `[...Buffer.from(text, 'base64')]`.
        for (text, expected) in [
            ("AQID", vec![1, 2, 3]),
            ("AQ", vec![1]),
            ("AQ==xx", vec![1]),
            ("A Q I D\n", vec![1, 2, 3]),
            ("-_-_", vec![251, 255, 191]),
            ("A", vec![]),
            ("AQI", vec![1, 2]),
            ("!!AQID", vec![1, 2, 3]),
            ("AQ=ID", vec![1]),
        ] {
            assert_eq!(node_base64(text), expected, "{text:?}");
        }
    }
}
