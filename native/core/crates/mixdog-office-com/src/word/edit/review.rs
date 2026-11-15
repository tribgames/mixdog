//! The review operations of `Invoke-WordOperation`: comments (`add_comment`, `add_comment_reply`, `add_provenance`,
//! `delete_comment`, `set_comment_resolved`) and tracked changes (`track_changes`, `normalize_runs`, `resolve_revisions`,
//! `resolve_revision`), with `Provenance-Text`.

use super::Com;
use super::Value;
use super::cast_int;
use super::lower;
use super::ordered;
use super::prop;
use super::same;
use super::text_of;
use super::truthy;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;

/// `[int]$op.<key>`, refused with the script's text unless it names one of the document's `collection` (1 to its count).
fn index_in(document: &Obj, op: &Value, key: &str, collection: &str, refusal: &str) -> Result<i32> {
    let index = cast_int(&prop(op, key))?;
    if index < 1 || index > super::count_of_collection(&document.get(collection)?)? {
        return Err(Error::host(format!("{refusal}: {index}")));
    }
    Ok(index)
}

/// `add_comment`: Word's find crosses runs, tabs and fields, so the comment always spans the phrase itself.
pub(super) fn add_comment(document: &Obj, op: &Value) -> Result<Value> {
    let range = document.get("Content")?.member("Duplicate")?;
    let found = range.member("Find")?.call_member("Execute", &[Com::from(text_of(&prop(op, "find")))])?;
    if !super::truth(&found) {
        return Err(Error::host(format!("Comment target not found: {}", text_of(&prop(op, "find")))));
    }
    document.get("Comments")?.call_member("Add", &[range, Com::from(text_of(&prop(op, "text")))])?;
    Ok(ordered(vec![("op", Value::string("add_comment")), ("changed", Value::Bool(true)), ("anchor", Value::string("phrase"))]))
}

/// `add_comment_reply`.
pub(super) fn add_comment_reply(document: &Obj, op: &Value) -> Result<Value> {
    let index = index_in(document, op, "comment", "Comments", "Comment index out of range")?;
    let comment = super::item(&document.get("Comments")?, index)?;
    let reply = (|| -> Result<()> {
        let range = comment.member("Scope")?.member("Duplicate")?;
        comment.member("Replies")?.call_member("Add", &[range, Com::from(text_of(&prop(op, "text")))])?;
        Ok(())
    })();
    if reply.is_err() {
        return Err(Error::host("This Word version does not expose threaded comment replies through COM"));
    }
    Ok(ordered(vec![("op", Value::string("add_comment_reply")), ("changed", Value::Bool(true)), ("comment", Value::Int(index))]))
}

/// `Provenance-Text`: the citation is composed by the runtime (provenanceCitation) and written as handed, so both backends
/// cite a source alike.
fn provenance_text(op: &Value) -> Result<String> {
    let text = text_of(&prop(op, "citation"));
    if text.trim().is_empty() {
        return Err(Error::host("add_provenance requires source with a document or label"));
    }
    Ok(text)
}

/// `add_provenance`: the citation as a comment on a paragraph's text.
pub(super) fn add_provenance(document: &Obj, op: &Value) -> Result<Value> {
    let index = index_in(document, op, "paragraph", "Paragraphs", "Provenance paragraph index out of range")?;
    let range = super::item(&document.get("Paragraphs")?, index)?.member("Range")?.member("Duplicate")?;
    if super::int(&range.member("End")?)? > super::int(&range.member("Start")?)? {
        let end = super::int(&range.member("End")?)? - 1;
        range.set_member("End", Com::I4(end))?;
    }
    let text = provenance_text(op)?;
    document.get("Comments")?.call_member("Add", &[range, Com::from(text.as_str())])?;
    Ok(ordered(vec![
        ("op", Value::string("add_provenance")),
        ("changed", Value::Bool(true)),
        ("target", Value::String(format!("/body/p[{index}]"))),
        ("citation", Value::String(text)),
    ]))
}

/// `delete_comment`: recursively when the comment has replies.
pub(super) fn delete_comment(document: &Obj, op: &Value) -> Result<Value> {
    let index = index_in(document, op, "comment", "Comments", "Comment index out of range")?;
    let comment = super::item(&document.get("Comments")?, index)?;
    if super::count_of_collection(&comment.member("Replies")?)? > 0 {
        comment.call_member("DeleteRecursively", &[])?;
    } else {
        comment.call_member("Delete", &[])?;
    }
    Ok(ordered(vec![("op", Value::string("delete_comment")), ("changed", Value::Bool(true)), ("comment", Value::Int(index))]))
}

/// `set_comment_resolved`.
pub(super) fn set_comment_resolved(document: &Obj, op: &Value) -> Result<Value> {
    let index = index_in(document, op, "comment", "Comments", "Comment index out of range")?;
    let comment = super::item(&document.get("Comments")?, index)?;
    let resolved = truthy(&prop(op, "resolved"));
    if comment.set_member("Done", Com::Bool(resolved)).is_err() {
        return Err(Error::host("This Word version does not expose resolved comment state through COM"));
    }
    Ok(ordered(vec![
        ("op", Value::string("set_comment_resolved")),
        ("changed", Value::Bool(true)),
        ("comment", Value::Int(index)),
        ("resolved", Value::Bool(resolved)),
    ]))
}

