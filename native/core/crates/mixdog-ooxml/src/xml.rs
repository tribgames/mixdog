//! `portable/portable-xml.mjs`: the regex-based tag, attribute, paragraph and run walkers every Office part is cut and
//! edited with. The Node code edits XML as strings; so does this, and every pattern is a `JsRegex`, so a match is the one
//! V8 finds (lazy `[\s\S]`, look-ahead, `\p{L}`).

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use mixdog_js::{JsRegex, is_js_space, js_trim, js_words};

/// A template placeholder, `{{name}}`, where the name is written in the document's own script (read with the `u` flag).
pub const TEMPLATE_TOKEN_SOURCE: &str = r"\{\{\s*([\p{L}\p{N}_.-]+)\s*\}\}";

/// One sectPr element and nothing past it: a document with section breaks carries a sectPr inside each break paragraph
/// as well, and a pattern allowed to run across them would read the first of those as the document's own.
pub const SECTION_PROPERTIES_SOURCE: &str = r"<w:sectPr(?:\s[^>]*)?(?:\/>|>(?:(?!<w:sectPr)[\s\S])*?<\/w:sectPr>)";

/// One Word run: its opening tag, and the run properties that may lead its content. The run itself is a source string,
/// so each walk compiles a pattern of its own.
pub const WORD_RUN_SOURCE: &str = r"<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>";
pub const WORD_RUN_OPEN_SOURCE: &str = r"^<w:r(?:\s[^>]*)?>";
pub const WORD_RUN_PROPERTIES_SOURCE: &str = r"^\s*(?:<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>|<w:rPr\/>)";

pub const WORD_MAIN_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub const SPREADSHEET_MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
pub const SPREADSHEET_DRAWING_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
pub const DRAWING_MAIN_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
pub const OFFICE_RELATIONSHIP_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

pub const XML_HEADER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n";

/// `OOXML_REQUIRED[format]`: the parts a package of that format must hold.
pub fn ooxml_required(format: &str) -> Option<[&'static str; 2]> {
    match format {
        "docx" => Some(["[Content_Types].xml", "word/document.xml"]),
        "xlsx" => Some(["[Content_Types].xml", "xl/workbook.xml"]),
        "pptx" => Some(["[Content_Types].xml", "ppt/presentation.xml"]),
        _ => None,
    }
}

/// The compiled pattern of a source and its flags, built once: a tag name builds a pattern, and the same few names
/// recur across every part of every document. Some sources carry text of the call (a find text, a cell reference, a part
/// name), so the cache starts over once it holds 1,024 patterns rather than growing for the life of the
/// process.
pub fn compiled(source: &str, flags: &str) -> Arc<JsRegex> {
    const COMPILED_LIMIT: usize = 1_024;
    static CACHE: LazyLock<Mutex<HashMap<String, Arc<JsRegex>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    let key = format!("{flags}/{source}");
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = cache.get(&key) {
        return Arc::clone(found);
    }
    if cache.len() >= COMPILED_LIMIT {
        cache.clear();
    }
    let regex = Arc::new(JsRegex::new_static(source, flags));
    cache.insert(key, Arc::clone(&regex));
    regex
}

/// `TRAILING_SECTION_PATTERN`: the section properties that end a document body.
pub fn trailing_section_pattern() -> Arc<JsRegex> {
    compiled(&format!(r"{SECTION_PROPERTIES_SOURCE}\s*$"), "")
}

/// `WORD_RUN_OPEN`.
pub fn word_run_open() -> Arc<JsRegex> {
    compiled(WORD_RUN_OPEN_SOURCE, "")
}

/// `WORD_RUN_PROPERTIES`.
pub fn word_run_properties() -> Arc<JsRegex> {
    compiled(WORD_RUN_PROPERTIES_SOURCE, "")
}

/// The character a numeric entity names: `String.fromCodePoint`, except that a lone surrogate (which a Rust string
/// cannot hold) is U+FFFD, and a number past U+10FFFF (a `RangeError` in Node) leaves the entity as written.
fn entity_char(digits: &str, radix: u32) -> Option<char> {
    let code = u32::from_str_radix(digits, radix).ok()?;
    if (0xd800..=0xdfff).contains(&code) {
        return Some('\u{fffd}');
    }
    char::from_u32(code)
}

