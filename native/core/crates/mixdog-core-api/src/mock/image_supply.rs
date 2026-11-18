//! A double of the attachment store's [`ImageSupply`], for tests of an egress that sends images. A reference's text is base64 of
//! its bytes; the type is read from them (the JPEG start marker is a JPEG, anything else a PNG), never from a label, and the text
//! that is not base64 is not an image. A stored reference is missing.

use std::sync::Arc;
use std::sync::Once;

use async_trait::async_trait;
use base64::Engine as _;
use mixdog_image_egress::Choice;
use mixdog_image_egress::ImageKind;
use mixdog_image_egress::Manifest;
use mixdog_image_egress::Outcome;

use crate::domain::image_supply::ImageSupply;
use crate::domain::image_supply::SupplyError;
use crate::domain::image_supply::install;

pub struct MockImageSupply;

fn decode(text: &str) -> Result<Vec<u8>, SupplyError> {
    base64::engine::general_purpose::STANDARD.decode(text).map_err(|error| SupplyError::NotAnImage(error.to_string()))
}

#[async_trait]
impl ImageSupply for MockImageSupply {
    async fn inline(&self, base64: &str) -> Result<Manifest, SupplyError> {
        let bytes = decode(base64)?;
        let kind = if bytes.starts_with(&[0xff, 0xd8, 0xff]) { ImageKind::Jpeg } else { ImageKind::Png };
        Ok(Manifest {
            validator_version: 1,
            original: base64.to_owned(),
            name: String::new(),
            encoded_len: bytes.len() as u64,
            outcome: Outcome::Accepted { kind, width: 8, height: 8, frames: 1, rendition: None },
        })
    }

    async fn stored(&self, _: &str) -> Result<Manifest, SupplyError> {
        Err(SupplyError::Missing)
    }

    async fn bytes(&self, manifest: &Manifest, _: Choice) -> Result<Arc<[u8]>, SupplyError> {
        Ok(decode(&manifest.original)?.into())
    }
}

/// Install the double as the process's image supply, once.
pub fn install_mock_image_supply() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| install(Arc::new(MockImageSupply)));
}
