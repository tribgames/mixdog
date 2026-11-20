//! The appearance streams of form widgets, drawn the way pdf-lib 1.17.1's default appearance providers draw them
//! (`api/form/appearances.ts`, `api/operations.ts`, `api/text/layout.ts`) and `PDFForm.updateFieldAppearances`.
//!
//! Text is laid out with the font's own measures ([`mixdog_pdf::embed::Font`]: a standard font or the embedded Unicode
//! face): a size of 0 fits the value to the box (4 pt up, one point at a time, until it no longer fits), a multiline
//! value wraps at the last space that fits, a combed value takes one cell a character. A check box and a radio button
//! carry an on and an off appearance (and the darker `down` pair), a text field, dropdown and option list one
//! stream clipped to the box inside its border, with the selected lines of a list highlighted.

use std::sync::{Arc, LazyLock};

use mixdog_js::math::{cos, sin, tan};
use mixdog_js::{JsRegex, is_js_space, js_trim, utf16_len};
use mixdog_pdf::embed::Font;
use mixdog_pdf::write::store::ObjectStore;
use mixdog_pdf::write::{PdfDocument, flate_stream};
use mixdog_pdf::{Dict, Obj, Ref};

use super::{
    FLAG_COMB, FLAG_FILE_SELECT, FLAG_MULTILINE, FLAG_PASSWORD, Field, FieldKind, FormError, FormFont, FormResult, NormalAppearance, PdfForm, Widget,
    border_style_width, characteristic_components, characteristic_rotation, choice_options, choice_values, default_appearance, find_last_match, has_flag,
    latin1_object, normal_appearance, pdf_number, set_key, text_value, widget_on_value, widget_rectangle, widgets_of,
};

const MIN_FONT_SIZE: f64 = 4.0;
const MAX_FONT_SIZE: f64 = 500.0;

// colours

/// A colour of the three device spaces pdf-lib draws with.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Color {
    Gray(f64),
    Rgb(f64, f64, f64),
    Cmyk(f64, f64, f64, f64),
}

impl Color {
    pub(crate) fn fill(self) -> String {
        match self {
            Self::Gray(g) => op("g", &[g]),
            Self::Rgb(r, g, b) => op("rg", &[r, g, b]),
            Self::Cmyk(c, m, y, k) => op("k", &[c, m, y, k]),
        }
    }

    fn stroke(self) -> String {
        match self {
            Self::Gray(g) => op("G", &[g]),
            Self::Rgb(r, g, b) => op("RG", &[r, g, b]),
            Self::Cmyk(c, m, y, k) => op("K", &[c, m, y, k]),
        }
    }
}

const BLACK: Color = Color::Rgb(0.0, 0.0, 0.0);

/// `componentsToColor`: a colour array of one, three or four numbers, scaled.
fn components_to_color(components: Option<&[f64]>, scale: f64) -> Option<Color> {
    match components? {
        [g] => Some(Color::Gray(g * scale)),
        [r, g, b] => Some(Color::Rgb(r * scale, g * scale, b * scale)),
        [c, m, y, k] => Some(Color::Cmyk(c * scale, m * scale, y * scale, k * scale)),
        _ => None,
    }
}

// operators

fn op(name: &str, args: &[f64]) -> String {
    let mut out = String::new();
    for arg in args {
        out.push_str(&pdf_number(*arg));
        out.push(' ');
    }
    out.push_str(name);
    out
}

fn cm(a: f64, b: f64, c: f64, d: f64, e: f64, f: f64) -> String {
    op("cm", &[a, b, c, d, e, f])
}

fn translate(x: f64, y: f64) -> String {
    cm(1.0, 0.0, 0.0, 1.0, x, y)
}

fn rotate_radians(angle: f64) -> String {
    cm(cos(angle), sin(angle), -sin(angle), cos(angle), 0.0, 0.0)
}

fn degrees_to_radians(degrees: f64) -> f64 {
    (degrees * std::f64::consts::PI) / 180.0
}

fn skew_radians(x: f64, y: f64) -> String {
    cm(1.0, tan(x), tan(y), 1.0, 0.0, 0.0)
}

fn move_to(x: f64, y: f64) -> String {
    op("m", &[x, y])
}

fn line_to(x: f64, y: f64) -> String {
    op("l", &[x, y])
}

fn curve(x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64) -> String {
    op("c", &[x1, y1, x2, y2, x3, y3])
}

fn truthy(number: f64) -> bool {
    number != 0.0 && !number.is_nan()
}

/// The operator that ends a shape: fill and stroke, fill, stroke, or just close the path.
fn paint(color: Option<Color>, border_color: Option<Color>, border_width: f64) -> String {
    if color.is_some() && truthy(border_width) {
        "B".to_owned()
    } else if color.is_some() {
        "f".to_owned()
    } else if border_color.is_some() {
        "S".to_owned()
    } else {
        "h".to_owned()
    }
}

struct RectangleStyle {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    border_width: f64,
    color: Option<Color>,
    border_color: Option<Color>,
}

fn draw_rectangle(style: &RectangleStyle) -> Vec<String> {
    let mut ops = vec!["q".to_owned()];
    if let Some(color) = style.color {
        ops.push(color.fill());
    }
    if let Some(color) = style.border_color {
        ops.push(color.stroke());
    }
    ops.push(op("w", &[style.border_width]));
    ops.push("[] 0 d".to_owned());
    ops.push(translate(style.x, style.y));
    ops.push(rotate_radians(0.0));
    ops.push(skew_radians(0.0, 0.0));
    ops.push(move_to(0.0, 0.0));
    ops.push(line_to(0.0, style.height));
    ops.push(line_to(style.width, style.height));
    ops.push(line_to(style.width, 0.0));
    ops.push("h".to_owned());
    ops.push(paint(style.color, style.border_color, style.border_width));
    ops.push("Q".to_owned());
    ops
}

