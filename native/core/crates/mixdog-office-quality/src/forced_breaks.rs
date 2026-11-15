//! Which rendered pages open with a deliberate forced page break, ported from
//! `src/runtime/office/quality/forced-break-pages.mjs`. A page that ends short before such a break ends where the
//! author ended it (`page_bottom_empty` reads this through [`crate::rendered::RenderedOptions::forced_break_pages`]).
//! The openings come from the authored source: the kept HTML (`break-before: page` / `page-break-before: always|page`,
//! inline or from a stylesheet rule) or the DOCX body (`w:pageBreakBefore`, or a page-break run before the paragraph).
//! They are matched against the first body text of each page of the preview PDF, ignoring the running head and folio
//! bands.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, is_js_space, js_sort_by, js_to_lowercase, js_trim, js_words, slice_utf16, utf16_len};
use mixdog_office_pdf::{LayoutOptions, PageLayout, PdfSource, extract_pdf_text_layout};
use mixdog_ooxml::zipio::Package;

const OPENING_CHARS: usize = 40;
const MIN_OPENING_CHARS: usize = 3;
/// How much of an element without a closing tag is read for its text, in UTF-16 units.
const UNCLOSED_TEXT_UNITS: usize = 2000;
/// Running head and folio bands, as a share of the page height.
const MARGIN_BAND: f64 = 0.06;
const SKIPPED_TAGS: [&str; 8] = ["html", "head", "body", "style", "script", "link", "meta", "title"];

static STYLE_OR_SCRIPT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<(style|script)\b[\s\S]*?</\1>", "i"));
static ANY_TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<[^>]*>", ""));
static ENTITY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"&(#39|[a-z]+);", "i"));
static SCREEN_ONLY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s*(?:only\s+)?screen\b", "i"));
static NOT_PRINT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s*not\s+print\b", "i"));
static LEADING_AT_STATEMENTS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:\s*@[^{;]*;)+", ""));
static MEDIA_RULE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^@media\b", "i"));
static BREAK_DECLARATION: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\s*(?:page-)?break-before\s*:\s*(.*?)\s*$", "i"));
static IMPORTANT_END: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\s*!\s*important\s*$", "i"));
static FORCED_VALUE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:page|always)$", "i"));
static STYLE_ELEMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<style\b[^>]*>([\s\S]*?)</style>", "i"));
static CSS_COMMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"/\*[\s\S]*?\*/", ""));
static SIMPLE_SELECTOR: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^\s*([a-z][\w-]*)?(?:#([\w-]+))?((?:\.[\w-]+)*)\s*$", "i"));
static OPEN_TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<([a-z][\w-]*)\b([^>]*)>", "i"));
static STYLE_ATTRIBUTE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')"#, "i"));
static ID_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bid\s*=\s*["']([^"']*)["']"#, "i"));
static CLASS_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bclass\s*=\s*["']([^"']*)["']"#, "i"));
static DOCX_PARAGRAPH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<w:p\b[^>]*>[\s\S]*?</w:p>", ""));
static DOCX_PAGE_BREAK_BEFORE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"<w:pageBreakBefore\b(?![^>]*w:val="(?:0|false)")[^>]*/>"#, ""));
static DOCX_PAGE_RUN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<w:br\b[^>]*w:type="page"[^>]*/>"#, ""));
static DOCX_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<w:t\b[^>]*>([^<]*)</w:t>", ""));

/// `squash`: the text without white space, lowercased.
fn squash(text: &str) -> String {
    js_to_lowercase(&text.chars().filter(|c| !is_js_space(*c)).collect::<String>())
}

/// What an HTML entity name stands for (`entities[name.toLowerCase()]`).
fn entity_text(name: &str) -> Option<&'static str> {
    match name {
        "amp" => Some("&"),
        "lt" => Some("<"),
        "gt" => Some(">"),
        "quot" => Some("\""),
        "nbsp" => Some(" "),
        "#39" => Some("'"),
        _ => None,
    }
}

/// `visibleText`: the text of a piece of markup, its tags and style/script bodies gone, five entities decoded and the
/// white space collapsed.
fn visible_text(html: &str) -> String {
    let without_blocks = STYLE_OR_SCRIPT.replace_all_with(html, |_| " ".to_owned());
    let without_tags = ANY_TAG.replace_all_with(&without_blocks, |_| " ".to_owned());
    let decoded = ENTITY.replace_all_with(&without_tags, |caps| {
        let whole = caps.get(0).unwrap_or_default();
        entity_text(&js_to_lowercase(caps.get(1).unwrap_or_default())).map_or_else(|| whole.to_owned(), str::to_owned)
    });
    js_words(&decoded).collect::<Vec<_>>().join(" ")
}

