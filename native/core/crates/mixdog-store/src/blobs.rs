//! The one blob store (FORMAT.md §4, SM §9): `<D>/prompt-attachments/sha256/<ab>/<64 hex>`,
//! named by the SHA-256 of the bytes.
//!
//! GC and publication meet under the blob's shard mutex (`<ab>`). A writer pins a digest
//! under that mutex before publishing it and keeps the pin until the referencing frame is
//! projected into `blob_refs`; GC deletes only unpinned digests under the same mutex. The
//! pin replaces holding the mutex itself across the barrier and the projection, so no
//! lock is held across I/O and unrelated sessions never wait on each other.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blob file I/O runs only in lane jobs (lane proof arguments)")]

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_protocol::BlobDescriptor;
use mixdog_protocol::MAX_BLOB_BYTES;
use mixdog_rt::InLane;
use sha2::Digest as _;
use sha2::Sha256;

use crate::fsio::IoError;
use crate::fsio::IoLane;
use crate::fsio::IoOp;
use crate::fsio::WriteLane;
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

fn hex(digest: &Digest) -> &str {
    &digest.as_str()[DIGEST_PREFIX.len()..]
}

struct Shard {
    pins: Mutex<HashMap<String, u32>>,
}

struct Inner {
    root: PathBuf,
    shards: Vec<Shard>,
}

/// Handle to the blob store; cheap to clone.
#[derive(Clone)]
pub struct BlobStore {
    inner: Arc<Inner>,
}

/// Keeps a digest from GC until dropped (after the referencing frame is projected).
pub struct BlobPin {
    inner: Arc<Inner>,
    digest: Digest,
}

impl std::fmt::Debug for BlobPin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("BlobPin").field(&self.digest.as_str()).finish()
    }
}

impl BlobPin {
    pub fn digest(&self) -> &Digest {
        &self.digest
    }
}

impl Drop for BlobPin {
    fn drop(&mut self) {
        let shard = self.inner.shard(&self.digest);
        let mut pins = shard.pins.lock().unwrap_or_else(|e| e.into_inner());
        let key = hex(&self.digest);
        if let Some(n) = pins.get_mut(key) {
            *n -= 1;
            if *n == 0 {
                pins.remove(key);
            }
        }
    }
}

impl Inner {
    fn shard(&self, digest: &Digest) -> &Shard {
        let h = hex(digest);
        let index = u8::from_str_radix(&h[..2], 16).expect("hex digest");
        &self.shards[usize::from(index)]
    }

    fn pin(self: &Arc<Self>, digest: &Digest) -> BlobPin {
        let mut pins = self.shard(digest).pins.lock().unwrap_or_else(|e| e.into_inner());
        *pins.entry(hex(digest).to_owned()).or_insert(0) += 1;
        BlobPin {
            inner: self.clone(),
            digest: digest.clone(),
        }
    }
}

