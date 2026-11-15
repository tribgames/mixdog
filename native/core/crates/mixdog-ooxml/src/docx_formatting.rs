//! `portable/docx-formatting.mjs`: formatting patches for WordprocessingML. Only the properties a patch supplies change; the
//! ones it does not name, and the revision metadata beside them, stay as they were, in the order the schema gives. Latin and
//! East Asian faces are separate slots, a hanging indent replaces a first-line indent, and a phrase is formatted across the
//! runs it spans without touching headers or footers.

use std::cell::{Cell, RefCell};

use serde_json::Value;

use crate::docx_xml::{Numbering, paragraph_format_xml, word_run_properties};
use crate::xml::{compiled, top_level_elements, xml_decode, xml_encode};

/// The schema's child order of a paragraph's and a run's properties.
const PPR_ORDER: &str = "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange";
const RPR_ORDER: &str = "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange";

fn order_of(tag: &str) -> Vec<&'static str> {
    match tag {
        "pPr" => PPR_ORDER.split(' ').collect(),
        "rPr" => RPR_ORDER.split(' ').collect(),
        _ => Vec::new(),
    }
}

/// A top-level element of a fragment: its name, its text, and where it starts and ends in the fragment.
struct Child {
    name: String,
    xml: String,
    start: usize,
    end: usize,
}

/// The top-level elements of a fragment, whatever their names.
fn elements(xml: &str) -> Vec<Child> {
    let mut names: Vec<String> = Vec::new();
    for found in compiled(r"<([A-Za-z_][\w:.-]*)\b", "g").captures_iter(xml) {
        let name = found.get(1).unwrap_or("").to_owned();
        if !names.contains(&name) {
            names.push(name);
        }
    }
    let accepted: Vec<&str> = names.iter().map(String::as_str).collect();
    top_level_elements(xml, &accepted).into_iter().map(|element| Child { name: element.name, xml: element.xml, start: element.start, end: element.end }).collect()
}

/// The attributes of an element's opening tag, in source order (a repeated name keeps its first place and its last value).
fn attributes(xml: &str) -> Vec<(String, String)> {
    let mut list: Vec<(String, String)> = Vec::new();
    for found in compiled(r#"([\w:]+)="([^"]*)""#, "g").captures_iter(xml) {
        set_attribute(&mut list, found.get(1).unwrap_or(""), found.get(2).unwrap_or("").to_owned());
    }
    list
}

fn set_attribute(list: &mut Vec<(String, String)>, key: &str, value: String) {
    match list.iter_mut().find(|(name, _)| name == key) {
        Some(entry) => entry.1 = value,
        None => list.push((key.to_owned(), value)),
    }
}

/// `xml.split('>')[0]`.
fn opening(xml: &str) -> &str {
    xml.split('>').next().unwrap_or("")
}

fn merge_attributes(previous: &str, patch: &str, name: &str) -> String {
    let mut values = attributes(opening(previous));
    let updates = attributes(opening(patch));
    let has = |key: &str| updates.iter().any(|(name, _)| name == key);
    if name == "w:rFonts" {
        for slot in ["ascii", "hAnsi", "eastAsia", "cs"] {
            if has(&format!("w:{slot}")) {
                let theme = if slot == "cs" { "w:cstheme".to_owned() } else { format!("w:{slot}Theme") };
                values.retain(|(key, _)| *key != theme);
            }
        }
    }
    // The first line is either hung or indented: left beside a new one, the old w:hanging outranks a w:firstLine.
    if name == "w:ind" {
        if has("w:hanging") {
            values.retain(|(key, _)| key != "w:firstLine");
        }
        if has("w:firstLine") {
            values.retain(|(key, _)| key != "w:hanging");
        }
    }
    for (key, value) in updates {
        set_attribute(&mut values, &key, value);
    }
    format!("<{name}{}/>", values.iter().map(|(key, value)| format!(" {key}=\"{value}\"")).collect::<String>())
}

/// The index JavaScript's `text.slice(0, -1)` stops at: one UTF-16 unit before the end.
fn before_last(text: &str) -> usize {
    text.len() - text.chars().next_back().map_or(0, char::len_utf8)
}

