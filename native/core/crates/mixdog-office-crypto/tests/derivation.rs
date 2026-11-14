//! The crypto cases of `pdf/document-preview-password.slow.test.mjs` of the Node tree: agile and standard encryption
//! with every hash variant, the descriptor read by namespace and schema, the HMAC integrity check, a cancelled
//! derivation and the two-at-a-time limit.
//!
//! The derivation scheduler is process-wide, so every test that derives a key holds `serial()`: the counting tests
//! would otherwise see each other's threads.

mod support;

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use mixdog_office_crypto::{
    CancelToken, DerivationCounts, Descriptor, Integrity, KeyDerivation, KeyError, decrypt_package, key_derivations,
    ooxml_encryption, package_intact, password_key,
};
use support::{Encryption, Entry, encrypt_ooxml_entries};

const PASSWORD: &str = "Kor\u{e9}e p\u{e4}ss \u{1F511}";
const ENCRYPTION_NS: &str = "http://schemas.microsoft.com/office/2006/encryption";
const PASSWORD_NS: &str = "http://schemas.microsoft.com/office/2006/keyEncryptor/password";
const AGILE_HEADER: [u8; 8] = [4, 0, 4, 0, 0x40, 0, 0, 0];

fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn plain() -> Vec<u8> {
    let mut plain = b"PK\x03\x04 plain package ".to_vec();
    plain.extend(vec![0x41; 9000]);
    plain
}

fn stream_data(entries: &[Entry], index: usize) -> Vec<u8> {
    entries[index].data.clone().expect("a stream")
}

fn agile_entries(options: &Encryption) -> Vec<Entry> {
    encrypt_ooxml_entries(&plain(), PASSWORD, options)
}

#[derive(Debug, PartialEq, Eq)]
enum Opened {
    Wrong,
    Corrupt,
    Plain(Vec<u8>),
}

/// The order the preview follows: the verifier decides the password first, then the HMAC, then the decryption.
fn open_entries(entries: &[Entry], password: &str) -> Opened {
    let descriptor = ooxml_encryption(&stream_data(entries, 0)).expect("a supported descriptor");
    let package = stream_data(entries, 1);
    let Some(key) = password_key(&descriptor, password, &CancelToken::new()).expect("a derivation") else {
        return Opened::Wrong;
    };
    if !package_intact(&descriptor, &key, &package).expect("an integrity check") {
        return Opened::Corrupt;
    }
    Opened::Plain(decrypt_package(&descriptor, &key, &package).expect("a decryption"))
}

fn descriptor_xml(info: &[u8]) -> String {
    String::from_utf8(info[8..].to_vec()).expect("UTF-8")
}

fn with_xml(xml: &str) -> Vec<u8> {
    let mut info = AGILE_HEADER.to_vec();
    info.extend_from_slice(xml.as_bytes());
    info
}

/// `xml` with the first `from` replaced; a replacement that finds nothing is a mistake in the test.
fn replaced(xml: &str, from: &str, to: &str) -> String {
    assert!(xml.contains(from), "the descriptor holds {from}");
    xml.replacen(from, to, 1)
}

fn attribute_span(xml: &str, name: &str) -> (usize, usize) {
    let start = xml
        .find(&format!("{name}=\""))
        .unwrap_or_else(|| panic!("the descriptor holds {name}"));
    let value_start = start + name.len() + 2;
    let end = value_start + xml[value_start..].find('"').expect("a closing quote");
    (start, end + 1)
}

fn set_attribute(xml: &str, name: &str, value: &str) -> String {
    let (start, end) = attribute_span(xml, name);
    format!("{}{name}=\"{value}\"{}", &xml[..start], &xml[end..])
}

fn remove_attribute(xml: &str, name: &str) -> String {
    let (start, end) = attribute_span(xml, name);
    format!("{}{}", &xml[..start - 1], &xml[end..])
}

/// The whole element that begins with `open` (a start tag text) and ends at the first `end`.
fn element(xml: &str, open: &str, end: &str) -> String {
    let start = xml.find(open).unwrap_or_else(|| panic!("the descriptor holds {open}"));
    let stop = start + xml[start..].find(end).expect("the end of the element") + end.len();
    xml[start..stop].to_owned()
}