/// The first [`OPENING_CHARS`] UTF-16 units of a text, kept only when they hold at least [`MIN_OPENING_CHARS`] characters
/// besides white space.
fn opening_of(text: &str) -> Option<String> {
    let opening = slice_utf16(text, OPENING_CHARS);
    (utf16_len(&squash(&opening)) >= MIN_OPENING_CHARS).then_some(opening)
}

/// A media query list reaches the printed page unless every query is screen-only.
fn applies_to_print(queries: &str) -> bool {
    queries.split(',').any(|query| !SCREEN_ONLY.is_match(query) && !NOT_PRINT.is_match(query))
}

struct StyleRule {
    head: String,
    body: String,
}

/// Style rules in source order, flattened out of `@media` blocks that do not apply in print.
fn css_rules(css: &str, active: bool, rules: &mut Vec<StyleRule>) {
    let bytes = css.as_bytes();
    let mut index = 0;
    while index < css.len() {
        let Some(found) = css[index..].find('{') else { break };
        let open = index + found;
        let mut depth = 1i32;
        let mut close = open + 1;
        while close < bytes.len() && depth > 0 {
            depth += match bytes[close] {
                b'{' => 1,
                b'}' => -1,
                _ => 0,
            };
            close += 1;
        }
        let before = &css[index..open];
        let head = match LEADING_AT_STATEMENTS.find(before) {
            Some(range) => js_trim(&before[range.end..]),
            None => js_trim(before),
        };
        // A block left open loses its last unit, as `slice(open + 1, close - 1)` does.
        let inner = if depth == 0 {
            &css[open + 1..close - 1]
        } else {
            let rest = &css[open + 1..];
            rest.char_indices().last().map_or("", |(at, _)| &rest[..at])
        };
        if MEDIA_RULE.is_match(head) {
            css_rules(inner, active && applies_to_print(&head[6..]), rules);
        } else if active && !head.is_empty() && !head.starts_with('@') {
            rules.push(StyleRule { head: head.to_owned(), body: inner.to_owned() });
        }
        index = close;
    }
}

/// The winning break-before declaration of a block: whether it forces a page, and its cascade rank.
#[derive(Clone, Copy)]
struct Declaration {
    forced: bool,
    rank: [i64; 4],
}

/// `breakDeclaration`: the declaration a block states, or `None` when it states none. `!important` beats source order
/// within the block too.
fn break_declaration(body: &str, rank: [i64; 3]) -> Option<Declaration> {
    let mut declarations: Vec<(String, bool)> = Vec::new();
    for text in body.split(';') {
        let Some(caps) = BREAK_DECLARATION.captures(text) else { continue };
        let value = caps.get(1).unwrap_or_default();
        let important = IMPORTANT_END.is_match(value);
        let cleaned = match IMPORTANT_END.find(value) {
            Some(range) => js_trim(&format!("{}{}", &value[..range.start], &value[range.end..])).to_owned(),
            None => js_trim(value).to_owned(),
        };
        declarations.push((cleaned, important));
    }
    let winner = declarations.iter().rev().find(|(_, important)| *important).or_else(|| declarations.last())?;
    Some(Declaration {
        forced: FORCED_VALUE.is_match(&winner.0),
        rank: [i64::from(winner.1), rank[0], rank[1], rank[2]],
    })
}

/// `beats`: whether `a` wins over `b` in the cascade (a tie goes to `a`, the later one).
fn beats(a: &Declaration, b: &Declaration) -> bool {
    for (left, right) in a.rank.iter().zip(&b.rank) {
        if left != right {
            return left > right;
        }
    }
    true
}

struct BreakSelector {
    tag: String,
    id: String,
    classes: Vec<String>,
    declaration: Declaration,
}

