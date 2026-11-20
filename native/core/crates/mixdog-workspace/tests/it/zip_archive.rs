//! A folder's ZIP export: which files go in (generated folders and links out of the folder are left out; a file list the repository
//! gives is the list), the order, the entry names, and the archive's own bytes (read back with an independent parser).

use std::io::Cursor;
use std::path::Path;

use mixdog_workspace::lanes::Lanes;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::zip::TrackedFiles;
use mixdog_workspace::zip::scan_folder;
use mixdog_workspace::zip::write_archive;
use tokio_util::sync::CancellationToken;

/// Outside any repository.
struct NoRepository;

#[async_trait::async_trait]
impl TrackedFiles for NoRepository {
    async fn files(&self, _: &Path, _: &CancellationToken) -> Option<Vec<String>> {
        None
    }
    async fn ignored(&self, _: &Path, _: &CancellationToken) -> Option<u64> {
        None
    }
}

/// A repository whose verdict is the given list, with `ignored` further ignored files.
struct Repository(Vec<&'static str>, u64);

#[async_trait::async_trait]
impl TrackedFiles for Repository {
    async fn files(&self, _: &Path, _: &CancellationToken) -> Option<Vec<String>> {
        Some(self.0.iter().map(|s| (*s).to_owned()).collect())
    }
    async fn ignored(&self, _: &Path, _: &CancellationToken) -> Option<u64> {
        Some(self.1)
    }
}

fn lanes() -> Lanes {
    let tokens = mixdog_rt::testing::tokens();
    Lanes { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io, cpu_bulk: tokens.cpu_bulk }
}

fn put(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

struct Entry {
    name: String,
    method: u16,
    crc: u32,
    stored: Vec<u8>,
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(b[at..at + 2].try_into().unwrap())
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// Reads the archive through its central directory.
fn read_archive(bytes: &[u8]) -> Vec<Entry> {
    let end = bytes.len() - 22;
    assert_eq!(u32_at(bytes, end), 0x0605_4b50, "end of central directory");
    let count = u16_at(bytes, end + 10) as usize;
    let (size, start) = (u32_at(bytes, end + 12) as usize, u32_at(bytes, end + 16) as usize);
    assert_eq!(start + size, end, "the directory ends where the end record begins");
    let mut at = start;
    let mut out = Vec::new();
    for _ in 0..count {
        assert_eq!(u32_at(bytes, at), 0x0201_4b50);
        assert_eq!(u16_at(bytes, at + 8), 0x0800, "names are UTF-8");
        let (method, crc, compressed) = (u16_at(bytes, at + 10), u32_at(bytes, at + 16), u32_at(bytes, at + 20) as usize);
        let (name_len, extra, comment) = (u16_at(bytes, at + 28) as usize, u16_at(bytes, at + 30) as usize, u16_at(bytes, at + 32) as usize);
        let local = u32_at(bytes, at + 42) as usize;
        let name = String::from_utf8(bytes[at + 46..at + 46 + name_len].to_vec()).unwrap();
        assert_eq!(u32_at(bytes, local), 0x0403_4b50);
        assert_eq!(u32_at(bytes, local + 18) as usize, compressed, "sizes are in the local header");
        let (local_name, local_extra) = (u16_at(bytes, local + 26) as usize, u16_at(bytes, local + 28) as usize);
        let data = local + 30 + local_name + local_extra;
        out.push(Entry { name, method, crc, stored: bytes[data..data + compressed].to_vec() });
        at += 46 + name_len + extra + comment;
    }
    out
}

fn inflate(entry: &Entry) -> Vec<u8> {
    use std::io::Read;
    match entry.method {
        0 => entry.stored.clone(),
        8 => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(&entry.stored[..]).read_to_end(&mut out).unwrap();
            out
        }
        other => panic!("method {other}"),
    }
}

async fn archive_of(root: &Path, git: &dyn TrackedFiles) -> (Vec<Entry>, u64) {
    let scan = scan_folder(git, lanes(), &CancellationToken::new(), root, 1 << 30, 100_000, None).await.unwrap();
    let mut out = Cursor::new(Vec::new());
    write_archive(&mut out, &scan.files, 1 << 30, &|_: &str| {}).unwrap();
    (read_archive(&out.into_inner()), scan.ignored)
}

#[tokio::test(flavor = "multi_thread")]
async fn outside_a_repository_generated_folders_are_left_out_and_every_other_file_is_stored_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonical(dir.path()).unwrap();
    let repetitive = "abc".repeat(1000);
    put(&root, "b.txt", repetitive.as_bytes());
    put(&root, "a/inner.txt", "héllo wörld".as_bytes());
    put(&root, "empty.bin", b"");
    put(&root, "node_modules/dep/index.js", b"x");
    put(&root, "dist/out.js", b"x");
    put(&root, "target/debug/x", b"x");
    put(&root, "src/build/hidden.txt", b"x");
    put(&root, "src/keep.txt", b"kept");
    let (entries, ignored) = archive_of(&root, &NoRepository).await;
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["a/inner.txt", "b.txt", "empty.bin", "src/keep.txt"], "sorted, `/`-separated, a generated folder is left out at any depth");
    // The files under the folders left out (node_modules, dist, target, src/build: one each) are reported as left out
    // (`zip.rs` walk: a `Generated` rule's `Verdict::Out` adds `count_files`).
    assert_eq!(ignored, 4);
    let content = |name: &str| inflate(entries.iter().find(|e| e.name == name).unwrap());
    assert_eq!(content("a/inner.txt"), "héllo wörld".as_bytes());
    assert_eq!(content("b.txt"), repetitive.as_bytes());
    assert_eq!(content("empty.bin"), b"");
    // A file is deflated only when that is smaller; the checksum is the file's.
    let method = |name: &str| entries.iter().find(|e| e.name == name).unwrap().method;
    assert_eq!((method("b.txt"), method("empty.bin"), method("a/inner.txt")), (8, 0, 0));
    let crc = entries.iter().find(|e| e.name == "src/keep.txt").unwrap().crc;
    assert_eq!(crc, 0xfb28_6a06, "the CRC-32 of `kept`");
}