#[test]
fn right_and_wrong_passwords_for_both_schemes() {
    let _serial = serial();
    for standard in [false, true] {
        let entries = agile_entries(&Encryption {
            standard,
            ..Encryption::default()
        });
        assert_eq!(
            open_entries(&entries, PASSWORD),
            Opened::Plain(plain()),
            "standard {standard}"
        );
        assert_eq!(
            open_entries(&entries, &format!("{PASSWORD}x")),
            Opened::Wrong,
            "standard {standard}"
        );
        assert_eq!(open_entries(&entries, ""), Opened::Wrong, "standard {standard}");
    }
}

#[test]
fn extensible_encryption_and_malformed_descriptors_are_not_guessed_at() {
    assert_eq!(ooxml_encryption(&[4, 0, 3, 0, 0, 0, 0, 0, 1, 2, 3, 4]), None);
    let mut empty = AGILE_HEADER.to_vec();
    empty.extend_from_slice(b"<encryption/>");
    assert_eq!(ooxml_encryption(&empty), None);
    assert_eq!(ooxml_encryption(&[4, 0, 4]), None);
    let info = stream_data(&agile_entries(&Encryption::default()), 0);
    // Hash names are matched exactly as [MS-OFFCRYPTO] 2.3.4.10 writes them: "SHA512", never "SHA-512" or "sha512".
    for name in ["SHA-512", "sha512"] {
        let text = descriptor_xml(&info).replace("SHA512", name);
        assert_eq!(ooxml_encryption(&with_xml(&text)), None, "{name}");
    }
    assert!(matches!(ooxml_encryption(&info), Some(Descriptor::Agile(_))));
    // A byte order mark ahead of the descriptor is dropped, as a TextDecoder drops it.
    let mut marked = AGILE_HEADER.to_vec();
    marked.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    marked.extend_from_slice(descriptor_xml(&info).as_bytes());
    assert!(ooxml_encryption(&marked).is_some());
    // Invalid UTF-8 is refused, not repaired.
    let mut invalid = info.clone();
    invalid.push(0xff);
    assert_eq!(ooxml_encryption(&invalid), None);
}

fn opens(text: &str) -> bool {
    let Some(descriptor) = ooxml_encryption(&with_xml(text)) else {
        return false;
    };
    password_key(&descriptor, PASSWORD, &CancelToken::new())
        .expect("a derivation")
        .is_some()
}

fn prefixed(xml: &str) -> String {
    let mut out = replaced(
        xml,
        &format!("xmlns=\"{ENCRYPTION_NS}\""),
        &format!("xmlns:e=\"{ENCRYPTION_NS}\""),
    );
    for (from, to) in [
        ("<keyEncryptors", "<e:keyEncryptors"),
        ("</keyEncryptors", "</e:keyEncryptors"),
        ("<keyEncryptor ", "<e:keyEncryptor "),
        ("</keyEncryptor>", "</e:keyEncryptor>"),
        ("<encryption ", "<e:encryption "),
        ("</encryption>", "</e:encryption>"),
        ("<keyData ", "<e:keyData "),
        ("<dataIntegrity ", "<e:dataIntegrity "),
    ] {
        out = replaced(&out, from, to);
    }
    out
}

