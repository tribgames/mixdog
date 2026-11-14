//! `capture`: a window's accessibility snapshot and pixels from the helper, or a display's pixels from the desktop
//! (`computer_pixels`).

use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_rt::time::sleep;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::computer_backend::ProcessComputerBackend;
use super::computer_backend::Reply;
use super::computer_backend::parts_of;
use super::computer_command::text;
use super::computer_delta::DeltaOptions;
use super::computer_delta::capture_baseline_key;
use super::computer_frames::Frame;
use super::computer_frames::InputIdle;
use super::computer_frames::USER_INPUT_DURING_CAPTURE;
use super::computer_marks_draw::Mark;
use super::computer_marks_draw::MarkSource;
use super::computer_marks_draw::paint_marks_or_input;
use super::computer_ocr;
use super::computer_pixels::capture_display;

/// A capture's snapshot round trip, and each read of the input observer around it; reaching it retires the helper
/// (`CAPTURE_ACCESSIBILITY_TIMEOUT_MS`, `shared/common.ts`).
const ACCESSIBILITY_TIMEOUT: Duration = Duration::from_millis(2_500);
/// The budget the helper gives every provider read of the snapshot (`CAPTURE_ACCESSIBILITY_DEADLINE_MS`).
const ACCESSIBILITY_DEADLINE_MS: u64 = 2_000;
/// A window capture's round trip: two native attempts of 2000 ms (`NATIVE_CAPTURE_TIMEOUT_MS`, `shared/capture-attempts.ts`) and the
/// time to cancel and release them.
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(4_500);
/// A window capture that also recognizes its text: the helper runs OCR inside `window_capture` with its own 20 s budget
/// (`OCR_WORK_MS`, platform/windows/shell.rs), so the round trip waits for that beside the capture's own.
const OCR_CAPTURE_TIMEOUT: Duration = Duration::from_millis(4_500 + 20_000 + 500);
/// `captureElementBudget`: a state capture's default (`DEFAULT_CAPTURE_MAX_ELEMENTS`), every other mode's, and the most.
pub(super) const STATE_MAX_ELEMENTS: i64 = 80;
pub(super) const OTHER_MAX_ELEMENTS: i64 = 200;
pub(super) const MAX_ELEMENTS: i64 = 1_000;
/// `DEFAULT_SCREENSHOT_MAX_WIDTH` with its bounds, and `DEFAULT_SCREENSHOT_QUALITY` (`shared/common.ts`).
pub(super) const DEFAULT_MAX_WIDTH: i64 = 1_280;
pub(super) const MIN_MAX_WIDTH: i64 = 256;
pub(super) const MAX_MAX_WIDTH: i64 = 3_840;
pub(super) const DEFAULT_QUALITY: i64 = 55;

/// The observer's reason while it recovers from input it could not attribute (`INPUT_GAP_REASON`), and how long a read waits for it.
const INPUT_GAP_REASON: &str = "input_gap";
const INPUT_GAP_SETTLE: Duration = Duration::from_millis(1_000);
const INPUT_GAP_POLL: Duration = Duration::from_millis(100);

/// What a capture whose native release the helper did not confirm reports (`worker-requests.ts`).
const CLEANUP_FAILED_MESSAGE: &str = "capture_cleanup_failed: native capture release was not confirmed";

/// How long a window whose provider timed out is served from pixels (doubling per consecutive timeout up to the ceiling), and how
/// long one whose tree came back empty twice (`capture-visual-only.ts`).
const VISUAL_ONLY_TTL: Duration = Duration::from_secs(30);
const VISUAL_ONLY_TIMEOUT_MAX_TTL: Duration = Duration::from_secs(120);
const VISUAL_ONLY_MISS_THRESHOLD: u32 = 2;
const VISUAL_ONLY_MAX_ENTRIES: usize = 128;
const TIMEOUT_CODE: &str = "computer_command_timeout";
/// A cache hit asked no provider, so it never repeats the stored timeout's account of that earlier read.
const CACHED_TIMEOUT_ERROR: &str =
    "computer_command_timeout: cached result of an earlier accessibility timeout on this window; the provider was not asked again for this read";

impl ProcessComputerBackend {
    /// `capture`: the accessibility snapshot, plus the window's pixels unless the mode is `ax`.
    pub(super) async fn capture(&self, mut command: Map<String, Value>, asked_mode: &str, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        if command.contains_key("screen") {
            return self.capture_screen(&command, asked_mode, cancel).await;
        }
        let mode = command.shift_remove("mode").and_then(|mode| mode.as_str().map(str::to_string)).unwrap_or_else(|| "state".into());
        if let Some(parts) = self.capture_window(&command, &mode, false, cancel).await? {
            return Ok(parts);
        }
        // The input observer was replaced during the capture: one read of fresh pixels bound to the replacement's
        // (`captureComputer(command, forcedWindowId, true)`).
        self.capture_window(&command, &mode, true, cancel).await?.ok_or_else(observation_unavailable)
    }

    /// One window capture (`captureComputer`): the observer's read, the bounded snapshot, the pixels, the observer's read again.
    /// `None` when the observer was replaced meanwhile and pixels alone may still answer; `replacement` is that read, which asks
    /// no accessibility.
    async fn capture_window(&self, command: &Map<String, Value>, mode: &str, replacement: bool, cancel: &CancellationToken) -> Result<Option<Vec<ToolPart>>, ComputerError> {
        // `beginCaptureAttempt`: a new capture invalidates the frame before it, whatever it ends in.
        self.frames.clear();
        let default_budget = if mode == "state" { STATE_MAX_ELEMENTS } else { OTHER_MAX_ELEMENTS };
        let budget = bounded_integer(command, "max_elements", default_budget, 1, MAX_ELEMENTS, "max_elements")?;
        let max_width = bounded_integer(command, "maxWidth", DEFAULT_MAX_WIDTH, MIN_MAX_WIDTH, MAX_MAX_WIDTH, "maxWidth")?;
        let quality = bounded_integer(command, "quality", DEFAULT_QUALITY, 0, 100, "quality")?;
        let (window_id, related) = self.capture_target(command, mode, cancel).await?;
        let mut before = self.read_input(&window_id, cancel).await?;

        let key = format!("{}\u{0}{window_id}", self.config.session_id);
        let eligible = visual_only_eligible(command, mode, &window_id);
        let resolved = if eligible { lock(&VISUAL_ONLY).resolve(&key, Instant::now()) } else { Resolved::default() };
        let mut read = Accessibility::default();
        if mode != "vision" && !replacement {
            read = self.read_accessibility(command, &window_id, budget, &resolved, cancel).await?;
            if read.failure.is_some() {
                // A read that failed may have replaced the helper: the pixels bind to the observer that answers now.
                before = self.read_input(&window_id, cancel).await?;
            }
        }
        if let Some(failure) = &read.failure
            && (mode == "ax" || truthy(command, "continuation"))
        {
            // Paging depends on the accessibility read: swallowing its error would answer a stale token with page one. The cache
            // still learns that the provider stalls.
            learn(eligible, &key, &resolved, false, &read.error, 0);
            return Err(failure.clone());
        }

        // The helper recognizes the frame inside the capture, so a capture whose tree names no content asks for it with the pixels.
        let ocr_asked = computer_ocr::ask(command, mode, View::of(&read, None).semantic)?;
        let mut pixels = if mode == "ax" { None } else { Some(self.read_pixels(&window_id, max_width, quality, ocr_asked.as_ref(), cancel).await?) };
        let geometry = pixels.as_ref().and_then(|pixels| geometry_of(&pixels.result));
        let mut view = View::of(&read, geometry);
        // A fresh first answer of chrome alone earns one more read of the content (`shouldRereadContent`).
        let filtered = truthy(command, "query") || truthy(command, "role");
        if !resolved.hit && !replacement && !truthy(command, "continuation") && should_reread(mode, view.semantic, &read.error, view.total, command.get("include_ocr") == Some(&Value::Bool(true)), filtered) {
            read = self.read_accessibility(command, &window_id, budget, &Resolved::default(), cancel).await?;
            view = View::of(&read, geometry);
        }
        if !replacement {
            learn(eligible, &key, &resolved, view.semantic, &read.error, view.actionable);
        }

        // The frame's geometry can show a tree of menu chrome alone, which only the settled view knows: its capture asks again.
        let ocr = computer_ocr::ask(command, mode, view.semantic)?;
        if let Some(ask) = &ocr
            && ocr_asked.is_none()
            && pixels.is_some()
        {
            pixels = Some(self.read_pixels(&window_id, max_width, quality, Some(ask), cancel).await?);
        }

        let after = self.read_input(&window_id, cancel).await?;
        if before.as_ref().zip(after.as_ref()).is_some_and(|(before, after)| before.monitor != after.monitor) {
            if replacement || mode == "ax" {
                return Err(observation_unavailable());
            }
            return Ok(None);
        }
        let mut parts = read.parts(&resolved)?;
        let ocr_content = pixels.as_ref().is_some_and(|pixels| recognized_words(&pixels.result));
        // The frame is issued before the text is finished: the words keep a share of the element budget, so the rows of the
        // accessibility text beyond what is left of it are cut from the text before the capture's bookkeeping reads it.
        let frame = pixels.as_ref().and_then(|pixels| {
            let idle = settle_input(before.as_ref(), after.as_ref());
            let id = format!("frame-{}", uuid::Uuid::new_v4().simple());
            // A child window the helper read through its owner (`captureThroughOwner`) is a frame of the owner's window.
            let (frame_window, frame_related) = match pixels.result.get("window_id").and_then(Value::as_str) {
                Some(owner) if pixels.result.contains_key("requested_window_id") => (owner.to_string(), vec![owner.to_string()]),
                _ => (window_id.clone(), related.clone()),
            };
            frame_of(&pixels.result, &id, &frame_window, frame_related, idle)
        });
        let capture = computer_ocr::Capture { command, mode, ask: ocr.as_ref(), accessibility: read.result.as_ref().filter(|_| read.error.is_empty()), budget };
        if let (Some(frame), Some(ToolPart::Text(shown))) = (&frame, parts.first_mut()) {
            let cut = computer_ocr::rows_beyond_reservation(&capture, frame);
            if !cut.is_empty() {
                *shown = without_element_lines(shown, &cut);
            }
        }
        self.observe(&mut parts, command, mode, &window_id, &related, &read, &resolved, budget, ocr_content);
        if let Some(pixels) = pixels {
            let marked = frame.clone().filter(|_| mode == "som");
            let from = parts.len();
            parts.extend(self.pixel_parts(&pixels.result, frame, quality, &capture)?);
            if let Some(frame) = marked
                && let Some(overlay) = mark_frame(&mut parts[from..], capture.accessibility, &self.frames.ocr_boxes(&frame), &frame, quality)
            {
                if let Some(error) = &overlay.error {
                    parts.push(ToolPart::Text(format!("Marks overlay not drawn: {error}")));
                }
                overlay.record(&mut parts);
            }
            self.keep_image(command, &mut parts);
        }
        Ok(Some(parts))
    }

