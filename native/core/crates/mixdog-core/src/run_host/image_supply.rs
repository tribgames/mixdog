//! The attachment store as the provider layer's image supply: recorded verdicts and stored bytes for the images a send carries. The
//! send path reads manifests and verified blobs; an import (a decode) happens only for what has no verdict yet.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::image_supply::ImageSupply;
use mixdog_core_api::domain::image_supply::SupplyError;
use mixdog_core_base::support::on_lane_wait as on_lane;
use mixdog_image_egress::Choice;
use mixdog_image_egress::Manifest;
use mixdog_image_egress::admission::Cancel;
use mixdog_image_vault::ImageVault;
use mixdog_image_vault::vault::ImportError;
use mixdog_image_vault::vault::Lookup;
use mixdog_image_vault::vault::ReadError;
use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneTokens;
use mixdog_store::blobs::BlobStore;
use tokio_util::sync::CancellationToken;

pub struct VaultSupply {
    blobs: BlobStore,
    data_dir: PathBuf,
    durability: DurabilityIo,
}

impl VaultSupply {
    pub fn new(blobs: BlobStore, data_dir: &Path, tokens: &LaneTokens) -> Self {
        Self { blobs, data_dir: data_dir.to_path_buf(), durability: tokens.durability_io }
    }

    fn vault(&self) -> ImageVault {
        ImageVault::new(self.blobs.clone(), &self.data_dir)
    }
}

fn unavailable(error: impl std::fmt::Debug) -> SupplyError {
    SupplyError::Unavailable(format!("{error:?}"))
}

fn from_import(error: ImportError) -> SupplyError {
    match error {
        ImportError::Missing(_) => SupplyError::Missing,
        ImportError::Invalid(text) => SupplyError::NotAnImage(text),
        ImportError::Transient(why) => unavailable(why),
        ImportError::Storage(text) => SupplyError::Unavailable(text),
    }
}

#[async_trait]
impl ImageSupply for VaultSupply {
    async fn inline(&self, base64: &str) -> Result<Manifest, SupplyError> {
        let (vault, base64) = (self.vault(), base64.to_owned());
        on_lane(self.durability, &CancellationToken::new(), move |lane| vault.import_base64(lane, &base64, "", &Cancel::default()))
            .await
            .map_err(unavailable)?
            .map_err(from_import)
    }

    async fn stored(&self, reference: &str) -> Result<Manifest, SupplyError> {
        let (vault, reference) = (self.vault(), reference.to_owned());
        on_lane(self.durability, &CancellationToken::new(), move |lane| match vault.lookup(lane, &reference) {
            Lookup::Found(manifest) => Ok(manifest),
            // Every ingress imports on arrival and the restore gate migrates old history, so a reference without a current
            // verdict is a stale or damaged one: validated again here, completely, under the same admission.
            Lookup::Absent | Lookup::Stale { .. } | Lookup::Damaged => vault.import_blob_ref(lane, &reference, "", &Cancel::default()).map_err(from_import),
        })
        .await
        .map_err(unavailable)?
    }

    async fn bytes(&self, manifest: &Manifest, choice: Choice) -> Result<Arc<[u8]>, SupplyError> {
        let (vault, manifest) = (self.vault(), manifest.clone());
        on_lane(self.durability, &CancellationToken::new(), move |lane| vault.bytes_for(lane, &manifest, choice)).await.map_err(unavailable)?.map_err(|error| {
            match error {
                ReadError::Missing => SupplyError::Missing,
                ReadError::Corrupt => SupplyError::Corrupt,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;
    use mixdog_imaging::Format;
    use mixdog_imaging::Raster;
    use mixdog_imaging::encode::encode_in_format;

    use super::*;

    fn png() -> Vec<u8> {
        let data = (0..32 * 24).flat_map(|n| [(n % 251) as u8, (n % 13) as u8 * 19, 90]).collect();
        encode_in_format(&Raster { width: 32, height: 24, has_alpha: false, data }, Format::Png).unwrap()
    }

    fn supply() -> (tempfile::TempDir, VaultSupply) {
        let dir = tempfile::tempdir().unwrap();
        let supply = VaultSupply::new(BlobStore::new(dir.path()), dir.path(), &mixdog_rt::testing::tokens());
        (dir, supply)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_inline_image_is_imported_once_and_its_stored_bytes_are_what_a_send_reads() {
        let (_dir, supply) = supply();
        let bytes = png();
        let manifest = supply.inline(&STANDARD.encode(&bytes)).await.unwrap();
        assert!(matches!(manifest.outcome, mixdog_image_egress::Outcome::Accepted { .. }));
        // By reference afterwards: a recorded verdict, no second validation, the verified original.
        let again = supply.stored(&manifest.original).await.unwrap();
        assert_eq!(again, manifest);
        assert_eq!(&*supply.bytes(&again, Choice::Original).await.unwrap(), &bytes[..]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_reference_with_no_stored_file_is_missing_and_a_non_image_payload_is_not_an_image() {
        let (_dir, supply) = supply();
        assert_eq!(supply.stored(&"0".repeat(64)).await.unwrap_err(), SupplyError::Missing);
        assert!(matches!(supply.inline("!!not base64!!").await, Err(SupplyError::NotAnImage(_))));
        let refused = supply.inline(&STANDARD.encode(b"plain words, no picture")).await.unwrap();
        assert!(matches!(refused.outcome, mixdog_image_egress::Outcome::Refused { .. }), "a recorded refusal, not an error");
    }
}
