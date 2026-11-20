//! The one blob store (FORMAT.md §4, SM §9): `<D>/blobs/sha256/<ab>/<64 hex>`, named by the SHA-256 of the bytes. The
//! core's own directory: no 1.4.5 code names it, and the migration gives it every 1.4.5 blob once
//! (`mixdog_migrate::legacy_blobs`).
//!
//! Nothing deletes a blob (FORMAT.md §4.3), and a log rewrite deletes none, so a published blob needs no hold.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blob file I/O runs only in lane jobs (lane proof arguments)")]

use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use mixdog_protocol::BlobDescriptor;
use mixdog_protocol::MAX_BLOB_BYTES;
use mixdog_protocol::message_class::user_text::Blobs;
use mixdog_protocol::message_class::user_text::ReadError;
use mixdog_rt::InLane;
use sha2::Digest as _;
use sha2::Sha256;

use crate::fsio::Access;
use crate::fsio::IoError;
use crate::fsio::IoLane;
use crate::fsio::IoOp;
use crate::fsio::err;
use crate::schema::blob::BLOB_DIR;
use crate::schema::blob::BODY_MEDIA_TYPE;
use crate::schema::blob::BodyBlob;
use crate::schema::blob::DIGEST_PREFIX;
use crate::schema::bounded::Digest;

#[derive(Debug, thiserror::Error)]
pub enum BlobError {
    #[error("item too large: {bytes} bytes")]
    ItemTooLarge { bytes: u64 },
    #[error("blob missing: {digest}")]
    Missing { digest: Digest },
    #[error("blob corrupt: {digest}")]
    Corrupt { digest: Digest },
    #[error(transparent)]
    Io(#[from] IoError),
}

/// `sha256:<hex>` of `bytes`.
pub fn digest_of(bytes: &[u8]) -> Digest {
    let hash = Sha256::digest(bytes);
    let mut text = String::with_capacity(DIGEST_PREFIX.len() + 64);
    text.push_str(DIGEST_PREFIX);
    for b in hash {
        text.push_str(&format!("{b:02x}"));
    }
    Digest::try_from(text).expect("sha256 hex is a digest")
}

/// The 64 hex digits of `digest`: the reference the attachment layer names the blob by (`attachmentRef`).
pub fn hex(digest: &Digest) -> &str {
    &digest.as_str()[DIGEST_PREFIX.len()..]
}

/// The digest an attachment reference names (`/^[a-f0-9]{64}$/`, `attachmentPath`); `None` for anything else.
pub fn digest_of_reference(reference: &str) -> Option<Digest> {
    Digest::try_from(format!("{DIGEST_PREFIX}{reference}")).ok()
}

/// Handle to the blob store; cheap to clone.
#[derive(Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    /// The store under data dir `data_dir`.
    pub fn new(data_dir: &Path) -> Self {
        // One component at a time: the paths a failed read names carry the platform's separator, as
        // Node's `path.join` writes them.
        let root = BLOB_DIR.split('/').fold(data_dir.to_path_buf(), |path, part| path.join(part));
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn path(&self, digest: &Digest) -> PathBuf {
        let h = hex(digest);
        self.root.join(&h[..2]).join(h)
    }

    /// [`Self::put_unlaned`] creating the file with `access` ([`crate::fsio::publish_file_with`], which needs no write
    /// lane): the session's prompt-attachment intake and staged originals publish from the lane they run on.
    pub fn put_with<L: IoLane>(&self, _lane: &InLane<L>, bytes: &[u8], access: Access) -> Result<Digest, BlobError> {
        self.put_unlaned(bytes, |path, bytes| crate::fsio::publish_file_with(path, bytes, access))
    }

    /// [`Self::put_unlaned`] on a write lane.
    pub fn put<L: crate::fsio::WriteLane>(&self, lane: &InLane<L>, bytes: &[u8]) -> Result<Digest, BlobError> {
        self.put_unlaned(bytes, |path, bytes| crate::fsio::publish_file(lane, path, bytes))
    }

    /// Publishes `bytes` (SM §7.5 step 1) for a frame about to be committed and returns their digest. An existing file whose
    /// bytes hash to its name is kept; any other (unreadable, or cut short by a crash) is replaced by the publish's rename:
    /// these bytes are the ones the name stands for (`saveBuffer`, `attachments/store.mjs:146-160`).
    pub(crate) fn put_unlaned(&self, bytes: &[u8], publish: impl FnOnce(&Path, &[u8]) -> Result<(), IoError>) -> Result<Digest, BlobError> {
        if bytes.len() as u64 > MAX_BLOB_BYTES {
            return Err(BlobError::ItemTooLarge { bytes: bytes.len() as u64 });
        }
        let digest = digest_of(bytes);
        let path = self.path(&digest);
        if read_verified(&path, &digest).is_err() {
            publish(&path, bytes)?;
        }
        Ok(digest)
    }

    /// The bytes of `digest`, verified (`blobCorrupt` on a mismatch).
    pub fn read<L: IoLane>(&self, _lane: &InLane<L>, digest: &Digest) -> Result<Vec<u8>, BlobError> {
        read_verified(&self.path(digest), digest)
    }

    /// The size of the stored file of `digest` (`statSync(attachmentPath(ref)).size`, no
    /// verification); `None` when it is not there.
    pub fn len<L: IoLane>(&self, _lane: &InLane<L>, digest: &Digest) -> Result<Option<u64>, BlobError> {
        let path = self.path(digest);
        match std::fs::metadata(&path) {
            Ok(meta) => Ok(Some(meta.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(err(IoOp::Open, &path)(e).into()),
        }
    }

    /// Streams the file of `digest` through SHA-256 without holding its bytes: its length when they hash to its name
    /// (`blobCorrupt` otherwise). A reader that pages a blob verifies it once with this, then reads pages with
    /// [`Self::read_range`].
    pub fn verify<L: IoLane>(&self, _lane: &InLane<L>, digest: &Digest) -> Result<u64, BlobError> {
        let path = self.path(digest);
        let file = open_blob(&path, digest)?;
        let mut hasher = Sha256::new();
        let len = std::io::copy(&mut file.take(MAX_BLOB_BYTES + 1), &mut HashWriter(&mut hasher)).map_err(err(IoOp::Read, &path))?;
        let hash = hasher.finalize();
        let mut text = String::with_capacity(DIGEST_PREFIX.len() + 64);
        text.push_str(DIGEST_PREFIX);
        for b in hash {
            text.push_str(&format!("{b:02x}"));
        }
        if text != digest.as_str() {
            return Err(BlobError::Corrupt { digest: digest.clone() });
        }
        Ok(len)
    }

    /// Up to `len` bytes of the file of `digest` from `offset` (fewer at its end), not verified: for a blob
    /// [`Self::verify`] accepted.
    pub fn read_range<L: IoLane>(&self, _lane: &InLane<L>, digest: &Digest, offset: u64, len: usize) -> Result<Vec<u8>, BlobError> {
        use std::io::Seek as _;
        let path = self.path(digest);
        let mut file = open_blob(&path, digest)?;
        file.seek(std::io::SeekFrom::Start(offset)).map_err(err(IoOp::Read, &path))?;
        let mut bytes = Vec::with_capacity(len.min(1 << 20));
        file.take(len as u64).read_to_end(&mut bytes).map_err(err(IoOp::Read, &path))?;
        Ok(bytes)
    }

    pub(crate) fn read_unlaned(&self, digest: &Digest) -> Result<Vec<u8>, BlobError> {
        read_verified(&self.path(digest), digest)
    }
}

/// Feeds what is written to a hasher.
struct HashWriter<'a>(&'a mut Sha256);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.update(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn open_blob(path: &Path, digest: &Digest) -> Result<std::fs::File, BlobError> {
    match std::fs::File::open(path) {
        Ok(f) => Ok(f),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(BlobError::Missing { digest: digest.clone() }),
        Err(e) => Err(err(IoOp::Open, path)(e).into()),
    }
}

fn read_verified(path: &Path, digest: &Digest) -> Result<Vec<u8>, BlobError> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(BlobError::Missing { digest: digest.clone() });
        }
        Err(e) => return Err(err(IoOp::Open, path)(e).into()),
    };
    let mut bytes = Vec::new();
    file.by_ref().take(MAX_BLOB_BYTES + 1).read_to_end(&mut bytes).map_err(err(IoOp::Read, path))?;
    if digest_of(&bytes) != *digest {
        return Err(BlobError::Corrupt { digest: digest.clone() });
    }
    Ok(bytes)
}

