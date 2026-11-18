use std::io::Write;
use std::path::{Path, PathBuf};

use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_ooxml::package::load_package;
use mixdog_ooxml::portable::{
    CreateOptions, ValidateOptions, apply_portable_ooxml_batch, create_portable_ooxml_document, snapshot_portable_ooxml,
    validate_portable_ooxml,
};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

/// A document on disk in a scratch folder, created blank and edited by batches.
pub struct Doc {
    dir: tempfile::TempDir,
    pub path: PathBuf,
    pub format: &'static str,
}

impl Doc {
    pub fn new(format: &'static str) -> Self {
        Self::named(format, "")
    }

    /// A workbook whose first sheet has this name.
    pub fn named(format: &'static str, sheet: &str) -> Self {
        let dir = tempfile::tempdir().expect("scratch folder");
        let path = dir.path().join(format!("feature.{format}"));
        create_portable_ooxml_document(&Unlaned, &NoWriteNote, &path, &CreateOptions { file_kind: format, title: "feature title", sheet_name: sheet })
            .expect("a blank document");
        Self { dir, path, format }
    }

    pub fn dir(&self) -> &Path {
        self.dir.path()
    }

    pub fn try_apply(&self, operations: Value) -> Result<Vec<Value>, String> {
        let registry = fonts();
        let measurer = TextMeasurer::new(&Unlaned, &registry);
        apply_portable_ooxml_batch(&Unlaned, &NoWriteNote, &measurer, &self.path, self.format, operations.as_array().expect("a list"))
    }

    pub fn apply(&self, operations: Value) -> Vec<Value> {
        self.try_apply(operations).expect("the batch applies")
    }

    pub fn package(&self) -> Package {
        load_package(&Unlaned, &self.path).expect("the saved package")
    }

    pub fn part(&self, name: &str) -> String {
        self.package().text(name)
    }

    pub fn has_part(&self, name: &str) -> bool {
        self.package().names().iter().any(|known| known == name)
    }

    pub fn snapshot(&self) -> Value {
        let registry = fonts();
        let measurer = TextMeasurer::new(&Unlaned, &registry);
        snapshot_portable_ooxml(&Unlaned, &measurer, &self.path, self.format, &json!({})).expect("a snapshot")
    }

    pub fn validate(&self) -> Value {
        validate_portable_ooxml(&Unlaned, &self.path, self.format, &ValidateOptions::default()).expect("a validation")
    }

    pub fn assert_valid(&self) {
        let report = self.validate();
        assert_eq!(report["ok"], json!(true), "{report}");
    }
}

/// The repository's Liberation Sans faces: the family every measurement falls back to.
pub fn fonts() -> Registry {
    let mut registry = Registry::new();
    for name in ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"] {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts").join(name);
        registry.register_file(&Unlaned, &path, Some("Liberation Sans")).expect("a face");
    }
    registry
}

pub fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

/// The text of every `<w:t>` of a Word part, in order.
pub fn word_texts(xml: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(at) = rest.find("<w:t") {
        let after = &rest[at + 4..];
        if !after.starts_with('>') && !after.starts_with(' ') {
            rest = after;
            continue;
        }
        let open_end = after.find('>').expect("a closed tag");
        let body = &after[open_end + 1..];
        let close = body.find("</w:t>").expect("a closing tag");
        found.push(body[..close].to_owned());
        rest = &body[close..];
    }
    found
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// A solid-colour RGB PNG of the given size.
pub fn png(width: u32, height: u32) -> Vec<u8> {
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&u32::try_from(data.len()).expect("small").to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    }
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut raw = Vec::new();
    for _ in 0..height {
        raw.push(0);
        raw.extend(std::iter::repeat_n([200u8, 30, 30], width as usize).flatten());
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).expect("compress");
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &encoder.finish().expect("compressed"));
    chunk(&mut out, b"IEND", &[]);
    out
}

/// The snapshot entry of a worksheet cell.
pub fn cell(snapshot: &Value, sheet: &str, reference: &str) -> Option<Value> {
    let path = format!("/sheet[{sheet}]/cell[{reference}]");
    snapshot["sheets"]
        .as_array()?
        .iter()
        .flat_map(|entry| entry["cells"].as_array().map_or(&[][..], Vec::as_slice))
        .find(|entry| entry["path"] == json!(path))
        .cloned()
}
