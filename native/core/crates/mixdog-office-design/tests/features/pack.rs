//! A signed design pack: it is accepted only for a trusted Ed25519 key and the exact pack that was signed.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_office_design::library::core::canonical_office_design_pack;
use mixdog_office_design::library::pack::verify_office_design_pack_envelope;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Map, Value, json};

const SPKI_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

fn key(seed: u8) -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[seed; 32]).expect("a key")
}

fn public_pem(pair: &Ed25519KeyPair) -> String {
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(pair.public_key().as_ref());
    format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", STANDARD.encode(der))
}

fn trusted(id: &str, pair: &Ed25519KeyPair) -> Map<String, Value> {
    let mut keys = Map::new();
    keys.insert(id.to_owned(), Value::String(public_pem(pair)));
    keys
}

fn pack() -> Value {
    json!({ "id": "acme", "version": "1.2.3" })
}

fn signed(pair: &Ed25519KeyPair, key_id: &str, pack: &Value) -> Value {
    let signature = pair.sign(canonical_office_design_pack(pack).as_bytes());
    json!({ "schemaVersion": 1, "keyId": key_id, "signature": STANDARD.encode(signature.as_ref()), "pack": pack })
}

#[test]
fn a_pack_signed_by_a_trusted_key_is_accepted_whatever_the_order_of_its_keys() {
    let pair = key(7);
    let envelope = signed(&pair, "acme-key", &pack());
    let verified = verify_office_design_pack_envelope(&envelope, &trusted("acme-key", &pair)).expect("verified");
    assert_eq!(verified.key_id, "acme-key");
    assert_eq!(verified.pack["id"], "acme");
    assert_eq!(verified.pack["version"], "1.2.3");
    assert_eq!(verified.pack["channel"], "stable", "a pack without a channel is on the stable one");
    let mut reordered = envelope.clone();
    reordered["pack"] = json!({ "version": "1.2.3", "id": "acme" });
    assert!(verify_office_design_pack_envelope(&reordered, &trusted("acme-key", &pair)).is_ok(), "the signature covers the canonical form");
}

#[test]
fn a_changed_pack_an_untrusted_key_or_a_malformed_envelope_is_refused_with_its_reason() {
    let pair = key(7);
    let keys = trusted("acme-key", &pair);
    let mut tampered = signed(&pair, "acme-key", &pack());
    tampered["pack"]["version"] = json!("9.9.9");
    assert_eq!(verify_office_design_pack_envelope(&tampered, &keys).unwrap_err(), "Office design pack signature verification failed");
    let stranger = signed(&key(8), "acme-key", &pack());
    assert_eq!(verify_office_design_pack_envelope(&stranger, &keys).unwrap_err(), "Office design pack signature verification failed");
    let unknown = signed(&pair, "other-key", &pack());
    assert_eq!(verify_office_design_pack_envelope(&unknown, &keys).unwrap_err(), "Office design pack signing key is not trusted: other-key");
    let mut short = signed(&pair, "acme-key", &pack());
    short["signature"] = json!("AAAA");
    assert_eq!(verify_office_design_pack_envelope(&short, &keys).unwrap_err(), "Office design pack signature is invalid");
    let mut wrong_schema = signed(&pair, "acme-key", &pack());
    wrong_schema["schemaVersion"] = json!(2);
    assert_eq!(verify_office_design_pack_envelope(&wrong_schema, &keys).unwrap_err(), "Office design pack envelope requires schemaVersion 1");
    assert!(verify_office_design_pack_envelope(&json!("text"), &keys).is_err());
}

#[test]
fn a_pack_whose_id_or_version_is_not_valid_is_refused_even_when_signed() {
    let pair = key(7);
    let keys = trusted("acme-key", &pair);
    let bad_id = signed(&pair, "acme-key", &json!({ "id": "Bad Id!", "version": "1.0.0" }));
    assert_eq!(
        verify_office_design_pack_envelope(&bad_id, &keys).unwrap_err(),
        "Office design pack id must use 1-64 lowercase letters, digits, dots, underscores, or hyphens"
    );
    let bad_version = signed(&pair, "acme-key", &json!({ "id": "acme", "version": "one" }));
    assert_eq!(verify_office_design_pack_envelope(&bad_version, &keys).unwrap_err(), "Office design pack acme has invalid semantic version one");
}