fn draw_check_mark(x: f64, y: f64, size: f64, thickness: f64, color: Option<Color>) -> Vec<String> {
    let p2x = -1.0 + 0.75;
    let p2y = -1.0 + 0.51;
    let p3y = 1.0 - 0.525;
    let p3x = 1.0 - 0.31;
    let p1x = -1.0 + 0.325;
    let p1y = -((p1x - p2x) * (p3x - p2x)) / (p3y - p2y) + p2y;
    let mut ops = vec!["q".to_owned()];
    if let Some(color) = color {
        ops.push(color.stroke());
    }
    ops.push(op("w", &[thickness]));
    ops.push(translate(x, y));
    ops.push(move_to(p1x * size, p1y * size));
    ops.push(line_to(p2x * size, p2y * size));
    ops.push(line_to(p3x * size, p3y * size));
    ops.push("S".to_owned());
    ops.push("Q".to_owned());
    ops
}

/// `rotateInPlace`: the translation and rotation that put a widget rotated by its `MK /R` upright in its box.
fn rotate_in_place(width: f64, height: f64, rotation: u32) -> Vec<String> {
    let angle = f64::from(rotation);
    let (x, y) = match rotation {
        0 => (0.0, 0.0),
        90 => (width, 0.0),
        180 => (width, height),
        _ => (0.0, height),
    };
    vec![translate(x, y), rotate_radians(degrees_to_radians(angle))]
}

fn draw_check_box(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    thickness: f64,
    border_width: f64,
    mark_color: Color,
    color: Option<Color>,
    border_color: Option<Color>,
    filled: bool,
) -> Vec<String> {
    let outline = draw_rectangle(&RectangleStyle { x, y, width, height, border_width, color, border_color });
    if !filled {
        return outline;
    }
    let mark = draw_check_mark(width / 2.0, height / 2.0, width.min(height) / 2.0, thickness, Some(mark_color));
    let mut ops = vec!["q".to_owned()];
    ops.extend(outline);
    ops.extend(mark);
    ops.push("Q".to_owned());
    ops
}

fn draw_ellipse(x: f64, y: f64, x_scale: f64, y_scale: f64, color: Option<Color>, border_color: Option<Color>, border_width: f64) -> Vec<String> {
    let kappa = 4.0 * ((2.0_f64.sqrt() - 1.0) / 3.0);
    let mut ops = vec!["q".to_owned()];
    if let Some(color) = color {
        ops.push(color.fill());
    }
    if let Some(color) = border_color {
        ops.push(color.stroke());
    }
    ops.push(op("w", &[border_width]));
    ops.push("[] 0 d".to_owned());
    let left = x - x_scale;
    let bottom = y - y_scale;
    let ox = x_scale * kappa;
    let oy = y_scale * kappa;
    let right = left + x_scale * 2.0;
    let top = bottom + y_scale * 2.0;
    let xm = left + x_scale;
    let ym = bottom + y_scale;
    ops.push("q".to_owned());
    ops.push(move_to(left, ym));
    ops.push(curve(left, ym - oy, xm - ox, bottom, xm, bottom));
    ops.push(curve(xm + ox, bottom, right, ym - oy, right, ym));
    ops.push(curve(right, ym + oy, xm + ox, top, xm, top));
    ops.push(curve(xm - ox, top, left, ym + oy, left, ym));
    ops.push("Q".to_owned());
    ops.push(paint(color, border_color, border_width));
    ops.push("Q".to_owned());
    ops
}

fn draw_radio_button(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    border_width: f64,
    dot_color: Color,
    color: Option<Color>,
    border_color: Option<Color>,
    filled: bool,
) -> Vec<String> {
    let scale = width.min(height) / 2.0;
    let outline = draw_ellipse(x, y, scale, scale, color, border_color, border_width);
    if !filled {
        return outline;
    }
    let dot = draw_ellipse(x, y, scale * 0.45, scale * 0.45, Some(dot_color), None, 0.0);
    let mut ops = vec!["q".to_owned()];
    ops.extend(outline);
    ops.extend(dot);
    ops.push("Q".to_owned());
    ops
}

/// `/Name` of a name token: a character outside the regular ones is written `#` and its code in hex.
fn name_token(name: &str) -> String {
    let mut out = String::from("/");
    for unit in name.encode_utf16() {
        let regular = (0x21..=0x7e).contains(&unit) && !b"()<>[]{}/%#".contains(&(unit as u8));
        if regular {
            out.push(char::from(unit as u8));
        } else {
            out.push_str(&format!("#{unit:X}"));
        }
    }
    out
}

fn hex_string(bytes: &[u8]) -> String {
    let mut out = String::from("<");
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out.push('>');
    out
}

/// A line of text with the position it is drawn at.
#[derive(Debug, Clone)]
struct TextPosition {
    encoded: Vec<u8>,
    x: f64,
    y: f64,
    height: f64,
    text: String,
}

fn draw_text_lines(lines: &[TextPosition], color: Color, font_name: &str, size: f64) -> Vec<String> {
    let mut ops = vec!["BT".to_owned(), color.fill(), format!("{} {} Tf", name_token(font_name), pdf_number(size))];
    for line in lines {
        ops.push(op("Tm", &[1.0, 0.0, 0.0, 1.0, line.x, line.y]));
        ops.push(format!("{} Tj", hex_string(&line.encoded)));
    }
    ops.push("ET".to_owned());
    ops
}

struct BoxStyle {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    border_width: f64,
    color: Option<Color>,
    border_color: Option<Color>,
    text_color: Color,
    font: String,
    font_size: f64,
    padding: f64,
}

fn clipping_area(style: &BoxStyle) -> Vec<String> {
    let clip_x = style.x + style.border_width / 2.0 + style.padding;
    let clip_y = style.y + style.border_width / 2.0 + style.padding;
    let clip_width = style.width - (style.border_width / 2.0 + style.padding) * 2.0;
    let clip_height = style.height - (style.border_width / 2.0 + style.padding) * 2.0;
    vec![
        move_to(clip_x, clip_y),
        line_to(clip_x, clip_y + clip_height),
        line_to(clip_x + clip_width, clip_y + clip_height),
        line_to(clip_x + clip_width, clip_y),
        "h".to_owned(),
        "W".to_owned(),
        "n".to_owned(),
    ]
}

