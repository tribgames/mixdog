//! Blob references in a request's params, expanded for the app server before the method runs.
//!
//! A payload above the inbound frame bound is uploaded with `blob/put` and the request carries
//! `{"$blobRef": digest, "as": "text" | "base64"}` where the string would be. Only the pointers
//! `blob_fields::fields(method)` lists may hold one: a reference anywhere else is refused with
//! `invalidParams` ("a string"), so no method meets an object where its decoder expects text.
//! The blob replaces the object as its UTF-8 text (bytes that are not UTF-8 are refused) or as
//! standard base64. The expanded total is checked from the stored sizes before a blob is read.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_app_protocol::boundary::blob_fields;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_server::param_refs::ParamRefs;
use mixdog_core_api::CoreError;
use mixdog_protocol::BlobDigest;
use mixdog_rt::CancellationToken;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_store::blobs::BlobStore;
use serde_json::Value;

use mixdog_core_base::support::invalid;
use mixdog_core_base::support::on_lane;

use super::store_error;

/// The characters every string a capability call carries may add up to: `MAX_STRUCTURED_STRING_TOTAL`
/// (`capability-request.ts`), which also bounds submit options; a workspace text is at most `MAX_TEXT_FILE_LENGTH`.
const MAX_STRUCTURED_STRING_TOTAL: u64 = 32_000_000;
const MAX_TEXT_FILE_LENGTH: u64 = 4_194_304;

