//! The draft the editor edits.

/// The text of the prompt box with its caret and selection anchor, both offsets in UTF-16 units.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Draft {
    pub value: String,
    pub cursor: usize,
    /// The fixed end of a selection; the selection runs between it and `cursor`.
    pub selection_anchor: Option<usize>,
}

impl Draft {
    pub fn new(value: impl Into<String>, cursor: usize, selection_anchor: Option<usize>) -> Self {
        Self { value: value.into(), cursor, selection_anchor }
    }

    /// A draft with the caret after its last character.
    pub fn at_end(value: impl Into<String>) -> Self {
        let value = value.into();
        let cursor = mixdog_js::utf16_len(&value);
        Self { value, cursor, selection_anchor: None }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    /// The length of the value in UTF-16 units.
    pub fn len16(&self) -> usize {
        mixdog_js::utf16_len(&self.value)
    }
}