    /// `finishCapture`'s bookkeeping over the rows the read returned: the change summary against the session's last capture of this
    /// window, and the observation delta that stands in for the full list when the command asked for one (`observation_delta`: the
    /// capture that follows an action). Marks, OCR rows and pages always go in full. A cached or failed read, and a `vision` one,
    /// has no rows to record and drops the delta list the session held.
    #[allow(clippy::too_many_arguments)]
    fn observe(&self, parts: &mut [ToolPart], command: &Map<String, Value>, mode: &str, window_id: &str, related: &[String], read: &Accessibility, resolved: &Resolved, budget: i64, ocr_content: bool) {
        let Some(snapshot) = read.result.as_ref().filter(|_| mode != "vision" && read.error.is_empty() && !resolved.hit) else {
            // A read that is no baseline (`recordable: false` in `finishCapture`) ends the list the model holds: the next one is full.
            self.shared.delta.forget_delta(&self.config.session_id);
            return;
        };
        let rows = snapshot.get("elements").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let session = &self.config.session_id;
        let key = capture_baseline_key(command, mode, budget.max(0) as u64);
        let changes = self.shared.delta.record_baseline(session, window_id, &key, rows);
        let paged = truthy(command, "continuation") || snapshot.get("continuation").is_some_and(|token| !token.is_null());
        let options = DeltaOptions {
            observation_delta: command.get("observation_delta") == Some(&Value::Bool(true)) && mode != "som" && !ocr_content && !paged,
            recordable: !ocr_content,
            baseline_key: key,
            related_window_ids: related.to_vec(),
        };
        let outcome = self.shared.delta.observe(session, window_id, snapshot, None, &options);
        let Some(ToolPart::Text(shown)) = parts.first_mut() else { return };
        if let Some(delta) = &outcome.delta
            && let Some(replaced) = with_delta(shown, rows, delta)
        {
            *shown = replaced;
        }
        if let Some(changes) = changes {
            shown.push_str(&format!("\nChanges since the last capture: {changes}"));
        }
    }

    /// The window a capture reads and the windows around it: the helper's `window_bounds` unless an `ax` capture names its window
    /// (`resolveCaptureWindowId`, `windowScreenshotTarget`).
    async fn capture_target(&self, command: &Map<String, Value>, mode: &str, cancel: &CancellationToken) -> Result<(String, Vec<String>), ComputerError> {
        let named = text(command, "window_id").to_string();
        let mut window_id = named.clone();
        let mut related = Vec::new();
        if mode != "ax" || named.is_empty() {
            let mut extra = Vec::new();
            for key in ["window", "window_id"] {
                if !text(command, key).is_empty() {
                    extra.push((key, json!(text(command, key))));
                }
            }
            let bounds = self.host_read("window_bounds", extra, None, cancel).await?;
            window_id = bounds.get("window_id").and_then(Value::as_str).filter(|id| !id.is_empty()).map_or(named, str::to_string);
            related = strings(bounds.get("related_window_ids"));
            if related.is_empty() && !window_id.is_empty() {
                related.push(window_id.clone());
            }
        }
        if window_id.is_empty() && mode != "vision" {
            return Err(ComputerError::Failed { code: "computer_failed".into(), message: format!("{mode} capture requires an exact target window") });
        }
        Ok((window_id, related))
    }

    /// The bounded snapshot of a window (`readAccessibilitySnapshot`), or the cache's answer for one whose provider stalls. A
    /// refusal of the provider is the read's `failure`, which the capture reports and goes on without.
    async fn read_accessibility(&self, command: &Map<String, Value>, window_id: &str, budget: i64, resolved: &Resolved, cancel: &CancellationToken) -> Result<Accessibility, ComputerError> {
        if resolved.hit {
            return Ok(Accessibility { ran: true, error: resolved.cached_error.clone(), ..Accessibility::default() });
        }
        match self.call_with(snapshot_command(command, window_id, budget), ACCESSIBILITY_TIMEOUT, cancel).await {
            Ok(result) => Ok(Accessibility { ran: true, result: Some(result), ..Accessibility::default() }),
            Err(failure @ ComputerError::Failed { .. }) => {
                let error = if let ComputerError::Failed { message, .. } = &failure { message.clone() } else { String::new() };
                Ok(Accessibility { ran: true, error, failure: Some(failure), ..Accessibility::default() })
            }
            Err(other) => Err(other),
        }
    }

    /// The window's pixels from the helper within `CAPTURE_TIMEOUT`. A capture whose native release the helper did not confirm
    /// retires it, whether or not it carried pixels (`worker-requests.ts`).
    async fn read_pixels(&self, window_id: &str, max_width: i64, quality: i64, ocr: Option<&computer_ocr::Ask>, cancel: &CancellationToken) -> Result<Pixels, ComputerError> {
        let mut command = read_command("window_capture");
        if let Some(ocr) = ocr {
            ocr.apply(&mut command);
        }
        command.insert("window_id".into(), json!(window_id));
        command.insert("max_width".into(), json!(max_width));
        command.insert("quality".into(), json!(quality));
        Ok(Pixels { result: self.exchange_pixels(command, cancel).await? })
    }

    /// One `window_capture` round trip within `CAPTURE_TIMEOUT` (core-zoom reads its crop through it as well).
    pub(super) async fn exchange_pixels(&self, command: Map<String, Value>, cancel: &CancellationToken) -> Result<Map<String, Value>, ComputerError> {
        let timeout = if command.get("include_ocr") == Some(&Value::Bool(true)) { OCR_CAPTURE_TIMEOUT } else { CAPTURE_TIMEOUT };
        let reply = self.exchange(command, timeout, cancel).await?;
        let unconfirmed = cleanup_unconfirmed(&reply);
        if unconfirmed {
            // The retire's result goes where every other retire's does: an unconfirmed cleanup hands the desktop to the user.
            let confirmed = self.retire().await;
            self.pause_unless(confirmed);
        }
        match reply {
            Ok(result) => Ok(result),
            Err(failure) => {
                self.note_failed_capture(&failure);
                Err(if unconfirmed { cleanup_failed() } else { failure.into_error() })
            }
        }
    }

    /// One read of the input observer around the captured window, settled while the observer recovers from an input gap
    /// (`createInputObservationReader`). `None` when it cannot be read.
    async fn read_input(&self, window_id: &str, cancel: &CancellationToken) -> Result<Option<Observation>, ComputerError> {
        let deadline = Instant::now() + INPUT_GAP_SETTLE;
        let mut reads = Vec::new();
        loop {
            let mut request = read_command("input_idle_state");
            if !window_id.is_empty() {
                request.insert("input_target_window_id".into(), json!(window_id));
            }
            let read = match self.call_with(request, ACCESSIBILITY_TIMEOUT, cancel).await {
                Ok(result) => Observation::of(&result),
                Err(ComputerError::Cancelled) => return Err(ComputerError::Cancelled),
                Err(_) => None,
            };
            let in_gap = read.as_ref().is_some_and(|read| !read.ready && read.reason.as_deref() == Some(INPUT_GAP_REASON));
            reads.push(read);
            if !in_gap || Instant::now() >= deadline {
                return Ok(settle_reads(reads));
            }
            sleep(INPUT_GAP_POLL).await;
        }
    }

    /// The window capture as the tool returns it: the frame's description (`screenshotCapture`) in place of the helper's own text,
    /// the image with its size, the OCR lines after it. The frame is issued here, so a click can name it.
    fn pixel_parts(&self, result: &Map<String, Value>, frame: Option<Frame>, quality: i64, ocr: &computer_ocr::Capture) -> Result<Vec<ToolPart>, ComputerError> {
        let mut parts = parts_of(result)?;
        let issued = frame.clone();
        if let (Some(frame), Some(ToolPart::Image { mime, data, width, height })) = (frame, parts.get_mut(1)) {
            let bytes = if let ImageData::Bytes(bytes) = data { bytes.len() } else { 0 };
            let title = result.get("title").and_then(Value::as_str).filter(|title| !title.is_empty());
            let subject = title.or(frame.window_id.as_deref()).unwrap_or_default();
            let encoding = if mime.as_str() == "image/jpeg" { format!("JPEG quality {quality}") } else { "PNG".to_string() };
            let window = frame.window_id.as_deref().map(|id| format!(" window_id={id}")).unwrap_or_default();
            let description = format!(
                "Screenshot of window \"{subject}\" ({}x{}, {bytes} bytes, {encoding}); frame_id={}{window}; coordinates are pixels in this frame",
                frame.capture_width, frame.capture_height, frame.id
            );
            (*width, *height) = (u32::try_from(frame.capture_width).ok(), u32::try_from(frame.capture_height).ok());
            parts[0] = ToolPart::Text(description);
            self.frames.remember(frame);
        }
        computer_ocr::augment(&self.frames, ocr, result, issued.as_ref(), &mut parts);
        Ok(parts)
    }