#[test]
fn the_agile_descriptor_is_read_by_namespace_and_schema_not_by_text_patterns() {
    let _serial = serial();
    let info = stream_data(&agile_entries(&Encryption::default()), 0);
    let xml = descriptor_xml(&info);
    // The same descriptor with the encryption namespace on a prefix, a comment that looks like a keyData, a certificate
    // key encryptor ahead of the password one, and a uri with surrounding whitespace.
    assert!(opens(&prefixed(&xml)), "prefixed");
    assert!(
        opens(&replaced(
            &xml,
            "<keyData",
            "<!-- <keyData saltSize=\"1\"/> --><keyData"
        )),
        "comment"
    );
    let certificate = "<keyEncryptor uri=\"http://schemas.microsoft.com/office/2006/keyEncryptor/certificate\">\
<c:encryptedKey xmlns:c=\"http://schemas.microsoft.com/office/2006/keyEncryptor/certificate\" encryptedKeyValue=\"\" X509Certificate=\"\" certVerifier=\"\"/>\
</keyEncryptor>";
    assert!(
        opens(&replaced(
            &xml,
            "<keyEncryptors>",
            &format!("<keyEncryptors>{certificate}")
        )),
        "certificate"
    );
    assert!(
        opens(&replaced(
            &xml,
            &format!("uri=\"{PASSWORD_NS}\""),
            &format!("uri=\"  {PASSWORD_NS} \"")
        )),
        "token"
    );

    let integrity = element(&xml, "<dataIntegrity", "/>");
    let key_data = element(&xml, "<keyData", "/>");
    let key_encryptor = element(&xml, "<keyEncryptor ", "</keyEncryptor>");
    let key_data_with_child = format!("{}><x/></keyData>", &key_data[..key_data.len() - 2]);
    let salt_span = attribute_span(&key_data, "saltValue");
    let key_data_bad_salt = format!(
        "{}saltValue=\"***\"{}",
        &key_data[..salt_span.0],
        &key_data[salt_span.1..]
    );
    let refused: Vec<(&str, String)> = vec![
        (
            "a DTD",
            replaced(&xml, "?>", "?><!DOCTYPE encryption [<!ENTITY x \"SHA512\">]>"),
        ),
        (
            "an external entity",
            replaced(&xml, "?>", "?><!DOCTYPE encryption SYSTEM \"file:///etc/passwd\">"),
        ),
        (
            "an undefined entity",
            replaced(&xml, "hashAlgorithm=\"SHA512\"", "hashAlgorithm=\"&x;\""),
        ),
        (
            "another encoding",
            replaced(&xml, "encoding=\"UTF-8\"", "encoding=\"UTF-16\""),
        ),
        (
            "the password key outside its namespace",
            replaced(&xml, "<p:encryptedKey", "<encryptedKey"),
        ),
        (
            "keyData in no namespace",
            replaced(&xml, "<keyData", "<keyData xmlns=\"\""),
        ),
        (
            "dataIntegrity after keyEncryptors",
            replaced(
                &replaced(&xml, &integrity, ""),
                "</encryption>",
                &format!("{integrity}</encryption>"),
            ),
        ),
        (
            "two keyData elements",
            replaced(&xml, &key_data, &format!("{key_data}{key_data}")),
        ),
        (
            "an element the schema does not have",
            replaced(&xml, "<keyEncryptors>", "<extra/><keyEncryptors>"),
        ),
        (
            "a child inside keyData",
            replaced(&xml, &key_data, &key_data_with_child),
        ),
        (
            "two password key encryptors",
            replaced(&xml, &key_encryptor, &format!("{key_encryptor}{key_encryptor}")),
        ),
        (
            "no password key encryptor",
            replaced(&xml, &format!("uri=\"{PASSWORD_NS}\""), "uri=\"urn:other\""),
        ),
        (
            "a spinCount over 10,000,000",
            replaced(&xml, "spinCount=\"1000\"", "spinCount=\"10000001\""),
        ),
        (
            "an empty spinCount",
            replaced(&xml, "spinCount=\"1000\"", "spinCount=\"\""),
        ),
        (
            "a salt that is not base64",
            replaced(&xml, &key_data, &key_data_bad_salt),
        ),
        ("malformed XML", replaced(&xml, "</keyEncryptors>", "")),
        ("an unbound prefix", replaced(&xml, "<keyData", "<q:keyData")),
        ("text outside the root", format!("{xml}stray")),
    ];
    for (name, text) in &refused {
        assert_eq!(ooxml_encryption(&with_xml(text)), None, "{name}");
    }
    // The upper bound itself is allowed.
    let top = ooxml_encryption(&with_xml(&replaced(
        &xml,
        "spinCount=\"1000\"",
        "spinCount=\"10000000\"",
    )))
    .expect("allowed");
    let Descriptor::Agile(agile) = top else {
        panic!("an agile descriptor")
    };
    assert_eq!(agile.spin_count, 10_000_000);
}

#[test]
fn agile_descriptors_hashed_with_each_supported_name_open_with_their_password() {
    let _serial = serial();
    for hash_algorithm in ["SHA-1", "SHA1", "SHA256", "SHA384", "SHA512"] {
        let entries = agile_entries(&Encryption {
            hash_algorithm,
            ..Encryption::default()
        });
        assert_eq!(
            open_entries(&entries, PASSWORD),
            Opened::Plain(plain()),
            "{hash_algorithm}"
        );
    }
}