fn background(style: &BoxStyle) -> Vec<String> {
    draw_rectangle(&RectangleStyle {
        x: style.x,
        y: style.y,
        width: style.width,
        height: style.height,
        border_width: style.border_width,
        color: style.color,
        border_color: style.border_color,
    })
}

fn marked_text(lines: &[TextPosition], style: &BoxStyle) -> Vec<String> {
    let mut ops = vec!["/Tx BMC".to_owned(), "q".to_owned()];
    ops.extend(draw_text_lines(lines, style.text_color, &style.font, style.font_size));
    ops.push("Q".to_owned());
    ops.push("EMC".to_owned());
    ops
}

fn draw_text_field(style: &BoxStyle, lines: &[TextPosition]) -> Vec<String> {
    let mut ops = vec!["q".to_owned()];
    ops.extend(background(style));
    ops.extend(clipping_area(style));
    ops.extend(marked_text(lines, style));
    ops.push("Q".to_owned());
    ops
}

fn draw_option_list(style: &BoxStyle, lines: &[TextPosition], line_height: f64, selected: &[usize], selected_color: Color) -> Vec<String> {
    let mut ops = vec!["q".to_owned()];
    ops.extend(background(style));
    for index in selected {
        let line = &lines[*index];
        ops.extend(draw_rectangle(&RectangleStyle {
            x: line.x - style.padding,
            y: line.y - (line_height - line.height) / 2.0,
            width: style.width - style.border_width,
            height: line.height + (line_height - line.height) / 2.0,
            border_width: 0.0,
            color: Some(selected_color),
            border_color: None,
        }));
    }
    ops.extend(clipping_area(style));
    ops.extend(marked_text(lines, style));
    ops.push("Q".to_owned());
    ops
}

fn draw_button(style: &BoxStyle, line: &TextPosition) -> Vec<String> {
    let mut ops = vec!["q".to_owned()];
    ops.extend(background(style));
    ops.extend(draw_text_lines(std::slice::from_ref(line), style.text_color, &style.font, style.font_size));
    ops.push("Q".to_owned());
    ops
}

// text layout

#[derive(Debug, Clone, Copy)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Alignment {
    Left,
    Center,
    Right,
}

fn alignment_from(quadding: Option<f64>) -> Alignment {
    match quadding {
        Some(q) if q == 1.0 => Alignment::Center,
        Some(q) if q == 2.0 => Alignment::Right,
        _ => Alignment::Left,
    }
}

/// `cleanText`: tabs and the Unicode line separators become four spaces, backspace and vertical tab go.
fn clean_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\t' | '\u{85}' | '\u{2028}' | '\u{2029}' => out.push_str("    "),
            '\u{8}' | '\u{b}' => {}
            other => out.push(other),
        }
    }
    out
}

fn is_line_break(c: char) -> bool {
    matches!(c, '\n' | '\u{c}' | '\r' | '\u{b}')
}

fn merge_lines(text: &str) -> String {
    text.chars().map(|c| if is_line_break(c) { ' ' } else { c }).collect()
}

fn line_split(text: &str) -> Vec<String> {
    text.split(is_line_break).map(str::to_owned).collect()
}

fn compute_font_size(lines: &[String], font: &Font, bounds: Bounds, multiline: bool) -> FormResult<f64> {
    let mut font_size = MIN_FONT_SIZE;
    while font_size < MAX_FONT_SIZE {
        let mut lines_used = 0usize;
        for line in lines {
            lines_used += 1;
            let words: Vec<&str> = line.split(' ').collect();
            let mut space_remaining = bounds.width;
            for (index, word) in words.iter().enumerate() {
                let last = index == words.len() - 1;
                let word = if last { (*word).to_owned() } else { format!("{word} ") };
                let width_of_word = font.width_of_text_at_size(&word, font_size)?;
                space_remaining -= width_of_word;
                if space_remaining <= 0.0 {
                    lines_used += 1;
                    space_remaining = bounds.width - width_of_word;
                }
            }
        }
        if !multiline && lines_used > lines.len() {
            return Ok(font_size - 1.0);
        }
        let height = font.height_at_size(font_size, true);
        let line_height = height + height * 0.2;
        if line_height * lines_used as f64 > bounds.height.abs() {
            return Ok(font_size - 1.0);
        }
        font_size += 1.0;
    }
    Ok(font_size)
}

fn char_at_index(units: &[u16], index: usize) -> (String, usize) {
    let Some(&first) = units.get(index) else {
        return (String::new(), 1);
    };
    let mut length = 1;
    if (0xd800..=0xdbff).contains(&first) {
        if let Some(&second) = units.get(index + 1) {
            if (0xdc00..=0xdfff).contains(&second) {
                length = 2;
            }
        }
    }
    (String::from_utf16_lossy(&units[index..index + length]), length)
}

fn compute_combed_font_size(line: &str, font: &Font, bounds: Bounds, cell_count: f64) -> FormResult<f64> {
    let cell_width = bounds.width / cell_count;
    let cell_height = bounds.height;
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut chars = Vec::new();
    let mut at = 0;
    while at < units.len() {
        let (c, length) = char_at_index(&units, at);
        chars.push(c);
        at += length;
    }
    let mut font_size = MIN_FONT_SIZE;
    while font_size < MAX_FONT_SIZE {
        for c in &chars {
            if font.width_of_text_at_size(c, font_size)? > cell_width * 0.75 {
                return Ok(font_size - 1.0);
            }
        }
        if font.height_at_size(font_size, false) > cell_height {
            return Ok(font_size - 1.0);
        }
        font_size += 1.0;
    }
    Ok(font_size)
}

fn aligned_x(alignment: Alignment, bounds: Bounds, width: f64) -> f64 {
    match alignment {
        Alignment::Left => bounds.x,
        Alignment::Center => bounds.x + (bounds.width / 2.0 - width / 2.0),
        Alignment::Right => bounds.x + bounds.width - width,
    }
}

fn is_unit_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

struct Split {
    line: String,
    encoded: Vec<u8>,
    width: f64,
    remainder: Option<Vec<u16>>,
}