/// `patchWordFormat(xml, owner, tag, patch)`: patch only supplied properties; preserve unrelated settings and revision
/// metadata.
fn patch_word_format(xml: &str, owner: &str, tag: &str, patch: &str) -> Result<String, String> {
    if patch.is_empty() {
        return Ok(xml.to_owned());
    }
    let open_length = compiled(&format!(r"^<w:{owner}(?:\s[^>]*)?>"), "")
        .find(xml)
        .map(|range| range.end)
        .ok_or_else(|| format!("Missing Word {owner} element"))?;
    let close = xml.rfind(&format!("</w:{owner}>")).unwrap_or_else(|| before_last(xml));
    let children = elements(&xml[open_length..close.max(open_length)]);
    let wanted_name = format!("w:{tag}");
    let existing = children.iter().find(|child| child.name == wanted_name);
    let inner = existing
        .map(|child| {
            let without_open = compiled(r"^<[^>]+>", "").replace_all_with(&child.xml, |_| String::new());
            compiled(r"<\/[^>]+>$", "").replace_all_with(&without_open, |_| String::new())
        })
        .unwrap_or_default();
    let mut entries: Vec<(String, String)> = elements(&inner).into_iter().map(|entry| (entry.name, entry.xml)).collect();
    let order = order_of(tag);
    let rank_of = |name: &str| order.iter().position(|item| *item == name.get(2..).unwrap_or(""));
    for entry in elements(patch) {
        let index = entries.iter().position(|value| value.0 == entry.name);
        let value = match index {
            Some(at) if ["w:spacing", "w:rFonts", "w:lang", "w:ind"].contains(&entry.name.as_str()) => merge_attributes(&entries[at].1, &entry.xml, &entry.name),
            _ => entry.xml.clone(),
        };
        match index {
            Some(at) => entries[at].1 = value,
            None => {
                let rank = rank_of(&entry.name);
                let next = rank.and_then(|rank| entries.iter().position(|item| rank_of(&item.0).is_some_and(|other| other > rank)));
                entries.insert(next.unwrap_or(entries.len()), (entry.name.clone(), value));
            }
        }
    }
    let properties = format!("<w:{tag}>{}</w:{tag}>", entries.iter().map(|entry| entry.1.as_str()).collect::<String>());
    Ok(match existing {
        None => format!("{}{}{}", &xml[..open_length], properties, &xml[open_length..]),
        Some(child) => format!("{}{}{}", &xml[..open_length + child.start], properties, &xml[open_length + child.end..]),
    })
}

/// `patchParagraphFormat(xml, properties, numbering)`: a paragraph's properties patched with the supplied ones only.
pub fn patch_paragraph_format(xml: &str, properties: &Value, numbering: Option<&Numbering>) -> Result<String, String> {
    patch_word_format(xml, "p", "pPr", &paragraph_format_xml(properties, numbering))
}

// A style definition's children run name ... qFormat, then pPr, rPr, then the table parts; an absent pPr or rPr is opened in
// its place first, so the patch lands inside the schema's order rather than ahead of the style's name.
fn open_style_properties(style_xml: &str, tag: &str) -> String {
    if compiled(&format!(r"<w:{tag}(?:\s[^>]*)?(?:\/>|>)"), "").is_match(style_xml) {
        return match compiled(&format!(r"<w:{tag}(?:\s[^>]*)?\/>"), "").find(style_xml) {
            Some(range) => format!("{}<w:{tag}></w:{tag}>{}", &style_xml[..range.start], &style_xml[range.end..]),
            None => style_xml.to_owned(),
        };
    }
    let before = if tag == "pPr" {
        compiled(r"<w:(?:rPr|tblPr|trPr|tcPr|tblStylePr)\b", "")
    } else {
        compiled(r"<w:(?:tblPr|trPr|tcPr|tblStylePr)\b", "")
    };
    let at = before.find(style_xml).map(|range| range.start).or_else(|| style_xml.rfind("</w:style>")).unwrap_or_else(|| before_last(style_xml));
    format!("{}<w:{tag}></w:{tag}>{}", &style_xml[..at], &style_xml[at..])
}

