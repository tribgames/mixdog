//! The host's record of its application and the sweep of what a dead host left (`src/host/ledger.rs`, `src/sweep.rs`),
//! on the fake platform: the record is written and removed at the right moments, and the sweep ends only an owned,
//! background, identity-matched, windowless application of a host that is gone.

use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_fsio::Unlaned;
use mixdog_office_com::Ownership;
use mixdog_office_com::host::ledger;
use mixdog_office_com::host::ledger::Entry;
use mixdog_office_com::host::ledger::Ledger;
use mixdog_office_com::host::ledger::Tracked;
use mixdog_office_com::platform::FakePlatform;
use mixdog_office_com::platform::FakeWindow;
use mixdog_office_com::platform::Platform;
use mixdog_office_com::sweep::sweep;

const HOST_PID: u32 = 4000;
const HOST_TICKS: i64 = 9_000;

fn scratch() -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!("mixdog-office-com-containment-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)))
}

fn entry(format: &str, app_pid: i32, app_ticks: i64) -> Entry {
    Entry {
        format: format.into(),
        mode: "background".into(),
        ownership: Some(Ownership::Owned),
        owns_application: true,
        app_pid,
        app_start_ticks: app_ticks,
        chart_excel: Vec::new(),
    }
}

fn record_of(data: &Path, pid: u32, ticks: i64, entry: &Entry) {
    Ledger::new(data, pid, ticks).record(&Unlaned, entry).expect("record");
}