fn split_out_lines(input: &[u16], max_width: f64, font: &Font, font_size: f64) -> FormResult<Split> {
    let mut last = input.len();
    while last > 0 {
        let candidate = &input[..last];
        let line = String::from_utf16_lossy(candidate);
        let encoded = font.encode_text(&line)?;
        let width = font.width_of_text_at_size(&line, font_size)?;
        if width < max_width {
            let rest = &input[last..];
            let remainder = if rest.is_empty() { None } else { Some(rest.to_vec()) };
            return Ok(Split { line, encoded, width, remainder });
        }
        last = (1..candidate.len()).rev().find(|at| is_unit_space(candidate[*at])).unwrap_or(0);
    }
    let line = String::from_utf16_lossy(input);
    Ok(Split { encoded: font.encode_text(&line)?, width: font.width_of_text_at_size(&line, font_size)?, line, remainder: None })
}

struct MultilineLayout {
    lines: Vec<TextPosition>,
    font_size: f64,
    line_height: f64,
}

fn layout_multiline_text(text: &str, alignment: Alignment, font_size: Option<f64>, font: &Font, bounds: Bounds) -> FormResult<MultilineLayout> {
    let lines = line_split(&clean_text(text));
    let font_size = match font_size {
        Some(size) if size != 0.0 => size,
        _ => compute_font_size(&lines, font, bounds, true)?,
    };
    let height = font.height_at_size(font_size, true);
    let line_height = height + height * 0.2;
    let mut positions = Vec::new();
    let mut y = bounds.y + bounds.height;
    for line in &lines {
        let mut previous: Option<Vec<u16>> = Some(line.encode_utf16().collect());
        while let Some(input) = previous {
            let split = split_out_lines(&input, bounds.width, font, font_size)?;
            let x = aligned_x(alignment, bounds, split.width);
            y -= line_height;
            positions.push(TextPosition { encoded: split.encoded, x, y, height, text: split.line });
            previous = split.remainder.map(|rest| {
                let text = String::from_utf16_lossy(&rest);
                js_trim(&text).encode_utf16().collect()
            });
        }
    }
    Ok(MultilineLayout { lines: positions, font_size, line_height })
}

fn layout_singleline_text(text: &str, alignment: Alignment, font_size: Option<f64>, font: &Font, bounds: Bounds) -> FormResult<(TextPosition, f64)> {
    let line = merge_lines(&clean_text(text));
    let font_size = match font_size {
        Some(size) if size != 0.0 => size,
        _ => compute_font_size(std::slice::from_ref(&line), font, bounds, false)?,
    };
    let encoded = font.encode_text(&line)?;
    let width = font.width_of_text_at_size(&line, font_size)?;
    let height = font.height_at_size(font_size, false);
    let x = aligned_x(alignment, bounds, width);
    let y = bounds.y + (bounds.height / 2.0 - height / 2.0);
    Ok((TextPosition { encoded, x, y, height, text: line }, font_size))
}

fn layout_combed_text(text: &str, font_size: Option<f64>, font: &Font, bounds: Bounds, cell_count: f64) -> FormResult<(Vec<TextPosition>, f64)> {
    let line = merge_lines(&clean_text(text));
    let length = utf16_len(&line);
    if (length as f64) > cell_count {
        return Err(FormError::new(format!("Failed to layout combed text as lineLength={length} is greater than cellCount={}", pdf_number(cell_count))));
    }
    let font_size = match font_size {
        Some(size) if size != 0.0 => size,
        _ => compute_combed_font_size(&line, font, bounds, cell_count)?,
    };
    let cell_width = bounds.width / cell_count;
    let height = font.height_at_size(font_size, false);
    let y = bounds.y + (bounds.height / 2.0 - height / 2.0);
    let units: Vec<u16> = line.encode_utf16().collect();
    let mut cells = Vec::new();
    let mut cell_offset = 0.0;
    let mut char_offset = 0usize;
    while cell_offset < cell_count {
        let (character, char_length) = char_at_index(&units, char_offset);
        let encoded = font.encode_text(&character)?;
        let width = font.width_of_text_at_size(&character, font_size)?;
        let cell_center = bounds.x + (cell_width * cell_offset + cell_width / 2.0);
        cells.push(TextPosition { encoded, x: cell_center - width / 2.0, y, height, text: line.clone() });
        cell_offset += 1.0;
        char_offset += char_length;
    }
    Ok((cells, font_size))
}

// default appearance strings

static TF_WITH_SIZE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"/([^\x00\t\n\f\r\x20]+)[\x00\t\n\f\r\x20]+(\d*\.\d+|\d+)[\x00\t\n\f\r\x20]+Tf", ""));

static COLOR_OPERATOR: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r"(\d*\.\d+|\d+)[\x00\t\n\f\r\x20]*(\d*\.\d+|\d+)?[\x00\t\n\f\r\x20]*(\d*\.\d+|\d+)?[\x00\t\n\f\r\x20]*(\d*\.\d+|\d+)?[\x00\t\n\f\r\x20]+(g|rg|k)",
        "",
    )
});

/// `getDefaultFontSize`: the size of the last `Tf` of a default appearance, when it is a number.
pub(crate) fn default_font_size(da: Option<&str>) -> Option<f64> {
    let (_, _, groups) = find_last_match(da.unwrap_or(""), &TF_WITH_SIZE, 2)?;
    let size = mixdog_js::string_to_number(groups.get(2)?.as_deref()?);
    size.is_finite().then_some(size)
}

/// `getDefaultColor`: the last colour operator of a default appearance.
fn default_color(da: Option<&str>) -> Option<Color> {
    let (_, _, groups) = find_last_match(da.unwrap_or(""), &COLOR_OPERATOR, 5)?;
    let number = |at: usize| groups.get(at).and_then(Option::as_deref).filter(|text| !text.is_empty()).map(mixdog_js::string_to_number);
    match groups.get(5).and_then(Option::as_deref)? {
        "g" => number(1).map(Color::Gray),
        "rg" => Some(Color::Rgb(number(1)?, number(2)?, number(3)?)),
        "k" => Some(Color::Cmyk(number(1)?, number(2)?, number(3)?, number(4)?)),
        _ => None,
    }
}