fn break_selectors(html: &str) -> Vec<BreakSelector> {
    let mut selectors = Vec::new();
    let mut order = 0i64;
    for caps in STYLE_ELEMENT.captures_iter(html) {
        let css = CSS_COMMENT.replace_all_with(caps.get(1).unwrap_or_default(), |_| String::new());
        let mut rules = Vec::new();
        css_rules(&css, true, &mut rules);
        for StyleRule { head, body } in rules {
            order += 1;
            for selector in head.split(',') {
                let Some(found) = SIMPLE_SELECTOR.captures(selector) else { continue };
                let tag = found.get(1).unwrap_or_default();
                let id = found.get(2).unwrap_or_default();
                let class_text = found.get(3).unwrap_or_default();
                if tag.is_empty() && id.is_empty() && class_text.is_empty() {
                    continue;
                }
                let classes: Vec<String> = class_text.split('.').filter(|name| !name.is_empty()).map(str::to_owned).collect();
                let specificity = if id.is_empty() { 0 } else { 100 } + classes.len() as i64 * 10 + i64::from(!tag.is_empty());
                if let Some(declaration) = break_declaration(&body, [0, specificity, order]) {
                    selectors.push(BreakSelector { tag: js_to_lowercase(tag), id: id.to_owned(), classes, declaration });
                }
            }
        }
    }
    selectors
}

/// `htmlBreakOpenings`: the first ~40 visible characters of every element the HTML forces onto a new page.
pub fn html_break_openings(html: &str) -> Vec<String> {
    let selectors = break_selectors(html);
    let mut closers: HashMap<String, JsRegex> = HashMap::new();
    let mut openings = Vec::new();
    for found in OPEN_TAG.captures_iter(html) {
        let tag = js_to_lowercase(found.get(1).unwrap_or_default());
        if SKIPPED_TAGS.contains(&tag.as_str()) {
            continue;
        }
        let attributes = found.get(2).unwrap_or_default();
        let style = STYLE_ATTRIBUTE.captures(attributes);
        let id = ID_ATTRIBUTE.captures(attributes).and_then(|caps| caps.get(1)).unwrap_or_default();
        let classes: Vec<&str> = CLASS_ATTRIBUTE
            .captures(attributes)
            .and_then(|caps| caps.get(1))
            .map(|text| js_words(text).collect())
            .unwrap_or_default();
        let mut declarations: Vec<Declaration> = selectors
            .iter()
            .filter(|rule| {
                (rule.tag.is_empty() || rule.tag == tag)
                    && (rule.id.is_empty() || rule.id == id)
                    && rule.classes.iter().all(|name| classes.contains(&name.as_str()))
            })
            .map(|rule| rule.declaration)
            .collect();
        let inline_style = style.as_ref().map_or("", |caps| caps.get(1).or_else(|| caps.get(2)).unwrap_or_default());
        declarations.extend(break_declaration(inline_style, [1, 0, 0]));
        let winner = declarations.iter().fold(None::<Declaration>, |best, entry| match best {
            Some(current) if !beats(entry, &current) => Some(current),
            _ => Some(*entry),
        });
        if !winner.is_some_and(|declaration| declaration.forced) {
            continue;
        }
        let rest = &html[found.range().end..];
        // The element's own text (up to its closing tag), whatever tags nest inside it.
        let closer = closers
            .entry(tag.clone())
            .or_insert_with(|| JsRegex::new_static(&format!(r"</{tag}\s*>"), "i"));
        let own = match closer.find(rest) {
            Some(range) => visible_text(&rest[..range.start]),
            None => visible_text(&slice_utf16(rest, UNCLOSED_TEXT_UNITS)),
        };
        openings.extend(opening_of(&own));
    }
    openings
}

/// `docxBreakOpenings`: the opening text of every DOCX paragraph that carries `pageBreakBefore` or follows a page-break
/// run.
pub fn docx_break_openings(document_xml: &str) -> Vec<String> {
    let mut openings = Vec::new();
    let mut pending = false;
    for range in DOCX_PARAGRAPH.find_iter(document_xml) {
        let paragraph = &document_xml[range];
        if DOCX_PAGE_BREAK_BEFORE.is_match(paragraph) {
            pending = true;
        }
        let mut parts = Vec::new();
        let mut last = 0;
        for run in DOCX_PAGE_RUN.find_iter(paragraph) {
            parts.push(&paragraph[last..run.start]);
            last = run.end;
        }
        parts.push(&paragraph[last..]);
        for (index, part) in parts.into_iter().enumerate() {
            if index > 0 {
                pending = true;
            }
            let text: String = DOCX_TEXT.captures_iter(part).map(|caps| caps.get(1).unwrap_or_default()).collect();
            if !pending || js_trim(&text).is_empty() {
                continue;
            }
            pending = false;
            openings.extend(opening_of(&visible_text(&text)));
        }
    }
    openings
}

