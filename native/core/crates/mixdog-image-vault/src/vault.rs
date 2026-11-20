//! The versioned image verdict store. Every image enters through [`ImageVault::import`]: the bytes are digested once, validated
//! once behind the process-wide admission controller, the original and its PNG rendition are published as blobs through the
//! blob store's `put_with` (no ownership ticket, and nothing here ever deletes a blob), and the verdict is linked last as an
//! atomically written manifest under `<data>/image-vault/<original digest>.v<validator version>`. A manifest exists only after
//! its blobs do; a crash between leaves blobs without a verdict, which the next import finishes. The send path reads manifests
//! and blobs, never decodes.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;

use mixdog_image_egress::Choice;
use mixdog_image_egress::ImageFacts;
use mixdog_image_egress::Manifest;
use mixdog_image_egress::Outcome;
use mixdog_image_egress::Rendition;
use mixdog_image_egress::admission::AdmitError;
use mixdog_image_egress::admission::Cancel;
use mixdog_image_egress::admission::Coalescer;
use mixdog_image_egress::admission::WORKER_BYTES;
use mixdog_image_egress::admission::global;
use mixdog_imaging::validate::Reject;
use mixdog_imaging::validate::VALIDATOR_VERSION;
use mixdog_imaging::validate::Validated;
use mixdog_imaging::os_heic::HeicCodec as HeicCodecDyn;
use mixdog_imaging::validate::validate_with;
use mixdog_imaging::validate::validate_held;
use mixdog_imaging::validate::with_base64;
use mixdog_rt::InLane;
use mixdog_statefile::Access;
use mixdog_statefile::IoLane;
use mixdog_statefile::read_content;
use mixdog_store::blobs::BlobStore;
use mixdog_store::blobs::digest_of;
use mixdog_store::blobs::digest_of_reference;
use mixdog_store::blobs::hex;
use mixdog_store::fsio::create_dir_durable;
use mixdog_store::fsio::publish_file_with;

const DIR: &str = "image-vault";

/// Why an import produced no verdict. A transient failure is never stored.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ImportError {
    /// The queue was full or the caller cancelled; try again.
    Transient(AdmitError),
    /// A blob or the manifest could not be written; the text names it. Nothing is claimed as stored.
    Storage(String),
    /// The stored file a reference names is not there; there is nothing to import, and the person has to replace the image.
    Missing(String),
    /// The text is not base64 of an image-sized payload; there are no bytes to key a verdict by, so none is stored.
    Invalid(String),
}

/// What a manifest lookup found.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Lookup {
    Found(Manifest),
    Absent,
    /// A manifest of another validator version: migration re-runs it, it is not used.
    Stale { version: u32 },
    /// The manifest file exists and is not intact.
    Damaged,
}

/// Failure to read the stored bytes of an accepted image on the send path.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReadError {
    Missing,
    Corrupt,
}

pub struct ImageVault {
    blobs: BlobStore,
    dir: PathBuf,
    codec: Arc<dyn HeicCodecDyn>,
}

/// Stored with the verdict and shown as it is. The Store names are the ones Microsoft documents for opening HEIC on Windows.
#[cfg(windows)]
const HEIC_NO_DECODER: &str = "this is a HEIC image and this PC cannot read it; convert it to JPEG or PNG and attach it again, or install \"HEIF Image Extensions\" and \"HEVC Video Extensions\" from the Microsoft Store";
#[cfg(not(windows))]
const HEIC_NO_DECODER: &str = "this is a HEIC image and this PC cannot read it; convert it to JPEG or PNG and attach it again";
const HEIC_UNDECODABLE: &str = "this is a HEIC image and this PC cannot read it; convert it to JPEG or PNG and attach it again";

pub fn refusal_text(reject: Reject) -> &'static str {
    match reject {
        Reject::NotAnImage => "it is not an image this app can read",
        Reject::Corrupt => "its data is damaged or incomplete",
        Reject::TooLarge => "it is too large to process",
        Reject::HeicNoDecoder => HEIC_NO_DECODER,
        Reject::HeicUndecodable => HEIC_UNDECODABLE,
        Reject::Busy | Reject::Cancelled => "interrupted",
    }
}