fn update_default_appearance(store: &mut ObjectStore, target: Option<Ref>, color: Color, font: Option<&str>, size: f64) {
    let Some(target) = target else {
        return;
    };
    let da = format!("{}\n{} {} Tf", color.fill(), name_token(font.unwrap_or("dummy__noop")), pdf_number(size));
    set_key(store, target, "DA", latin1_object(&da));
}

// providers

/// `reduceRotation`: the rotation of a widget's `MK` as one of 0, 90, 180 and 270.
fn reduce_rotation(degrees: Option<f64>) -> u32 {
    let quadrants = (degrees.unwrap_or(0.0) / 90.0) % 4.0;
    match quadrants {
        q if q == 0.0 => 0,
        q if q == 1.0 => 90,
        q if q == 2.0 => 180,
        q if q == 3.0 => 270,
        _ => 0,
    }
}

/// What a provider reads of a widget before it draws.
struct WidgetGeometry {
    border_width: f64,
    width: f64,
    height: f64,
    rotate: Vec<String>,
    border_color: Option<Color>,
    normal_background: Option<Color>,
    down_background: Option<Color>,
    widget_color: Option<Color>,
    field_color: Option<Color>,
    widget_font_size: Option<f64>,
    field_font_size: Option<f64>,
}

fn read_geometry(store: &ObjectStore, field: Ref, widget: &Widget) -> FormResult<WidgetGeometry> {
    let widget_da = default_appearance(store, &widget.dict);
    let field_da = store.dict(field).and_then(|dict| default_appearance(store, dict));
    let rectangle = widget_rectangle(store, widget)?;
    let border_width = border_style_width(store, widget).unwrap_or(0.0);
    let rotation = reduce_rotation(characteristic_rotation(store, widget));
    let (width, height) = if rotation == 90 || rotation == 270 { (rectangle.height, rectangle.width) } else { (rectangle.width, rectangle.height) };
    let border = characteristic_components(store, widget, "BC");
    let background = characteristic_components(store, widget, "BG");
    Ok(WidgetGeometry {
        border_width,
        width,
        height,
        rotate: rotate_in_place(rectangle.width, rectangle.height, rotation),
        border_color: components_to_color(border.as_deref(), 1.0),
        normal_background: components_to_color(background.as_deref(), 1.0),
        down_background: components_to_color(background.as_deref(), 0.8),
        widget_color: default_color(widget_da.as_deref()),
        field_color: default_color(field_da.as_deref()),
        widget_font_size: default_font_size(widget_da.as_deref()),
        field_font_size: default_font_size(field_da.as_deref()),
    })
}

/// The operators of the appearances of one widget.
enum Drawn {
    One(Vec<String>),
    Pair { normal: Vec<String>, down: Vec<String> },
    OnOff { normal: (Vec<String>, Vec<String>), down: (Vec<String>, Vec<String>) },
}

fn with_rotation(rotate: &[String], drawn: Vec<String>) -> Vec<String> {
    let mut ops = rotate.to_vec();
    ops.extend(drawn);
    ops
}

fn update_target(widget: &Widget, field: Ref, moved_to_widget: bool) -> Option<Ref> {
    if moved_to_widget { widget.reference } else { Some(field) }
}

fn checkbox_ops(store: &mut ObjectStore, field: Ref, widget: &Widget, radio: bool) -> FormResult<Drawn> {
    let g = read_geometry(store, field, widget)?;
    let border_color = g.border_color.unwrap_or(BLACK);
    let text_color = g.widget_color.or(g.field_color).unwrap_or(BLACK);
    update_default_appearance(store, update_target(widget, field, g.widget_color.is_some()), text_color, None, 0.0);
    let border = g.border_width;
    let draw = |background: Option<Color>, filled: bool| -> Vec<String> {
        let drawn = if radio {
            draw_radio_button(g.width / 2.0, g.height / 2.0, g.width - border, g.height - border, border, text_color, background, Some(border_color), filled)
        } else {
            draw_check_box(border / 2.0, border / 2.0, g.width - border, g.height - border, 1.5, border, text_color, background, Some(border_color), filled)
        };
        with_rotation(&g.rotate, drawn)
    };
    Ok(Drawn::OnOff {
        normal: (draw(g.normal_background, true), draw(g.normal_background, false)),
        down: (draw(g.down_background, true), draw(g.down_background, false)),
    })
}

fn text_style(g: &WidgetGeometry, text_color: Color, font: &str, font_size: f64, padding: f64) -> BoxStyle {
    BoxStyle {
        x: g.border_width / 2.0,
        y: g.border_width / 2.0,
        width: g.width - g.border_width,
        height: g.height - g.border_width,
        border_width: g.border_width,
        color: g.normal_background,
        border_color: g.border_color,
        text_color,
        font: font.to_owned(),
        font_size,
        padding,
    }
}

fn text_bounds(g: &WidgetGeometry, padding: f64) -> Bounds {
    Bounds {
        x: g.border_width + padding,
        y: g.border_width + padding,
        width: g.width - (g.border_width + padding) * 2.0,
        height: g.height - (g.border_width + padding) * 2.0,
    }
}

fn field_number(store: &ObjectStore, field: Ref, key: &str) -> Option<f64> {
    store.dict(field).and_then(|dict| store.lookup(dict, key)).and_then(Obj::as_num)
}