/// `track_changes`.
pub(super) fn track_changes(document: &Obj, op: &Value) -> Result<Value> {
    document.put("TrackRevisions", Com::Bool(truthy(&prop(op, "enabled"))))?;
    Ok(ordered(vec![
        ("op", Value::string("track_changes")),
        ("changed", Value::Bool(true)),
        ("enabled", Value::Bool(super::truth(&document.get("TrackRevisions")?))),
    ]))
}

/// `normalize_runs`: Word's object model reads text across run boundaries, so the portable run merge has nothing to do here.
pub(super) fn normalize_runs() -> Value {
    ordered(vec![
        ("op", Value::string("normalize_runs")),
        ("changed", Value::Bool(false)),
        ("merged", Value::Int(0)),
        ("note", Value::string("Word searches text across runs itself; nothing to normalize in a Microsoft Office session.")),
    ])
}

fn revisions_count(document: &Obj) -> Result<i32> {
    super::count_of_collection(&document.get("Revisions")?)
}

/// Rejects or accepts one revision.
fn settle(revision: &Com, reject: bool) -> Result<()> {
    revision.call_member(if reject { "Reject" } else { "Accept" }, &[]).map(|_| ())
}

/// `resolve_revisions`: everything at once, or one reviewer's, each revision on its own, from the end.
pub(super) fn resolve_revisions(document: &Obj, op: &Value) -> Result<Value> {
    let resolution = lower(&text_of(&prop(op, "resolution")));
    let reject = same(&resolution, "reject");
    let settled = if reject { "reject" } else { "accept" };
    let author = text_of(&prop(op, "author"));
    if !author.is_empty() {
        // Word settles all revisions or one, never one reviewer's, so each of the reviewer's revisions is settled on its own.
        // Walking from the last keeps the earlier indexes valid while the collection shrinks.
        let mut count = 0;
        let mut position = revisions_count(document)?;
        while position >= 1 {
            if position <= revisions_count(document)? {
                let revision = super::item(&document.get("Revisions")?, position)?;
                if same(&super::string(&revision.member("Author")?), &author) {
                    settle(&revision, reject)?;
                    count += 1;
                }
            }
            position -= 1;
        }
        let mut pairs = vec![
            ("op", Value::string("resolve_revisions")),
            ("changed", Value::Bool(count > 0)),
            ("resolved", Value::Int(count)),
            ("author", Value::String(author.clone())),
            ("resolution", Value::string(settled)),
        ];
        if count == 0 {
            // A label matching nobody is most often misspelt; the names present let the caller correct it.
            let mut reviewers: Vec<String> = Vec::new();
            let mut position = 1;
            while position <= revisions_count(document)? {
                let name = super::string(&super::item(&document.get("Revisions")?, position)?.member("Author")?);
                if !reviewers.iter().any(|known| same(known, &name)) {
                    reviewers.push(name);
                }
                position += 1;
            }
            let quoted: Vec<String> = reviewers.iter().map(|name| format!("\"{name}\"")).collect();
            let note = if reviewers.is_empty() {
                format!("No revision by \"{author}\"; the document carries no tracked change.")
            } else {
                format!("No revision by \"{author}\"; the tracked changes are by {}.", quoted.join(", "))
            };
            pairs.push(("note", Value::String(note)));
        }
        return Ok(ordered(pairs));
    }
    let count = document.get("Revisions")?.member("Count")?;
    document.call(if reject { "RejectAllRevisions" } else { "AcceptAllRevisions" }, &[])?;
    Ok(ordered(vec![
        ("op", Value::string("resolve_revisions")),
        ("changed", Value::Bool(super::int(&count)? > 0)),
        ("resolved", super::ps_value(&count, "System.Object")?),
        ("resolution", Value::string(settled)),
    ]))
}

/// `resolve_revision`.
pub(super) fn resolve_revision(document: &Obj, op: &Value) -> Result<Value> {
    let index = index_in(document, op, "revision", "Revisions", "Revision index out of range")?;
    let reject = same(&lower(&text_of(&prop(op, "resolution"))), "reject");
    let revision = super::item(&document.get("Revisions")?, index)?;
    settle(&revision, reject)?;
    Ok(ordered(vec![
        ("op", Value::string("resolve_revision")),
        ("changed", Value::Bool(true)),
        ("revision", Value::Int(index)),
        ("resolution", Value::string(if reject { "reject" } else { "accept" })),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ps::payload::parse_payload;

    #[test]
    fn a_citation_must_say_something() {
        let blank = parse_payload(r#"{"citation":"  "}"#).unwrap();
        assert_eq!(provenance_text(&blank).unwrap_err().message(), "add_provenance requires source with a document or label");
        let said = parse_payload(r#"{"citation":"Source: ledger.xlsx#Raw!B8"}"#).unwrap();
        assert_eq!(provenance_text(&said).unwrap(), "Source: ledger.xlsx#Raw!B8");
    }

    #[test]
    fn a_note_that_names_nothing_to_settle_has_fixed_text() {
        let value = normalize_runs();
        assert_eq!(crate::ps::json::to_json(&value, 4), "{\"op\":\"normalize_runs\",\"changed\":false,\"merged\":0,\"note\":\"Word searches text across runs itself; nothing to normalize in a Microsoft Office session.\"}");
    }
}
