//! Grapheme clusters with their widths, cluster boundaries, and the conversion between UTF-16 offsets (how Node
//! indexes a string) and byte offsets (how Rust does).
//!
//! Clusters are Unicode extended grapheme clusters, the cut `Intl.Segmenter` makes. Widths are the display widths of
//! the process policy ([`crate::policy::display_width`]). Word boundaries are not here: the editor's word motions are
//! ported with the editor.

use unicode_segmentation::{GraphemeCursor, UnicodeSegmentation};

use crate::policy::display_width;

use crate::lone::units_of;
pub use crate::lone::utf16_len;

/// A grapheme cluster of a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grapheme<'a> {
    pub text: &'a str,
    /// Byte offset of the cluster in the text.
    pub start: usize,
    /// Cells the cluster occupies under the display-width policy.
    pub width: usize,
}

/// The clusters of `text`, in order, with their byte offsets and widths.
pub fn graphemes_with_widths(text: &str) -> Vec<Grapheme<'_>> {
    text.grapheme_indices(true).map(|(start, cluster)| Grapheme { text: cluster, start, width: display_width(cluster) }).collect()
}

/// The nearest char boundary at or before `at` (clamped to the length of `text`).
fn floor_boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The first cluster boundary after `at`, or the end of `text`.
pub fn next_boundary(text: &str, at: usize) -> usize {
    let at = floor_boundary(text, at);
    if at >= text.len() {
        return text.len();
    }
    GraphemeCursor::new(at, text.len(), true).next_boundary(text, 0).ok().flatten().unwrap_or(text.len())
}

/// The last cluster boundary before `at`, or 0.
pub fn prev_boundary(text: &str, at: usize) -> usize {
    let at = floor_boundary(text, at);
    if at == 0 {
        return 0;
    }
    GraphemeCursor::new(at, text.len(), true).prev_boundary(text, 0).ok().flatten().unwrap_or(0)
}

/// The byte offset of UTF-16 offset `units` of `text`. An offset past the end gives the length; an offset inside a
/// surrogate pair (a position a Rust string cannot hold) gives the start of that character.
pub fn utf16_to_byte(text: &str, units: usize) -> usize {
    let mut seen = 0;
    for (at, ch) in text.char_indices() {
        let next = seen + units_of(ch);
        if next > units {
            return at;
        }
        seen = next;
    }
    text.len()
}

/// The UTF-16 offset of byte offset `at` of `text` (rounded down to a char boundary, clamped to the length).
pub fn byte_to_utf16(text: &str, at: usize) -> usize {
    utf16_len(&text[..floor_boundary(text, at)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clusters_carry_offsets_and_widths() {
        let clusters = graphemes_with_widths("a日e\u{301}🙂");
        let shape: Vec<(&str, usize, usize)> = clusters.iter().map(|g| (g.text, g.start, g.width)).collect();
        assert_eq!(shape, [("a", 0, 1), ("日", 1, 2), ("e\u{301}", 4, 1), ("🙂", 7, 2)]);
    }

    #[test]
    fn boundaries_step_over_whole_clusters() {
        let text = "ae\u{301}🇯🇵b";
        assert_eq!(next_boundary(text, 0), 1);
        assert_eq!(next_boundary(text, 1), 4);
        assert_eq!(next_boundary(text, 4), 12);
        assert_eq!(next_boundary(text, 12), 13);
        assert_eq!(next_boundary(text, 13), 13);
        assert_eq!(prev_boundary(text, 13), 12);
        assert_eq!(prev_boundary(text, 12), 4);
        assert_eq!(prev_boundary(text, 4), 1);
        assert_eq!(prev_boundary(text, 0), 0);
    }

    #[test]
    fn a_boundary_asked_inside_a_character_starts_from_its_start() {
        assert_eq!(next_boundary("日本", 1), 3);
        assert_eq!(prev_boundary("日本", 4), 0);
    }

    #[test]
    fn utf16_offsets_round_trip_with_byte_offsets() {
        let text = "a日🙂b";
        assert_eq!(utf16_len(text), 5);
        assert_eq!(utf16_to_byte(text, 0), 0);
        assert_eq!(utf16_to_byte(text, 2), 4);
        assert_eq!(utf16_to_byte(text, 3), 4, "inside a surrogate pair");
        assert_eq!(utf16_to_byte(text, 4), 8);
        assert_eq!(utf16_to_byte(text, 99), text.len());
        assert_eq!(byte_to_utf16(text, 4), 2);
        assert_eq!(byte_to_utf16(text, 8), 4);
        assert_eq!(byte_to_utf16(text, 99), 5);
        assert_eq!(byte_to_utf16(text, 5), 2, "inside a character");
    }
}