/// Width and height of a rendition just made by the encoder (at most the provider box).
fn rendition_size(bytes: &[u8]) -> (u32, u32) {
    mixdog_imaging::decoded_dimensions(bytes).unwrap_or((0, 0))
}

fn storage<E: std::fmt::Debug>(what: &str, error: E) -> ImportError {
    ImportError::Storage(format!("{what}: {error:?}"))
}

/// The operating system's HEIC codec.
struct SystemCodec;

impl HeicCodecDyn for SystemCodec {
    fn decode(&self, bytes: &[u8], max_pixels: u64) -> Result<mixdog_imaging::decode::Raster, mixdog_imaging::os_heic::HeicFailure> {
        mixdog_imaging::os_heic::system().decode(bytes, max_pixels)
    }
}

type Flight = Result<Manifest, ImportError>;

fn flights() -> &'static Coalescer<(String, u32), Flight> {
    static FLIGHTS: OnceLock<Coalescer<(String, u32), Flight>> = OnceLock::new();
    FLIGHTS.get_or_init(Coalescer::default)
}

impl ImageVault {
    /// The vault of the data dir a blob store lives under (`<data>/blobs/sha256`).
    pub fn for_blobs(blobs: BlobStore) -> Self {
        let data = blobs.root().parent().and_then(Path::parent).expect("the blob dir is under <data>/blobs").to_path_buf();
        Self::new(blobs, &data)
    }

    pub fn new(blobs: BlobStore, data_dir: &Path) -> Self {
        Self { blobs, dir: data_dir.join(DIR), codec: Arc::new(SystemCodec) }
    }

    /// The vault with another HEIC codec (a test stands one in).
    pub fn with_codec(mut self, codec: Arc<dyn HeicCodecDyn>) -> Self {
        self.codec = codec;
        self
    }

    fn manifest_path(&self, original: &str, version: u32) -> PathBuf {
        self.dir.join(format!("{original}.v{version}"))
    }

    /// The manifest of `original` (64 hex) at the current validator version.
    pub fn lookup(&self, original: &str) -> Lookup {
        let current = self.manifest_path(original, VALIDATOR_VERSION);
        match read_content(&current).map(|bytes| bytes.map(String::from_utf8)) {
            Ok(Some(Ok(text))) => match Manifest::decode(&text) {
                Some(manifest) if manifest.original == original && manifest.validator_version == VALIDATOR_VERSION => Lookup::Found(manifest),
                _ => Lookup::Damaged,
            },
            Ok(None) => self.older(original),
            Ok(Some(Err(_))) | Err(_) => Lookup::Damaged,
        }
    }

    fn older(&self, original: &str) -> Lookup {
        for version in (1..VALIDATOR_VERSION).rev() {
            if read_content(&self.manifest_path(original, version)).is_ok_and(|content| content.is_some()) {
                return Lookup::Stale { version };
            }
        }
        Lookup::Absent
    }

    /// Both blobs a manifest names are present (length only: the send path verifies content when it reads them).
    fn blobs_present<L: IoLane>(&self, lane: &InLane<L>, manifest: &Manifest) -> bool {
        let present = |reference: &str, len: u64| {
            digest_of_reference(reference).is_some_and(|digest| matches!(self.blobs.len(lane, &digest), Ok(Some(found)) if found == len))
        };
        match &manifest.outcome {
            Outcome::Refused { .. } => true,
            Outcome::Accepted { rendition, .. } => {
                present(&manifest.original, manifest.encoded_len) && rendition.as_ref().is_none_or(|r| present(&r.digest, r.encoded_len))
            }
        }
    }

    /// Import `bytes` as `name`. The existing verdict is returned without decoding when it is intact and its blobs are present;
    /// a missing blob is republished (repair). Equal concurrent imports share one validation.
    pub fn import<L: IoLane>(&self, lane: &InLane<L>, bytes: &[u8], name: &str, cancel: &Cancel) -> Result<Manifest, ImportError> {
        let original = hex(&digest_of(bytes)).to_owned();
        if let Lookup::Found(manifest) = self.lookup(&original)
            && self.blobs_present(lane, &manifest)
        {
            return Ok(manifest);
        }
        let key = (original.clone(), VALIDATOR_VERSION);
        let result = flights().run(key, cancel, |_stop| self.validate_and_store(lane, &original, bytes, name, cancel));
        match result {
            Ok(flight) => flight,
            Err(admit) => Err(ImportError::Transient(admit)),
        }
    }

