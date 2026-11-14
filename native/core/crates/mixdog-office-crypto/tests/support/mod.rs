//! Test support: a minimal Compound File Binary ([MS-CFB]) writer with real container structure (header, FAT, DIFAT,
//! mini FAT, mini stream, directory with sibling trees), laid out the way Office writes it, and an encrypting writer
//! that follows [MS-OFFCRYPTO] in the encrypting direction. A port of `pdf/cfb-fixture.mjs` of the Node tree.
//! Random bytes are a fixed pseudo-random sequence, so a failure repeats.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockEncrypt, KeyInit};
use aes::{Aes128, Aes192, Aes256};
use mixdog_office_crypto::hashes::{HashAlgorithm, hash, hmac};

const END_OF_CHAIN: u32 = 0xffff_fffe;
const FAT_SECTOR: u32 = 0xffff_fffd;
const DIFAT_SECTOR: u32 = 0xffff_fffc;
const NO_STREAM: u32 = 0xffff_ffff;
const MINI_SECTOR_SIZE: usize = 64;
const MINI_STREAM_CUTOFF: usize = 4096;
const HEADER_DIFAT_ENTRIES: usize = 109;

/// An entry under the root storage: a stream (`data` is `Some`) or a storage of further entries.
#[derive(Clone)]
pub struct Entry {
    pub name: String,
    pub data: Option<Vec<u8>>,
    pub children: Vec<Entry>,
}

impl Entry {
    pub fn stream(name: &str, data: Vec<u8>) -> Self {
        Self {
            name: name.to_owned(),
            data: Some(data),
            children: Vec::new(),
        }
    }

    pub fn storage(name: &str, children: Vec<Entry>) -> Self {
        Self {
            name: name.to_owned(),
            data: None,
            children,
        }
    }
}

struct Node {
    name: String,
    kind: u8,
    data: Vec<u8>,
    children: Vec<usize>,
    left: u32,
    right: u32,
    child: Option<u32>,
    start: Option<u32>,
    size: Option<u64>,
}

fn register(nodes: &mut Vec<Node>, name: &str, kind: u8, data: &[u8], children: &[Entry]) -> usize {
    let id = nodes.len();
    nodes.push(Node {
        name: name.to_owned(),
        kind,
        data: data.to_vec(),
        children: Vec::new(),
        left: NO_STREAM,
        right: NO_STREAM,
        child: None,
        start: None,
        size: None,
    });
    for child in children {
        let (kind, data) = match &child.data {
            Some(data) => (2, data.as_slice()),
            None => (1, &[][..]),
        };
        let child_id = register(nodes, &child.name, kind, data, &child.children);
        nodes[id].children.push(child_id);
    }
    id
}

fn build_tree(nodes: &mut [Node], ordered: &[usize], low: isize, high: isize) -> u32 {
    if low > high {
        return NO_STREAM;
    }
    let middle = (low + high) >> 1;
    let id = ordered[middle as usize];
    let left = build_tree(nodes, ordered, low, middle - 1);
    let right = build_tree(nodes, ordered, middle + 1, high);
    nodes[id].left = left;
    nodes[id].right = right;
    id as u32
}

fn put_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

