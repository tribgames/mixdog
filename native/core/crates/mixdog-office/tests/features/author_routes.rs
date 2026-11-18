//! The author action through `Engine::execute`, with the real host (`SystemAuthor`) behind it and no browser to lease.
//!
//! What only a real browser exercises is the layout of the HTML: `SystemAuthor::run_pptx_html`, `run_docx_html`,
//! `run_xlsx_html` and `print_pdf` hand the document to the shared render browser (`HtmlBrowser::launch` leases it, and
//! everything they measure and write follows). A script of pptxgenjs runs on the install's script interpreter, a process of its
//! own. Everything up to those calls is the action's own work and is tested here: the target and overwrite checks, the staging
//! folder, the failure answer of a browser that cannot be leased, and that a failed run leaves the existing document and the
//! folder as they were. The routes after a successful layout (landing, session, gates, receipts) are tested in `author.rs`
//! against a host that writes the staged document itself.

use mixdog_office::author::pptx_session::STAGING_PREFIX;
use serde_json::json;

use crate::support::Harness;

const ROUTES: [(&str, &str); 4] = [
    ("deck.pptx", "<section class=\"slide\"><h1>Retention rose</h1></section>"),
    ("doc.docx", "<!doctype html><p>Word body</p>"),
    ("book.xlsx", "<section data-sheet=\"Data\"><table><tr><td>1</td></tr></table></section>"),
    ("report.pdf", "<!doctype html><h1>Report</h1>"),
];

fn entries(office: &Harness) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(&office.docs).expect("the folder").map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn a_browser_that_cannot_be_leased_fails_each_html_route_by_name_and_leaves_no_document_or_staging_folder() {
    let office = Harness::new();
    for (path, html) in ROUTES {
        let text = office.text_of(json!({ "action": "author", "path": path, "script": html, "render": false }), false);
        assert!(text.contains("no browser here"), "{path}: the answer names why nothing was written: {text}");
        assert!(!office.docs.join(path).exists(), "{path}: no document was written");
        assert!(!entries(&office).iter().any(|name| name.starts_with(STAGING_PREFIX)), "{path}: the staging folder was removed: {:?}", entries(&office));
    }
}

#[test]
fn a_failed_run_leaves_the_document_that_was_there() {
    let office = Harness::new();
    for (path, html) in ROUTES {
        office.put(path, "existing bytes");
        let text = office.text_of(json!({ "action": "author", "path": path, "script": html, "overwrite": true, "render": false }), false);
        assert!(text.contains("no browser here"), "{path}: {text}");
        assert_eq!(office.read(path), "existing bytes", "{path}");
    }
    assert!(!entries(&office).iter().any(|name| name.starts_with(STAGING_PREFIX)), "no staging folder was left: {:?}", entries(&office));
}

#[test]
fn an_existing_deck_or_pdf_is_not_replaced_without_overwrite_and_nothing_runs() {
    let office = Harness::new();
    for (path, html) in [ROUTES[0], ROUTES[3]] {
        office.put(path, "existing bytes");
        let text = office.text_of(json!({ "action": "author", "path": path, "script": html }), false).replace('\\', "/");
        assert!(text.starts_with("Error: author target already exists: ") && text.ends_with(&format!("/{path}; pass overwrite:true to replace it")), "{path}: {text}");
        assert!(!text.contains("no browser here"), "{path}: the check comes before the browser is asked for");
        assert_eq!(office.read(path), "existing bytes");
    }
}