//! `portable/pptx-relations.mjs`: the relationships an author declares between shapes of a slide (a value and its label, the
//! cells of a table, a paragraph, an object) and how they are read back. A declaration lives in the shape's name, so it
//! survives every Office round trip without a custom XML part. These declarations describe meaning; they never choose a
//! layout.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, json_number, json_parse, json_stringify, math, number_to_string, utf16_len, value_to_string};
use serde_json::{Map, Value, json};

use crate::opc::decode_uri_component;
use crate::xml::xml_decode;

const PREFIX: &str = "mixdog-relation:";
const ROLES: [&str; 5] = ["value", "label", "table-cell", "paragraph", "object"];
const OPTIONAL_KEYS: [&str; 4] = ["label", "group", "row", "column"];

fn valid_id(value: &str) -> bool {
    let length = utf16_len(value);
    length > 0 && length <= 100 && !value.chars().any(|c| (c as u32) < 0x20)
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `relationOptions(relation)`: the shape name that carries a declaration, `mixdog-relation:` and the declaration as
/// encoded JSON. An error when the declaration lacks an id or a role, or an identifier is empty, long, or holds a control
/// character.
pub fn relation_options(relation: &Value) -> Result<String, String> {
    let role = relation.get("role").and_then(Value::as_str).filter(|role| ROLES.contains(role));
    let id = relation.get("id").and_then(Value::as_str).filter(|id| valid_id(id));
    let (Some(role), Some(id)) = (role, id) else {
        return Err("RELATE requires an id and role: value, label, table-cell, paragraph, or object".to_owned());
    };
    let mut declared = Map::new();
    declared.insert("id".to_owned(), Value::from(id));
    declared.insert("role".to_owned(), Value::from(role));
    for key in OPTIONAL_KEYS {
        let Some(item) = relation.get(key).filter(|item| !item.is_null()) else { continue };
        let text = value_to_string(item);
        if !valid_id(&text) {
            return Err(format!("RELATE {key} must be a non-empty identifier of at most 100 characters"));
        }
        declared.insert(key.to_owned(), Value::String(text));
    }
    Ok(format!("{PREFIX}{}", encode_uri_component(&json_stringify(&Value::Object(declared)))))
}

/// What a shape's XML says about it.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapeIdentity {
    pub shape_id: String,
    /// The declaration the shape's name carries, as written.
    pub relation: Option<Value>,
    pub relation_error: Option<&'static str>,
}

static SHAPE_PROPERTIES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<p:cNvPr\b([^>]*)", ""));
static SHAPE_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bname="([^"]*)""#, ""));
static SHAPE_ID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bid="([^"]*)""#, ""));

fn first_group(pattern: &JsRegex, text: &str) -> String {
    pattern.captures(text).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default()
}

/// `shapeIdentity(xml)`: the shape's id, and the declaration its name carries when it carries one (or the reason it could
/// not be read).
pub fn shape_identity(xml: &str) -> ShapeIdentity {
    let properties = first_group(&SHAPE_PROPERTIES, xml);
    let name = xml_decode(&first_group(&SHAPE_NAME, &properties));
    let shape_id = first_group(&SHAPE_ID, &properties);
    let Some(encoded) = name.strip_prefix(PREFIX) else {
        return ShapeIdentity { shape_id, relation: None, relation_error: None };
    };
    let declared = decode_uri_component(encoded)
        .and_then(|text| json_parse(&text).ok())
        .filter(|relation| relation_options(relation).is_ok());
    match declared {
        Some(relation) => ShapeIdentity { shape_id, relation: Some(relation), relation_error: None },
        None => ShapeIdentity { shape_id, relation: None, relation_error: Some("Invalid shape relationship declaration") },
    }
}

/// A declaration read back from a shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub id: String,
    pub role: String,
    pub label: Option<String>,
    pub group: Option<String>,
    pub row: Option<String>,
    pub column: Option<String>,
}

impl Relation {
    /// The declaration of a parsed object (identifiers read as text); `None` when it has no id or role.
    pub fn from_value(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).filter(|item| !item.is_null()).map(value_to_string);
        Some(Self {
            id: value.get("id")?.as_str()?.to_owned(),
            role: value.get("role")?.as_str()?.to_owned(),
            label: text("label"),
            group: text("group"),
            row: text("row"),
            column: text("column"),
        })
    }
}