    /// The capture of a display: its pixels asked of the desktop (`host/computer/pixels`) and read from the core's blob store, the frame
    /// they make remembered so a click or a zoom can name it, and the text its words are (`computer_pixels::capture_display`).
    ///
    /// `asked_mode` is the call's own `mode`: the reply text carries it (`args.input?.mode || 'state'`), not the one a Linux fallback rewrote.
    async fn capture_screen(&self, command: &Map<String, Value>, asked_mode: &str, cancel: &CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        let desktop = self.desktop()?;
        let blobs = self.display_blobs()?;
        let mut asked = command.clone();
        asked.shift_remove("mode");
        if !asked_mode.is_empty() {
            asked.insert("mode".into(), json!(asked_mode));
        }
        let (mut parts, _) = capture_display(desktop.as_ref(), blobs.as_ref(), &self.frames, Some(self), &asked, cancel).await?;
        self.keep_image(command, &mut parts);
        Ok(parts)
    }
}

/// Whether the helper's recognition of the frame found words or lines (`ocrContent`): rows that are not accessibility's.
fn recognized_words(result: &Map<String, Value>) -> bool {
    let rows = |key: &str| result.get("ocr").and_then(|ocr| ocr.get(key)).and_then(Value::as_array).is_some_and(|rows| !rows.is_empty());
    rows("lines") || rows("words")
}

/// The text of a capture without the lines the helper wrote for the elements whose refs are named (`elements.splice` of
/// `mergeCaptureOcr`, which cut the rows beyond the budget less the words' reservation).
fn without_element_lines(shown: &str, refs: &[String]) -> String {
    let prefixes: Vec<String> = refs.iter().map(|reference| format!("[{reference}] ")).collect();
    shown.split('\n').filter(|line| !prefixes.iter().any(|prefix| line.starts_with(prefix.as_str()))).collect::<Vec<_>>().join("\n")
}

/// The text of a capture with the delta in place of its element lines: each line the helper wrote for an element (`[<ref>] ...`)
/// is dropped and one `Elements delta` line, the rows that changed in full and the ones that did not by their refs, stands where the
/// first was. `None` when the text holds no element line to replace, so the full list stays.
fn with_delta(shown: &str, rows: &[Value], delta: &Value) -> Option<String> {
    let refs: Vec<String> = rows.iter().filter_map(|row| row.get("ref").and_then(Value::as_str)).map(|reference| format!("[{reference}] ")).collect();
    let is_element = |line: &str| refs.iter().any(|prefix| line.starts_with(prefix.as_str()));
    let lines: Vec<&str> = shown.split('\n').collect();
    let first = lines.iter().position(|line| is_element(*line))?;
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        if index == first {
            out.push(format!("Elements delta: {delta}"));
        }
        if !is_element(*line) {
            out.push((*line).to_owned());
        }
    }
    Some(out.join("\n"))
}

/// What drawing the marks came to (`overlay_rendered`, `overlay_error` and `overlay_ms` of the capture payload).
#[derive(Debug)]
struct Marked {
    rendered: bool,
    error: Option<String>,
    ms: u64,
}

impl Marked {
    /// The fields in the reply: in the first text part when that is the payload object, else as a part of their own.
    fn record(&self, parts: &mut Vec<ToolPart>) {
        let mut fields = Map::new();
        fields.insert("overlay_rendered".into(), json!(self.rendered));
        if let Some(error) = &self.error {
            fields.insert("overlay_error".into(), json!(error));
        }
        fields.insert("overlay_ms".into(), json!(self.ms));
        if let Some(ToolPart::Text(shown)) = parts.first_mut()
            && let Ok(Value::Object(mut payload)) = serde_json::from_str::<Value>(shown)
        {
            payload.extend(fields);
            *shown = Value::Object(payload).to_string();
        } else {
            parts.push(ToolPart::Text(Value::Object(fields).to_string()));
        }
    }
}

/// `renderSomOverlay` over the frame's image part: the elements of the snapshot and the OCR words listed after them, each outlined and
/// numbered in the pixels the model will point at. A frame that cannot be drawn on keeps its pixels and the reply says why; a capture
/// with neither an accessibility read nor a word has nothing to draw.
fn mark_frame(parts: &mut [ToolPart], snapshot: Option<&Map<String, Value>>, words: &[(i64, [i64; 4])], frame: &Frame, quality: i64) -> Option<Marked> {
    if snapshot.is_none() && words.is_empty() {
        return None;
    }
    let mut marks = snapshot.map(|snapshot| som_marks(snapshot, frame)).unwrap_or_default();
    marks.extend(word_marks(words, frame));
    let ToolPart::Image { mime, data: ImageData::Bytes(bytes), .. } = parts.iter_mut().find(|part| matches!(part, ToolPart::Image { .. }))? else { return None };
    let started = Instant::now();
    let overlay = paint_marks_or_input(bytes, mime, u32::try_from(frame.capture_width).unwrap_or(0), u32::try_from(frame.capture_height).unwrap_or(0), &marks, quality.clamp(0, 100) as u8);
    *bytes = overlay.image.bytes;
    *mime = overlay.image.mime;
    Some(Marked { rendered: overlay.rendered, error: overlay.error, ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX) })
}

/// The OCR words as marks: their boxes are already in the frame's pixels, clipped to them; one entirely outside is not drawn.
fn word_marks(words: &[(i64, [i64; 4])], frame: &Frame) -> Vec<Mark> {
    words
        .iter()
        .filter_map(|(number, [x, y, width, height])| {
            let (x, y, width, height) = (*x as f64, *y as f64, (*width).max(1) as f64, (*height).max(1) as f64);
            let (frame_width, frame_height) = (frame.capture_width as f64, frame.capture_height as f64);
            if x + width <= 0.0 || y + height <= 0.0 || x >= frame_width || y >= frame_height {
                return None;
            }
            let (left, top) = (x.max(0.0), y.max(0.0));
            let bounds = [left, top, (frame_width - left).min(width - (left - x)).max(1.0), (frame_height - top).min(height - (top - y)).max(1.0)];
            Some(Mark { mark: u32::try_from(*number).ok()?, bounds, source: MarkSource::Ocr })
        })
        .collect()
}

/// The snapshot's elements as marks in the frame's pixels (`frameElements`, `clipElementToFrame`): one entirely outside is not drawn.
fn som_marks(snapshot: &Map<String, Value>, frame: &Frame) -> Vec<Mark> {
    let Some(rows) = snapshot.get("elements").and_then(Value::as_array) else { return Vec::new() };
    let scale = |value: f64, origin: i64, capture: i64, physical: i64| ((value - origin as f64) * capture as f64 / physical.max(1) as f64 + 0.5).floor();
    rows.iter()
        .filter_map(Value::as_object)
        .filter_map(|row| {
            let number = |key: &str| row.get(key).and_then(Value::as_f64).filter(|number| number.is_finite()).unwrap_or(0.0);
            let x = scale(number("x"), frame.origin_x, frame.capture_width, frame.physical_width);
            let y = scale(number("y"), frame.origin_y, frame.capture_height, frame.physical_height);
            let width = scale(number("width"), 0, frame.capture_width, frame.physical_width).max(1.0);
            let height = scale(number("height"), 0, frame.capture_height, frame.physical_height).max(1.0);
            if x + width <= 0.0 || y + height <= 0.0 || x >= frame.capture_width as f64 || y >= frame.capture_height as f64 {
                return None;
            }
            let (left, top) = (x.max(0.0), y.max(0.0));
            let bounds = [left, top, (frame.capture_width as f64 - left).min(width - (left - x)).max(1.0), (frame.capture_height as f64 - top).min(height - (top - y)).max(1.0)];
            Some(Mark { mark: u32::try_from(row.get("mark").and_then(Value::as_i64)?).ok()?, bounds, source: MarkSource::parse(row.get("source").and_then(Value::as_str)) })
        })
        .collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The refusal of a capture whose input observer was replaced twice, or in a read that cannot be repeated.
fn observation_unavailable() -> ComputerError {
    ComputerError::Failed {
        code: "input_observation_unavailable".into(),
        message: "input_observation_unavailable: observation worker changed during capture".into(),
    }
}

fn cleanup_failed() -> ComputerError {
    ComputerError::Failed { code: "capture_cleanup_failed".into(), message: CLEANUP_FAILED_MESSAGE.into() }
}

/// A field a capture's input carries as JS truthiness reads it (`command.query`, `command.continuation`).
fn truthy(command: &Map<String, Value>, key: &str) -> bool {
    match command.get(key) {
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::Array(_) | Value::Object(_)) => true,
        _ => false,
    }
}

/// `screenshotInteger`: an absent value is the fallback; a present one must be an integer inside the bounds.
pub(super) fn bounded_integer(command: &Map<String, Value>, key: &str, fallback: i64, minimum: i64, maximum: i64, label: &str) -> Result<i64, ComputerError> {
    let Some(value) = command.get(key) else { return Ok(fallback) };
    let integer = value.as_i64().or_else(|| value.as_f64().filter(|number| number.fract() == 0.0 && number.abs() < 9e15).map(|number| number as i64));
    integer.filter(|integer| (minimum..=maximum).contains(integer)).ok_or_else(|| ComputerError::InvalidInput {
        reason: format!("{label} must be an integer from {minimum} to {maximum}"),
    })
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).filter(|item| !item.is_empty()).map(str::to_string).collect()).unwrap_or_default()
}

