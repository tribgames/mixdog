//! The real [`OutlineSource`]: spans come from `mixdog_graph::outline::outline_files`, the same
//! walk `code_graph mode:"symbols"` prints, so function lengths match what the graph reports.
//!
//! Each item and each of its members becomes one symbol `{kind, name, startLine, endLine}`; the
//! kind is the outline `symbolType` in the unified vocabulary (lower camel case, `typeParameter`
//! folded into `type`), and the lines are the zero-based range plus one. Import rows are not
//! symbols and are left out. The records are read through their `Serialize` form, which is the
//! `--outline` wire shape and the only part of the report that is public.

use std::path::Path;

use async_trait::async_trait;
use mixdog_graph::outline::{FileOutline, outline_files};
use mixdog_graph::scan::ScanError;
use serde_json::{Value, json};

use super::function_length::OutlineSource;

pub struct GraphOutlineSource;

/// The unified kind of an outline `symbolType` (already camelCase on the wire).
fn unified_symbol_kind(symbol_type: &str) -> &str {
    match symbol_type {
        "typeParameter" => "type",
        other => other,
    }
}

fn symbol(row: &Value) -> Option<Value> {
    let line = |pointer: &str| row.pointer(pointer).and_then(Value::as_u64).map(|n| n + 1);
    Some(json!({
        "kind": unified_symbol_kind(row.get("symbolType")?.as_str()?),
        "name": row.get("name")?.as_str()?,
        "startLine": line("/range/start/line")?,
        "endLine": line("/range/end/line")?,
    }))
}

/// One `{rel, lang, symbols}` record per outlined file. A file that failed to read or parse keeps
/// its record with no symbols, so it is counted as seen and never as short.
pub fn file_record(file: &FileOutline) -> Value {
    let mut symbols = Vec::new();
    for item in file.items.iter().filter_map(|i| serde_json::to_value(i).ok()) {
        if item.get("isImport") == Some(&Value::Bool(true)) {
            continue;
        }
        symbols.extend(symbol(&item));
        symbols.extend(item.get("members").and_then(Value::as_array).into_iter().flatten().filter_map(symbol));
    }
    json!({"rel": file.file, "lang": file.lang, "symbols": symbols})
}

#[async_trait]
impl OutlineSource for GraphOutlineSource {
    async fn outline(&self, cwd: &Path, rels: &[String]) -> Result<Vec<Value>, String> {
        // An empty list would make the walk cover all of cwd, which is never what a scoped call means.
        if rels.is_empty() {
            return Ok(Vec::new());
        }
        let (root, rels) = (cwd.to_owned(), rels.to_vec());
        let report = tokio::task::spawn_blocking(move || outline_files(&root, &rels, None))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| match e {
                ScanError::Usage(m) | ScanError::Internal(m) => m,
            })?;
        Ok(report.files.iter().map(file_record).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tidy::function_length::summarize_function_lengths;

    const SOURCE: &str = "use std::fmt;\n\nfn short() {}\n\nstruct Holder;\n\nimpl Holder {\n    fn method(&self) -> u32 {\n        1\n    }\n}\n\nfn long_one() {\n    let a = 1;\n    let b = 2;\n    let c = a + b;\n    let _ = c;\n}\n";

    #[tokio::test]
    async fn a_real_rust_file_yields_spans_in_the_unified_kinds() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), SOURCE).unwrap();
        let records = GraphOutlineSource.outline(dir.path(), &["a.rs".to_owned()]).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!((records[0]["rel"].as_str(), records[0]["lang"].as_str()), (Some("a.rs"), Some("rust")));
        let symbols = records[0]["symbols"].as_array().unwrap();
        let find = |name: &str| symbols.iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("{name} in {symbols:?}"));
        assert_eq!((find("short")["kind"].clone(), find("short")["startLine"].clone(), find("short")["endLine"].clone()), (json!("function"), json!(3), json!(3)));
        assert_eq!(find("long_one")["kind"], "function");
        assert_eq!((find("long_one")["startLine"].clone(), find("long_one")["endLine"].clone()), (json!(13), json!(18)));
        // A method is a member of its impl, with the lines of its own declaration.
        assert_eq!((find("method")["kind"].clone(), find("method")["startLine"].clone(), find("method")["endLine"].clone()), (json!("method"), json!(8), json!(10)));
        assert!(symbols.iter().all(|s| s["name"] != "fmt" && s["startLine"].as_u64().unwrap() >= 1), "imports are not symbols");
    }

    #[tokio::test]
    async fn the_function_length_summary_counts_from_the_real_outline() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), SOURCE).unwrap();
        std::fs::write(dir.path().join("notes.txt"), "plain text").unwrap();
        let out = summarize_function_lengths(&GraphOutlineSource, dir.path(), &["a.rs".to_owned(), "notes.txt".to_owned()]).await;
        assert_eq!(out["measured"], true);
        assert_eq!(out["functions"], 3, "short, method and long_one");
        assert_eq!(out["longest"][0]["name"], "long_one");
        assert_eq!(out["longest"][0]["lines"], 6);
        assert_eq!(out["notMeasured"], json!([".txt"]));
    }

    #[tokio::test]
    async fn an_empty_selection_never_walks_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), SOURCE).unwrap();
        assert!(GraphOutlineSource.outline(dir.path(), &[]).await.unwrap().is_empty());
    }
}