/// A text run of a preview PDF page, in the layout's top-left coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct TextItem {
    pub text: String,
    pub x: f64,
    pub top: f64,
}

/// A page of the preview PDF layout: its number, its height and its text runs.
#[derive(Debug, Clone, PartialEq)]
pub struct TextPage {
    pub page: usize,
    pub height: f64,
    pub items: Vec<TextItem>,
}

impl From<&PageLayout> for TextPage {
    fn from(page: &PageLayout) -> Self {
        TextPage {
            page: page.page,
            height: page.height,
            items: page.items.iter().map(|item| TextItem { text: item.text.clone(), x: item.x, top: item.top }).collect(),
        }
    }
}

/// A running head or folio repeats at the same position on several pages; a folio differs only by its number.
fn running_key(item: &TextItem) -> String {
    let numbering = !item.text.is_empty()
        && item.text.chars().all(|c| is_js_space(c) || c.is_ascii_digit() || "-\u{2013}/.()".contains(c));
    let text = if numbering { "#" } else { js_trim(&item.text) };
    format!("{text}@{}", (item.top + 0.5).floor() as i64)
}

/// Only the outer margin bands of a page hold running chrome; body text is never filtered, however often it repeats.
fn in_margin(page: &TextPage, item: &TextItem) -> bool {
    let height = if page.height.is_nan() { 0.0 } else { page.height };
    height > 0.0 && (item.top < height * MARGIN_BAND || item.top > height * (1.0 - MARGIN_BAND))
}

fn running_items(pages: &[TextPage]) -> HashSet<String> {
    let mut pages_by_key: HashMap<String, usize> = HashMap::new();
    for page in pages {
        let keys: HashSet<String> = page.items.iter().filter(|item| in_margin(page, item)).map(running_key).collect();
        for key in keys {
            *pages_by_key.entry(key).or_default() += 1;
        }
    }
    pages_by_key.into_iter().filter(|(_, count)| *count > 1).map(|(key, _)| key).collect()
}

/// Body text of a PDF layout page in reading order, without the running head and folio items.
fn body_text(page: &TextPage, running: &HashSet<String>) -> String {
    let mut items: Vec<&TextItem> = page.items.iter().filter(|item| !(in_margin(page, item) && running.contains(&running_key(item)))).collect();
    js_sort_by(&mut items, |a, b| if (a.top - b.top).abs() > 2.0 { a.top - b.top } else { a.x - b.x });
    items.iter().map(|item| item.text.as_str()).collect()
}

/// `forcedBreakPagesFromTexts`: the 1-based pages whose body text begins with one of the openings, in page order.
pub fn forced_break_pages_from_texts(openings: &[String], pages: &[TextPage]) -> Vec<usize> {
    let wanted: Vec<String> = openings.iter().map(|opening| squash(opening)).collect();
    let running = running_items(pages);
    let mut found: Vec<usize> = Vec::new();
    for page in pages {
        let text = squash(&body_text(page, &running));
        if wanted.iter().any(|opening| text.starts_with(opening.as_str())) && !found.contains(&page.page) {
            found.push(page.page);
        }
    }
    found
}

/// The parts of a document session `forcedBreakPages` reads.
#[derive(Debug, Clone, Copy)]
pub struct BreakSession<'a> {
    /// `session.format`: only `docx` and `pdf` have authored breaks.
    pub format: &'a str,
    /// `session.target`: the document file.
    pub target: &'a Path,
    /// `session.htmlSource`: the kept HTML the document was made from.
    pub html_source: Option<&'a Path>,
    /// `session.htmlSourceEdits`: the document was edited after it was made from the HTML.
    pub html_source_edits: bool,
}

/// The parts of a preview render `forcedBreakPages` reads.
#[derive(Debug, Clone, Copy)]
pub struct BreakPreview<'a> {
    /// `preview._images` is not empty: the render produced pages (a measure-only pass has none).
    pub has_images: bool,
    /// `preview.output`: the exported preview file.
    pub output: &'a str,
    /// `preview.exportAvailable`.
    pub export_available: Option<bool>,
}