/// A read-only request of the helper, as the desktop host's own reads are (`host_read`).
pub(super) fn read_command(action: &str) -> Map<String, Value> {
    let mut command = Map::new();
    command.insert("action".into(), json!(action));
    command.insert("read_only".into(), json!(true));
    command.insert("pointer_feedback".into(), json!(false));
    command
}

/// `readAccessibilitySnapshot`'s request: bounded by the deadline, over the budget of elements.
fn snapshot_command(command: &Map<String, Value>, window_id: &str, budget: i64) -> Map<String, Value> {
    let mut snapshot = read_command("snapshot");
    snapshot.insert("window_id".into(), json!(window_id));
    for key in ["query", "role", "visible_only", "include_noninteractive", "include_structure", "continuation"] {
        if let Some(value) = command.get(key).filter(|value| !value.is_null()) {
            snapshot.insert(key.into(), value.clone());
        }
    }
    snapshot.insert("max_elements".into(), json!(budget));
    snapshot.insert("bounded".into(), json!(true));
    snapshot.insert("deadline_ms".into(), json!(ACCESSIBILITY_DEADLINE_MS));
    snapshot
}

/// The pixels a window capture returned, with the geometry of the window they cover.
struct Pixels {
    result: Map<String, Value>,
}

/// The window's top edge and height the pixels cover, where the helper reports them.
fn geometry_of(result: &Map<String, Value>) -> Option<(f64, f64)> {
    Some((result.get("y").and_then(Value::as_f64)?, result.get("height").and_then(Value::as_f64)?))
}

/// What a capture's snapshot answered: the helper's result, the error of its provider, or the cache's answer in its place.
#[derive(Default)]
struct Accessibility {
    /// A read was asked for (not `vision`, not a replacement read).
    ran: bool,
    result: Option<Map<String, Value>>,
    /// The text a capture reports as `accessibility_error`.
    error: String,
    /// The provider's refusal, which `ax` and paged captures report as their own.
    failure: Option<ComputerError>,
}

impl Accessibility {
    /// The snapshot's text, or the notice that stands in for it when the read failed or the cache answered.
    fn parts(&self, resolved: &Resolved) -> Result<Vec<ToolPart>, ComputerError> {
        if !self.ran {
            return Ok(Vec::new());
        }
        if let Some(result) = &self.result {
            return parts_of(result);
        }
        let mut notice = Map::new();
        notice.insert("accessibility_status".into(), json!(if resolved.hit { "visual_only_cached" } else { "error" }));
        if resolved.hit {
            notice.insert("accessibility_cache".into(), json!("visual_only"));
        }
        if !self.error.is_empty() {
            notice.insert("accessibility_error".into(), json!(self.error));
        }
        Ok(vec![ToolPart::Text(Value::Object(notice).to_string())])
    }
}

/// One accessibility element as the reread decision reads it (`ComputerElementRecord`).
struct Element {
    role: String,
    value: String,
    enabled: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    actionable: bool,
}

fn elements_of(result: &Map<String, Value>) -> Vec<Element> {
    let Some(rows) = result.get("elements").and_then(Value::as_array) else { return Vec::new() };
    rows.iter()
        .filter_map(Value::as_object)
        .map(|row| {
            let number = |key: &str| row.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            Element {
                role: row.get("role").and_then(Value::as_str).unwrap_or_default().to_string(),
                value: row.get("value").and_then(Value::as_str).unwrap_or_default().to_string(),
                enabled: row.get("enabled") == Some(&Value::Bool(true)),
                x: number("x"),
                y: number("y"),
                width: number("width"),
                height: number("height"),
                actionable: row.get("actions").and_then(Value::as_array).is_some_and(|actions| actions.iter().any(|action| action.as_str().is_some_and(|action| !action.is_empty()))),
            }
        })
        .collect()
}

/// `actionableAccessibilityElements`: elements a command could address, whatever their placement.
fn actionable_elements(elements: &[Element]) -> Vec<&Element> {
    const CONTAINER_ROLES: [&str; 7] = ["Window", "Pane", "Document", "Group", "Custom", "Image", "Text"];
    elements.iter().filter(|element| element.enabled && element.width > 1.0 && element.height > 1.0 && !CONTAINER_ROLES.contains(&element.role.as_str()) && element.actionable).collect()
}

/// `hasSemanticAccessibilityTarget`: whether the tree names something to act on in the window's content. `frame` is the captured
/// window's top edge and height, which tell a menu strip from content.
fn has_semantic_target(elements: &[Element], frame: Option<(f64, f64)>) -> bool {
    let largest = elements.iter().fold(0.0_f64, |largest, element| largest.max(element.width * element.height));
    let surfaces: Vec<&Element> = elements
        .iter()
        .filter(|element| matches!(element.role.as_str(), "Document" | "Custom" | "Image") && element.width > 1.0 && element.height > 1.0 && element.width * element.height * 2.0 >= largest)
        .collect();
    // An editor surface hands back its own text, so the window is already read.
    if surfaces.iter().any(|surface| !surface.value.trim().is_empty()) {
        return true;
    }
    let actionable = actionable_elements(elements);
    if actionable.is_empty() {
        return false;
    }
    if surfaces.is_empty() {
        if let Some((top, height)) = frame {
            let strip_bottom = top + (height * 0.12).max(64.0);
            if actionable.iter().all(|element| element.y + element.height / 2.0 <= strip_bottom) {
                return false;
            }
        }
        return true;
    }
    actionable.iter().any(|element| {
        let (center_x, center_y) = (element.x + element.width / 2.0, element.y + element.height / 2.0);
        surfaces.iter().any(|surface| center_x >= surface.x && center_y >= surface.y && center_x <= surface.x + surface.width && center_y <= surface.y + surface.height)
    })
}

/// `shouldRereadContentAccessibility`: a window that answers with its chrome but no content surface is usually mid transition, and
/// asking its provider once more costs a fraction of recognising the same pixels.
fn should_reread(mode: &str, semantic: bool, error: &str, chrome_elements: u64, explicit_ocr: bool, filtered: bool) -> bool {
    if semantic || !error.is_empty() || explicit_ocr || filtered {
        return false;
    }
    matches!(mode, "state" | "som") && chrome_elements > 0
}

/// What a capture reads off its accessibility answer: the elements' count, whether they name content, how many could be addressed.
struct View {
    total: u64,
    semantic: bool,
    actionable: usize,
}

impl View {
    fn of(read: &Accessibility, frame: Option<(f64, f64)>) -> View {
        let (Some(result), true) = (&read.result, read.error.is_empty()) else { return View { total: 0, semantic: false, actionable: 0 } };
        let elements = elements_of(result);
        let total = result.get("total_elements").and_then(Value::as_u64).filter(|total| *total > 0).unwrap_or(elements.len() as u64);
        View { total, semantic: has_semantic_target(&elements, frame), actionable: actionable_elements(&elements).len() }
    }
}

/// `visualOnlyEligible`: only a plain read of one window may be answered from, or teach, the cache. An explicit `ax` capture asks
/// the provider again, but the observation after an action takes the cached answer.
fn visual_only_eligible(command: &Map<String, Value>, mode: &str, window_id: &str) -> bool {
    let flag = |key: &str| command.get(key) == Some(&Value::Bool(true));
    !window_id.is_empty()
        && (matches!(mode, "state" | "som") || (mode == "ax" && flag("observation_after")))
        && !truthy(command, "query")
        && !truthy(command, "role")
        && !truthy(command, "continuation")
        && !flag("include_noninteractive")
        && !flag("include_structure")
}

/// One window's entry of the visual-only cache (`VisualOnlyCapability`).
#[derive(Clone, Debug, PartialEq)]
struct Capability {
    misses: u32,
    /// When the window is read again; `None` while it has not missed often enough to be skipped.
    expires: Option<Instant>,
    /// A bounded retry delay after a timeout, not evidence that the provider is empty.
    error: Option<String>,
}

/// What the cache said of a capture's window (`resolveVisualOnlyCapture`).
#[derive(Default)]
struct Resolved {
    capability: Option<Capability>,
    /// The window is served from pixels now, without asking its provider.
    hit: bool,
    cached_error: String,
}

/// Windows whose accessibility tree keeps timing out or coming back empty, served from pixels for a while instead of restarting
/// the same stalled provider after every input (`capture-visual-only.ts`). Least recently used last, per session and window.
struct VisualOnly(Vec<(String, Capability)>);

static VISUAL_ONLY: Mutex<VisualOnly> = Mutex::new(VisualOnly(Vec::new()));

impl VisualOnly {
    /// The entry of `key`, taken out of the order: it goes back only when it answers (a hit).
    fn resolve(&mut self, key: &str, now: Instant) -> Resolved {
        let Some(position) = self.0.iter().position(|(entry, _)| entry == key) else { return Resolved::default() };
        let (_, capability) = self.0.remove(position);
        let hit = capability.expires.is_some_and(|expires| expires > now);
        let cached_error = if hit && capability.error.is_some() { CACHED_TIMEOUT_ERROR.to_string() } else { String::new() };
        if hit {
            self.0.push((key.to_string(), capability.clone()));
        }
        Resolved { capability: Some(capability), hit, cached_error }
    }

    fn remember(&mut self, key: &str, capability: Capability) {
        self.0.retain(|(entry, _)| entry != key);
        self.0.push((key.to_string(), capability));
        if self.0.len() > VISUAL_ONLY_MAX_ENTRIES {
            self.0.remove(0);
        }
    }

