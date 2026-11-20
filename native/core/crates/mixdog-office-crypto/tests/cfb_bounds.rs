//! The 17 cases of `pdf/cfb-protection.test.mjs` of the Node tree: the probes and the stream readers over containers
//! the test writer builds (`tests/support`), and over containers corrupted in each way the reader must refuse.

mod support;

use std::path::{Path, PathBuf};

use mixdog_fsio::Unlaned;
use mixdog_office_crypto::{is_encrypted_binary_presentation, is_encrypted_ooxml, read_encrypted_ooxml, read_ooxml_encryption_info};
use support::{Entry, build_cfb, current_user_stream, encrypted_ooxml_entries, written};
use tempfile::TempDir;

const ENCRYPTED_TOKEN: u32 = 0xf3d1_c4df;
const PLAIN_TOKEN: u32 = 0xe391_c05f;

fn dir() -> TempDir {
    tempfile::tempdir().expect("a scratch directory")
}

fn ooxml(path: &Path) -> bool {
    is_encrypted_ooxml(&Unlaned, path)
}

fn presentation(path: &Path) -> bool {
    is_encrypted_binary_presentation(&Unlaned, path)
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn put16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn put64(bytes: &mut [u8], at: usize, value: u64) {
    bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
}

/// What an unencrypted legacy .doc holds: a CFB container with no encryption streams at all.
fn legacy_word_entries() -> Vec<Entry> {
    vec![
        Entry::stream("WordDocument", vec![1; 9000]),
        Entry::stream("1Table", vec![2; 5000]),
        Entry::stream("\u{1}CompObj", vec![3; 100]),
        Entry::stream("\u{5}SummaryInformation", vec![4; 300]),
    ]
}

fn summary_and_current_user(token: u32) -> Vec<Entry> {
    vec![Entry::stream("\u{5}SummaryInformation", vec![0; 1000]), current_user_stream(token), Entry::stream("PowerPoint Document", vec![7; 6000])]
}

#[test]
fn an_encrypted_ooxml_container_is_protected() {
    let dir = dir();
    for version in [3, 4] {
        let path = written(dir.path(), &format!("secret-v{version}.docx"), &build_cfb(&encrypted_ooxml_entries(5000), version));
        assert!(ooxml(&path), "CFB version {version}");
    }
}

#[test]
fn stream_names_match_case_insensitively() {
    let dir = dir();
    let entries = [Entry::stream("ENCRYPTIONINFO", vec![0; 40]), Entry::stream("encryptedpackage", vec![0; 40])];
    assert!(ooxml(&written(dir.path(), "shout.xlsx", &build_cfb(&entries, 3))));
}

#[test]
fn a_plain_container_renamed_docx_is_not_protected() {
    let dir = dir();
    assert!(!ooxml(&written(dir.path(), "renamed-legacy.docx", &build_cfb(&legacy_word_entries(), 3))));
}

#[test]
fn both_encryption_streams_are_required_and_only_at_the_root() {
    let dir = dir();
    let entries = encrypted_ooxml_entries(5000);
    let (info, package) = (entries[0].clone(), entries[1].clone());
    assert!(!ooxml(&written(dir.path(), "no-info.docx", &build_cfb(&[package.clone()], 3))));
    assert!(!ooxml(&written(dir.path(), "no-package.docx", &build_cfb(&[info.clone()], 3))));
    let mut nested = vec![Entry::storage("Nested", vec![info, package])];
    nested.extend(legacy_word_entries());
    assert!(!ooxml(&written(dir.path(), "nested.docx", &build_cfb(&nested, 3))));
}

#[test]
fn a_directory_beyond_the_109_header_fat_entries_is_reached_through_the_difat_chain() {
    // 109 FAT sectors of 128 entries map 7,143,424 bytes of 512-byte sectors; the directory follows the data.
    let dir = dir();
    let package_bytes = 7_700_000;
    let big = build_cfb(&encrypted_ooxml_entries(package_bytes), 3);
    assert!(u32_at(&big, 72) >= 1, "the fixture needs a DIFAT sector");
    assert!(ooxml(&written(dir.path(), "big.xlsx", &big)));
    let big_plain = build_cfb(&[Entry::stream("Workbook", vec![0; package_bytes])], 3);
    assert!(!ooxml(&written(dir.path(), "big-plain.xlsx", &big_plain)));
}

#[test]
fn a_truncated_container_is_not_protected() {
    let dir = dir();
    let whole = build_cfb(&encrypted_ooxml_entries(5000), 3);
    let directory_at = (u32_at(&whole, 48) as usize + 1) * 512;
    for length in [0, 7, 100, 512, 1024, directory_at, directory_at + 60] {
        let path = written(dir.path(), "cut.docx", &whole[..length]);
        assert!(!ooxml(&path), "cut at {length} bytes");
    }
    assert!(!ooxml(&dir.path().join("cfb-protection-missing.docx")));
}

#[test]
fn a_corrupt_container_is_not_protected() {
    let dir = dir();
    type Change = fn(&mut Vec<u8>, usize);
    let cases: [(&str, Change); 10] = [
        ("bad signature", |bytes, _| bytes[0] ^= 0xff),
        ("bad byte order", |bytes, _| put16(bytes, 28, 0xfeff)),
        ("sector size that does not match the version", |bytes, _| put16(bytes, 30, 12)),
        ("directory start is free", |bytes, _| put32(bytes, 48, 0xffff_ffff)),
        ("directory start past the file", |bytes, _| put32(bytes, 48, 0x00ff_ffff)),
        ("directory chain loops on itself", |bytes, _| {
            let fat_sector = u32_at(bytes, 76) as usize;
            let start = u32_at(bytes, 48);
            put32(bytes, (fat_sector + 1) * 512 + start as usize * 4, start);
        }),
        ("no root storage", |bytes, directory_at| bytes[directory_at + 66] = 0),
        ("sibling tree loops", |bytes, directory_at| put32(bytes, directory_at + 2 * 128 + 72, 1)),
        ("entry id past the directory", |bytes, directory_at| put32(bytes, directory_at + 76, 900)),
        ("entry name too long", |bytes, directory_at| put16(bytes, directory_at + 128 + 64, 200)),
    ];
    for (name, change) in cases {
        let mut bytes = build_cfb(&encrypted_ooxml_entries(5000), 3);
        let directory_at = (u32_at(&bytes, 48) as usize + 1) * 512;
        change(&mut bytes, directory_at);
        assert!(!ooxml(&written(dir.path(), &format!("{name}.docx"), &bytes)), "{name}");
    }
}

#[test]
fn a_non_cfb_file_is_not_protected_whatever_its_extension_or_content() {
    let dir = dir();
    assert!(!ooxml(&written(dir.path(), "zip.docx", b"PK\x03\x04 zip bytes")));
    assert!(!presentation(&written(dir.path(), "text.ppt", b"source bytes")));
}

#[test]
fn an_encrypted_binary_presentation_is_found_by_its_current_user_header_token() {
    // A summary stream ahead of it puts "Current User" at mini sector 16, in the third sector of the mini stream.
    let dir = dir();
    assert!(presentation(&written(dir.path(), "locked.ppt", &build_cfb(&summary_and_current_user(ENCRYPTED_TOKEN), 3))));
    assert!(!presentation(&written(dir.path(), "open.ppt", &build_cfb(&summary_and_current_user(PLAIN_TOKEN), 3))));
    assert!(presentation(&written(dir.path(), "locked4.ppt", &build_cfb(&summary_and_current_user(ENCRYPTED_TOKEN), 4))));
}

#[test]
fn a_current_user_stream_past_the_declared_mini_stream_size_of_the_root_entry_is_not_read() {
    let dir = dir();
    let mut bytes = build_cfb(&[current_user_stream(ENCRYPTED_TOKEN)], 3);
    // The root entry is the first directory entry; its stream size sits at byte 120.
    let at = (u32_at(&bytes, 48) as usize + 1) * 512 + 120;
    put64(&mut bytes, at, 0);
    assert!(!presentation(&written(dir.path(), "sizeless.ppt", &bytes)));
}

#[test]
fn a_current_user_stream_above_the_mini_stream_cutoff_is_read_from_its_regular_sectors() {
    let dir = dir();
    let mut stream = current_user_stream(ENCRYPTED_TOKEN);
    stream.data.as_mut().expect("a stream").extend_from_slice(&[0; 5000]);
    assert!(presentation(&written(dir.path(), "padded.ppt", &build_cfb(&[stream], 3))));
}

#[test]
fn an_encrypted_summary_stream_marks_an_encrypted_binary_presentation() {
    let dir = dir();
    let entries = [current_user_stream(PLAIN_TOKEN), Entry::stream("EncryptedSummary", vec![0; 200])];
    assert!(presentation(&written(dir.path(), "summary.ppt", &build_cfb(&entries, 3))));
}

// Offsets inside a container built by the writer (its FAT sectors are all listed in the header).
fn sector_size_of(bytes: &[u8]) -> usize {
    1 << u16_at(bytes, 30)
}

fn sector_at(bytes: &[u8], sector: u32) -> usize {
    (sector as usize + 1) * sector_size_of(bytes)
}

fn fat_entry_at(bytes: &[u8], sector: u32) -> usize {
    let per_sector = sector_size_of(bytes) / 4;
    sector_at(bytes, u32_at(bytes, 76 + (sector as usize / per_sector) * 4)) + (sector as usize % per_sector) * 4
}

fn entry_at(bytes: &[u8], name: &str) -> usize {
    let mut at = sector_at(bytes, u32_at(bytes, 48));
    loop {
        let length = usize::from(u16_at(bytes, at + 64));
        let units: Vec<u16> = bytes[at..at + length - 2].chunks_exact(2).map(|pair| u16_at(pair, 0)).collect();
        if String::from_utf16_lossy(&units) == name {
            return at;
        }
        at += 128;
    }
}

fn start_of(bytes: &[u8], name: &str) -> u32 {
    u32_at(bytes, entry_at(bytes, name) + 116)
}

#[test]
fn a_cyclic_mini_stream_chain_is_refused_even_under_a_root_size_far_beyond_the_file() {
    // "Current User" sits at mini sector 16, in the third sector of the mini stream: reading it follows the chain.
    let dir = dir();
    let deck = vec![Entry::stream("\u{5}SummaryInformation", vec![0; 1000]), current_user_stream(ENCRYPTED_TOKEN)];
    let looped = |entries: &[Entry], version: u16, root_size: Option<u64>| {
        let mut bytes = build_cfb(entries, version);
        let root = start_of(&bytes, "Root Entry");
        let at = fat_entry_at(&bytes, root);
        put32(&mut bytes, at, root);
        if let Some(size) = root_size {
            let at = entry_at(&bytes, "Root Entry") + 120;
            put64(&mut bytes, at, size);
        }
        bytes
    };
    assert!(!presentation(&written(dir.path(), "loop.ppt", &looped(&deck, 3, None))));
    for (version, root_size) in [(3u16, 0xffff_ffc0u64), (4, 1 << 40)] {
        let deck_path = written(dir.path(), &format!("huge-{version}.ppt"), &looped(&deck, version, Some(root_size)));
        assert!(!presentation(&deck_path), "version {version}");
        let ooxml_path = written(dir.path(), &format!("huge-{version}.docx"), &looped(&encrypted_ooxml_entries(5000), version, Some(root_size)));
        assert_eq!(read_ooxml_encryption_info(&Unlaned, &ooxml_path), None, "version {version}");
        assert_eq!(read_encrypted_ooxml(&Unlaned, &ooxml_path), None, "version {version}");
    }
}

#[test]
fn a_cyclic_mini_sector_chain_or_a_mini_fat_larger_than_the_file_is_refused() {
    let dir = dir();
    let entries = || vec![Entry::stream("EncryptionInfo", vec![1; 200]), Entry::stream("EncryptedPackage", vec![2; 5000])];
    let intact: PathBuf = written(dir.path(), "intact.docx", &build_cfb(&entries(), 3));
    assert_eq!(read_ooxml_encryption_info(&Unlaned, &intact), Some(vec![1; 200]));
    // EncryptionInfo holds mini sectors 0 to 3; sending the third back to the second closes a loop.
    let mut cyclic = build_cfb(&entries(), 3);
    let at = sector_at(&cyclic, u32_at(&cyclic, 60)) + 2 * 4;
    put32(&mut cyclic, at, 1);
    assert_eq!(read_ooxml_encryption_info(&Unlaned, &written(dir.path(), "mini-loop.docx", &cyclic)), None);
    let mut oversized = build_cfb(&entries(), 3);
    put32(&mut oversized, 64, 0xffff_ffff);
    assert!(!ooxml(&written(dir.path(), "mini-fat.docx", &oversized)));
}

#[test]
fn a_cyclic_stream_chain_or_one_that_leaves_the_file_is_refused() {
    let dir = dir();
    let changed = |name: &str, next: fn(u32) -> u32| {
        let mut bytes = build_cfb(&encrypted_ooxml_entries(5000), 3);
        let start = start_of(&bytes, "EncryptedPackage");
        let at = fat_entry_at(&bytes, start + 1);
        put32(&mut bytes, at, next(start));
        written(dir.path(), name, &bytes)
    };
    assert!(read_encrypted_ooxml(&Unlaned, &changed("intact.docx", |start| start + 2)).is_some());
    assert!(read_encrypted_ooxml(&Unlaned, &changed("loop.docx", |start| start)).is_none());
    assert!(read_encrypted_ooxml(&Unlaned, &changed("outside.docx", |_| 0x00ff_ffff)).is_none());
}

#[test]
fn header_counts_beyond_the_file_or_a_mini_stream_cutoff_other_than_4096_are_not_a_container() {
    let dir = dir();
    for (name, at) in [("FAT sectors", 44), ("DIFAT sectors", 72), ("mini FAT sectors", 64)] {
        let mut bytes = build_cfb(&encrypted_ooxml_entries(5000), 3);
        put32(&mut bytes, at, 0x7fff_ffff);
        assert!(!ooxml(&written(dir.path(), &format!("{name}.docx"), &bytes)), "{name}");
    }
    let mut bytes = build_cfb(&encrypted_ooxml_entries(5000), 3);
    put32(&mut bytes, 56, 0xffff_ffff);
    assert!(!ooxml(&written(dir.path(), "mini-stream cutoff.docx", &bytes)), "mini-stream cutoff");
}

#[test]
fn stray_header_token_bytes_elsewhere_do_not_mark_a_binary_presentation_as_encrypted() {
    let dir = dir();
    let atom = current_user_stream(ENCRYPTED_TOKEN).data.expect("a stream");
    let mut inside_other_stream = vec![0u8; 64];
    inside_other_stream.extend_from_slice(&atom);
    inside_other_stream.extend_from_slice(&[0; 64]);
    let strays = [
        // The atom inside another stream, with no root "Current User" stream.
        vec![Entry::stream("PowerPoint Document", inside_other_stream)],
        // The atom under a sub-storage, not at the root.
        vec![Entry::storage("Nested", vec![Entry::stream("Current User", atom.clone())]), Entry::stream("Pictures", vec![0; 100])],
        // A Current User stream too short to hold the atom's headerToken.
        vec![Entry::stream("Current User", atom[..14].to_vec())],
    ];
    for (index, entries) in strays.iter().enumerate() {
        assert!(!presentation(&written(dir.path(), &format!("stray-{index}.ppt"), &build_cfb(entries, 3))));
    }
    let mut raw = vec![0u8; 64];
    raw.extend_from_slice(&[0xdf, 0xc4, 0xd1, 0xf3]);
    raw.extend_from_slice(&[0; 64]);
    assert!(!presentation(&written(dir.path(), "raw.ppt", &raw)));
}
