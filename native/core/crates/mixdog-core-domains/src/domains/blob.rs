//! The `blob` domain: `blob/read` pages and `blob/put` chunks over the one blob store
//! (P §3, SPEC R1). Blobs are content-addressed, so neither method is a mutation: a repeated
//! chunk or page has one effect and needs no op id.
//!
//! An upload is staged in memory until the bytes received hash to the digest it names, then
//! published through the store's durability lane. Staged bytes are bounded as a whole;
//! beyond the bound the least recently touched upload is dropped (its client sees a gap and
//! starts again). Reads keep the last verified blobs, so the pages of one blob cost one
//! verified read of the file, not one per page.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::v2::op::BlobPutParams;
use mixdog_app_protocol::v2::op::BlobReadParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_protocol::BlobDigest;
use mixdog_protocol::MAX_BLOB_BYTES;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_store::blobs::BlobError;
use mixdog_store::blobs::BlobStore;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

mod attachment;
mod param_refs;
pub use attachment::AttachmentSource;
pub use param_refs::BlobParamRefs;
pub(crate) use attachment::lane_failure;
pub(crate) use attachment::sanitized_file_name;

use mixdog_core_base::support::decode;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::wrong_method;

/// Staged bytes of all uploads together.
const MAX_STAGED_BYTES: usize = 256 * 1024 * 1024;
/// Verified blobs kept for paging.
const MAX_CACHED_BYTES: usize = 64 * 1024 * 1024;

struct UploadState {
    buf: Vec<u8>,
    hasher: Sha256,
    staged: Arc<AtomicUsize>,
}

impl Drop for UploadState {
    fn drop(&mut self) {
        self.staged.fetch_sub(self.buf.len(), Ordering::Relaxed);
    }
}

struct Upload {
    state: Mutex<UploadState>,
    touched: AtomicU64,
}

#[derive(Default)]
struct Staging {
    uploads: Mutex<HashMap<BlobDigest, Arc<Upload>>>,
    staged: Arc<AtomicUsize>,
    clock: AtomicU64,
}

impl Staging {
    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    fn get(&self, digest: &BlobDigest) -> Option<Arc<Upload>> {
        self.uploads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(digest)
            .cloned()
    }

    /// The upload of `digest`, created empty when none is staged.
    fn entry(&self, digest: &BlobDigest) -> Arc<Upload> {
        let tick = self.tick();
        let mut uploads = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
        let upload = uploads.entry(digest.clone()).or_insert_with(|| {
            Arc::new(Upload {
                state: Mutex::new(UploadState {
                    buf: Vec::new(),
                    hasher: Sha256::new(),
                    staged: self.staged.clone(),
                }),
                touched: AtomicU64::new(tick),
            })
        });
        upload.touched.store(tick, Ordering::Relaxed);
        upload.clone()
    }

    fn remove(&self, digest: &BlobDigest) {
        self.uploads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(digest);
    }

    /// Drops least recently touched uploads other than `keep` until `extra` more bytes fit.
    /// `false` when they do not fit even then.
    fn make_room(&self, keep: &BlobDigest, extra: usize) -> bool {
        let mut uploads = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
        while self.staged.load(Ordering::Relaxed) + extra > MAX_STAGED_BYTES {
            let oldest = uploads
                .iter()
                .filter(|(digest, _)| *digest != keep)
                .min_by_key(|(_, upload)| upload.touched.load(Ordering::Relaxed))
                .map(|(digest, _)| digest.clone());
            match oldest {
                Some(digest) => {
                    uploads.remove(&digest);
                }
                None => return false,
            }
        }
        true
    }
}

/// A verified blob, and when it was last read.
type CachedBlob = (BlobDigest, Arc<Vec<u8>>, u64);

#[derive(Default)]
struct ReadCache {
    entries: Mutex<Vec<CachedBlob>>,
    clock: AtomicU64,
}

impl ReadCache {
    fn get(&self, digest: &BlobDigest) -> Option<Arc<Vec<u8>>> {
        let tick = self.clock.fetch_add(1, Ordering::Relaxed);
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let entry = entries.iter_mut().find(|(d, _, _)| d == digest)?;
        entry.2 = tick;
        Some(entry.1.clone())
    }

    fn insert(&self, digest: BlobDigest, bytes: Arc<Vec<u8>>) {
        if bytes.len() > MAX_CACHED_BYTES {
            return;
        }
        let tick = self.clock.fetch_add(1, Ordering::Relaxed);
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|(d, _, _)| *d != digest);
        let mut total: usize = entries.iter().map(|(_, b, _)| b.len()).sum::<usize>() + bytes.len();
        while total > MAX_CACHED_BYTES {
            let Some(oldest) = entries
                .iter()
                .enumerate()
                .min_by_key(|(_, e)| e.2)
                .map(|(i, _)| i)
            else {
                break;
            };
            total -= entries.remove(oldest).1.len();
        }
        entries.push((digest, bytes, tick));
    }
}

pub struct BlobService {
    store: BlobStore,
    interactive: InteractiveIo,
    durability: DurabilityIo,
    page_bytes: usize,
    chunk_bytes: usize,
    staging: Staging,
    cache: ReadCache,
}

fn store_error(error: BlobError, digest: &BlobDigest) -> CoreError {
    match error {
        BlobError::ItemTooLarge { .. } => CoreError::ItemTooLarge {
            limit: MAX_BLOB_BYTES,
        },
        BlobError::Missing { .. } => CoreError::BlobNotFound {
            digest: digest.clone(),
        },
        BlobError::Corrupt { .. } => CoreError::BlobCorrupt {
            digest: digest.clone(),
        },
        BlobError::Io(_) => CoreError::Internal {
            incident_id: "blob-io".into(),
        },
    }
}

