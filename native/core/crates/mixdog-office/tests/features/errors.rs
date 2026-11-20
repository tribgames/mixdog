//! What the Office tool says when a call cannot be served: the refusal is one `Error:` text that names what to do instead.

use serde_json::json;

use crate::support::Harness;

fn refused(office: &Harness, args: serde_json::Value) -> String {
    let text = office.text_of(args, false);
    assert!(text.starts_with("Error: "), "expected a refusal, got {text}");
    text
}

#[test]
fn a_session_that_does_not_exist_or_is_closed_is_named() {
    let office = Harness::new();
    assert_eq!(refused(&office, json!({ "action": "snapshot", "session": "office_missing" })), "Error: Unknown or closed Office Use session: office_missing");
    let session = office.call(json!({ "action": "create", "path": "t.csv" }))["session"].as_str().expect("session").to_owned();
    assert_eq!(office.call(json!({ "action": "close", "session": session }))["closed"], true);
    assert_eq!(refused(&office, json!({ "action": "close", "session": session })), format!("Error: Unknown or closed Office Use session: {session}"));
}

#[test]
fn calls_missing_what_they_need_say_what_to_pass() {
    let office = Harness::new();
    assert_eq!(refused(&office, json!({ "action": "create" })), "Error: create requires path or output");
    assert_eq!(
        refused(&office, json!({ "action": "secure", "path": "a.csv", "output": "b.pdf", "security": "encrypt" })),
        "Error: secure supports PDF files only"
    );
    assert_eq!(
        refused(&office, json!({ "action": "attach", "path": "x.csv", "finalize": true })),
        "Error: attach does not support finalize:true; attach first, then use batch with finalize:true when closing the document is intended"
    );
    assert!(
        refused(&office, json!({ "action": "recover" })).starts_with("Error: recover finishes an interrupted Office transaction and needs its transaction id.")
    );
}

#[test]
fn a_document_that_is_not_there_and_an_output_that_is_a_folder_are_named() {
    let office = Harness::new();
    let missing = refused(&office, json!({ "action": "open", "path": "missing.csv" }));
    assert!(missing.starts_with("Error: Office document not found: ") && missing.replace('\\', "/").ends_with("/docs/missing.csv"), "{missing}");
    office.put("report.csv", "a,b\n");
    let folder = office.docs.join("out");
    std::fs::create_dir_all(&folder).expect("folder");
    let text = refused(&office, json!({ "action": "open", "path": "report.csv", "output": folder.display().to_string(), "mode": "portable" }));
    let shown = folder.display().to_string();
    let expected_head = format!("Error: Office output is the file to write, not a folder: {shown} is a directory. Pass a file path such as ");
    assert!(text.starts_with(&expected_head) && text.ends_with("report.mixdog-edit.csv."), "{text}");
}

#[test]
fn a_deck_is_not_created_from_a_script() {
    let office = Harness::new();
    let text = refused(&office, json!({ "action": "create", "path": "d.pptx", "script": "x" }));
    assert_eq!(text, "Error: PPTX create takes no script. A deck written from a script uses action:'author' with script.");
}

#[test]
fn no_transaction_is_pending_in_a_fresh_data_folder() {
    let office = Harness::new();
    assert_eq!(office.call(json!({ "action": "transactions" })), json!({ "ok": true, "transactions": [] }));
}

#[test]
fn authoring_without_its_source_refuses_and_points_at_where_to_read_the_contract() {
    let office = Harness::new();
    let tail = |skill: &str, contract: &str| {
        format!(" Load the `{skill}` Skill first (Skill name:\"{skill}\"): it carries the {contract}, then call author again with path and script.")
    };
    let from_source = |noun: &str, path: &str| {
        let target = office.docs.join(path).display().to_string().replace('\\', "/");
        format!("Error: author requires script: an HTML document for {noun} (without one it re-authors from {target}.mixdog-source.html, and none is there).")
    };
    let cases = [
        ("doc.docx", from_source("a Word file", "doc.docx"), tail("docx", "HTML route (@page sheet, what becomes a paragraph, a table, a box)")),
        (
            "book.xlsx",
            from_source("an Excel workbook", "book.xlsx"),
            tail("xlsx", "HTML route (one <section data-sheet> per worksheet, data-formula, data-chart)"),
        ),
    ];
    for (path, head, rest) in cases {
        let text = refused(&office, json!({ "action": "author", "path": path })).replace('\\', "/");
        assert_eq!(text, format!("{head}{rest}"));
        assert!(!office.docs.join(path).exists(), "{path}: a refused author call writes nothing");
    }
    assert_eq!(
        refused(&office, json!({ "action": "author", "path": "deck.pptx" })),
        "Error: author requires script: HTML slides or a pptxgenjs script (without one it re-authors from <deck>.pptx.mixdog-source.html, and none is there). Load the `pptx` Skill first (Skill name:\"pptx\"): it carries the authoring workflow, the HTML contract, the composition grammar, and the device kit, then call author again with path and script."
    );
    assert_eq!(
        refused(&office, json!({ "action": "author", "path": "out.pdf" })),
        "Error: author requires script: an HTML document for a PDF (without one it re-authors from <file>.pdf.mixdog-source.html, and none is there). Load the `pdf` Skill first (Skill name:\"pdf\"): it carries the page contract (@page size and margins, page breaks, fonts), then call author again with path and script."
    );
    for path in ["deck.pptx", "out.pdf"] {
        assert!(!office.docs.join(path).exists(), "{path}: a refused author call writes nothing");
    }
}