fn text_field_ops(store: &mut ObjectStore, field: Ref, widget: &Widget, font: &FormFont) -> FormResult<Drawn> {
    let g = read_geometry(store, field, widget)?;
    let text = text_value(store, field)?.unwrap_or_default();
    let multiline = has_flag(store, field, FLAG_MULTILINE);
    let max_length = field_number(store, field, "MaxLen");
    let combed = has_flag(store, field, FLAG_COMB)
        && !multiline
        && !has_flag(store, field, FLAG_PASSWORD)
        && !has_flag(store, field, FLAG_FILE_SELECT)
        && max_length.is_some();
    let alignment = alignment_from(field_number(store, field, "Q"));
    let padding = if combed { 0.0 } else { 1.0 };
    let bounds = text_bounds(&g, padding);
    let requested = g.widget_font_size.or(g.field_font_size);
    let (lines, font_size) = if multiline {
        let layout = layout_multiline_text(&text, alignment, requested, &font.font, bounds)?;
        (layout.lines, layout.font_size)
    } else if combed {
        layout_combed_text(&text, requested, &font.font, bounds, max_length.unwrap_or(0.0))?
    } else {
        let (line, size) = layout_singleline_text(&text, alignment, requested, &font.font, bounds)?;
        (vec![line], size)
    };
    let text_color = g.widget_color.or(g.field_color).unwrap_or(BLACK);
    let on_widget = g.widget_color.is_some() || g.widget_font_size.is_some();
    update_default_appearance(store, update_target(widget, field, on_widget), text_color, Some(font.font.name()), font_size);
    let style = text_style(&g, text_color, font.font.name(), font_size, padding);
    Ok(Drawn::One(with_rotation(&g.rotate, draw_text_field(&style, &lines))))
}

fn dropdown_ops(store: &mut ObjectStore, field: Ref, widget: &Widget, font: &FormFont) -> FormResult<Drawn> {
    let g = read_geometry(store, field, widget)?;
    let text = choice_values(store, field).into_iter().next().unwrap_or_default();
    let bounds = text_bounds(&g, 1.0);
    let (line, font_size) = layout_singleline_text(&text, Alignment::Left, g.widget_font_size.or(g.field_font_size), &font.font, bounds)?;
    let text_color = g.widget_color.or(g.field_color).unwrap_or(BLACK);
    let on_widget = g.widget_color.is_some() || g.widget_font_size.is_some();
    update_default_appearance(store, update_target(widget, field, on_widget), text_color, Some(font.font.name()), font_size);
    let style = text_style(&g, text_color, font.font.name(), font_size, 1.0);
    Ok(Drawn::One(with_rotation(&g.rotate, draw_text_field(&style, &[line]))))
}

fn option_list_ops(store: &mut ObjectStore, field: Ref, widget: &Widget, font: &FormFont) -> FormResult<Drawn> {
    let g = read_geometry(store, field, widget)?;
    let mut options: Vec<String> = choice_options(store, field)?.into_iter().map(|(_, display)| display).collect();
    let selected = choice_values(store, field);
    if has_flag(store, field, super::FLAG_SORT) {
        options.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    }
    let text = options.join("\n");
    let bounds = text_bounds(&g, 1.0);
    let layout = layout_multiline_text(&text, Alignment::Left, g.widget_font_size.or(g.field_font_size), &font.font, bounds)?;
    let selected_lines: Vec<usize> = layout.lines.iter().enumerate().filter(|(_, line)| selected.contains(&line.text)).map(|(index, _)| index).collect();
    let blue = Color::Rgb(153.0 / 255.0, 193.0 / 255.0, 218.0 / 255.0);
    let text_color = g.widget_color.or(g.field_color).unwrap_or(BLACK);
    let on_widget = g.widget_color.is_some() || g.widget_font_size.is_some();
    update_default_appearance(store, update_target(widget, field, on_widget), text_color, Some(font.font.name()), layout.font_size);
    let style = text_style(&g, text_color, font.font.name(), layout.font_size, 1.0);
    let drawn = draw_option_list(&style, &layout.lines, layout.line_height, &selected_lines, blue);
    Ok(Drawn::One(with_rotation(&g.rotate, drawn)))
}

fn caption(store: &ObjectStore, widget: &Widget, key: &str) -> Option<String> {
    let mk = match store.lookup(&widget.dict, "MK") {
        Some(Obj::Dict(mk)) => mk.clone(),
        _ => return None,
    };
    match store.lookup(&mk, key) {
        Some(Obj::Str(bytes)) => Some(mixdog_pdf::write::info::decode_text_string(bytes)),
        _ => None,
    }
}

fn button_ops(store: &mut ObjectStore, field: Ref, widget: &Widget, font: &FormFont) -> FormResult<Drawn> {
    let g = read_geometry(store, field, widget)?;
    let normal_text = caption(store, widget, "CA").unwrap_or_default();
    let down_text = caption(store, widget, "AC").unwrap_or_else(|| normal_text.clone());
    let bounds = Bounds { x: g.border_width, y: g.border_width, width: g.width - g.border_width * 2.0, height: g.height - g.border_width * 2.0 };
    let requested = g.widget_font_size.or(g.field_font_size);
    let (normal_line, normal_size) = layout_singleline_text(&normal_text, Alignment::Center, requested, &font.font, bounds)?;
    let (down_line, down_size) = layout_singleline_text(&down_text, Alignment::Center, requested, &font.font, bounds)?;
    let font_size = normal_size.min(down_size);
    let text_color = g.widget_color.or(g.field_color).unwrap_or(BLACK);
    let on_widget = g.widget_color.is_some() || g.widget_font_size.is_some();
    update_default_appearance(store, update_target(widget, field, on_widget), text_color, Some(font.font.name()), font_size);
    let mut style = text_style(&g, text_color, font.font.name(), font_size, 0.0);
    let normal = with_rotation(&g.rotate, draw_button(&style, &normal_line));
    style.color = g.down_background;
    let down = with_rotation(&g.rotate, draw_button(&style, &down_line));
    Ok(Drawn::Pair { normal, down })
}

// writing the streams into the widgets

fn numbers(values: &[f64]) -> Obj {
    Obj::Array(Arc::new(values.iter().map(|value| Obj::Num(*value)).collect()))
}

