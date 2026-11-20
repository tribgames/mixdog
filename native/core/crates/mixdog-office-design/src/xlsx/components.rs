//! `design/xlsx/design-xlsx-components.mjs`: the pieces a composed sheet is built from (a merged block, the wrapped
//! band's height and line breaks, the decision panel with its gates and actions), as portable xlsx operations.

use mixdog_js::{json_number, math, value_to_string};
use mixdog_office_base::a1::column_label;
use mixdog_office_base::labels::preset_labels;
use mixdog_office_base::line_breaks::{without_runt, wrap_units};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::prop;
use crate::tokens::strings;

/// A computed number as the JSON value `JSON.stringify` writes for it.
pub(super) fn num(value: f64) -> Value {
    json_number(value)
}

pub(super) fn text_value(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// The letters of a 1-based column number.
pub(super) fn col(column: usize) -> String {
    column_label(column as f64)
}

/// An object whose absent (`undefined`) members are left out, as `JSON.stringify` leaves them.
pub(super) fn props(entries: Vec<(&str, Option<Value>)>) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        if let Some(value) = value {
            map.insert(key.to_owned(), value);
        }
    }
    Value::Object(map)
}

/// An operation: `{ op, ...fields }`.
pub(super) fn operation(name: &str, fields: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    map.insert("op".to_owned(), text_value(name));
    for (key, value) in fields {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

static NULL: Value = Value::Null;

/// The colours and faces of a design (`design.tokens.colors`, `design.tokens.typography`).
pub(super) struct Tokens<'a> {
    colors: &'a Value,
    typography: &'a Value,
}

impl<'a> Tokens<'a> {
    pub(super) fn of(design: &'a Value) -> Self {
        let tokens = prop(design, "tokens").unwrap_or(&NULL);
        Tokens { colors: prop(tokens, "colors").unwrap_or(&NULL), typography: prop(tokens, "typography").unwrap_or(&NULL) }
    }

    pub(super) fn color(&self, role: &str) -> Option<Value> {
        prop(self.colors, role).cloned()
    }

    /// `colors.first || colors.second`.
    pub(super) fn color_or(&self, first: &str, second: &str) -> Option<Value> {
        match prop(self.colors, first) {
            Some(value) if truthy(value) => Some(value.clone()),
            _ => self.color(second),
        }
    }

    pub(super) fn face(&self, role: &str) -> Option<Value> {
        prop(self.typography, role).cloned()
    }
}

/// One merged block: its range, the value in its first cell, its style.
struct Block<'a> {
    sheet: &'a str,
    start_column: usize,
    end_column: usize,
    row: usize,
    rows: usize,
    value: &'a str,
    properties: Value,
}

fn merged_block(output: &mut Vec<Value>, block: Block) {
    let Block { sheet, start_column, end_column, row, rows, value, properties } = block;
    let start = col(start_column);
    let end = col(end_column);
    let last = row + rows.max(1) - 1;
    // The value goes into the merged block, not the lone cell before it: Excel fits a row to a lone cell's broken
    // lines the moment they are written. A merged cell never fits its row.
    if end_column > start_column || last > row {
        output.push(operation("merge_cells", vec![("sheet", text_value(sheet)), ("range", text_value(&format!("{start}{row}:{end}{last}")))]));
    }
    output.push(operation("set_cell", vec![("sheet", text_value(sheet)), ("cell", text_value(&format!("{start}{row}"))), ("value", text_value(value))]));
    output.push(operation(
        "set_style",
        vec![("sheet", text_value(sheet)), ("range", text_value(&format!("{start}{row}:{end}{last}"))), ("properties", properties)],
    ));
}

