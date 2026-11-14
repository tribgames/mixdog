//! The pixels of a display, read from the desktop's computer host (`host/computer/pixels`, which answers a blob reference) and issued as a
//! frame a click or a zoom can name (`observation/screenshot-target.ts` `displayScreenshotTarget`, `observation/screenshot-frame.ts`).
//! `host/computer/displays` is the display list the capture and the frames' validity (`session/frame-validity.ts`) are judged against.

use async_trait::async_trait;
use mixdog_app_protocol::v2::host::HostComputerDisplay;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::Method;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::REPORTED_CODE;
use super::computer_capture::DEFAULT_MAX_WIDTH;
use super::computer_capture::DEFAULT_QUALITY;
use super::computer_capture::MAX_ELEMENTS;
use super::computer_capture::MAX_MAX_WIDTH;
use super::computer_capture::OTHER_MAX_ELEMENTS;
use super::computer_capture::STATE_MAX_ELEMENTS;
use super::computer_capture::MIN_MAX_WIDTH;
use super::computer_capture::bounded_integer;
use super::computer_frames::DisplaySource;
use super::computer_frames::Frame;
use super::computer_frames::FrameStore;
use super::computer_ocr;

const PIXELS: &str = "host/computer/pixels";
const DISPLAYS: &str = "host/computer/displays";
/// `client.mjs` `BRIDGE_UNAVAILABLE_MESSAGE`: what the model reads when no desktop serves the computer host.
const UNAVAILABLE_MESSAGE: &str = "computer use is unavailable; open the Mixdog desktop app and enable Computer Use in settings";
/// JSON-RPC's "method not found": a desktop older than `host/computer/pixels`.
const METHOD_NOT_FOUND: i64 = -32601;
/// How far a capture's shape may differ from the rectangle it shows (`frameQualityIssue`).
const SHAPE_TOLERANCE: f64 = 0.05;

/// The core's blob store as a computer capture reads it: the bytes the desktop uploaded with `blob/put`, by their `sha256:` digest.
#[async_trait]
pub trait ComputerBlobs: Send + Sync {
    async fn read(&self, digest: &str) -> Result<Vec<u8>, ComputerError>;
}