/// A text shape of a slide as the reviews read it: where it sits (points) and what it declares.
#[derive(Debug, Clone, PartialEq)]
pub struct RelationBox {
    pub slide: f64,
    pub shape: f64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub relation: Option<Relation>,
    pub relation_error: Option<String>,
}

/// `bySlide(entries)`: the entries grouped by the slide they sit on, in the order they were read.
pub fn by_slide<T>(entries: &[T], slide_of: impl Fn(&T) -> f64) -> Vec<(f64, Vec<&T>)> {
    let mut slides: Vec<(f64, Vec<&T>)> = Vec::new();
    for entry in entries {
        let slide = slide_of(entry);
        // A `Map` key is compared as SameValueZero: NaN equals NaN.
        match slides.iter_mut().find(|(known, _)| *known == slide || (known.is_nan() && slide.is_nan())) {
            Some((_, group)) => group.push(entry),
            None => slides.push((slide, vec![entry])),
        }
    }
    slides
}

/// The shape each declared id belongs to, by position; `None` where two shapes declare the same id.
pub type RelationIndex = HashMap<String, Option<usize>>;

/// `relationIndex(shapes)`.
pub fn relation_index(shapes: &[RelationBox]) -> RelationIndex {
    let mut index = RelationIndex::new();
    for (at, shape) in shapes.iter().enumerate() {
        let Some(id) = shape.relation.as_ref().map(|relation| relation.id.as_str()).filter(|id| !id.is_empty()) else { continue };
        let value = if index.contains_key(id) { None } else { Some(at) };
        index.insert(id.to_owned(), value);
    }
    index
}

fn role_at(shapes: &[RelationBox], index: &RelationIndex, id: Option<&str>) -> Option<String> {
    let at = index.get(id?).copied().flatten()?;
    shapes[at].relation.as_ref().map(|relation| relation.role.clone())
}

/// `independentTextUnit(box, shapes, index)`: whether the shape at `at` is a unit of its own by declaration: a value with
/// its label, a label some value declares, or a table cell with a neighbour in its row.
pub fn independent_text_unit(shapes: &[RelationBox], at: usize, index: &RelationIndex) -> bool {
    let Some(relation) = shapes[at].relation.as_ref() else { return false };
    if index.get(&relation.id).copied().flatten() != Some(at) {
        return false;
    }
    match relation.role.as_str() {
        "value" => role_at(shapes, index, relation.label.as_deref()).as_deref() == Some("label"),
        "label" => shapes.iter().enumerate().any(|(other_at, shape)| {
            shape.relation.as_ref().is_some_and(|other| {
                other.role == "value"
                    && other.label.as_deref() == Some(relation.id.as_str())
                    && index.get(&other.id).copied().flatten() == Some(other_at)
            })
        }),
        // `relation.group && relation.row && relation.column`: an empty identifier counts as absent.
        "table-cell" if [&relation.group, &relation.row, &relation.column].iter().all(|item| item.as_deref().is_some_and(|text| !text.is_empty())) => {
            shapes.iter().enumerate().any(|(other_at, shape)| {
                other_at != at
                    && shape.relation.as_ref().is_some_and(|other| {
                        other.role == "table-cell"
                            && other.group == relation.group
                            && other.row == relation.row
                            && other.column.as_deref().is_some_and(|column| !column.is_empty())
                            && other.column != relation.column
                    })
            })
        }
        _ => false,
    }
}

/// `rectangleGap(a, b)`: the distance between two rectangles (zero when they touch or overlap).
pub fn rectangle_gap(a: &RelationBox, b: &RelationBox) -> f64 {
    let across = math::max(math::max(0.0, a.left - b.left - b.width), b.left - a.left - a.width);
    let down = math::max(math::max(0.0, a.top - b.top - b.height), b.top - a.top - a.height);
    math::hypot(&[across, down])
}

fn path_of(shape: &RelationBox) -> String {
    format!("/slide[{}]/shape[{}]", number_to_string(shape.slide), number_to_string(shape.shape))
}

