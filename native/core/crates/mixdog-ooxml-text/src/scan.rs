//! The tag-level scanner the three formats share: element pairing, entity decoding, the markers for figures and hidden
//! content. Patterns are JavaScript regular expressions (`mixdog_js::JsRegex`), so `\s`, `\b` and the bounded attribute
//! class mean what they mean in Node.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::number_to_string;

use crate::Failure;
use crate::docx::PartKind;
use crate::docx::ooxml_part_text;

/// The longest run of attributes inside one tag that a pattern will cross (`ATTRS`, 4096 characters). Bounded so a tag with
/// no closing bracket cannot make a pattern rescan the part.
pub const A: &str = "[^<>]{0,4096}";

fn pattern(source: &str) -> JsRegex {
    JsRegex::new_static(source, "")
}

pub static V_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r"<v(?:\s{A})?>([^<]*)</v>")));
pub static T_RUN_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r"<t(?:\s{A})?>([^<]*)</t>")));
static HIDDEN_RUN_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r#"<w:vanish\b(?!{A}\bw:val="(?:false|0)")"#)));
static HIDDEN_SHAPE_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r#"<p:cNvPr\b{A}\bhidden="(?:1|true)""#)));
pub static HIDDEN_SLIDE_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r#"<p:sld\b{A}\bshow="0""#)));
pub static BODY_PLACEHOLDER_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r#"<p:ph\b{A}\btype="body""#)));
pub static GRAPHIC_FRAME_OPEN_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r"^<p:graphicFrame\b{A}>")));
static VANISH_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r"<w:vanish\b"));
static TEXT_TAG_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r"<w:t[\s>]"));
static SHAPE_OPEN_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r"<p:(sp|pic|graphicFrame)\b{A}>")));
static DRAWING_DESCRIPTION_RE: LazyLock<JsRegex> =
    LazyLock::new(|| pattern(&format!(r#"<(?:wp|pic|p|xdr):(?:docPr|cNvPr)\b{A}\bdescr="([^"]+)""#)));
static CHART_KIND_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r#"<c:chart\b|\bchart"|<cx:chart\b"#));
static DIAGRAM_KIND_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r"<dgm:relIds\b|diagramData"));
static RELATIONSHIP_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(&format!(r"<Relationship\b({A}?)/?>")));
static REL_ID_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r#"\bId="([^"<>]+)""#));
static REL_TARGET_RE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r#"\bTarget="([^"<>]+)""#));

/// The `i`th group of the first match of `re` in `text` (`re.exec(text)?.[i]`).
pub fn first_group<'t>(re: &JsRegex, text: &'t str) -> Option<&'t str> {
    re.captures(text)?.get(1)
}

/// The compiled `<name\b(attrs?)(/?)>` of a tag name, built once per name.
fn open_tag(name: &str) -> Arc<JsRegex> {
    static CACHE: LazyLock<Mutex<HashMap<String, Arc<JsRegex>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    let mut cache = CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    Arc::clone(
        cache
            .entry(name.to_owned())
            .or_insert_with(|| Arc::new(pattern(&format!(r"<{name}\b({A}?)(/?)>")))),
    )
}

/// One element found by [`scan_elements`]. `inner` is `None` for a self-closing tag.
pub struct Element<'a> {
    pub index: usize,
    pub attrs: &'a str,
    pub inner: Option<&'a str>,
    pub full: &'a str,
    pub end: usize,
}

/// Pairs container elements with their close tag. Every pattern here is linear in the size of the part, whatever the
/// input: attribute runs are bounded and never cross a tag boundary, and each close tag is found with a substring search
/// from the open tag's end, a name being given up for good once its close tag is absent from the rest of the part.
pub struct ScanElements<'a> {
    xml: &'a str,
    open: Arc<JsRegex>,
    close: String,
    pos: usize,
    close_absent: bool,
}

pub fn scan_elements<'a>(xml: &'a str, name: &str) -> ScanElements<'a> {
    ScanElements { xml, open: open_tag(name), close: format!("</{name}>"), pos: 0, close_absent: false }
}

