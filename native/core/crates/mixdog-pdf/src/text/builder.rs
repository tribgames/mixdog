//! pdf.js's text item builder: what the text operators of `getTextContent` do to the item being built
//! (`buildTextContentItem`, `ensureTextContentItem`, `compareWithLastPosition`, `addFakeSpaces`,
//! `flushTextContentItem`, `resetLastChars`, `appendEOL`, `pushWhitespace`), with pdf.js's thresholds. A glyph that
//! starts outside the page's view box is dropped, as pdf.js drops it.

use mixdog_js::math::hypot;

use crate::error::{PdfError, Result};
use crate::fonts::data::{BidiDir, CharCategory, bidi, normalize_unicode};
use crate::fonts::font::{FONT_IDENTITY_MATRIX, Glyph};
use crate::oplist::gstate::{self, IDENTITY, Matrix};

use super::state::TextState;
use super::{TextContent, TextItem, TextStyle};

const TRACKING_SPACE_FACTOR: f64 = 0.102;
const NOT_A_SPACE_FACTOR: f64 = 0.03;
const NEGATIVE_SPACE_FACTOR: f64 = -0.2;
const SPACE_IN_FLOW_MIN_FACTOR: f64 = 0.102;
const SPACE_IN_FLOW_MAX_FACTOR: f64 = 0.6;
const VERTICAL_SHIFT_RATIO: f64 = 0.25;

/// What a text-showing operator shows (`chars`).
#[derive(Clone, Copy)]
pub enum Chars<'a> {
    /// An empty string (or another value JavaScript calls false): no glyphs, only the spacing moves the text.
    Empty,
    /// The bytes of a string.
    Bytes(&'a [u8]),
    /// A value that is true and not a string: the font finds no glyph in it.
    NoGlyphs,
}

/// JavaScript truthiness of a number.
fn truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// `a || b` over numbers.
fn or(a: f64, b: f64) -> f64 {
    if truthy(a) { a } else { b }
}

/// `Math.sign`.
fn sign(value: f64) -> f64 {
    if value.is_nan() || value == 0.0 {
        value
    } else if value > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// `getCurrentTextTransform`: the text space of the next glyph in the page's space. A Type 3 font whose size is no
/// more than 1 (or whose bounding box came from its glyphs) and whose matrix is not the usual one scales the height
/// by its glyph box.
pub fn current_text_transform(state: &TextState) -> Matrix {
    let mut tsm = [
        state.font_size * state.text_h_scale,
        0.0,
        0.0,
        state.font_size,
        0.0,
        state.text_rise,
    ];
    if let Some(font) = state.font.as_ref().and_then(|font| font.font())
        && font.is_type3_font
        && (state.font_size <= 1.0 || font.is_char_bbox)
        && state.font_matrix != FONT_IDENTITY_MATRIX
    {
        let bbox = font.bbox.unwrap_or([0.0; 4]);
        let glyph_height = bbox[3] - bbox[1];
        if glyph_height > 0.0 {
            tsm[3] *= glyph_height * state.font_matrix[3];
        }
    }
    gstate::transform(&state.ctm, &gstate::transform(&state.text_matrix, &tsm))
}

/// `applyInverseRotation`.
fn apply_inverse_rotation(x: f64, y: f64, matrix: &Matrix) -> (f64, f64) {
    let scale = hypot(&[matrix[0], matrix[1]]);
    (
        (matrix[0] * x + matrix[1] * y) / scale,
        (matrix[2] * x + matrix[3] * y) / scale,
    )
}

/// The category of a glyph's text; a printable ASCII character is none of the three.
fn category_of(glyph: &Glyph) -> CharCategory {
    if let [unit] = glyph.unicode.as_slice()
        && (0x21..0x7f).contains(unit)
    {
        return CharCategory {
            is_whitespace: false,
            is_zero_width_diacritic: false,
            is_invisible_format_mark: false,
        };
    }
    glyph.category()
}

/// `normalizeUnicode` over UTF-16: a lone surrogate stays as it is.
fn normalize_units(units: Vec<u16>) -> Vec<u16> {
    if units.iter().all(|&unit| unit < 0xa0) {
        return units;
    }
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut run = String::new();
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ch) => run.push(ch),
            Err(lone) => {
                out.extend(normalize_unicode(&run).encode_utf16());
                run.clear();
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    out.extend(normalize_unicode(&run).encode_utf16());
    out
}

/// `textContentItem`: the item being built. It lives as long as the stream is read: what a flush leaves (the last
/// position, the advance scale, the thresholds) is what the next glyph is compared with.
struct Chunk {
    initialized: bool,
    units: Vec<u16>,
    /// `str.length`: the number of pieces, not code units.
    pieces: usize,
    total_width: f64,
    total_height: f64,
    width: f64,
    height: f64,
    vertical: bool,
    prev_transform: Option<Matrix>,
    prev_text_rise: f64,
    text_advance_scale: f64,
    space_in_flow_min: f64,
    space_in_flow_max: f64,
    tracking_space_min: f64,
    negative_space_max: f64,
    not_a_space: f64,
    transform: Matrix,
    font_name: Option<String>,
    has_eol: bool,
}

impl Chunk {
    fn new() -> Self {
        Chunk {
            initialized: false,
            units: Vec::new(),
            pieces: 0,
            total_width: 0.0,
            total_height: 0.0,
            width: 0.0,
            height: 0.0,
            vertical: false,
            prev_transform: None,
            prev_text_rise: 0.0,
            text_advance_scale: 0.0,
            space_in_flow_min: 0.0,
            space_in_flow_max: 0.0,
            tracking_space_min: f64::INFINITY,
            negative_space_max: f64::NEG_INFINITY,
            not_a_space: f64::NEG_INFINITY,
            transform: IDENTITY,
            font_name: None,
            has_eol: false,
        }
    }
}

/// The builder of one `getTextContent` call: the item, the last two characters, and the text state the previous
/// show was made with (`currentTextState`).
pub struct Builder<'a> {
    pub sink: &'a mut TextContent,
    view_box: [f64; 4],
    item: Chunk,
    /// `twoLastChars`: whether each of the last two characters is exactly one space.
    two_last: [bool; 2],
    two_last_pos: usize,
    current: Option<TextState>,
}