/// `replace(/&#x([0-9a-f]+);/gi, ...)` when `hex`, `replace(/&#(\d+);/g, ...)` otherwise.
fn numeric_entities(text: &str, hex: bool) -> String {
    if !text.contains("&#") {
        return text.to_owned();
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    let mut last = 0;
    while at < bytes.len() {
        if bytes[at] == b'&' && bytes.get(at + 1) == Some(&b'#') {
            let mut end = at + 2;
            let mut matched = true;
            if hex {
                if matches!(bytes.get(end), Some(b'x' | b'X')) {
                    end += 1;
                } else {
                    matched = false;
                }
            }
            if matched {
                let digits_from = end;
                while end < bytes.len() && (if hex { bytes[end].is_ascii_hexdigit() } else { bytes[end].is_ascii_digit() }) {
                    end += 1;
                }
                if end > digits_from && bytes.get(end) == Some(&b';') {
                    if let Some(c) = entity_char(&text[digits_from..end], if hex { 16 } else { 10 }) {
                        out.push_str(&text[last..at]);
                        out.push(c);
                        last = end + 1;
                        at = end + 1;
                        continue;
                    }
                }
            }
        }
        at += 1;
    }
    out.push_str(&text[last..]);
    out
}

/// `xmlDecode`: numeric entities (hexadecimal first, then decimal), then the five named ones, `&amp;` last.
pub fn xml_decode(value: &str) -> String {
    let step = numeric_entities(value, true);
    let step = numeric_entities(&step, false);
    step.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// `xmlEncode`.
pub fn xml_encode(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

/// `tagPattern`: the tag as literal pattern text.
pub fn tag_pattern(tag: &str) -> String {
    let mut out = String::with_capacity(tag.len() + 4);
    for c in tag.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Whether a text starts or ends in white space (`/^\s|\s$/`).
fn has_edge_space(text: &str) -> bool {
    text.chars().next().is_some_and(is_js_space) || text.chars().next_back().is_some_and(is_js_space)
}

static XML_SPACE_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\bxml:space=", ""));

/// `attrs` with `xml:space="preserve"` added when `text` has edge white space and the attributes do not say.
fn preserving_space(attrs: &str, text: &str) -> String {
    if has_edge_space(text) && !XML_SPACE_ATTRIBUTE.is_match(attrs) { format!("{attrs} xml:space=\"preserve\"") } else { attrs.to_owned() }
}

/// `text.slice(from, to)` on byte offsets: what lies outside the text, or between characters, is empty.
fn cut(text: &str, from: usize, to: usize) -> &str {
    text.get(from..to.min(text.len())).unwrap_or("")
}

/// A text element found by [`text_nodes`]: where it lies in the source, its attributes as written and its decoded text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextNode {
    pub start: usize,
    pub end: usize,
    pub attrs: String,
    pub text: String,
}

/// `textNodes(xml, tag)`: every `<tag ...>text</tag>` (a self-closing tag has no text and is not one).
pub fn text_nodes(xml: &str, tag: &str) -> Vec<TextNode> {
    let t = tag_pattern(tag);
    let regex = compiled(&format!(r"<{t}(\s[^>]*)?>([\s\S]*?)</{t}>"), "g");
    regex
        .captures_iter(xml)
        .map(|found| {
            let range = found.range();
            TextNode { start: range.start, end: range.end, attrs: found.get(1).unwrap_or("").to_owned(), text: xml_decode(found.get(2).unwrap_or("")) }
        })
        .collect()
}

/// `rebuildTextNodes`: the source with each node written back from its attributes and text.
pub fn rebuild_text_nodes(xml: &str, tag: &str, nodes: &[TextNode]) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    for node in nodes {
        out.push_str(cut(xml, cursor, node.start));
        let attrs = preserving_space(&node.attrs, &node.text);
        out.push_str(&format!("<{tag}{attrs}>{}</{tag}>", xml_encode(&node.text)));
        cursor = node.end;
    }
    out.push_str(xml.get(cursor..).unwrap_or(""));
    out
}

/// `nodeAtOffset`: the node an offset of the joined text falls in, and the offset inside it.
fn node_at_offset(nodes: &[TextNode], offset: usize, use_previous_at_boundary: bool) -> Option<(usize, usize)> {
    let mut current = 0;
    for (index, node) in nodes.iter().enumerate() {
        let next = current + node.text.len();
        if offset < next || (use_previous_at_boundary && offset == next && next > current) {
            return Some((index, offset.saturating_sub(current)));
        }
        current = next;
    }
    nodes.last().map(|last| (nodes.len() - 1, last.text.len()))
}

/// The result of a replacement: the XML and how many times the text was replaced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replaced {
    pub xml: String,
    pub count: usize,
}

/// `replaceAcrossRuns(xml, tag, find, replacement)`: every occurrence of `find` in the joined text of the runs, where a
/// match may start in one run and end in another; the replacement lands in the first run it touches.
pub fn replace_across_runs(xml: &str, tag: &str, find: &str, replacement: &str) -> Result<Replaced, String> {
    if find.is_empty() {
        return Err("replace_text requires non-empty find".to_owned());
    }
    let mut nodes = text_nodes(xml, tag);
    if nodes.is_empty() {
        return Ok(Replaced { xml: xml.to_owned(), count: 0 });
    }
    let joined: String = nodes.iter().map(|node| node.text.as_str()).collect();
    let mut occurrences = Vec::new();
    let mut cursor = 0;
    while cursor + find.len() <= joined.len() {
        let Some(relative) = joined.get(cursor..).and_then(|rest| rest.find(find)) else { break };
        let index = cursor + relative;
        occurrences.push(index);
        cursor = index + find.len();
    }
    for occurrence in occurrences.iter().rev() {
        let (Some((start_index, start_offset)), Some((end_index, end_offset))) =
            (node_at_offset(&nodes, *occurrence, false), node_at_offset(&nodes, occurrence + find.len(), true))
        else {
            continue;
        };
        if start_index == end_index {
            let source = nodes[start_index].text.clone();
            nodes[start_index].text = format!("{}{replacement}{}", cut(&source, 0, start_offset), cut(&source, end_offset, source.len()));
            continue;
        }
        let first = nodes[start_index].text.clone();
        nodes[start_index].text = format!("{}{replacement}", cut(&first, 0, start_offset));
        for index in start_index + 1..end_index {
            nodes[index].text = String::new();
        }
        let last = nodes[end_index].text.clone();
        nodes[end_index].text = cut(&last, end_offset, last.len()).to_owned();
    }
    Ok(Replaced { xml: rebuild_text_nodes(xml, tag, &nodes), count: occurrences.len() })
}

/// The tags [`replace_in_paragraphs`] walks: the paragraph, its text run and its soft break.
#[derive(Debug, Clone, Copy)]
pub struct ParagraphTags<'a> {
    pub paragraph: &'a str,
    pub run: &'a str,
    pub line_break: &'a str,
}

