//! The floating panels (`ContextInspector.jsx`, `ContextPanel.jsx`, `UsagePanel.jsx`, `BtwPanel.jsx`): each one in the
//! file of its name, with the helpers they share here.
//!
//! The panels take the objects the Node components receive (`detail`, `inspection`, `dashboard`, `panel`) as JSON
//! values, because the component reads them with JavaScript's own coercions (`Number(value)`, `value || fallback`,
//! `?.`) and the producers (the core's context and usage reports) are JSON. Each panel is a painter function that
//! returns the rows it took and a `*_rows` function that gives the same count without painting; the keyboard
//! handling is a state value with `handle_key` that returns what the owner has to do.

use mixdog_term::frame::{Grid, Rect, Style};
use mixdog_term::paint::{Painter, RoundBorder, TextWrap};
use mixdog_tui_style::Key;
use serde_json::Value;

use crate::themed;

pub mod btw_panel;
pub mod context_inspector;
pub mod context_panel;
pub mod usage_panel;

/// `value?.[key]` of a JSON object.
pub(crate) fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// JavaScript truthiness of an optional value (an absent one is falsy).
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value || '')`.
pub(crate) fn text_or_empty(value: Option<&Value>) -> String {
    if truthy(value) { value.map(mixdog_js::value_to_string).unwrap_or_default() } else { String::new() }
}

/// `${value}` of a template literal: an absent value is `undefined`.
pub(crate) fn template_text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}

/// `Number.isFinite(Number(value)) ? Number(value) : 0`.
pub(crate) fn finite_number(value: Option<&Value>) -> f64 {
    let n = mixdog_js::to_number_of(value);
    if n.is_finite() { n } else { 0.0 }
}

/// An absent value or `null` (`value == null`).
pub(crate) fn is_nullish(value: Option<&Value>) -> bool {
    matches!(value, None | Some(Value::Null))
}

/// The items of an array value; anything else has none (`Array.isArray(value) ? value : []`).
pub(crate) fn items(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(array) => array.as_slice(),
        None => &[],
    }
}

/// The rows an Ink `<Text>` takes painted: an empty text is no node at all and takes none.
pub(crate) fn put(painter: &mut Painter, x: i32, y: i32, text: &str, style: Style, width: usize, mode: TextWrap) -> u16 {
    if text.is_empty() {
        return 0;
    }
    painter.text(x, y, text, style, width, mode)
}

/// The border of a panel (`<Box borderStyle="round" borderColor={theme.promptBorder} paddingX={1} width="100%">`) of
/// `columns` cells and `rows` rows with its corner at `(x, y)`.
pub(crate) fn paint_frame(painter: &mut Painter, x: i32, y: i32, columns: usize, rows: u16) {
    if x >= 0 && y >= 0 {
        painter.border(Rect::new(x as u16, y as u16, columns as u16, rows), &RoundBorder::all(themed(Key::PromptBorder)));
    }
}

/// The rows a painter function reports, without painting anywhere: the function runs over a grid one row high, which
/// clips everything it draws.
pub(crate) fn rows_of(columns: usize, paint: impl FnOnce(&mut Painter) -> u16) -> u16 {
    let mut grid = Grid::new(columns.min(usize::from(u16::MAX)) as u16, 1);
    let mut painter = Painter::new(&mut grid);
    paint(&mut painter)
}
