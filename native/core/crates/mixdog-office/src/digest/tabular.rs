//! The delimited-file digest: a cell names its place twice, the reference already says the row and the column.

use serde_json::Value;

use super::common::{digest_object_with, remove};

fn sheet_digest(sheet: &Value) -> Value {
    let Value::Object(map) = sheet else { return sheet.clone() };
    let Some(Value::Array(cells)) = map.get("cells") else { return sheet.clone() };
    let cells = cells
        .iter()
        .map(|cell| {
            digest_object_with(cell, |cell| {
                let mut rest = cell.clone();
                remove(&mut rest, "row");
                remove(&mut rest, "column");
                rest
            })
        })
        .collect();
    let mut digest = map.clone();
    digest.insert("cells".to_owned(), Value::Array(cells));
    Value::Object(digest)
}

/// The document a model reads, for a csv or tsv file.
pub fn tabular_document_digest(document: &Value) -> Value {
    let Value::Object(map) = document else { return document.clone() };
    let Some(Value::Array(sheets)) = map.get("sheets") else { return document.clone() };
    let mut digest = map.clone();
    digest.insert("sheets".to_owned(), Value::Array(sheets.iter().map(sheet_digest).collect()));
    Value::Object(digest)
}