fn files(data: &Path) -> Vec<String> {
    let mut names: Vec<String> = match mixdog_fsio::read_dir(&Unlaned, ledger::directory(data)) {
        Ok(dir) => dir.flatten().map(|item| item.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

fn forget(data: &Path) {
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, data);
}

#[test]
fn the_record_is_written_on_every_identity_change_and_removed_after_a_cleanup_that_succeeded() {
    let data = scratch();
    let mut record = Ledger::new(&data, HOST_PID, HOST_TICKS);
    let name = ledger::file_name(HOST_PID, HOST_TICKS);
    assert_eq!(name, "4000-9000.json");
    assert_eq!(record.path(), ledger::directory(&data).join(&name));

    assert!(files(&data).is_empty(), "nothing is written before the host has an application");
    record.record(&Unlaned, &entry("docx", 0, 0)).expect("no process");
    assert!(files(&data).is_empty(), "an entry with no process writes nothing");

    record.record(&Unlaned, &entry("docx", 77, 500)).expect("first identity");
    assert_eq!(files(&data), [name.clone()]);
    let first = mixdog_fsio::read(&Unlaned, record.path()).expect("read");
    assert_eq!(Entry::parse(&first), Some(entry("docx", 77, 500)));

    record.record(&Unlaned, &entry("docx", 78, 600)).expect("the application was replaced");
    let second = mixdog_fsio::read(&Unlaned, record.path()).expect("read");
    assert_eq!(Entry::parse(&second), Some(entry("docx", 78, 600)));
    assert_eq!(files(&data), [name.clone()], "no staging file is left behind");

    record.settle(&Unlaned, false).expect("a failed cleanup");
    assert_eq!(files(&data), [name], "a cleanup that failed leaves the record for the sweep");

    record.settle(&Unlaned, true).expect("a successful cleanup");
    assert!(files(&data).is_empty());
    record.settle(&Unlaned, true).expect("removing twice is not an error");

    record.record(&Unlaned, &entry("docx", 79, 700)).expect("record again");
    record.record(&Unlaned, &entry("docx", 0, 0)).expect("the application is gone");
    assert!(files(&data).is_empty(), "an application that exited takes its record with it");
    forget(&data);
}

#[test]
fn the_chart_excel_pids_are_part_of_the_record() {
    let data = scratch();
    let mut record = Ledger::new(&data, HOST_PID, HOST_TICKS);
    let mut pptx = entry("pptx", 77, 500);
    pptx.chart_excel = vec![Tracked { pid: 90, start_ticks: 5 }, Tracked { pid: 91, start_ticks: 6 }];
    record.record(&Unlaned, &pptx).expect("record");
    let read = Entry::parse(&mixdog_fsio::read(&Unlaned, record.path()).expect("read")).expect("parsed");
    assert_eq!(read.chart_excel, pptx.chart_excel);
    forget(&data);
}

#[test]
fn the_record_of_this_process_is_named_for_its_pid_and_start_time() {
    let platform = FakePlatform::new();
    let pid = std::process::id();
    platform.add_process(i32::try_from(pid).expect("a pid"), "mixdogd", 1234);
    let record = Ledger::for_this_process(Path::new("data"), &platform);
    assert_eq!(record.path().file_name().and_then(|name| name.to_str()), Some(ledger::file_name(pid, 1234).as_str()));
}

#[test]
fn a_sweep_ends_the_owned_background_application_of_a_dead_host_and_removes_its_record() {
    let data = scratch();
    let platform = FakePlatform::new();
    platform.add_process(77, "WINWORD", 500);
    record_of(&data, HOST_PID, HOST_TICKS, &entry("docx", 77, 500));
    let report = sweep(&Unlaned, &platform, &data);
    assert_eq!(report.ended, [77]);
    assert_eq!(report.removed, 1);
    assert!(!platform.process_exists(77));
    assert!(files(&data).is_empty());
    forget(&data);
}

#[test]
fn the_chart_excel_of_a_dead_presentation_host_is_ended_with_its_application() {
    let data = scratch();
    let platform = FakePlatform::new();
    platform.add_process(77, "POWERPNT", 500);
    platform.add_process(90, "EXCEL", 5);
    platform.add_process(91, "EXCEL", 6);
    let mut pptx = entry("pptx", 77, 500);
    pptx.chart_excel = vec![Tracked { pid: 90, start_ticks: 5 }, Tracked { pid: 91, start_ticks: 60 }];
    record_of(&data, HOST_PID, HOST_TICKS, &pptx);
    let report = sweep(&Unlaned, &platform, &data);
    assert_eq!(report.ended, [77, 90]);
    assert!(platform.process_exists(91), "a process that started at another time is not the one the host tracked");
    assert!(files(&data).is_empty());
    forget(&data);
}

#[test]
fn a_live_host_is_never_swept() {
    let data = scratch();
    let platform = FakePlatform::new();
    platform.add_process(i32::try_from(HOST_PID).expect("pid"), "mixdogd", HOST_TICKS);
    platform.add_process(77, "WINWORD", 500);
    record_of(&data, HOST_PID, HOST_TICKS, &entry("docx", 77, 500));
    let report = sweep(&Unlaned, &platform, &data);
    assert_eq!((report.ended.len(), report.removed), (0, 0));
    assert!(platform.process_exists(77));
    assert_eq!(files(&data).len(), 1);
    forget(&data);
}

#[test]
fn a_host_whose_pid_was_reused_is_dead() {
    let data = scratch();
    let platform = FakePlatform::new();
    platform.add_process(i32::try_from(HOST_PID).expect("pid"), "notepad", HOST_TICKS + 1);
    platform.add_process(77, "WINWORD", 500);
    record_of(&data, HOST_PID, HOST_TICKS, &entry("docx", 77, 500));
    assert_eq!(sweep(&Unlaned, &platform, &data).ended, [77]);
    forget(&data);
}

#[test]
fn what_is_visible_attached_or_no_longer_the_recorded_process_is_left_and_the_record_is_removed() {
    let data = scratch();
    let platform = FakePlatform::new();
    // A visible window: the user took the application over.
    platform.add_process(10, "WINWORD", 500);
    platform.add_window(FakeWindow::new(1, 10, "OpusApp", "report.docx - Word"));
    record_of(&data, 4001, 1, &entry("docx", 10, 500));
    // A user's own application the host only attached to.
    platform.add_process(11, "EXCEL", 510);
    let mut attached = entry("xlsx", 11, 510);
    attached.ownership = Some(Ownership::Attached);
    attached.owns_application = false;
    attached.mode = "attach".into();
    record_of(&data, 4002, 1, &attached);
    // A visible-mode session.
    platform.add_process(12, "POWERPNT", 520);
    let mut visible = entry("pptx", 12, 520);
    visible.mode = "visible".into();
    record_of(&data, 4003, 1, &visible);
    // The recorded pid now belongs to another process.
    platform.add_process(13, "WINWORD", 531);
    record_of(&data, 4004, 1, &entry("docx", 13, 530));
    // An application the host owned a document in but did not own itself.
    platform.add_process(14, "WINWORD", 540);
    let mut shared = entry("docx", 14, 540);
    shared.owns_application = false;
    record_of(&data, 4005, 1, &shared);
    // Already gone.
    record_of(&data, 4006, 1, &entry("docx", 15, 550));

    let report = sweep(&Unlaned, &platform, &data);
    assert!(report.ended.is_empty());
    assert_eq!(report.removed, 6);
    for pid in [10, 11, 12, 13, 14] {
        assert!(platform.process_exists(pid), "{pid}");
    }
    assert!(files(&data).is_empty());
    forget(&data);
}

#[test]
fn files_that_are_not_records_stay_and_an_unreadable_record_is_removed_without_ending_anything() {
    let data = scratch();
    let platform = FakePlatform::new();
    platform.add_process(77, "WINWORD", 500);
    let dir = ledger::directory(&data);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("dir");
    for name in ["notes.txt", "4000-9000.tmp", "x-1.json"] {
        mixdog_fsio::write(&Unlaned, dir.join(name), b"{}").expect("write");
    }
    mixdog_fsio::write(&Unlaned, dir.join("4001-1.json"), b"not json").expect("write");
    let report = sweep(&Unlaned, &platform, &data);
    assert_eq!((report.ended.len(), report.removed), (0, 1));
    assert_eq!(files(&data), ["4000-9000.tmp", "notes.txt", "x-1.json"]);
    forget(&data);
}

#[test]
fn a_sweep_with_no_record_directory_does_nothing() {
    let data = scratch();
    let platform = FakePlatform::new();
    assert_eq!(sweep(&Unlaned, &platform, &data), Default::default());
}

#[test]
fn the_ledger_of_a_live_host_is_not_a_target_of_its_own_sweep() {
    // The record this process writes names a host that exists: a sweep run by the same process leaves it.
    let data = scratch();
    let platform = FakePlatform::new();
    let pid = std::process::id();
    platform.add_process(i32::try_from(pid).expect("pid"), "mixdogd", 42);
    platform.add_process(77, "WINWORD", 500);
    Ledger::for_this_process(&data, &platform).record(&Unlaned, &entry("docx", 77, 500)).expect("record");
    assert_eq!(platform.process_start_ticks(i32::try_from(pid).expect("pid")), 42);
    assert!(sweep(&Unlaned, &platform, &data).ended.is_empty());
    assert!(platform.process_exists(77));
    forget(&data);
}
