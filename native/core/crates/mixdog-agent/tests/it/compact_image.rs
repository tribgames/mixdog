//! Tool-result image compaction: the display box and the size note that supersedes the earlier one, the quality steps, the images kept as they are, and the hand-over of
//! every image to the attachment store (no image becomes text).
//! The decoder is the host's; these tests drive the pipeline through a scripted one.

use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::image::CodecError;
use mixdog_agent::compact::image::Encoded;
use mixdog_agent::compact::image::ImageCodec;
use mixdog_agent::compact::image::ImageSize;
use mixdog_agent::compact::image::ToolImageCompactor;
use mixdog_agent::compact::image::superseding_metadata_text;
use mixdog_agent::compact::image::target_dimensions;
use mixdog_agent::offload::ImageCompactor;
use mixdog_agent::offload::ImageOutcome;

/// Answers by script: the size the image decodes at, what each quality encodes to, and what a
/// validation says. The calls made are recorded.
struct Scripted {
    size: Result<ImageSize, CodecError>,
    /// Encoded byte length and size per quality tried, in order.
    encodes: Vec<(usize, ImageSize)>,
    validation: Result<(), CodecError>,
    calls: Mutex<Vec<String>>,
}

impl Scripted {
    fn new(size: Result<ImageSize, CodecError>, encodes: Vec<(usize, ImageSize)>, validation: Result<(), CodecError>) -> Arc<Self> {
        Arc::new(Self { size, encodes, validation, calls: Mutex::default() })
    }
}

#[async_trait]
impl ImageCodec for Scripted {
    async fn probe(&self, _: &[u8]) -> Result<ImageSize, CodecError> {
        self.calls.lock().unwrap().push("probe".into());
        self.size.clone()
    }
    async fn jpeg(&self, _: &[u8], width: u32, height: u32, enlarge: bool, quality: u8) -> Result<Encoded, CodecError> {
        let mut calls = self.calls.lock().unwrap();
        calls.push(format!("jpeg {width}x{height} enlarge={enlarge} q={quality}"));
        let (len, size) = self.encodes[calls.iter().filter(|c| c.starts_with("jpeg")).count() - 1];
        Ok(Encoded { bytes: vec![7; len], size })
    }
    async fn validate(&self, _: &[u8], format: &str) -> Result<(), CodecError> {
        self.calls.lock().unwrap().push(format!("validate {format}"));
        self.validation.clone()
    }
}

/// A base64 text over the 256 KiB target.
fn big() -> String {
    "A".repeat(400_000)
}

const FROM: ImageSize = ImageSize { width: 3000, height: 2000 };
const BOX: ImageSize = ImageSize { width: 1568, height: 1045 };

fn encoded_base64_len(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

#[tokio::test]
async fn a_large_image_is_reencoded_into_its_display_box_with_a_note() {
    let codec = Scripted::new(Ok(FROM), vec![(150_000, BOX)], Ok(()));
    let outcome = ToolImageCompactor::new(codec.clone()).compact(&big(), "image/png").await;
    let ImageOutcome::Compacted { data, mime, note } = outcome else { panic!("not re-encoded") };
    assert_eq!(mime, "image/jpeg");
    assert_eq!(data, STANDARD.encode(vec![7u8; 150_000]));
    assert_eq!(note.as_deref(), Some(superseding_metadata_text(FROM, BOX).as_str()));
    let (w, h, enlarge) = target_dimensions(3000, 2000);
    assert_eq!(*codec.calls.lock().unwrap(), vec!["probe".to_owned(), format!("jpeg {w}x{h} enlarge={enlarge} q=85")]);
}

#[tokio::test]
async fn quality_steps_down_until_the_base64_fits_and_the_last_try_stands() {
    assert!(encoded_base64_len(200_000) > 256 * 1024 && encoded_base64_len(190_000) <= 256 * 1024);
    let codec = Scripted::new(Ok(FROM), vec![(200_000, BOX), (190_000, BOX)], Ok(()));
    let outcome = ToolImageCompactor::new(codec.clone()).compact(&big(), "image/webp").await;
    let ImageOutcome::Compacted { data, .. } = outcome else { panic!("not re-encoded") };
    assert_eq!(data.len(), encoded_base64_len(190_000));
    let qualities: Vec<_> = codec.calls.lock().unwrap().iter().filter(|c| c.starts_with("jpeg")).map(|c| c.rsplit('=').next().unwrap().to_owned()).collect();
    assert_eq!(qualities, ["85", "70"]);

    let stubborn = Scripted::new(Ok(FROM), vec![(299_000, BOX), (299_000, BOX), (299_000, BOX)], Ok(()));
    let outcome = ToolImageCompactor::new(stubborn.clone()).compact(&"A".repeat(500_000), "image/jpeg").await;
    assert!(matches!(outcome, ImageOutcome::Compacted { .. }));
    assert_eq!(stubborn.calls.lock().unwrap().iter().filter(|c| c.starts_with("jpeg")).count(), 3);
}

#[tokio::test]
async fn an_image_that_keeps_its_size_gets_no_note() {
    let codec = Scripted::new(Ok(BOX), vec![(100_000, BOX)], Ok(()));
    let outcome = ToolImageCompactor::new(codec).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Compacted { note: None, .. }));
}

#[tokio::test]
async fn an_image_that_would_not_shrink_is_kept_as_it_is() {
    // The re-encode is as long as the original base64.
    let codec = Scripted::new(Ok(FROM), vec![(300_000, BOX); 3], Ok(()));
    let outcome = ToolImageCompactor::new(codec.clone()).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Keep));
    // Whether the picture decodes is the attachment store's verdict, never the compactor's.
    assert!(codec.calls.lock().unwrap().iter().all(|c| !c.starts_with("validate")));
}