impl Default for ParagraphTags<'_> {
    fn default() -> Self {
        Self { paragraph: "a:p", run: "a:t", line_break: "a:br" }
    }
}

/// One run or soft break of a paragraph.
struct Token<'a> {
    start: usize,
    end: usize,
    raw: &'a str,
    is_break: bool,
    attrs: String,
    text: String,
    removed: bool,
}

/// The token a text offset falls in and the offset at which that token starts.
fn token_at(tokens: &[Token<'_>], offset: usize) -> (usize, usize) {
    let mut position = 0;
    for (index, token) in tokens.iter().enumerate() {
        if offset < position + token.text.len() {
            return (index, position);
        }
        position += token.text.len();
    }
    let last = tokens.len().saturating_sub(1);
    (last, position - tokens.last().map_or(0, |token| token.text.len()))
}

/// `replaceInParagraphs`: replace_text on a slide, paragraph by paragraph, reading a soft break as the space it stands
/// for. An authored deck pre-wraps Hangul by the eojeol with `<a:br/>` between runs, and the space at the wrap is gone:
/// "올해 상반기에도" is stored as "올해", a break, "상반기에도", so the phrase the reader sees could never be found. A space
/// in `find` matches a space or a break; a break inside a match is removed with it, so the new words run as one line. A
/// match never crosses from one paragraph (or shape) into the next.
pub fn replace_in_paragraphs(xml: &str, find: &str, replacement: &str, tags: &ParagraphTags<'_>) -> Result<Replaced, String> {
    if find.is_empty() {
        return Err("replace_text requires non-empty find".to_owned());
    }
    let words: Vec<String> = js_words(js_trim(find)).map(tag_pattern).collect();
    if words.is_empty() {
        return Err("replace_text requires non-empty find".to_owned());
    }
    let lead = if find.chars().next().is_some_and(is_js_space) { r"[ \n]+" } else { "" };
    let tail = if find.chars().next_back().is_some_and(is_js_space) { r"[ \n]+" } else { "" };
    let body = words.join(r"[ \n]+");
    let pattern = compiled(&format!("{lead}{body}{tail}"), "g");
    let run = tag_pattern(tags.run);
    let line_break = tag_pattern(tags.line_break);
    let token_pattern = compiled(&format!(r"<{run}(\s[^>]*)?>([\s\S]*?)</{run}>|<{line_break}\b(?:[^>]*?/>|[^>]*>[\s\S]*?</{line_break}>)"), "g");
    let paragraph = tag_pattern(tags.paragraph);
    let paragraph_pattern = compiled(&format!(r"<{paragraph}\b[^>]*>[\s\S]*?</{paragraph}>"), "g");
    let count = Cell::new(0_usize);
    let next = paragraph_pattern.replace_all_with(xml, |paragraph_match| {
        let source = &xml[paragraph_match.range()];
        let mut tokens: Vec<Token<'_>> = token_pattern
            .captures_iter(source)
            .map(|found| {
                let range = found.range();
                let inner = found.get(2);
                Token {
                    start: range.start,
                    end: range.end,
                    raw: &source[range.clone()],
                    is_break: inner.is_none(),
                    attrs: found.get(1).unwrap_or("").to_owned(),
                    text: inner.map_or_else(|| "\n".to_owned(), xml_decode),
                    removed: false,
                }
            })
            .collect();
        let text: String = tokens.iter().map(|token| token.text.as_str()).collect();
        let matches: Vec<std::ops::Range<usize>> = pattern.find_iter(&text).collect();
        if matches.is_empty() {
            return source.to_owned();
        }
        count.set(count.get() + matches.len());
        for found in matches.iter().rev() {
            let (first, first_start) = token_at(&tokens, found.start);
            let first_offset = found.start - first_start;
            let (last, last_start) = token_at(&tokens, found.end - 1);
            let last_to = found.end - last_start;
            for index in first..=last {
                if tokens[index].is_break {
                    tokens[index].removed = true;
                    continue;
                }
                let from = if index == first { first_offset } else { 0 };
                let to = if index == last { last_to } else { tokens[index].text.len() };
                let current = tokens[index].text.clone();
                let inserted = if index == first { replacement } else { "" };
                tokens[index].text = format!("{}{inserted}{}", cut(&current, 0, from), cut(&current, to, current.len()));
            }
            // The replacement lands in the first run the match touches; a match that starts on a break (never, since
            // find starts with a word unless it leads with a space) would leave it in the next run instead.
            if tokens[first].is_break {
                if let Some(host) = tokens[first..].iter_mut().find(|token| !token.is_break) {
                    host.text = format!("{replacement}{}", host.text);
                }
            }
        }
        let mut rebuilt = String::with_capacity(source.len());
        let mut cursor = 0;
        for token in &tokens {
            rebuilt.push_str(cut(source, cursor, token.start));
            if !token.removed {
                if token.is_break {
                    rebuilt.push_str(token.raw);
                } else {
                    let attrs = preserving_space(&token.attrs, &token.text);
                    rebuilt.push_str(&format!("<{}{attrs}>{}</{}>", tags.run, xml_encode(&token.text), tags.run));
                }
            }
            cursor = token.end;
        }
        rebuilt.push_str(source.get(cursor..).unwrap_or(""));
        rebuilt
    });
    Ok(Replaced { xml: next, count: count.get() })
}

/// `paragraphTexts(xml, tag)`: the non-empty texts of the elements, in order.
pub fn paragraph_texts(xml: &str, tag: &str) -> Vec<String> {
    text_nodes(xml, tag).into_iter().map(|node| node.text).filter(|text| !text.is_empty()).collect()
}

/// `blockText(xml, tag)`: the text of a block as a reader sees it: runs joined as written (a bold run mid-sentence
/// carries no space), a line break (`<a:br>`, `<w:br>`) as a newline, a run's tab (`<w:tab/>`, never a tab-stop
/// definition, which carries attributes) as a tab, and paragraphs (`<a:p>`, `<w:p>`) separated by a newline. The scan is
/// a token walk, not a paragraph extraction, so a slice that starts or ends inside a paragraph keeps every run and still
/// marks the paragraph ends it crosses; an empty paragraph is one blank line; trailing blanks are dropped.
pub fn block_text(xml: &str, tag: &str) -> String {
    let prefix = tag_pattern(tag.split(':').next().unwrap_or(""));
    let run = tag_pattern(tag);
    let token = compiled(
        &format!(
            r"<{run}(?:\s[^>]*)?>([\s\S]*?)</{run}>|<{prefix}:br\b(?:[^>]*?/>|[^>]*>[\s\S]*?</{prefix}:br>)|(<{prefix}:tab\s*/>)|</{prefix}:p>|<{prefix}:p\b[^>]*/>"
        ),
        "g",
    );
    let mut text = String::new();
    for found in token.captures_iter(xml) {
        if found.get(2).is_some_and(|tab| !tab.is_empty()) {
            text.push('\t');
        } else if let Some(inner) = found.get(1) {
            text.push_str(&xml_decode(inner));
        } else {
            text.push('\n');
        }
    }
    text.trim_end_matches('\n').to_owned()
}

/// An element of [`top_level_elements`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Element {
    pub name: String,
    pub start: usize,
    pub end: usize,
    pub xml: String,
}

