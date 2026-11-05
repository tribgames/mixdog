//! Known answer: `NATIVE_PUSH_TEST_VECTOR` of apps/desktop/src/shared/native-push-crypto.ts
//! (fixed ephemeral key and IV) must produce the same `mx`, and the phone half must open it.
//! The collapse key was computed by running `nativeCollapseKey`'s expression in Node.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_remote::push::native_crypto::{NativePushContent, Reason, collapse_key, encrypt_native_push};

const DEVICE_PUBLIC: &str = "BA3gsNuflWc_YtOOjL4UlR6XsAjDlhnotjRhlhX8bD2uYLd8QaH-VWyEfF8_Q92IyBYFsmuaJEWaMF0OYB5m71o";
const EPHEMERAL: &str = "iXlhZqRfCiv2mye1cYq3RnadfOjcm1cnd1ufrqaClCM";
const IV: &str = "AAECAwQFBgcICQoL";
const MX: &str = "eyJ2IjoxLCJlcGsiOiJCSjFpcjg2WXlVUHpwdjBPaUpiRDF3VzdsR3k1eDFXNm40azk2aXIybF9Yci15TEd0QmM5ZFF4M21wOEhreFJHVTFOTGFQNlZCSU04RG5IRGE4OHE0ZTAiLCJpdiI6IkFBRUNBd1FGQmdjSUNRb0wiLCJjdCI6IlNsSVRmVERORmg3T3hMU0cxOFpGdzVSV0o0UlJLOGV2cDd5VVhoeUpLb21HQTlRS2YyWXNpSi10WldRR0E0U016QldrTWx2aVNfUjladEZ0MzdRYnFyVmlybndWMzRCd0dUQVpqdHFGdG53Qi1aVGRVLUhtWE1MbnNXWTBZbU9WZmZQRWVIVloyU0ZqWTZCT24ydnA5cjFSN1hvXy1hM0RtOE9sN3pJOUlRa0tTU1Y4Wk1UMlg1c0pycUNjZVh6MlVkYWhfcDVnVWlLQSJ9";

#[test]
fn mx_equals_the_node_vector() {
    let ephemeral = p256::SecretKey::from_slice(&URL_SAFE_NO_PAD.decode(EPHEMERAL).unwrap()).unwrap();
    let iv: [u8; 12] = URL_SAFE_NO_PAD.decode(IV).unwrap().try_into().unwrap();
    let content = NativePushContent {
        title: "Mixdog".into(),
        body: "Build finished: 42 tests passed".into(),
        session_id: "session-1".into(),
        reason: Reason::ApprovalPending,
        approval_id: Some("approval-1".into()),
        allow_once: None,
        host_id: None,
    };
    assert_eq!(encrypt_native_push(DEVICE_PUBLIC, &content, &ephemeral, iv).unwrap(), MX);
}

#[test]
fn collapse_key_equals_node() {
    assert_eq!(collapse_key("session-1", Reason::ApprovalPending), "NWeqTsKkMR6iyFtOWGVouZsIFMh-iWMr");
}