#[tokio::test(flavor = "multi_thread")]
async fn inside_a_repository_the_repositorys_list_is_the_archive_and_its_ignored_count_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonical(dir.path()).unwrap();
    put(&root, "tracked.txt", b"t");
    put(&root, "sub/also.txt", b"a");
    put(&root, "dist/built.js", b"b");
    put(&root, "ignored.log", b"i");
    let (entries, ignored) = archive_of(&root, &Repository(vec!["tracked.txt", "sub/also.txt", "dist/built.js"], 1)).await;
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["dist/built.js", "sub/also.txt", "tracked.txt"], "a tracked file under a generated name stays; an ignored one goes");
    assert_eq!(ignored, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_past_the_file_or_byte_cap_is_too_large_to_zip() {
    let dir = tempfile::tempdir().unwrap();
    let root = canonical(dir.path()).unwrap();
    put(&root, "a.txt", b"12345");
    put(&root, "b.txt", b"12345");
    let by_files = scan_folder(&NoRepository, lanes(), &CancellationToken::new(), &root, 1 << 20, 1, None).await.unwrap_err();
    assert!(by_files.message.starts_with("The folder is too large to zip. ("), "{}", by_files.message);
    let by_bytes = scan_folder(&NoRepository, lanes(), &CancellationToken::new(), &root, 9, 10, None).await.unwrap_err();
    assert!(by_bytes.message.starts_with("The folder is too large to zip. ("), "{}", by_bytes.message);
    assert!(scan_folder(&NoRepository, lanes(), &CancellationToken::new(), &root, 10, 2, None).await.is_ok());
}
