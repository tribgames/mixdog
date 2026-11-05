//! The PC-signed Web Push path (push-subscription-store.ts, web-push.ts): the VAPID header
//! verifies against the stored public key, and a send reaches the poster with the headers
//! `sendWebPush` sets and a body the subscription can open.

use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_remote::push::legacy::{
    LegacyKeys, LegacySubscription, PushPoster, VAPID_SUBJECT, node_base64_decode, send_web_push, vapid_authorization_header,
};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};

const P256DH: &str = "BNZak5d8qj0bCBhS_1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc_3bZ1XwW9UHw8Uz_OnJEoU";
const AUTH: &str = "MzMzMzMzMzMzMzMzMzMzMw";

#[test]
fn vapid_header_verifies_against_the_public_key() {
    let keys = LegacyKeys::generate();
    let header = vapid_authorization_header("https://push.example/send/abc", &keys, VAPID_SUBJECT, 1_700_000_000_000).unwrap();
    let rest = header.strip_prefix("vapid t=").unwrap();
    let (token, key) = rest.split_once(", k=").unwrap();
    assert_eq!(key, keys.public_key);
    let (signing_input, signature) = token.rsplit_once('.').unwrap();
    let verifier = VerifyingKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(key).unwrap()).unwrap();
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
    verifier.verify(signing_input.as_bytes(), &signature).unwrap();
    let payload = signing_input.split('.').nth(1).unwrap();
    let claims: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
    assert_eq!(
        claims,
        serde_json::json!({ "aud": "https://push.example", "exp": 1_700_000_000u64 + 43_200, "sub": VAPID_SUBJECT })
    );
}

#[test]
fn node_base64_accepts_padding_and_both_alphabets() {
    assert_eq!(node_base64_decode("AQID"), vec![1, 2, 3]);
    assert_eq!(node_base64_decode("AQI="), vec![1, 2]);
    assert_eq!(node_base64_decode("-_8"), node_base64_decode("+/8="));
}

struct Recorder(Mutex<Vec<(String, Vec<(String, String)>, usize)>>, u16);

#[async_trait]
impl PushPoster for Recorder {
    async fn post(&self, endpoint: &str, headers: &[(&str, String)], body: Vec<u8>) -> Result<u16, String> {
        let headers = headers.iter().map(|(n, v)| ((*n).to_owned(), v.clone())).collect();
        self.0.lock().unwrap().push((endpoint.to_owned(), headers, body.len()));
        Ok(self.1)
    }
}

#[tokio::test]
async fn send_posts_the_node_headers_and_flags_gone_subscriptions() {
    let subscription = LegacySubscription {
        endpoint: "https://push.example/send/abc".into(),
        p256dh: P256DH.into(),
        auth: AUTH.into(),
        client_id: "c1".into(),
        label: String::new(),
    };
    let keys = LegacyKeys::generate();
    let poster = Recorder(Mutex::new(Vec::new()), 410);
    let result = send_web_push(&poster, &subscription, "{\"title\":\"Done\"}", &keys, 1_700_000_000_000).await;
    assert!(result.expired && result.status_code == 410 && result.error.is_none());
    let calls = poster.0.lock().unwrap();
    let (endpoint, headers, body_len) = &calls[0];
    assert_eq!(endpoint, "https://push.example/send/abc");
    let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
    assert_eq!(header("Content-Encoding"), Some("aes128gcm"));
    assert_eq!(header("Content-Type"), Some("application/octet-stream"));
    assert_eq!(header("TTL"), Some("86400"));
    assert_eq!(header("Urgency"), Some("high"));
    assert!(header("Authorization").unwrap().starts_with("vapid t="));
    // salt + record size + key length + 65-byte key + ciphertext (payload + delimiter + tag).
    assert_eq!(*body_len, 16 + 4 + 1 + 65 + "{\"title\":\"Done\"}".len() + 1 + 16);
}
