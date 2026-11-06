//! Page text extraction (D4): an HTML document becomes tidy markdown. Semantic
//! containers win; the article extractor runs only when none holds text. There
//! is no other extractor and no fallback behind it.

use std::sync::LazyLock;

use dom_query::Document;
use dom_query::NodeRef;
use dom_query::Selection;
use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use url::Url;

use super::error::FetchError;
use super::error::FetchKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Extracted {
    pub title: String,
    pub content: String,
    /// `raw`, `dom-markdown` or `readability`.
    pub extractor: &'static str,
    /// `html`, `text`, `json` or `markdown` (Node `format`).
    pub format: &'static str,
    /// The lower-cased MIME type, or `text/html` for an HTML page without one (Node `contentType`).
    pub content_type: String,
    /// The first 240 UTF-16 units of the text before any `og:image` lines (Node `excerpt`).
    pub excerpt: String,
    /// `JSON.stringify(excerpt).length` in Node, where a cut inside a surrogate pair leaves a
    /// lone surrogate written as six units; `excerpt` itself shows it as U+FFFD.
    pub excerpt_json_len: usize,
}

fn collapse_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending = false;
    for c in text.chars() {
        if is_js_space(c) {
            pending = true;
        } else {
            if pending {
                out.push(' ');
                pending = false;
            }
            out.push(c);
        }
    }
    if pending {
        out.push(' ');
    }
    out
}

fn safe_link(value: Option<&str>, base: &Url) -> String {
    let Some(value) = value else {
        return String::new();
    };
    match base.join(value) {
        Ok(url) if matches!(url.scheme(), "http" | "https" | "mailto") => url.to_string(),
        _ => String::new(),
    }
}

fn attr(node: &NodeRef, name: &str) -> Option<String> {
    node.attr(name).map(|value| value.to_string())
}

fn tag_of(node: &NodeRef) -> String {
    node.node_name()
        .map(|name| name.to_ascii_lowercase())
        .unwrap_or_default()
}

fn element_children<'a>(node: &NodeRef<'a>) -> Vec<NodeRef<'a>> {
    node.children().into_iter().filter(|child| child.is_element()).collect()
}

fn backtick_runs(text: &str) -> impl Iterator<Item = usize> + '_ {
    text.split(|c| c != '`').map(str::len).filter(|len| *len > 0)
}

use mixdog_js::number_to_string as format_number;
use mixdog_js::string_to_number as js_number;

static LANGUAGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:language|lang)-([\w+-]+)", ""));
static ESCAPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"([\\`*_\[\]])", ""));