/// The container holding `entries` under its root storage. `version` is the CFB major version: 3 (512-byte sectors) or
/// 4 (4096-byte sectors).
pub fn build_cfb(entries: &[Entry], version: u16) -> Vec<u8> {
    let sector_size: usize = if version == 4 { 4096 } else { 512 };
    let entries_per_sector = sector_size / 4;

    // Directory ids in storage order, root first; the siblings under each storage form one balanced tree.
    let mut nodes: Vec<Node> = Vec::new();
    register(&mut nodes, "Root Entry", 5, &[], entries);
    for id in 0..nodes.len() {
        if nodes[id].kind == 2 {
            continue;
        }
        let mut ordered = nodes[id].children.clone();
        ordered.sort_by(|a, b| {
            let (a, b) = (&nodes[*a].name, &nodes[*b].name);
            a.chars()
                .count()
                .cmp(&b.chars().count())
                .then_with(|| a.to_uppercase().cmp(&b.to_uppercase()))
        });
        let child = build_tree(&mut nodes, &ordered, 0, ordered.len() as isize - 1);
        nodes[id].child = Some(child);
    }

    let mut sectors: Vec<Vec<u8>> = Vec::new();
    let mut fat: Vec<u32> = Vec::new();
    let allocate = |sectors: &mut Vec<Vec<u8>>, fat: &mut Vec<u32>, bytes: &[u8]| -> u32 {
        let count = bytes.len().div_ceil(sector_size);
        let start = sectors.len() as u32;
        for i in 0..count {
            let mut sector = vec![0u8; sector_size];
            let end = ((i + 1) * sector_size).min(bytes.len());
            sector[..end - i * sector_size].copy_from_slice(&bytes[i * sector_size..end]);
            sectors.push(sector);
            fat.push(if i == count - 1 {
                END_OF_CHAIN
            } else {
                sectors.len() as u32
            });
        }
        if count > 0 { start } else { END_OF_CHAIN }
    };

    let mut mini_streams: Vec<u8> = Vec::new();
    let mut mini_fat: Vec<u32> = Vec::new();
    for node in nodes.iter_mut() {
        if node.kind != 2 {
            continue;
        }
        node.size = Some(node.data.len() as u64);
        if node.data.len() >= MINI_STREAM_CUTOFF {
            node.start = Some(allocate(&mut sectors, &mut fat, &node.data));
        } else if node.data.is_empty() {
            node.start = Some(END_OF_CHAIN);
        } else {
            let count = node.data.len().div_ceil(MINI_SECTOR_SIZE);
            node.start = Some(mini_fat.len() as u32);
            for i in 0..count {
                mini_fat.push(if i == count - 1 {
                    END_OF_CHAIN
                } else {
                    mini_fat.len() as u32 + 1
                });
            }
            mini_streams.extend_from_slice(&node.data);
            mini_streams.resize(mini_streams.len() + count * MINI_SECTOR_SIZE - node.data.len(), 0);
        }
    }
    nodes[0].size = Some(mini_streams.len() as u64);
    nodes[0].start = Some(allocate(&mut sectors, &mut fat, &mini_streams));

    let mut mini_fat_bytes = vec![0xffu8; mini_fat.len().div_ceil(entries_per_sector) * entries_per_sector * 4];
    for (i, next) in mini_fat.iter().enumerate() {
        put_u32(&mut mini_fat_bytes, i * 4, *next);
    }
    let mini_fat_start = allocate(&mut sectors, &mut fat, &mini_fat_bytes);

    let mut directory = vec![0xffu8; nodes.len().div_ceil(sector_size / 128) * sector_size];
    for (i, node) in nodes.iter().enumerate() {
        let at = i * 128;
        directory[at..at + 128].fill(0);
        for (j, unit) in node.name.encode_utf16().enumerate() {
            put_u16(&mut directory, at + j * 2, unit);
        }
        put_u16(
            &mut directory,
            at + 64,
            ((node.name.encode_utf16().count() + 1) * 2) as u16,
        );
        directory[at + 66] = node.kind;
        directory[at + 67] = 1;
        put_u32(&mut directory, at + 68, node.left);
        put_u32(&mut directory, at + 72, node.right);
        put_u32(&mut directory, at + 76, node.child.unwrap_or(NO_STREAM));
        put_u32(&mut directory, at + 116, node.start.unwrap_or(0));
        put_u32(&mut directory, at + 120, node.size.unwrap_or(0) as u32);
    }
    // Entries past the last one are unallocated: type 0, with every id unset.
    let mut at = nodes.len() * 128;
    while at < directory.len() {
        directory[at..at + 68].fill(0);
        at += 128;
    }
    let directory_start = allocate(&mut sectors, &mut fat, &directory);

    // The FAT describes every sector including its own and the DIFAT's, so their counts settle together.
    let mut fat_count = 0usize;
    let mut difat_count = 0usize;
    while fat_count * entries_per_sector < fat.len() + fat_count + difat_count {
        fat_count += 1;
        difat_count = if fat_count > HEADER_DIFAT_ENTRIES {
            (fat_count - HEADER_DIFAT_ENTRIES).div_ceil(entries_per_sector - 1)
        } else {
            0
        };
    }
    let fat_sector_ids: Vec<u32> = (0..fat_count).map(|i| (sectors.len() + i) as u32).collect();
    let difat_sector_ids: Vec<u32> = (0..difat_count)
        .map(|i| (sectors.len() + fat_count + i) as u32)
        .collect();
    let mut fat_entries = fat.clone();
    fat_entries.extend(fat_sector_ids.iter().map(|_| FAT_SECTOR));
    fat_entries.extend(difat_sector_ids.iter().map(|_| DIFAT_SECTOR));
    let mut fat_bytes = vec![0xffu8; fat_count * sector_size];
    for (i, next) in fat_entries.iter().enumerate() {
        put_u32(&mut fat_bytes, i * 4, *next);
    }
    for i in 0..fat_count {
        sectors.push(fat_bytes[i * sector_size..(i + 1) * sector_size].to_vec());
    }
    let beyond_header: Vec<u32> = fat_sector_ids.iter().skip(HEADER_DIFAT_ENTRIES).copied().collect();
    for i in 0..difat_count {
        let mut sector = vec![0xffu8; sector_size];
        let from = (i * (entries_per_sector - 1)).min(beyond_header.len());
        let to = ((i + 1) * (entries_per_sector - 1)).min(beyond_header.len());
        for (j, id) in beyond_header[from..to].iter().enumerate() {
            put_u32(&mut sector, j * 4, *id);
        }
        let next = if i == difat_count - 1 {
            END_OF_CHAIN
        } else {
            difat_sector_ids[i + 1]
        };
        put_u32(&mut sector, sector_size - 4, next);
        sectors.push(sector);
    }

    let mut header = vec![0u8; sector_size];
    header[..8].copy_from_slice(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    put_u16(&mut header, 24, 0x3e);
    put_u16(&mut header, 26, version);
    put_u16(&mut header, 28, 0xfffe);
    put_u16(&mut header, 30, if version == 4 { 12 } else { 9 });
    put_u16(&mut header, 32, 6);
    put_u32(
        &mut header,
        40,
        if version == 4 {
            (directory.len() / sector_size) as u32
        } else {
            0
        },
    );
    put_u32(&mut header, 44, fat_count as u32);
    put_u32(&mut header, 48, directory_start);
    put_u32(&mut header, 56, MINI_STREAM_CUTOFF as u32);
    put_u32(&mut header, 60, mini_fat_start);
    put_u32(&mut header, 64, (mini_fat_bytes.len() / sector_size) as u32);
    put_u32(
        &mut header,
        68,
        if difat_count > 0 {
            difat_sector_ids[0]
        } else {
            END_OF_CHAIN
        },
    );
    put_u32(&mut header, 72, difat_count as u32);
    header[76..512].fill(0xff);
    for (i, id) in fat_sector_ids.iter().take(HEADER_DIFAT_ENTRIES).enumerate() {
        put_u32(&mut header, 76 + i * 4, *id);
    }
    let mut out = header;
    for sector in sectors {
        out.extend_from_slice(&sector);
    }
    out
}

fn data_spaces() -> Entry {
    Entry::storage(
        "\u{6}DataSpaces",
        vec![
            Entry::stream("Version", vec![0; 76]),
            Entry::stream("DataSpaceMap", vec![0; 112]),
        ],
    )
}

/// The root-level streams of an encrypted OOXML document ([MS-OFFCRYPTO] 2.3.4), with the given ciphertext size.
pub fn encrypted_ooxml_entries(package_bytes: usize) -> Vec<Entry> {
    let mut info = vec![4, 0, 4, 0, 0x40, 0, 0, 0];
    info.extend_from_slice(b"<encryption/>");
    let mut package = vec![0u8; 8];
    package.resize(8 + package_bytes, 0x5a);
    vec![
        Entry::stream("EncryptionInfo", info),
        Entry::stream("EncryptedPackage", package),
        data_spaces(),
    ]
}

/// A binary Word document's "WordDocument" stream whose FibBase ([MS-DOC] 2.5.1) has fEncrypted set or clear.
pub fn word_document_stream(encrypted: bool) -> Entry {
    let mut data = vec![3u8; 6000];
    put_u16(&mut data, 0, 0xa5ec);
    put_u16(&mut data, 2, 0x00c1);
    put_u16(&mut data, 10, if encrypted { 0x0100 | 0x0200 } else { 0x0200 });
    Entry::stream("WordDocument", data)
}

/// A "Current User" stream holding a CurrentUserAtom ([MS-PPT] 2.3.2) with this headerToken.
pub fn current_user_stream(header_token: u32) -> Entry {
    let name = b"Mixdog";
    let mut atom = vec![0u8; 28 + name.len() + 4];
    put_u16(&mut atom, 2, 0x0ff6);
    let length = atom.len();
    put_u32(&mut atom, 4, (length - 8) as u32);
    put_u32(&mut atom, 8, 0x14);
    put_u32(&mut atom, 12, header_token);
    put_u16(&mut atom, 20, name.len() as u16);
    put_u16(&mut atom, 22, 0x03f4);
    atom[24] = 3;
    atom[28..28 + name.len()].copy_from_slice(name);
    put_u32(&mut atom, 28 + name.len(), 8);
    Entry::stream("Current User", atom)
}

/// A file of `bytes` named `name` in `dir`.
pub fn written(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    mixdog_fsio::write(&mixdog_fsio::Unlaned, &path, bytes).expect("write the fixture file");
    path
}

static RANDOM_STATE: AtomicU64 = AtomicU64::new(0x9e37_79b9_7f4a_7c15);

/// `length` pseudo-random bytes (a fixed sequence: SplitMix64).
pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(length + 8);
    while out.len() < length {
        let mut z = RANDOM_STATE
            .fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed)
            .wrapping_add(0x9e37_79b9_7f4a_7c15);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        out.extend_from_slice(&(z ^ (z >> 31)).to_le_bytes());
    }
    out.truncate(length);
    out
}