/// `createAppearanceStream`: a form XObject the size of the widget's rectangle holding `ops`, its resources naming
/// `font` when there is one.
fn create_appearance_stream(store: &mut ObjectStore, widget: &Widget, ops: &[String], font: Option<&FormFont>) -> FormResult<Ref> {
    let rectangle = widget_rectangle(store, widget)?;
    let mut dict = Dict::new();
    dict.set("BBox", numbers(&[0.0, 0.0, rectangle.width, rectangle.height]));
    dict.set("Matrix", numbers(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0]));
    if let Some(font) = font {
        let mut fonts = Dict::new();
        fonts.set(font.font.name(), Obj::Ref(font.reference));
        let mut resources = Dict::new();
        resources.set("Font", Obj::Dict(Arc::new(fonts)));
        dict.set("Resources", Obj::Dict(Arc::new(resources)));
    }
    dict.set("Type", Obj::name("XObject"));
    dict.set("Subtype", Obj::name("Form"));
    let content: String = ops.iter().map(|operator| format!("{operator}\n")).collect();
    Ok(store.register(flate_stream(dict, content.as_bytes())))
}

fn on_off_dictionary(store: &mut ObjectStore, widget: &Widget, pair: &(Vec<String>, Vec<String>), on_value: &str) -> FormResult<Obj> {
    let on = create_appearance_stream(store, widget, &pair.0, None)?;
    let off = create_appearance_stream(store, widget, &pair.1, None)?;
    let mut dict = Dict::new();
    dict.set(on_value, Obj::Ref(on));
    dict.set("Off", Obj::Ref(off));
    Ok(Obj::Dict(Arc::new(dict)))
}

/// `updateWidgetAppearances`: the normal appearance, and the down one when there is one; a rollover appearance is removed.
fn set_widget_appearances(store: &mut ObjectStore, widget: Ref, normal: Obj, down: Option<Obj>) {
    let edit = move |ap: &mut Dict| {
        ap.set("N", normal);
        ap.delete("R");
        match down {
            Some(down) => ap.set("D", down),
            None => ap.delete("D"),
        }
    };
    let indirect = store.dict(widget).and_then(|dict| dict.get_raw("AP")).and_then(Obj::as_ref_value).filter(|reference| store.dict(*reference).is_some());
    if let Some(reference) = indirect {
        store.modify_dict(reference, edit);
        return;
    }
    store.modify_dict(widget, |dict| {
        let mut ap = match dict.get_raw("AP") {
            Some(Obj::Dict(existing)) => (**existing).clone(),
            _ => Dict::new(),
        };
        edit(&mut ap);
        dict.set("AP", Obj::Dict(Arc::new(ap)));
    });
}

/// Draws the appearances of one widget of a field and writes them into it. A widget written inline in its parent's
/// `Kids` cannot be written and is left as it is.
fn update_widget_appearance(store: &mut ObjectStore, field: &Field, widget: &Widget, font: &FormFont, on_value: Option<&str>) -> FormResult<()> {
    let drawn = match field.kind {
        FieldKind::Checkbox => checkbox_ops(store, field.reference, widget, false)?,
        FieldKind::Radio => checkbox_ops(store, field.reference, widget, true)?,
        FieldKind::Text => text_field_ops(store, field.reference, widget, font)?,
        FieldKind::Dropdown => dropdown_ops(store, field.reference, widget, font)?,
        FieldKind::OptionList => option_list_ops(store, field.reference, widget, font)?,
        FieldKind::Button => button_ops(store, field.reference, widget, font)?,
        FieldKind::Signature => return Ok(()),
    };
    let Some(reference) = widget.reference else {
        return Ok(());
    };
    let (normal, down) = match drawn {
        Drawn::One(ops) => (Obj::Ref(create_appearance_stream(store, widget, &ops, Some(font))?), None),
        Drawn::Pair { normal, down } => {
            let normal = create_appearance_stream(store, widget, &normal, Some(font))?;
            let down = create_appearance_stream(store, widget, &down, Some(font))?;
            (Obj::Ref(normal), Some(Obj::Ref(down)))
        }
        Drawn::OnOff { normal, down } => {
            let on_value = on_value.unwrap_or("Yes");
            let normal = on_off_dictionary(store, widget, &normal, on_value)?;
            let down = on_off_dictionary(store, widget, &down, on_value)?;
            (normal, Some(down))
        }
    };
    set_widget_appearances(store, reference, normal, down);
    Ok(())
}

/// Draws the appearance of a widget that was just added to a field (`addToPage`'s call of `updateWidgetAppearance`).
pub(crate) fn draw_new_widget(doc: &mut PdfDocument, field: &Field, widget_ref: Ref, font: &FormFont, on_value: Option<&str>) -> FormResult<()> {
    let store = doc.store_mut();
    let widgets = widgets_of(store, field.reference)?;
    let widget = widgets.into_iter().find(|entry| entry.reference == Some(widget_ref)).ok_or_else(|| FormError::new("the widget is not a kid of its field"))?;
    update_widget_appearance(store, field, &widget, font, on_value)
}

