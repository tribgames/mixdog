use mixdog_app_protocol::limits::Limits;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::DomainService;
use mixdog_store::blobs::BlobStore;
use serde_json::Value;
use serde_json::json;

use super::BlobService;

/// sha256("abc"): the digest of `packages/protocol-client/conformance/08_blobs.json`.
const ABC: &str = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

fn service(dir: &std::path::Path) -> std::sync::Arc<BlobService> {
    let limits = Limits {
        max_blob_page_bytes: 6,
        max_blob_put_chunk_bytes: 2,
        ..Limits::default()
    };
    BlobService::new(BlobStore::new(dir), &mixdog_rt::testing::tokens(), &limits)
}

async fn call(service: &BlobService, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let req = CoreRequest {
        method: Method(method),
        params,
        op: None,
        ctx: CallContext::internal("test"),
    };
    match service.call(req).await? {
        Reply::Value(value) => Ok(value),
        Reply::Subscribe(_) => panic!("blob methods never subscribe"),
    }
}

fn put(digest: &str, offset: u64, b64: &str) -> Value {
    json!({ "digest": digest, "offset": offset, "bytesB64": b64 })
}

#[tokio::test]
async fn chunks_publish_when_the_bytes_hash_to_the_digest() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    // The conformance transcript: "ab" at 0, "c" at 2.
    assert_eq!(call(&service, "blob/put", put(ABC, 0, "YWI=")).await.unwrap(), json!({}));
    assert!(matches!(
        call(&service, "blob/read", json!({ "digest": ABC })).await,
        Err(CoreError::BlobNotFound { .. })
    ));
    assert_eq!(call(&service, "blob/put", put(ABC, 2, "Yw==")).await.unwrap(), json!({}));
    assert_eq!(call(&service, "blob/read", json!({ "digest": ABC })).await.unwrap(), json!({ "bytesB64": "YWJj" }));
    assert_eq!(
        call(&service, "blob/read", json!({ "digest": ABC, "offset": 1, "length": 1 })).await.unwrap(),
        json!({ "bytesB64": "Yg==" })
    );
    // Past the end is an empty page.
    assert_eq!(
        call(&service, "blob/read", json!({ "digest": ABC, "offset": 9 })).await.unwrap(),
        json!({ "bytesB64": "" })
    );
}

#[tokio::test]
async fn a_resent_chunk_has_one_effect_and_a_gap_or_a_changed_chunk_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    call(&service, "blob/put", put(ABC, 0, "YWI=")).await.unwrap();
    // The same chunk again: nothing changes.
    call(&service, "blob/put", put(ABC, 0, "YWI=")).await.unwrap();
    // A chunk past the end leaves a gap.
    assert!(matches!(
        call(&service, "blob/put", put(ABC, 3, "Yw==")).await,
        Err(CoreError::InvalidParams { .. })
    ));
    // Different bytes at an offset already received.
    assert!(matches!(
        call(&service, "blob/put", put(ABC, 0, "eHg=")).await,
        Err(CoreError::InvalidParams { .. })
    ));
    // A chunk over the advertised raw bound.
    assert!(matches!(
        call(&service, "blob/put", put(ABC, 2, "YWJj")).await,
        Err(CoreError::InvalidParams { .. })
    ));
    call(&service, "blob/put", put(ABC, 2, "Yw==")).await.unwrap();
    // The completing chunk sent again after its answer was lost.
    call(&service, "blob/put", put(ABC, 2, "Yw==")).await.unwrap();
}

#[tokio::test]
async fn a_chunk_of_an_unknown_upload_past_zero_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    assert!(matches!(
        call(&service, "blob/put", put(ABC, 2, "Yw==")).await,
        Err(CoreError::InvalidParams { .. })
    ));
}

#[tokio::test]
async fn a_page_is_never_larger_than_the_advertised_page() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    // sha256 of "hello world" in 2-byte chunks (the page bound is 6).
    let digest = "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
    for (offset, chunk) in ["hello world".as_bytes()].concat().chunks(2).enumerate() {
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, chunk);
        call(&service, "blob/put", put(digest, (offset * 2) as u64, &b64)).await.unwrap();
    }
    let page = call(&service, "blob/read", json!({ "digest": digest, "length": 100 })).await.unwrap();
    // "hello " is 6 bytes.
    assert_eq!(page, json!({ "bytesB64": "aGVsbG8g" }));
}
