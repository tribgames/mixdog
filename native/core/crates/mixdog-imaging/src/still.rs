//! The lossy WebP encoder, the one codec this crate does not have yet. `encode.rs` calls it for a resized WebP input
//! (sharp's default WebP quality is 80); until `nr-exthost-imaging-still` writes it, the answer is that there is no
//! encoder, which a caller treats as the machine's lack (an environment failure), never as a judgement of the image.

use crate::decode::Raster;
use crate::error::ImagingError;

/// Encodes `raster` as lossy WebP at `quality` (1 to 100).
pub(crate) fn encode_webp(_raster: &Raster, _quality: u8) -> Result<Vec<u8>, ImagingError> {
    Err(ImagingError::environment("lossy WebP encoding is not available"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn until_the_encoder_exists_the_answer_is_the_machines_lack() {
        let raster = Raster { width: 1, height: 1, has_alpha: false, data: vec![0, 0, 0] };
        let error = encode_webp(&raster, 80).unwrap_err();
        assert!(error.is_environment());
    }
}