impl<'a> Iterator for ScanElements<'a> {
    type Item = Element<'a>;

    fn next(&mut self) -> Option<Element<'a>> {
        loop {
            let xml: &'a str = self.xml;
            let found = self.open.captures(&xml[self.pos..])?;
            let range = found.range();
            let index = self.pos + range.start;
            let inner_start = self.pos + range.end;
            let attrs = found.get(1).unwrap_or("");
            let self_closing = found.get(2).is_some_and(|slash| !slash.is_empty());
            self.pos = inner_start;
            if self_closing {
                return Some(Element { index, attrs, inner: None, full: &xml[index..inner_start], end: inner_start });
            }
            if self.close_absent {
                continue;
            }
            let Some(offset) = xml[inner_start..].find(&self.close) else {
                self.close_absent = true;
                continue;
            };
            let at = inner_start + offset;
            let end = at + self.close.len();
            self.pos = end;
            return Some(Element { index, attrs, inner: Some(&xml[inner_start..at]), full: &xml[index..end], end });
        }
    }
}

/// `firstElement(xml, name)`.
pub fn first_element<'a>(xml: &'a str, name: &str) -> Option<Element<'a>> {
    scan_elements(xml, name).next()
}

/// `String.fromCodePoint(value)` as one UTF-8 character: a surrogate code point, which a Rust string cannot hold, is the
/// replacement character Node's UTF-8 encoding gives it. A value that is no code point is Node's `RangeError`.
fn from_code_point(value: f64) -> Result<char, Failure> {
    if value.fract() != 0.0 || !(0.0..=1_114_111.0).contains(&value) {
        return Err(Failure::Other(format!("Invalid code point {}", number_to_string(value))));
    }
    Ok(char::from_u32(value as u32).unwrap_or('\u{fffd}'))
}

/// `parseInt(digits, radix)` of a non-empty run of digits of that radix.
fn parse_int(digits: &str, radix: u32) -> f64 {
    if radix == 10 {
        return digits.parse::<f64>().unwrap_or(f64::INFINITY);
    }
    match u128::from_str_radix(digits, radix) {
        Ok(value) => value as f64,
        Err(_) => digits.chars().fold(0.0, |sum, c| sum * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))),
    }
}

/// `text.replace(/&#x([0-9a-fA-F]+);/g, ..)` (hex) or `text.replace(/&#(\d+);/g, ..)` (decimal).
fn replace_numeric_references(text: &str, hex: bool) -> Result<String, Failure> {
    let (prefix, radix) = if hex { ("&#x", 16) } else { ("&#", 10) };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(prefix) {
        let digits_from = at + prefix.len();
        let tail = &rest[digits_from..];
        let digits = tail.find(|c: char| !c.is_digit(radix)).unwrap_or(tail.len());
        if digits > 0 && tail[digits..].starts_with(';') {
            out.push_str(&rest[..at]);
            out.push(from_code_point(parse_int(&tail[..digits], radix))?);
            rest = &tail[digits + 1..];
        } else {
            out.push_str(&rest[..at + 1]);
            rest = &rest[at + 1..];
        }
    }
    out.push_str(rest);
    Ok(out)
}

/// `decodeXmlEntities`: numeric references, then the five named ones, each pass over the whole text in Node's order.
pub fn decode_xml_entities(text: &str) -> Result<String, Failure> {
    if !text.contains('&') {
        return Ok(text.to_owned());
    }
    let decoded = replace_numeric_references(&replace_numeric_references(text, true)?, false)?;
    Ok(decoded
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&"))
}

/// Collapses line breaks (and their surrounding blanks) into single spaces: every run of whitespace that contains a line
/// break becomes one space.
pub fn collapse_newline_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.char_indices().peekable();
    while let Some((start, first)) = chars.next() {
        let blank = is_js_space(first);
        let mut newline = first == '\n';
        let mut end = start + first.len_utf8();
        while let Some(&(at, c)) = chars.peek() {
            if is_js_space(c) != blank {
                break;
            }
            newline |= c == '\n';
            end = at + c.len_utf8();
            chars.next();
        }
        if blank && newline {
            out.push(' ');
        } else {
            out.push_str(&text[start..end]);
        }
    }
    out
}

