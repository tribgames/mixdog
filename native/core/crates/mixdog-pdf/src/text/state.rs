//! The state `getTextContent` keeps while it reads a content stream: pdf.js's `TextState` (the text state and the
//! current transformation matrix) and the `StateManager` that saves and restores it at `q` and `Q`.

use std::sync::Arc;

use crate::fonts::font::{FONT_IDENTITY_MATRIX, TranslatedFont};
use crate::oplist::gstate::{self, IDENTITY, Matrix};

/// `TextState`. A clone shares the font (the object) and copies the matrices.
#[derive(Clone)]
pub struct TextState {
    pub ctm: Matrix,
    /// `fontName`: the resource name the font was set with (`null` after an `ExtGState` font).
    pub font_name: Option<String>,
    pub font_size: f64,
    pub loaded_name: Option<String>,
    pub font: Option<Arc<TranslatedFont>>,
    pub font_matrix: Matrix,
    pub text_matrix: Matrix,
    pub text_line_matrix: Matrix,
    pub char_spacing: f64,
    pub word_spacing: f64,
    pub leading: f64,
    pub text_h_scale: f64,
    pub text_rise: f64,
}

impl TextState {
    pub fn new() -> Self {
        TextState {
            ctm: IDENTITY,
            font_name: None,
            font_size: 0.0,
            loaded_name: None,
            font: None,
            font_matrix: FONT_IDENTITY_MATRIX,
            text_matrix: IDENTITY,
            text_line_matrix: IDENTITY,
            char_spacing: 0.0,
            word_spacing: 0.0,
            leading: 0.0,
            text_h_scale: 1.0,
            text_rise: 0.0,
        }
    }

    pub fn set_text_matrix(&mut self, m: Matrix) {
        self.text_matrix = m;
    }

    pub fn set_text_line_matrix(&mut self, m: Matrix) {
        self.text_line_matrix = m;
    }

    pub fn translate_text_matrix(&mut self, x: f64, y: f64) {
        let m = &mut self.text_matrix;
        m[4] = m[0] * x + m[2] * y + m[4];
        m[5] = m[1] * x + m[3] * y + m[5];
    }

    pub fn translate_text_line_matrix(&mut self, x: f64, y: f64) {
        let m = &mut self.text_line_matrix;
        m[4] = m[0] * x + m[2] * y + m[4];
        m[5] = m[1] * x + m[3] * y + m[5];
    }

    /// `carriageReturn`: the next line starts one leading down, and the text matrix goes there.
    pub fn carriage_return(&mut self) {
        self.translate_text_line_matrix(0.0, -self.leading);
        self.text_matrix = self.text_line_matrix;
    }

    /// The font's `vertical` (`undefined`, so false, for a font that could not be made).
    pub fn font_is_vertical(&self) -> bool {
        self.font.as_ref().and_then(|font| font.font()).is_some_and(|font| font.vertical)
    }
}

impl Default for TextState {
    fn default() -> Self {
        TextState::new()
    }
}

/// `StateManager`: the current state and the saved ones.
pub struct StateManager {
    pub state: TextState,
    stack: Vec<TextState>,
}

impl StateManager {
    pub fn new(initial: TextState) -> Self {
        StateManager { state: initial, stack: Vec::new() }
    }

    pub fn save(&mut self) {
        let copy = self.state.clone();
        let old = std::mem::replace(&mut self.state, copy);
        self.stack.push(old);
    }

    pub fn restore(&mut self) {
        if let Some(previous) = self.stack.pop() {
            self.state = previous;
        }
    }

    /// `cm`: the matrix is applied before the current one.
    pub fn transform(&mut self, args: &[f64]) {
        self.state.ctm = gstate::transform(&self.state.ctm, args);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carriage_return_moves_the_line_matrix_down_by_the_leading() {
        let mut state = TextState::new();
        state.leading = 14.0;
        state.set_text_line_matrix([1.0, 0.0, 0.0, 1.0, 10.0, 100.0]);
        state.carriage_return();
        assert_eq!(state.text_line_matrix[5], 86.0);
        assert_eq!(state.text_matrix, state.text_line_matrix);
    }

    #[test]
    fn restore_brings_back_the_matrix_and_the_font_size_of_the_save() {
        let mut manager = StateManager::new(TextState::new());
        manager.state.font_size = 10.0;
        manager.save();
        manager.transform(&[2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
        manager.state.font_size = 20.0;
        assert_eq!(manager.state.ctm[0], 2.0);
        manager.restore();
        assert_eq!(manager.state.ctm[0], 1.0);
        assert_eq!(manager.state.font_size, 10.0);
        manager.restore();
        assert_eq!(manager.state.font_size, 10.0);
    }

    #[test]
    fn translating_the_text_matrix_follows_its_scale() {
        let mut state = TextState::new();
        state.set_text_matrix([2.0, 0.0, 0.0, 3.0, 5.0, 7.0]);
        state.translate_text_matrix(1.0, 1.0);
        assert_eq!(state.text_matrix[4], 7.0);
        assert_eq!(state.text_matrix[5], 10.0);
    }
}