    fn validate_and_store<L: IoLane>(&self, lane: &InLane<L>, original: &str, bytes: &[u8], name: &str, cancel: &Cancel) -> Flight {
        // A flight that finished while this caller queued has already stored the verdict.
        if let Lookup::Found(manifest) = self.lookup(original)
            && self.blobs_present(lane, &manifest)
        {
            return Ok(manifest);
        }
        self.finish(lane, original, bytes, name, validate_with(bytes, global(), cancel, self.codec.as_ref()))
    }

    /// Record the verdict alidated for ytes: blobs first, the manifest last. A transient rejection stores nothing.
    fn finish<L: IoLane>(&self, lane: &InLane<L>, original: &str, bytes: &[u8], name: &str, validated: Result<Validated, Reject>) -> Flight {
        let encoded_len = bytes.len() as u64;
        let outcome = match validated {
            Ok(validated) => self.store_blobs(lane, bytes, validated)?,
            // The original is kept beside its refusal: a later validator, codec or replacement decision starts from the bytes.
            Err(reject) if reject.is_permanent() => {
                self.blobs.put_with(lane, bytes, Access::Inherit).map_err(|e| storage("original blob", e))?;
                Outcome::Refused { text: refusal_text(reject).to_owned() }
            }
            Err(Reject::Cancelled) => return Err(ImportError::Transient(AdmitError::Cancelled)),
            Err(_) => return Err(ImportError::Transient(AdmitError::Busy)),
        };
        let manifest = Manifest { validator_version: VALIDATOR_VERSION, original: original.to_owned(), name: name.to_owned(), encoded_len, outcome };
        create_dir_durable(&self.dir).map_err(|e| storage("image-vault dir", e))?;
        publish_file_with(&self.manifest_path(original, VALIDATOR_VERSION), manifest.encode().as_bytes(), Access::Inherit).map_err(|e| storage("manifest", e))?;
        Ok(manifest)
    }

    /// Import base64 (a legacy inline image, a pasted payload). The text is bounded and decoded strictly under the worker slot,
    /// keyed by the digest of the binary and never of the text; an intact verdict is reused without validation.
    pub fn import_base64<L: IoLane>(&self, lane: &InLane<L>, base64: &str, name: &str, cancel: &Cancel) -> Result<Manifest, ImportError> {
        let held = with_base64(base64, global(), cancel, |bytes, held| {
            let original = hex(&digest_of(&bytes)).to_owned();
            if let Lookup::Found(manifest) = self.lookup(&original)
                && self.blobs_present(lane, &manifest)
            {
                return Ok(Ok(manifest));
            }
            Ok(self.finish(lane, &original, &bytes, name, validate_held(&bytes, held, global(), cancel, self.codec.as_ref())))
        });
        match held {
            Ok(flight) => flight,
            Err(Reject::Busy) => Err(ImportError::Transient(AdmitError::Busy)),
            Err(Reject::Cancelled) => Err(ImportError::Transient(AdmitError::Cancelled)),
            Err(reject) => Err(ImportError::Invalid(refusal_text(reject).to_owned())),
        }
    }

