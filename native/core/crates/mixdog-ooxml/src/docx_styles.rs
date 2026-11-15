//! `portable/portable-docx-styles.mjs`: a style as the document names it. Word writes its built-in styles under ids of its
//! own language (Korean Word saves "heading 1" as w:styleId="1" and "Quote" as "a5") and keeps the English name in w:name.
//! Written as the English id alone, a Korean Word document edited here showed every heading, quote, and caption as body text.

use crate::blank::word_styles;
use crate::docx_xml::docx_style_id;
use crate::xml::{compiled, xml_decode};
use crate::zipio::Package;

const STYLES_PART: &str = "word/styles.xml";

/// `key(value)`: a name compared lower-cased without white space.
fn key(value: &str) -> String {
    mixdog_js::js_to_lowercase(value).chars().filter(|c| !mixdog_js::is_js_space(*c)).collect()
}

/// One `w:style` of a styles part.
struct StyleEntry {
    xml: String,
    kind: String,
    id: String,
    name: String,
}

fn style_entries(styles_xml: &str) -> Vec<StyleEntry> {
    let kind = compiled(r#"\bw:type="([^"]+)""#, "");
    let id = compiled(r#"\bw:styleId="([^"]+)""#, "");
    let name = compiled(r#"<w:name\s+w:val="([^"]*)""#, "");
    compiled(r"<w:style\b([^>]*)>([\s\S]*?)<\/w:style>", "g")
        .captures_iter(styles_xml)
        .map(|found| {
            let attributes = found.get(1).unwrap_or("");
            StyleEntry {
                xml: found.get(0).unwrap_or("").to_owned(),
                kind: kind.captures(attributes).and_then(|m| m.get(1).map(str::to_owned)).unwrap_or_else(|| "paragraph".to_owned()),
                id: xml_decode(id.captures(attributes).and_then(|m| m.get(1)).unwrap_or("")),
                name: xml_decode(name.captures(found.get(2).unwrap_or("")).and_then(|m| m.get(1)).unwrap_or("")),
            }
        })
        .collect()
}

/// By the id asked for, then the English id Word's English template uses, then the style's name.
fn find_style<'a>(entries: &'a [StyleEntry], requested: &str, kind: &str) -> Option<&'a StyleEntry> {
    let english = docx_style_id(requested);
    let of_kind = || entries.iter().filter(|entry| entry.kind == kind);
    of_kind()
        .find(|entry| entry.id == requested)
        .or_else(|| of_kind().find(|entry| entry.id == english))
        .or_else(|| of_kind().find(|entry| key(&entry.name) == key(requested)))
        .or_else(|| of_kind().find(|entry| key(&entry.name) == key(&english)))
}

/// The id the document carries for a style, and whether the document (or the new-document styles) defines it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentStyle {
    pub id: String,
    pub found: bool,
}

/// `documentStyleId(zip, requested, type)`: the id the document carries for a paragraph or table style asked for by name or
/// id. A built-in style the document has not defined yet (Word keeps "caption" and "Table Grid" latent until first used) is
/// added from the new-document styles under its English id, which Word reads as the built-in style by its name; `found` is
/// false only for a style neither defines.
pub fn document_style_id(zip: &mut Package, requested: &str, kind: &str) -> DocumentStyle {
    let wanted = mixdog_js::js_trim(requested);
    if wanted.is_empty() {
        return DocumentStyle { id: String::new(), found: true };
    }
    let styles = zip.text(STYLES_PART);
    // A package without a styles part says nothing about which styles exist; its reference stands as written.
    if styles.is_empty() {
        return DocumentStyle { id: docx_style_id(wanted), found: true };
    }
    let entries = style_entries(&styles);
    if let Some(existing) = find_style(&entries, wanted, kind) {
        return DocumentStyle { id: existing.id.clone(), found: true };
    }
    let template = style_entries(&word_styles());
    let borrowed = find_style(&template, wanted, kind);
    let Some(borrowed) = borrowed.filter(|borrowed| !entries.iter().any(|entry| entry.id == borrowed.id)) else {
        return DocumentStyle { id: docx_style_id(wanted), found: false };
    };
    // The definition's own references follow the document's ids: Korean Word's Normal is "a", its Normal Table "a1".
    let definition = compiled(r#"(<w:(?:basedOn|next|link)\s+w:val=")([^"]*)(")"#, "g").replace_all_with(&borrowed.xml, |found| {
        let (open, reference, close) = (found.get(1).unwrap_or(""), found.get(2).unwrap_or(""), found.get(3).unwrap_or(""));
        let local = template
            .iter()
            .find(|entry| entry.id == reference)
            .map(|entry| &entry.name)
            .filter(|name| !name.is_empty())
            .and_then(|name| entries.iter().find(|entry| key(&entry.name) == key(name)));
        match local {
            Some(entry) => format!("{open}{}{close}", entry.id),
            None => found.get(0).unwrap_or("").to_owned(),
        }
    });
    let updated = match styles.find("</w:styles>") {
        Some(at) => format!("{}{definition}{}", &styles[..at], &styles[at..]),
        None => styles.clone(),
    };
    zip.set(STYLES_PART, updated);
    DocumentStyle { id: borrowed.id.clone(), found: true }
}
