//! Twin test `crypto`: the recording of Node's password-protected Office code
//! (`native/core/fixtures/office-crypto/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-crypto.mjs`) replayed over the Rust crate. Probe verdicts, stream
//! bytes, the descriptor read from each `EncryptionInfo`, the derived keys, the HMAC verdicts, the decrypted package
//! bytes, the error texts and the hash answers must equal Node's exactly. Re-recording is running that recorder
//! against a Node product tree (`MIXDOG_BENCH_TREE`), which `twin_live_crypto` does.

use std::path::Path;

use base64::Engine as _;
use mixdog_fsio::Unlaned;
use mixdog_office_crypto::hashes::{HashAlgorithm, hash, hmac};
use mixdog_office_crypto::{
    CancelToken, Descriptor, Integrity, decrypt_package, is_encrypted_binary_presentation, is_encrypted_ooxml,
    is_encrypted_word_document, ooxml_encryption, package_intact, password_key, read_encrypted_ooxml,
    read_ooxml_encryption_info,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const GOLDEN: &str = include_str!("../../../fixtures/office-crypto/golden.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("golden.json parses")
}

fn decode(value: &Value) -> Option<Vec<u8>> {
    value
        .as_str()
        .map(|text| base64::engine::general_purpose::STANDARD.decode(text).expect("base64"))
}

fn encode(bytes: &[u8]) -> Value {
    json!(base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn optional(bytes: Option<Vec<u8>>) -> Value {
    bytes.map_or(Value::Null, |bytes| encode(&bytes))
}

fn cipher(cipher: &mixdog_office_crypto::AgileCipher) -> Value {
    json!({
        "keyBits": cipher.key_bits,
        "blockSize": cipher.block_size,
        "saltSize": cipher.salt_size,
        "hashSize": cipher.hash_size,
        "algorithm": cipher.algorithm.openssl_name(),
        "salt": encode(&cipher.salt),
    })
}

/// The descriptor as the recorder summarizes Node's.
fn summary(descriptor: Option<&Descriptor>) -> Value {
    match descriptor {
        None => Value::Null,
        Some(Descriptor::Standard(standard)) => json!({
            "type": "standard",
            "keyBits": standard.key_bits,
            "salt": encode(&standard.salt),
            "verifier": encode(&standard.verifier),
            "verifierHash": encode(&standard.verifier_hash),
            "verifierHashSize": standard.verifier_hash_size,
        }),
        Some(Descriptor::Agile(agile)) => {
            let integrity = match &agile.integrity {
                None => json!("none"),
                Some(Integrity::Malformed) => json!("malformed"),
                Some(Integrity::Present {
                    hmac_key,
                    hmac_value,
                    salt_length,
                }) => json!({
                    "hmacKey": encode(hmac_key),
                    "hmacValue": encode(hmac_value),
                    "saltLength": salt_length,
                }),
            };
            json!({
                "type": "agile",
                "data": cipher(&agile.data),
                "key": cipher(&agile.key),
                "spinCount": agile.spin_count,
                "verifierInput": encode(&agile.verifier_input),
                "verifierHash": encode(&agile.verifier_hash),
                "encryptedKey": encode(&agile.encrypted_key),
                "integrity": integrity,
            })
        }
    }
}

fn replay_containers(golden: &Value, dir: &Path) {
    for (index, record) in golden["containers"].as_array().expect("containers").iter().enumerate() {
        let name = record["name"].as_str().expect("name");
        let path = dir.join(format!("{index}.bin"));
        mixdog_fsio::write(&Unlaned, &path, decode(&record["bytes"]).expect("bytes")).expect("write the container");
        assert_eq!(
            is_encrypted_ooxml(&Unlaned, &path),
            record["isEncryptedOoxml"],
            "{name}: isEncryptedOoxml"
        );
        assert_eq!(
            is_encrypted_word_document(&Unlaned, &path),
            record["isEncryptedWordDocument"],
            "{name}: isEncryptedWordDocument"
        );
        assert_eq!(
            is_encrypted_binary_presentation(&Unlaned, &path),
            record["isEncryptedBinaryPresentation"],
            "{name}: isEncryptedBinaryPresentation"
        );
        assert_eq!(
            optional(read_ooxml_encryption_info(&Unlaned, &path)),
            record["encryptionInfo"],
            "{name}: encryptionInfo"
        );
        let read = match read_encrypted_ooxml(&Unlaned, &path) {
            Some(read) => json!({
                "encryptionInfo": encode(&read.encryption_info),
                "encryptedPackage": encode(&read.encrypted_package),
            }),
            None => Value::Null,
        };
        assert_eq!(read, record["encryptedOoxml"], "{name}: encryptedOoxml");
    }
    let missing = dir.join("missing.bin");
    let record = &golden["missingFile"];
    assert_eq!(is_encrypted_ooxml(&Unlaned, &missing), record["isEncryptedOoxml"]);
    assert_eq!(
        is_encrypted_word_document(&Unlaned, &missing),
        record["isEncryptedWordDocument"]
    );
    assert_eq!(
        is_encrypted_binary_presentation(&Unlaned, &missing),
        record["isEncryptedBinaryPresentation"]
    );
    assert_eq!(read_ooxml_encryption_info(&Unlaned, &missing), None);
    assert_eq!(read_encrypted_ooxml(&Unlaned, &missing), None);
}

fn replay_packages(golden: &Value) {
    let password = golden["password"].as_str().expect("password");
    for record in golden["packages"].as_array().expect("packages") {
        let name = record["name"].as_str().expect("name");
        let info = decode(&record["encryptionInfo"]).expect("info");
        let package = decode(&record["encryptedPackage"]).expect("package");
        let descriptor = ooxml_encryption(&info);
        assert_eq!(summary(descriptor.as_ref()), record["descriptor"], "{name}: descriptor");
        let Some(descriptor) = descriptor else { continue };
        let key = password_key(&descriptor, password, &CancelToken::new()).expect("a derivation");
        assert_eq!(optional(key.clone()), record["key"], "{name}: key");
        let wrong = password_key(&descriptor, &format!("{password}x"), &CancelToken::new()).expect("a derivation");
        assert_eq!(optional(wrong), record["wrongPasswordKey"], "{name}: wrong password");
        let empty = password_key(&descriptor, "", &CancelToken::new()).expect("a derivation");
        assert_eq!(optional(empty), record["emptyPasswordKey"], "{name}: empty password");
        let Some(key) = key else { continue };
        let intact = package_intact(&descriptor, &key, &package).expect("an integrity check");
        assert_eq!(json!(intact), record["intact"], "{name}: intact");
        match decrypt_package(&descriptor, &key, &package) {
            Ok(plain) => {
                assert_eq!(encode(&plain), record["decrypted"], "{name}: decrypted");
                if let Some(sha) = record["plainSha256"].as_str() {
                    let digest: String = Sha256::digest(&plain)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect();
                    assert_eq!(digest, sha, "{name}: plain digest");
                }
            }
            Err(error) => assert_eq!(
                json!(error.to_string()),
                record["decryptError"],
                "{name}: decrypt error"
            ),
        }
    }
}

fn replay_descriptors(golden: &Value) {
    for record in golden["descriptors"].as_array().expect("descriptors") {
        let name = record["name"].as_str().expect("name");
        let info = decode(&record["encryptionInfo"]).expect("info");
        assert_eq!(
            summary(ooxml_encryption(&info).as_ref()),
            record["descriptor"],
            "{name}"
        );
    }
}

fn algorithm_named(name: &str) -> HashAlgorithm {
    match name {
        "sha1" => HashAlgorithm::Sha1,
        "sha256" => HashAlgorithm::Sha256,
        "sha384" => HashAlgorithm::Sha384,
        "sha512" => HashAlgorithm::Sha512,
        "md5" => HashAlgorithm::Md5,
        "md4" => HashAlgorithm::Md4,
        "md2" => HashAlgorithm::Md2,
        "ripemd128" => HashAlgorithm::Ripemd128,
        "ripemd160" => HashAlgorithm::Ripemd160,
        "whirlpool" => HashAlgorithm::Whirlpool,
        other => panic!("an algorithm the recorder did not name: {other}"),
    }
}

fn answer<E: std::fmt::Display>(result: Result<impl AsRef<[u8]>, E>) -> Value {
    match result {
        Ok(bytes) => json!({ "ok": encode(bytes.as_ref()) }),
        Err(error) => json!({ "error": error.to_string() }),
    }
}

fn replay_hashes(golden: &Value) {
    let inputs: Vec<Vec<u8>> = golden["hashInputs"]
        .as_array()
        .expect("inputs")
        .iter()
        .map(|input| decode(input).expect("input"))
        .collect();
    for record in golden["hashes"].as_array().expect("hashes") {
        let name = record["name"].as_str().expect("name");
        let algorithm = algorithm_named(name);
        for (index, input) in inputs.iter().enumerate() {
            assert_eq!(
                answer(hash(algorithm, &[input]).map(|digest| digest.to_vec())),
                record["digests"][index],
                "{name}: digest {index}"
            );
        }
        for case in record["hmacs"].as_array().expect("hmacs") {
            let length = usize::try_from(case["keyLength"].as_u64().expect("keyLength")).expect("length");
            let key: Vec<u8> = (0..length).map(|index| ((index * 13 + 1) & 0xff) as u8).collect();
            assert_eq!(
                answer(hmac(algorithm, &key, &inputs[2]).map(|mac| mac.to_vec())),
                case["result"],
                "{name}: hmac with a {length}-byte key"
            );
        }
    }
}

fn replay(golden: &Value) {
    let dir = tempfile::tempdir().expect("a scratch directory");
    replay_containers(golden, dir.path());
    replay_packages(golden);
    replay_descriptors(golden);
    replay_hashes(golden);
}

#[test]
fn twin_crypto() {
    replay(&golden());
}

/// Records again with Node and compares: `MIXDOG_BENCH_TREE=<product tree> cargo test -p mixdog-office-crypto --test
/// twin_crypto -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/pdf/ooxml-crypto.mjs, cfb-protection.mjs) from MIXDOG_BENCH_TREE"]
fn twin_live_crypto() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let status = std::process::Command::new("node")
        .arg(root.join("benchmarks/rust-core/recorders/record-office-crypto.mjs"))
        .status()
        .expect("run node");
    assert!(status.success(), "the recorder failed");
    let recorded = mixdog_fsio::read_to_string(&Unlaned, root.join("native/core/fixtures/office-crypto/golden.json"))
        .expect("golden.json");
    replay(&serde_json::from_str(&recorded).expect("golden.json parses"));
}