/// The gate rows of a panel: three texts each, from a list of `[track, release, stop]` or `{ track, release, stop }`.
fn normalized_gates(value: Option<&Value>) -> Vec<[String; 3]> {
    let cell = |cell: &Value| if cell.is_null() { String::new() } else { value_to_string(cell) };
    let named = |entry: &Value, names: [&[&str]; 3]| -> [String; 3] {
        let pick = |keys: &[&str]| keys.iter().filter_map(|key| prop(entry, key)).find(|value| truthy(value)).map_or_else(String::new, value_to_string);
        [pick(names[0]), pick(names[1]), pick(names[2])]
    };
    let Some(Value::Array(entries)) = value else { return Vec::new() };
    entries
        .iter()
        .filter_map(|entry| match entry {
            Value::Array(cells) => (cells.len() >= 3).then(|| [cell(&cells[0]), cell(&cells[1]), cell(&cells[2])]),
            Value::Object(_) => Some(named(entry, [&["track", "label", "title"], &["release", "go"], &["stop", "hold"]])),
            _ => None,
        })
        .filter(|row| row.iter().any(|text| !text.is_empty()))
        .collect()
}

fn is_cjk_em(c: char) -> bool {
    matches!(c, '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7AF}' | '\u{3040}'..='\u{30FF}' | '\u{4E00}'..='\u{9FFF}')
}

/// Bold display type runs wider than the regular em, and the merged band loses its cell insets: the estimate leans
/// long, since a band a line too tall reads as air and one a line short cuts the title. Hangul and CJK run about one
/// em a character, Latin about half.
fn text_ems(text: &str) -> f64 {
    text.chars().fold(0.0, |total, c| total + if is_cjk_em(c) { 1.1 } else { 0.6 })
}

fn line_room(canvas_points: f64) -> f64 {
    let points = if canvas_points.is_nan() || canvas_points == 0.0 { 480.0 } else { canvas_points };
    math::max(1.0, points * 0.8)
}

/// The height a wrapped band needs: its lines (each line the text breaks itself and each wrap of one over the canvas)
/// at 1.3 times the size, with the band's own inset.
pub fn band_height(text: &str, size: f64, canvas_points: f64) -> f64 {
    let room = line_room(canvas_points);
    let lines = text.split('\n').fold(0.0, |total, line| total + math::max(1.0, math::ceil(text_ems(line) * size / room)));
    math::min(409.0, math::round(lines * size * 1.3 + 8.0))
}