impl<'a> Builder<'a> {
    pub fn new(sink: &'a mut TextContent, view_box: [f64; 4]) -> Self {
        Builder {
            sink,
            view_box,
            item: Chunk::new(),
            two_last: [true, true],
            two_last_pos: 0,
            current: None,
        }
    }

    /// `currentTextState ||= textState.clone()`.
    pub fn note_state(&mut self, state: &TextState) {
        if self.current.is_none() {
            self.current = Some(state.clone());
        }
    }

    fn save_last_char(&mut self, is_space: bool) -> bool {
        let next = (self.two_last_pos + 1) % 2;
        let ret = !self.two_last[self.two_last_pos] && self.two_last[next];
        self.two_last[self.two_last_pos] = is_space;
        self.two_last_pos = next;
        ret
    }

    fn should_add_whitespace(&self) -> bool {
        !self.two_last[self.two_last_pos] && self.two_last[(self.two_last_pos + 1) % 2]
    }

    fn reset_last_chars(&mut self) {
        self.two_last = [true, true];
        self.two_last_pos = 0;
    }

    fn push_whitespace(
        &mut self,
        width: f64,
        height: f64,
        transform: Option<Matrix>,
        font_name: Option<String>,
    ) {
        let transform = transform.or(self.item.prev_transform).unwrap_or(IDENTITY);
        let font_name = font_name.or_else(|| self.item.font_name.clone());
        self.sink.items.push(TextItem {
            units: vec![0x20],
            dir: BidiDir::Ltr,
            width,
            height,
            transform,
            font_name,
            has_eol: false,
        });
    }

