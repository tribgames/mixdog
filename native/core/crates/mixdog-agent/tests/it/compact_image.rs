//! Tool-result image compaction equals Node's `compactResultImages`: the display box, the note that
//! supersedes an earlier size annotation, and the fixed text for undecodable and unsupported images.
//! The decoder is the host's; these tests drive the pipeline through a scripted one.

use crate::compact_support;

use std::collections::HashMap;
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
use serde_json::Value;

#[test]
fn the_display_box_equals_nodes() {
    let golden = golden!("image");
    let targets = golden["targets"].as_array().expect("targets");
    assert!(targets.len() > 10);
    for case in targets {
        let (w, h) = (case["width"].as_u64().unwrap() as u32, case["height"].as_u64().unwrap() as u32);
        let want = (case["target"][0].as_u64().unwrap() as u32, case["target"][1].as_u64().unwrap() as u32, case["allowEnlargement"].as_bool().unwrap());
        assert_eq!(target_dimensions(w, h), (want.0, want.1, want.2), "{w}x{h}");
    }
}

#[test]
fn the_superseding_note_equals_nodes() {
    let golden = golden!("image");
    for case in golden["notes"].as_array().expect("notes") {
        let size = |key: &str| ImageSize { width: case[key][0].as_u64().unwrap() as u32, height: case[key][1].as_u64().unwrap() as u32 };
        assert_eq!(superseding_metadata_text(size("original"), size("display")), case["text"].as_str().unwrap(), "{case}");
    }
}

/// The decoder's verdict per image, as Node's decoder gave it for the golden's bytes.
struct Verdicts(HashMap<Vec<u8>, bool>);

#[async_trait]
impl ImageCodec for Verdicts {
    async fn probe(&self, _: &[u8]) -> Result<ImageSize, CodecError> {
        panic!("a small image is never re-encoded")
    }
    async fn jpeg(&self, _: &[u8], _: u32, _: u32, _: bool, _: u8) -> Result<Encoded, CodecError> {
        panic!("a small image is never re-encoded")
    }
    async fn validate(&self, bytes: &[u8], _: &str) -> Result<(), CodecError> {
        if self.0[bytes] { Ok(()) } else { Err(CodecError::Invalid) }
    }
}

#[tokio::test]
async fn small_undecodable_and_unsupported_images_equal_nodes() {
    let golden = golden!("image");
    let results = golden["results"].as_array().expect("results");
    assert!(results.len() > 15);
    let verdicts = results
        .iter()
        .filter(|r| !r["data"].as_str().unwrap().is_empty())
        .map(|r| (STANDARD.decode(r["data"].as_str().unwrap()).expect("base64"), r["decodes"].as_bool().unwrap()))
        .collect();
    let compactor = ToolImageCompactor::new(Arc::new(Verdicts(verdicts)));
    for case in results {
        let name = case["name"].as_str().unwrap();
        let outcome = compactor.compact(case["data"].as_str().unwrap(), case["mime"].as_str().unwrap()).await;
        match (case.get("keep"), case.get("omitted")) {
            (Some(_), _) => assert!(matches!(outcome, ImageOutcome::Keep), "{name}"),
            (_, Some(text)) => match outcome {
                ImageOutcome::Omitted(got) => assert_eq!(Value::String(got), *text, "{name}"),
                _ => panic!("{name}: not omitted"),
            },
            _ => panic!("{name}: no verdict"),
        }
    }
}

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

/// Answers with what Node's decoder and encoder gave for the golden's one real re-encode.
struct Recorded {
    original: ImageSize,
    display: ImageSize,
    jpeg: Vec<u8>,
    calls: Mutex<Vec<String>>,
}

#[async_trait]
impl ImageCodec for Recorded {
    async fn probe(&self, _: &[u8]) -> Result<ImageSize, CodecError> {
        Ok(self.original)
    }
    async fn jpeg(&self, _: &[u8], width: u32, height: u32, enlarge: bool, quality: u8) -> Result<Encoded, CodecError> {
        self.calls.lock().unwrap().push(format!("{width}x{height} enlarge={enlarge} q={quality}"));
        Ok(Encoded { bytes: self.jpeg.clone(), size: self.display })
    }
    async fn validate(&self, _: &[u8], _: &str) -> Result<(), CodecError> {
        panic!("a re-encoded image is not validated")
    }
}

#[tokio::test]
async fn a_real_reencode_equals_nodes_result_and_note() {
    let golden = golden!("image");
    let case = &golden["reencode"];
    let size = |key: &str| ImageSize { width: case[key][0].as_u64().unwrap() as u32, height: case[key][1].as_u64().unwrap() as u32 };
    let codec = Arc::new(Recorded {
        original: size("original"),
        display: size("display"),
        jpeg: STANDARD.decode(case["jpeg"].as_str().unwrap()).expect("base64"),
        calls: Mutex::default(),
    });
    let outcome = ToolImageCompactor::new(codec.clone()).compact(case["data"].as_str().unwrap(), case["mime"].as_str().unwrap()).await;
    let ImageOutcome::Compacted { data, mime, note } = outcome else { panic!("not re-encoded") };
    assert_eq!(data, case["jpeg"].as_str().unwrap());
    assert_eq!(mime, case["outMime"].as_str().unwrap());
    assert_eq!(note.as_deref(), case["note"].as_str());
    // The sub-patch short edge is lifted to the floor, which allows the enlargement.
    assert_eq!(*codec.calls.lock().unwrap(), vec!["200x400 enlarge=true q=85".to_owned()]);
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
async fn an_image_that_would_not_shrink_is_kept_when_it_decodes() {
    // The re-encode is as long as the original base64.
    let codec = Scripted::new(Ok(FROM), vec![(300_000, BOX); 3], Ok(()));
    let outcome = ToolImageCompactor::new(codec.clone()).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Keep));
    assert_eq!(codec.calls.lock().unwrap().last().unwrap(), "validate png");
}

#[tokio::test]
async fn only_png_jpeg_and_webp_are_reencoded_and_a_missing_type_reads_as_png() {
    for (mime, probed) in [("image/gif", false), ("image/svg+xml", false), ("image/png; charset=x", false), ("image/jpg", true), ("IMAGE/WEBP", true), ("", true), ("image", true)] {
        let codec = Scripted::new(Ok(FROM), vec![(150_000, BOX)], Ok(()));
        ToolImageCompactor::new(codec.clone()).compact(&big(), mime).await;
        assert_eq!(codec.calls.lock().unwrap().first().is_some_and(|c| c == "probe"), probed, "{mime:?}");
    }
}

#[tokio::test]
async fn a_failed_probe_leaves_the_judgement_to_the_validation() {
    let rejected = Scripted::new(Err(CodecError::Invalid), vec![], Err(CodecError::Invalid));
    let outcome = ToolImageCompactor::new(rejected).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Omitted(ref t) if t == "[image omitted: could not be decoded]"));
    // A machine failure drops nothing: the image stays for a later retry.
    let machine = Scripted::new(Err(CodecError::Environment(Some("host down".into()))), vec![], Err(CodecError::Environment(Some("host down".into()))));
    let outcome = ToolImageCompactor::new(machine).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Keep));
    // An image of unknown size is not re-encoded.
    let unknown = Scripted::new(Ok(ImageSize { width: 0, height: 0 }), vec![], Ok(()));
    let outcome = ToolImageCompactor::new(unknown.clone()).compact(&big(), "image/png").await;
    assert!(matches!(outcome, ImageOutcome::Keep));
    assert_eq!(unknown.calls.lock().unwrap().len(), 2);
}