/// `forcedBreakPages(session, preview)`: the forced-break page numbers of a docx or pdf session's preview, or `None` when
/// the render has no authored source to read the breaks from (`page_bottom_empty` then reports at its full severity).
pub fn forced_break_pages<P: ReadProof>(
    proof: &P,
    session: &BreakSession<'_>,
    preview: &BreakPreview<'_>,
) -> Result<Option<Vec<usize>>, String> {
    if !matches!(session.format, "docx" | "pdf") || !preview.has_images {
        return Ok(None);
    }
    if !preview.output.to_ascii_lowercase().ends_with(".pdf") || preview.export_available == Some(false) {
        return Ok(None);
    }
    let mut openings = Vec::new();
    let mut known = false;
    if session.format == "docx" {
        let bytes = mixdog_fsio::read(proof, session.target).map_err(|error| error.to_string())?;
        let package = Package::load_unchecked(&bytes)?;
        openings.extend(docx_break_openings(&package.text("word/document.xml")));
        known = true;
    }
    if let Some(html_source) = session.html_source.filter(|_| !session.html_source_edits) {
        let bytes = mixdog_fsio::read(proof, html_source).map_err(|error| error.to_string())?;
        openings.extend(html_break_openings(&String::from_utf8_lossy(&bytes)));
        known = true;
    }
    if !known {
        return Ok(None);
    }
    let options = LayoutOptions { shapes: false, ..LayoutOptions::default() };
    let layout = extract_pdf_text_layout(proof, PdfSource::Path(Path::new(preview.output)), &options).map_err(|error| error.to_string())?;
    let pages: Vec<TextPage> = layout.pages.iter().map(TextPage::from).collect();
    Ok(Some(forced_break_pages_from_texts(&openings, &pages)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|text| (*text).to_owned()).collect()
    }

    fn item(text: &str, x: f64, top: f64) -> TextItem {
        TextItem { text: text.to_owned(), x, top }
    }

    /// A page of the preview PDF layout: a running head, the body lines, and a folio.
    fn page(number: usize, lines: &[&str]) -> TextPage {
        let mut items = vec![item("Annual report", 50.0, 20.0)];
        items.extend(lines.iter().enumerate().map(|(index, text)| item(text, 50.0, 100.0 + index as f64 * 20.0)));
        items.push(item(&number.to_string(), 300.0, 780.0));
        TextPage { page: number, height: 800.0, items }
    }

    #[test]
    fn a_stylesheet_rule_and_an_inline_style_both_mark_a_forced_break_opening() {
        let html = r#"<html><head><style>
    .chapter { break-before: page; color: #123 }
    h2.part, #appendix { page-break-before: always }
    p { margin: 0 }
  </style></head><body>
    <p>Cover words and the summary.</p>
    <h1 class="chapter">Chapter One &amp; its aim</h1><p>Body.</p>
    <p>Filler paragraph.</p>
    <h2 class="part">Part Two begins here</h2>
    <div id="appendix"><b>Appendix</b> A: the tables</div>
    <p style="break-before: page">Inline break opening</p>
    <p style="page-break-before: avoid">Not a break</p>
  </body></html>"#;
        let openings = html_break_openings(html);
        assert_eq!(
            openings,
            strings(&["Chapter One & its aim", "Part Two begins here", "Appendix A: the tables", "Inline break opening"])
        );
        let pages = [
            page(1, &["Cover words and the summary."]),
            page(2, &["Chapter One & its aim", "Body.", "Filler paragraph."]),
            page(3, &["More text of chapter one"]),
            page(4, &["Part Two begins here", "Appendix", "A: the tables"]),
        ];
        assert_eq!(forced_break_pages_from_texts(&openings, &pages), vec![2, 4]);
    }

    #[test]
    fn native_docx_page_break_before_and_a_preceding_page_break_run_open_a_forced_page() {
        let xml = r#"<w:body>
    <w:p><w:r><w:t>Front matter text</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Chapter Alpha starts</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ordinary paragraph</w:t></w:r><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:r><w:t>Chapter Beta starts</w:t></w:r></w:p>
    <w:p><w:pPr><w:pageBreakBefore w:val="0"/></w:pPr><w:r><w:t>Switched off paragraph</w:t></w:r></w:p>
  </w:body>"#;
        let openings = docx_break_openings(xml);
        assert_eq!(openings, strings(&["Chapter Alpha starts", "Chapter Beta starts"]));
        let pages = [
            page(1, &["Front matter text", "Ordinary paragraph"]),
            page(2, &["Chapter Alpha starts", "Ordinary paragraph"]),
            page(3, &["Chapter Beta starts", "Switched off paragraph"]),
        ];
        assert_eq!(forced_break_pages_from_texts(&openings, &pages), vec![2, 3]);
    }

    #[test]
    fn a_chapter_heading_at_the_20_mm_margin_of_an_a4_page_is_a_forced_break_page() {
        let a4 = |number: usize, lines: &[&str]| {
            let mut items = vec![item("Annual report", 50.0, 20.0)];
            items.extend(lines.iter().enumerate().map(|(index, text)| item(text, 57.0, 57.0 + index as f64 * 20.0)));
            items.push(item(&number.to_string(), 300.0, 800.0));
            TextPage { page: number, height: 842.0, items }
        };
        let pages = [a4(1, &["Intro text"]), a4(2, &["Chapter Two", "Body."]), a4(3, &["More"])];
        assert_eq!(forced_break_pages_from_texts(&strings(&["Chapter Two"]), &pages), vec![2]);
    }

    #[test]
    fn a_later_rule_inline_style_or_screen_only_media_rule_decides_whether_a_break_is_effective() {
        let html = r#"<style>
    .chapter { break-before: page } .chapter { break-before: auto }
    .part { break-before: auto } .part { break-before: page }
    .both { break-before: page } @media screen { .both { break-before: auto } }
    @media print { .printed { break-before: page } }
    @media screen { .screened { break-before: page } }
    .over { break-before: page } p.over { break-before: auto }
  </style>
  <h1 class="chapter">Overridden chapter</h1>
  <h1 class="part">Effective part</h1>
  <h1 class="both">Print-effective both</h1>
  <h1 class="printed">Printed only rule</h1>
  <h1 class="screened">Screen only rule</h1>
  <p class="over">Higher specificity override</p>
  <h1 class="chapter" style="break-before: page">Inline wins</h1>"#;
        assert_eq!(
            html_break_openings(html),
            strings(&["Effective part", "Print-effective both", "Printed only rule", "Inline wins"])
        );
    }

    #[test]
    fn declarations_within_one_block_resolve_by_important_then_source_order() {
        let html = r#"<style>
    .a { break-before: page; break-before: auto }
    .b { break-before: page !important; break-before: auto }
    .c { color: red; break-before: auto; page-break-before: always }
  </style>
  <h1 class="a">Later auto wins</h1>
  <h1 class="b">Important page wins</h1>
  <h1 class="c">Later always wins</h1>"#;
        assert_eq!(html_break_openings(html), strings(&["Important page wins", "Later always wins"]));
    }

    #[test]
    fn body_text_repeated_at_the_same_position_on_several_pages_still_opens_a_forced_break_page() {
        let pages: Vec<TextPage> = (1..=3)
            .map(|number| TextPage {
                page: number,
                height: 800.0,
                items: vec![
                    item("Annual report", 50.0, 20.0),
                    item("Summary", 50.0, 100.0),
                    item(&format!("Findings of part {number}"), 50.0, 120.0),
                    item(&number.to_string(), 300.0, 780.0),
                ],
            })
            .collect();
        assert_eq!(forced_break_pages_from_texts(&strings(&["Summary"]), &pages), vec![1, 2, 3]);
    }

    #[test]
    fn a_running_head_or_folio_line_is_not_the_opening_of_a_page() {
        let pages = [page(1, &["Annual report overview"]), page(2, &["Something else"])];
        assert_eq!(forced_break_pages_from_texts(&strings(&["Annual report overview"]), &pages), vec![1]);
        assert!(forced_break_pages_from_texts(&strings(&["Annual reportSomething"]), &pages).is_empty());
    }

    #[test]
    fn a_session_without_pages_an_export_or_an_authored_source_has_no_forced_breaks() {
        let proof = mixdog_fsio::Unlaned;
        let target = Path::new("missing.docx");
        let session = |format| BreakSession { format, target, html_source: None, html_source_edits: false };
        let preview = BreakPreview { has_images: true, output: "preview.PDF", export_available: None };
        assert_eq!(forced_break_pages(&proof, &session("xlsx"), &preview), Ok(None));
        assert_eq!(forced_break_pages(&proof, &session("pdf"), &preview), Ok(None));
        assert_eq!(forced_break_pages(&proof, &session("pdf"), &BreakPreview { has_images: false, ..preview }), Ok(None));
        assert_eq!(forced_break_pages(&proof, &session("pdf"), &BreakPreview { export_available: Some(false), ..preview }), Ok(None));
        assert_eq!(forced_break_pages(&proof, &session("pdf"), &BreakPreview { output: "preview.png", ..preview }), Ok(None));
    }
}
