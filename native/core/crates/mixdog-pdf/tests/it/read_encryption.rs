//! Documents protected by the standard security handler with RC4 (40-bit revision 2, 128-bit revision 3): opening with
//! no password, the user password, the owner password and a wrong one, and the decryption of the page content. The
//! documents are encrypted here with the algorithms of the PDF specification (7.6.3), written independently of the
//! reader: MD5 and RC4 are checked against their published test vectors first.

use aes::cipher::{BlockEncrypt, KeyInit, generic_array::GenericArray};
use mixdog_pdf::document::{Document, OpenOptions, wrap_reason};
use sha2::{Digest, Sha256, Sha384, Sha512};

use crate::read_support::{build_with_trailer, stream};

const PAD: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00,
    0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

fn md5(input: &[u8]) -> [u8; 16] {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
        20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
        10, 15, 21,
    ];
    let k: Vec<u32> = (0..64).map(|i| ((f64::from(i) + 1.0).sin().abs() * 4_294_967_296.0) as u32).collect();
    let (mut a0, mut b0, mut c0, mut d0) = (0x6745_2301u32, 0xefcd_ab89u32, 0x98ba_dcfeu32, 0x1032_5476u32);
    let mut message = input.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend(((input.len() as u64) * 8).to_le_bytes());
    for chunk in message.chunks(64) {
        let m: Vec<u32> = chunk.chunks(4).map(|w| u32::from_le_bytes([w[0], w[1], w[2], w[3]])).collect();
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64usize {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let sum = f.wrapping_add(a).wrapping_add(k[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(sum.rotate_left(S[i]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0u8; 16];
    for (slot, word) in out.chunks_mut(4).zip([a0, b0, c0, d0]) {
        slot.copy_from_slice(&word.to_le_bytes());
    }
    out
}

fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut s: Vec<u8> = (0..=255).collect();
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(s[i]).wrapping_add(key[i % key.len()]);
        s.swap(i, usize::from(j));
    }
    let (mut i, mut j) = (0u8, 0u8);
    data.iter()
        .map(|byte| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(s[usize::from(i)]);
            s.swap(usize::from(i), usize::from(j));
            byte ^ s[usize::from(s[usize::from(i)].wrapping_add(s[usize::from(j)]))]
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn padded(password: &str) -> Vec<u8> {
    let mut out = password.as_bytes().to_vec();
    out.extend_from_slice(&PAD);
    out.truncate(32);
    out
}

const FILE_ID: &[u8; 16] = b"0123456789abcdef";
const CONTENT: &str = "BT /F1 12 Tf 20 100 Td (Secret) Tj ET";

/// A one-page file whose content stream (object 4) is encrypted with `revision` 2 (40-bit key) or 3 (128-bit key).
fn encrypted(revision: u8, user: &str, owner: &str) -> Vec<u8> {
    standard_file(revision, user, owner, false)
}

/// Revisions 2 and 3 use RC4; revision 4 (`aes`) is the same key derivation with the AESV2 crypt filter: the object
/// key is salted with "sAlT" and the data is a 16-byte IV followed by AES-128-CBC with PKCS#7 padding.
fn standard_file(revision: u8, user: &str, owner: &str, aes: bool) -> Vec<u8> {
    let n = if revision == 2 { 5 } else { 16 };
    // Algorithm 3: the owner entry is the user password padded and encrypted with a key made of the owner password.
    let mut digest = md5(&padded(if owner.is_empty() { user } else { owner }));
    if revision >= 3 {
        for _ in 0..50 {
            digest = md5(&digest);
        }
    }
    let owner_key = &digest[..n];
    let mut o = rc4(owner_key, &padded(user));
    if revision >= 3 {
        for round in 1..=19u8 {
            let key: Vec<u8> = owner_key.iter().map(|b| b ^ round).collect();
            o = rc4(&key, &o);
        }
    }
    // Algorithm 2: the file key.
    let permissions: i32 = -4;
    let mut seed = padded(user);
    seed.extend_from_slice(&o);
    seed.extend_from_slice(&permissions.to_le_bytes());
    seed.extend_from_slice(FILE_ID);
    let mut digest = md5(&seed);
    if revision >= 3 {
        for _ in 0..50 {
            digest = md5(&digest[..n]);
        }
    }
    let key = digest[..n].to_vec();
    // Algorithms 4 and 5: the user entry.
    let u = if revision == 2 {
        rc4(&key, &PAD)
    } else {
        let mut seed = PAD.to_vec();
        seed.extend_from_slice(FILE_ID);
        let mut u = rc4(&key, &md5(&seed));
        for round in 1..=19u8 {
            let round_key: Vec<u8> = key.iter().map(|b| b ^ round).collect();
            u = rc4(&round_key, &u);
        }
        u.resize(32, 0);
        u
    };
    // Algorithm 1: the key of object 4, generation 0.
    let mut object_key = key.clone();
    object_key.extend_from_slice(&[4, 0, 0, 0, 0]);
    if aes {
        object_key.extend_from_slice(b"sAlT");
    }
    let object_key = &md5(&object_key)[..(n + 5).min(16)];
    let secret = if aes {
        aes_data(object_key, CONTENT.as_bytes())
    } else {
        rc4(object_key, CONTENT.as_bytes())
    };
    let encrypt = if aes {
        format!(
            "<< /Filter /Standard /V 4 /R 4 /Length 128 /P -4 /O <{}> /U <{}> /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF >>",
            hex(&o),
            hex(&u)
        )
    } else {
        format!(
            "<< /Filter /Standard /V {} /R {revision} /Length {} /P -4 /O <{}> /U <{}> >>",
            if revision == 2 { 1 } else { 2 },
            n * 8,
            hex(&o),
            hex(&u)
        )
    };
    let objects = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>".to_vec()),
        (4, stream("", &secret)),
        (6, encrypt.into_bytes()),
    ];
    build_with_trailer(&objects, &format!("/Encrypt 6 0 R /ID [<{0}> <{0}>]", hex(FILE_ID)))
}

fn open_with(bytes: &[u8], password: Option<&str>) -> Result<Document, mixdog_pdf::PdfError> {
    let options = OpenOptions { password: password.map(str::to_owned), ..OpenOptions::default() };
    Document::open(bytes.to_vec(), &options)
}

fn content_of(document: &Document) -> Vec<u8> {
    document.page(0).expect("a page").content(document).expect("the content")
}

#[test]
fn the_helpers_match_the_published_test_vectors() {
    assert_eq!(hex(&md5(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(hex(&md5(b"")), "d41d8cd98f00b204e9800998ecf8427e");
    assert_eq!(hex(&rc4(b"Key", b"Plaintext")), "bbf316e8d940af0ad3");
}

#[test]
fn a_file_with_an_empty_user_password_opens_without_one_and_its_content_is_decrypted() {
    for revision in [2, 3] {
        let bytes = encrypted(revision, "", "owner-secret");
        let document = open_with(&bytes, None).unwrap_or_else(|e| panic!("revision {revision}: {e}"));
        assert_eq!(content_of(&document), CONTENT.as_bytes(), "revision {revision}");
    }
}

#[test]
fn a_user_password_is_needed_and_the_wrong_one_is_refused() {
    for revision in [2, 3] {
        let bytes = encrypted(revision, "open sesame", "owner-secret");
        let missing = open_with(&bytes, None).err().expect("no password");
        let missing = wrap_reason(&missing);
        assert_eq!(
            (missing.name, missing.code, missing.message.as_str()),
            ("PasswordException", Some(1), "No password given"),
            "revision {revision}"
        );
        let wrong = open_with(&bytes, Some("not the password")).err().expect("a wrong password");
        let wrong = wrap_reason(&wrong);
        assert_eq!(
            (wrong.name, wrong.code, wrong.message.as_str()),
            ("PasswordException", Some(2), "Incorrect Password"),
            "revision {revision}"
        );
        let document = open_with(&bytes, Some("open sesame")).expect("the user password");
        assert_eq!(content_of(&document), CONTENT.as_bytes(), "revision {revision}");
    }
}

#[test]
fn the_owner_password_opens_the_file_too() {
    for revision in [2, 3] {
        let bytes = encrypted(revision, "open sesame", "owner-secret");
        let document = open_with(&bytes, Some("owner-secret")).unwrap_or_else(|e| panic!("revision {revision}: {e}"));
        assert_eq!(content_of(&document), CONTENT.as_bytes(), "revision {revision}");
    }
}

fn cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
    fn run<C: BlockEncrypt + KeyInit>(key: &[u8], iv: &[u8], data: &[u8]) -> Vec<u8> {
        let cipher = C::new(GenericArray::from_slice(key));
        let mut previous = iv.to_vec();
        let mut out = Vec::new();
        for chunk in data.chunks(16) {
            let mut block: Vec<u8> = chunk.iter().zip(&previous).map(|(a, b)| a ^ b).collect();
            cipher.encrypt_block(GenericArray::from_mut_slice(&mut block));
            previous = block.clone();
            out.extend(block);
        }
        out
    }
    if key.len() == 16 { run::<aes::Aes128>(key, iv, data) } else { run::<aes::Aes256>(key, iv, data) }
}

/// A 16-byte IV followed by the data in CBC with PKCS#7 padding.
fn aes_data(key: &[u8], data: &[u8]) -> Vec<u8> {
    let iv = [7u8; 16];
    let pad = 16 - data.len() % 16;
    let mut padded = data.to_vec();
    padded.extend(std::iter::repeat_n(pad as u8, pad));
    let mut out = iv.to_vec();
    out.extend(cbc(key, &iv, &padded));
    out
}

/// Algorithm 2.B of ISO 32000-2: the hash of revision 6.
fn hash_r6(password: &[u8], salt: &[u8], user_entry: &[u8]) -> Vec<u8> {
    let mut k = Sha256::digest([password, salt, user_entry].concat()).to_vec();
    let mut round = 0usize;
    loop {
        let unit = [password, &k, user_entry].concat();
        let e = cbc(&k[..16], &k[16..32], &unit.repeat(64));
        let choice = e[..16].iter().map(|&b| u32::from(b)).sum::<u32>() % 3;
        k = match choice {
            0 => Sha256::digest(&e).to_vec(),
            1 => Sha384::digest(&e).to_vec(),
            _ => Sha512::digest(&e).to_vec(),
        };
        round += 1;
        if round >= 64 && usize::from(e[e.len() - 1]) <= round - 32 {
            break;
        }
    }
    k.truncate(32);
    k
}

/// A one-page file protected with AES-256 (revision 6): the file key is stored encrypted under keys made of each
/// password, and the content is encrypted with the file key itself.
fn aes256_file(user: &str, owner: &str) -> Vec<u8> {
    let file_key: Vec<u8> = (0..32u8).map(|i| i * 7 + 1).collect();
    let (user_validation, user_key_salt) = (b"uvalsalt", b"ukeysalt");
    let (owner_validation, owner_key_salt) = (b"ovalsalt", b"okeysalt");
    let mut u = hash_r6(user.as_bytes(), user_validation, &[]);
    u.extend_from_slice(user_validation);
    u.extend_from_slice(user_key_salt);
    let ue = cbc(&hash_r6(user.as_bytes(), user_key_salt, &[]), &[0; 16], &file_key);
    let mut o = hash_r6(owner.as_bytes(), owner_validation, &u);
    o.extend_from_slice(owner_validation);
    o.extend_from_slice(owner_key_salt);
    let oe = cbc(&hash_r6(owner.as_bytes(), owner_key_salt, &u), &[0; 16], &file_key);
    let mut permissions = vec![0xFC, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, b'T', b'a', b'd', b'b'];
    permissions.extend([0; 4]);
    let perms = cbc(&file_key, &[0; 16], &permissions);
    let encrypt = format!(
        "<< /Filter /Standard /V 5 /R 6 /Length 256 /P -4 /O <{}> /U <{}> /OE <{}> /UE <{}> /Perms <{}> /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF >>",
        hex(&o), hex(&u), hex(&oe), hex(&ue), hex(&perms)
    );
    let objects = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>".to_vec()),
        (4, stream("", &aes_data(&file_key, CONTENT.as_bytes()))),
        (6, encrypt.into_bytes()),
    ];
    build_with_trailer(&objects, &format!("/Encrypt 6 0 R /ID [<{0}> <{0}>]", hex(FILE_ID)))
}

#[test]
fn aes_128_files_open_with_the_user_and_the_owner_password() {
    let bytes = standard_file(4, "open sesame", "owner-secret", true);
    assert_eq!(wrap_reason(&open_with(&bytes, None).err().expect("no password")).code, Some(1));
    assert_eq!(wrap_reason(&open_with(&bytes, Some("nope")).err().expect("wrong")).code, Some(2));
    for password in ["open sesame", "owner-secret"] {
        let document = open_with(&bytes, Some(password)).unwrap_or_else(|e| panic!("{password}: {e}"));
        assert_eq!(content_of(&document), CONTENT.as_bytes(), "{password}");
    }
    let open_file = standard_file(4, "", "owner-secret", true);
    assert_eq!(content_of(&open_with(&open_file, None).expect("empty user password")), CONTENT.as_bytes());
}

#[test]
fn aes_256_files_open_with_the_user_and_the_owner_password() {
    let bytes = aes256_file("open sesame", "owner-secret");
    assert_eq!(wrap_reason(&open_with(&bytes, None).err().expect("no password")).code, Some(1));
    assert_eq!(wrap_reason(&open_with(&bytes, Some("nope")).err().expect("wrong")).code, Some(2));
    for password in ["open sesame", "owner-secret"] {
        let document = open_with(&bytes, Some(password)).unwrap_or_else(|e| panic!("{password}: {e}"));
        assert_eq!(content_of(&document), CONTENT.as_bytes(), "{password}");
    }
    let open_file = aes256_file("", "owner-secret");
    assert_eq!(content_of(&open_with(&open_file, None).expect("empty user password")), CONTENT.as_bytes());
}