fn markdown(node: &NodeRef, base: &Url) -> String {
    if node.is_text() {
        return ESCAPE.replace_all_with(&collapse_space(&node.text()), |caps| format!("\\{}", caps.get(1).unwrap_or_default()));
    }
    if !node.is_element() {
        return String::new();
    }
    let tag = tag_of(node);
    let children = || -> String { node.children().iter().map(|child| markdown(child, base)).collect() };
    match tag.as_str() {
        "pre" => {
            let text = node.text().replace("\r\n", "\n");
            let code = text.strip_suffix('\n').unwrap_or(&text);
            let longest = backtick_runs(code).max().unwrap_or(0).max(2);
            let fence = "`".repeat(longest + 1);
            let language = Selection::from(node.clone())
                .select_single("code")
                .nodes()
                .first()
                .and_then(|inner| attr(inner, "class"))
                .and_then(|class| LANGUAGE.captures(&class).and_then(|c| c.get(1).map(str::to_string)))
                .unwrap_or_default();
            format!("\n\n{fence}{language}\n{code}\n{fence}\n\n")
        }
        "code" => {
            let text = collapse_space(&node.text());
            let fence = "`".repeat(backtick_runs(&text).max().unwrap_or(0) + 1);
            format!("{fence} {text} {fence}")
        }
        "br" => "\n".to_string(),
        "hr" => "\n\n---\n\n".to_string(),
        "img" => {
            let alt = attr(node, "alt").map(|alt| js_trim(&alt).to_string()).unwrap_or_default();
            let url = safe_link(attr(node, "src").as_deref(), base);
            if !alt.is_empty() && !url.is_empty() {
                format!("![{}](<{url}>)", alt.replace(['[', ']'], ""))
            } else {
                String::new()
            }
        }
        "a" => {
            let label = js_trim(&children()).to_string();
            let url = safe_link(attr(node, "href").as_deref(), base);
            if !label.is_empty() && !url.is_empty() {
                format!("[{label}](<{url}>)")
            } else {
                label
            }
        }
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
            let level: usize = tag[1..].parse().unwrap_or(1);
            format!("\n\n{} {}\n\n", "#".repeat(level), js_trim(&children()))
        }
        "strong" | "b" => format!("**{}**", js_trim(&children())),
        "em" | "i" => format!("*{}*", js_trim(&children())),
        "blockquote" => {
            let quoted: Vec<String> = js_trim(&children()).split('\n').map(|line| format!("> {line}")).collect();
            format!("\n\n{}\n\n", quoted.join("\n"))
        }
        "table" => table(node, base),
        "ul" | "ol" => {
            let ordered = tag == "ol";
            let start = attr(node, "start").map(|value| js_number(&value)).unwrap_or(f64::NAN);
            let mut index = if start.is_nan() || start == 0.0 { 1.0 } else { start };
            let items: Vec<String> = element_children(node)
                .iter()
                .map(|item| {
                    let prefix = if ordered {
                        let prefix = format!("{}. ", format_number(index));
                        index += 1.0;
                        prefix
                    } else {
                        "- ".to_string()
                    };
                    let indent = format!("\n{}", " ".repeat(prefix.len()));
                    format!("{prefix}{}", js_trim(&markdown(item, base)).replace('\n', &indent))
                })
                .collect();
            format!("\n\n{}\n\n", items.join("\n"))
        }
        "p" | "div" | "section" | "article" | "main" | "header" | "figure" | "figcaption" | "dl" | "dt" | "dd" => {
            format!("\n\n{}\n\n", js_trim(&children()))
        }
        _ => children(),
    }
}