    /// `record`: learns from a fresh read. A window whose tree names content is not visual only; consecutive timeouts double the
    /// wait up to the ceiling; an empty tree twice in a row is skipped for a while, and a timeout count never becomes an empty-tree count.
    fn record(&mut self, key: &str, previous: Option<&Capability>, semantic: bool, error: &str, actionable: usize, now: Instant) {
        if semantic {
            self.0.retain(|(entry, _)| entry != key);
            return;
        }
        let timed_out_before = previous.is_some_and(|capability| capability.error.is_some());
        let misses_before = previous.map_or(0, |capability| capability.misses);
        if error.starts_with(TIMEOUT_CODE) {
            let timeouts = (if timed_out_before { misses_before } else { 0 }) + 1;
            let wait = (VISUAL_ONLY_TTL * 2u32.pow((timeouts - 1).min(8))).min(VISUAL_ONLY_TIMEOUT_MAX_TTL);
            self.remember(key, Capability { misses: timeouts, expires: Some(now + wait), error: Some(error.to_string()) });
        } else if error.is_empty() && actionable == 0 {
            let misses = (if timed_out_before { 0 } else { misses_before }) + 1;
            let expires = (misses >= VISUAL_ONLY_MISS_THRESHOLD).then(|| now + VISUAL_ONLY_TTL);
            self.remember(key, Capability { misses, expires, error: None });
        }
    }
}

/// A fresh read teaches the cache; a capture answered from the cache teaches it nothing.
fn learn(eligible: bool, key: &str, resolved: &Resolved, semantic: bool, error: &str, actionable: usize) {
    if eligible && !resolved.hit {
        lock(&VISUAL_ONLY).record(key, resolved.capability.as_ref(), semantic, error, actionable, Instant::now());
    }
}

/// One read of the input observer (`CaptureInputObservation`): `target_sequence` is the last foreign input that could reach the
/// captured window's process.
#[derive(Clone, Debug, PartialEq)]
struct Observation {
    ready: bool,
    monitor: String,
    sequence: i64,
    reason: Option<String>,
    target_sequence: Option<i64>,
}

impl Observation {
    fn of(result: &Map<String, Value>) -> Option<Observation> {
        let monitor = result.get("monitor").and_then(Value::as_str).filter(|monitor| !monitor.is_empty())?.to_string();
        let sequence = result.get("sequence").and_then(Value::as_i64).filter(|sequence| *sequence >= 0)?;
        let ready = result.get("observer_ready") == Some(&Value::Bool(true));
        let reason = result.get("observer_reason").and_then(Value::as_str).filter(|reason| !ready && !reason.is_empty()).map(str::to_string);
        Some(Observation { ready, monitor, sequence, reason, target_sequence: result.get("target_sequence").and_then(Value::as_i64) })
    }
}

/// The observer's gap counts once, when it opens, so the first read already carries that count and a clean recovery keeps it. A
/// later change is more input during the wait: the first read stays the refused baseline.
fn settle_reads(reads: Vec<Option<Observation>>) -> Option<Observation> {
    let first = reads.first().cloned().flatten();
    let settled = reads.last().cloned().flatten();
    match (first, settled) {
        (Some(first), Some(settled)) if first.monitor != settled.monitor || first.sequence != settled.sequence => Some(first),
        (_, settled) => settled,
    }
}

/// `settleInputObservation`: what the reads before and after a capture say of foreground input. The user's input into the captured
/// window during the capture never fails it: the frame is published unready, so foreground input refuses it and background proceeds.
fn settle_input(before: Option<&Observation>, after: Option<&Observation>) -> Option<InputIdle> {
    let before = before?;
    let ready = after.is_some_and(|after| {
        before.ready && after.ready && before.monitor == after.monitor && after.sequence >= before.sequence && after.target_sequence.unwrap_or(after.sequence) <= before.sequence
    });
    let reason = (!ready).then(|| {
        // A gap that outlasted the settle wait is input still arriving, not a broken observer.
        let unavailable = |read: Option<&Observation>| !read.is_some_and(|read| read.ready) && read.and_then(|read| read.reason.as_deref()) != Some(INPUT_GAP_REASON);
        let broken = unavailable(Some(before)) || unavailable(after);
        (if broken { "input_observer_unavailable" } else { USER_INPUT_DURING_CAPTURE }).to_string()
    });
    Some(InputIdle { ready, monitor: json!(before.monitor), sequence: before.sequence, reason })
}

/// `screenshotFrame`: the frame a window capture issues, its pixels mapped onto the physical rectangle at its origin (the image is
/// the physical size unless the helper scaled it and reported the size it produced).
fn frame_of(result: &Map<String, Value>, id: &str, window_id: &str, related: Vec<String>, idle: Option<InputIdle>) -> Option<Frame> {
    let integer = |key: &str| result.get(key).and_then(Value::as_f64).filter(|number| number.is_finite()).map(|number| number.round() as i64);
    let (physical_width, physical_height) = (integer("width")?, integer("height")?);
    if physical_width <= 0 || physical_height <= 0 {
        return None;
    }
    let (capture_width, capture_height) = match (integer("image_width"), integer("image_height")) {
        (Some(width), Some(height)) if width > 0 && height > 0 => (width, height),
        _ => (physical_width, physical_height),
    };
    let named = !window_id.is_empty();
    Some(Frame {
        id: id.to_string(),
        window_id: named.then(|| window_id.to_string()),
        related_window_ids: named.then_some(related),
        origin_x: integer("x").unwrap_or(0),
        origin_y: integer("y").unwrap_or(0),
        physical_width,
        physical_height,
        capture_width,
        capture_height,
        idle,
    })
}