fn sha(algorithm: HashAlgorithm, parts: &[&[u8]]) -> Vec<u8> {
    hash(algorithm, parts).expect("a computable hash").to_vec()
}

fn pad_to(bytes: &[u8], block: usize) -> Vec<u8> {
    let mut out = bytes.to_vec();
    out.resize(out.len().div_ceil(block) * block, 0);
    out
}

fn encrypt_block(key: &[u8], block: &mut [u8]) {
    let block = GenericArray::from_mut_slice(block);
    match key.len() {
        16 => Aes128::new_from_slice(key).expect("key").encrypt_block(block),
        24 => Aes192::new_from_slice(key).expect("key").encrypt_block(block),
        _ => Aes256::new_from_slice(key).expect("key").encrypt_block(block),
    }
}

/// AES in `mode` ("cbc" or "ecb") with no padding, over whole blocks.
pub fn aes_encrypt(mode: &str, key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    let mut previous = if mode == "cbc" { iv.to_vec() } else { vec![0; 16] };
    for chunk in out.chunks_exact_mut(16) {
        if mode == "cbc" {
            for (byte, mask) in chunk.iter_mut().zip(&previous) {
                *byte ^= mask;
            }
        }
        encrypt_block(key, chunk);
        if mode == "cbc" {
            previous = chunk.to_vec();
        }
    }
    out
}

