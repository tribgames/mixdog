#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use std::path::Path;
use std::process::Command;

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

#[cfg(windows)]
fn peak_working_set() -> u64 {
    use windows_sys::Win32::System::ProcessStatus::GetProcessMemoryInfo;
    use windows_sys::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: a plain query of the current process into an out struct of the declared size.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        assert!(GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0);
        counters.PeakWorkingSetSize as u64
    }
}

#[cfg(target_os = "macos")]
fn peak_working_set() -> u64 {
    // SAFETY: a plain query of the current process into a zeroed out struct; macOS reports the peak in bytes.
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        assert_eq!(libc::getrusage(libc::RUSAGE_SELF, &mut usage), 0);
        usage.ru_maxrss as u64
    }
}

#[cfg(target_os = "linux")]
fn peak_working_set() -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let kb: u64 = status.lines().find_map(|l| l.strip_prefix("VmHWM:")).and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok()).unwrap();
    kb * 1024
}

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
    // Warm the allocator with a first page, then measure the rest.
    let first = transfers.read_range(&["dev"], &opened.transfer_id, 0, RANGE_MAX_BYTES, None).unwrap();
    assert_eq!(first.length, RANGE_MAX_BYTES);
    drop(first);
    let baseline = peak_working_set();
    // The pages after which the peak is taken as settled: the allocator has its buffers by then.
    const SETTLING: u64 = 16;
    let (mut offset, mut pages, mut settled) = (RANGE_MAX_BYTES, 1u64, baseline);
    loop {
        let page = transfers.read_range(&["dev"], &opened.transfer_id, offset, RANGE_MAX_BYTES, None).unwrap();
        offset += page.length;
        pages += 1;
        if pages == SETTLING {
            settled = peak_working_set();
        }
        if page.eof {
            break;
        }
    }
    assert_eq!((offset, pages), (SIZE, SIZE / RANGE_MAX_BYTES));
    let peak = peak_working_set();
    // The peak is the whole process's and counts whole OS pages, so sizes are rounded up to the largest page of the systems this runs on
    // (on Apple silicon's 16 KiB the two pages below are 1196 OS pages, and the unrounded bound was 1194.67 of them).
    const OS_PAGE: u64 = 64 * 1024;
    let whole = |bytes: u64| bytes.div_ceil(OS_PAGE) * OS_PAGE;
    // Independent of the size, as far as the peak shows it: the 496 pages read after the peak settled raise the observed peak by at most
    // one rounding step. Memory kept per range shows here only once it makes the process touch pages it had not.
    let later = peak.saturating_sub(settled);
    assert!(later <= OS_PAGE, "peak working set grew {later} bytes over the {} pages read after it had settled", pages - SETTLING);
    // And small: two pages of bytes plus their base64 text, each buffer whole, and no third page. The peak is the whole process's,
    // so what else it touched while it settled (its allocator's own pages, a stack that grew, code first run) is counted with the
    // buffers and cannot be told from them below the size of one: on the Apple silicon runner it came to 234 838 bytes beside the two
    // pages' 19 573 418 (release gate run 44959677392), where one rounding step had been allowed for it. What the peak
    // decides is whether a further buffer was held, and the smallest is a page of bytes.
    let growth = peak.saturating_sub(baseline);
    let two_pages = 2 * (whole(RANGE_MAX_BYTES) + whole(RANGE_MAX_BYTES * 4 / 3));
    let bound = two_pages + whole(RANGE_MAX_BYTES);
    assert!(growth < bound, "peak working set grew {growth} bytes over {pages} pages: two pages are {two_pages}, a third would make it {bound}");
    eprintln!("streamed {pages} pages of a 2 GiB file; peak working set grew {growth} bytes (two pages: {two_pages}), {later} of them after page {SETTLING}");
}