/// The most characters `method` may have expanded from blobs: the sum of what its validators accept today in the listed
/// fields, so the expansion refuses no input that is accepted and the method's own validator applies the finer bounds.
fn expansion_bound(method: &str) -> u64 {
    match method {
        // The prompt (text `MAX_PROMPT_LENGTH`, images `MAX_PROMPT_IMAGE_BASE64_TOTAL`, files
        // `MAX_PROMPT_FILE_BASE64_TOTAL`, prompt-limits.ts) and the submit options validated apart.
        "turn/start" | "thread/start" | "room/send" => 1_000_000 + 30_000_000 + 28_000_000 + MAX_STRUCTURED_STRING_TOTAL,
        // Up to 100 files, each with content and expected content (`requiredWorkspaceTextWrites`).
        "projectFs/writeTextBatch" => 100 * 2 * MAX_TEXT_FILE_LENGTH,
        _ => MAX_STRUCTURED_STRING_TOTAL,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Encoding {
    Text,
    Base64,
}

impl Encoding {
    /// The characters `bytes` stored bytes make.
    fn chars(self, bytes: u64) -> u64 {
        match self {
            Self::Text => bytes,
            Self::Base64 => bytes.div_ceil(3).saturating_mul(4),
        }
    }
}

/// One reference found in the params: where it is (a JSON pointer), what it names and how it is read.
struct Found {
    pointer: String,
    digest: BlobDigest,
    encoding: Encoding,
}

/// Expands `{"$blobRef"}` objects at the listed pointers of a method's params.
pub struct BlobParamRefs {
    store: BlobStore,
    interactive: InteractiveIo,
    bound: fn(&str) -> u64,
}

impl BlobParamRefs {
    /// `store` is the data dir's blob store, the one `blob/put` publishes to.
    pub fn new(store: BlobStore, tokens: &LaneTokens, _limits: &Limits) -> Arc<Self> {
        Arc::new(Self { store, interactive: tokens.interactive_io, bound: expansion_bound })
    }

    async fn stored_len(&self, found: &Found, cancel: &CancellationToken) -> Result<u64, CoreError> {
        let (store, digest) = (self.store.clone(), found.digest.clone());
        on_lane(self.interactive, cancel, move |lane| store.len(lane, &digest))
            .await?
            .map_err(|error| store_error(error, &found.digest))?
            .ok_or_else(|| CoreError::BlobNotFound { digest: found.digest.clone() })
    }

    async fn read(&self, found: &Found, cancel: &CancellationToken) -> Result<Vec<u8>, CoreError> {
        let (store, digest) = (self.store.clone(), found.digest.clone());
        on_lane(self.interactive, cancel, move |lane| store.read(lane, &digest))
            .await?
            .map_err(|error| store_error(error, &found.digest))
    }
}

/// Whether `path` (the keys and indexes down to a value) is one of the listed pointers, `*` matching any one segment.
fn listed(pointers: &[&str], path: &[String]) -> bool {
    pointers.iter().any(|pointer| {
        let mut want = pointer.split('/').skip(1);
        let mut have = path.iter();
        loop {
            match (want.next(), have.next()) {
                (None, None) => return true,
                (Some(want), Some(have)) if want == "*" || want == have.as_str() => {}
                _ => return false,
            }
        }
    })
}

fn pointer_of(path: &[String]) -> String {
    path.iter().map(|segment| format!("/{}", segment.replace('~', "~0").replace('/', "~1"))).collect()
}

/// A reference object read as a `Found`: exactly `$blobRef` (a digest) and `as`.
fn reference(object: &serde_json::Map<String, Value>, pointer: String) -> Result<Found, CoreError> {
    if object.keys().any(|key| key != "$blobRef" && key != "as") {
        return Err(invalid(&pointer, "{\"$blobRef\": digest, \"as\": \"text\" | \"base64\"}"));
    }
    let digest = object
        .get("$blobRef")
        .and_then(Value::as_str)
        .and_then(|text| text.parse::<BlobDigest>().ok())
        .ok_or_else(|| invalid(&format!("{pointer}/$blobRef"), "a blob digest"))?;
    let encoding = match object.get("as").and_then(Value::as_str) {
        Some("text") => Encoding::Text,
        Some("base64") => Encoding::Base64,
        _ => return Err(invalid(&format!("{pointer}/as"), "\"text\" or \"base64\"")),
    };
    Ok(Found { pointer, digest, encoding })
}

/// Collects the references under `value`; one at a place `pointers` does not list is refused.
fn scan(value: &Value, pointers: &[&str], path: &mut Vec<String>, found: &mut Vec<Found>) -> Result<(), CoreError> {
    match value {
        Value::Object(object) if object.contains_key("$blobRef") => {
            let pointer = pointer_of(path);
            if !listed(pointers, path) {
                return Err(invalid(&pointer, "a string"));
            }
            found.push(reference(object, pointer)?);
        }
        Value::Object(object) => {
            for (key, entry) in object {
                path.push(key.clone());
                scan(entry, pointers, path, found)?;
                path.pop();
            }
        }
        Value::Array(entries) => {
            for (index, entry) in entries.iter().enumerate() {
                path.push(index.to_string());
                scan(entry, pointers, path, found)?;
                path.pop();
            }
        }
        _ => {}
    }
    Ok(())
}

#[async_trait]
impl ParamRefs for BlobParamRefs {
    async fn expand(&self, method: &str, params: &mut Value, cancel: &CancellationToken) -> Result<(), CoreError> {
        let mut found = Vec::new();
        scan(params, blob_fields::fields(method), &mut Vec::new(), &mut found)?;
        if found.is_empty() {
            return Ok(());
        }
        // Every size is known before the first blob is read, so a request over the bound allocates none of it.
        let bound = (self.bound)(method);
        let mut total = 0u64;
        for reference in &found {
            let bytes = self.stored_len(reference, cancel).await?;
            total = total.saturating_add(reference.encoding.chars(bytes));
            if total > bound {
                return Err(CoreError::ItemTooLarge { limit: bound });
            }
        }
        for reference in found {
            let bytes = self.read(&reference, cancel).await?;
            let text = match reference.encoding {
                Encoding::Text => String::from_utf8(bytes).map_err(|_| invalid(&reference.pointer, "a blob of UTF-8 text"))?,
                Encoding::Base64 => STANDARD.encode(bytes),
            };
            if let Some(slot) = params.pointer_mut(&reference.pointer) {
                *slot = Value::String(text);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::CallContext;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::Reply;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::service::DomainService;
    use mixdog_store::blobs::digest_of;
    use serde_json::json;

    use super::*;
    use crate::domains::blob::BlobService;

    struct Fixture {
        _dir: tempfile::TempDir,
        refs: BlobParamRefs,
    }

    /// A store holding `blobs`, uploaded through `blob/put` as a client does; returns their digests in order.
    async fn fixture(blobs: &[&[u8]]) -> (Fixture, Vec<String>) {
        let dir = tempfile::tempdir().unwrap();
        let limits = Limits::default();
        let tokens = mixdog_rt::testing::tokens();
        let service = BlobService::new(BlobStore::new(dir.path()), &tokens, &limits);
        let mut digests = Vec::new();
        for bytes in blobs {
            let digest = digest_of(bytes).as_str().to_owned();
            let req = CoreRequest {
                method: Method("blob/put"),
                params: json!({ "digest": digest, "offset": 0, "bytesB64": STANDARD.encode(bytes) }),
                op: None,
                ctx: CallContext::internal("test"),
            };
            assert!(matches!(service.call(req).await.unwrap(), Reply::Value(_)));
            digests.push(digest);
        }
        let refs = BlobParamRefs { store: BlobStore::new(dir.path()), interactive: tokens.interactive_io, bound: expansion_bound };
        (Fixture { _dir: dir, refs }, digests)
    }

    async fn expand(fixture: &Fixture, method: &str, params: &mut Value) -> Result<(), CoreError> {
        fixture.refs.expand(method, params, &CancellationToken::new()).await
    }

    #[tokio::test]
    async fn expands_text() {
        let (fixture, digests) = fixture(&["héllo\nworld".as_bytes()]).await;
        let mut params = json!({ "root": "r", "rel": "a.txt", "content": { "$blobRef": digests[0], "as": "text" }, "expectedContent": "" });
        expand(&fixture, "projectFs/writeText", &mut params).await.unwrap();
        assert_eq!(params["content"], "héllo\nworld");
        assert_eq!(params["expectedContent"], "");
    }

    #[tokio::test]
    async fn expands_base64() {
        let (fixture, digests) = fixture(&[&[0u8, 255, 1, 2]]).await;
        let mut params = json!({ "input": { "prompt": [
            { "type": "text", "text": "x" },
            { "type": "image", "mimeType": "image/png", "data": { "$blobRef": digests[0], "as": "base64" } }
        ] } });
        expand(&fixture, "turn/start", &mut params).await.unwrap();
        assert_eq!(params["input"]["prompt"][1]["data"], STANDARD.encode([0u8, 255, 1, 2]));
        assert_eq!(params["input"]["prompt"][0]["text"], "x");
    }

    #[tokio::test]
    async fn params_without_a_reference_are_left_alone() {
        let (fixture, _) = fixture(&[]).await;
        let mut params = json!({ "input": { "prompt": "hi", "other": {} } });
        let before = params.clone();
        expand(&fixture, "turn/start", &mut params).await.unwrap();
        assert_eq!(params, before);
    }

    #[tokio::test]
    async fn unlisted_pointer_refused() {
        let (fixture, digests) = fixture(&[b"abc"]).await;
        let reference = json!({ "$blobRef": digests[0], "as": "text" });
        // A place of a listed method that is not listed.
        let mut params = json!({ "input": { "prompt": "x", "options": { "displayText": reference.clone() } } });
        let error = expand(&fixture, "turn/start", &mut params).await.unwrap_err();
        assert!(matches!(&error, CoreError::InvalidParams { path, expected } if &**path == "/input/options/displayText" && &**expected == "a string"));
        // A method that lists nothing.
        let mut params = json!({ "anything": reference.clone() });
        let error = expand(&fixture, "thread/list", &mut params).await.unwrap_err();
        assert!(matches!(&error, CoreError::InvalidParams { path, .. } if &**path == "/anything"));
        // Below a listed pointer.
        let mut params = json!({ "content": { "deeper": reference } });
        assert!(expand(&fixture, "projectFs/writeText", &mut params).await.is_err());
    }

    #[tokio::test]
    async fn malformed_reference_refused() {
        let (fixture, digests) = fixture(&[b"abc"]).await;
        for reference in [
            json!({ "$blobRef": "sha256:xyz", "as": "text" }),
            json!({ "$blobRef": digests[0] }),
            json!({ "$blobRef": digests[0], "as": "hex" }),
            json!({ "$blobRef": digests[0], "as": "text", "more": 1 }),
        ] {
            let mut params = json!({ "content": reference });
            let error = expand(&fixture, "projectFs/writeText", &mut params).await.unwrap_err();
            assert!(matches!(error, CoreError::InvalidParams { .. }));
        }
    }

    #[tokio::test]
    async fn invalid_utf8_as_text_refused() {
        let (fixture, digests) = fixture(&[&[0xff, 0xfe, 0x41]]).await;
        let mut params = json!({ "content": { "$blobRef": digests[0], "as": "text" } });
        let error = expand(&fixture, "projectFs/writeText", &mut params).await.unwrap_err();
        assert!(matches!(error, CoreError::InvalidParams { .. }));
        let mut params = json!({ "content": { "$blobRef": digests[0], "as": "base64" } });
        expand(&fixture, "projectFs/writeText", &mut params).await.unwrap();
    }

    #[tokio::test]
    async fn missing_blob() {
        let (fixture, _) = fixture(&[]).await;
        let absent = digest_of(b"never uploaded").as_str().to_owned();
        let mut params = json!({ "content": { "$blobRef": absent, "as": "text" } });
        let error = expand(&fixture, "projectFs/writeText", &mut params).await.unwrap_err();
        assert!(matches!(error, CoreError::BlobNotFound { .. }));
    }

    #[tokio::test]
    async fn over_limit_refused() {
        let (mut fixture, digests) = fixture(&[b"0123456789", b"abcdef"]).await;
        // 10 text characters and 8 base64 characters: each within a bound of 17, together over it.
        fixture.refs.bound = |_| 17;
        let mut one = json!({ "content": { "$blobRef": digests[0], "as": "text" } });
        expand(&fixture, "projectFs/writeText", &mut one).await.unwrap();
        let mut both = json!({
            "content": { "$blobRef": digests[0], "as": "text" },
            "expectedContent": { "$blobRef": digests[1], "as": "base64" }
        });
        let error = expand(&fixture, "projectFs/writeText", &mut both).await.unwrap_err();
        assert!(matches!(error, CoreError::ItemTooLarge { limit: 17 }));
        assert!(both["content"].is_object(), "nothing was expanded");
    }

    #[test]
    fn bound_is_what_the_method_accepts_today() {
        assert_eq!(expansion_bound("turn/start"), 91_000_000);
        assert_eq!(expansion_bound("room/send"), expansion_bound("thread/start"));
        assert_eq!(expansion_bound("projectFs/writeTextBatch"), 838_860_800);
        assert!(expansion_bound("projectFs/writeText") >= 2 * MAX_TEXT_FILE_LENGTH);
        assert_eq!(expansion_bound("voice/transcribeAudio"), 32_000_000);
    }
}
