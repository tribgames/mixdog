//! `design/design-table-input.mjs`: one reading of a preset table for every consumer, the composer that writes the rows
//! and the topology that picks the layout from them.

use mixdog_js::js_object_keys;
use mixdog_office_base::values::plain_object;
use serde_json::Value;

use crate::{array_of, prop};

const ACCEPTED: &str = "table: [[…], […]] or table: { headers: […], rows: [[…]] }";

/// The field name the refusal texts start with when the caller names none.
pub const DEFAULT_FIELD: &str = "section.table";

/// `rowArrays`: the list when every row is itself a list.
fn row_arrays(value: Option<&Value>) -> Option<&Vec<Value>> {
    array_of(value).filter(|rows| rows.iter().all(Value::is_array))
}

/// `composeTableRows(table, { field, strict })`: the header row (when there is one) followed by the body rows. A shape
/// nobody can write is refused (`strict`) rather than dropped, because a silently missing table reads as a finished
/// document; a lenient reading answers no rows for it.
pub fn compose_table_rows(table: Option<&Value>, field: &str, strict: bool) -> Result<Vec<Value>, String> {
    let refuse = |detail: String| -> Result<Vec<Value>, String> {
        if strict { Err(format!("{field} {detail}. Pass {ACCEPTED}.")) } else { Ok(Vec::new()) }
    };
    let table = match table {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(inner) => inner,
    };
    if let Value::Array(_) = table {
        return match row_arrays(Some(table)) {
            Some(rows) => Ok(rows.clone()),
            None => refuse("must hold row arrays".into()),
        };
    }
    if plain_object(table) {
        let unusable: Vec<&str> = js_object_keys(table.as_object().expect("an object"))
            .into_iter()
            .map(String::as_str)
            .filter(|key| !["headers", "rows"].contains(key))
            .collect();
        if !unusable.is_empty() {
            return refuse(format!("does not take {}", unusable.join(", ")));
        }
        let empty = Value::Array(Vec::new());
        let written = prop(table, "rows").filter(|rows| !rows.is_null()).unwrap_or(&empty);
        let Some(rows) = row_arrays(Some(written)) else {
            return refuse("rows must be an array of row arrays".into());
        };
        let headers: Vec<Value> = match prop(table, "headers") {
            Some(Value::Array(headers)) if !headers.is_empty() => vec![Value::Array(headers.clone())],
            _ => Vec::new(),
        };
        if headers.is_empty() && rows.is_empty() {
            return refuse("carries no rows".into());
        }
        return Ok(headers.into_iter().chain(rows.iter().cloned()).collect());
    }
    refuse("must hold row arrays".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strict(table: Value) -> Result<Vec<Value>, String> {
        compose_table_rows(Some(&table), DEFAULT_FIELD, true)
    }

    #[test]
    fn rows_come_from_either_shape() {
        assert_eq!(strict(json!([["a", 1], ["b", 2]])), Ok(vec![json!(["a", 1]), json!(["b", 2])]));
        assert_eq!(
            strict(json!({ "headers": ["h1", "h2"], "rows": [["a", 1]] })),
            Ok(vec![json!(["h1", "h2"]), json!(["a", 1])])
        );
        assert_eq!(strict(json!({ "rows": [["a"]] })), Ok(vec![json!(["a"])]));
        assert_eq!(strict(json!({ "headers": ["h"] })), Ok(vec![json!(["h"])]));
        assert_eq!(compose_table_rows(None, DEFAULT_FIELD, true), Ok(vec![]));
        assert_eq!(compose_table_rows(Some(&Value::Null), DEFAULT_FIELD, true), Ok(vec![]));
        assert_eq!(strict(json!([])), Ok(vec![]));
    }

    #[test]
    fn an_unwritable_shape_is_refused_with_the_accepted_forms() {
        let accepted = "Pass table: [[…], […]] or table: { headers: […], rows: [[…]] }.";
        assert_eq!(strict(json!(["a", "b"])), Err(format!("section.table must hold row arrays. {accepted}")));
        assert_eq!(strict(json!("x")), Err(format!("section.table must hold row arrays. {accepted}")));
        assert_eq!(strict(json!({ "cells": 1, "rows": [], "caption": "c" })), Err(format!("section.table does not take cells, caption. {accepted}")));
        assert_eq!(strict(json!({ "rows": "x" })), Err(format!("section.table rows must be an array of row arrays. {accepted}")));
        assert_eq!(strict(json!({ "headers": [], "rows": [] })), Err(format!("section.table carries no rows. {accepted}")));
        assert_eq!(
            compose_table_rows(Some(&json!(5)), "blocks[2].table", true),
            Err(format!("blocks[2].table must hold row arrays. {accepted}"))
        );
    }

    #[test]
    fn a_lenient_reading_answers_no_rows() {
        for table in [json!(["a"]), json!("x"), json!({ "cells": 1 }), json!({ "rows": 3 }), json!({})] {
            assert_eq!(compose_table_rows(Some(&table), DEFAULT_FIELD, false), Ok(vec![]), "{table}");
        }
        assert_eq!(compose_table_rows(Some(&json!([["a"]])), DEFAULT_FIELD, false), Ok(vec![json!(["a"])]));
    }
}
