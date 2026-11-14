//! Owner: s4-engine-reply
//! A screenshot in the reply (`reply-screenshot.ts`, and the persisting part of `frame-files.ts`). It is bound to the snapshot it
//! was taken with, so coordinates read off the image can be trusted against that snapshot id: a page that changed between the two
//! is refused, and a full-page capture is inspection only and binds nothing. The picture goes into the reply, or beside the run
//! when the caller asked to keep pixels out of the conversation; a frame that cannot go to a file stays in the reply rather than
//! disappearing.
//!
//! The host hands a screenshot over inline (base64, 128 KiB or less) or by blob digest; [`read_capture`] reads either into bytes.
//! The file's name and the pruning of old frames are the [`FilePort`] implementation's, which writes into the folder given.

use std::path::Path;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use mixdog_app_protocol::v2::browser_engine::HostBrowserScreenshotResult;

use crate::port::BlobPort;
use crate::port::FilePort;
use crate::refs::grounding::VisualGrounding;
use crate::refs::ref_set::RefSet;

use super::reply::ReplyError;
use super::reply::ReplyImage;
use super::reply::ToolReply;

/// The most an image may weigh inline in a reply: the tool output refuses a larger one.
pub const MAX_INLINE_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// The most a frame file may hold (`FRAME_MAX_BYTES` of `frame-files.ts`).
pub const FRAME_MAX_BYTES: usize = 100 * 1024 * 1024;

/// A screenshot the host took, read into bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct CapturedScreenshot {
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    /// The capture covers the whole page, not the viewport.
    pub full_page: bool,
    pub bytes: Bytes,
}

/// Where the picture goes (`image_output` of the command).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ImageOutput {
    #[default]
    Inline,
    File,
}

impl ImageOutput {
    /// `image_output` as the command carried it: only `file` moves the pixels out of the reply.
    pub fn from_command(value: Option<&str>) -> Self {
        if value == Some("file") { Self::File } else { Self::Inline }
    }
}

/// The picture of a `host/browser/screenshot` result: the inline data, else the blob read by its digest.
pub async fn read_capture(result: &HostBrowserScreenshotResult, full_page: bool, blobs: &dyn BlobPort) -> Result<CapturedScreenshot, ReplyError> {
    let bytes = if let Some(data) = &result.data {
        Bytes::from(STANDARD.decode(data).map_err(|_| ReplyError::new("browser screenshot answered a picture that is not valid base64"))?)
    } else if let Some(blob) = &result.blob {
        blobs.read(&blob.digest).await.map_err(|error| ReplyError::new(format!("browser screenshot could not be read: {error}")))?
    } else {
        return Err(ReplyError::new("browser screenshot answered no picture"));
    };
    Ok(CapturedScreenshot { mime_type: result.mime_type.clone(), width: result.width, height: result.height, full_page, bytes })
}

/// A frame may go to a file when it is not empty and not above the file budget (`frameImageFitsFileBudget`).
fn fits_file_budget(length: usize) -> bool {
    length > 0 && length <= FRAME_MAX_BYTES
}

/// Where a screenshot goes: into the reply, or beside the run when the caller asked to keep pixels out of the conversation
/// (`attachFrame`). A frame that cannot be written to a file stays in the reply.
pub async fn attach_frame(files: &dyn FilePort, reply: &mut ToolReply, output: ImageOutput, frame_dir: &Path, capture: &CapturedScreenshot) -> Result<(), ReplyError> {
    let length = capture.bytes.len();
    if output == ImageOutput::File && fits_file_budget(length) {
        let path = files.write_frame(frame_dir, capture.bytes.clone()).await;
        reply.text.push_str(&format!("\n\nFrame written to {} ({length} bytes).", path.display()));
        return Ok(());
    }
    if length > MAX_INLINE_IMAGE_BYTES {
        return Err(ReplyError::new(format!(
            "browser screenshot is {length} bytes; an image in the reply may weigh {MAX_INLINE_IMAGE_BYTES} bytes at most. Use image_output:file to keep the pixels beside the run"
        )));
    }
    reply.image = Some(ReplyImage { mime_type: capture.mime_type.clone(), bytes: capture.bytes.clone() });
    Ok(())
}

/// A screenshot to put in a reply, with what it is bound to.
pub struct ScreenshotInput<'a> {
    pub capture: &'a CapturedScreenshot,
    /// The refs of the snapshot the screenshot belongs to (the page's latest when the capture began); `None` when the page has none.
    pub bound: Option<&'a RefSet>,
    /// The page's latest refs now, after the capture.
    pub latest: Option<&'a RefSet>,
    pub output: ImageOutput,
    /// The folder frames of this surface are written to.
    pub frame_dir: &'a Path,
    pub now: Instant,
}