/// `reviewDeclaredRelations(shapes, maximumGap)`: the issues the declarations raise: one that could not be read or a
/// repeated id (`shape_relation_invalid`), a value without a unique label (`shape_relation_invalid`), and a value and its
/// declared label further apart than `maximum_gap` points (`stat_label_detached`).
pub fn review_declared_relations(shapes: &[RelationBox], maximum_gap: f64) -> Vec<Value> {
    let index = relation_index(shapes);
    let mut issues = Vec::new();
    for shape in shapes {
        let relation = shape.relation.as_ref();
        let path = path_of(shape);
        let duplicated = relation.is_some_and(|declared| matches!(index.get(&declared.id), Some(None)));
        let error = shape.relation_error.as_deref().filter(|error| !error.is_empty());
        if error.is_some() || duplicated {
            let message = error.map_or_else(
                || format!("Duplicate relationship id: {}", relation.map_or("", |declared| declared.id.as_str())),
                str::to_owned,
            );
            issues.push(json!({ "code": "shape_relation_invalid", "path": path, "message": message }));
        }
        let Some(declared) = relation.filter(|declared| declared.role == "value") else { continue };
        let label_at = declared.label.as_deref().and_then(|label| index.get(label).copied().flatten());
        let label = label_at.map(|found| &shapes[found]).filter(|found| found.relation.as_ref().is_some_and(|other| other.role == "label"));
        let Some(label) = label else {
            let named = declared.label.as_deref().filter(|label| !label.is_empty()).unwrap_or("(missing)");
            issues.push(json!({
                "code": "shape_relation_invalid",
                "path": path,
                "message": format!("Value {} has no unique label {named}.", declared.id),
            }));
            continue;
        };
        let gap = rectangle_gap(shape, label);
        if gap > maximum_gap {
            let rounded = math::round(gap);
            issues.push(json!({
                "code": "stat_label_detached",
                "path": path,
                "confidence": "declared",
                "message": format!(
                    "Value {} and its declared label {} are {}pt apart; review their association.",
                    declared.id,
                    declared.label.as_deref().unwrap_or(""),
                    number_to_string(rounded)
                ),
                "gap": json_number(rounded),
                "shapes": [json_number(shape.shape), json_number(label.shape)],
            }));
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(id: &str, role: &str, label: Option<&str>) -> Option<Relation> {
        Some(Relation {
            id: id.to_owned(),
            role: role.to_owned(),
            label: label.map(str::to_owned),
            group: None,
            row: None,
            column: None,
        })
    }

    fn shape(shape: f64, left: f64, top: f64, relation: Option<Relation>) -> RelationBox {
        RelationBox { slide: 1.0, shape, left, top, width: 100.0, height: 20.0, relation, relation_error: None }
    }

    #[test]
    fn a_declaration_survives_the_shape_name() {
        let name = relation_options(&json!({ "id": "value-0", "role": "value", "label": "label-0" })).unwrap();
        assert_eq!(name, "mixdog-relation:%7B%22id%22%3A%22value-0%22%2C%22role%22%3A%22value%22%2C%22label%22%3A%22label-0%22%7D");
        let xml = format!("<p:nvSpPr><p:cNvPr id=\"4\" name=\"{name}\"/></p:nvSpPr>");
        let identity = shape_identity(&xml);
        assert_eq!(identity.shape_id, "4");
        assert_eq!(identity.relation, Some(json!({ "id": "value-0", "role": "value", "label": "label-0" })));
        assert_eq!(identity.relation_error, None);
        let plain = shape_identity("<p:cNvPr id=\"7\" name=\"Title 1\"/>");
        assert_eq!((plain.shape_id.as_str(), plain.relation, plain.relation_error), ("7", None, None));
    }

    #[test]
    fn a_bad_declaration_is_refused_and_a_bad_name_is_reported() {
        let refused = "RELATE requires an id and role: value, label, table-cell, paragraph, or object";
        assert_eq!(relation_options(&json!({ "id": "a" })).unwrap_err(), refused);
        assert_eq!(relation_options(&json!({ "id": "", "role": "label" })).unwrap_err(), refused);
        assert_eq!(relation_options(&json!({ "id": "a", "role": "other" })).unwrap_err(), refused);
        assert_eq!(relation_options(&json!(null)).unwrap_err(), refused);
        assert_eq!(
            relation_options(&json!({ "id": "a", "role": "value", "label": "x".repeat(101) })).unwrap_err(),
            "RELATE label must be a non-empty identifier of at most 100 characters"
        );
        assert_eq!(
            relation_options(&json!({ "id": "a", "role": "table-cell", "row": 4, "column": "c\u{1}" })).unwrap_err(),
            "RELATE column must be a non-empty identifier of at most 100 characters"
        );
        let broken = shape_identity("<p:cNvPr id=\"9\" name=\"mixdog-relation:%7Bnope\"/>");
        assert_eq!(broken.relation_error, Some("Invalid shape relationship declaration"));
        let unknown = shape_identity("<p:cNvPr id=\"9\" name=\"mixdog-relation:%7B%22id%22%3A%22a%22%7D\"/>");
        assert_eq!(unknown.relation_error, Some("Invalid shape relationship declaration"));
    }

    #[test]
    fn a_value_next_to_its_label_is_independent_and_a_detached_one_is_reported() {
        let mut shapes = vec![shape(1.0, 0.0, 0.0, declared("v", "value", Some("l"))), shape(2.0, 110.0, 0.0, declared("l", "label", None))];
        let index = relation_index(&shapes);
        assert!(independent_text_unit(&shapes, 0, &index));
        assert!(independent_text_unit(&shapes, 1, &index));
        assert!(review_declared_relations(&shapes, 80.0).is_empty());
        shapes[1].left = 700.0;
        let detached = review_declared_relations(&shapes, 80.0);
        assert_eq!(detached.len(), 1);
        assert_eq!(detached[0]["code"], "stat_label_detached");
        assert_eq!(detached[0]["confidence"], "declared");
        assert_eq!(detached[0]["gap"], 600);
        assert_eq!(detached[0]["shapes"], json!([1, 2]));
        assert_eq!(detached[0]["path"], "/slide[1]/shape[1]");
        shapes.remove(1);
        let missing = review_declared_relations(&shapes, 80.0);
        assert_eq!(missing[0]["code"], "shape_relation_invalid");
        assert_eq!(missing[0]["message"], "Value v has no unique label l.");
    }

    #[test]
    fn ambiguous_relationship_ids_cannot_silently_satisfy_a_value_label() {
        let shapes = vec![
            shape(1.0, 0.0, 0.0, declared("v", "value", Some("l"))),
            shape(2.0, 0.0, 0.0, declared("l", "label", None)),
            shape(3.0, 0.0, 0.0, declared("l", "label", None)),
            shape(4.0, 0.0, 0.0, declared("l", "label", None)),
        ];
        let issues = review_declared_relations(&shapes, 80.0);
        assert!(issues.iter().any(|issue| issue["code"] == "shape_relation_invalid"
            && issue["path"].as_str().is_some_and(|path| path.ends_with("shape[1]"))));
        let duplicate = issues.iter().find(|issue| issue["path"] == "/slide[1]/shape[2]").expect("duplicate");
        assert_eq!(duplicate["message"], "Duplicate relationship id: l");
        assert!(!independent_text_unit(&shapes, 1, &relation_index(&shapes)));
    }

    #[test]
    fn declared_table_cells_remain_independent() {
        let cell = |shape_number: f64, row: &str, column: &str| {
            shape(
                shape_number,
                0.0,
                0.0,
                Some(Relation {
                    id: format!("cell-{row}-{column}"),
                    role: "table-cell".into(),
                    label: None,
                    group: Some("ledger".into()),
                    row: Some(row.into()),
                    column: Some(column.into()),
                }),
            )
        };
        let shapes = vec![cell(1.0, "0", "0"), cell(2.0, "0", "1"), cell(3.0, "1", "0")];
        let index = relation_index(&shapes);
        assert!(independent_text_unit(&shapes, 0, &index));
        assert!(independent_text_unit(&shapes, 1, &index));
        assert!(!independent_text_unit(&shapes[2..], 0, &relation_index(&shapes[2..])));
    }

    #[test]
    fn entries_group_by_slide_in_reading_order() {
        let mut shapes = vec![shape(1.0, 0.0, 0.0, None), shape(2.0, 0.0, 0.0, None), shape(3.0, 0.0, 0.0, None)];
        shapes[1].slide = 2.0;
        let grouped = by_slide(&shapes, |entry| entry.slide);
        assert_eq!(grouped.iter().map(|(slide, group)| (*slide, group.len())).collect::<Vec<_>>(), [(1.0, 2), (2.0, 1)]);
    }

    #[test]
    fn the_gap_between_rectangles_is_zero_when_they_touch() {
        let a = shape(1.0, 0.0, 0.0, None);
        assert_eq!(rectangle_gap(&a, &shape(2.0, 100.0, 20.0, None)), 0.0);
        assert_eq!(rectangle_gap(&a, &shape(2.0, 130.0, 60.0, None)), 50.0);
    }
}