    /// Import an image already stored as an attachment blob (a legacy `attachmentRef`). The blob is read, verified, under the
    /// worker slot; an unreadable or oversize one is a named failure, never a guess.
    pub fn import_blob_ref<L: IoLane>(&self, lane: &InLane<L>, reference: &str, name: &str, cancel: &Cancel) -> Result<Manifest, ImportError> {
        let digest = digest_of_reference(reference).ok_or_else(|| ImportError::Invalid("not an attachment reference".into()))?;
        if let Lookup::Found(manifest) = self.lookup(reference)
            && self.blobs_present(lane, &manifest)
        {
            return Ok(manifest);
        }
        let _permit = global().acquire(WORKER_BYTES, cancel).map_err(ImportError::Transient)?;
        match self.blobs.len(lane, &digest) {
            Ok(Some(len)) if len < WORKER_BYTES => {}
            Ok(Some(_)) => return Err(ImportError::Invalid(refusal_text(Reject::TooLarge).to_owned())),
            Ok(None) => return Err(ImportError::Missing(format!("attachment {reference} is missing"))),
            Err(error) => return Err(storage("attachment blob", error)),
        }
        let bytes = self.blobs.read(lane, &digest).map_err(|e| storage("attachment blob", e))?;
        self.finish(lane, reference, &bytes, name, validate_held(&bytes, 0, global(), cancel, self.codec.as_ref()))
    }

    /// Publish the original and the rendition; the manifest is written after both.
    fn store_blobs<L: IoLane>(&self, lane: &InLane<L>, bytes: &[u8], validated: Validated) -> Result<Outcome, ImportError> {
        self.blobs.put_with(lane, bytes, Access::Inherit).map_err(|e| storage("original blob", e))?;
        let rendition = match validated.rendition {
            Some((kind, png)) => {
                let digest = self.blobs.put_with(lane, &png, Access::Inherit).map_err(|e| storage("rendition blob", e))?;
                let (width, height) = rendition_size(&png);
                Some(Rendition { kind, digest: hex(&digest).to_owned(), width, height, encoded_len: png.len() as u64 })
            }
            None => None,
        };
        Ok(Outcome::Accepted { kind: validated.kind, width: validated.width, height: validated.height, frames: validated.frames, rendition })
    }

    /// The bytes of the original or rendition `choice` selects: a verified blob read, no decoding, no hashing of base64.
    pub fn bytes_for<L: IoLane>(&self, lane: &InLane<L>, manifest: &Manifest, choice: Choice) -> Result<Arc<[u8]>, ReadError> {
        let reference = match (&manifest.outcome, choice) {
            (Outcome::Accepted { .. }, Choice::Original) => manifest.original.as_str(),
            (Outcome::Accepted { rendition: Some(r), .. }, Choice::Rendition) => r.digest.as_str(),
            _ => return Err(ReadError::Missing),
        };
        let digest = digest_of_reference(reference).ok_or(ReadError::Corrupt)?;
        match self.blobs.read(lane, &digest) {
            Ok(bytes) => Ok(Arc::from(bytes)),
            Err(mixdog_store::blobs::BlobError::Missing { .. }) => Err(ReadError::Missing),
            Err(_) => Err(ReadError::Corrupt),
        }
    }