/// An intake that records what it was given and answers a fixed reference.
struct Intake {
    seen: Mutex<Vec<String>>,
    answer: Option<String>,
}

#[async_trait::async_trait]
impl mixdog_agent::offload::ImageIntake for Intake {
    async fn store(&self, base64: &str, _: &str) -> Option<String> {
        self.seen.lock().unwrap().push(base64.to_owned());
        self.answer.clone()
    }
    async fn store_blob(&self, reference: &str, _: &str) -> Option<(String, String)> {
        self.seen.lock().unwrap().push(reference.to_owned());
        self.answer.clone().map(|stored| (stored, "image/png".to_owned()))
    }
}

#[tokio::test]
async fn a_blob_image_of_a_tool_becomes_the_stores_reference_in_place() {
    use mixdog_core_api::domain::provider::{BinarySource, Content, ContentPart, ImageSource};
    let intake = Arc::new(Intake { seen: Mutex::default(), answer: Some("ef".repeat(32)) });
    let compactor = ToolImageCompactor::new(Scripted::new(Ok(FROM), vec![], Ok(()))).with_intake(intake.clone());
    let content = Content::Parts(vec![ContentPart::Text("shot".into(), None), ContentPart::Image(ImageSource::FileId(format!("sha256:{}", "12".repeat(32))))]);
    let Content::Parts(parts) = mixdog_agent::offload::compact_images(&compactor, &content).await else { panic!("parts") };
    assert_eq!(parts.len(), 2, "order and multiplicity stay");
    assert!(
        matches!(&parts[1], ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, text: None, .. } if *r == "ef".repeat(32) && mime_type == "image/png")
    );
    assert_eq!(*intake.seen.lock().unwrap(), vec!["12".repeat(32)], "the digest, without its algorithm prefix, names the blob");
}

#[tokio::test]
async fn an_image_the_codec_cannot_read_is_stored_for_its_verdict_never_replaced_by_text() {
    let rejected = Scripted::new(Err(CodecError::Invalid), vec![], Err(CodecError::Invalid));
    let intake = Arc::new(Intake { seen: Mutex::default(), answer: Some("ab".repeat(32)) });
    let outcome = ToolImageCompactor::new(rejected).with_intake(intake.clone()).compact(&big(), "image/heic").await;
    assert!(matches!(outcome, ImageOutcome::Stored { ref reference, ref mime, note: None } if *reference == "ab".repeat(32) && mime == "image/heic"));
    assert_eq!(*intake.seen.lock().unwrap(), vec![big()]);
}

#[tokio::test]
async fn a_reencoded_image_is_stored_as_reencoded_and_survives_a_store_that_cannot_take_it() {
    let codec = Scripted::new(Ok(FROM), vec![(150_000, BOX)], Ok(()));
    let intake = Arc::new(Intake { seen: Mutex::default(), answer: Some("cd".repeat(32)) });
    let outcome = ToolImageCompactor::new(codec).with_intake(intake.clone()).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Stored { ref mime, note: Some(_), .. } if mime == "image/jpeg"));
    assert_eq!(*intake.seen.lock().unwrap(), vec![STANDARD.encode(vec![7u8; 150_000])]);

    let codec = Scripted::new(Ok(FROM), vec![(150_000, BOX)], Ok(()));
    let down = Arc::new(Intake { seen: Mutex::default(), answer: None });
    let outcome = ToolImageCompactor::new(codec).with_intake(down).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Compacted { .. }));
    let plain =
        ToolImageCompactor::new(Scripted::new(Err(CodecError::Invalid), vec![], Ok(()))).with_intake(Arc::new(Intake { seen: Mutex::default(), answer: None }));
    assert!(matches!(plain.compact("AAAA", "image/png").await, ImageOutcome::Keep));
}

#[tokio::test]
async fn only_png_jpeg_and_webp_are_reencoded_and_a_missing_type_reads_as_png() {
    for (mime, probed) in [
        ("image/gif", false),
        ("image/svg+xml", false),
        ("image/png; charset=x", false),
        ("image/jpg", true),
        ("IMAGE/WEBP", true),
        ("", true),
        ("image", true),
    ] {
        let codec = Scripted::new(Ok(FROM), vec![(150_000, BOX)], Ok(()));
        ToolImageCompactor::new(codec.clone()).compact(&big(), mime).await;
        assert_eq!(codec.calls.lock().unwrap().first().is_some_and(|c| c == "probe"), probed, "{mime:?}");
    }
}

#[tokio::test]
async fn a_failed_probe_leaves_the_judgement_to_the_validation() {
    let rejected = Scripted::new(Err(CodecError::Invalid), vec![], Err(CodecError::Invalid));
    let outcome = ToolImageCompactor::new(rejected).compact(&big(), "image/png").await;
    // An image no decoder reads is not replaced by text: it stays, and the attachment store records its refusal.
    assert!(matches!(outcome, ImageOutcome::Keep));
    // A machine failure drops nothing: the image stays for a later retry.
    let machine = Scripted::new(Err(CodecError::Environment(Some("host down".into()))), vec![], Err(CodecError::Environment(Some("host down".into()))));
    let outcome = ToolImageCompactor::new(machine).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Keep));
    // An image of unknown size is not re-encoded.
    let unknown = Scripted::new(Ok(ImageSize { width: 0, height: 0 }), vec![], Ok(()));
    let outcome = ToolImageCompactor::new(unknown.clone()).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Keep));
    // Whether it decodes is the attachment store's verdict: the compactor only probed it.
    assert_eq!(*unknown.calls.lock().unwrap(), vec!["probe".to_owned()]);
}