fn hex_of(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl BlobService {
    /// `store` is the data dir's blob store; `limits` are the server's advertised limits
    /// (`maxBlobPageBytes`, `maxBlobPutChunkBytes`).
    pub fn new(store: BlobStore, tokens: &LaneTokens, limits: &Limits) -> Arc<Self> {
        Arc::new(Self {
            store,
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            page_bytes: limits.max_blob_page_bytes as usize,
            chunk_bytes: limits.max_blob_put_chunk_bytes as usize,
            staging: Staging::default(),
            cache: ReadCache::default(),
        })
    }

    async fn verified(
        &self,
        req: &CoreRequest,
        digest: &BlobDigest,
    ) -> Result<Arc<Vec<u8>>, CoreError> {
        if let Some(hit) = self.cache.get(digest) {
            return Ok(hit);
        }
        let store = self.store.clone();
        let wanted = digest.clone();
        let bytes = on_lane(self.interactive, &req.ctx.cancel, move |lane| {
            store.read(lane, &wanted)
        })
        .await?
        .map_err(|e| store_error(e, digest))?;
        let bytes = Arc::new(bytes);
        self.cache.insert(digest.clone(), bytes.clone());
        Ok(bytes)
    }

    async fn read(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: BlobReadParams = decode(req)?;
        let bytes = self.verified(req, &params.digest).await?;
        let offset = usize::try_from(params.offset.unwrap_or(0))
            .unwrap_or(usize::MAX)
            .min(bytes.len());
        let length = params.length.map_or(self.page_bytes, |n| {
            usize::try_from(n)
                .unwrap_or(usize::MAX)
                .min(self.page_bytes)
        });
        let end = offset.saturating_add(length).min(bytes.len());
        Ok(json!({ "bytesB64": STANDARD.encode(&bytes[offset..end]) }))
    }

    async fn put(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: BlobPutParams = decode(req)?;
        let chunk = STANDARD
            .decode(&params.bytes_b64)
            .map_err(|_| invalid("bytesB64", "standard base64"))?;
        if chunk.len() > self.chunk_bytes {
            return Err(invalid(
                "bytesB64",
                "at most limits.maxBlobPutChunkBytes raw bytes",
            ));
        }
        let digest = &params.digest;
        let offset =
            usize::try_from(params.offset).map_err(|_| invalid("offset", "a byte offset"))?;
        let upload = match self.staging.get(digest) {
            Some(upload) => upload,
            // The chunk that completed the blob may be sent again after its answer was lost.
            None if offset > 0 => return self.already_stored(req, digest).await,
            None => self.staging.entry(digest),
        };
        let complete = {
            let mut state = upload.state.lock().unwrap_or_else(|e| e.into_inner());
            let have = state.buf.len();
            // A gap or a resent chunk that differs from what was staged is refused; a resent
            // chunk that repeats it adds only the bytes past the end.
            if offset > have {
                return Err(invalid(
                    "offset",
                    "the next byte after those already received",
                ));
            }
            let held = (have - offset).min(chunk.len());
            if state.buf[offset..offset + held] != chunk[..held] {
                return Err(invalid(
                    "bytesB64",
                    "the bytes already received at this offset",
                ));
            }
            let fresh = &chunk[held..];
            if (have + fresh.len()) as u64 > MAX_BLOB_BYTES {
                drop(state);
                self.staging.remove(digest);
                return Err(CoreError::ItemTooLarge {
                    limit: MAX_BLOB_BYTES,
                });
            }
            if !fresh.is_empty() && !self.staging.make_room(digest, fresh.len()) {
                return Err(CoreError::QueueFull {
                    queue: "blobUploads".into(),
                });
            }
            state.buf.extend_from_slice(fresh);
            state.hasher.update(fresh);
            state.staged.fetch_add(fresh.len(), Ordering::Relaxed);
            upload.touched.store(self.staging.tick(), Ordering::Relaxed);
            if format!("sha256:{}", hex_of(state.hasher.clone())) == digest.as_str() {
                let taken = std::mem::take(&mut state.buf);
                state.staged.fetch_sub(taken.len(), Ordering::Relaxed);
                Some(taken)
            } else {
                None
            }
        };
        if let Some(bytes) = complete {
            self.staging.remove(digest);
            let store = self.store.clone();
            on_lane(self.durability, &req.ctx.cancel, move |lane| {
                store.put(lane, &bytes)
            })
            .await?
            .map_err(|e| store_error(e, digest))?;
        }
        Ok(json!({}))
    }

    async fn already_stored(
        &self,
        req: &CoreRequest,
        digest: &BlobDigest,
    ) -> Result<Value, CoreError> {
        match self.verified(req, digest).await {
            Ok(_) => Ok(json!({})),
            Err(CoreError::BlobNotFound { .. }) => Err(invalid(
                "offset",
                "0: no upload of this blob is in progress",
            )),
            Err(other) => Err(other),
        }
    }
}

#[async_trait]
impl DomainService for BlobService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let value = match req.method.as_str() {
            "blob/read" => self.read(&req).await?,
            "blob/put" => self.put(&req).await?,
            other => return Err(wrong_method("blob", other)),
        };
        Ok(Reply::Value(value))
    }

    fn methods(&self) -> &'static [&'static str] {
        &["blob/read", "blob/put"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
