//! Isolated snapshot/collection regressions. No installed fonts, canvas or host discovery.
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use mixdog_fonts::Face;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use sha2::{Digest, Sha256};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!("mixdog-font-snapshot-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir(&path).expect("unique isolated directory");
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.join("snapshot.ttc"));
        let _ = std::fs::remove_file(self.0.join("snapshot.ttf"));
        let _ = std::fs::remove_dir(&self.0);
    }
}
fn fixture(bold: bool) -> Vec<u8> {
    let (name, digest) = if bold {
        ("NotoSansLisu-Bold.ttf", "2940c8397a096f2bb295a869a318a5d91fbbf3b70e09995308febe9c483eb9e2")
    } else {
        ("NotoSansLisu-Regular.ttf", "7aa2279848cc8647198185807616555759bd68b8a3edb21ecc467d071aa7a6a4")
    };
    let bytes = std::fs::read(twin::repo_root().join("native/core/fixtures/office-measure/faces").join(name)).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), digest);
    bytes
}

// Wrap the two pinned sfnt fixtures in TTC v1; sfnt table offsets become absolute TTC offsets.
fn collection() -> Vec<u8> {
    let fonts = [fixture(false), fixture(true)];
    let mut bytes = b"ttcf\0\x01\0\0\0\0\0\x02".to_vec();
    bytes.resize(20, 0);
    for (index, mut font) in fonts.into_iter().enumerate() {
        while bytes.len() % 4 != 0 { bytes.push(0); }
        let base = u32::try_from(bytes.len()).unwrap();
        bytes[12 + index * 4..16 + index * 4].copy_from_slice(&base.to_be_bytes());
        let tables = usize::from(u16::from_be_bytes(font[4..6].try_into().unwrap()));
        for table in 0..tables {
            let at = 12 + table * 16 + 8;
            let offset = u32::from_be_bytes(font[at..at + 4].try_into().unwrap());
            font[at..at + 4].copy_from_slice(&(offset + base).to_be_bytes());
        }
        bytes.extend(font);
    }
    bytes
}

#[test]
fn verified_snapshot_survives_source_replacement_and_removal() {
    let scratch = Scratch::new();
    let path = scratch.0.join("snapshot.ttf");
    let bytes = fixture(false);
    std::fs::write(&path, &bytes).unwrap();
    let direct = Face::described(&path, &bytes).unwrap();
    let mut registry = Registry::new();
    let id = registry.register_described(&path, &bytes, Some("Pinned")).unwrap();
    let before = registry.face(id).parsed().unwrap().glyph_index('A');
    std::fs::write(&path, fixture(true)).unwrap();
    assert_eq!(registry.register_file(&Unlaned, &path, Some("Pinned")).unwrap(), id);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(direct.ensure_loaded(&Unlaned).unwrap().as_ref(), bytes.as_slice());
    assert_eq!(registry.face(id).ensure_loaded(&Unlaned).unwrap().as_ref(), bytes.as_slice());
    assert_eq!(registry.face(id).parsed().unwrap().glyph_index('A'), before);
    assert_eq!(registry.face(id).style.weight, 400);
    assert_eq!(registry.len(), 1);
}

#[test]
fn directory_registration_enumerates_all_collection_members_and_shares_bytes() {
    let scratch = Scratch::new();
    let path = scratch.0.join("snapshot.ttc");
    let bytes = collection();
    std::fs::write(&path, &bytes).unwrap();
    let mut registry = Registry::new();
    assert_eq!(registry.register_dir(&Unlaned, &scratch.0), 2);
    assert_eq!(registry.register_dir(&Unlaned, &scratch.0), 0);
    assert_eq!(registry.len(), 2);
    assert_eq!((registry.face(0).index(), registry.face(1).index()), (0, 1));
    assert_eq!((registry.face(0).style.weight, registry.face(1).style.weight), (400, 700));
    assert!(Arc::ptr_eq(registry.face(0).bytes().unwrap(), registry.face(1).bytes().unwrap()));
    for id in 0..2 {
        assert_eq!(registry.face(id).path(), Some(path.as_path()));
        assert!(registry.face(id).parsed().unwrap().glyph_index('A').is_some());
    }
    std::fs::remove_file(&path).unwrap();
    assert_eq!(registry.face(1).ensure_loaded(&Unlaned).unwrap().as_ref(), bytes.as_slice());
    let mut aliased = Registry::new();
    assert_eq!(aliased.register_bytes(&path, bytes, Some("Collection")).unwrap(), vec![0, 1]);
    assert_eq!(aliased.family("Collection"), Some(&[0, 1][..]));
}

#[test]
fn invalid_later_collection_member_does_not_partially_register() {
    let mut bytes = collection();
    bytes[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
    let mut registry = Registry::new();
    assert!(registry.register_bytes(std::path::Path::new("not-read.ttc"), bytes, None).is_err());
    assert!(registry.is_empty());
}