#[test]
fn hashes_the_reference_runtime_cannot_compute_leave_the_descriptor_unsupported() {
    let info = stream_data(&agile_entries(&Encryption::default()), 0);
    let xml = descriptor_xml(&info);
    for name in ["MD4", "MD2", "RIPEMD-128", "WHIRLPOOL"] {
        assert_eq!(
            ooxml_encryption(&with_xml(&xml.replace("SHA512", name))),
            None,
            "{name}"
        );
    }
}

fn tampered(entries: &[Entry], change: impl FnOnce(&mut Vec<u8>)) -> Vec<Entry> {
    let mut out = entries.to_vec();
    let mut data = stream_data(entries, 1);
    change(&mut data);
    out[1].data = Some(data);
    out
}

#[test]
fn a_package_whose_hmac_does_not_match_is_corrupt_after_the_password() {
    let _serial = serial();
    let entries = agile_entries(&Encryption::default());
    let changes: [(&str, fn(&mut Vec<u8>)); 2] = [
        ("one ciphertext byte", |data| data[100] ^= 1),
        ("the StreamSize field", |data| {
            data[..8].copy_from_slice(&((plain().len() - 1) as u64).to_le_bytes())
        }),
    ];
    for (name, change) in changes {
        let changed = tampered(&entries, change);
        assert_eq!(open_entries(&changed, PASSWORD), Opened::Corrupt, "{name}");
        assert_eq!(open_entries(&changed, &format!("{PASSWORD}x")), Opened::Wrong, "{name}");
    }
}

#[test]
fn malformed_integrity_data_is_refused_and_absent_integrity_data_is_allowed() {
    let _serial = serial();
    let entries = agile_entries(&Encryption::default());
    let xml = descriptor_xml(&stream_data(&entries, 0));
    let zero_key = |length: usize| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(vec![0u8; length])
    };
    let broken: Vec<(&str, String)> = vec![
        ("an empty HMAC key", set_attribute(&xml, "encryptedHmacKey", "")),
        // saltSize 16 and hashSize 64 pad to 16 or 64 bytes, never 32.
        (
            "an HMAC key of neither length",
            set_attribute(&xml, "encryptedHmacKey", &zero_key(32)),
        ),
        (
            "an HMAC value that is not base64",
            set_attribute(&xml, "encryptedHmacValue", "%%%%"),
        ),
        (
            "an HMAC value of the wrong length",
            set_attribute(&xml, "encryptedHmacValue", &zero_key(16)),
        ),
        ("no HMAC value", remove_attribute(&xml, "encryptedHmacValue")),
    ];
    for (name, text) in &broken {
        let Some(Descriptor::Agile(agile)) = ooxml_encryption(&with_xml(text)) else {
            panic!("{name}: the descriptor still parses");
        };
        assert_eq!(agile.integrity, Some(Integrity::Malformed), "{name}");
    }
    let absent = agile_entries(&Encryption {
        integrity: false,
        ..Encryption::default()
    });
    let Some(Descriptor::Agile(agile)) = ooxml_encryption(&stream_data(&absent, 0)) else {
        panic!("an agile descriptor");
    };
    assert_eq!(agile.integrity, None);
    assert_eq!(open_entries(&absent, PASSWORD), Opened::Plain(plain()));
}

#[test]
fn integrity_data_keyed_by_a_salt_size_or_hash_size_salt_verifies_and_one_flipped_byte_fails_it() {
    let _serial = serial();
    // (hash, keyData saltSize, HMAC salt bytes): the salt [MS-OFFCRYPTO] 2.3.4.14 step 2 sizes by saltSize, the one
    // Excel sizes by hashSize, and salts whose block padding would reach past one hash block (129 bytes pad to 144).
    let salts: [(&str, usize, usize); 8] = [
        ("SHA512", 16, 16),
        ("SHA512", 16, 64),
        ("SHA512", 64, 64),
        ("SHA512", 129, 129),
        ("SHA-1", 16, 16),
        ("SHA-1", 16, 20),
        ("SHA-1", 64, 64),
        ("SHA-1", 129, 129),
    ];
    for (hash_algorithm, key_salt_size, hmac_salt_size) in salts {
        let label = format!("{hash_algorithm}, saltSize {key_salt_size}, {hmac_salt_size}-byte HMAC salt");
        let entries = agile_entries(&Encryption {
            hash_algorithm,
            key_salt_size,
            hmac_salt_size: Some(hmac_salt_size),
            ..Encryption::default()
        });
        assert_eq!(open_entries(&entries, PASSWORD), Opened::Plain(plain()), "{label}");
        let flipped = tampered(&entries, |data| data[100] ^= 1);
        assert_eq!(open_entries(&flipped, PASSWORD), Opened::Corrupt, "{label}");
    }
}