    /// The facts of an intact accepted manifest.
    pub fn facts(manifest: &Manifest) -> Option<ImageFacts> {
        manifest.facts()
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_base::support::on_lane_wait as on_lane;
    use mixdog_image_egress::ImageKind;
    use mixdog_image_egress::admission::global;
    use mixdog_imaging::Format;
    use mixdog_imaging::decode::Raster;
    use mixdog_imaging::encode::encode_in_format;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn picture(format: Format, width: u32, height: u32) -> Vec<u8> {
        let data = (0..width * height).flat_map(|i| [(i % 251) as u8, (i % 13) as u8 * 19, (i % 7) as u8 * 36]).collect();
        encode_in_format(&Raster { width, height, has_alpha: false, data }, format).unwrap()
    }

    struct World {
        dir: tempfile::TempDir,
        tokens: mixdog_rt::LaneTokens,
    }

    impl World {
        fn new() -> Self {
            Self { dir: tempfile::tempdir().unwrap(), tokens: mixdog_rt::testing::tokens() }
        }

        fn vault(&self) -> ImageVault {
            ImageVault::new(BlobStore::new(self.dir.path()), self.dir.path())
        }

        async fn import(&self, bytes: Vec<u8>, name: &str) -> Result<Manifest, ImportError> {
            let vault = self.vault();
            let name = name.to_owned();
            on_lane(self.tokens.durability_io, &CancellationToken::new(), move |lane| vault.import(lane, &bytes, &name, &Cancel::default())).await.unwrap()
        }

        async fn read(&self, manifest: Manifest, choice: Choice) -> Result<Arc<[u8]>, ReadError> {
            let vault = self.vault();
            on_lane(self.tokens.durability_io, &CancellationToken::new(), move |lane| vault.bytes_for(lane, &manifest, choice)).await.unwrap()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_import_is_validated_once_and_a_restart_or_repeat_never_decodes() {
        let world = World::new();
        let png = picture(Format::Png, 30, 20);
        let first = world.import(png.clone(), "a.png").await.unwrap();
        assert_eq!(global().stats().decodes, 1);
        // A restart is a new vault over the same data dir; the verdict is read, not recomputed.
        let again = world.import(png.clone(), "other-name.png").await.unwrap();
        assert_eq!(again, first, "the first record stands");
        assert_eq!(global().stats().decodes, 1, "zero decodes on the repeat");
        let facts = ImageVault::facts(&first).unwrap();
        assert_eq!((facts.kind(), facts.frames()), (ImageKind::Png, 1));
        assert_eq!(&*world.read(first, Choice::Original).await.unwrap(), &png[..]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_tiff_is_kept_with_a_decodable_png_rendition() {
        let world = World::new();
        let manifest = world.import(picture(Format::Tiff, 40, 30), "scan.tif").await.unwrap();
        let png = world.read(manifest.clone(), Choice::Rendition).await.unwrap();
        assert_eq!(Format::sniff(&png), Some(Format::Png));
        let original = world.read(manifest, Choice::Original).await.unwrap();
        assert_eq!(Format::sniff(&original), Some(Format::Tiff));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_permanent_refusal_is_recorded_and_not_revalidated() {
        let world = World::new();
        let mut bad = picture(Format::Png, 64, 64);
        bad.truncate(bad.len() / 2);
        let bad_len = bad.len() as u64;
        let first = world.import(bad.clone(), "broken.png").await.unwrap();
        assert!(matches!(first.outcome, Outcome::Refused { .. }));
        let decodes = global().stats().decodes;
        assert_eq!(world.import(bad, "broken.png").await.unwrap(), first);
        assert_eq!(global().stats().decodes, decodes);
        assert!(world.read(first.clone(), Choice::Original).await.is_err(), "no bytes are served for a refused original");
        // The original is nevertheless kept, for a later validator or a replacement decision.
        let (blobs, digest) = (BlobStore::new(world.dir.path()), digest_of_reference(&first.original).unwrap());
        let kept = on_lane(world.tokens.durability_io, &CancellationToken::new(), move |lane| blobs.len(lane, &digest)).await.unwrap();
        assert!(matches!(kept, Ok(Some(len)) if len == bad_len));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_missing_rendition_blob_is_republished_and_a_damaged_manifest_is_rewritten() {
        let world = World::new();
        let tiff = picture(Format::Tiff, 20, 20);
        let manifest = world.import(tiff.clone(), "t.tif").await.unwrap();
        let Outcome::Accepted { rendition: Some(r), .. } = &manifest.outcome else { panic!("rendition expected") };
        let blob = BlobStore::new(world.dir.path()).path(&digest_of_reference(&r.digest).unwrap());
        std::fs::remove_file(&blob).unwrap();
        let repaired = world.import(tiff.clone(), "t.tif").await.unwrap();
        assert_eq!(repaired.outcome, manifest.outcome);
        assert!(blob.exists(), "the rendition was published again");
        // An interrupted import: the manifest is gone (or torn) while the blobs stay.
        let path = world.vault().manifest_path(&manifest.original, VALIDATOR_VERSION);
        std::fs::write(&path, b"torn").unwrap();
        assert_eq!(world.vault().lookup(&manifest.original), Lookup::Damaged);
        assert_eq!(world.import(tiff, "t.tif").await.unwrap().outcome, manifest.outcome);
        assert!(matches!(world.vault().lookup(&manifest.original), Lookup::Found(_)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn fifty_equal_concurrent_imports_share_one_validation() {
        let world = Arc::new(World::new());
        let png = picture(Format::Png, 48, 48);
        let tasks: Vec<_> = (0..50)
            .map(|_| {
                let (world, png) = (Arc::clone(&world), png.clone());
                tokio::spawn(async move { world.import(png, "same.png").await.unwrap() })
            })
            .collect();
        let mut results = Vec::new();
        for task in tasks {
            results.push(task.await.unwrap());
        }
        assert!(results.windows(2).all(|w| w[0] == w[1]));
        assert!(global().stats().decodes <= 3, "decodes: {}", global().stats().decodes);
        assert_eq!(global().stats().max_simultaneous_workers, 1);
    }

    fn heic_bytes() -> Vec<u8> {
        let mut heic = vec![0, 0, 0, 24, b'f', b't', b'y', b'p', b'h', b'e', b'i', b'c', 0, 0, 0, 0, b'm', b'i', b'f', b'1', b'h', b'e', b'i', b'c'];
        heic.extend_from_slice(&[0; 64]);
        heic
    }

    async fn heic_import(world: &World, codec: Arc<dyn HeicCodecDyn>) -> Manifest {
        let vault = world.vault().with_codec(codec);
        on_lane(world.tokens.durability_io, &CancellationToken::new(), move |lane| vault.import(lane, &heic_bytes(), "scan.heic", &Cancel::default())).await.unwrap().unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_heic_the_os_decodes_goes_to_gemini_as_itself_and_elsewhere_as_its_jpeg_rendition() {
        use mixdog_image_egress::Column;
        use mixdog_image_egress::InputImagePolicy;
        use mixdog_imaging::os_heic::fakes::Fixed;
        let world = World::new();
        let data = (0..200 * 100).flat_map(|i| [(i % 251) as u8, 40, 90, 255]).collect();
        let manifest = heic_import(&world, Arc::new(Fixed(Raster { width: 200, height: 100, has_alpha: true, data }))).await;
        let facts = manifest.facts().expect("accepted");
        assert_eq!(facts.kind(), ImageKind::Heic);
        for (column, want) in [
            (Column::Gemini, Choice::Original),
            (Column::Messages, Choice::Rendition),
            (Column::Responses, Choice::Rendition),
            (Column::Chat, Choice::Rendition),
            (Column::Inline, Choice::Rendition),
        ] {
            let choice = mixdog_image_egress::decide::decide_local(&test_origin(), &facts, &InputImagePolicy::for_column(column)).unwrap();
            assert_eq!(choice, want, "{column:?}");
        }
        let jpeg = world.read(manifest.clone(), Choice::Rendition).await.unwrap();
        assert_eq!(Format::sniff(&jpeg), Some(Format::Jpeg));
        assert_eq!(&*world.read(manifest, Choice::Original).await.unwrap(), &heic_bytes()[..], "the original is kept");
    }

    fn test_origin() -> mixdog_image_egress::Origin {
        mixdog_image_egress::Origin {
            session: "s".into(),
            branch: "b".into(),
            message_id: "m".into(),
            role: mixdog_image_egress::Role::User,
            tool_call_id: None,
            part_path: vec![0, 0],
            display_name: "scan.heic".into(),
            turn: 1,
            tool_label: None,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_heic_with_no_codec_or_a_failing_one_is_a_recorded_refusal_in_plain_words() {
        use mixdog_imaging::os_heic::fakes::FailsMidDecode;
        use mixdog_imaging::os_heic::fakes::NoDecoder;
        let world = World::new();
        for codec in [Arc::new(NoDecoder) as Arc<dyn HeicCodecDyn>, Arc::new(FailsMidDecode)] {
            let manifest = heic_import(&world, codec).await;
            let Outcome::Refused { text } = &manifest.outcome else { panic!("refusal expected") };
            assert!(text.contains("HEIC image") && text.contains("cannot read it") && text.contains("convert it to JPEG or PNG"), "{text}");
            assert!(manifest.facts().is_none());
            // Remove the recorded verdict so the next codec is consulted.
            std::fs::remove_file(world.vault().manifest_path(&manifest.original, VALIDATOR_VERSION)).unwrap();
        }
    }
}
