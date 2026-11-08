//! Known answer: the RFC 8291 body this crate builds is byte-identical to the Node product's
//! `encryptWebPushPayload` (apps/desktop/src/main/web-push.ts) for the same keys, salt and
//! payload. The vector was produced by running that function with fixed throwaway keys
//! (`d = 0x11..` local, `0x22..` subscription, auth `0x33..`, salt `0x44..`).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use mixdog_remote::e2ee::WebPushKeys;
use mixdog_remote::push::web::encrypt_web_push_payload;

const LOCAL_D: &str = "ERERERERERERERERERERERERERERERERERERERERERE";
const P256DH: &str = "BNZak5d8qj0bCBhS_1ennkZfFmBXcwS66tUF3TpIWJzzUBheiVNy32Ih6joTdVfkc_3bZ1XwW9UHw8Uz_OnJEoU";
const AUTH: &str = "MzMzMzMzMzMzMzMzMzMzMw";
const SALT: &str = "RERERERERERERERERERERA";
const PLAINTEXT: &str = "{\"title\":\"Done\",\"body\":\"ünïcode ✓\",\"sessionId\":\"s1\"}";
const NODE_BODY: &str = "RERERERERERERERERERERAAAEABBBAIX5hfwtkQ5KCePlpmeaaI6TywVK99tbN9m5bgCgtTtGUp968uXcS0t2jyoWqh2Wlb0X8dYWZZS8ol8ZTBuV5TOQuEqI6I70WnwmEFkknmEdcix9pQaqsonFj3aDYAlEiDlfJCZsTkWzo0OPo9nWoP1tTs1G5lNeFG81waxDRdKvD7gEEX-duXz";

#[test]
fn the_body_equals_the_node_products() {
    let decode = |text: &str| URL_SAFE_NO_PAD.decode(text).unwrap();
    let local = p256::SecretKey::from_slice(&decode(LOCAL_D)).unwrap();
    let salt: [u8; 16] = decode(SALT).try_into().unwrap();
    let keys = WebPushKeys { p256dh: P256DH.into(), auth: AUTH.into() };
    let body = encrypt_web_push_payload(&keys, PLAINTEXT.as_bytes(), salt, &local).unwrap();
    assert_eq!(URL_SAFE_NO_PAD.encode(body), NODE_BODY);
}