    /// `ensureTextContentItem`: starts an item at the current position (and records the font's style).
    fn ensure_text_content_item(&mut self, state: &TextState) {
        if self.item.initialized {
            return;
        }
        if let (Some(loaded), Some(font)) = (
            &state.loaded_name,
            state.font.as_ref().and_then(|font| font.font()),
        ) && !self.sink.styles.iter().any(|(name, _)| name == loaded)
        {
            self.sink.styles.push((
                loaded.clone(),
                TextStyle {
                    font_family: font.fallback_name.clone(),
                    ascent: font.ascent,
                    descent: font.descent,
                    vertical: font.vertical,
                },
            ));
        }
        self.item.font_name = state.loaded_name.clone();
        let trm = current_text_transform(state);
        self.item.transform = trm;
        if !state.font_is_vertical() {
            self.item.width = 0.0;
            self.item.total_width = 0.0;
            let height = hypot(&[trm[2], trm[3]]);
            self.item.height = height;
            self.item.total_height = height;
            self.item.vertical = false;
        } else {
            let width = hypot(&[trm[0], trm[1]]);
            self.item.width = width;
            self.item.total_width = width;
            self.item.height = 0.0;
            self.item.total_height = 0.0;
            self.item.vertical = true;
        }
        let scale_line_x = hypot(&[state.text_line_matrix[0], state.text_line_matrix[1]]);
        let scale_ctm_x = hypot(&[state.ctm[0], state.ctm[1]]);
        self.item.text_advance_scale = scale_ctm_x * scale_line_x;
        let font_size = state.font_size;
        self.item.tracking_space_min = font_size * TRACKING_SPACE_FACTOR;
        self.item.not_a_space = font_size * NOT_A_SPACE_FACTOR;
        self.item.negative_space_max = font_size * NEGATIVE_SPACE_FACTOR;
        self.item.space_in_flow_min = font_size * SPACE_IN_FLOW_MIN_FACTOR;
        self.item.space_in_flow_max = font_size * SPACE_IN_FLOW_MAX_FACTOR;
        self.item.has_eol = false;
        self.item.initialized = true;
    }

    /// `updateAdvanceScale`: after `Tm` the advance of the item so far is kept at the scale it was made at.
    pub fn update_advance_scale(&mut self, state: &TextState) {
        if !self.item.initialized {
            return;
        }
        let scale_line_x = hypot(&[state.text_line_matrix[0], state.text_line_matrix[1]]);
        let scale_ctm_x = hypot(&[state.ctm[0], state.ctm[1]]);
        let scale_factor = scale_ctm_x * scale_line_x;
        if scale_factor == self.item.text_advance_scale {
            return;
        }
        if !self.item.vertical {
            self.item.total_width += self.item.width * self.item.text_advance_scale;
            self.item.width = 0.0;
        } else {
            self.item.total_height += self.item.height * self.item.text_advance_scale;
            self.item.height = 0.0;
        }
        self.item.text_advance_scale = scale_factor;
    }

    /// `flushTextContentItem` (with `runBidiTransform`): the item becomes a text item, its text normalised and put
    /// in visual order.
    pub fn flush(&mut self) {
        if !self.item.initialized {
            return;
        }
        if !self.item.vertical {
            self.item.total_width += self.item.width * self.item.text_advance_scale;
        } else {
            self.item.total_height += self.item.height * self.item.text_advance_scale;
        }
        let text = normalize_units(std::mem::take(&mut self.item.units));
        let ordered = bidi(&text, None, self.item.vertical);
        self.sink.items.push(TextItem {
            units: ordered.units,
            dir: ordered.dir,
            width: self.item.total_width.abs(),
            height: self.item.total_height.abs(),
            transform: self.item.transform,
            font_name: self.item.font_name.clone(),
            has_eol: self.item.has_eol,
        });
        self.item.initialized = false;
        self.item.pieces = 0;
    }

    fn append_eol(&mut self, state: &TextState) {
        self.reset_last_chars();
        if self.item.initialized {
            self.item.has_eol = true;
            self.flush();
        } else {
            self.sink.items.push(TextItem {
                units: Vec::new(),
                dir: BidiDir::Ltr,
                width: 0.0,
                height: 0.0,
                transform: current_text_transform(state),
                font_name: state.loaded_name.clone(),
                has_eol: true,
            });
        }
    }

    /// `addFakeSpaces`: a gap that is the width of a space inside the flow becomes a space in the item (`false`), a
    /// wider one ends the item and becomes an item of its own (`true`).
    fn add_fake_spaces(
        &mut self,
        state: &TextState,
        width: f64,
        transform: Option<Matrix>,
        text_orientation: f64,
    ) -> bool {
        if text_orientation * self.item.space_in_flow_min <= width
            && width <= text_orientation * self.item.space_in_flow_max
        {
            if self.item.initialized {
                self.reset_last_chars();
                self.item.units.push(0x20);
                self.item.pieces += 1;
            }
            return false;
        }
        let font_name = self.item.font_name.clone();
        let (mut width, mut height) = (width, 0.0);
        if self.item.vertical {
            height = width;
            width = 0.0;
        }
        self.flush();
        self.reset_last_chars();
        let at = transform.unwrap_or_else(|| current_text_transform(state));
        self.push_whitespace(width.abs(), height.abs(), Some(at), font_name);
        true
    }