static ANY_TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<([/]?)([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?([/]?)>", "g"));

/// `topLevelElements(fragment, acceptedTags)`: the accepted elements that are not inside another element, in source
/// order; a self-closing one is kept, one that never closes is not.
pub fn top_level_elements(fragment: &str, accepted: &[&str]) -> Vec<Element> {
    let mut elements = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut tracked: Option<(String, usize)> = None;
    for found in ANY_TAG.captures_iter(fragment) {
        let range = found.range();
        let closing = found.get(1) == Some("/");
        let name = found.get(2).unwrap_or("");
        let self_closing = found.get(3) == Some("/");
        if closing {
            let opened = stack.pop();
            let closes_tracked = stack.is_empty() && tracked.as_ref().is_some_and(|(name, _)| opened.as_deref() == Some(name.as_str()));
            if closes_tracked {
                if let Some((tracked_name, tracked_start)) = tracked.take() {
                    elements.push(Element { xml: fragment[tracked_start..range.end].to_owned(), name: tracked_name, start: tracked_start, end: range.end });
                }
            }
            continue;
        }
        if stack.is_empty() && accepted.contains(&name) {
            if self_closing {
                elements.push(Element { name: name.to_owned(), start: range.start, end: range.end, xml: fragment[range.clone()].to_owned() });
            } else {
                tracked = Some((name.to_owned(), range.start));
            }
        }
        if !self_closing {
            stack.push(name.to_owned());
        }
    }
    elements
}

/// What [`container_inner`] finds: where the content starts and ends, and the content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub start: usize,
    pub end: usize,
    pub inner: String,
}

/// `containerInner(xml, tag, from)`: the content of the first container element at or after `from`, balanced against
/// nested ones of the same name; an empty element (`<tag/>`) is not a container, and `None` is an unclosed one.
pub fn container_inner(xml: &str, tag: &str, from: usize) -> Option<Container> {
    let t = tag_pattern(tag);
    let opener = compiled(&format!(r"<{t}(?:\s[^>]*?)?(/?)>"), "g");
    let rest = xml.get(from..)?;
    let open_end = {
        let open = opener.captures_iter(rest).find(|found| found.get(1) != Some("/"))?;
        from + open.range().end
    };
    let scanner = compiled(&format!(r"<{t}(?:\s[^>]*?)?(/?)>|</{t}>"), "g");
    let mut depth = 1_usize;
    for found in scanner.captures_iter(&xml[open_end..]) {
        let range = found.range();
        if xml[open_end + range.start..open_end + range.end].starts_with("</") {
            depth -= 1;
            if depth > 0 {
                continue;
            }
            let end = open_end + range.start;
            return Some(Container { start: open_end, end, inner: xml[open_end..end].to_owned() });
        }
        if found.get(1) != Some("/") {
            depth += 1;
        }
    }
    None
}

/// `setXmlAttribute(attributes, name, value)`: the attribute rewritten where it is, appended where it is not.
pub fn set_xml_attribute(attributes: &str, name: &str, value: &str) -> String {
    let pattern = compiled(&format!(r#"\b{name}="[^"]*""#), "i");
    match pattern.find(attributes) {
        Some(range) => format!("{}{name}=\"{value}\"{}", &attributes[..range.start], &attributes[range.end..]),
        None => format!("{attributes} {name}=\"{value}\""),
    }
}

/// An element of [`element_spans`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub attrs: String,
    pub xml: String,
}

/// `elementSpans(fragment, tag)`: every `<tag ...>...</tag>` and `<tag .../>`, never a longer name that starts with it.
pub fn element_spans(fragment: &str, tag: &str) -> Vec<Span> {
    let t = tag_pattern(tag);
    let regex = compiled(&format!(r"<{t}\b([^>]*?)(\/>|>[\s\S]*?<\/{t}>)"), "g");
    regex
        .captures_iter(fragment)
        .map(|found| {
            let range = found.range();
            Span { start: range.start, end: range.end, attrs: found.get(1).unwrap_or("").to_owned(), xml: fragment[range].to_owned() }
        })
        .collect()
}

/// `containerBody(xml, tag)`: what lies between the opening tag and the last closing one (a missing closing tag cuts the
/// last character, as `slice(start, -1)` does).
pub fn container_body(xml: &str, tag: &str) -> String {
    if xml.ends_with("/>") {
        return String::new();
    }
    let start = xml.find('>').map_or(0, |at| at + 1);
    let end = xml.rfind(&format!("</{tag}>")).unwrap_or_else(|| xml.len() - xml.chars().next_back().map_or(0, char::len_utf8));
    cut(xml, start, end).to_owned()
}

/// `upsertOrderedChild(xml, order, tag, element)`: the child written in schema order: before the first later sibling that
/// is present, else before the closing tag of the parent. An empty `element` removes the child.
pub fn upsert_ordered_child(xml: &str, order: &[&str], tag: &str, element: &str) -> String {
    let t = tag_pattern(tag);
    let own = compiled(&format!(r"<{t}\b[^>]*?(?:\/>|>[\s\S]*?<\/{t}>)"), "");
    let stripped = match own.find(xml) {
        Some(range) => format!("{}{}", &xml[..range.start], &xml[range.end..]),
        None => xml.to_owned(),
    };
    if element.is_empty() {
        return stripped;
    }
    let later = match order.iter().position(|candidate| *candidate == tag) {
        Some(index) => &order[index + 1..],
        None => order,
    };
    for candidate in later {
        let c = tag_pattern(candidate);
        let found = compiled(&format!(r"<{c}\b[^>]*?(?:\/>|>[\s\S]*?<\/{c}>)"), "");
        if let Some(range) = found.find(&stripped) {
            return format!("{}{element}{}", &stripped[..range.start], &stripped[range.start..]);
        }
    }
    static CLOSING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<\/[A-Za-z:]+>\s*$", ""));
    match CLOSING.find(&stripped) {
        Some(range) => format!("{}{element}{}", &stripped[..range.start], &stripped[range.start..]),
        None => stripped,
    }
}

/// `xmlAttribute(attributes, name)`: the attribute's value, `""` when it is absent.
pub fn xml_attribute(attributes: &str, name: &str) -> String {
    let pattern = compiled(&format!(r#"\b{name}="([^"]*)""#), "i");
    pattern.captures(attributes).and_then(|found| found.get(1).map(str::to_owned)).unwrap_or_default()
}

static TRACK_REVISIONS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<w:trackRevisions\b([^>]*)\/?>", ""));

/// `settingsTrackChanges(settingsXml)`: whether word/settings.xml says new edits are recorded as revisions. Word drops
/// the element when the author turns tracking off, but a converted or template-based file writes it as `w:val="false"`
/// instead; reading the element alone would call that document tracked.
pub fn settings_track_changes(settings_xml: &str) -> bool {
    let Some(found) = TRACK_REVISIONS.captures(settings_xml) else { return false };
    let declared = xml_attribute(found.get(1).unwrap_or(""), "w:val");
    !["0", "false", "off"].contains(&mixdog_js::js_to_lowercase(&declared).as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entities_decode_in_node_order() {
        assert_eq!(xml_decode("a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos;"), "a&b <c> \"d\" 'e'");
        assert_eq!(xml_decode("&#x41;&#X42;&#67;"), "ABC");
        // `&#x26;lt;` decodes to `&lt;` in the numeric pass and then to `<`, as the chained replaces do.
        assert_eq!(xml_decode("&#x26;lt;"), "<");
        assert_eq!(xml_decode("&amp;lt;"), "&lt;");
        assert_eq!(xml_decode("&#x1F600;"), "\u{1f600}");
        assert_eq!(xml_decode("&#;&#x;&#xZZ;"), "&#;&#x;&#xZZ;");
    }

    #[test]
    fn encoding_escapes_the_five() {
        assert_eq!(xml_encode(r#"a&b<c>"d"'e'"#), "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;");
    }

    #[test]
    fn text_nodes_preserve_source_spans_attributes_escaping_and_empty_runs() {
        let first = "<w:t xml:space=\"preserve\"> A&amp;B </w:t>";
        let empty = "<w:t></w:t>";
        let xml = format!("{first}<w:br/>{empty}");
        assert_eq!(
            text_nodes(&xml, "w:t"),
            vec![
                TextNode { start: 0, end: first.len(), attrs: " xml:space=\"preserve\"".into(), text: " A&B ".into() },
                TextNode { start: first.len() + 7, end: xml.len(), attrs: String::new(), text: String::new() },
            ]
        );
        assert!(text_nodes("<w:t/>", "w:t").is_empty());
    }

    #[test]
    fn top_level_elements_exclude_nested_matches_and_keep_self_closing_siblings() {
        let nested = "<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>";
        let paragraph = "<w:p><w:r/></w:p>";
        let fragment = format!("{nested}{paragraph}<w:p/>");
        assert_eq!(
            top_level_elements(&fragment, &["w:p"]),
            vec![
                Element { name: "w:p".into(), start: nested.len(), end: nested.len() + paragraph.len(), xml: paragraph.into() },
                Element { name: "w:p".into(), start: nested.len() + paragraph.len(), end: fragment.len(), xml: "<w:p/>".into() },
            ]
        );
        assert!(top_level_elements("<w:p>", &["w:p"]).is_empty());
    }

    #[test]
    fn container_lookup_skips_empty_siblings_balances_nested_containers_and_respects_the_offset() {
        let inner = "a<w:p>b</w:p><w:p/>c";
        let first = format!("<w:p/>x<w:p>{inner}</w:p>");
        let xml = format!("{first}<w:p>last</w:p>");
        assert_eq!(container_inner(&xml, "w:p", 0), Some(Container { start: 12, end: 12 + inner.len(), inner: inner.into() }));
        assert_eq!(container_inner(&xml, "w:p", first.len()), Some(Container { start: first.len() + 5, end: first.len() + 9, inner: "last".into() }));
        assert_eq!(container_inner("<w:p/>", "w:p", 0), None);
        assert_eq!(container_inner("<w:p>unclosed", "w:p", 0), None);
    }

    #[test]
    fn element_spans_keep_attributes_and_both_forms_without_matching_longer_names() {
        let first = "<c r=\"A1\"/>";
        let second = "<c r=\"B1\"><v>7</v></c>";
        let fragment = format!("{first}{second}<cols/>");
        assert_eq!(
            element_spans(&fragment, "c"),
            vec![
                Span { start: 0, end: first.len(), attrs: " r=\"A1\"".into(), xml: first.into() },
                Span { start: first.len(), end: first.len() + second.len(), attrs: " r=\"B1\"".into(), xml: second.into() },
            ]
        );
        assert!(element_spans("<c>unclosed", "c").is_empty());
    }

    #[test]
    fn a_match_across_runs_lands_in_the_first_and_empties_the_ones_it_crosses() {
        let xml = "<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>lo wo</w:t></w:r><w:r><w:t>rld</w:t></w:r></w:p>";
        let replaced = replace_across_runs(xml, "w:t", "lo world", "there").unwrap();
        assert_eq!(replaced.count, 1);
        assert_eq!(replaced.xml, "<w:p><w:r><w:t>Hel</w:t></w:r><w:r><w:t>there</w:t></w:r><w:r><w:t></w:t></w:r></w:p>");
        let spaced = replace_across_runs("<w:t>a</w:t>", "w:t", "a", " b ").unwrap();
        assert_eq!(spaced.xml, "<w:t xml:space=\"preserve\"> b </w:t>");
        assert_eq!(replace_across_runs("<w:t>a</w:t>", "w:t", "", "x").unwrap_err(), "replace_text requires non-empty find");
    }

    #[test]
    fn a_soft_break_reads_as_the_space_it_stands_for() {
        let xml = "<a:p><a:r><a:t>올해</a:t></a:r><a:br/><a:r><a:t>상반기에도</a:t></a:r></a:p>";
        let replaced = replace_in_paragraphs(xml, "올해 상반기에도", "내년", &ParagraphTags::default()).unwrap();
        assert_eq!(replaced.count, 1);
        assert_eq!(replaced.xml, "<a:p><a:r><a:t>내년</a:t></a:r><a:r><a:t></a:t></a:r></a:p>");
        let none = replace_in_paragraphs(xml, "상반기에도 올해", "x", &ParagraphTags::default()).unwrap();
        assert_eq!((none.count, none.xml.as_str()), (0, xml));
    }

    #[test]
    fn block_text_reads_breaks_tabs_and_paragraph_ends() {
        let xml = "<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br/><w:t>b&amp;</w:t><w:tab/></w:r></w:p><w:p/><w:p><w:r><w:t>c</w:t></w:r></w:p><w:p/>";
        assert_eq!(block_text(xml, "w:t"), "a\nb&\t\n\nc");
    }

    #[test]
    fn attributes_are_set_read_and_ordered_children_upserted() {
        assert_eq!(set_xml_attribute(" a=\"1\" b=\"2\"", "b", "9"), " a=\"1\" b=\"9\"");
        assert_eq!(set_xml_attribute(" a=\"1\"", "b", "9"), " a=\"1\" b=\"9\"");
        assert_eq!(xml_attribute(" w:val=\"Off\"", "w:val"), "Off");
        assert_eq!(xml_attribute(" a=\"1\"", "w:val"), "");
        let order = ["w:rStyle", "w:b", "w:sz"];
        assert_eq!(upsert_ordered_child("<w:rPr><w:sz w:val=\"2\"/></w:rPr>", &order, "w:b", "<w:b/>"), "<w:rPr><w:b/><w:sz w:val=\"2\"/></w:rPr>");
        assert_eq!(upsert_ordered_child("<w:rPr><w:b/></w:rPr>", &order, "w:sz", "<w:sz/>"), "<w:rPr><w:b/><w:sz/></w:rPr>");
        assert_eq!(upsert_ordered_child("<w:rPr><w:b/></w:rPr>", &order, "w:b", ""), "<w:rPr></w:rPr>");
    }

    #[test]
    fn container_body_cuts_between_the_tags() {
        assert_eq!(container_body("<w:p a=\"1\">x<w:r/></w:p>", "w:p"), "x<w:r/>");
        assert_eq!(container_body("<w:p/>", "w:p"), "");
    }

    #[test]
    fn tracked_revisions_follow_the_declared_value() {
        assert!(settings_track_changes("<w:settings><w:trackRevisions/></w:settings>"));
        assert!(!settings_track_changes("<w:settings><w:trackRevisions w:val=\"false\"/></w:settings>"));
        assert!(!settings_track_changes("<w:settings><w:trackRevisions w:val=\"Off\"/></w:settings>"));
        assert!(settings_track_changes("<w:settings><w:trackRevisions w:val=\"1\"/></w:settings>"));
        assert!(!settings_track_changes("<w:settings/>"));
    }

    #[test]
    fn the_section_patterns_stop_at_one_element() {
        let xml = "<w:body><w:p><w:pPr><w:sectPr><w:cols/></w:sectPr></w:pPr></w:p><w:sectPr><w:pgSz/></w:sectPr></w:body>";
        let found = trailing_section_pattern();
        let trailing = "<w:sectPr><w:pgSz/></w:sectPr>  ";
        assert_eq!(found.find(trailing).map(|range| range.start), Some(0));
        assert!(found.find(xml).is_none());
    }
}