fn table(node: &NodeRef, base: &Url) -> String {
    let rows: Vec<Vec<String>> = Selection::from(node.clone())
        .select("tr")
        .nodes()
        .iter()
        .filter(|row| {
            row.ancestors(None)
                .iter()
                .find(|ancestor| ancestor.is_element() && tag_of(ancestor) == "table")
                .is_some_and(|table| table.id == node.id)
        })
        .map(|row| {
            element_children(row)
                .iter()
                .filter(|cell| matches!(tag_of(cell).as_str(), "td" | "th"))
                .map(|cell| {
                    let text = markdown(cell, base);
                    let joined: Vec<&str> = js_trim(&text).split('\n').filter(|part| !part.is_empty()).collect();
                    joined.join("<br>").replace('|', "\\|")
                })
                .collect()
        })
        .collect();
    if rows.is_empty() {
        return String::new();
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let render = |row: &[String]| -> String {
        let cells: Vec<&str> = (0..width).map(|i| row.get(i).map_or("", String::as_str)).collect();
        format!("| {} |", cells.join(" | "))
    };
    let separator = vec!["---".to_string(); width];
    let body: Vec<String> = rows[1..].iter().map(|row| render(row)).collect();
    format!("\n\n{}\n{}\n{}\n\n", render(&rows[0]), render(&separator), body.join("\n"))
}

/// Blank-line squeeze that leaves fenced code untouched.
fn tidy_markdown(text: &str) -> String {
    static FENCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(`{3,})", ""));
    let mut fence: Option<usize> = None;
    let mut blanks = 0;
    let mut kept: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if let Some(open) = FENCE.captures(line) {
            let len = open.get(1).unwrap_or_default().len();
            match fence {
                None => fence = Some(len),
                Some(current) if len >= current => fence = None,
                Some(_) => {}
            }
        }
        if fence.is_some() || !js_trim(line).is_empty() {
            blanks = 0;
            kept.push(line);
        } else {
            blanks += 1;
            if blanks <= 1 {
                kept.push(line);
            }
        }
    }
    js_trim(&kept.join("\n")).to_string()
}

pub fn assert_readable(content: &str) -> Result<(), FetchError> {
    if js_trim(content).is_empty() {
        return Err(FetchError::new(FetchKind::EmptyContent, "No readable content in response"));
    }
    Ok(())
}

const REMOVED: &str = "script,style,noscript,template,nav,footer,aside,[hidden],[aria-hidden=\"true\"],[inert]";
const CONTAINERS: &str = "main,[role=\"main\"],article,.markdown-body,[itemprop=\"articleBody\"]";

fn meta_content(doc: &Document, selector: &str) -> Option<String> {
    let found = doc.select_single(selector);
    let node = found.nodes().first()?;
    attr(node, "content").filter(|content| !content.is_empty())
}

fn document_title(doc: &Document) -> String {
    let title = doc.select_single("title");
    title
        .nodes()
        .first()
        .map(|node| collapse_space(&node.text()))
        .map(|text| js_trim(&text).to_string())
        .unwrap_or_default()
}

/// Article extraction on a copy of the pruned document, returning its markdown
/// when the extractor finds text.
fn readability_markdown(doc: &Document, url: &Url) -> Option<String> {
    let mut reader = dom_smoothie::Readability::new(doc.html().to_string(), Some(url.as_str()), None).ok()?;
    let article = reader.parse().ok()?;
    if js_trim(&article.text_content).is_empty() || article.content.is_empty() {
        return None;
    }
    let wrapper = Document::from(format!("<div>{}</div>", article.content));
    let root = wrapper.select_single("body > div");
    root.nodes().first().map(|node| markdown(node, url))
}

fn is_html(mime: &str, body: &str) -> bool {
    if mime == "text/html" || mime == "application/xhtml+xml" {
        return true;
    }
    static SNIFF: LazyLock<JsRegex> =
        LazyLock::new(|| JsRegex::new_static(r"^\s*(?:<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])", "i"));
    mime.is_empty() && SNIFF.is_match(body)
}

pub fn extract_document(url: &Url, body: &str, content_type: &str) -> Result<Extracted, FetchError> {
    let mime = js_trim(content_type.split(';').next().unwrap_or_default()).to_lowercase();
    if !is_html(&mime, body) {
        assert_readable(body)?;
        let path = url.path().to_lowercase();
        let format = if mime.contains("json") {
            "json"
        } else if mime.contains("markdown") || path.ends_with(".md") || path.ends_with(".mdown") {
            "markdown"
        } else {
            "text"
        };
        return Ok(Extracted {
            title: String::new(),
            content: body.to_string(),
            extractor: "raw",
            format,
            excerpt: mixdog_js::slice_utf16(body, 240),
            excerpt_json_len: mixdog_js::json_cut_utf16_len(body, 240),
            content_type: mime,
        });
    }
    let doc = Document::from(body);
    let title = document_title(&doc);
    let images: Vec<String> = ["meta[property=\"og:image\"]", "meta[name=\"twitter:image\"]"]
        .iter()
        .filter_map(|selector| meta_content(&doc, selector))
        .collect();
    doc.select(REMOVED).remove();
    let mut root: Option<(NodeRef, usize)> = None;
    for candidate in doc.select(CONTAINERS).nodes() {
        let length = utf16_len(js_trim(&candidate.text()));
        if root.as_ref().is_none_or(|(_, best)| length > *best) {
            root = Some((candidate.clone(), length));
        }
    }
    let (text, extractor) = match root.filter(|(_, length)| *length > 0) {
        Some((node, _)) => (markdown(&node, url), "dom-markdown"),
        None => match readability_markdown(&doc, url) {
            Some(text) => (text, "readability"),
            None => {
                let body_node = doc.select_single("body");
                let text = body_node.nodes().first().map(|node| markdown(node, url)).unwrap_or_default();
                (text, "dom-markdown")
            }
        },
    };
    let content = tidy_markdown(&text);
    assert_readable(&content)?;
    let excerpt = mixdog_js::slice_utf16(&content, 240);
    let excerpt_json_len = mixdog_js::json_cut_utf16_len(&content, 240);
    let mut unique: Vec<&String> = Vec::new();
    for value in &images {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    let lines: Vec<String> = unique
        .into_iter()
        .map(|value| safe_link(Some(value), url))
        .filter(|link| !link.is_empty())
        .map(|link| format!("og:image: {link}"))
        .collect();
    let content = if lines.is_empty() {
        content
    } else {
        format!("{}\n\n{content}", lines.join("\n"))
    };
    Ok(Extracted {
        title: js_trim(&title).to_string(),
        content,
        extractor,
        format: "html",
        content_type: if mime.is_empty() { "text/html".to_string() } else { mime },
        excerpt,
        excerpt_json_len,
    })
}
