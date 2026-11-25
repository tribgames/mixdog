#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
#![allow(unsafe_code, reason = "the counting allocator wraps the system allocator")]

use std::alloc::GlobalAlloc;
use std::alloc::Layout;
use std::alloc::System;
use std::path::Path;
#[cfg(windows)]
use std::process::Command;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use mixdog_workspace::inplace::open_authorized_ro;
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::pathguard::project_entry_path;
use mixdog_workspace::transfer::RANGE_MAX_BYTES;
use mixdog_workspace::transfer::Transfers;

/// A directory link: a junction on Windows, a symlink elsewhere. `false` when it cannot be made.
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(windows)]
    {
        Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().is_ok_and(|o| o.status.success())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

#[cfg(windows)]
fn remove_link(link: &Path) {
    let _ = std::fs::remove_dir(link);
}

#[cfg(not(windows))]
fn remove_link(link: &Path) {
    let _ = std::fs::remove_file(link);
}

#[test]
fn a_directory_swapped_for_a_link_after_resolving_is_refused_at_open() {
    let dir = tempfile::tempdir().unwrap();
    let base = canonical(dir.path()).unwrap();
    let (root, outside) = (base.join("project"), base.join("outside"));
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("docs/report.txt"), "inside").unwrap();
    std::fs::write(outside.join("report.txt"), "SECRET").unwrap();

    // Resolved while `docs` is a real folder: the path passes the project check.
    let resolved = project_entry_path(&root, "docs/report.txt").unwrap();
    // The race: `docs` becomes a link to the outside folder before the open.
    std::fs::remove_dir_all(root.join("docs")).unwrap();
    if !link_dir(&outside, &root.join("docs")) {
        eprintln!("SKIPPED: this account cannot create directory links");
        return;
    }
    let err = open_authorized_ro(&resolved, &root).err().expect("the swapped path must be refused");
    assert_eq!(err.message, "The file resolves outside the project.");
    // Through the transfer service it never opens either (the check repeats on the real path).
    let transfers = Transfers::default();
    assert!(transfers.begin_project_read("o", &root, "docs/report.txt").is_err());
    assert_eq!(transfers.open_reads(), 0);
    remove_link(&root.join("docs"));
}

/// The heap of this test binary, counted at each allocation. A read's buffers are heap memory, so their peak comes out the same every
/// run, whatever else the process maps and whatever the system's page size: the whole process's peak working set counted both.
struct CountingHeap;

static HEAP_LIVE: AtomicUsize = AtomicUsize::new(0);
static HEAP_PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(size: usize) {
    let live = HEAP_LIVE.fetch_add(size, Ordering::SeqCst) + size;
    HEAP_PEAK.fetch_max(live, Ordering::SeqCst);
}

fn shrank(size: usize) {
    HEAP_LIVE.fetch_sub(size, Ordering::SeqCst);
}

// SAFETY: every request goes to `System` with the caller's layout and its answer is returned unchanged; the counter only observes.
unsafe impl GlobalAlloc for CountingHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract, which `System` shares.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        // SAFETY: the caller upholds `GlobalAlloc::alloc_zeroed`'s contract, which `System` shares.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        shrank(layout.size());
        grew(new_size);
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract, which `System` shares.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        shrank(layout.size());
        // SAFETY: the caller upholds `GlobalAlloc::dealloc`'s contract, which `System` shares.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static HEAP: CountingHeap = CountingHeap;

#[test]
fn a_2_gib_file_streams_with_memory_independent_of_its_size() {
    const SIZE: u64 = 2 * 1024 * 1024 * 1024;
    let dir = tempfile::tempdir().unwrap();
    let root = canonical(dir.path()).unwrap();
    {
        let file = std::fs::File::create(root.join("big.bin")).unwrap();
        file.set_len(SIZE).unwrap();
    }
    let transfers = Transfers::default();
    let opened = transfers.begin_project_read("dev", &root, "big.bin").unwrap();
    assert_eq!(opened.size, SIZE);
    // Warm the reader with a first page, then measure the rest.
    let first = transfers.read_range(&["dev"], &opened.transfer_id, 0, RANGE_MAX_BYTES, None).unwrap();
    assert_eq!(first.length, RANGE_MAX_BYTES);
    drop(first);
    let held = HEAP_LIVE.load(Ordering::SeqCst);
    HEAP_PEAK.store(held, Ordering::SeqCst);
    // The pages after which the peak is taken as settled: every buffer a read makes has been made by then.
    const SETTLING: u64 = 16;
    let (mut offset, mut pages, mut settled) = (RANGE_MAX_BYTES, 1u64, held);
    loop {
        let page = transfers.read_range(&["dev"], &opened.transfer_id, offset, RANGE_MAX_BYTES, None).unwrap();
        offset += page.length;
        pages += 1;
        if pages == SETTLING {
            settled = HEAP_PEAK.load(Ordering::SeqCst);
        }
        if page.eof {
            break;
        }
    }
    assert_eq!((offset, pages), (SIZE, SIZE / RANGE_MAX_BYTES));
    let peak = HEAP_PEAK.load(Ordering::SeqCst);
    // Independent of the size: the pages read after the peak settled keep nothing, so they raise it by nothing.
    assert_eq!(peak, settled, "the heap's peak grew over the {} pages read after it had settled", pages - SETTLING);
    // And small: a read holds one page's bytes and their base64 text at once, never a second page.
    let page_buffers = usize::try_from(RANGE_MAX_BYTES + RANGE_MAX_BYTES.div_ceil(3) * 4).expect("a page's buffers");
    let growth = peak - held;
    assert!(growth < 2 * page_buffers, "the heap grew {growth} bytes over {pages} pages, a second page's buffers ({page_buffers} each)");
    eprintln!("streamed {pages} pages of a 2 GiB file; the heap's peak grew {growth} bytes over what it held (one page's buffers {page_buffers})");
}
