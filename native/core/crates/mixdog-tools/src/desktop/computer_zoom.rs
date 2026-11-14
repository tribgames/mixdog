//! `capture mode="zoom"` over a stored frame (`observation/capture-zoom.ts`, `zoom-region.ts`, `zoom-shot.ts`).

use std::sync::Mutex;
use std::time::Instant;

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::ProcessComputerBackend;
use super::computer_backend::parts_of;
use super::computer_capture::DEFAULT_MAX_WIDTH;
use super::computer_capture::DEFAULT_QUALITY;
use super::computer_capture::MAX_MAX_WIDTH;
use super::computer_capture::MIN_MAX_WIDTH;
use super::computer_capture::bounded_integer;
use super::computer_capture::read_command;
use super::computer_command::text;
use super::computer_frames::Frame;

/// The smallest edge of a zoom region, in frame pixels (`zoomGeometry`).
const MIN_REGION_EDGE: i64 = 8;

/// A rectangle in physical screen pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
}

/// The surface the latest zoom frame was cut from (`CaptureFrame.windowX..windowHeight`, which `Frame` does not carry). Frames
/// are held one at a time, so only the latest zoom's is kept, under its id.
static ZOOM_BASE: Mutex<Option<(String, Rect)>> = Mutex::new(None);

fn stale(message: &str) -> ComputerError {
    ComputerError::Failed { code: "stale_frame".into(), message: format!("stale_frame: {message}") }
}

fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0 && f.abs() < 9e15).map(|f| f as i64))
}

/// `zoomRegionOf`: `[x0,y0,x1,y1]` in the frame's image coordinates.
fn region_of(command: &Map<String, Value>) -> Result<[i64; 4], ComputerError> {
    let invalid = || ComputerError::InvalidInput { reason: "zoom requires region [x0,y0,x1,y1] in frame_id image coordinates".into() };
    let items = command.get("region").and_then(Value::as_array).filter(|items| items.len() == 4).ok_or_else(invalid)?;
    let mut region = [0; 4];
    for (slot, item) in region.iter_mut().zip(items) {
        *slot = integer(item).ok_or_else(invalid)?;
    }
    Ok(region)
}

/// `zoomGeometry`: the region checked against the frame it names, as the physical rectangle it covers (halves round up, as `Math.round`).
fn physical_region(frame: &Frame, region: [i64; 4]) -> Result<Rect, ComputerError> {
    let [x0, y0, x1, y1] = region;
    if x0 < 0 || y0 < 0 || x1 > frame.capture_width || y1 > frame.capture_height || x1 - x0 < MIN_REGION_EDGE || y1 - y0 < MIN_REGION_EDGE {
        return Err(ComputerError::InvalidInput {
            reason: format!(
                "zoom region [x0,y0,x1,y1] must be at least 8x8 and inside frame {}x{}; received [{x0},{y0},{x1},{y1}]",
                frame.capture_width, frame.capture_height
            ),
        });
    }
    let scaled = |v: i64, physical: i64, capture: i64| (2 * v * physical + capture).div_euclid(2 * capture);
    let x = |v: i64| frame.origin_x + scaled(v, frame.physical_width, frame.capture_width);
    let y = |v: i64| frame.origin_y + scaled(v, frame.physical_height, frame.capture_height);
    Ok(Rect { x: x(x0), y: y(y0), width: x(x1) - x(x0), height: y(y1) - y(y0) })
}

/// The surface `frame` was cut from: the one its zoom recorded, else its own rectangle (a capture's frame is the whole window).
fn base_of(frame: &Frame) -> Rect {
    let recorded = ZOOM_BASE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match recorded.as_ref() {
        Some((id, base)) if *id == frame.id => *base,
        _ => Rect { x: frame.origin_x, y: frame.origin_y, width: frame.physical_width, height: frame.physical_height },
    }
}

/// The helper's `window_capture` for the crop: the region in physical screen pixels from the window's full-resolution surface.
fn crop_command(window_id: &str, region: Rect, max_width: i64, quality: i64, command: &Map<String, Value>) -> Map<String, Value> {
    let mut request = read_command("window_capture");
    request.insert("window_id".into(), json!(window_id));
    request.insert("max_width".into(), json!(max_width));
    request.insert("quality".into(), json!(quality));
    request.insert("region".into(), json!({ "x": region.x, "y": region.y, "width": region.width, "height": region.height }));
    request.insert("preserve_resolution".into(), json!(true));
    if wants_ocr(command) {
        request.insert("include_ocr".into(), json!(true));
        if let Some(language) = command.get("ocr_language").filter(|language| !language.is_null()) {
            request.insert("ocr_language".into(), language.clone());
        }
    }
    request
}