fn fitted(bytes: &[u8], length: usize) -> Vec<u8> {
    let mut out = bytes[..bytes.len().min(length)].to_vec();
    out.resize(length, 0x36);
    out
}

fn spun(algorithm: HashAlgorithm, salt: &[u8], password: &str, count: u32) -> Vec<u8> {
    let utf16: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut value = sha(algorithm, &[salt, &utf16]);
    for i in 0..count {
        value = sha(algorithm, &[&i.to_le_bytes(), &value]);
    }
    value
}

fn with_size(plain_length: usize, ciphertext: &[u8]) -> Vec<u8> {
    let mut out = (plain_length as u64).to_le_bytes().to_vec();
    out.extend_from_slice(ciphertext);
    out
}

fn base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// How `encrypt_ooxml_entries` encrypts.
#[derive(Clone)]
pub struct Encryption {
    pub standard: bool,
    pub spin_count: u32,
    /// The descriptor's name for the hash ("SHA512", "SHA-1", ...).
    pub hash_algorithm: &'static str,
    pub key_salt_size: usize,
    pub integrity: bool,
    pub hmac_salt_size: Option<usize>,
}

impl Default for Encryption {
    fn default() -> Self {
        Self {
            standard: false,
            spin_count: 1000,
            hash_algorithm: "SHA512",
            key_salt_size: 16,
            integrity: true,
            hmac_salt_size: None,
        }
    }
}

