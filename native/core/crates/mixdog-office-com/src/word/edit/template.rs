//! `fill_template` for Word: `Word-StoryRanges` and `Fill-WordTemplate`. Every story of the document and its chain of linked
//! stories is searched; the particles come first and then the token variants, each counted by its matches and replaced
//! through `Find.Execute` with `wdReplaceAll`.
//!
//! The token variants of a story are visited in order of first appearance in its text. The PowerShell host visited them in
//! the order of a .NET hashtable's keys, which depends on the hash codes of the spellings and cannot be reproduced; the order
//! decides nothing but the order the filled counts are listed in when two variants of one token stand in one story.

use super::Com;
use super::Value;
use super::prop;
use super::text_of;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::ps::payload::names_equal;
use crate::ps::pipeline_items;
use crate::template;

/// `Word-StoryRanges`: a duplicate of each story's range and of every range linked after it, for the story types 1 to 17 that
/// the document holds.
fn story_ranges(document: &Obj) -> Vec<Obj> {
    let mut ranges = Vec::new();
    for story_type in 1..=17 {
        let _ = (|| -> Result<()> {
            let mut current = super::item(&document.get("StoryRanges")?, story_type)?;
            while super::is_object(&current) {
                if let Some(copy) = current.member("Duplicate")?.as_obj() {
                    ranges.push(copy.clone());
                }
                current = current.member("NextStoryRange").unwrap_or(Com::Null);
            }
            Ok(())
        })();
    }
    ranges
}

/// `[regex]::Matches($text, [regex]::Escape($pattern)).Count`: the non-overlapping occurrences, and for an empty pattern one
/// at every position.
fn occurrences(text: &str, pattern: &str) -> i32 {
    if pattern.is_empty() {
        return text.encode_utf16().count() as i32 + 1;
    }
    text.matches(pattern).count() as i32
}

/// `$range.Duplicate.Find.Execute(find, ..., replacement, wdReplaceAll)`.
fn replace_all(range: &Com, find: &str, replacement: &str) -> Result<bool> {
    let search = range.member("Duplicate")?;
    let arguments = [
        Com::from(find),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(true),
        Com::I4(0),
        Com::Bool(false),
        Com::from(replacement),
        Com::I4(2),
    ];
    Ok(super::truth(&search.member("Find")?.call_member("Execute", &arguments)?))
}

/// `Fill-WordTemplate`.
pub(super) fn fill_template(document: &Obj, op: &Value) -> Result<Value> {
    let values = template::template_value_map(op).map_err(Error::host)?;
    let mut filled: Vec<(String, i32)> = Vec::new();
    for range in story_ranges(document) {
        let range = Com::Dispatch(range);
        let text = super::string(&range.member("Text")?);
        // The token with its particle first (shared/korean-particles.mjs): "{{company}}은 " lands as 모아페이는.
        for entry in pipeline_items(&prop(op, "particles")) {
            if entry.is_null() {
                continue;
            }
            let find = text_of(&prop(&entry, "find"));
            let count = occurrences(&text, &find);
            if count == 0 {
                continue;
            }
            if replace_all(&range, &find, &text_of(&prop(&entry, "replace")))? {
                template::template_count_filled(&mut filled, &text_of(&prop(&entry, "key")), count);
            }
        }
        let text = super::string(&range.member("Text")?);
        // The variants, by the way each is spelled, in order of first appearance; a later match of the same spelling names
        // the key.
        let mut variants: Vec<(String, String)> = Vec::new();
        for found in template::template_matches(&text) {
            match variants.iter().position(|(raw, _)| names_equal(raw, &found.raw)) {
                Some(at) => variants[at].1 = found.key,
                None => variants.push((found.raw, found.key)),
            }
        }
        for (raw, key) in variants {
            let Some(value) = template::template_value(&values, &key) else { continue };
            let count = occurrences(&text, &raw);
            if count == 0 {
                continue;
            }
            if replace_all(&range, &raw, &text_of(value))? {
                template::template_count_filled(&mut filled, &key, count);
            }
        }
    }
    template::template_result(op, &filled, &story_ranges(document)).map_err(Error::host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occurrences_do_not_overlap_and_an_empty_pattern_matches_everywhere() {
        assert_eq!(occurrences("{{a}} {{a}}", "{{a}}"), 2);
        assert_eq!(occurrences("aaa", "aa"), 1);
        assert_eq!(occurrences("abc", ""), 4);
        assert_eq!(occurrences("abc", "{{a}}"), 0);
    }
}