/// Korean breaks between words, never inside one: the text is broken at its spaces into lines of the width
/// [`band_height`] measures, words that read as one stay together, and a band never ends on one word alone under a
/// full line.
pub fn wrap_words(text: &str, size: f64, canvas_points: f64) -> String {
    let room = line_room(canvas_points);
    let measure = |line: &str| text_ems(line) * size;
    text.split('\n')
        .map(|paragraph| {
            let mut lines: Vec<String> = Vec::new();
            let mut line = String::new();
            for word in wrap_units(&paragraph.split(' ').collect::<Vec<_>>()) {
                let candidate = if line.is_empty() { word.clone() } else { format!("{line} {word}") };
                if !line.is_empty() && measure(&candidate) > room {
                    lines.push(std::mem::take(&mut line));
                    line = word;
                } else {
                    line = candidate;
                }
            }
            lines.push(line);
            without_runt(&lines, measure, room).join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What [`add_xlsx_decision_panel`] is given.
pub(super) struct Panel<'a> {
    pub sheet: &'a str,
    pub row: usize,
    pub start_column: usize,
    pub columns: usize,
    pub design: &'a Value,
    pub decision: &'a str,
    pub gates: Option<&'a Value>,
    pub actions: Option<&'a Value>,
    pub label: &'a str,
    /// The panel's printed width, from which the decision's merged row takes its height: a merged cell never grows to
    /// its lines, and a two-sentence decision showed its first line and hid the rest in Excel.
    pub width_points: f64,
}

/// Writes the decision panel; the row after its last one.
pub(super) fn add_xlsx_decision_panel(output: &mut Vec<Value>, panel: &Panel) -> usize {
    let tokens = Tokens::of(panel.design);
    let sheet = panel.sheet;
    let first_column = panel.start_column.max(1);
    // Four columns hold the gate row's three spans; a panel under a four-column table keeps the table's width.
    let width = panel.columns.max(4);
    let final_column = first_column + width - 1;
    let mut cursor = panel.row;
    let sample = Value::Array(vec![
        Value::String(panel.decision.to_owned()),
        panel.gates.cloned().unwrap_or(Value::Null),
        panel.actions.cloned().unwrap_or(Value::Null),
    ]);
    let preset = preset_labels(&sample);
    merged_block(
        output,
        Block {
            sheet,
            start_column: first_column,
            end_column: final_column,
            row: cursor,
            rows: 1,
            value: if panel.label.is_empty() { preset.decision } else { panel.label },
            properties: props(vec![
                ("fontName", tokens.face("data")),
                ("fontSize", Some(num(10.0))),
                ("bold", Some(Value::Bool(true))),
                ("color", tokens.color("onInverse")),
                ("fillColor", tokens.color("inverse")),
                ("verticalAlignment", Some(text_value("center"))),
            ]),
        },
    );
    cursor += 1;
    // Beside a table the panel shares the table's rows: a taller decision row made the table's first record taller
    // than the rest. There the decision spans as many 15 pt rows as its lines need instead of growing one.
    let beside_table = first_column > 1;
    let decision_text = if panel.width_points > 0.0 { wrap_words(panel.decision, 15.0, panel.width_points) } else { panel.decision.to_owned() };
    let decision_rows = if beside_table && panel.width_points > 0.0 {
        math::max(1.0, math::ceil(band_height(&decision_text, 15.0, panel.width_points) / 15.0)) as usize
    } else {
        1
    };
    merged_block(
        output,
        Block {
            sheet,
            start_column: first_column,
            end_column: final_column,
            row: cursor,
            rows: decision_rows,
            value: &decision_text,
            properties: props(vec![
                ("fontName", tokens.face("display")),
                ("fontSize", Some(num(15.0))),
                ("bold", Some(Value::Bool(true))),
                ("color", tokens.color("ink")),
                ("fillColor", tokens.color("surface")),
                ("verticalAlignment", Some(text_value("center"))),
                ("wrapText", Some(Value::Bool(true))),
            ]),
        },
    );
    if panel.width_points > 0.0 && !beside_table {
        output.push(operation(
            "set_row_height",
            vec![("sheet", text_value(sheet)), ("row", num(cursor as f64)), ("height", num(band_height(&decision_text, 15.0, panel.width_points)))],
        ));
    }
    cursor += decision_rows + 1;
    let gate_rows = normalized_gates(panel.gates);
    let action_list = strings(panel.actions);
    if !gate_rows.is_empty() {
        let third = width / 3;
        let two_thirds = width * 2 / 3;
        let relative = [(1, third.max(1)), ((third + 1).max(2), two_thirds.max(3)), ((two_thirds + 1).max(4), width)];
        let spans: Vec<(usize, usize)> = relative.iter().map(|(start, end)| (first_column + start - 1, first_column + end - 1)).collect();
        // The gate columns are named in the copy's language: "트랙 / Release / Stop" put two English words the caller
        // never wrote into a Korean sheet.
        for (index, label) in preset.gate.iter().enumerate() {
            merged_block(
                output,
                Block {
                    sheet,
                    start_column: spans[index].0,
                    end_column: spans[index].1,
                    row: cursor,
                    rows: 1,
                    value: label,
                    properties: props(vec![
                        ("fontName", tokens.face("body")),
                        ("fontSize", Some(num(10.0))),
                        ("bold", Some(Value::Bool(true))),
                        ("color", tokens.color("onInverse")),
                        ("fillColor", tokens.color("inverse")),
                        ("horizontalAlignment", Some(text_value("left"))),
                        ("verticalAlignment", Some(text_value("center"))),
                    ]),
                },
            );
        }
        cursor += 1;
        for (row_index, values) in gate_rows.iter().enumerate() {
            for (column_index, value) in values.iter().enumerate() {
                // Release is a positive state, Stop a critical one: the state fields and words, never a literal tint.
                let mut color = tokens.color("ink");
                let mut fill = if row_index % 2 == 0 { tokens.color("canvas") } else { tokens.color("surface2") };
                if column_index == 1 {
                    color = tokens.color_or("positiveText", "accent");
                    fill = tokens.color_or("positiveWeak", "surface");
                } else if column_index == 2 {
                    color = tokens.color_or("criticalText", "accent2");
                    fill = tokens.color_or("criticalWeak", "surface2");
                }
                merged_block(
                    output,
                    Block {
                        sheet,
                        start_column: spans[column_index].0,
                        end_column: spans[column_index].1,
                        row: cursor,
                        rows: 1,
                        value,
                        properties: props(vec![
                            ("fontName", tokens.face("body")),
                            ("fontSize", Some(num(10.0))),
                            ("bold", Some(Value::Bool(column_index == 0))),
                            ("color", color),
                            ("fillColor", fill),
                            ("verticalAlignment", Some(text_value("center"))),
                            ("wrapText", Some(Value::Bool(true))),
                        ]),
                    },
                );
            }
            cursor += 1;
        }
    }
    // The actions follow the gates rather than stand in for them: given both, the actions would be dropped.
    if !gate_rows.is_empty() && !action_list.is_empty() {
        cursor += 1;
    }
    for action in action_list.iter().take(4) {
        merged_block(
            output,
            Block {
                sheet,
                start_column: first_column,
                end_column: final_column,
                row: cursor,
                rows: 1,
                value: &format!("• {action}"),
                properties: props(vec![
                    ("fontName", tokens.face("body")),
                    ("fontSize", Some(num(10.0))),
                    ("color", tokens.color("ink")),
                    ("fillColor", if cursor % 2 == 0 { tokens.color("canvas") } else { tokens.color("surface") }),
                    ("verticalAlignment", Some(text_value("center"))),
                    ("wrapText", Some(Value::Bool(true))),
                ]),
            },
        );
        cursor += 1;
    }
    cursor
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_band_is_as_tall_as_its_lines() {
        // 16 Latin characters at 10 pt: 96 em-points over a 0.8 * 480 room is one line.
        assert_eq!(band_height("abcdefghijklmnop", 10.0, 480.0), 21.0);
        assert_eq!(band_height("a\nb", 10.0, 480.0), 34.0);
        assert_eq!(band_height(&"한".repeat(100), 10.0, 480.0), 47.0);
    }

    #[test]
    fn a_line_breaks_between_words_and_keeps_a_date_whole() {
        let text = wrap_words("야간 전용안을 10월 14일 투자심의에서 확정합니다", 15.0, 120.0);
        assert!(text.contains("10월 14일"));
        assert!(text.contains('\n'));
        assert_eq!(wrap_words("short", 15.0, 480.0), "short");
    }

    #[test]
    fn gates_are_read_from_lists_and_from_named_fields() {
        let gates = json!([["a", "b", "c"], { "label": "x", "go": "y", "hold": "z" }, ["a", "b"], "text", null, { "track": "" }]);
        assert_eq!(normalized_gates(Some(&gates)), vec![["a", "b", "c"].map(String::from), ["x", "y", "z"].map(String::from)]);
        assert!(normalized_gates(None).is_empty());
    }

    #[test]
    fn a_panel_names_itself_and_lists_four_actions_at_most() {
        let design = json!({ "tokens": { "colors": { "ink": "111111" }, "typography": { "body": "Calibri" } } });
        let actions = json!(["a", "b", "c", "d", "e"]);
        let mut output = Vec::new();
        let end = add_xlsx_decision_panel(
            &mut output,
            &Panel {
                sheet: "S",
                row: 3,
                start_column: 1,
                columns: 6,
                design: &design,
                decision: "Go",
                gates: None,
                actions: Some(&actions),
                label: "",
                width_points: 0.0,
            },
        );
        // The heading, the decision, a blank row, then four bullets.
        assert_eq!(end, 3 + 1 + 1 + 1 + 4);
        let cells: Vec<&str> = output.iter().filter(|entry| entry["op"] == "set_cell").map(|entry| entry["value"].as_str().unwrap()).collect();
        assert_eq!(cells, ["DECISION WINDOW", "Go", "• a", "• b", "• c", "• d"]);
    }
}