/// The root-level streams of `plain` encrypted with `password` the way Office writes it, following [MS-OFFCRYPTO] in
/// the encrypting direction: agile encryption (2.3.4.10-2.3.4.15, AES-256-CBC) by default, or standard encryption
/// (2.3.4.5-2.3.4.9, AES-128-ECB, SHA-1). The keyData salt is `key_salt_size` bytes. Agile encryption carries
/// dataIntegrity (2.3.4.14) unless `integrity` is false, its HMAC key a salt of `hmac_salt_size` bytes: hashSize, as
/// Excel writes it, unless given.
pub fn encrypt_ooxml_entries(plain: &[u8], password: &str, options: &Encryption) -> Vec<Entry> {
    let (encryption_info, encrypted_package);
    if options.standard {
        let salt = random_bytes(16);
        let first = spun(HashAlgorithm::Sha1, &salt, password, 50_000);
        let final_hash = sha(HashAlgorithm::Sha1, &[&first, &0u32.to_le_bytes()]);
        let derive = |fill: u8| {
            let mut buffer = vec![fill; 64];
            for (byte, mask) in buffer.iter_mut().zip(&final_hash) {
                *byte ^= mask;
            }
            sha(HashAlgorithm::Sha1, &[&buffer])
        };
        let mut key = derive(0x36);
        key.extend(derive(0x5c));
        key.truncate(16);
        let verifier = random_bytes(16);
        let csp: Vec<u8> = "Microsoft Enhanced RSA and AES Cryptographic Provider\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let mut header: Vec<u8> = Vec::new();
        for word in [0x24u32, 0, 0x660e, 0x8004, 128, 0x18, 0, 0] {
            header.extend_from_slice(&word.to_le_bytes());
        }
        header.extend_from_slice(&csp);
        let mut info = vec![3, 0, 2, 0];
        info.extend_from_slice(&0x24u32.to_le_bytes());
        info.extend_from_slice(&(header.len() as u32).to_le_bytes());
        info.extend_from_slice(&header);
        info.extend_from_slice(&16u32.to_le_bytes());
        info.extend_from_slice(&salt);
        info.extend_from_slice(&aes_encrypt("ecb", &key, &[], &verifier));
        info.extend_from_slice(&20u32.to_le_bytes());
        info.extend_from_slice(&aes_encrypt(
            "ecb",
            &key,
            &[],
            &pad_to(&sha(HashAlgorithm::Sha1, &[&verifier]), 16),
        ));
        encryption_info = info;
        encrypted_package = with_size(plain.len(), &aes_encrypt("ecb", &key, &[], &pad_to(plain, 16)));
    } else {
        let algorithm = HashAlgorithm::from_descriptor_name(options.hash_algorithm).expect("a descriptor hash name");
        let hash_size = algorithm.digest_length().expect("a computable hash");
        let secret = random_bytes(32);
        let key_salt = random_bytes(options.key_salt_size);
        let password_salt = random_bytes(16);
        let hashed = spun(algorithm, &password_salt, password, options.spin_count);
        let key_for = |block: &[u8]| fitted(&sha(algorithm, &[&hashed, block]), 32);
        let verifier_input = random_bytes(16);
        let encrypted =
            |block: &[u8], data: &[u8]| base64(&aes_encrypt("cbc", &key_for(block), &password_salt, &pad_to(data, 16)));
        let mut segments: Vec<u8> = Vec::new();
        for (index, segment) in plain.chunks(4096).enumerate() {
            let iv = fitted(&sha(algorithm, &[&key_salt, &(index as u32).to_le_bytes()]), 16);
            segments.extend_from_slice(&aes_encrypt("cbc", &secret, &iv, &pad_to(segment, 16)));
        }
        let package = with_size(plain.len(), &segments);
        // 2.3.4.14: an HMAC of the whole stream keyed by a random salt, both encrypted with the package key.
        let sealed = |block: &[u8], data: &[u8]| {
            let iv = fitted(&sha(algorithm, &[&key_salt, block]), 16);
            base64(&aes_encrypt("cbc", &secret, &iv, &pad_to(data, 16)))
        };
        let hmac_salt = random_bytes(options.hmac_salt_size.unwrap_or(hash_size));
        let mac = hmac(algorithm, &hmac_salt, &package).expect("a computable hash");
        let data_integrity = if options.integrity {
            format!(
                "<dataIntegrity encryptedHmacKey=\"{}\" encryptedHmacValue=\"{}\"/>",
                sealed(&[0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6], &hmac_salt),
                sealed(&[0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33], &mac)
            )
        } else {
            String::new()
        };
        let cipher = format!(
            "blockSize=\"16\" keyBits=\"256\" hashSize=\"{hash_size}\" cipherAlgorithm=\"AES\" cipherChaining=\"ChainingModeCBC\" hashAlgorithm=\"{}\"",
            options.hash_algorithm
        );
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n\
<encryption xmlns=\"http://schemas.microsoft.com/office/2006/encryption\" xmlns:p=\"http://schemas.microsoft.com/office/2006/keyEncryptor/password\">\
<keyData saltSize=\"{}\" {cipher} saltValue=\"{}\"/>{data_integrity}\
<keyEncryptors><keyEncryptor uri=\"http://schemas.microsoft.com/office/2006/keyEncryptor/password\">\
<p:encryptedKey spinCount=\"{}\" saltSize=\"16\" {cipher} saltValue=\"{}\" encryptedVerifierHashInput=\"{}\" encryptedVerifierHashValue=\"{}\" encryptedKeyValue=\"{}\"/>\
</keyEncryptor></keyEncryptors></encryption>",
            options.key_salt_size,
            base64(&key_salt),
            options.spin_count,
            base64(&password_salt),
            encrypted(&[0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79], &verifier_input),
            encrypted(
                &[0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e],
                &sha(algorithm, &[&verifier_input])
            ),
            encrypted(&[0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6], &secret),
        );
        let mut info = vec![4, 0, 4, 0, 0x40, 0, 0, 0];
        info.extend_from_slice(xml.as_bytes());
        encryption_info = info;
        encrypted_package = package;
    }
    vec![
        Entry::stream("EncryptionInfo", encryption_info),
        Entry::stream("EncryptedPackage", encrypted_package),
        data_spaces(),
    ]
}