    /// `compareWithLastPosition`: whether the glyph about to be added is inside the page's view box, and what the
    /// distance to the end of the last one makes of the item (a space, a new item, a new line).
    fn compare_with_last_position(&mut self, state: &TextState, glyph_width: f64) -> bool {
        let current = current_text_transform(state);
        let mut pos_x = current[4];
        let mut pos_y = current[5];
        let view = self.view_box;
        if state.font_is_vertical() {
            if pos_x < view[0] || pos_x > view[2] || pos_y + glyph_width < view[1] || pos_y > view[3]
            {
                return false;
            }
        } else if pos_x + glyph_width < view[0]
            || pos_x > view[2]
            || pos_y < view[1]
            || pos_y > view[3]
        {
            return false;
        }
        let Some(prev) = self.item.prev_transform.filter(|_| state.font.is_some()) else {
            return true;
        };
        let mut last_pos_x = prev[4];
        let mut last_pos_y = prev[5];
        if last_pos_x == pos_x && last_pos_y == pos_y {
            return true;
        }
        let mut rotate = -1;
        if truthy(current[0]) && current[1] == 0.0 && current[2] == 0.0 {
            rotate = if current[0] > 0.0 { 0 } else { 180 };
        } else if truthy(current[1]) && current[0] == 0.0 && current[3] == 0.0 {
            rotate = if current[1] > 0.0 { 90 } else { 270 };
        }
        match rotate {
            0 => {}
            90 => {
                (pos_x, pos_y) = (pos_y, pos_x);
                (last_pos_x, last_pos_y) = (last_pos_y, last_pos_x);
            }
            180 => {
                (pos_x, pos_y, last_pos_x, last_pos_y) = (-pos_x, -pos_y, -last_pos_x, -last_pos_y);
            }
            270 => {
                (pos_x, pos_y) = (-pos_y, -pos_x);
                (last_pos_x, last_pos_y) = (-last_pos_y, -last_pos_x);
            }
            _ => {
                (pos_x, pos_y) = apply_inverse_rotation(pos_x, pos_y, &current);
                (last_pos_x, last_pos_y) = apply_inverse_rotation(last_pos_x, last_pos_y, &prev);
            }
        }
        if state.font_is_vertical() {
            let advance_y = (last_pos_y - pos_y) / self.item.text_advance_scale;
            let advance_x = pos_x - last_pos_x;
            let text_orientation = sign(or(self.item.height, self.item.total_height));
            if advance_y < text_orientation * self.item.negative_space_max {
                if advance_x.abs() > 0.5 * self.item.width {
                    self.append_eol(state);
                    return true;
                }
                self.reset_last_chars();
                self.flush();
                return true;
            }
            if advance_x.abs() > self.item.width {
                self.append_eol(state);
                return true;
            }
            if advance_y <= text_orientation * self.item.not_a_space {
                self.reset_last_chars();
            }
            if advance_y <= text_orientation * self.item.tracking_space_min {
                if self.should_add_whitespace() {
                    self.reset_last_chars();
                    self.flush();
                    self.push_whitespace(0.0, advance_y.abs(), None, None);
                } else {
                    self.item.height += advance_y;
                }
            } else if !self.add_fake_spaces(state, advance_y, self.item.prev_transform, text_orientation)
            {
                if self.item.pieces == 0 {
                    self.reset_last_chars();
                    self.push_whitespace(0.0, advance_y.abs(), None, None);
                } else {
                    self.item.height += advance_y;
                }
            }
            if advance_x.abs() > self.item.width * VERTICAL_SHIFT_RATIO {
                self.flush();
            }
            return true;
        }
        let advance_x = (pos_x - last_pos_x) / self.item.text_advance_scale;
        let advance_y = pos_y - last_pos_y;
        let text_orientation = sign(or(self.item.width, self.item.total_width));
        if advance_x < text_orientation * self.item.negative_space_max {
            if advance_y.abs() > 0.5 * self.item.height {
                self.append_eol(state);
                return true;
            }
            self.reset_last_chars();
            self.flush();
            return true;
        }
        let text_rise_delta = state.text_rise - self.item.prev_text_rise;
        let advance_y_corrected = if text_rise_delta == 0.0 {
            advance_y
        } else {
            advance_y - current[3] / state.font_size * text_rise_delta
        };
        if advance_y_corrected.abs() > self.item.height {
            self.append_eol(state);
            return true;
        }
        if advance_x <= text_orientation * self.item.not_a_space {
            self.reset_last_chars();
        }
        if advance_x <= text_orientation * self.item.tracking_space_min {
            if self.should_add_whitespace() {
                self.reset_last_chars();
                self.flush();
                self.push_whitespace(advance_x.abs(), 0.0, None, None);
            } else {
                self.item.width += advance_x;
            }
        } else if !self.add_fake_spaces(state, advance_x, self.item.prev_transform, text_orientation)
        {
            if self.item.pieces == 0 {
                self.reset_last_chars();
                self.push_whitespace(advance_x.abs(), 0.0, None, None);
            } else {
                self.item.width += advance_x;
            }
        }
        if advance_y.abs() > self.item.height * VERTICAL_SHIFT_RATIO {
            self.flush();
        }
        true
    }

