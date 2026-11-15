//! `authoring/html-source-drift.mjs`. A document authored from HTML keeps that HTML beside it
//! (`<file>.mixdog-source.html`), and `author` with no script rebuilds the file from it. An edit made to the file
//! itself, a `batch` on the session, is not in that HTML, so the next rebuild drops it without a word. The session
//! remembers which HTML it was built from and how many edits have landed since; a batch says so when it changes the
//! file, and the next author says what it replaced.

use mixdog_js::{json_number, number_to_string, to_number_of};
use serde_json::{Value, json};

/// The part of a session that remembers its HTML source (`htmlSource`, `htmlSourceEdits`).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct HtmlSource {
    pub source: Option<String>,
    pub edits: f64,
}

/// `Number(value) || 0`.
fn count_of(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value }
}

impl HtmlSource {
    /// Records the HTML the session's file was just authored from; edits are counted from here. An empty path leaves
    /// the file without a source.
    pub fn mark_authored_from_html(&mut self, source_path: &str) {
        self.source = if source_path.is_empty() { None } else { Some(source_path.to_owned()) };
        self.edits = 0.0;
    }

    /// After a batch: counts the edits that landed (`changeSummary.changed`) and returns the notice for the batch
    /// result, or `None` when the file has no source or nothing changed.
    pub fn note_batch_against_html(&mut self, batch: &Value) -> Option<Value> {
        let path = self.source.as_deref()?;
        let changed = count_of(to_number_of(batch.get("changeSummary").and_then(|summary| summary.get("changed"))));
        if changed == 0.0 {
            return None;
        }
        self.edits = count_of(self.edits) + changed;
        Some(json!({
            "path": path,
            "current": false,
            "editsSinceAuthor": json_number(self.edits),
            "note": format!("These edits changed the file, not {path}. author with no script rebuilds the file from that HTML and drops them: make the same change in the HTML too, or keep finishing this file with batch."),
        }))
    }
}

/// Before a re-author replaces the file: what the previous session had edited past its HTML, or `None`.
pub fn edits_replaced_by_author(previous: Option<&HtmlSource>) -> Option<Value> {
    let count = count_of(previous.map_or(0.0, |session| session.edits));
    if count == 0.0 {
        return None;
    }
    let one = count == 1.0;
    let number = number_to_string(count);
    Some(json!({
        "count": json_number(count),
        "note": format!(
            "{number} edit{} made with batch since the last author {} in the replaced file, not in the HTML; the new file does not carry {}. Check that the HTML now holds the same fixes.",
            if one { "" } else { "s" },
            if one { "was" } else { "were" },
            if one { "it" } else { "them" },
        ),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(changed: Value) -> Value {
        json!({ "changeSummary": { "changed": changed } })
    }

    #[test]
    fn edits_are_counted_from_the_author_and_reported() {
        let mut session = HtmlSource::default();
        assert_eq!(session.note_batch_against_html(&batch(json!(3))), None);
        session.mark_authored_from_html("/work/deck.mixdog-source.html");
        let first = session.note_batch_against_html(&batch(json!(2))).expect("a notice");
        assert_eq!(first["editsSinceAuthor"], json!(2));
        assert_eq!(first["current"], json!(false));
        assert_eq!(session.note_batch_against_html(&batch(json!(1))).expect("a notice")["editsSinceAuthor"], json!(3));
        assert_eq!(session.note_batch_against_html(&batch(json!(0))), None);
        assert_eq!(session.note_batch_against_html(&json!({})), None);
        assert_eq!(session.note_batch_against_html(&Value::Null), None);
        let replaced = edits_replaced_by_author(Some(&session)).expect("replaced");
        assert_eq!(replaced["count"], json!(3));
        assert!(replaced["note"].as_str().expect("note").starts_with("3 edits made with batch since the last author were in"));
    }

    #[test]
    fn one_edit_is_said_in_the_singular_and_marking_again_resets() {
        let mut session = HtmlSource::default();
        session.mark_authored_from_html("a.html");
        session.note_batch_against_html(&batch(json!(1)));
        let note = edits_replaced_by_author(Some(&session)).expect("replaced")["note"].as_str().expect("note").to_owned();
        assert!(note.starts_with("1 edit made with batch since the last author was in"));
        assert!(note.contains("does not carry it."));
        session.mark_authored_from_html("b.html");
        assert_eq!(edits_replaced_by_author(Some(&session)), None);
        assert_eq!(edits_replaced_by_author(None), None);
    }

    #[test]
    fn an_empty_path_clears_the_source() {
        let mut session = HtmlSource::default();
        session.mark_authored_from_html("a.html");
        session.mark_authored_from_html("");
        assert_eq!(session.source, None);
        assert_eq!(session.note_batch_against_html(&batch(json!(2))), None);
    }

    #[test]
    fn a_count_reads_as_a_javascript_number() {
        let mut session = HtmlSource::default();
        session.mark_authored_from_html("a.html");
        assert!(session.note_batch_against_html(&batch(json!("3"))).is_some());
        assert_eq!(session.note_batch_against_html(&batch(json!("x"))), None);
        assert_eq!(session.edits, 3.0);
        session.note_batch_against_html(&batch(json!(-4)));
        assert_eq!(edits_replaced_by_author(Some(&session)).expect("replaced")["count"], json!(-1));
    }
}