/// The store inside one lane job, as the stored text is read through it (the session's user text, the compaction, the
/// transcript commit).
pub struct LaneBlobs<'a, L> {
    pub blobs: &'a BlobStore,
    pub lane: &'a InLane<L>,
}

impl<L: IoLane> Blobs for LaneBlobs<'_, L> {
    /// `readAttachmentTextWithin` (store.mjs:430): the blob's UTF-8 text when the file holds at most `max_bytes`, `None` when
    /// it holds more. A file that is not there is `Missing`; a reference off the pattern (`attachmentPath` throws), an empty or
    /// non-regular file, one whose bytes do not hash to its name, and every other failure are `Other`. The size is the file's
    /// own, and at most `max_bytes + 1` bytes are read.
    fn text_within(&self, reference: &str, max_bytes: u64) -> Result<Option<String>, ReadError> {
        let digest = digest_of_reference(reference).ok_or(ReadError::Other)?;
        let path = self.blobs.path(&digest);
        let failure = |error: std::io::Error| if error.kind() == std::io::ErrorKind::NotFound { ReadError::Missing } else { ReadError::Other };
        let meta = mixdog_statefile::metadata(self.lane, &path).map_err(failure)?;
        if !meta.is_file() || meta.len() == 0 {
            return Err(ReadError::Other);
        }
        if meta.len() > max_bytes {
            return Ok(None);
        }
        let wanted = usize::try_from(max_bytes.saturating_add(1)).unwrap_or(usize::MAX);
        let bytes = mixdog_statefile::read_range(self.lane, &path, 0, wanted).map_err(failure)?;
        if bytes.len() as u64 > max_bytes {
            return Ok(None);
        }
        if digest_of(&bytes) != digest {
            return Err(ReadError::Other);
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

/// The descriptor of a body slot whose encoding is `bytes`.
pub fn body_blob(bytes: &[u8]) -> BodyBlob {
    BodyBlob::try_from(BlobDescriptor { digest: digest_of(bytes), bytes: bytes.len() as u64, media_type: BODY_MEDIA_TYPE.to_owned() })
        .expect("a body descriptor is well formed")
}