fn wants_ocr(command: &Map<String, Value>) -> bool {
    command.get("include_ocr") == Some(&Value::Bool(true))
}

/// `acquireZoomShot`: a fresh shot whose surface is not the one the frame was cut from is a stale frame, never a mis-cropped zoom.
/// The helper reports the whole surface it cut the region from as `surface {x,y,width,height}`, and the rectangle it delivered as
/// `x`, `y`, `width`, `height`.
fn check_surface(result: &Map<String, Value>, base: Rect) -> Result<(), ComputerError> {
    let surface = result.get("surface").and_then(Value::as_object);
    let edge = |key: &str| surface.and_then(|surface| surface.get(key)).and_then(integer);
    match (edge("x"), edge("y"), edge("width"), edge("height")) {
        (Some(x), Some(y), Some(width), Some(height)) if (Rect { x, y, width, height }) == base => Ok(()),
        (Some(_), Some(_), Some(_), Some(_)) => Err(stale("native capture geometry changed; capture fresh state")),
        _ => Err(stale("native capture did not report the surface it was cut from; capture fresh state")),
    }
}

/// The crop must be the region that was asked for, at its shape (`frameQualityIssue` on the zoom image): an image of another
/// rectangle never becomes a frame whose coordinates would land elsewhere.
fn check_crop(result: &Map<String, Value>, region: Rect, image: (i64, i64)) -> Result<(), ComputerError> {
    let edge = |key: &str| result.get(key).and_then(integer);
    if (edge("x"), edge("y"), edge("width"), edge("height")) != (Some(region.x), Some(region.y), Some(region.width), Some(region.height)) {
        return Err(stale("native capture did not cut the requested region; capture fresh state"));
    }
    let expected = region.width as f64 / region.height.max(1) as f64;
    let actual = image.0 as f64 / image.1.max(1) as f64;
    let error = (actual - expected).abs() / expected.max(0.0001);
    if !error.is_finite() || error > 0.05 {
        return Err(ComputerError::Failed {
            code: "coordinate_mismatch".into(),
            message: "coordinate_mismatch: capture dimensions do not match the target coordinate space".into(),
        });
    }
    Ok(())
}

/// `zoomFrame`: the crop's own frame, keeping the parent's window identity.
fn zoom_frame(parent: &Frame, id: String, region: Rect, capture: (i64, i64)) -> Frame {
    Frame {
        id,
        window_id: parent.window_id.clone(),
        related_window_ids: parent.related_window_ids.clone(),
        origin_x: region.x,
        origin_y: region.y,
        physical_width: region.width,
        physical_height: region.height,
        capture_width: capture.0,
        capture_height: capture.1,
        idle: parent.idle.clone(),
    }
}

/// `recognizeZoomText`: the crop's own text lines, whose boxes are already the zoom frame's pixels (the helper reports `ocr`).
/// Unreadable text is a reason to keep the pixels, never to fail the crop.
fn recognized_text(result: &Map<String, Value>) -> String {
    let Some(ocr) = result.get("ocr").and_then(Value::as_object) else { return "\nOCR unavailable: recognition failed".into() };
    if let Some(error) = ocr.get("error").and_then(Value::as_str).filter(|error| !error.is_empty()) {
        return format!("\nOCR unavailable: {error}");
    }
    let lines = ocr.get("lines").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    if lines.is_empty() {
        return "\nOCR recognized no text in this region.".into();
    }
    let number = |line: &Value, key: &str| line.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    let rows: Vec<String> = lines
        .iter()
        .map(|line| {
            let (x, y, width, height) = (number(line, "x"), number(line, "y"), number(line, "width"), number(line, "height"));
            format!("[{x},{y} {width}x{height}] {}", line.get("text").and_then(Value::as_str).unwrap_or_default())
        })
        .collect();
    let language = ocr.get("language").and_then(Value::as_str).unwrap_or_default();
    format!("\nOCR {} lines, language {language}; boxes are pixels in this frame:\n{}", rows.len(), rows.join("\n"))
}

