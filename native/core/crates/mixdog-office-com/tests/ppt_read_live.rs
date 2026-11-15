//! The PowerPoint reader against real Microsoft PowerPoint. The test is `#[ignore]`d: it starts PowerPoint, so it runs only on
//! request (`cargo test -p mixdog-office-com --test ppt_read_live -- --ignored`) on a Windows machine with Microsoft PowerPoint
//! and `MIXDOG_TEST_LIVE_OFFICE=1`. Without that variable a test that was asked for ends at once and says it did nothing.
//!
//! A deck with text, a table, notes, a comment and a second slide is made through the dispatch layer, saved and closed. The
//! reader then reads and inspects the same file in this process: the snapshot is JSON and holds what was written. The recorded
//! scenarios of `tests/scenarios/ppt-read.json` (decks of every shape kind, charts of every kind, backgrounds, selections) run
//! through the transport in `tests/switch_powerpoint_live.rs` and are replayed by `tests/ppt_read.rs`.
#![cfg(windows)]

use std::path::Path;
use std::path::PathBuf;
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

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn the_reader_reads_the_deck_the_dispatch_layer_made() {
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

    let snapshot_text = to_json(&snapshot, 20);
    let _: Json = serde_json::from_str(&snapshot_text).expect("the snapshot is JSON");
    for expected in ["Slide 1: 12 and 34", "Slide 2: 12 and 34", "Cell", "A comment", "Source: Model!B2"] {
        assert!(snapshot_text.contains(expected), "the snapshot lacks {expected}: {snapshot_text}");
    }
    let issues_text = to_json(&issues, 20);
    let _: Json = serde_json::from_str(&issues_text).expect("the issues are JSON");
    println!("snapshot {snapshot_time:?}, issues {issues_time:?}");
    let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
}