/// A descriptor whose password hashing takes seconds: the full 10,000,000 rounds the spec allows.
fn slow_descriptor() -> Descriptor {
    let info = stream_data(&agile_entries(&Encryption::default()), 0);
    let text = replaced(&descriptor_xml(&info), "spinCount=\"1000\"", "spinCount=\"10000000\"");
    ooxml_encryption(&with_xml(&text)).expect("a supported descriptor")
}

fn until(mut condition: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "waiting for {what}");
        std::thread::park_timeout(Duration::from_millis(5));
    }
}

fn is_cancelled(result: Result<Option<Vec<u8>>, KeyError>) -> bool {
    matches!(result, Err(KeyError::Cancelled))
}

#[test]
fn a_cancelled_request_ends_its_password_derivation_at_once() {
    let _serial = serial();
    let cancel = CancelToken::new();
    let derivation = KeyDerivation::start(&slow_descriptor(), PASSWORD, &cancel).expect("started");
    assert_eq!(key_derivations(), DerivationCounts { running: 1, waiting: 0 });
    let cancelled_at = Instant::now();
    cancel.cancel();
    assert!(is_cancelled(derivation.wait()));
    assert!(
        cancelled_at.elapsed() < Duration::from_secs(1),
        "the cancel ends the derivation without waiting for it"
    );
    until(|| key_derivations().running == 0, "the derivation thread to end");
}

#[test]
fn a_request_cancelled_before_it_starts_takes_no_slot() {
    let _serial = serial();
    let cancel = CancelToken::new();
    cancel.cancel();
    assert!(matches!(
        KeyDerivation::start(&slow_descriptor(), PASSWORD, &cancel),
        Err(KeyError::Cancelled)
    ));
    assert_eq!(key_derivations(), DerivationCounts { running: 0, waiting: 0 });
}

#[test]
fn password_derivations_run_two_at_a_time_and_a_queued_one_is_cancelled_without_starting() {
    let _serial = serial();
    let descriptor = slow_descriptor();
    let tokens = [CancelToken::new(), CancelToken::new(), CancelToken::new()];
    let derivations: Vec<KeyDerivation> = tokens
        .iter()
        .map(|token| KeyDerivation::start(&descriptor, PASSWORD, token).expect("started"))
        .collect();
    assert_eq!(key_derivations(), DerivationCounts { running: 2, waiting: 1 });
    tokens[2].cancel();
    until(
        || key_derivations().waiting == 0,
        "the queued derivation to leave the line",
    );
    assert_eq!(key_derivations(), DerivationCounts { running: 2, waiting: 0 });
    tokens[0].cancel();
    tokens[1].cancel();
    for derivation in derivations {
        assert!(is_cancelled(derivation.wait()));
    }
    until(|| key_derivations().running == 0, "both threads to end");
}

#[test]
fn a_waiting_derivation_starts_when_a_running_one_ends() {
    let _serial = serial();
    let descriptor = slow_descriptor();
    let tokens = [CancelToken::new(), CancelToken::new(), CancelToken::new()];
    let mut derivations: Vec<KeyDerivation> = tokens
        .iter()
        .map(|token| KeyDerivation::start(&descriptor, PASSWORD, token).expect("started"))
        .collect();
    tokens[0].cancel();
    assert!(is_cancelled(derivations.remove(0).wait()));
    until(
        || key_derivations() == DerivationCounts { running: 2, waiting: 0 },
        "the queued derivation to take the slot",
    );
    tokens[1].cancel();
    tokens[2].cancel();
    for derivation in derivations {
        assert!(is_cancelled(derivation.wait()));
    }
    until(|| key_derivations().running == 0, "both threads to end");
}
