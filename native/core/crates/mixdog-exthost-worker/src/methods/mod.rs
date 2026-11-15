//! The methods the worker serves. Each family registers itself here as its task lands.

pub mod document;
pub use skill_office::SkillOfficeEngine;
mod document_engine;
mod image;
mod media_office;
mod office_browser;
mod office_journal;
mod office_run;
mod ooxml;
mod pdf;
mod pdf_ocr;
mod pdf_render;
mod skill_office;
mod soffice;

use base64::Engine as _;
use base64::alphabet;
use base64::engine::DecodePaddingMode;
use base64::engine::GeneralPurpose;
use base64::engine::GeneralPurposeConfig;
use serde_json::Value;

use crate::error::CodedError;
use crate::registry::Registry;

/// Registers the document methods: `ooxml.text`, `media.officeText`, the image calls and the PDF calls (`pdf.inspect`, `pdf.render`, `pdf.ocr`,
/// `media.pdfText`, `media.pdfCounts`). The office and syntax families register themselves as their tasks land.
pub fn register_document_methods(registry: &mut Registry) {
    ooxml::register(registry);
    media_office::register(registry);
    office_journal::register(registry);
    office_run::register(registry);
    image::register(registry);
    pdf::register(registry);
    pdf_render::register(registry);
    pdf_ocr::register(registry);
    document::register(registry);
}

/// The error a call with a malformed parameter answers.
fn invalid_params(message: impl Into<String>) -> CodedError {
    CodedError::new("invalid_params", message)
}

/// The call's `data` parameter, a base64 string (`data must be a base64 string` otherwise).
fn base64_param(params: &Value) -> Result<&str, CodedError> {
    params
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("data must be a base64 string"))
}

/// JavaScript's `String(value)` for the values a parameter can hold.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}

/// `Buffer.from(data, 'base64')`: characters outside the two alphabets are skipped, padding may be missing, and a dangling
/// single character carries no byte.
fn node_base64(data: &str) -> Vec<u8> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let mut cleaned: String = data
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    LENIENT.decode(&cleaned).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_is_read_as_buffer_from_reads_it() {
        assert_eq!(node_base64("aGVsbG8="), b"hello");
        assert_eq!(node_base64("aGVs\nbG8"), b"hello");
        assert_eq!(node_base64("aGVsbG8_-w"), node_base64("aGVsbG8/+w"));
        assert_eq!(node_base64("aGVsb"), b"hel");
        assert!(node_base64("").is_empty());
    }

    #[test]
    fn a_missing_data_parameter_is_refused_with_its_message() {
        let error = base64_param(&serde_json::json!({"data": 3})).unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("invalid_params", "data must be a base64 string"));
        assert_eq!(base64_param(&serde_json::json!({"data": "QQ=="})).unwrap(), "QQ==");
    }

    #[test]
    fn a_value_is_spelled_as_javascript_spells_it() {
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_string(Some(&serde_json::json!("a b"))), "a b");
        assert_eq!(js_string(Some(&serde_json::json!(5))), "5");
        assert_eq!(js_string(Some(&Value::Null)), "null");
        assert_eq!(js_string(Some(&serde_json::json!(["png", null, [1, 2]]))), "png,,1,2");
        assert_eq!(js_string(Some(&serde_json::json!({"format": "png"}))), "[object Object]");
        assert_eq!(js_string(Some(&serde_json::json!(1.0))), "1");
        assert_eq!(js_string(Some(&serde_json::json!(1e21))), "1e+21");
    }
}