impl BlobStore {
    /// The store under data dir `data_dir`.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            inner: Arc::new(Inner {
                root: data_dir.join(BLOB_DIR),
                shards: (0..256).map(|_| Shard { pins: Mutex::new(HashMap::new()) }).collect(),
            }),
        }
    }

    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    pub fn path(&self, digest: &Digest) -> PathBuf {
        let h = hex(digest);
        self.inner.root.join(&h[..2]).join(h)
    }

    /// Pins `digest` (see the module docs).
    pub fn pin(&self, digest: &Digest) -> BlobPin {
        self.inner.pin(digest)
    }

    /// Publishes `bytes` (SM §7.5 step 1) and returns its pin. An existing file whose bytes
    /// hash to its name is kept; any other existing file is replaced.
    pub fn put<L: WriteLane>(&self, lane: &InLane<L>, bytes: &[u8]) -> Result<BlobPin, BlobError> {
        self.put_unlaned(bytes, |path, bytes| crate::fsio::publish_file(lane, path, bytes))
    }

    pub(crate) fn put_unlaned(
        &self,
        bytes: &[u8],
        publish: impl FnOnce(&Path, &[u8]) -> Result<(), IoError>,
    ) -> Result<BlobPin, BlobError> {
        if bytes.len() as u64 > MAX_BLOB_BYTES {
            return Err(BlobError::ItemTooLarge { bytes: bytes.len() as u64 });
        }
        let digest = digest_of(bytes);
        let pin = self.pin(&digest);
        let path = self.path(&digest);
        let present = match read_verified(&path, &digest) {
            Ok(_) => true,
            Err(BlobError::Missing { .. } | BlobError::Corrupt { .. }) => false,
            Err(e) => return Err(e),
        };
        if !present {
            publish(&path, bytes)?;
        }
        Ok(pin)
    }

    /// The bytes of `digest`, verified (`blobCorrupt` on a mismatch).
    pub fn read<L: IoLane>(&self, _lane: &InLane<L>, digest: &Digest) -> Result<Vec<u8>, BlobError> {
        read_verified(&self.path(digest), digest)
    }

    pub(crate) fn read_unlaned(&self, digest: &Digest) -> Result<Vec<u8>, BlobError> {
        read_verified(&self.path(digest), digest)
    }

    /// GC of one shard (`<ab>`, 0..=255), SM §9 conditions 3 and 4; the caller has checked
    /// conditions 1 and 2. `referenced` answers condition 3. Deletion happens under the
    /// shard mutex and skips pinned digests. Returns the deleted digests.
    pub fn collect_shard(
        &self,
        _lane: &InLane<mixdog_rt::MaintenanceIo>,
        shard: u8,
        now: SystemTime,
        min_age: Duration,
        referenced: &mut dyn FnMut(&Digest) -> Result<bool, crate::sqlite::DbError>,
    ) -> Result<Vec<Digest>, GcError> {
        let dir = self.inner.root.join(format!("{shard:02x}"));
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(GcError::Io(err(IoOp::List, &dir)(e))),
        };
        let mut deleted = Vec::new();
        let mut removed_leftover = false;
        for entry in entries {
            mixdog_rt::job_progress();
            let entry = entry.map_err(|e| GcError::Io(err(IoOp::List, &dir)(e)))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            if is_writer_leftover(&name) {
                // A writer that died between create and rename: gone once it is as old as a
                // collectable blob. Node ignores one it cannot stat or unlink.
                let aged = entry.metadata().and_then(|m| m.modified()).is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() >= min_age);
                removed_leftover |= aged && std::fs::remove_file(&path).is_ok();
                continue;
            }
            let Ok(digest) = Digest::try_from(format!("{DIGEST_PREFIX}{name}")) else {
                continue;
            };
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .map_err(|e| GcError::Io(err(IoOp::Read, &path)(e)))?;
            // Node collects a blob whose mtime is at or before `now - min_age`.
            if now.duration_since(modified).unwrap_or_default() < min_age {
                continue;
            }
            let pins = self
                .inner
                .shard(&digest)
                .pins
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if pins.contains_key(hex(&digest)) {
                continue;
            }
            // Asked only now, under the shard's pin lock: a writer that pinned, referenced and
            // unpinned the digest since an earlier look cannot slip between the answer and the
            // unlink, so a referenced blob is never removed.
            if referenced(&digest)? {
                continue;
            }
            std::fs::remove_file(&path).map_err(|e| GcError::Io(err(IoOp::Remove, &path)(e)))?;
            drop(pins);
            deleted.push(digest);
        }
        if !deleted.is_empty() || removed_leftover {
            crate::fsio::sync_dir(&dir).map_err(GcError::Io)?;
        }
        Ok(deleted)
    }
}

fn is_lower_hex(bytes: &[u8]) -> bool {
    bytes.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A file a blob writer leaves behind when it dies before its rename: Node's
/// `.?<64 hex>.<anything>.tmp` and `<64 hex>.mixdog-tmp-<hex>`, and this store's own
/// `.<64 hex>.tmp-<16 hex>` ([`crate::fsio::is_tmp_name`]).
fn is_writer_leftover(name: &str) -> bool {
    let bare = name.strip_prefix('.').unwrap_or(name).as_bytes();
    if bare.len() < 66 || !is_lower_hex(&bare[..64]) || bare[64] != b'.' {
        return false;
    }
    let rest = &bare[65..];
    let dotted_prefix = name.len() != bare.len();
    let tagged = !dotted_prefix
        && rest.strip_prefix(b"mixdog-tmp-").is_some_and(|tail| !tail.is_empty() && is_lower_hex(tail));
    let own = dotted_prefix && crate::fsio::is_tmp_name(name);
    let dotted = rest.len() > 4 && rest.ends_with(b".tmp");
    tagged || own || dotted
}

#[derive(Debug, thiserror::Error)]
pub enum GcError {
    #[error(transparent)]
    Io(IoError),
    #[error(transparent)]
    Db(#[from] crate::sqlite::DbError),
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
    file.by_ref()
        .take(MAX_BLOB_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(err(IoOp::Read, path))?;
    if digest_of(&bytes) != *digest {
        return Err(BlobError::Corrupt { digest: digest.clone() });
    }
    Ok(bytes)
}

/// The descriptor of a body slot whose encoding is `bytes`.
pub fn body_blob(bytes: &[u8]) -> BodyBlob {
    BodyBlob::try_from(BlobDescriptor {
        digest: digest_of(bytes),
        bytes: bytes.len() as u64,
        media_type: BODY_MEDIA_TYPE.to_owned(),
    })
    .expect("a body descriptor is well formed")
}
