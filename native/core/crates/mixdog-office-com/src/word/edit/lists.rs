//! The list helpers of `office-com-host.ps1`: the document's own bullet, number and Korean number templates (found by name
//! before one is added), the numbering a new list counts in, `Apply-WordNumber`, `Apply-WordBullet` and `Reset-WordParagraph`.

use super::Com;
use super::Para;
use super::Value;
use super::is_object;
use super::item;
use super::same;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::ps::text;

/// `[string]$existing.Name -eq $name` over the document's list templates: the template already added, if any.
fn find_template(document: &Obj, name: &str) -> Result<Option<Com>> {
    for existing in super::items_of(&document.get("ListTemplates")?)? {
        let named = existing.member("Name").map(|value| same(&super::string(&value), name));
        if named.unwrap_or(false) {
            return Ok(Some(existing));
        }
    }
    Ok(None)
}

fn add_template(document: &Obj, name: &str) -> Result<Com> {
    document.get("ListTemplates")?.call_member("Add", &[Com::Bool(true), Com::from(name)])
}

/// The hanging indents of level `level` the three templates share, and the trailing character.
fn set_level_positions(entry: &Com, level: i32) -> Result<()> {
    entry.set_member("NumberPosition", Com::R4((36 * level - 18) as f32))?;
    entry.set_member("TextPosition", Com::R4((36 * level) as f32))?;
    entry.set_member("TabPosition", Com::R4((36 * level) as f32))?;
    entry.set_member("TrailingCharacter", Com::I4(0))
}

/// `Get-WordBulletTemplate`: the same marks, face and hanging indent the portable numbering part writes.
pub(super) fn bullet_template(document: &Obj) -> Result<Com> {
    if let Some(existing) = find_template(document, "MixdogBullet")? {
        return Ok(existing);
    }
    let template = add_template(document, "MixdogBullet")?;
    let marks = ["\u{2022}", "\u{25E6}", "\u{25AA}"];
    for level in 1..=3 {
        let entry = item(&template.member("ListLevels")?, level)?;
        // A literal mark with no %n placeholder is the bullet; setting NumberStyle to the bullet style on an outline
        // template throws.
        entry.set_member("NumberFormat", Com::from(marks[(level - 1) as usize]))?;
        entry.member("Font")?.set_member("Name", Com::from("Arial"))?;
        set_level_positions(&entry, level)?;
    }
    Ok(template)
}

/// The numbered templates differ in their names and the format and style of each level.
fn numbered_template(document: &Obj, name: &str, levels: [(&str, i32); 3]) -> Result<Com> {
    if let Some(existing) = find_template(document, name)? {
        return Ok(existing);
    }
    let template = add_template(document, name)?;
    for level in 1..=3 {
        let entry = item(&template.member("ListLevels")?, level)?;
        let (format, style) = levels[(level - 1) as usize];
        entry.set_member("NumberFormat", Com::from(format))?;
        entry.set_member("NumberStyle", Com::I4(style))?;
        entry.set_member("StartAt", Com::I4(1))?;
        set_level_positions(&entry, level)?;
    }
    Ok(template)
}

/// `Get-WordNumberTemplate`: 1. / a. / i. (wdListNumberStyleArabic, LowercaseLetter, LowercaseRoman).
pub(super) fn number_template(document: &Obj) -> Result<Com> {
    numbered_template(document, "MixdogNumber", [("%1.", 0), ("%2.", 4), ("%3.", 2)])
}

/// `Get-WordKoreanNumberTemplate`: 1. / 가. / 1) (Word's Ganada style, 24).
pub(super) fn korean_number_template(document: &Obj) -> Result<Com> {
    numbered_template(document, "MixdogNumberKo", [("%1.", 0), ("%2.", 24), ("%3)", 0)])
}

/// `Invoke-WordListInStyle`: Word's own "Use Normal style for bulleted or numbered lists" keeps a named style on the item;
/// it is an application setting, so it holds only while the list is applied and the user's value comes back.
pub(super) fn in_list_style<T>(document: &Obj, apply: impl FnOnce() -> Result<T>) -> Result<T> {
    let options = document.get("Application")?.member("Options")?;
    let mut user_setting = options.member("UseNormalStyleForList").ok().map(|value| super::truth(&value));
    if user_setting == Some(false) && options.set_member("UseNormalStyleForList", Com::Bool(true)).is_err() {
        user_setting = None;
    }
    let outcome = apply();
    if user_setting == Some(false) {
        let _ = options.set_member("UseNormalStyleForList", Com::Bool(false));
    }
    outcome
}

/// `Word-NumberedListScheme`: a list that opens on Korean text counts 1. 가. 1), any other the global 1. a. i.;
/// listNumbering names it outright.
pub(super) fn numbered_list_scheme(words: &str, named: &Value) -> Result<&'static str> {
    let scheme = text::to_lower_invariant(&super::text_of(named));
    match scheme.as_str() {
        "korean" => return Ok("korean"),
        "global" => return Ok("global"),
        "" => {}
        _ => return Err(Error::host(format!("listNumbering must be 'korean' or 'global', not \"{}\"", super::text_of(named)))),
    }
    let hangul = words.chars().any(|letter| ('\u{AC00}'..='\u{D7A3}').contains(&letter));
    Ok(if hangul { "korean" } else { "global" })
}