    /// `buildTextContentItem`: shows `chars` with `extra_spacing` added after the last glyph (the number of a `TJ`
    /// array, in text space units). The text state moves past what was shown.
    pub fn build_text_content_item(
        &mut self,
        state: &mut TextState,
        chars: Chars<'_>,
        extra_spacing: f64,
    ) -> Result<()> {
        let font_changed = match &self.current {
            Some(current) => {
                current.font_size != state.font_size
                    || (current.font_name != state.font_name && Self::fonts_differ(current, state)?)
            }
            None => false,
        };
        if font_changed {
            self.flush();
            self.current = Some(state.clone());
        }
        let Some(font) = state.font.clone() else {
            return Err(PdfError::Unknown(
                "Cannot read properties of null (reading 'vertical')".to_owned(),
            ));
        };
        let vertical = state.font_is_vertical();
        let base_char_spacing = if vertical {
            -state.char_spacing
        } else {
            state.char_spacing
        };
        let bytes = match chars {
            Chars::Empty => {
                let char_spacing = base_char_spacing + extra_spacing;
                if truthy(char_spacing) {
                    if !vertical {
                        state.translate_text_matrix(char_spacing * state.text_h_scale, 0.0);
                    } else {
                        state.translate_text_matrix(0.0, -char_spacing);
                    }
                }
                return Ok(());
            }
            Chars::NoGlyphs => return Ok(()),
            Chars::Bytes(bytes) => bytes,
        };
        let glyphs = font.chars_to_glyphs(bytes);
        let scale = state.font_matrix[0] * state.font_size;
        let count = glyphs.len();
        for (i, glyph) in glyphs.iter().enumerate() {
            let category = category_of(glyph);
            if category.is_invisible_format_mark {
                continue;
            }
            let mut char_spacing = base_char_spacing + if i + 1 == count { extra_spacing } else { 0.0 };
            let glyph_width = if vertical {
                match glyph.vmetric {
                    Some(vmetric) => vmetric[0],
                    None => {
                        return Err(PdfError::Unknown(
                            "Cannot read properties of undefined (reading '0')".to_owned(),
                        ));
                    }
                }
            } else {
                glyph.width
            };
            let mut scaled_dim = glyph_width * scale;
            if glyph.original_char_code == 0x20 {
                char_spacing += state.word_spacing;
            }
            if category.is_whitespace {
                if !vertical {
                    char_spacing += scaled_dim;
                    state.translate_text_matrix(char_spacing * state.text_h_scale, 0.0);
                } else {
                    char_spacing += -scaled_dim;
                    state.translate_text_matrix(0.0, -char_spacing);
                }
                self.save_last_char(true);
                continue;
            }
            if !category.is_zero_width_diacritic && !self.compare_with_last_position(state, scaled_dim)
            {
                if !vertical {
                    state.translate_text_matrix(scaled_dim * state.text_h_scale, 0.0);
                } else {
                    state.translate_text_matrix(0.0, scaled_dim);
                }
                continue;
            }
            self.ensure_text_content_item(state);
            if category.is_zero_width_diacritic {
                scaled_dim = 0.0;
            }
            if !vertical {
                scaled_dim *= state.text_h_scale;
                state.translate_text_matrix(scaled_dim, 0.0);
                self.item.width += scaled_dim;
            } else {
                state.translate_text_matrix(0.0, scaled_dim);
                scaled_dim = scaled_dim.abs();
                self.item.height += scaled_dim;
            }
            if truthy(scaled_dim) {
                self.item.prev_transform = Some(current_text_transform(state));
                self.item.prev_text_rise = state.text_rise;
            }
            if self.save_last_char(glyph.unicode.as_slice() == [0x20]) {
                self.item.units.push(0x20);
                self.item.pieces += 1;
            }
            self.item.units.extend_from_slice(&glyph.unicode);
            self.item.pieces += 1;
            if truthy(char_spacing) {
                if !vertical {
                    state.translate_text_matrix(char_spacing * state.text_h_scale, 0.0);
                } else {
                    state.translate_text_matrix(0.0, -char_spacing);
                }
            }
        }
        Ok(())
    }