/// The text recognizer a capture of pixels asks (the helper's `ocr_image`): the pixels carry no recognition of their own. Implemented
/// by the caller over its helper pool; its answer is the helper's result (`language`, `words`, `lines`, `total_words`,
/// `truncated_words`, boxes in the pixels of the image it was given), and its failure is the reason the recognition could not be made.
#[async_trait]
pub trait DisplayOcr: Send + Sync {
    async fn recognize(&self, image: &[u8], language: Option<&str>, limit: i64, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError>;
}

/// `recognizeCaptureOcr` over one display capture: the recognizer's answer shaped as a window capture's `ocr` member, which
/// `computer_ocr::augment` and the zoom's text read. A cancelled capture stays cancelled; any other failure is the reply's `error`.
pub(super) async fn recognize(
    ocr: Option<&dyn DisplayOcr>,
    image: &[u8],
    language: Option<&str>,
    limit: i64,
    cancel: &CancellationToken,
) -> Result<Map<String, Value>, ComputerError> {
    let Some(ocr) = ocr else { return Ok(Map::new()) };
    let reply = match ocr.recognize(image, language, limit, cancel).await {
        Ok(reply) => Value::Object(reply),
        Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
        Err(ComputerError::Failed { message, .. }) => json!({ "ok": false, "error": message }),
        Err(ComputerError::InvalidInput { reason } | ComputerError::Unavailable { reason }) => json!({ "ok": false, "error": reason }),
        Err(other) => json!({ "ok": false, "error": format!("{other:?}") }),
    };
    Ok(Map::from_iter([("ocr".to_owned(), reply)]))
}

/// What `host/computer/pixels` answers (`result`): the uploaded image, its size, and the surface it shows.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PixelsReply {
    blob: BlobRef,
    capture_width: i64,
    capture_height: i64,
    source: Source,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobRef {
    digest: String,
    byte_length: u64,
    mime_type: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    x: i64,
    y: i64,
    width: i64,
    height: i64,
    scale_factor: f64,
    #[serde(default)]
    display_id: Option<String>,
}

/// One display capture read back from its blob.
pub(super) struct Pixels {
    pub(super) bytes: Vec<u8>,
    pub(super) mime: String,
    pub(super) capture: (i64, i64),
    /// The rectangle the pixels show, in physical pixels, and the display's scale.
    pub(super) source: DisplaySource,
}

fn invalid_reply(reason: &str) -> ComputerError {
    ComputerError::Failed { code: "computer_invalid_reply".into(), message: format!("computer host returned an invalid capture: {reason}") }
}

/// One `host/computer/*` request to the desktop's computer host, its refusal as the model reads it (as the capture bridge's client
/// words it): no desktop serving, a request that outlives the client's timeout, the host's own error (its `data.code` when it names
/// one). A desktop without the method is `Unavailable`, which the caller may answer by another route.
async fn ask(desktop: &dyn HostChannel, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, ComputerError> {
    let unavailable = || ComputerError::Failed { code: REPORTED_CODE.into(), message: format!("Error: {UNAVAILABLE_MESSAGE}") };
    if !desktop.serves(HostCapability::Computer) {
        return Err(unavailable());
    }
    match desktop.request_scoped(HostCapability::Computer, Method(method), params, cancel).await {
        Ok(value) => Ok(value),
        Err(_) if cancel.is_cancelled() => Err(ComputerError::Cancelled),
        Err(HostError::Rpc { code: METHOD_NOT_FOUND, .. }) => Err(ComputerError::Unavailable { reason: format!("{method} is not served by this desktop") }),
        Err(HostError::Rpc { message, data, .. }) => {
            let code = data.as_ref().and_then(|data| data.get("code")).and_then(Value::as_str).filter(|code| !code.is_empty());
            Err(ComputerError::Failed { code: code.unwrap_or("computer_failed").to_owned(), message })
        }
        Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if &*detail == "timedOut" => {
            Err(ComputerError::Failed { code: REPORTED_CODE.into(), message: "Error: computer bridge timed out".into() })
        }
        Err(HostError::Core(_)) => Err(unavailable()),
    }
}

/// `host/computer/displays`: the attached displays, in the host's order.
pub(super) async fn read_displays(desktop: &dyn HostChannel, cancel: &CancellationToken) -> Result<Vec<HostComputerDisplay>, ComputerError> {
    serde_json::from_value(read_display_values(desktop, cancel).await?).map_err(|_| invalid_reply("the display list is malformed"))
}

/// The display list as the host sent it, for a reader that takes more of a display than [`HostComputerDisplay`] names (its label).
pub(super) async fn read_display_values(desktop: &dyn HostChannel, cancel: &CancellationToken) -> Result<Value, ComputerError> {
    ask(desktop, DISPLAYS, json!({}), cancel).await
}

/// The capture of a frame's shape must be that of the rectangle it shows (`frameQualityIssue`): pixels of another shape never become a
/// frame whose coordinates would land elsewhere.
pub(super) fn check_shape(physical: (i64, i64), image: (i64, i64)) -> Result<(), ComputerError> {
    let expected = physical.0 as f64 / physical.1.max(1) as f64;
    let actual = image.0 as f64 / image.1.max(1) as f64;
    let error = (actual - expected).abs() / expected.max(0.0001);
    if !error.is_finite() || error > SHAPE_TOLERANCE {
        return Err(ComputerError::Failed {
            code: "coordinate_mismatch".into(),
            message: "coordinate_mismatch: capture dimensions do not match the target coordinate space".into(),
        });
    }
    Ok(())
}

/// The request of `host/computer/pixels` for a display: the whole display, or `region` (`[x, y, width, height]` in physical pixels) of
/// it, fitted to `max_width` and encoded as JPEG. The host's quality is 1..=100.
fn pixels_request(display: &HostComputerDisplay, max_width: i64, quality: i64, region: Option<[i64; 4]>) -> Value {
    let mut request = json!({
        "target": { "kind": "display", "displayId": display.id, "index": display.index },
        "backend": "screen",
        "maxWidth": max_width,
        "format": "jpeg",
        "quality": quality.max(1),
    });
    if let Some([x, y, width, height]) = region {
        request["region"] = json!({ "x": x, "y": y, "width": width, "height": height });
    }
    request
}

/// The pixels of `display` (or of `region` of it): asked of the desktop, read from the blob it uploaded, and checked to be what was asked
/// for: the display it names, the length it says, a size and a rectangle with a shape.
pub(super) async fn fetch(
    desktop: &dyn HostChannel,
    blobs: &dyn ComputerBlobs,
    display: &HostComputerDisplay,
    max_width: i64,
    quality: i64,
    region: Option<[i64; 4]>,
    cancel: &CancellationToken,
) -> Result<Pixels, ComputerError> {
    let reply = ask(desktop, PIXELS, pixels_request(display, max_width, quality, region), cancel).await?;
    let reply: PixelsReply = serde_json::from_value(reply).map_err(|_| invalid_reply("the reply is malformed"))?;
    if reply.capture_width <= 0 || reply.capture_height <= 0 || reply.source.width <= 0 || reply.source.height <= 0 {
        return Err(invalid_reply("it has no size"));
    }
    if !matches!(reply.blob.mime_type.as_str(), "image/jpeg" | "image/png") {
        return Err(invalid_reply("its image is neither JPEG nor PNG"));
    }
    if reply.source.display_id.as_deref().is_some_and(|id| id != display.id) {
        return Err(invalid_reply("it is of another display"));
    }
    let bytes = blobs.read(&reply.blob.digest).await?;
    if bytes.len() as u64 != reply.blob.byte_length || bytes.is_empty() {
        return Err(invalid_reply("its image is not the length the host stored"));
    }
    let source = DisplaySource {
        display_id: display.id.clone(),
        x: reply.source.x,
        y: reply.source.y,
        width: reply.source.width,
        height: reply.source.height,
        scale_factor: reply.source.scale_factor,
    };
    check_shape((source.width, source.height), (reply.capture_width, reply.capture_height))?;
    Ok(Pixels { bytes, mime: reply.blob.mime_type, capture: (reply.capture_width, reply.capture_height), source })
}

/// `capture` of a screen (`screen` the display's index; the primary display by default): the display's pixels from the desktop, the
/// frame they make (`displayScreenshotTarget`, `screenshotFrame`) remembered in `frames` so a click or a zoom can name it, and the reply
/// as the tool returns it: the capture's text in its canonical form (`action`, `mode`, the frame and its size) and the image with its size.
pub(super) async fn capture_display(
    desktop: &dyn HostChannel,
    blobs: &dyn ComputerBlobs,
    frames: &FrameStore,
    ocr: Option<&dyn DisplayOcr>,
    command: &Map<String, Value>,
    cancel: &CancellationToken,
) -> Result<(Vec<ToolPart>, Frame), ComputerError> {
    let quality = bounded_integer(command, "quality", DEFAULT_QUALITY, 0, 100, "quality")?;
    let max_width = bounded_integer(command, "maxWidth", DEFAULT_MAX_WIDTH, MIN_MAX_WIDTH, MAX_MAX_WIDTH, "maxWidth")?;
    let displays = read_displays(desktop, cancel).await?;
    let primary = displays.iter().position(|display| display.primary).unwrap_or(0);
    let last = i64::try_from(displays.len().saturating_sub(1)).unwrap_or(0);
    let index = bounded_integer(command, "screen", i64::try_from(primary).unwrap_or(0), 0, last, "screen")?;
    let display = usize::try_from(index)
        .ok()
        .and_then(|index| displays.get(index))
        .ok_or_else(|| ComputerError::Unavailable { reason: "no display to capture".into() })?;

    let pixels = fetch(desktop, blobs, display, max_width, quality, None, cancel).await?;
    let frame = Frame {
        id: format!("frame-{}", uuid::Uuid::new_v4().simple()),
        window_id: None,
        related_window_ids: None,
        origin_x: pixels.source.x,
        origin_y: pixels.source.y,
        physical_width: pixels.source.width,
        physical_height: pixels.source.height,
        capture_width: pixels.capture.0,
        capture_height: pixels.capture.1,
        idle: None,
    };
    let title = if displays.len() > 1 { format!("screen {}/{}", index + 1, displays.len()) } else { "primary screen".to_owned() };
    let encoding = if pixels.mime == "image/jpeg" { format!("JPEG quality {quality}") } else { "PNG".to_owned() };
    let mode = command.get("mode").and_then(Value::as_str).filter(|mode| !mode.is_empty()).unwrap_or("state");
    let mut text = json!({
        "action": "capture",
        "mode": mode,
        "ok": true,
        "source": "screen",
        "coordinate_space": "frame",
        "screen": index,
        "display_id": display.id,
        "width": frame.capture_width,
        "height": frame.capture_height,
        "frame_id": frame.id,
        // A display has no accessibility tree to read: `accessibilityStatus` of a mode that reads none, or of an empty read.
        "accessibility_status": if mode == "vision" { "not_requested" } else { "empty" },
        "pixel_status": if mode == "ax" { "not_requested" } else { "available" },
        "description": format!(
            "Screenshot of {title} ({}x{}, {} bytes, {encoding}); frame_id={}; coordinates are pixels in this frame",
            frame.capture_width,
            frame.capture_height,
            pixels.bytes.len(),
            frame.id
        ),
    });
    // The text a recognition found (`include_ocr`, or a state or som capture that lists elements: a display has no accessibility
    // content): its words are the elements of the capture, marked after none.
    // With no recognizer attached an automatic recognition is not made (it would only report itself missing); an asked one reports it.
    let asked = computer_ocr::ask(command, mode, false)?.filter(|_| ocr.is_some() || command.get("include_ocr") == Some(&Value::Bool(true)));
    let mut parts = Vec::new();
    let mut listed = 0;
    if let Some(asked) = &asked {
        let result = recognize(ocr, &pixels.bytes, asked.language.as_deref(), asked.limit, cancel).await?;
        let default_budget = if mode == "state" { STATE_MAX_ELEMENTS } else { OTHER_MAX_ELEMENTS };
        let budget = bounded_integer(command, "max_elements", default_budget, 1, MAX_ELEMENTS, "max_elements")?;
        // The marks the words get belong to the frame, which is remembered before they are.
        frames.remember_display(frame.clone(), pixels.source.clone());
        let capture = computer_ocr::Capture { command, mode, ask: Some(asked), accessibility: None, budget };
        listed = computer_ocr::augment(frames, &capture, &result, Some(&frame), &mut parts);
    }
    let fields = text.as_object_mut().expect("the capture text is an object");
    fields.insert("total_elements".into(), listed.into());
    fields.insert("returned_elements".into(), listed.into());
    if mode != "vision" {
        fields.insert("total_accessibility_elements".into(), 0.into());
        fields.insert("elements".into(), json!([]));
    }
    if listed > 0 {
        fields.insert("ocr_elements".into(), listed.into());
    }
    let image = ToolPart::Image {
        mime: pixels.mime,
        data: ImageData::Bytes(pixels.bytes),
        width: u32::try_from(frame.capture_width).ok(),
        height: u32::try_from(frame.capture_height).ok(),
    };
    if asked.is_none() {
        frames.remember_display(frame.clone(), pixels.source);
    }
    let mut reply = vec![ToolPart::Text(text.to_string()), image];
    reply.append(&mut parts);
    Ok((reply, frame))
}

/// A desktop and a blob store that keep what they are asked and answer from what they are given.
#[cfg(test)]
pub(super) mod fakes {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// A desktop whose displays and pixels replies are the test's; every request it is asked is kept, by method.
    pub(in super::super) struct Desktop {
        pub(in super::super) displays: Mutex<Value>,
        pub(in super::super) pixels: Mutex<Result<Value, HostError>>,
        pub(in super::super) asked: Mutex<Vec<(String, Value)>>,
    }

    impl Desktop {
        pub(in super::super) fn new(displays: Value, pixels: Value) -> Desktop {
            Desktop { displays: Mutex::new(displays), pixels: Mutex::new(Ok(pixels)), asked: Mutex::default() }
        }
    }

    #[async_trait]
    impl HostChannel for Desktop {
        async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            assert_eq!(capability, HostCapability::Computer);
            self.asked.lock().unwrap().push((method.0.to_owned(), params));
            match method.0 {
                DISPLAYS => Ok(self.displays.lock().unwrap().clone()),
                PIXELS => self.pixels.lock().unwrap().clone(),
                other => panic!("unexpected request {other}"),
            }
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    #[derive(Default)]
    pub(in super::super) struct Blobs(pub(in super::super) HashMap<String, Vec<u8>>);

    #[async_trait]
    impl ComputerBlobs for Blobs {
        async fn read(&self, digest: &str) -> Result<Vec<u8>, ComputerError> {
            self.0.get(digest).cloned().ok_or_else(|| ComputerError::Failed { code: "blob_missing".into(), message: format!("no blob {digest}") })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fakes::Blobs;
    use super::fakes::Desktop;
    use super::*;

    const DIGEST: &str = "sha256:aaaa";

    fn displays() -> Value {
        json!([
            {"index": 0, "id": "11", "primary": true, "scale_factor": 1.5, "width": 1280, "height": 720, "x": 0, "y": 0},
            {"index": 1, "id": "12", "primary": false, "scale_factor": 1.0, "width": 1920, "height": 1080, "x": -1920, "y": -200},
        ])
    }

    /// The reply of the second display captured whole: 1920x1080 physical at its origin, fitted to 960x540.
    fn reply() -> Value {
        json!({
            "blob": {"digest": DIGEST, "byteLength": 4, "mimeType": "image/jpeg"},
            "captureWidth": 960, "captureHeight": 540,
            "source": {"x": -1920, "y": -200, "width": 1920, "height": 1080, "scaleFactor": 1.0, "displayId": "12", "windowId": null},
            "backend": "screen", "capturedAt": 1.0, "attempts": [{"backend": "screen", "ok": true}],
        })
    }

    fn blobs() -> Blobs {
        Blobs([(DIGEST.to_owned(), b"jpeg".to_vec())].into())
    }

    fn command(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    fn message(error: ComputerError) -> String {
        match error {
            ComputerError::Failed { message, .. } => message,
            ComputerError::InvalidInput { reason } | ComputerError::Unavailable { reason } => reason,
            other => format!("{other:?}"),
        }
    }

    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }

    /// A display capture is issued as a frame the store holds: the display's own rectangle, the host's capture size, and a reply
    /// whose text is the capture's canonical form and whose image is read from the blob.
    #[test]
    fn a_display_capture_issues_a_frame_a_click_can_name() {
        let desktop = Desktop::new(displays(), reply());
        let frames = FrameStore::default();
        let (parts, frame) = run(capture_display(&desktop, &blobs(), &frames, None, &command(json!({"screen": 1, "mode": "state"})), &CancellationToken::new())).unwrap();
        assert_eq!((frame.window_id.clone(), frame.origin_x, frame.origin_y, frame.physical_width, frame.capture_width), (None, -1920, -200, 1920, 960));
        let ToolPart::Text(text) = &parts[0] else { panic!("text first") };
        let text: Value = serde_json::from_str(text).unwrap();
        assert_eq!((text["action"].as_str(), text["mode"].as_str(), text["ok"].as_bool(), text["width"].as_i64()), (Some("capture"), Some("state"), Some(true), Some(960)));
        assert!(text["description"].as_str().unwrap().starts_with("Screenshot of screen 2/2 (960x540, 4 bytes, JPEG quality 55); frame_id=frame-"));
        assert_eq!(parts[1], ToolPart::Image { mime: "image/jpeg".into(), data: ImageData::Bytes(b"jpeg".to_vec()), width: Some(960), height: Some(540) });
        // The host was asked for that display, at the bounded size and quality.
        let asked = desktop.asked.lock().unwrap().clone();
        let request = &asked.iter().find(|(method, _)| method == PIXELS).unwrap().1;
        assert_eq!(request["target"], json!({"kind": "display", "displayId": "12", "index": 1}));
        assert_eq!((request["maxWidth"].clone(), request["quality"].clone(), request["format"].clone()), (json!(1280), json!(55), json!("jpeg")));
        // A click names it: frame pixel (480, 270) is physical (-1920 + 960, -200 + 540).
        let mut click = command(json!({"action": "click", "x": 480, "y": 270, "frame_id": frame.id}));
        super::super::computer_frames::map_step(&frames, &mut click).unwrap();
        assert_eq!((click["x"].clone(), click["y"].clone()), (json!(-960), json!(340)));
        assert_eq!(frames.display_of(&frame.id).map(|source| source.display_id), Some("12".to_owned()));
    }

    /// The recognizer the capture asks: one answer, and the language and limit it was asked with.
    struct Recognizer(Result<Map<String, Value>, ComputerError>, std::sync::Mutex<Vec<(Option<String>, i64)>>);

    #[async_trait]
    impl DisplayOcr for Recognizer {
        async fn recognize(&self, _: &[u8], language: Option<&str>, limit: i64, _: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
            self.1.lock().unwrap().push((language.map(str::to_owned), limit));
            self.0.clone()
        }
    }

    /// A display capture answers the fields of a capture (the coordinate space, the pixel and accessibility status, the element
    /// counts), and recognizes the pixels when asked: its words are the elements of a state capture, marked for a click.
    #[test]
    fn a_display_capture_answers_its_statuses_and_its_recognized_text() {
        let word = json!({"text": "Save", "line": 0, "x": 10, "y": 20, "width": 40, "height": 12, "center_x": 30, "center_y": 26});
        let found = json!({"language": "en-US", "words": [word], "lines": [], "total_words": 1, "truncated_words": 0}).as_object().cloned().unwrap();
        let recognizer = Recognizer(Ok(found), Default::default());
        let frames = FrameStore::default();
        let (parts, frame) = run(capture_display(&Desktop::new(displays(), reply()), &blobs(), &frames, Some(&recognizer), &command(json!({"screen": 1, "include_ocr": true, "ocr_language": "en-US"})), &CancellationToken::new())).unwrap();
        let ToolPart::Text(text) = &parts[0] else { panic!("text first") };
        let text: Value = serde_json::from_str(text).unwrap();
        assert_eq!(
            (text["coordinate_space"].clone(), text["pixel_status"].clone(), text["accessibility_status"].clone(), text["total_elements"].clone(), text["returned_elements"].clone()),
            (json!("frame"), json!("available"), json!("empty"), json!(1), json!(1))
        );
        assert_eq!(recognizer.1.lock().unwrap().clone(), vec![(Some("en-US".to_owned()), 300)]);
        let ToolPart::Text(listed) = &parts[2] else { panic!("the recognized text after the image") };
        assert!(listed.contains(&format!("[ocr:{}:1] Text \"Save\"", frame.id)), "{listed}");
        let vision = run(capture_display(&Desktop::new(displays(), reply()), &blobs(), &FrameStore::default(), None, &command(json!({"screen": 1, "mode": "vision"})), &CancellationToken::new())).unwrap().0;
        let ToolPart::Text(vision) = &vision[0] else { panic!("text first") };
        let vision: Value = serde_json::from_str(vision).unwrap();
        assert_eq!((vision["accessibility_status"].clone(), vision.get("elements").cloned()), (json!("not_requested"), None));
        // A recognizer that fails leaves the capture whole and says why.
        let broken = Recognizer(Err(ComputerError::Failed { code: "x".into(), message: "OCR offline".into() }), Default::default());
        let (parts, _) = run(capture_display(&Desktop::new(displays(), reply()), &blobs(), &FrameStore::default(), Some(&broken), &command(json!({"screen": 1, "include_ocr": true})), &CancellationToken::new())).unwrap();
        assert!(matches!(&parts[2], ToolPart::Text(text) if text == "OCR failed: OCR offline"), "{parts:?}");
    }

    /// With no `screen`, the primary display is captured, and a lone display is the primary screen.
    #[test]
    fn the_primary_display_is_the_default() {
        let one = json!([{"index": 0, "id": "11", "primary": true, "scale_factor": 1.0, "width": 800, "height": 600, "x": 0, "y": 0}]);
        let mut shown = reply();
        shown["captureWidth"] = json!(800);
        shown["captureHeight"] = json!(600);
        shown["source"] = json!({"x": 0, "y": 0, "width": 800, "height": 600, "scaleFactor": 1.0, "displayId": "11", "windowId": null});
        let desktop = Desktop::new(one, shown);
        let (parts, _) = run(capture_display(&desktop, &blobs(), &FrameStore::default(), None, &command(json!({"quality": 0})), &CancellationToken::new())).unwrap();
        let ToolPart::Text(text) = &parts[0] else { panic!("text first") };
        assert!(text.contains("Screenshot of primary screen"), "{text}");
        let asked = desktop.asked.lock().unwrap().clone();
        assert_eq!(asked.iter().find(|(method, _)| method == PIXELS).unwrap().1["quality"], json!(1));
        let bad = run(capture_display(&desktop, &blobs(), &FrameStore::default(), None, &command(json!({"screen": 2})), &CancellationToken::new())).unwrap_err();
        assert_eq!(message(bad), "screen must be an integer from 0 to 0");
    }

    /// A reply that is not what was asked, whole and shaped, is refused and leaves no frame.
    #[test]
    fn a_reply_that_is_not_the_display_asked_for_is_refused() {
        let refused = |edit: &dyn Fn(&mut Value), blob: Blobs| {
            let mut bad = reply();
            edit(&mut bad);
            let frames = FrameStore::default();
            let error = run(capture_display(&Desktop::new(displays(), bad), &blob, &frames, None, &command(json!({"screen": 1})), &CancellationToken::new())).unwrap_err();
            assert!(frames.lookup(None, std::time::Instant::now()).unwrap().is_none());
            message(error)
        };
        assert!(refused(&|r| r["source"]["displayId"] = json!("11"), blobs()).contains("of another display"));
        assert!(refused(&|r| r["blob"]["byteLength"] = json!(5), blobs()).contains("not the length"));
        assert!(refused(&|r| r["blob"]["mimeType"] = json!("image/gif"), blobs()).contains("neither JPEG nor PNG"));
        assert!(refused(&|r| r["captureHeight"] = json!(100), blobs()).starts_with("coordinate_mismatch"));
        assert!(refused(&|r| r["captureWidth"] = json!(0), blobs()).contains("no size"));
        assert!(refused(&|_| {}, Blobs::default()).starts_with("no blob"));
    }

    /// The host's refusals: its own code and text, a desktop without the method as `Unavailable`.
    #[test]
    fn the_hosts_refusals_keep_their_codes() {
        let desktop = Desktop::new(displays(), reply());
        *desktop.pixels.lock().unwrap() = Err(HostError::Rpc { code: -32000, message: "no permission".into(), data: Some(json!({"code": "computer_capture_permission"})) });
        let error = run(capture_display(&desktop, &blobs(), &FrameStore::default(), None, &Map::new(), &CancellationToken::new())).unwrap_err();
        assert_eq!(error, ComputerError::Failed { code: "computer_capture_permission".into(), message: "no permission".into() });
        *desktop.pixels.lock().unwrap() = Err(HostError::Rpc { code: METHOD_NOT_FOUND, message: "Method not found".into(), data: None });
        let error = run(capture_display(&desktop, &blobs(), &FrameStore::default(), None, &Map::new(), &CancellationToken::new())).unwrap_err();
        assert!(matches!(error, ComputerError::Unavailable { .. }), "{error:?}");
    }

    #[test]
    fn a_region_is_asked_in_physical_pixels() {
        let display: HostComputerDisplay = serde_json::from_value(displays()[1].clone()).unwrap();
        let request = pixels_request(&display, 1000, 70, Some([10, 20, 300, 200]));
        assert_eq!(request["region"], json!({"x": 10, "y": 20, "width": 300, "height": 200}));
        assert!(pixels_request(&display, 1000, 70, None).get("region").is_none());
    }
}
