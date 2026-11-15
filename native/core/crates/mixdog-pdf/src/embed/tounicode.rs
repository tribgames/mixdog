//! The ToUnicode CMap of an embedded face, written the way pdf-lib's `createCmap` writes it: one `bfchar` line per
//! glyph of the subset, the glyph's id on the left and the UTF-16BE of the characters it was first met for on the right.

use std::fmt::Write;

/// One glyph of the subset: its id in the subset font (the character code of the Identity-H string) and the code
/// points it stands for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlyphUnicode {
    pub glyph_id: u16,
    pub code_points: Vec<u32>,
}

fn code_point_hex(code_point: u32) -> String {
    if code_point <= 0xFFFF {
        format!("{code_point:04X}")
    } else {
        let high = (code_point - 0x10000) / 0x400 + 0xD800;
        let low = (code_point - 0x10000) % 0x400 + 0xDC00;
        format!("{high:04X}{low:04X}")
    }
}

/// The CMap text for `glyphs` (in subset order, `.notdef` left out).
pub fn create_cmap(glyphs: &[GlyphUnicode]) -> String {
    let mut lines = Vec::with_capacity(glyphs.len());
    for glyph in glyphs {
        let mut unicode = String::from("<");
        for code_point in &glyph.code_points {
            unicode.push_str(&code_point_hex(*code_point));
        }
        unicode.push('>');
        let mut line = String::new();
        let _ = write!(line, "<{:04X}> {unicode}", glyph.glyph_id);
        lines.push(line);
    }
    format!(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <<\n  /Registry (Adobe)\n  /Ordering (UCS)\n  /Supplement 0\n>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange\n{} beginbfchar\n{}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend",
        glyphs.len(),
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_ids_and_utf16_hex() {
        let text = create_cmap(&[
            GlyphUnicode {
                glyph_id: 1,
                code_points: vec![0x48],
            },
            GlyphUnicode {
                glyph_id: 2,
                code_points: vec![0x1F600],
            },
            GlyphUnicode {
                glyph_id: 11,
                code_points: vec![0x66, 0x69],
            },
        ]);
        assert!(text.contains(
            "3 beginbfchar\n<0001> <0048>\n<0002> <D83DDE00>\n<000B> <00660069>\nendbfchar"
        ));
        assert!(
            text.starts_with("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n")
        );
        assert!(text.ends_with("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend"));
    }

    #[test]
    fn no_glyph_leaves_an_empty_line() {
        assert!(create_cmap(&[]).contains("0 beginbfchar\n\nendbfchar"));
    }
}