    /// `currentTextState.font.name !== textState.font.name || currentTextState.font.vertical !==
    /// textState.font.vertical`: a font that could not be made has neither.
    fn fonts_differ(current: &TextState, state: &TextState) -> Result<bool> {
        let (Some(before), Some(now)) = (&current.font, &state.font) else {
            return Err(PdfError::Unknown(
                "Cannot read properties of null (reading 'name')".to_owned(),
            ));
        };
        let name = |font: &crate::fonts::font::TranslatedFont| font.font().map(|f| f.name.clone());
        let vertical = |font: &crate::fonts::font::TranslatedFont| font.font().map(|f| f.vertical);
        Ok(name(before.as_ref()) != name(now.as_ref())
            || vertical(before.as_ref()) != vertical(now.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sign_of_zero_and_nan_is_themselves() {
        assert_eq!(sign(3.0), 1.0);
        assert_eq!(sign(-0.5), -1.0);
        assert_eq!(sign(0.0), 0.0);
        assert!(sign(f64::NAN).is_nan());
    }

    #[test]
    fn or_takes_the_second_for_zero_and_nan() {
        assert_eq!(or(0.0, 5.0), 5.0);
        assert_eq!(or(f64::NAN, 5.0), 5.0);
        assert_eq!(or(2.0, 5.0), 2.0);
    }

    #[test]
    fn the_last_two_characters_ask_for_a_space_after_a_word_and_a_space() {
        let mut content = TextContent::default();
        let mut builder = Builder::new(&mut content, [0.0, 0.0, 100.0, 100.0]);
        assert!(!builder.save_last_char(false));
        assert!(!builder.save_last_char(true));
        assert!(builder.should_add_whitespace());
        assert!(builder.save_last_char(false));
        builder.reset_last_chars();
        assert!(!builder.should_add_whitespace());
    }

    #[test]
    fn normalisation_leaves_a_lone_surrogate_and_rewrites_a_ligature() {
        let mut units: Vec<u16> = "a\u{fb01}b".encode_utf16().collect();
        units.push(0xd800);
        let out = normalize_units(units);
        let mut expected: Vec<u16> = "afib".encode_utf16().collect();
        expected.push(0xd800);
        assert_eq!(out, expected);
        let plain: Vec<u16> = "plain".encode_utf16().collect();
        assert_eq!(normalize_units(plain.clone()), plain);
    }

    #[test]
    fn an_item_is_flushed_with_its_width_and_the_flag_of_the_line_end() {
        let mut content = TextContent::default();
        let mut builder = Builder::new(&mut content, [0.0, 0.0, 100.0, 100.0]);
        let state = TextState::new();
        builder.item.initialized = true;
        builder.item.units = "ab".encode_utf16().collect();
        builder.item.pieces = 2;
        builder.item.width = 3.0;
        builder.item.text_advance_scale = 2.0;
        builder.item.height = 12.0;
        builder.item.total_height = 12.0;
        builder.append_eol(&state);
        assert_eq!(content.items.len(), 1);
        let item = &content.items[0];
        assert_eq!(item.text(), "ab");
        assert!(item.has_eol);
        assert_eq!(item.width, 6.0);
        assert_eq!(item.height, 12.0);
    }
}