/// `flattenLines`.
pub fn flatten_lines(text: &str) -> String {
    js_trim(&collapse_newline_runs(text)).to_owned()
}

/// A figure is content the page shows but carries no text runs: the marker says what sits there and repeats the
/// description the file gives a reader who cannot see it.
pub fn drawing_marker(xml: &str) -> Result<String, Failure> {
    let kind = if CHART_KIND_RE.is_match(xml) {
        "chart"
    } else if DIAGRAM_KIND_RE.is_match(xml) {
        "diagram"
    } else {
        "image"
    };
    let description = decode_xml_entities(first_group(&DRAWING_DESCRIPTION_RE, xml).unwrap_or(""))?;
    let description = js_trim(&description);
    Ok(if description.is_empty() { format!("[{kind}]") } else { format!("[{kind}: {description}]") })
}

/// Word can hide a run (`w:vanish`): the words stay in the file and the page does not show them. A passage the document
/// withholds is marked as one instead of dropped or trusted.
pub fn mark_hidden_word_runs(xml: &str) -> String {
    if !VANISH_RE.is_match(xml) {
        return xml.to_owned();
    }
    const OPEN: &str = "<w:r><w:t>[hidden: </w:t></w:r>";
    const CLOSE: &str = "<w:r><w:t>]</w:t></w:r>";
    let mut out = String::with_capacity(xml.len());
    let mut cursor = 0;
    let mut open = false;
    for found in scan_elements(xml, "w:r") {
        if found.inner.is_none() {
            continue;
        }
        let properties = found.inner.and_then(|inner| first_element(inner, "w:rPr")).map_or("", |element| element.full);
        let hidden = HIDDEN_RUN_RE.is_match(properties) && TEXT_TAG_RE.is_match(found.full);
        let gap = &xml[cursor..found.index];
        // A paragraph break ends the marked passage even when the next run hides too.
        if open && (!hidden || gap.contains("</w:p>")) {
            out.push_str(CLOSE);
            open = false;
        }
        out.push_str(gap);
        if hidden && !open {
            out.push_str(OPEN);
            open = true;
        }
        out.push_str(found.full);
        cursor = found.end;
    }
    if open {
        out.push_str(CLOSE);
    }
    out.push_str(&xml[cursor..]);
    out
}

/// PowerPoint's selection pane hides a shape: it stays in the file and the slide does not show it. Read as ordinary
/// slide text it would be quoted back as what the page says.
pub fn mark_hidden_slide_shapes(xml: &str) -> Result<String, Failure> {
    if !HIDDEN_SHAPE_RE.is_match(xml) {
        return Ok(xml.to_owned());
    }
    // Shapes are paired like scan_elements does: a name whose close tag is absent from the rest of the part is given up
    // for good.
    let mut absent: HashSet<&str> = HashSet::new();
    let mut rewritten = String::with_capacity(xml.len());
    let mut cursor = 0;
    let mut pos = 0;
    while let Some(found) = SHAPE_OPEN_RE.captures(&xml[pos..]) {
        let range = found.range();
        let index = pos + range.start;
        let open_end = pos + range.end;
        let name = found.get(1).unwrap_or("");
        pos = open_end;
        if absent.contains(name) {
            continue;
        }
        let close = format!("</p:{name}>");
        let Some(offset) = xml[open_end..].find(&close) else {
            absent.insert(name);
            continue;
        };
        let end = open_end + offset + close.len();
        pos = end;
        rewritten.push_str(&xml[cursor..index]);
        rewritten.push_str(&hide_shape(&xml[index..end])?);
        cursor = end;
    }
    rewritten.push_str(&xml[cursor..]);
    Ok(rewritten)
}

