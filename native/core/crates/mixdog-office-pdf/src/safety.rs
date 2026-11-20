//! `pdf/pdf-safety.mjs`: the part of an untrusted PDF worth naming. Actions a viewer would run on open or click (script,
//! a launched program, another file, a link on a scheme that is not the web's) are reported and never followed.

use mixdog_js::{js_trim, slice_utf16};
use mixdog_pdf::write::{PdfDocument, decode_text_string};
use mixdog_pdf::{Dict, Obj};
use serde_json::{Value, json};

/// The action types that run something.
const ACTIVE_ACTIONS: [&str; 6] = ["JavaScript", "Launch", "GoToR", "GoToE", "ImportData", "SubmitForm"];

/// `/^(https?|mailto|tel):/i`.
fn is_web_link(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["http:", "https:", "mailto:", "tel:"].iter().any(|scheme| lower.starts_with(scheme))
}

/// `describeAction(dict)`: what an action does when it is worth naming, `None` for a harmless one.
fn describe_action(document: &PdfDocument, action: &Dict) -> Option<String> {
    let kind = match action.get_raw("S") {
        Some(Obj::Name(name)) => name.to_string(),
        _ => return None,
    };
    if ACTIVE_ACTIONS.contains(&kind.as_str()) {
        return Some(format!("a {kind} action"));
    }
    if kind != "URI" {
        return None;
    }
    let store = document.store();
    let text = match action.get_raw("URI").and_then(|uri| store.resolve(uri)) {
        Some(Obj::Str(bytes)) => js_trim(&decode_text_string(bytes)).to_owned(),
        _ => String::new(),
    };
    if is_web_link(&text) {
        return None;
    }
    let shown = slice_utf16(&text, 80);
    Some(format!("a link to {}", if shown.is_empty() { "an empty target" } else { &shown }))
}

fn issue(path: &str, what: &str) -> Value {
    json!({
        "severity": "warning",
        "code": "active_content",
        "path": path,
        "message": format!("{what}; treat the file as untrusted and do not open it in a viewer that honours actions."),
    })
}

/// `activeContentIssues(document)`: the open action, the additional-actions entry, document-level script, and each
/// annotation whose action runs something or leaves the web. A value that is not a dictionary where one is expected
/// names no action (an `OpenAction` that is a destination array is the usual case: it opens a page, it runs nothing).
pub fn active_content_issues(document: &PdfDocument) -> Vec<Value> {
    let mut issues = Vec::new();
    let store = document.store();
    let Some(catalog) = document.catalog_ref().and_then(|root| store.dict(root)) else {
        return issues;
    };
    if let Some(Obj::Dict(opening)) = store.lookup(catalog, "OpenAction")
        && let Some(kind) = describe_action(document, opening)
    {
        issues.push(issue("/metadata", &format!("The document runs {kind} when opened")));
    }
    if catalog.has("AA") {
        issues.push(issue("/metadata", "The document declares additional actions (AA) that run on events"));
    }
    if let Some(Obj::Dict(names)) = store.lookup(catalog, "Names")
        && names.has("JavaScript")
    {
        issues.push(issue("/metadata", "The document carries document-level JavaScript"));
    }
    for (position, page) in document.pages().into_iter().enumerate() {
        let number = position + 1;
        for entry in document.page_annotations(page) {
            let Some(Obj::Dict(annotation)) = store.resolve(&entry) else {
                continue;
            };
            let Some(Obj::Dict(action)) = store.lookup(annotation, "A") else {
                continue;
            };
            if let Some(kind) = describe_action(document, action) {
                issues.push(issue(&format!("/page[{number}]"), &format!("An annotation on page {number} triggers {kind}")));
            }
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_pdf::Ref;

    use super::*;

    fn dict(entries: Vec<(&str, Obj)>) -> Obj {
        let mut dict = Dict::new();
        for (key, value) in entries {
            dict.set(key, value);
        }
        Obj::Dict(Arc::new(dict))
    }

    fn document_with(catalog_entries: Vec<(&str, Obj)>, annotation_actions: Vec<Obj>) -> PdfDocument {
        let mut document = PdfDocument::create_at(0);
        let page = document.add_page(100.0, 100.0).expect("page");
        let mut annotations = Vec::new();
        for action in annotation_actions {
            let annotation = document.store_mut().register(dict(vec![("Subtype", Obj::name("Link")), ("A", action)]));
            annotations.push(Obj::Ref(annotation));
        }
        if !annotations.is_empty() {
            document.store_mut().modify_dict(page, |page| page.set("Annots", Obj::Array(Arc::new(annotations))));
        }
        let root: Ref = document.catalog_ref().expect("catalog");
        document.store_mut().modify_dict(root, |catalog| {
            for (key, value) in catalog_entries {
                catalog.set(key, value);
            }
        });
        document
    }

    fn uri(target: &str) -> Obj {
        dict(vec![("S", Obj::name("URI")), ("URI", Obj::string(target.as_bytes()))])
    }

    fn messages(document: &PdfDocument) -> Vec<String> {
        active_content_issues(document)
            .iter()
            .map(|issue| {
                let message = issue["message"].as_str().expect("message");
                format!("{} {}", issue["path"].as_str().expect("path"), message.split(';').next().expect("head"))
            })
            .collect()
    }

    #[test]
    fn a_plain_document_reports_nothing() {
        assert!(active_content_issues(&document_with(vec![], vec![])).is_empty());
    }

    #[test]
    fn the_open_action_the_additional_actions_and_document_script_are_named() {
        let document = document_with(
            vec![("OpenAction", dict(vec![("S", Obj::name("JavaScript"))])), ("AA", dict(vec![])), ("Names", dict(vec![("JavaScript", dict(vec![]))]))],
            vec![],
        );
        assert_eq!(
            messages(&document),
            [
                "/metadata The document runs a JavaScript action when opened",
                "/metadata The document declares additional actions (AA) that run on events",
                "/metadata The document carries document-level JavaScript",
            ]
        );
    }

    #[test]
    fn a_destination_array_as_the_open_action_runs_nothing() {
        let document = document_with(vec![("OpenAction", Obj::Array(Arc::new(vec![Obj::Num(0.0), Obj::name("Fit")])))], vec![]);
        assert!(active_content_issues(&document).is_empty());
    }

    #[test]
    fn annotation_actions_run_or_leave_the_web_are_named_per_page() {
        let document = document_with(
            vec![],
            vec![
                dict(vec![("S", Obj::name("Launch"))]),
                dict(vec![("S", Obj::name("GoToR"))]),
                dict(vec![("S", Obj::name("GoTo"))]),
                uri("https://example.test/a"),
                uri("  MAILTO:a@b.test"),
                uri("tel:+1"),
                uri("file:///etc/passwd"),
                uri("  "),
            ],
        );
        assert_eq!(
            messages(&document),
            [
                "/page[1] An annotation on page 1 triggers a Launch action",
                "/page[1] An annotation on page 1 triggers a GoToR action",
                "/page[1] An annotation on page 1 triggers a link to file:///etc/passwd",
                "/page[1] An annotation on page 1 triggers a link to an empty target",
            ]
        );
    }

    #[test]
    fn a_long_target_is_cut_to_eighty_characters() {
        let long = format!("ftp://{}", "a".repeat(200));
        let issues = active_content_issues(&document_with(vec![], vec![uri(&long)]));
        let message = issues[0]["message"].as_str().expect("message");
        assert!(message.contains(&format!("a link to {}; treat", &long[..80])));
    }
}