/// `captureZoom`: the region of a frame the backend holds, re-captured from the window's own surface and cut out; the crop is the
/// backend's new frame.
pub(super) async fn zoom(backend: &ProcessComputerBackend, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
    let quality = bounded_integer(&command, "quality", DEFAULT_QUALITY, 0, 100, "quality")?;
    let max_width = bounded_integer(&command, "maxWidth", DEFAULT_MAX_WIDTH, MIN_MAX_WIDTH, MAX_MAX_WIDTH, "maxWidth")?;
    let region = region_of(&command)?;
    let frame_id = text(&command, "frame_id");
    let frame = backend.frames.lookup(Some(frame_id), Instant::now())?.ok_or_else(|| stale(&format!("unknown frame_id {frame_id} in this session")))?;
    let physical = physical_region(&frame, region)?;
    let Some(window_id) = frame.window_id.as_deref() else {
        return Err(stale(&format!("exact capture source is unavailable ({})", frame.id)));
    };
    let base = base_of(&frame);

    let result = backend.exchange_pixels(crop_command(window_id, physical, max_width, quality, &command), cancel).await?;
    check_surface(&result, base)?;
    let mut parts = parts_of(&result)?;
    let Some(ToolPart::Image { mime, data, width, height }) = parts.get_mut(1) else {
        return Err(ComputerError::Failed { code: "computer_failed".into(), message: format!("zoom capture returned no image ({})", frame.id) });
    };
    let edge = |key: &str| result.get(key).and_then(integer).filter(|edge| *edge > 0);
    let size = edge("image_width").zip(edge("image_height")).unwrap_or((physical.width, physical.height));
    check_crop(&result, physical, size)?;
    let bytes = if let ImageData::Bytes(bytes) = data { bytes.len() } else { 0 };
    let encoding = if mime.as_str() == "image/jpeg" { format!("JPEG quality {quality}") } else { "PNG".to_string() };
    (*width, *height) = (u32::try_from(size.0).ok(), u32::try_from(size.1).ok());

    // The crop is the session's only frame from here (`framesBySession.clear()`, `rememberFrame`).
    let zoom_id = format!("frame-{}", uuid::Uuid::new_v4().simple());
    let [x0, y0, x1, y1] = region;
    let recognized = if wants_ocr(&command) { recognized_text(&result) } else { String::new() };
    let description = format!(
        "Zoom of {} region ({x0},{y0})-({x1},{y1}) ({}x{}, {bytes} bytes, {encoding}); frame_id={zoom_id}; coordinates are pixels in this frame{recognized}",
        frame.id, size.0, size.1
    );
    *ZOOM_BASE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((zoom_id.clone(), base));
    backend.frames.clear();
    backend.frames.remember(zoom_frame(&frame, zoom_id, physical, size));
    parts[0] = ToolPart::Text(description);
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame() -> Frame {
        Frame {
            id: "frame-a".into(),
            window_id: Some("hwnd:0x3".into()),
            related_window_ids: Some(vec!["hwnd:0x3".into()]),
            origin_x: -1920,
            origin_y: 100,
            physical_width: 300,
            physical_height: 200,
            capture_width: 200,
            capture_height: 100,
            idle: None,
        }
    }

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn reason(error: ComputerError) -> String {
        match error {
            ComputerError::InvalidInput { reason } => reason,
            ComputerError::Failed { message, .. } => message,
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn a_region_maps_through_a_scaled_offset_frame() {
        // 1.5 physical pixels per frame pixel: 10 -> 15, 51 -> 76.5 rounds up to 77, 20 -> 40, 60 -> 120.
        let rect = physical_region(&frame(), [10, 20, 51, 60]).unwrap();
        assert_eq!(rect, Rect { x: -1920 + 15, y: 100 + 40, width: 77 - 15, height: 120 - 40 });
    }

    #[test]
    fn a_region_outside_the_frame_or_too_small_is_refused() {
        for region in [[-1, 0, 50, 50], [0, 0, 201, 50], [0, 0, 50, 101], [0, 0, 7, 50], [10, 10, 40, 17]] {
            let message = reason(physical_region(&frame(), region).unwrap_err());
            assert!(message.starts_with("zoom region [x0,y0,x1,y1] must be at least 8x8 and inside frame 200x100; received ["), "{message}");
        }
        assert!(region_of(&object(json!({"region":[0,0,10]}))).is_err());
        assert!(region_of(&object(json!({"region":[0,0,10.5,10]}))).is_err());
        assert_eq!(region_of(&object(json!({"region":[0,0,10.0,10]}))).unwrap(), [0, 0, 10, 10]);
    }

    #[test]
    fn the_helper_is_asked_for_the_region_at_full_resolution() {
        let rect = Rect { x: 5, y: 6, width: 70, height: 80 };
        let command = crop_command("hwnd:0x3", rect, 1280, 55, &object(json!({"include_ocr":true,"ocr_language":"en-US"})));
        assert_eq!(
            Value::Object(command),
            json!({"action":"window_capture","read_only":true,"pointer_feedback":false,"window_id":"hwnd:0x3","max_width":1280,"quality":55,
                   "region":{"x":5,"y":6,"width":70,"height":80},"preserve_resolution":true,"include_ocr":true,"ocr_language":"en-US"})
        );
        assert!(!crop_command("w", rect, 1280, 55, &Map::new()).contains_key("include_ocr"));
    }

    #[test]
    fn a_moved_surface_is_a_stale_frame() {
        let base = base_of(&frame());
        assert_eq!(base, Rect { x: -1920, y: 100, width: 300, height: 200 });
        assert!(check_surface(&object(json!({"surface":{"x":-1920,"y":100,"width":300,"height":200},"x":-1900,"width":10})), base).is_ok());
        let unreported = reason(check_surface(&object(json!({"x":-1920,"y":100,"width":300,"height":200})), base).unwrap_err());
        assert!(unreported.starts_with("stale_frame: native capture did not report the surface"), "{unreported}");
        let moved = check_surface(&object(json!({"surface":{"x":-1900,"y":100,"width":300,"height":200}})), base).unwrap_err();
        assert_eq!(moved, ComputerError::Failed { code: "stale_frame".into(), message: "stale_frame: native capture geometry changed; capture fresh state".into() });
    }

    #[test]
    fn only_the_requested_region_at_its_shape_becomes_a_frame() {
        let region = Rect { x: -1905, y: 140, width: 62, height: 80 };
        let delivered = object(json!({"x":-1905,"y":140,"width":62,"height":80}));
        assert!(check_crop(&delivered, region, (62, 80)).is_ok());
        assert!(check_crop(&delivered, region, (124, 160)).is_ok());
        // The whole window delivered under the region's geometry, and a squashed image, are both refused.
        let whole = reason(check_crop(&object(json!({"x":-1920,"y":100,"width":300,"height":200})), region, (62, 80)).unwrap_err());
        assert!(whole.starts_with("stale_frame: native capture did not cut the requested region"), "{whole}");
        let squashed = check_crop(&delivered, region, (300, 200)).unwrap_err();
        assert_eq!(squashed, ComputerError::Failed { code: "coordinate_mismatch".into(), message: "coordinate_mismatch: capture dimensions do not match the target coordinate space".into() });
    }

    #[test]
    fn the_crop_is_a_frame_of_its_own_in_the_parents_window() {
        let rect = Rect { x: -1905, y: 140, width: 62, height: 80 };
        let zoom = zoom_frame(&frame(), "frame-z".into(), rect, (124, 160));
        assert_eq!((zoom.window_id.as_deref(), zoom.origin_x, zoom.origin_y, zoom.physical_width, zoom.capture_width), (Some("hwnd:0x3"), -1905, 140, 62, 124));
        // A zoom of the zoom maps through the crop's own origin.
        let inner = physical_region(&zoom, [0, 0, 124, 160]).unwrap();
        assert_eq!((inner.x, inner.y, inner.width, inner.height), (-1905, 140, 62, 80));
    }

    #[test]
    fn recognized_lines_are_listed_in_the_frames_pixels() {
        let result = object(json!({"ocr":{"language":"en-US","lines":[{"x":1,"y":2,"width":30,"height":9,"text":"Save"}]}}));
        assert_eq!(recognized_text(&result), "\nOCR 1 lines, language en-US; boxes are pixels in this frame:\n[1,2 30x9] Save");
        assert_eq!(recognized_text(&object(json!({"ocr":{"lines":[]}}))), "\nOCR recognized no text in this region.");
        assert_eq!(recognized_text(&object(json!({"ocr":{"error":"no engine"}}))), "\nOCR unavailable: no engine");
    }
}