fn hide_shape(block: &str) -> Result<String, Failure> {
    if !HIDDEN_SHAPE_RE.is_match(block) {
        return Ok(block.to_owned());
    }
    let inside = flatten_lines(&ooxml_part_text(block, PartKind::Drawing, None)?);
    let label = if inside.is_empty() {
        let marker = drawing_marker(block)?;
        let marker = marker.strip_prefix('[').unwrap_or(&marker);
        marker.strip_suffix(']').unwrap_or(marker).to_owned()
    } else {
        inside
    };
    let label = label.replace('&', "&amp;").replace('<', "&lt;");
    Ok(format!("<a:p><a:r><a:t>[hidden: {label}]</a:t></a:r></a:p>"))
}

/// Drops the tabs/newlines a table cell or row boundary replaces.
pub fn trim_trailing_breaks(text: &str) -> &str {
    text.trim_end_matches(['\t', '\n'])
}

/// The `Relationship` entries of a `.rels` part, attribute order independent: `(Id, Target)`, only those with a Target.
pub fn relationship_list(xml: &str) -> Vec<(Option<String>, String)> {
    RELATIONSHIP_RE
        .captures_iter(xml)
        .filter_map(|found| {
            let attributes = found.get(1).unwrap_or("");
            let target = first_group(&REL_TARGET_RE, attributes)?;
            Some((first_group(&REL_ID_RE, attributes).map(str::to_owned), target.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure_text(result: Result<String, Failure>) -> String {
        match result {
            Err(Failure::Other(text) | Failure::Format(text)) => text,
            Ok(text) => panic!("no failure, got {text:?}"),
        }
    }

    #[test]
    fn entities_decode_in_passes_in_node_order() {
        assert_eq!(decode_xml_entities("&amp;lt;").unwrap(), "&lt;");
        assert_eq!(decode_xml_entities("&#38;lt;").unwrap(), "<");
        assert_eq!(decode_xml_entities("&#x41;&#66;&quot;&apos;&gt;").unwrap(), "AB\"'>");
        assert_eq!(decode_xml_entities("&#;&#x;&#xZ;&#12 &").unwrap(), "&#;&#x;&#xZ;&#12 &");
        assert_eq!(decode_xml_entities("&#x1F600;").unwrap(), "\u{1f600}");
        // A surrogate cannot live in a Rust string: it is the replacement character, as Node's UTF-8 encoding makes it.
        assert_eq!(decode_xml_entities("&#xD800;").unwrap(), "\u{fffd}");
    }

    #[test]
    fn a_reference_that_is_no_code_point_fails_as_from_code_point_does() {
        assert_eq!(failure_text(decode_xml_entities("&#x110000;")), "Invalid code point 1114112");
        assert_eq!(failure_text(decode_xml_entities(&format!("&#{};", "9".repeat(23)))), "Invalid code point 1e+23");
        assert_eq!(failure_text(decode_xml_entities(&format!("&#{};", "9".repeat(400)))), "Invalid code point Infinity");
    }

    #[test]
    fn a_run_of_blanks_with_a_line_break_becomes_one_space() {
        assert_eq!(collapse_newline_runs("a \n b"), "a b");
        assert_eq!(collapse_newline_runs("a\n\n b\t c"), "a b\t c");
        assert_eq!(collapse_newline_runs("a  b"), "a  b");
        assert_eq!(collapse_newline_runs("\n"), " ");
        assert_eq!(collapse_newline_runs("가\n나"), "가 나");
        assert_eq!(flatten_lines("\n x \n y \n"), "x y");
    }

    #[test]
    fn elements_pair_with_their_close_tag_and_a_missing_close_is_given_up() {
        let xml = r#"<c r="A1"><v>1</v></c><c r="B1"/><cols/><c r="C1"><v>3</v>"#;
        let found: Vec<(Option<&str>, &str)> = scan_elements(xml, "c").map(|element| (element.inner, element.attrs)).collect();
        // The third `<c>` has no `</c>` after it; `<cols/>` is another name.
        assert_eq!(found, vec![(Some("<v>1</v>"), r#" r="A1""#), (None, r#" r="B1""#)]);
        let element = first_element(xml, "c").unwrap();
        assert_eq!(element.full, r#"<c r="A1"><v>1</v></c>"#);
        assert_eq!(element.index, 0);
        assert_eq!(&xml[element.end..element.end + 3], "<c ");
        assert!(first_element(xml, "d").is_none());
    }

    #[test]
    fn an_attribute_run_past_the_bound_is_not_an_open_tag() {
        let long = format!("<c a=\"{}\">x</c><c>y</c>", "z".repeat(5000));
        let inner: Vec<Option<&str>> = scan_elements(&long, "c").map(|element| element.inner).collect();
        assert_eq!(inner, vec![Some("y")]);
    }

    #[test]
    fn a_figure_is_named_by_what_it_holds_and_its_description() {
        assert_eq!(drawing_marker(r#"<pic:cNvPr id="1" descr=" a &amp; b "/>"#).unwrap(), "[image: a & b]");
        assert_eq!(drawing_marker("<x/>").unwrap(), "[image]");
        assert_eq!(drawing_marker(r#"<c:chart r:id="rId1"/>"#).unwrap(), "[chart]");
        assert_eq!(drawing_marker(r#"<a:graphicData uri="x/chart"/>"#).unwrap(), "[chart]");
        assert_eq!(drawing_marker("<dgm:relIds/>").unwrap(), "[diagram]");
        assert_eq!(drawing_marker(r#"<p:cNvPr descr="d"/><dgm:relIds/>"#).unwrap(), "[diagram: d]");
    }

    #[test]
    fn hidden_word_runs_are_marked_until_the_paragraph_ends() {
        let xml = "<w:p><w:r><w:t>a</w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>b</w:t></w:r><w:r><w:rPr><w:vanish w:val=\"0\"/></w:rPr><w:t>c</w:t></w:r></w:p>";
        let marked = mark_hidden_word_runs(xml);
        assert!(marked.contains("<w:r><w:t>[hidden: </w:t></w:r><w:r><w:rPr><w:vanish/></w:rPr><w:t>b</w:t></w:r><w:r><w:t>]</w:t></w:r><w:r><w:rPr><w:vanish w:val=\"0\"/>"));
        assert_eq!(mark_hidden_word_runs("<w:p/>"), "<w:p/>");
    }

    #[test]
    fn a_hidden_shape_becomes_a_marked_paragraph() {
        let shape = r#"<p:sp><p:nvSpPr><p:cNvPr id="2" hidden="1"/></p:nvSpPr><a:p><a:r><a:t>1 &lt; 2</a:t></a:r></a:p></p:sp>"#;
        let xml = format!("<p:sp><a:p><a:r><a:t>shown</a:t></a:r></a:p></p:sp>{shape}");
        let marked = mark_hidden_slide_shapes(&xml).unwrap();
        assert!(marked.ends_with("<a:p><a:r><a:t>[hidden: 1 &lt; 2]</a:t></a:r></a:p>"), "{marked}");
        assert!(marked.starts_with("<p:sp><a:p><a:r><a:t>shown"));
        assert_eq!(mark_hidden_slide_shapes("<p:sp/>").unwrap(), "<p:sp/>");
    }

    #[test]
    fn relationships_list_id_and_target_in_any_attribute_order() {
        let rels = r#"<Relationships><Relationship Target="a.xml" Id="rId1"/><Relationship Id="rId2" Target="b.xml"></Relationship><Relationship Id="rId3"/></Relationships>"#;
        assert_eq!(
            relationship_list(rels),
            vec![(Some("rId1".to_owned()), "a.xml".to_owned()), (Some("rId2".to_owned()), "b.xml".to_owned())]
        );
    }

    #[test]
    fn trailing_breaks_are_tabs_and_newlines_only() {
        assert_eq!(trim_trailing_breaks("a\t\n\t \n"), "a\t\n\t ");
        assert_eq!(trim_trailing_breaks("a\t\n\t"), "a");
        assert_eq!(trim_trailing_breaks("\t\n"), "");
    }
}
