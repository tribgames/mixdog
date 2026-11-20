//! Migration of the images a restored history already holds (legacy inline base64 and bare attachment references) into the
//! image vault, before sending is enabled. It runs on one lane job per image under the process-wide admission controller,
//! reports progress after every image, stops at once on cancel (what was imported stays imported), and returns every image it
//! could not import with its reason so the caller can offer repair. Dual-read of the old shapes lives only here; originals are
//! written at the same blob addresses the old code reads, so rolling the app back loses nothing.

use mixdog_image_egress::Manifest;
use mixdog_image_egress::admission::Cancel;
use mixdog_rt::InLane;
use mixdog_statefile::IoLane;

use crate::vault::ImageVault;
use crate::vault::ImportError;

/// Where a legacy image's bytes are.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LegacySource {
    Base64(String),
    /// The 64-hex reference of an attachment blob.
    BlobRef(String),
}

/// One image of a restored history, addressed by its stable origin id.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LegacyImage {
    pub key: String,
    pub name: String,
    pub source: LegacySource,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ItemResult {
    /// Imported, or found already imported at the current validator version.
    Done(Manifest),
    /// Not imported; the error says why. A transient one is retried by running the migration again.
    Failed(ImportError),
    /// Not reached: the migration was cancelled.
    NotRun,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Report {
    pub results: Vec<(String, ItemResult)>,
    pub cancelled: bool,
}

impl Report {
    /// Sending may be enabled: every image has a verdict (an accepted image, or a recorded refusal the preflight will name).
    pub fn complete(&self) -> bool {
        !self.cancelled && self.results.iter().all(|(_, r)| matches!(r, ItemResult::Done(_)))
    }

    /// Images that need repair: a failure that is not transient.
    pub fn needs_repair(&self) -> Vec<&str> {
        self.results
            .iter()
            .filter(|(_, r)| matches!(r, ItemResult::Failed(ImportError::Storage(_) | ImportError::Missing(_) | ImportError::Invalid(_))))
            .map(|(k, _)| k.as_str())
            .collect()
    }
}

/// Import every image of `items`. Equal images are imported once (the vault keys by content).
pub fn migrate<L: IoLane>(vault: &ImageVault, lane: &InLane<L>, items: &[LegacyImage], cancel: &Cancel, on_progress: &mut dyn FnMut(Progress)) -> Report {
    let total = items.len();
    let mut results = Vec::with_capacity(total);
    let mut cancelled = false;
    for (done, item) in items.iter().enumerate() {
        if cancelled || cancel.is_cancelled() {
            cancelled = true;
            results.push((item.key.clone(), ItemResult::NotRun));
            continue;
        }
        let outcome = match &item.source {
            LegacySource::Base64(text) => vault.import_base64(lane, text, &item.name, cancel),
            LegacySource::BlobRef(reference) => vault.import_blob_ref(lane, reference, &item.name, cancel),
        };
        let result = match outcome {
            Ok(manifest) => ItemResult::Done(manifest),
            Err(ImportError::Transient(mixdog_image_egress::admission::AdmitError::Cancelled)) => {
                cancelled = true;
                ItemResult::NotRun
            }
            Err(error) => ItemResult::Failed(error),
        };
        results.push((item.key.clone(), result));
        on_progress(Progress { done: done + 1, total });
    }
    Report { results, cancelled }
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use mixdog_core_base::support::on_lane_wait as on_lane;
    use mixdog_image_egress::admission::global;
    use mixdog_imaging::Format;
    use mixdog_imaging::decode::Raster;
    use mixdog_imaging::encode::encode_in_format;
    use mixdog_store::blobs::BlobStore;
    use mixdog_store::blobs::digest_of;
    use mixdog_store::blobs::hex;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let data = (0..width * height).flat_map(|i| [(i % 251) as u8, (i % 13) as u8 * 19, (i % 7) as u8 * 36]).collect();
        encode_in_format(&Raster { width, height, has_alpha: false, data }, Format::Png).unwrap()
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    async fn run(dir: &std::path::Path, items: Vec<LegacyImage>, cancel: Cancel) -> (Report, Vec<Progress>) {
        let tokens = mixdog_rt::testing::tokens();
        let vault = ImageVault::new(BlobStore::new(dir), dir);
        on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| {
            let mut seen = Vec::new();
            let report = migrate(&vault, lane, &items, &cancel, &mut |p| seen.push(p));
            (report, seen)
        })
        .await
        .unwrap()
    }

    fn item(key: &str, source: LegacySource) -> LegacyImage {
        LegacyImage { key: key.into(), name: format!("{key}.png"), source }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_inline_and_referenced_images_are_imported_with_progress_and_a_restart_decodes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (png(20, 10), png(30, 12));
        // `b` is already an attachment blob, as the old code stored it.
        let reference = {
            let store = BlobStore::new(dir.path());
            let tokens = mixdog_rt::testing::tokens();
            let bytes = b.clone();
            on_lane(tokens.durability_io, &CancellationToken::new(), move |lane| {
                hex(&store.put_with(lane, &bytes, mixdog_statefile::Access::Inherit).unwrap()).to_owned()
            })
            .await
            .unwrap()
        };
        let items =
            vec![item("m1/0", LegacySource::Base64(b64(&a))), item("m2/0", LegacySource::BlobRef(reference)), item("m3/0", LegacySource::Base64(b64(&a)))];
        let (report, progress) = run(dir.path(), items.clone(), Cancel::default()).await;
        assert!(report.complete(), "{report:?}");
        assert_eq!(progress.last(), Some(&Progress { done: 3, total: 3 }));
        assert_eq!(global().stats().decodes, 2, "the repeated image is validated once");
        // Rollback compatibility: the original is at the address old code reads.
        let store = BlobStore::new(dir.path());
        assert!(store.path(&digest_of(&a)).exists());
        // Restart: a second run is all verdict reads.
        let (again, _) = run(dir.path(), items, Cancel::default()).await;
        assert_eq!(again, report);
        assert_eq!(global().stats().decodes, 2, "zero decodes after restart");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_stops_at_once_keeps_what_was_imported_and_a_rerun_finishes() {
        let dir = tempfile::tempdir().unwrap();
        let items: Vec<_> = (0..4).map(|i| item(&format!("m{i}/0"), LegacySource::Base64(b64(&png(10 + i, 10))))).collect();
        let cancel = Cancel::default();
        cancel.cancel();
        let (report, progress) = run(dir.path(), items.clone(), cancel).await;
        assert!(report.cancelled && !report.complete());
        assert!(progress.is_empty() && report.results.iter().all(|(_, r)| *r == ItemResult::NotRun));
        let (finished, _) = run(dir.path(), items, Cancel::default()).await;
        assert!(finished.complete());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bad_base64_and_missing_blobs_are_named_for_repair_while_the_rest_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let items = vec![
            item("bad", LegacySource::Base64("not base64!!".into())),
            item("gone", LegacySource::BlobRef("ab".repeat(32))),
            item("ok", LegacySource::Base64(b64(&png(8, 8)))),
        ];
        let (report, _) = run(dir.path(), items, Cancel::default()).await;
        assert!(!report.complete());
        assert_eq!(report.needs_repair(), vec!["bad", "gone"]);
        assert!(matches!(report.results[2].1, ItemResult::Done(_)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_corrupt_legacy_image_is_a_recorded_refusal_not_a_blocked_migration() {
        let dir = tempfile::tempdir().unwrap();
        let mut broken = png(40, 40);
        broken.truncate(broken.len() / 2);
        let (report, _) = run(dir.path(), vec![item("c", LegacySource::Base64(b64(&broken)))], Cancel::default()).await;
        assert!(report.complete(), "a refusal is a verdict; the preflight names it at send time");
        assert!(matches!(&report.results[0].1, ItemResult::Done(m) if m.facts().is_none()));
    }
}