/// `patchWordStyle(styleXml, properties)`: a style's paragraph and run formatting patched with the supplied properties only
/// (define_styles).
pub fn patch_word_style(style_xml: &str, properties: &Value) -> Result<String, String> {
    let mut next = style_xml.to_owned();
    let paragraph = paragraph_format_xml(properties, None);
    if !paragraph.is_empty() {
        next = patch_word_format(&open_style_properties(&next, "pPr"), "style", "pPr", &paragraph)?;
    }
    let run = word_run_properties(properties);
    if !run.is_empty() {
        next = patch_word_format(&open_style_properties(&next, "rPr"), "style", "rPr", &run)?;
    }
    Ok(next)
}

/// One run of a paragraph for [`format_first_body_phrase`]: its text as UTF-16 units (a NUL unit when the run holds anything
/// but text: fields, drawings and breaks are search barriers).
struct PhraseRun {
    start: usize,
    end: usize,
    xml: String,
    open: String,
    properties: String,
    text: Vec<u16>,
}

fn index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// What [`format_first_body_phrase`] returns: the document and whether any character changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhraseFormat {
    pub xml: String,
    pub changed: bool,
}

/// `formatFirstBodyPhrase(documentXml, find, properties)`: search the first body phrase, across text runs, without touching
/// headers or footers. Only matching characters change; fields, drawings and breaks are search barriers.
pub fn format_first_body_phrase(document_xml: &str, find: &str, properties: &Value) -> Result<PhraseFormat, String> {
    if find.is_empty() || find.contains('\0') {
        return Err("set_font requires non-empty searchable text".to_owned());
    }
    let patch = word_run_properties(properties);
    if patch.is_empty() {
        return Err("set_font requires at least one font property".to_owned());
    }
    let wanted: Vec<u16> = find.encode_utf16().collect();
    let matched = Cell::new(false);
    let changed = Cell::new(false);
    let failure: RefCell<Option<String>> = RefCell::new(None);
    let run_open = compiled(r"^<w:r(?:\s[^>]*)?>", "");
    let run_properties = compiled(r"^\s*(?:<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\s*\/>)", "");
    let text_only = compiled(r"^(?:\s*<w:t\b[^>]*>[\s\S]*?<\/w:t>\s*)+$", "");
    let text_element = compiled(r"<w:t\b[^>]*>([\s\S]*?)<\/w:t>", "g");
    let run_pattern = compiled(r"<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>", "g");
    let xml = compiled(r"<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>", "g").replace_all_with(document_xml, |found| {
        let paragraph = found.get(0).unwrap_or("");
        if matched.get() {
            return paragraph.to_owned();
        }
        let runs: Vec<PhraseRun> = run_pattern
            .find_iter(paragraph)
            .map(|range| {
                let whole = &paragraph[range.clone()];
                let open = run_open.find(whole).map_or("", |open| &whole[open]);
                let inner = &whole[open.len()..whole.len() - "</w:r>".len()];
                let properties = run_properties.find(inner).map_or("", |found| &inner[found]);
                let content = &inner[properties.len()..];
                let text: Vec<u16> = if text_only.is_match(content) {
                    text_element.captures_iter(content).map(|part| xml_decode(part.get(1).unwrap_or(""))).collect::<String>().encode_utf16().collect()
                } else {
                    vec![0]
                };
                PhraseRun { start: range.start, end: range.end, xml: whole.to_owned(), open: open.to_owned(), properties: properties.to_owned(), text }
            })
            .collect();
        let joined: Vec<u16> = runs.iter().flat_map(|run| run.text.iter().copied()).collect();
        let Some(start) = index_of(&joined, &wanted) else { return paragraph.to_owned() };
        matched.set(true);
        let end = start + wanted.len();
        let mut offset = 0;
        let mut cursor = 0;
        let mut result = String::new();
        let text_run = |run: &PhraseRun, text: &str| format!("{}{}<w:t xml:space=\"preserve\">{}</w:t></w:r>", run.open, run.properties, xml_encode(text));
        for run in &runs {
            result.push_str(&paragraph[cursor..run.start]);
            cursor = run.end;
            let from = start.saturating_sub(offset);
            let to = run.text.len().min(end.saturating_sub(offset));
            offset += run.text.len();
            if to <= from {
                result.push_str(&run.xml);
                continue;
            }
            let updated = match patch_word_format(&run.xml, "r", "rPr", &patch) {
                Ok(updated) => updated,
                Err(error) => {
                    if failure.borrow().is_none() { *failure.borrow_mut() = Some(error); }
                    result.push_str(&run.xml);
                    continue;
                }
            };
            if updated == run.xml {
                result.push_str(&run.xml);
                continue;
            }
            changed.set(true);
            if from > 0 {
                result.push_str(&text_run(run, &text_of(&run.text[..from])));
            }
            match patch_word_format(&text_run(run, &text_of(&run.text[from..to])), "r", "rPr", &patch) {
                Ok(patched) => result.push_str(&patched),
                Err(error) => {
                    if failure.borrow().is_none() { *failure.borrow_mut() = Some(error); }
                }
            }
            if to < run.text.len() {
                result.push_str(&text_run(run, &text_of(&run.text[to..])));
            }
        }
        result.push_str(&paragraph[cursor..]);
        result
    });
    if let Some(error) = failure.into_inner() {
        return Err(error);
    }
    if !matched.get() {
        return Err(format!("Font target not found in document body: {find}"));
    }
    Ok(PhraseFormat { xml, changed: changed.get() })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const FONTS: &str = r#"<w:rFonts w:ascii="Cambria" w:eastAsia="Malgun Gothic" w:cs="Arial"/>"#;

    fn run(text: &str, props: &str) -> String {
        format!(r#"<w:r><w:rPr>{props}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
    }

    fn count(text: &str, needle: &str) -> usize {
        text.matches(needle).count()
    }

    #[test]
    fn body_font_edits_cross_fragments_and_preserve_formatting() {
        let original = format!(
            r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>{}{}</w:p>"#,
            run("아무것도 ", &format!("{FONTS}<w:b/><w:sz w:val=\"66\"/>")),
            run("하지 않는 시간", &format!("{FONTS}<w:color w:val=\"112233\"/><w:sz w:val=\"66\"/>"))
        );
        let body = format!(r#"<w:document xmlns:w="x"><w:body>{original}</w:body></w:document>"#);
        let edited = format_first_body_phrase(&body, "아무것도 하지 않는 시간", &json!({ "size": 24 })).expect("a phrase in the body");
        assert!(edited.changed);
        assert_eq!(count(&edited.xml, r#"w:sz w:val="48""#), 2);
        assert_eq!(count(&edited.xml, r#"w:eastAsia="Malgun Gothic""#), 2);
        assert!(edited.xml.contains("<w:b/>"));
        assert!(edited.xml.contains(r#"w:color w:val="112233""#));
        let missing = format_first_body_phrase(&body, "footer-only", &json!({ "size": 30 })).expect_err("not in the body");
        assert!(missing.contains("not found in document body"), "{missing}");
    }

    #[test]
    fn a_substring_edit_changes_only_its_characters_and_only_the_first_occurrence() {
        let paragraph = format!("<w:p>{}</w:p>", run("before target after target", &format!("{FONTS}<w:b/>")));
        let result = format_first_body_phrase(&paragraph, "target", &json!({ "bold": false, "color": "FF0000" })).expect("formatted");
        assert!(
            compiled(r#"<w:b w:val="0"/><w:color w:val="FF0000"/>.*?<w:t xml:space="preserve">target</w:t>"#, "").is_match(&result.xml),
            "{}",
            result.xml
        );
        assert_eq!(count(&result.xml, "FF0000"), 1);
        assert!(result.xml.contains(r#"<w:b/></w:rPr><w:t xml:space="preserve"> after target</w:t>"#));
    }

    #[test]
    fn fields_and_breaks_are_barriers_rather_than_disappearing_from_the_searched_phrase() {
        let paragraph = format!("<w:p>{}<w:r><w:tab/></w:r>{}</w:p>", run("a", ""), run("b", ""));
        let error = format_first_body_phrase(&paragraph, "ab", &json!({ "size": 12 })).expect_err("a barrier");
        assert!(error.contains("not found"), "{error}");
    }

    #[test]
    fn changing_a_page_break_preserves_paragraph_spacing_keep_rules_tabs_and_section_metadata() {
        let properties = concat!(
            r#"<w:pStyle w:val="Heading1"/><w:keepNext/><w:pageBreakBefore/>"#,
            r#"<w:tabs><w:tab w:val="right" w:pos="2000"/></w:tabs>"#,
            r#"<w:spacing w:before="200" w:after="140"/><w:ind w:left="120"/>"#,
            r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>"#
        );
        let paragraph = format!("<w:p><w:pPr>{properties}</w:pPr>{}</w:p>", run("Heading", ""));
        let edited = patch_paragraph_format(&paragraph, &json!({ "pageBreakBefore": false }), None).expect("patched");
        assert_eq!(edited, paragraph.replace("<w:pageBreakBefore/>", r#"<w:pageBreakBefore w:val="0"/>"#));
        assert_eq!(patch_paragraph_format(&edited, &json!({ "pageBreakBefore": false }), None).expect("patched"), edited);
        let spacing = patch_paragraph_format(&edited, &json!({ "spacingAfter": 8 }), None).expect("patched");
        assert!(spacing.contains(r#"<w:spacing w:before="200" w:after="160"/>"#), "{spacing}");
    }

    #[test]
    fn font_slots_stay_independent_and_spacing_uses_points() {
        let changed = format_first_body_phrase(&format!("<w:p>{}</w:p>", run("Korean 한국어", FONTS)), "Korean 한국어", &json!({ "name": "Georgia" }))
            .expect("formatted");
        assert!(changed.xml.contains(r#"w:ascii="Georgia""#));
        assert!(changed.xml.contains(r#"w:eastAsia="Malgun Gothic""#));
        assert!(changed.xml.contains(r#"w:cs="Arial""#));
        let east_asia = word_run_properties(&json!({ "nameEastAsia": "Batang" }));
        assert!(east_asia.contains(r#"w:eastAsia="Batang""#));
        assert!(!east_asia.contains("w:ascii="));
        assert!(paragraph_format_xml(&json!({ "lineSpacing": 14.7 }), None).contains(r#"w:line="294" w:lineRule="atLeast""#));
        // A callout is a shaded paragraph with a rule at its left; a quote is set in from the margin. Both are points in,
        // twips out, and the elements land in the schema's pPr order (pBdr, shd, spacing, ind, jc).
        let callout = paragraph_format_xml(
            &json!({
                "border": { "side": "left", "size": 12, "color": "1F6F8B" },
                "shading": "#EEF2F7",
                "indentLeft": 12,
                "indentRight": 12,
                "spacingAfter": 8,
                "alignment": "left",
            }),
            None,
        );
        assert!(
            compiled(
                r#"<w:pBdr><w:left [^>]*w:sz="12"[^>]*w:color="1F6F8B"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="EEF2F7"/><w:spacing w:after="160"/><w:ind w:left="240" w:right="240"/><w:jc w:val="left"/>"#,
                ""
            )
            .is_match(&callout),
            "{callout}"
        );
        assert!(paragraph_format_xml(&json!({ "indentFirstLine": 10.5 }), None).contains(r#"<w:ind w:firstLine="210"/>"#));
        // A rule keeps Word's own distance from the text unless the caller sets one: 4 pt beside, 1 pt above or below.
        assert!(compiled(r#"<w:left [^>]*w:space="4""#, "").is_match(&callout));
        let bottom = paragraph_format_xml(&json!({ "border": { "side": "bottom", "size": 8, "color": "1F6F8B" } }), None);
        assert!(compiled(r#"<w:bottom [^>]*w:space="1""#, "").is_match(&bottom));
        let flush = paragraph_format_xml(&json!({ "border": { "side": "left", "size": 8, "color": "1F6F8B", "space": 0 } }), None);
        assert!(compiled(r#"<w:left [^>]*w:space="0""#, "").is_match(&flush));
    }

    #[test]
    fn a_hanging_indent_replaces_a_first_line_indent_and_a_style_patch_lands_in_schema_order() {
        let hung = patch_paragraph_format(
            r#"<w:p><w:pPr><w:ind w:left="720" w:firstLine="360"/></w:pPr></w:p>"#,
            &json!({ "indentFirstLine": -18 }),
            None,
        )
        .expect("patched");
        assert_eq!(hung, r#"<w:p><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:p>"#);
        let style = r#"<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:qFormat/></w:style>"#;
        let patched = patch_word_style(style, &json!({ "bold": true, "spacingAfter": 6 })).expect("patched");
        assert_eq!(
            patched,
            r#"<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:b w:val="1"/></w:rPr></w:style>"#
        );
        let missing = patch_paragraph_format("<w:r/>", &json!({ "keepWithNext": true }), None).expect_err("not a paragraph");
        assert_eq!(missing, "Missing Word p element");
    }
}