/// The screenshot of a reply, bound to the fresh snapshot (`attachScreenshot`): the text says what the image is, a viewport capture
/// becomes the page's visual grounding (`reply.grounding`), and the picture is attached.
pub async fn attach_screenshot(files: &dyn FilePort, reply: &mut ToolReply, input: ScreenshotInput<'_>) -> Result<(), ReplyError> {
    let Some(bound) = input.bound else {
        return Err(ReplyError::new("browser screenshot could not bind to the fresh snapshot"));
    };
    if input.latest.map(|latest| latest.snapshot_id.as_str()) != Some(bound.snapshot_id.as_str()) {
        return Err(ReplyError::new("page changed during screenshot capture; take a fresh snapshot"));
    }
    let capture = input.capture;
    if capture.full_page {
        reply.text.push_str(&format!("\n\nFull-page screenshot: {}x{} px; inspection-only and not coordinate-bound.", capture.width, capture.height));
    } else {
        reply.grounding = Some(VisualGrounding::bind(bound, f64::from(capture.width), f64::from(capture.height), input.now));
        reply.text.push_str(&format!(
            "\n\nVisual screenshot: {} is {}x{} image px; viewport {}x{} CSS px. Coordinate actions require this snapshotId and use image-pixel coordinates.",
            bound.snapshot_id,
            capture.width,
            capture.height,
            mixdog_js::number_to_string(bound.viewport_width),
            mixdog_js::number_to_string(bound.viewport_height)
        ));
    }
    attach_frame(files, reply, input.output, input.frame_dir, capture).await
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;
    use crate::types::FileFacts;

    #[derive(Default)]
    struct Frames(Mutex<Vec<(PathBuf, usize)>>);

    #[async_trait]
    impl FilePort for Frames {
        async fn stat(&self, _path: &Path) -> FileFacts {
            FileFacts::default()
        }

        async fn write_frame(&self, run_dir: &Path, bytes: Bytes) -> PathBuf {
            self.0.lock().unwrap().push((run_dir.to_path_buf(), bytes.len()));
            run_dir.join("frame.png")
        }
    }

    struct Blobs(Result<Bytes, String>);

    #[async_trait]
    impl BlobPort for Blobs {
        async fn read(&self, _digest: &str) -> Result<Bytes, String> {
            self.0.clone()
        }
    }

    fn set(id: &str) -> RefSet {
        let mut loaded = payload(id, vec![element(&format!("{id}-e1"), "button", "Go")], "https://a.test/");
        loaded.viewport_width = 800.0;
        loaded.viewport_height = 600.0;
        RefSet::from_payload(id, &loaded)
    }

    fn capture(bytes: &[u8], full_page: bool) -> CapturedScreenshot {
        CapturedScreenshot { mime_type: "image/png".into(), width: 1600, height: 1200, full_page, bytes: Bytes::copy_from_slice(bytes) }
    }

    fn input<'a>(capture: &'a CapturedScreenshot, bound: Option<&'a RefSet>, latest: Option<&'a RefSet>, output: ImageOutput) -> ScreenshotInput<'a> {
        ScreenshotInput { capture, bound, latest, output, frame_dir: Path::new("frames"), now: Instant::now() }
    }

    fn result(patch: serde_json::Value) -> HostBrowserScreenshotResult {
        let mut value = json!({"mimeType": "image/png", "width": 4, "height": 3, "facts": crate::fake::page_facts("p1", 1)});
        if let (Some(target), Some(extra)) = (value.as_object_mut(), patch.as_object()) {
            target.extend(extra.clone());
        }
        serde_json::from_value(value).expect("screenshot result")
    }

    #[tokio::test]
    async fn a_capture_is_read_from_its_inline_data_or_its_blob() {
        let none = Blobs(Err("unused".into()));
        let inline = read_capture(&result(json!({"data": STANDARD.encode(b"png bytes")})), false, &none).await.unwrap();
        assert_eq!((inline.bytes.as_ref(), inline.width, inline.height, inline.full_page), (&b"png bytes"[..], 4, 3, false));
        let blob = json!({"blob": {"digest": "sha256:ab", "size": 3}});
        let stored = read_capture(&result(blob.clone()), true, &Blobs(Ok(Bytes::from_static(b"big")))).await.unwrap();
        assert_eq!((stored.bytes.as_ref(), stored.full_page), (&b"big"[..], true));
        let lost = read_capture(&result(blob), false, &Blobs(Err("gone".into()))).await.unwrap_err();
        assert_eq!(lost.message, "browser screenshot could not be read: gone");
        assert_eq!(read_capture(&result(json!({})), false, &none).await.unwrap_err().message, "browser screenshot answered no picture");
        assert!(read_capture(&result(json!({"data": "***"})), false, &none).await.is_err());
    }

    #[tokio::test]
    async fn a_viewport_screenshot_is_bound_to_its_snapshot_and_rides_in_the_reply() {
        let frames = Frames::default();
        let refs = set("p-s1");
        let shot = capture(b"pixels", false);
        let mut reply = ToolReply::text("page");
        attach_screenshot(&frames, &mut reply, input(&shot, Some(&refs), Some(&refs), ImageOutput::Inline)).await.unwrap();
        assert_eq!(
            reply.text,
            "page\n\nVisual screenshot: p-s1 is 1600x1200 image px; viewport 800x600 CSS px. Coordinate actions require this snapshotId and use image-pixel coordinates."
        );
        assert_eq!(reply.image, Some(ReplyImage { mime_type: "image/png".into(), bytes: Bytes::from_static(b"pixels") }));
        let grounding = reply.grounding.expect("grounding");
        assert_eq!((grounding.snapshot_id.as_str(), grounding.image_width, grounding.viewport_height), ("p-s1", 1600.0, 600.0));
        assert!(frames.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_full_page_screenshot_is_inspection_only_and_binds_nothing() {
        let refs = set("p-s1");
        let shot = capture(b"pixels", true);
        let mut reply = ToolReply::default();
        attach_screenshot(&Frames::default(), &mut reply, input(&shot, Some(&refs), Some(&refs), ImageOutput::Inline)).await.unwrap();
        assert_eq!(reply.text, "\n\nFull-page screenshot: 1600x1200 px; inspection-only and not coordinate-bound.");
        assert!(reply.grounding.is_none() && reply.image.is_some());
    }

    #[tokio::test]
    async fn a_page_that_changed_during_the_capture_or_has_no_snapshot_is_refused() {
        let (before, after) = (set("p-s1"), set("p-s2"));
        let shot = capture(b"pixels", false);
        let frames = Frames::default();
        let mut moved = ToolReply::default();
        let changed = attach_screenshot(&frames, &mut moved, input(&shot, Some(&before), Some(&after), ImageOutput::Inline)).await.unwrap_err();
        assert_eq!(changed.message, "page changed during screenshot capture; take a fresh snapshot");
        let mut gone = ToolReply::default();
        assert!(attach_screenshot(&frames, &mut gone, input(&shot, Some(&before), None, ImageOutput::Inline)).await.is_err());
        let mut unbound = ToolReply::default();
        let refused = attach_screenshot(&frames, &mut unbound, input(&shot, None, None, ImageOutput::Inline)).await.unwrap_err();
        assert_eq!(refused.message, "browser screenshot could not bind to the fresh snapshot");
        assert!(moved.image.is_none() && moved.grounding.is_none() && moved.text.is_empty());
    }

    #[tokio::test]
    async fn image_output_file_keeps_the_pixels_out_of_the_reply() {
        let frames = Frames::default();
        let refs = set("p-s1");
        let shot = capture(b"pixels", false);
        let mut reply = ToolReply::default();
        attach_screenshot(&frames, &mut reply, input(&shot, Some(&refs), Some(&refs), ImageOutput::File)).await.unwrap();
        assert!(reply.image.is_none());
        assert!(reply.text.ends_with(&format!("\n\nFrame written to {} (6 bytes).", Path::new("frames").join("frame.png").display())), "{}", reply.text);
        assert_eq!(*frames.0.lock().unwrap(), vec![(PathBuf::from("frames"), 6)]);
    }

    #[tokio::test]
    async fn a_frame_too_large_for_a_file_or_a_reply_is_not_lost_silently() {
        let frames = Frames::default();
        let mut empty = ToolReply::default();
        attach_frame(&frames, &mut empty, ImageOutput::File, Path::new("frames"), &capture(b"", false)).await.unwrap();
        assert!(empty.image.is_some() && frames.0.lock().unwrap().is_empty(), "an empty frame is not written; it stays inline");
        let huge = capture(&vec![0u8; MAX_INLINE_IMAGE_BYTES + 1], false);
        let mut inline = ToolReply::default();
        let refused = attach_frame(&frames, &mut inline, ImageOutput::Inline, Path::new("frames"), &huge).await.unwrap_err();
        assert!(refused.message.starts_with(&format!("browser screenshot is {} bytes;", MAX_INLINE_IMAGE_BYTES + 1)), "{}", refused.message);
        let mut filed = ToolReply::default();
        attach_frame(&frames, &mut filed, ImageOutput::File, Path::new("frames"), &huge).await.unwrap();
        assert!(filed.image.is_none() && filed.text.contains("Frame written to"));
        assert_eq!(ImageOutput::from_command(Some("file")), ImageOutput::File);
        assert_eq!(ImageOutput::from_command(Some("inline")), ImageOutput::Inline);
        assert_eq!(ImageOutput::from_command(None), ImageOutput::Inline);
    }
}