impl PdfForm {
    /// `field.needsAppearancesUpdate()`.
    fn needs_appearance_update(&self, doc: &PdfDocument, field: &Field) -> FormResult<bool> {
        let store = doc.store();
        match field.kind {
            FieldKind::Signature => Ok(false),
            FieldKind::Checkbox | FieldKind::Radio => {
                for widget in widgets_of(store, field.reference)? {
                    let state = match store.lookup(&widget.dict, "AS") {
                        Some(Obj::Name(name)) => Some(name.to_string()),
                        _ => None,
                    };
                    match normal_appearance(store, &widget)? {
                        Some(NormalAppearance::Mapping(mapping)) => {
                            if state.is_some_and(|state| !mapping.has(&state)) {
                                return Ok(true);
                            }
                        }
                        _ => return Ok(true),
                    }
                }
                Ok(false)
            }
            _ => {
                if self.is_dirty(field.reference) {
                    return Ok(true);
                }
                for widget in widgets_of(store, field.reference)? {
                    if !matches!(normal_appearance(store, &widget)?, Some(NormalAppearance::Stream)) {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
        }
    }

    /// `field.defaultUpdateAppearances(font)`.
    fn update_appearances(&mut self, doc: &mut PdfDocument, field: &Field, font: &FormFont) -> FormResult<()> {
        let store = doc.store_mut();
        for widget in widgets_of(store, field.reference)? {
            match field.kind {
                FieldKind::Checkbox => {
                    let on_value = widget_on_value(store, &widget)?.unwrap_or_else(|| "Yes".to_owned());
                    update_widget_appearance(store, field, &widget, font, Some(&on_value))?;
                }
                FieldKind::Radio => {
                    let Some(on_value) = widget_on_value(store, &widget)? else {
                        continue;
                    };
                    update_widget_appearance(store, field, &widget, font, Some(&on_value))?;
                }
                _ => update_widget_appearance(store, field, &widget, font, None)?,
            }
        }
        if !matches!(field.kind, FieldKind::Radio | FieldKind::Button | FieldKind::Signature) {
            self.mark_clean(field.reference);
        }
        Ok(())
    }

    /// `PDFForm.updateFieldAppearances(font)`: every field whose appearance is missing or out of date is drawn again with
    /// `font` (the default font, Helvetica, when none is given).
    pub fn update_field_appearances(&mut self, doc: &mut PdfDocument, font: Option<&FormFont>) -> FormResult<()> {
        let font = match font {
            Some(font) => font.clone(),
            None => self.default_font(doc)?,
        };
        for field in self.fields(doc)? {
            if self.needs_appearance_update(doc, &field)? {
                self.update_appearances(doc, &field, &font)?;
            }
        }
        Ok(())
    }

    /// The `/DA` font size the appearance of a widget was drawn at: the size the field's default appearance names or,
    /// when that is 0 (auto), the size the appearance stream itself sets. 0 when neither says.
    pub(crate) fn appearance_font_size(doc: &PdfDocument, field: &Field, widget: &Widget) -> f64 {
        let store = doc.store();
        let size_of = |content: &str| -> f64 {
            static TF_ANY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"/[^\s/]+\s+([\d.]+)\s+Tf", ""));
            TF_ANY.captures(content).and_then(|caps| caps.get(1).map(mixdog_js::string_to_number)).filter(|size| truthy(*size)).unwrap_or(0.0)
        };
        let declared = store.dict(field.reference).and_then(|dict| default_appearance(store, dict)).map_or(0.0, |da| size_of(&da));
        if declared > 0.0 {
            return declared;
        }
        let Some(Obj::Dict(ap)) = store.lookup(&widget.dict, "AP") else {
            return 0.0;
        };
        let Some(reference) = ap.get_raw("N").and_then(Obj::as_ref_value) else {
            return 0.0;
        };
        let Some(Obj::Stream(stream)) = store.get(reference) else {
            return 0.0;
        };
        let guard = mixdog_pdf::Guard::unbounded();
        match stream.decode(&mixdog_pdf::codec_glue::CodecFilters, &guard) {
            Ok(bytes) => {
                let content: String = bytes.iter().map(|byte| char::from(*byte)).collect();
                size_of(&content)
            }
            Err(_) => 0.0,
        }
    }
}

/// `greedyLineCount`: the lines a value wraps to at `size` in a box `width` wide, breaking at spaces.
pub(crate) fn greedy_line_count(text: &str, font: &Font, size: f64, width: f64) -> FormResult<usize> {
    let mut lines = 0usize;
    for paragraph in text.split(['\n']).map(|part| part.strip_suffix('\r').unwrap_or(part)) {
        let words: Vec<&str> = paragraph.split(|c: char| is_js_space(c)).filter(|word| !word.is_empty()).collect();
        if words.is_empty() {
            lines += 1;
            continue;
        }
        let mut current = String::new();
        lines += 1;
        for word in words {
            let candidate = if current.is_empty() { word.to_owned() } else { format!("{current} {word}") };
            if current.is_empty() || font.width_of_text_at_size(&candidate, size)? <= width {
                current = candidate;
                continue;
            }
            lines += 1;
            current = word.to_owned();
        }
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_appearance_gives_its_last_size_and_colour() {
        assert_eq!(default_font_size(Some("0 g\n/Helv 9 Tf /Helv 12.5 Tf")), Some(12.5));
        assert_eq!(default_font_size(Some("/Helv 0 Tf")), Some(0.0));
        assert_eq!(default_font_size(Some("0 g")), None);
        assert_eq!(default_color(Some("0.3 1 .3 rg\n/Helv 0 Tf")), Some(Color::Rgb(0.3, 1.0, 0.3)));
        assert_eq!(default_color(Some("0.5 g")), Some(Color::Gray(0.5)));
        assert_eq!(default_color(Some("0 1 0 0 k")), Some(Color::Cmyk(0.0, 1.0, 0.0, 0.0)));
        assert_eq!(default_color(None), None);
    }

    #[test]
    fn a_name_keeps_its_regular_characters_only() {
        assert_eq!(name_token("Helvetica"), "/Helvetica");
        assert_eq!(name_token("AB+Font Name"), "/AB+Font#20Name");
        assert_eq!(name_token("A/B"), "/A#2FB");
    }

    #[test]
    fn rotation_is_reduced_to_a_quadrant() {
        assert_eq!(reduce_rotation(None), 0);
        assert_eq!(reduce_rotation(Some(90.0)), 90);
        assert_eq!(reduce_rotation(Some(450.0)), 90);
        assert_eq!(reduce_rotation(Some(270.0)), 270);
        assert_eq!(reduce_rotation(Some(-90.0)), 0);
        assert_eq!(reduce_rotation(Some(45.0)), 0);
    }

    #[test]
    fn text_is_cleaned_and_split_like_pdf_lib() {
        assert_eq!(clean_text("a\tb\u{b}c\u{8}"), "a    bc");
        assert_eq!(line_split("a\r\nb"), ["a", "", "b"]);
        assert_eq!(merge_lines("a\nb\rc"), "a b c");
    }

    #[test]
    fn the_last_whitespace_not_at_the_start_ends_a_line() {
        let units: Vec<u16> = " ab cd".encode_utf16().collect();
        let at = (1..units.len()).rev().find(|at| is_unit_space(units[*at]));
        assert_eq!(at, Some(3));
        assert_eq!(char_at_index(&"a\u{1F600}".encode_utf16().collect::<Vec<_>>(), 1), ("\u{1F600}".to_owned(), 2));
        assert_eq!(char_at_index(&[0x61], 5), (String::new(), 1));
    }
}
