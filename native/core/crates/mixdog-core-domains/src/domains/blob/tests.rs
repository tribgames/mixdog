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

async fn call(
    service: &BlobService,
    method: &'static str,
    params: Value,
) -> Result<Value, CoreError> {
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
    assert_eq!(
        call(&service, "blob/put", put(ABC, 0, "YWI="))
            .await
            .unwrap(),
        json!({})
    );
    assert!(matches!(
        call(&service, "blob/read", json!({ "digest": ABC })).await,
        Err(CoreError::BlobNotFound { .. })
    ));
    assert_eq!(
        call(&service, "blob/put", put(ABC, 2, "Yw=="))
            .await
            .unwrap(),
        json!({})
    );
    assert_eq!(
        call(&service, "blob/read", json!({ "digest": ABC }))
            .await
            .unwrap(),
        json!({ "bytesB64": "YWJj" })
    );
    assert_eq!(
        call(
            &service,
            "blob/read",
            json!({ "digest": ABC, "offset": 1, "length": 1 })
        )
        .await
        .unwrap(),
        json!({ "bytesB64": "Yg==" })
    );
    // Past the end is an empty page.
    assert_eq!(
        call(&service, "blob/read", json!({ "digest": ABC, "offset": 9 }))
            .await
            .unwrap(),
        json!({ "bytesB64": "" })
    );
}

#[tokio::test]
async fn a_resent_chunk_has_one_effect_and_a_gap_or_a_changed_chunk_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    call(&service, "blob/put", put(ABC, 0, "YWI="))
        .await
        .unwrap();
    // The same chunk again: nothing changes.
    call(&service, "blob/put", put(ABC, 0, "YWI="))
        .await
        .unwrap();
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
    call(&service, "blob/put", put(ABC, 2, "Yw=="))
        .await
        .unwrap();
    // The completing chunk sent again after its answer was lost.
    call(&service, "blob/put", put(ABC, 2, "Yw=="))
        .await
        .unwrap();
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
        call(&service, "blob/put", put(digest, (offset * 2) as u64, &b64))
            .await
            .unwrap();
    }
    let page = call(
        &service,
        "blob/read",
        json!({ "digest": digest, "length": 100 }),
    )
    .await
    .unwrap();
    // "hello " is 6 bytes.
    assert_eq!(page, json!({ "bytesB64": "aGVsbG8g" }));
}

/// Two uploaders of the same content (two pages that carry the same library) send their chunks at the same time: the one that
/// completes the blob removes the staging while the other still has chunks to send, and the other's chunk finds neither the
/// staging nor, yet, the published file. Neither may be refused.
#[tokio::test]
async fn two_uploaders_of_the_same_content_both_finish() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    for round in 0..30u8 {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let bytes = vec![round, 1, 2, 3, 4, 5, 6];
        let digest = mixdog_store::blobs::digest_of(&bytes).as_str().to_owned();
        let upload = || async {
            for (index, chunk) in bytes.chunks(2).enumerate() {
                call(&service, "blob/put", put(&digest, (index * 2) as u64, &STANDARD.encode(chunk))).await?;
            }
            Ok::<_, CoreError>(())
        };
        let (a, b) = tokio::join!(upload(), upload());
        a.unwrap();
        b.unwrap();
        let read = call(&service, "blob/read", json!({ "digest": digest, "length": 6 })).await.unwrap();
        assert_eq!(read, json!({ "bytesB64": STANDARD.encode(&bytes[..6]) }));
    }
}

/// A sender's existence probe (a read of one byte) of a blob another connection has just completed, and that is still being
/// written, waits for the publication like the continuation chunks do: it must not answer not-found, or the sender uploads
/// the content again. `join!` polls the completing chunk first, which announces the blob before its first wait.
#[tokio::test]
async fn a_probe_of_a_blob_being_published_waits_for_it() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path());
    call(&service, "blob/put", put(ABC, 0, "YWI=")).await.unwrap();
    let (put_last, probe) = tokio::join!(
        call(&service, "blob/put", put(ABC, 2, "Yw==")),
        call(&service, "blob/read", json!({ "digest": ABC, "length": 1 })),
    );
    put_last.unwrap();
    assert_eq!(probe.unwrap(), json!({ "bytesB64": "YQ==" }));
}

/// A blob's file is verified once, streamed, and its pages after that are ranged reads of the file: a corrupt file is
/// refused on the first read, a verified one is paged at any offset, and one removed since answers not-found and is
/// verified again when it returns.
#[tokio::test]
async fn pages_are_ranged_reads_of_a_file_verified_once() {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    let dir = tempfile::tempdir().unwrap();
    let store = BlobStore::new(dir.path());
    let service = BlobService::new(store.clone(), &mixdog_rt::testing::tokens(), &Limits { max_blob_page_bytes: 6, ..Limits::default() });
    let bytes: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
    let digest = mixdog_store::blobs::digest_of(&bytes);
    let path = store.path(&digest);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut corrupt = bytes.clone();
    corrupt[100] ^= 1;
    std::fs::write(&path, &corrupt).unwrap();
    let read = |offset: u64| call(&service, "blob/read", json!({ "digest": digest.as_str(), "offset": offset }));
    assert!(matches!(read(0).await, Err(CoreError::BlobCorrupt { .. })));
    std::fs::write(&path, &bytes).unwrap();
    assert_eq!(read(4000).await.unwrap(), json!({ "bytesB64": STANDARD.encode(&bytes[4000..4006]) }));
    assert_eq!(read(4094).await.unwrap(), json!({ "bytesB64": STANDARD.encode(&bytes[4094..]) }));
    assert_eq!(read(5000).await.unwrap(), json!({ "bytesB64": "" }));
    std::fs::remove_file(&path).unwrap();
    assert!(matches!(read(0).await, Err(CoreError::BlobNotFound { .. })));
    // Forgotten on the not-found: a corrupt file in its place is caught by a fresh verification.
    std::fs::write(&path, &corrupt).unwrap();
    assert!(matches!(read(0).await, Err(CoreError::BlobCorrupt { .. })));
}
