//! `fill_template` over a deck: `PowerPoint-ShapeTextRanges`, `PowerPoint-TextRanges` and `Fill-PowerPointTemplate`.

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ppt::truth;
use crate::ps::Value;
use crate::ps::payload;
use crate::template::template_count_filled;
use crate::template::template_matches;
use crate::template::template_result;
use crate::template::template_value;
use crate::template::template_value_map;

use super::array_of;
use super::attempt;
use super::bstr;
use super::count;
use super::i4;
use super::int_value;
use super::item;
use super::items;
use super::prop;
use super::string_value;
use super::text_of;
use super::walk;

/// `PowerPoint-ShapeTextRanges`: the text range of a shape's frame, of every cell of its table, and of every shape of its
/// group (recursively). Each part is read inside the failure the script tolerates, and what was gathered before it stays.
pub(crate) fn shape_text_ranges(shape: &Com) -> Vec<Com> {
    let mut ranges: Vec<Com> = Vec::new();
    attempt(|| {
        if truth(&shape.member("HasTextFrame")?) && truth(&walk(shape, &["TextFrame", "HasText"])?) {
            ranges.push(walk(shape, &["TextFrame", "TextRange"])?);
        }
        Ok(())
    });
    attempt(|| {
        if truth(&shape.member("HasTable")?) {
            let mut row = 1;
            while row <= count(&walk(shape, &["Table", "Rows"])?)? {
                let mut column = 1;
                while column <= count(&walk(shape, &["Table", "Columns"])?)? {
                    let cell = shape.member("Table")?.call_member("Cell", &[i4(row), i4(column)])?;
                    ranges.push(walk(&cell, &["Shape", "TextFrame", "TextRange"])?);
                    column += 1;
                }
                row += 1;
            }
        }
        Ok(())
    });
    attempt(|| {
        if int_value(&shape.member("Type")?)? == 6 {
            let mut index = 1;
            while index <= count(&shape.member("GroupItems")?)? {
                let member = item(&shape.member("GroupItems")?, index)?;
                ranges.extend(shape_text_ranges(&member));
                index += 1;
            }
        }
        Ok(())
    });
    ranges
}

/// `PowerPoint-TextRanges`: the text ranges of every slide and of its notes page.
pub(crate) fn text_ranges(presentation: &Com) -> Result<Vec<Com>> {
    let mut ranges: Vec<Com> = Vec::new();
    for slide in items(&presentation.member("Slides")?)? {
        for shape in items(&slide.member("Shapes")?)? {
            ranges.extend(shape_text_ranges(&shape));
        }
        attempt(|| {
            for shape in items(&walk(&slide, &["NotesPage", "Shapes"])?)? {
                ranges.extend(shape_text_ranges(&shape));
            }
            Ok(())
        });
    }
    Ok(ranges)
}

/// How many times `needle` occurs in `text` (`[regex]::Matches($text, [regex]::Escape($needle)).Count`): non-overlapping, and
/// an empty needle matches between every two UTF-16 units and at both ends.
fn occurrences(text: &str, needle: &str) -> i32 {
    if needle.is_empty() {
        return text.encode_utf16().count() as i32 + 1;
    }
    text.matches(needle).count() as i32
}

/// `$range.Replace` once per occurrence, each search starting after the previous replacement. Answers how many were replaced.
fn replace_all_in(range: &Com, find: &str, replacement: &str, expected: i32) -> Result<i32> {
    let mut replaced = 0;
    let mut after = 0;
    while replaced < expected {
        let found = range.call_member("Replace", &[bstr(find), bstr(replacement), i4(after), i4(0), i4(0)])?;
        if found.is_null() {
            break;
        }
        replaced += 1;
        let start = int_value(&found.member("Start")?)?;
        let length = int_value(&found.member("Length")?)?;
        after = start + length.max(1) - 1;
    }
    Ok(replaced)
}

/// `Fill-PowerPointTemplate`: each token's particle form first (the token with its particle: "{{company}}은 " lands as 모아페이는),
/// then each token as the text holds it, in the order of first appearance.
pub(crate) fn fill_powerpoint_template(presentation: &Com, op: &Value) -> Result<Value> {
    let values = template_value_map(op).map_err(Error::host)?;
    let mut filled: Vec<(String, i32)> = Vec::new();
    for range in text_ranges(presentation)? {
        let content = string_value(&range.member("Text")?);
        for entry in array_of(&prop(op, "particles")) {
            if entry.is_null() {
                continue;
            }
            let find = text_of(&prop(&entry, "find"));
            let expected = occurrences(&content, &find);
            let replaced = replace_all_in(&range, &find, &text_of(&prop(&entry, "replace")), expected)?;
            if replaced > 0 {
                template_count_filled(&mut filled, &text_of(&prop(&entry, "key")), replaced);
            }
        }
        let content = string_value(&range.member("Text")?);
        let mut variants: Vec<(String, String)> = Vec::new();
        for found in template_matches(&content) {
            match variants.iter().position(|(raw, _)| payload::names_equal(raw, &found.raw)) {
                Some(at) => variants[at].1 = found.key,
                None => variants.push((found.raw, found.key)),
            }
        }
        for (raw, key) in variants {
            let Some(value) = template_value(&values, &key) else { continue };
            let expected = occurrences(&content, &raw);
            let replaced = replace_all_in(&range, &raw, &text_of(value), expected)?;
            if replaced > 0 {
                template_count_filled(&mut filled, &key, replaced);
            }
        }
    }
    let remaining: Vec<Obj> = text_ranges(presentation)?.iter().filter_map(|range| range.as_obj().cloned()).collect();
    template_result(op, &filled, &remaining).map_err(Error::host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occurrences_are_counted_without_overlap_and_an_empty_needle_between_units() {
        assert_eq!(occurrences("aaaa", "aa"), 2);
        assert_eq!(occurrences("{{a}} and {{a}}", "{{a}}"), 2);
        assert_eq!(occurrences("abc", ""), 4);
        assert_eq!(occurrences("abc", "d"), 0);
        assert_eq!(occurrences("A", "a"), 0);
    }
}