/// A capture reply whose `capture_cleanup` the helper did not confirm, as `worker-requests.ts` retires the worker for.
fn cleanup_unconfirmed(reply: &Reply) -> bool {
    let result = match reply {
        Ok(result) => Some(result),
        Err(failure) => failure.result.as_ref(),
    };
    let status = result.and_then(|result| result.get("capture_cleanup")).and_then(|cleanup| cleanup.get("status")).and_then(Value::as_str);
    matches!(status, Some("failed" | "unconfirmed" | "unknown"))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::computer_backend::ComputerConfig;
    use super::super::computer_backend::HelperFailure;
    use super::super::computer_frames::map_step;
    use super::super::computer_targets::testing::Scripted;
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn element(role: &str, x: f64, y: f64, width: f64, height: f64, value: &str, actions: &[&str]) -> Element {
        Element { role: role.into(), value: value.into(), enabled: true, x, y, width, height, actionable: !actions.is_empty() }
    }

    /// A helper that answers a window's reads: `snapshot` and the pixels as the test says, the rest as a quiet observer.
    fn window(snapshot: Value, capture: Value) -> Arc<Scripted> {
        Scripted::new(move |request| match request["action"].as_str() {
            Some("window_bounds") => Ok(json!({"window_id": "hwnd:0x2", "title": "T", "related_window_ids": ["hwnd:0x2", "hwnd:0x9"]})),
            Some("input_idle_state") => Ok(json!({"observer_ready": true, "monitor": "m1", "sequence": 4, "target_sequence": 4})),
            Some("snapshot") => Ok(snapshot.clone()),
            Some("window_capture") => Ok(capture.clone()),
            _ => Ok(json!({"text": "ok"})),
        })
    }

    fn pixels(extra: Value) -> Value {
        let mut capture = object(json!({"text": "cap", "title": "T", "x": 100, "y": -20, "width": 400, "height": 200, "image_base64": "aGk="}));
        capture.extend(object(extra));
        Value::Object(capture)
    }

    fn state(session: &str, manager: &Arc<Scripted>) -> ProcessComputerBackend {
        ProcessComputerBackend::new(ComputerConfig::new("helper", session), manager.clone())
    }

    fn command(extra: Value) -> Map<String, Value> {
        let mut command = object(json!({"action": "capture", "window_id": "hwnd:0x2"}));
        command.extend(object(extra));
        command
    }

    fn lines(manager: &Scripted, action: &str) -> Vec<Value> {
        manager.lines().into_iter().filter(|line| line["action"] == action).collect()
    }

    fn texts(parts: &[ToolPart]) -> Vec<String> {
        parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.clone()) } else { None }).collect()
    }

    /// The snapshot is bounded and carries its element budget by mode (80 for state, 200 otherwise); the pixels carry the width and
    /// quality; the capture issues a frame a click maps through, bound to the observation it was read with.
    #[tokio::test]
    async fn a_state_capture_is_bounded_and_issues_a_frame() {
        let manager = window(json!({"text": "snap", "window_id": "hwnd:0x2", "total_elements": 1, "elements": [
            {"role": "Button", "enabled": true, "x": 120, "y": 100, "width": 50, "height": 20, "actions": ["click"]}]}), pixels(json!({"image_width": 200, "image_height": 100})));
        let backend = state("capture-frame", &manager);
        let parts = backend.capture(command(json!({"mode": "state"})), "", &CancellationToken::new()).await.unwrap();

        let snapshots = lines(&manager, "snapshot");
        let snapshot = &snapshots[0];
        assert_eq!((snapshot["bounded"].clone(), snapshot["deadline_ms"].clone(), snapshot["max_elements"].clone()), (json!(true), json!(2000), json!(80)));
        let captures = lines(&manager, "window_capture");
        let capture = &captures[0];
        assert_eq!((capture["max_width"].clone(), capture["quality"].clone(), capture["window_id"].clone()), (json!(1280), json!(55), json!("hwnd:0x2")));

        let text = texts(&parts);
        assert_eq!(text[0], "snap");
        let id = text[1].split("frame_id=").nth(1).and_then(|rest| rest.split(' ').next()).unwrap().to_string();
        assert!(text[1].ends_with(&format!("frame_id={id} window_id=hwnd:0x2; coordinates are pixels in this frame")), "{}", text[1]);
        assert!(matches!(parts[2], ToolPart::Image { width: Some(200), height: Some(100), .. }), "{parts:?}");

        // 400x200 physical at (100,-20) over a 200x100 image: pixel (100,50) is physical (300,80).
        let mut click = object(json!({"action": "click", "x": 100, "y": 50, "delivery": "foreground", "frame_id": id}));
        map_step(&backend.frames, &mut click).unwrap();
        assert_eq!((click["x"].clone(), click["y"].clone()), (json!(300), json!(80)));
        assert_eq!((click["observed_input_monitor_id"].clone(), click["observed_input_user_sequence"].clone()), (json!("m1"), json!(4)));
        assert_eq!(click["allowed_window_ids"], json!(["hwnd:0x2", "hwnd:0x9"]));
    }

    /// Other modes ask for 200 elements, and a capture without the image's own size covers the physical one.
    #[tokio::test]
    async fn an_ax_capture_asks_two_hundred_and_an_unscaled_frame_is_physical() {
        let manager = window(json!({"text": "snap"}), pixels(json!({})));
        let backend = state("capture-ax", &manager);
        backend.capture(command(json!({"mode": "ax"})), "", &CancellationToken::new()).await.unwrap();
        assert_eq!(lines(&manager, "snapshot")[0]["max_elements"], json!(200));
        assert!(lines(&manager, "window_capture").is_empty(), "ax reads no pixels");
        assert!(lines(&manager, "window_bounds").is_empty(), "an ax capture that names its window needs no bounds");

        let frame = frame_of(&object(json!({"x": 5, "y": 6, "width": 300, "height": 120})), "f", "hwnd:0x2", vec!["hwnd:0x2".into()], None).unwrap();
        assert_eq!((frame.origin_x, frame.origin_y, frame.capture_width, frame.capture_height), (5, 6, 300, 120));
        assert!(frame_of(&object(json!({"width": 0, "height": 10})), "f", "", Vec::new(), None).is_none());
    }

    #[test]
    fn element_budget_and_encoding_are_bounded_integers() {
        let input = object(json!({"max_elements": 1001, "maxWidth": 100, "quality": 55.5}));
        assert_eq!(bounded_integer(&input, "max_elements", 80, 1, 1000, "max_elements"), Err(ComputerError::InvalidInput { reason: "max_elements must be an integer from 1 to 1000".into() }));
        assert!(bounded_integer(&input, "maxWidth", 1280, 256, 3840, "maxWidth").is_err());
        assert!(bounded_integer(&input, "quality", 55, 0, 100, "quality").is_err());
        assert_eq!(bounded_integer(&input, "absent", 55, 0, 100, "quality"), Ok(55));
        assert_eq!(bounded_integer(&object(json!({"quality": 100.0})), "quality", 55, 0, 100, "quality"), Ok(100));
    }

    /// A provider that times out is asked once: the next plain read of the window is answered from the cache, with the cached
    /// account of the timeout, and an `ax` read asks again.
    #[tokio::test]
    async fn a_stalled_provider_is_not_asked_again_within_the_cool_down() {
        let manager = Scripted::new(|request| match request["action"].as_str() {
            Some("snapshot") => Err("computer_command_timeout: command exceeded 2500ms; the input host was restarted".into()),
            Some("input_idle_state") => Ok(json!({"observer_ready": true, "monitor": "m1", "sequence": 1})),
            Some("window_capture") => Ok(json!({"text": "cap", "x": 0, "y": 0, "width": 10, "height": 10, "image_base64": "aGk="})),
            _ => Ok(json!({"text": "ok"})),
        });
        let backend = state("capture-stall", &manager);
        let cancel = CancellationToken::new();
        let first = backend.capture(command(json!({})), "", &cancel).await.unwrap();
        assert!(texts(&first)[0].contains("\"accessibility_status\":\"error\""), "{first:?}");
        let second = backend.capture(command(json!({})), "", &cancel).await.unwrap();
        assert_eq!(lines(&manager, "snapshot").len(), 1, "the cool-down answers the second read");
        let notice = texts(&second)[0].clone();
        assert!(notice.contains("visual_only_cached") && notice.contains("cached result of an earlier accessibility timeout"), "{notice}");
        assert_eq!(lines(&manager, "window_capture").len(), 2, "pixels are read each time");

        let refused = backend.capture(command(json!({"mode": "ax"})), "", &cancel).await.unwrap_err();
        assert!(matches!(refused, ComputerError::Failed { ref message, .. } if message.starts_with("computer_command_timeout")), "{refused:?}");
        assert_eq!(lines(&manager, "snapshot").len(), 2, "an ax read asks the provider again");
    }

    /// A chrome-only answer earns one content re-read, and only one.
    #[tokio::test]
    async fn a_chrome_only_answer_is_read_once_more() {
        let manager = window(
            json!({"text": "snap", "total_elements": 1, "elements": [{"role": "Window", "enabled": true, "x": 0, "y": 0, "width": 100, "height": 100, "actions": ["click"]}]}),
            pixels(json!({})),
        );
        let backend = state("capture-reread", &manager);
        backend.capture(command(json!({})), "", &CancellationToken::new()).await.unwrap();
        assert_eq!(lines(&manager, "snapshot").len(), 2);
        backend.capture(command(json!({"query": "ok"})), "", &CancellationToken::new()).await.unwrap();
        assert_eq!(lines(&manager, "snapshot").len(), 3, "a narrowed query is not read again");
    }

    #[test]
    fn the_reread_decision_follows_analysis_ts() {
        // chrome only, state or som, nothing asked for OCR or narrowed: read again
        assert!(should_reread("state", false, "", 3, false, false));
        assert!(should_reread("som", false, "", 1, false, false));
        // content found, an error, OCR asked, a filtered read, another mode, an empty tree: no
        assert!(!should_reread("state", true, "", 3, false, false));
        assert!(!should_reread("state", false, "boom", 3, false, false));
        assert!(!should_reread("state", false, "", 3, true, false));
        assert!(!should_reread("state", false, "", 3, false, true));
        assert!(!should_reread("ax", false, "", 3, false, false));
        assert!(!should_reread("state", false, "", 0, false, false));
    }

    #[test]
    fn content_is_a_surface_with_text_or_an_action_inside_one() {
        let button = |x, y| element("Button", x, y, 40.0, 20.0, "", &["click"]);
        // chrome alone: a Window with no action, or a button confined to the menu strip of the frame
        assert!(!has_semantic_target(&[element("Window", 0.0, 0.0, 800.0, 600.0, "", &["click"])], None));
        assert!(!has_semantic_target(&[button(10.0, 10.0)], Some((0.0, 600.0))));
        assert!(has_semantic_target(&[button(10.0, 300.0)], Some((0.0, 600.0))));
        assert!(has_semantic_target(&[button(10.0, 10.0)], None));
        // an editor surface that quotes text is already read; one without needs an action inside it
        let surface = |value: &str| element("Document", 0.0, 100.0, 800.0, 500.0, value, &[]);
        assert!(has_semantic_target(&[surface("hello")], None));
        assert!(!has_semantic_target(&[surface(" "), button(10.0, 10.0)], None));
        assert!(has_semantic_target(&[surface(" "), button(10.0, 300.0)], None));
        assert!(!has_semantic_target(&[], None));
    }

    /// Timeouts double the wait to the ceiling and never become empty-tree counts; two empty trees skip the window once.
    #[test]
    fn the_visual_only_cache_learns_timeouts_and_empty_trees() {
        let mut cache = VisualOnly(Vec::new());
        let now = Instant::now();
        let timeout = "computer_command_timeout: stalled";
        cache.record("w", None, false, timeout, 0, now);
        let first = cache.resolve("w", now + Duration::from_secs(29));
        assert!(first.hit && first.cached_error == CACHED_TIMEOUT_ERROR);
        assert!(!cache.resolve("w", now + Duration::from_secs(31)).hit, "30 s after the first timeout the window is read again");

        let mut cache = VisualOnly(Vec::new());
        cache.record("w", None, false, timeout, 0, now);
        let previous = cache.resolve("w", now + Duration::from_secs(31)).capability;
        cache.record("w", previous.as_ref(), false, timeout, 0, now);
        assert_eq!(cache.0[0].1.misses, 2);
        assert_eq!(cache.0[0].1.expires, Some(now + Duration::from_secs(60)));
        let mut previous = cache.0[0].1.clone();
        for _ in 0..4 {
            cache.record("w", Some(&previous), false, timeout, 0, now);
            previous = cache.0[0].1.clone();
        }
        assert_eq!(cache.0[0].1.expires, Some(now + VISUAL_ONLY_TIMEOUT_MAX_TTL));

        let mut cache = VisualOnly(Vec::new());
        cache.record("e", None, false, "", 0, now);
        assert_eq!(cache.0[0].1.expires, None, "one empty tree is not enough");
        let previous = cache.0[0].1.clone();
        cache.record("e", Some(&previous), false, "", 0, now);
        assert_eq!(cache.0[0].1.expires, Some(now + VISUAL_ONLY_TTL));
        cache.record("e", None, true, "", 3, now);
        assert!(cache.0.is_empty(), "content forgets the window");
        cache.record("e", None, false, "other failure", 0, now);
        assert!(cache.0.is_empty(), "an error that is not a timeout teaches nothing");
    }

    #[test]
    fn only_a_plain_read_may_use_the_cache() {
        let plain = object(json!({}));
        assert!(visual_only_eligible(&plain, "state", "w"));
        assert!(!visual_only_eligible(&plain, "state", ""));
        assert!(!visual_only_eligible(&plain, "ax", "w"));
        assert!(visual_only_eligible(&object(json!({"observation_after": true})), "ax", "w"));
        assert!(!visual_only_eligible(&object(json!({"query": "x"})), "state", "w"));
        assert!(!visual_only_eligible(&object(json!({"include_structure": true})), "som", "w"));
        assert!(!visual_only_eligible(&plain, "vision", "w"));
    }

    fn read(ready: bool, monitor: &str, sequence: i64, reason: Option<&str>, target: Option<i64>) -> Observation {
        Observation { ready, monitor: monitor.into(), sequence, reason: reason.map(str::to_string), target_sequence: target }
    }

    #[test]
    fn foreground_input_needs_a_quiet_observer_across_the_capture() {
        let quiet = read(true, "m", 5, None, Some(5));
        let idle = settle_input(Some(&quiet), Some(&quiet)).unwrap();
        assert_eq!((idle.ready, idle.reason, idle.sequence), (true, None, 5));
        // input into another process leaves it ready; input that reached the window does not
        assert!(settle_input(Some(&quiet), Some(&read(true, "m", 9, None, Some(5)))).unwrap().ready);
        let user = settle_input(Some(&quiet), Some(&read(true, "m", 9, None, Some(7)))).unwrap();
        assert_eq!((user.ready, user.reason.as_deref()), (false, Some("user_input_during_capture")));
        // an observer that is not ready, or unreadable, is unavailable; one still in a gap is input arriving
        let down = settle_input(Some(&quiet), None).unwrap();
        assert_eq!(down.reason.as_deref(), Some("input_observer_unavailable"));
        let gap = read(false, "m", 5, Some("input_gap"), None);
        assert_eq!(settle_input(Some(&gap), Some(&gap)).unwrap().reason.as_deref(), Some("user_input_during_capture"));
        assert_eq!(settle_input(Some(&read(false, "m", 5, Some("warming"), None)), Some(&quiet)).unwrap().reason.as_deref(), Some("input_observer_unavailable"));
        assert!(settle_input(None, Some(&quiet)).is_none());
    }

    #[test]
    fn a_gap_that_recovers_keeps_the_first_read_only_if_input_arrived() {
        let gap = read(false, "m", 6, Some("input_gap"), None);
        let ready = read(true, "m", 6, None, None);
        assert_eq!(settle_reads(vec![Some(gap.clone()), Some(ready.clone())]), Some(ready.clone()));
        assert_eq!(settle_reads(vec![Some(gap.clone()), Some(read(true, "m", 8, None, None))]), Some(gap));
        assert_eq!(settle_reads(vec![None, Some(ready.clone())]), Some(ready));
        assert_eq!(settle_reads(vec![Some(read(true, "m", 1, None, None)), None]), None);
        let seen = Observation::of(&object(json!({"monitor": "m", "sequence": 3, "observer_ready": false, "observer_reason": "input_gap", "target_sequence": 2})));
        assert_eq!(seen, Some(read(false, "m", 3, Some("input_gap"), Some(2))));
        assert_eq!(Observation::of(&object(json!({"monitor": "", "sequence": 3}))), None);
        assert_eq!(Observation::of(&object(json!({"monitor": "m", "sequence": -1}))), None);
    }

    /// A capture whose native release is not confirmed retires the helper (the next read starts a new one) and, when the helper
    /// refused it, reports the release as the failure.
    #[tokio::test]
    async fn an_unconfirmed_cleanup_retires_the_helper() {
        let manager = window(json!({"text": "snap"}), pixels(json!({"capture_cleanup": {"status": "unconfirmed"}})));
        let backend = state("capture-cleanup", &manager);
        backend.capture(command(json!({"mode": "vision"})), "", &CancellationToken::new()).await.unwrap();
        assert_eq!(manager.starts(), 2, "the observer read after the capture started the replacement helper");

        let failure = HelperFailure { text: "capture_cleanup_failed|window capture resources did not all close".into(), result: Some(object(json!({"capture_cleanup": {"status": "failed"}}))) };
        assert!(cleanup_unconfirmed(&Err(failure)));
        assert!(!cleanup_unconfirmed(&Err(HelperFailure { text: "x".into(), result: None })));
        assert!(!cleanup_unconfirmed(&Ok(object(json!({"capture_cleanup": {"status": "confirmed"}})))));
        assert!(cleanup_unconfirmed(&Ok(object(json!({"capture_cleanup": {"status": "unknown"}})))));
        assert_eq!(
            cleanup_failed(),
            ComputerError::Failed { code: "capture_cleanup_failed".into(), message: "capture_cleanup_failed: native capture release was not confirmed".into() }
        );
    }

    /// A window capture leaves the helper no more than 4500 ms: two native attempts of 2000 ms and the time to release them.
    #[test]
    fn the_capture_deadline_holds_two_native_attempts() {
        assert_eq!(CAPTURE_TIMEOUT, Duration::from_millis(4_500));
        assert!(CAPTURE_TIMEOUT >= Duration::from_millis(2 * 2_000));
        assert_eq!(ACCESSIBILITY_TIMEOUT, Duration::from_millis(2_500));
    }

    /// A helper whose every snapshot is the next generation of eight rows; from the second on the fourth row has changed.
    fn ticking() -> Arc<Scripted> {
        let generation = std::sync::atomic::AtomicUsize::new(0);
        Scripted::new(move |request| match request["action"].as_str() {
            Some("input_idle_state") => Ok(json!({"observer_ready": true, "monitor": "m1", "sequence": 4, "target_sequence": 4})),
            Some("snapshot") => {
                let generation = generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let rows: Vec<Value> = (0..8)
                    .map(|n| {
                        let name = if generation > 1 && n == 3 { "Done".to_owned() } else { format!("Item {n}") };
                        json!({"mark": n + 1, "ref": format!("s{generation}:e{n}"), "role": "Button", "name": name, "value": "", "state": "", "enabled": true,
                               "x": 10, "y": 10 + n * 30, "width": 80, "height": 20, "actions": ["click"]})
                    })
                    .collect();
                let lines: Vec<String> = rows.iter().map(|row| format!("[{}] Button \"{}\" @50,50", row["ref"].as_str().unwrap(), row["name"].as_str().unwrap())).collect();
                Ok(json!({"text": format!("Window: T [hwnd:0x2]\nElements: total=8 generation={generation}\n{}", lines.join("\n")),
                          "window_id": "hwnd:0x2", "generation": generation, "total_elements": 8, "elements": rows}))
            }
            _ => Ok(json!({"text": "ok"})),
        })
    }

    /// The capture that follows an action (`observation_delta`) names the rows still on screen by their refs and lists only what
    /// changed; a capture that did not ask is the full list, and a capture compared with the last one says what changed.
    #[tokio::test]
    async fn the_observation_delta_replaces_the_rows_that_did_not_change() {
        let backend = state("delta", &ticking());
        let ask = |delta: bool| command(json!({"mode": "ax", "observation_delta": delta}));
        let first = texts(&backend.capture(ask(true), "", &CancellationToken::new()).await.unwrap()).remove(0);
        assert!(first.contains("[s1:e0] Button \"Item 0\"") && !first.contains("Elements delta"), "nothing is held yet: {first}");

        let second = texts(&backend.capture(ask(true), "", &CancellationToken::new()).await.unwrap()).remove(0);
        assert!(second.contains("Elements delta: ") && second.contains("Done"), "{second}");
        assert!(!second.contains("[s2:e0] Button \"Item 0\""), "an unchanged row is not listed again: {second}");
        assert!(second.starts_with("Window: T [hwnd:0x2]\nElements: total=8 generation=2\nElements delta: "), "{second}");
        assert!(second.contains("Changes since the last capture: "), "{second}");

        let third = texts(&backend.capture(ask(false), "", &CancellationToken::new()).await.unwrap()).remove(0);
        assert!(third.contains("[s3:e0] Button \"Item 0\"") && !third.contains("Elements delta"), "a capture that did not ask is the full list: {third}");
    }

    /// A set-of-marks read always goes in full, whatever the command asked.
    #[tokio::test]
    async fn a_marks_read_is_never_a_delta() {
        let backend = state("delta-som", &ticking());
        let pixels_free = |mode: &str| command(json!({"mode": mode, "observation_delta": true}));
        backend.capture(pixels_free("ax"), "", &CancellationToken::new()).await.unwrap();
        let again = texts(&backend.capture(pixels_free("ax"), "", &CancellationToken::new()).await.unwrap()).remove(0);
        assert!(again.contains("Elements delta"), "{again}");
        let mut marks = pixels_free("som");
        marks.insert("max_elements".into(), json!(80));
        let full = texts(&backend.capture(marks, "", &CancellationToken::new()).await.unwrap()).remove(0);
        assert!(!full.contains("Elements delta") && full.contains("Item 0"), "{full}");
    }

    #[test]
    fn the_lines_of_the_cut_rows_leave_the_text() {
        let shown = "Window\n[e1] Button \"a\"\n[e2] Button \"b\"\n[e10] Text \"c\"\nfooter";
        assert_eq!(without_element_lines(shown, &["e2".to_string()]), "Window\n[e1] Button \"a\"\n[e10] Text \"c\"\nfooter");
        assert_eq!(without_element_lines(shown, &["e2".to_string(), "e10".to_string(), "e1".to_string()]), "Window\nfooter");
    }

    /// The marks of a frame are the snapshot's elements in its pixels, clipped to it; one entirely outside is not drawn.
    #[test]
    fn the_marks_are_the_elements_in_the_frames_pixels() {
        let frame = frame_of(&object(json!({"x": 100, "y": -20, "width": 400, "height": 200, "image_width": 200, "image_height": 100})), "f", "hwnd:0x2", Vec::new(), None).unwrap();
        let snapshot = object(json!({"elements": [
            {"mark": 1, "x": 120, "y": 100, "width": 50, "height": 20, "source": "uia"},
            {"mark": 2, "x": 1000, "y": 100, "width": 50, "height": 20},
            {"mark": 3, "x": 90, "y": 100, "width": 60, "height": 20, "source": "msaa"},
        ]}));
        let marks = som_marks(&snapshot, &frame);
        assert_eq!(marks.iter().map(|mark| (mark.mark, mark.bounds, mark.source)).collect::<Vec<_>>(), vec![
            (1, [10.0, 60.0, 25.0, 10.0], MarkSource::Uia),
            (3, [0.0, 60.0, 25.0, 10.0], MarkSource::Msaa),
        ]);
    }

    #[test]
    fn the_overlay_fields_join_the_capture_reply() {
        let overlay = Marked { rendered: true, error: None, ms: 7 };
        let mut plain = vec![ToolPart::Text("snap".into())];
        overlay.record(&mut plain);
        let [ToolPart::Text(first), ToolPart::Text(fields)] = plain.as_slice() else { panic!("{plain:?}") };
        assert_eq!((first.as_str(), serde_json::from_str::<Value>(fields).unwrap()), ("snap", json!({"overlay_rendered": true, "overlay_ms": 7})));
        let mut payload = vec![ToolPart::Text(json!({"mode": "som"}).to_string())];
        Marked { rendered: false, error: Some("no paint".into()), ms: 1 }.record(&mut payload);
        let [ToolPart::Text(only)] = payload.as_slice() else { panic!("{payload:?}") };
        assert_eq!(serde_json::from_str::<Value>(only).unwrap(), json!({"mode": "som", "overlay_rendered": false, "overlay_error": "no paint", "overlay_ms": 1}));
    }

    /// A frame the overlay cannot draw on keeps its pixels, and the reply says why.
    #[test]
    fn a_frame_that_cannot_be_marked_keeps_its_pixels() {
        let frame = frame_of(&object(json!({"x": 0, "y": 0, "width": 200, "height": 100})), "f", "hwnd:0x2", Vec::new(), None).unwrap();
        let snapshot = object(json!({"elements": [{"mark": 1, "x": 10, "y": 10, "width": 50, "height": 20}]}));
        let mut parts = vec![ToolPart::Text("frame".into()), ToolPart::Image { mime: "image/jpeg".into(), data: ImageData::Bytes(b"not a jpeg".to_vec()), width: Some(200), height: Some(100) }];
        let overlay = mark_frame(&mut parts, Some(&snapshot), &[], &frame, 55).expect("the reason");
        assert!(!overlay.rendered && overlay.error.is_some(), "{overlay:?}");
        assert!(matches!(&parts[1], ToolPart::Image { data: ImageData::Bytes(bytes), .. } if bytes == b"not a jpeg"));
        let empty = mark_frame(&mut parts, Some(&object(json!({"elements": []}))), &[], &frame, 55).expect("an overlay that drew nothing");
        assert!(!empty.rendered && empty.error.is_none(), "no element, nothing drawn, nothing to say: {empty:?}");
        assert!(mark_frame(&mut parts, None, &[], &frame, 55).is_none(), "no read and no word: nothing to draw");
    }

    /// The OCR words listed after the elements are outlined too, in the frame's pixels, clipped to it.
    #[test]
    fn ocr_words_are_marked_inside_the_frame() {
        let frame = frame_of(&object(json!({"x": 0, "y": 0, "width": 200, "height": 100})), "f", "hwnd:0x2", Vec::new(), None).unwrap();
        let marks = word_marks(&[(3, [10, 20, 40, 12]), (4, [190, 90, 40, 30]), (5, [300, 10, 5, 5]), (6, [-5, -5, 3, 3])], &frame);
        assert_eq!(marks.iter().map(|mark| (mark.mark, mark.source)).collect::<Vec<_>>(), [(3, MarkSource::Ocr), (4, MarkSource::Ocr)]);
        assert_eq!(marks[0].bounds, [10.0, 20.0, 40.0, 12.0]);
        assert_eq!(marks[1].bounds, [190.0, 90.0, 10.0, 10.0], "a word past the edge is clipped");
    }

    fn two_displays() -> Value {
        json!([
            {"index": 0, "id": "11", "primary": true, "scale_factor": 1.0, "width": 1280, "height": 720, "x": 0, "y": 0},
            {"index": 1, "id": "12", "primary": false, "scale_factor": 1.0, "width": 1920, "height": 1080, "x": -1920, "y": -200},
        ])
    }

    fn display_pixels() -> Value {
        json!({
            "blob": {"digest": "sha256:aaaa", "byteLength": 4, "mimeType": "image/jpeg"},
            "captureWidth": 960, "captureHeight": 540,
            "source": {"x": -1920, "y": -200, "width": 1920, "height": 1080, "scaleFactor": 1.0, "displayId": "12", "windowId": null},
            "backend": "screen", "capturedAt": 1.0, "attempts": [],
        })
    }

    fn with_screen_desktop(config: ComputerConfig) -> (ProcessComputerBackend, Arc<super::super::computer_pixels::fakes::Desktop>) {
        use super::super::computer_backend::ComputerShared;
        use super::super::computer_pixels::ComputerBlobs;
        use super::super::computer_pixels::fakes::Blobs;
        use super::super::computer_pixels::fakes::Desktop;
        let desktop = Arc::new(Desktop::new(two_displays(), display_pixels()));
        let blobs: Arc<dyn ComputerBlobs> = Arc::new(Blobs([("sha256:aaaa".to_owned(), b"jpeg".to_vec())].into()));
        let backend = ProcessComputerBackend::new(config, Scripted::new(|_| Ok(json!({"text": "ok"})))).with_shared(ComputerShared { blobs: Some(blobs), ..ComputerShared::default() }).with_desktop(desktop.clone());
        (backend, desktop)
    }

    /// A capture of a display is read through the desktop's pixels and the core's blob store, and the frame it makes is the one a click
    /// or a zoom names; the desktop is never asked for `host/computer/capture`.
    #[tokio::test]
    async fn a_display_capture_issues_a_frame_from_the_desktops_pixels() {
        let (backend, desktop) = with_screen_desktop(ComputerConfig::new("helper", "screen-1"));
        let parts = backend.capture(command(json!({"screen": 1, "mode": "vision"})), "vision", &CancellationToken::new()).await.unwrap();
        let reply: Value = serde_json::from_str(&texts(&parts)[0]).unwrap();
        assert_eq!((reply["action"].clone(), reply["mode"].clone(), reply["screen"].clone()), (json!("capture"), json!("vision"), json!(1)));
        let frame = reply["frame_id"].as_str().unwrap();
        assert!(backend.frames.display_of(frame).is_some(), "the frame is a display's");
        assert!(matches!(parts[1], ToolPart::Image { width: Some(960), height: Some(540), .. }), "{parts:?}");
        let asked: Vec<String> = desktop.asked.lock().unwrap().iter().map(|(method, _)| method.clone()).collect();
        assert_eq!(asked, ["host/computer/displays", "host/computer/pixels"]);
    }

    /// With no blob store attached the pixels of a display cannot be read, and the capture says so.
    #[tokio::test]
    async fn a_display_capture_without_a_blob_store_is_unavailable() {
        let (backend, _) = with_screen_desktop(ComputerConfig::new("helper", "screen-2"));
        let bare = ProcessComputerBackend::new(ComputerConfig::new("helper", "screen-3"), Scripted::new(|_| Ok(json!({"text": "ok"})))).with_desktop(backend.desktop().unwrap().clone());
        let error = bare.capture(command(json!({"screen": 0, "mode": "vision"})), "vision", &CancellationToken::new()).await.unwrap_err();
        assert!(matches!(error, ComputerError::Unavailable { reason } if reason.contains("blob store")), "no blob store");
    }

    /// `image_output: "file"` moves the pixels to a file the host names; the reply carries its path and size. Where nothing can be
    /// written the frame stays inline.
    #[tokio::test]
    async fn image_output_moves_the_pixels_to_a_file() {
        let data = tempfile::tempdir().unwrap();
        let config = ComputerConfig { data_dir: Some(data.path().to_path_buf()), ..ComputerConfig::new("helper", "screen-4") };
        let (backend, _) = with_screen_desktop(config);
        let parts = backend.capture(command(json!({"screen": 1, "mode": "vision", "image_output": "file"})), "vision", &CancellationToken::new()).await.unwrap();
        assert!(parts.iter().all(|part| !matches!(part, ToolPart::Image { .. })), "the pixels left the reply: {parts:?}");
        let reply: Value = serde_json::from_str(&texts(&parts)[0]).unwrap();
        let file = reply["image_file"]["path"].as_str().expect("the file's path");
        assert!(file.starts_with(&*data.path().to_string_lossy()), "{file}");
        assert_eq!((std::fs::read(file).unwrap(), reply["image_file"]["bytes"].clone(), reply["image_file"]["mime_type"].clone()), (b"jpeg".to_vec(), json!(4), json!("image/jpeg")));

        let (inline, _) = with_screen_desktop(ComputerConfig::new("helper", "screen-5"));
        let parts = inline.capture(command(json!({"screen": 1, "mode": "vision", "image_output": "file"})), "vision", &CancellationToken::new()).await.unwrap();
        assert!(parts.iter().any(|part| matches!(part, ToolPart::Image { .. })), "no data directory, no file: the frame stays");
    }
}
