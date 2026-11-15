//! The PowerPoint reader against real Microsoft PowerPoint. The test is `#[ignore]`d: it starts PowerPoint, so it runs only on
//! request (`cargo test -p mixdog-office-com --test ppt_read_live -- --ignored`) on a Windows machine with Microsoft PowerPoint
//! and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! A deck with text, a table, notes, a comment and a second slide is made through the dispatch layer, saved and closed. The
//! unchanged PowerShell host (`assets/office-com-host.ps1`) then reads it with a one-shot `snapshot` and `issues` request, and
//! the reader reads and inspects the same file in this process: the answers must be equal and the reader must not take longer
//! than the PowerShell host did. The recorded scenarios of `recorder/scenarios/ppt-read.json` (decks of every shape kind, charts
//! of every kind, backgrounds, selections) are read the same way once their recordings exist; they are replayed by
//! `tests/ppt_read.rs` meanwhile.
#![cfg(windows)]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

use mixdog_fsio::Unlaned;
use mixdog_office_com::com::Obj;
use mixdog_office_com::com::Value as Com;
use mixdog_office_com::com::live::Sta;
use mixdog_office_com::format::FormatReader;
use mixdog_office_com::office::Env;
use mixdog_office_com::office::LiveApplications;
use mixdog_office_com::office::close_office_document;
use mixdog_office_com::office::new_hidden_application;
use mixdog_office_com::office::open_background_document;
use mixdog_office_com::platform::WindowsPlatform;
use mixdog_office_com::ppt::Reader;
use mixdog_office_com::ps::json::to_json;
use mixdog_office_com::ps::payload;
use serde_json::Value as Json;
use serde_json::json;

fn live_office() -> bool {
    std::env::var("MIXDOG_TEST_LIVE_OFFICE").as_deref() == Ok("1")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mixdog-office-ppt-read-live-{}-{name}", std::process::id()));
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
    mixdog_fsio::create_dir_all(&Unlaned, &dir).expect("a scratch directory");
    dir
}

/// A deck of two slides written through the dispatch layer and saved at `path`.
fn make_deck(env: &Env<'_>, path: &Path) {
    let app = new_hidden_application(env, "pptx", "PowerPoint.Application").expect("PowerPoint of this test's own");
    let deck = app.get("Presentations").expect("Presentations").call_member("Add", &[Com::I4(0)]).expect("Add").into_obj().expect("a deck");
    let layout = deck.get("SlideMaster").and_then(|master| master.member("CustomLayouts")).and_then(|layouts| layouts.call_member("Item", &[Com::I4(7)])).expect("a layout");
    for at in 1..=2 {
        let slide = deck.get("Slides").and_then(|slides| slides.call_member("AddSlide", &[Com::I4(at), layout.clone()])).expect("a slide");
        let shape = slide
            .member("Shapes")
            .and_then(|shapes| shapes.call_member("AddTextbox", &[Com::I4(1), Com::R4(48.0), Com::R4(48.0), Com::R4(400.0), Com::R4(60.0)]))
            .expect("a text box");
        shape.member("TextFrame").and_then(|frame| frame.member("TextRange")).and_then(|range| range.set_member("Text", Com::from(format!("Slide {at}: 12 and 34")))).expect("text");
        if at == 1 {
            let table = slide.member("Shapes").and_then(|shapes| shapes.call_member("AddTable", &[Com::I4(2), Com::I4(2), Com::R4(48.0), Com::R4(160.0), Com::R4(300.0), Com::R4(80.0)])).expect("a table");
            table.member("Table").and_then(|table| table.call_member("Cell", &[Com::I4(1), Com::I4(1)])).and_then(|cell| cell.member("Shape")).and_then(|shape| shape.member("TextFrame")).and_then(|frame| frame.member("TextRange")).and_then(|range| range.set_member("Text", Com::from("Cell"))).expect("a cell");
            slide.member("Comments").and_then(|comments| comments.call_member("Add", &[Com::R4(20.0), Com::R4(20.0), Com::from("Me"), Com::from("M"), Com::from("A comment")])).expect("a comment");
            slide
                .member("NotesPage")
                .and_then(|notes| notes.member("Shapes"))
                .and_then(|shapes| shapes.member("Placeholders"))
                .and_then(|placeholders| placeholders.call_member("Item", &[Com::I4(2)]))
                .and_then(|shape| shape.member("TextFrame"))
                .and_then(|frame| frame.member("TextRange"))
                .and_then(|range| range.set_member("Text", Com::from("Source: Model!B2")))
                .expect("notes");
        }
    }
    deck.call("SaveAs", &[Com::from(path.to_string_lossy().into_owned())]).expect("SaveAs");
    deck.call("Close", &[]).expect("Close");
    app.call("Quit", &[]).expect("Quit");
}

/// The unchanged PowerShell host on one one-shot request: its `value` and the wall time of the whole process.
fn powershell_value(request: &Json) -> (Json, Duration) {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets").join("office-com-host.ps1");
    let powershell = Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let started = Instant::now();
    let mut child = Command::new(powershell)
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Windows PowerShell");
    child.stdin.take().expect("stdin").write_all(request.to_string().as_bytes()).expect("the request");
    let output = child.wait_with_output().expect("the host exits");
    let elapsed = started.elapsed();
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let answer: Json = serde_json::from_str(text.lines().last().expect("an answer line")).expect("the answer is JSON");
    (answer["value"].clone(), elapsed)
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_reader_answers_what_the_powershell_host_answers_and_is_not_slower() {
    if !live_office() {
        eprintln!("MIXDOG_TEST_LIVE_OFFICE is not 1: nothing was run");
        return;
    }
    let _apartment = Sta::enter().expect("an apartment");
    let platform = WindowsPlatform::new().expect("the Windows layer");
    let env = Env { platform: &platform, applications: &LiveApplications };
    let dir = scratch("deck");
    let path = dir.join("deck.pptx");
    make_deck(&env, &path);
    let path_text = path.to_string_lossy().into_owned();

    let (shell_snapshot, shell_snapshot_time) = powershell_value(&json!({"action": "snapshot", "format": "pptx", "path": path_text}));
    let (shell_issues, shell_issues_time) = powershell_value(&json!({"action": "issues", "format": "pptx", "path": path_text}));

    let app = new_hidden_application(&env, "pptx", "PowerPoint.Application").expect("PowerPoint of this test's own");
    let deck: Obj = open_background_document(&app, "pptx", &path_text).expect("the deck opens");
    let empty = payload::parse_payload("{}").expect("a request");
    let started = Instant::now();
    let snapshot = Reader.snapshot(&env, &deck, &empty).expect("the snapshot");
    let snapshot_time = started.elapsed();
    let started = Instant::now();
    let issues = Reader.issues(&env, &deck, &empty).expect("the issues");
    let issues_time = started.elapsed();
    close_office_document(&deck, "pptx").expect("the deck closes");
    app.call("Quit", &[]).expect("PowerPoint quits");

    let ours: Json = serde_json::from_str(&to_json(&snapshot, 20)).expect("the snapshot is JSON");
    assert_eq!(ours, shell_snapshot, "the snapshot");
    let ours: Json = serde_json::from_str(&to_json(&issues, 20)).expect("the issues are JSON");
    assert_eq!(ours, shell_issues["issues"], "the issues");
    assert!(snapshot_time <= shell_snapshot_time, "the snapshot took {snapshot_time:?}, the PowerShell host {shell_snapshot_time:?}");
    assert!(issues_time <= shell_issues_time, "the issues took {issues_time:?}, the PowerShell host {shell_issues_time:?}");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