/// `Word-ContinuedListScheme`: the numbering of the nearest numbered item before the paragraph (a bullet nested in the list
/// is passed over), up to 500 paragraphs back.
pub(super) fn continued_list_scheme(paragraph: &Para) -> Result<Option<&'static str>> {
    // A target that is no paragraph has no Previous(): the lookup fails, and a failure is no previous paragraph.
    let Para::Real(start) = paragraph else { return Ok(None) };
    let mut previous = start.clone();
    for _ in 0..500 {
        previous = match previous.call_member("Previous", &[]) {
            Ok(found) if is_object(&found) => found,
            _ => return Ok(None),
        };
        let format = previous.member("Range")?.member("ListFormat")?;
        if super::int(&format.member("ListType")?)? == 0 {
            continue;
        }
        let Ok(template) = format.member("ListTemplate") else { continue };
        if !is_object(&template) {
            continue;
        }
        let level = (|| -> Result<Com> {
            let number = super::int(&format.member("ListLevelNumber")?)?.max(1);
            item(&template.member("ListLevels")?, number)
        })();
        let Ok(level) = level else { continue };
        if !is_object(&level) {
            continue;
        }
        if !super::string(&level.member("NumberFormat")?).contains('%') || super::int(&level.member("NumberStyle")?)? == 23 {
            continue;
        }
        let second_style = (|| -> Result<i32> { super::int(&item(&template.member("ListLevels")?, 2)?.member("NumberStyle")?) })();
        return Ok(Some(if second_style.unwrap_or(0) == 24 { "korean" } else { "global" }));
    }
    Ok(None)
}

/// `Apply-WordNumber`: an item right after a list item continues the numbered list; after a heading, a body paragraph or a
/// table it starts again at 1, unless listContinue carries the list before it on past them.
pub(super) fn apply_number(document: &Obj, paragraph: &Para, index: i32, continued: bool, numbering: &Value) -> Result<()> {
    let mut carry_on = continued;
    if !carry_on && index > 1 {
        let previous = item(&document.get("Paragraphs")?, index - 1)?.member("Range")?;
        carry_on = super::int(&previous.member("ListFormat")?.member("ListType")?)? != 0
            && !super::truth(&super::indexed(&previous, "Information", &[Com::I4(12)])?);
    }
    // A block of appended items comes as one range: the list opens, or is joined, at its first paragraph, which is where
    // its words are read and where the walk back to the list it continues starts.
    let opening = match paragraph.range().and_then(|range| range.member("Paragraphs")).and_then(|all| item(&all, 1)) {
        Ok(first) => Para::Real(first),
        Err(_) => paragraph.clone(),
    };
    let mut scheme = numbered_list_scheme(&super::string(&opening.range()?.member("Text")?), numbering)?;
    if carry_on {
        if let Some(continuing) = continued_list_scheme(&opening)? {
            scheme = continuing;
        }
    }
    let template = if scheme == "korean" { korean_number_template(document)? } else { number_template(document)? };
    let apply = || -> Result<()> {
        let format = paragraph.range()?.member("ListFormat")?;
        format.call_member("ApplyListTemplate", &[template.clone(), Com::Bool(carry_on), Com::I4(2)])?;
        paragraph.range()?.member("ListFormat")?.set_member("ListLevelNumber", Com::I4(1))
    };
    if apply().is_err() {
        paragraph.range()?.member("ListFormat")?.call_member("ApplyNumberDefault", &[])?;
    }
    Ok(())
}

/// `Apply-WordBullet`: applied to this paragraph only (wdListApplyToSelection), continuing the list before it, at the first
/// level: applying to the whole list renumbered the earlier items into the template's deeper levels.
pub(super) fn apply_bullet(document: &Obj, paragraph: &Para) -> Result<()> {
    let apply = || -> Result<()> {
        let format = paragraph.range()?.member("ListFormat")?;
        let template = bullet_template(document)?;
        format.call_member("ApplyListTemplate", &[template, Com::Bool(true), Com::I4(2)])?;
        paragraph.range()?.member("ListFormat")?.set_member("ListLevelNumber", Com::I4(1))
    };
    if apply().is_err() {
        paragraph.range()?.member("ListFormat")?.call_member("ApplyBulletDefault", &[])?;
    }
    Ok(())
}

/// `Reset-WordParagraph`: a paragraph Word opens after another one carries that paragraph's style, list, borders, shading,
/// indents, spacing and the run format of its mark; the portable writer starts every block as a bare paragraph, and so does
/// this one.
pub(super) fn reset_paragraph(paragraph: &Para) -> Result<()> {
    let range = paragraph.range()?;
    let _ = range.member("ListFormat").and_then(|format| format.call_member("RemoveNumbers", &[]));
    let _ = range.set_member("Style", Com::I4(-1));
    let _ = range.member("ParagraphFormat").and_then(|format| format.call_member("Reset", &[]));
    let _ = range.member("Font").and_then(|font| font.call_member("Reset", &[]));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_counts_the_way_its_first_words_do_unless_it_is_named() {
        assert_eq!(numbered_list_scheme("Plan", &Value::Null).unwrap(), "global");
        assert_eq!(numbered_list_scheme("계획 A", &Value::Null).unwrap(), "korean");
        assert_eq!(numbered_list_scheme("계획", &Value::string("Global")).unwrap(), "global");
        assert_eq!(
            numbered_list_scheme("x", &Value::string("roman")).unwrap_err().message(),
            "listNumbering must be 'korean' or 'global', not \"roman\""
        );
    }
}
