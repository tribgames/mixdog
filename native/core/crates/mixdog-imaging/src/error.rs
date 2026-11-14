//! Why an image call gave no image. Node tells two reasons apart (`runtime/shared/environment-error.mjs`): the
//! decoder rejected the bytes (a property of the input), or the machine failed (an `ERR_*`/`ENOMEM` code, or an
//! out-of-memory message). Only the first judges the image.
//!
//! The sentence of a rejection is the one libvips gives for the same class of failure (owner decision: the
//! composer shows it, and users and tests know it): a Rust decoder words its failures differently, so each failure
//! class maps to the libvips sentence the twin corpus recorded for it, with the unsupported-format sentence as the
//! fallback.

use std::fmt;

/// `invalid or corrupt image data: ` is what `resizeImageBuffer` prefixes to the decoder's sentence.
const INVALID_IMAGE_DATA_PREFIX: &str = "invalid or corrupt image data: ";

/// The sentence libvips gives for bytes it cannot sniff.
pub const UNSUPPORTED_FORMAT: &str = "Input buffer contains unsupported image format";

/// The sentence sharp gives for an empty buffer (`probe` and `jpeg` pass an empty buffer to the decoder).
pub const EMPTY_BUFFER: &str = "Input Buffer is empty";

/// The sentence libvips gives for an image over `limitInputPixels`.
pub const PIXEL_LIMIT: &str = "Input image exceeds pixel limit";

/// The sentence libvips gives when libpng stops inside the pixel data.
pub const PNG_READ: &str = "vipspng: libpng read error";

/// The two classes of Node's `isEnvironmentError`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ErrorClass {
    /// The decoder rejected the bytes.
    Invalid,
    /// The machine failed, or there is no decoder or encoder for the work.
    Environment,
}

/// A failed image call.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ImagingError {
    class: ErrorClass,
    sentence: String,
    /// Set by `resizeImageBuffer`, which throws `InvalidImageDataError` for every failure of its pipeline; the
    /// class of the cause is kept (`isEnvironmentError` follows `cause`).
    wrapped: bool,
}

impl ImagingError {
    /// Bytes the decoder rejects, with libvips's sentence.
    pub fn invalid(sentence: impl Into<String>) -> Self {
        Self { class: ErrorClass::Invalid, sentence: sentence.into(), wrapped: false }
    }

    /// A failure of the machine, or work no codec here does.
    pub fn environment(sentence: impl Into<String>) -> Self {
        Self { class: ErrorClass::Environment, sentence: sentence.into(), wrapped: false }
    }

    /// Node's `isEnvironmentError` on a message: an out-of-memory or failed-allocation text is the machine's, any
    /// other text is a decoder's judgement of the input.
    pub fn from_message(message: &str) -> Self {
        let lower = message.to_ascii_lowercase();
        if ["out of memory", "allocation failed", "cannot allocate memory"].iter().any(|needle| lower.contains(needle)) {
            Self::environment(message)
        } else {
            Self::invalid(message)
        }
    }

    /// `resizeImageBuffer`'s `InvalidImageDataError`.
    #[must_use]
    pub fn wrapped(mut self) -> Self {
        self.wrapped = true;
        self
    }

    pub fn class(&self) -> ErrorClass {
        self.class
    }

    pub fn is_environment(&self) -> bool {
        self.class == ErrorClass::Environment
    }

    /// The decoder's sentence alone.
    pub fn sentence(&self) -> &str {
        &self.sentence
    }

    /// The text Node's error carries: the sentence, behind `invalid or corrupt image data: ` when it came out of
    /// `resizeImageBuffer`.
    pub fn message(&self) -> String {
        if self.wrapped { format!("{INVALID_IMAGE_DATA_PREFIX}{}", self.sentence) } else { self.sentence.clone() }
    }
}

impl fmt::Display for ImagingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ImagingError {}

/// The sentence for a header the codec of a format could not parse. `detail` is what libvips appends after the
/// colon (empty for libpng, which gives none).
pub fn corrupt_header(detail: &str) -> String {
    if detail.is_empty() { "Input buffer has corrupt header:".to_owned() } else { format!("Input buffer has corrupt header: {detail}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_memory_text_is_the_machines() {
        assert_eq!(ImagingError::from_message("Input buffer contains unsupported image format").class(), ErrorClass::Invalid);
        assert_eq!(ImagingError::from_message("vips: Out Of Memory").class(), ErrorClass::Environment);
        assert_eq!(ImagingError::from_message("Allocation failed for 5 bytes").class(), ErrorClass::Environment);
        assert_eq!(ImagingError::from_message("Cannot allocate memory").class(), ErrorClass::Environment);
    }

    #[test]
    fn the_resize_pipeline_prefixes_the_sentence_and_keeps_the_class_of_the_cause() {
        let invalid = ImagingError::invalid(UNSUPPORTED_FORMAT).wrapped();
        assert_eq!(invalid.message(), "invalid or corrupt image data: Input buffer contains unsupported image format");
        assert_eq!(invalid.sentence(), UNSUPPORTED_FORMAT);
        assert_eq!(invalid.class(), ErrorClass::Invalid);
        let machine = ImagingError::environment("no encoder").wrapped();
        assert!(machine.is_environment());
        assert_eq!(ImagingError::invalid(EMPTY_BUFFER).to_string(), "Input Buffer is empty");
    }

    #[test]
    fn a_corrupt_header_has_libvips_s_trailing_colon_when_it_has_no_detail() {
        assert_eq!(corrupt_header(""), "Input buffer has corrupt header:");
        assert_eq!(corrupt_header("webp: unable to parse image"), "Input buffer has corrupt header: webp: unable to parse image");
    }
}
