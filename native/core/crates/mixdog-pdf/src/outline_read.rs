//! The catalog's navigation as pdf.js 6.4 reads it: the document outline (`getOutline`), named destinations
//! (`getDestination`), the index of the page a reference names (`getPageIndex`), and the action and destination
//! dictionary parser (`Catalog.parseDestDictionary`) that outline items and link annotations share.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use url::Url;

use crate::color::ColorSpace;
use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::fonts::data::string_to_pdf_string;
use crate::object::{Dict, Obj, Ref};
use crate::xref::Xref;

/// The destination of an item or a link: a named one, or an explicit one (`[page /XYZ left top zoom]`).
#[derive(Debug, Clone)]
pub enum Dest {
    Named(String),
    Explicit(Vec<Obj>),
}

/// `SetOCGState` action data.
#[derive(Debug, Clone, PartialEq)]
pub struct SetOcgState {
    pub state: Vec<String>,
    pub preserve_rb: bool,
}

/// `ResetForm` action data.
#[derive(Debug, Clone, PartialEq)]
pub struct ResetForm {
    pub fields: Vec<String>,
    pub refs: Vec<String>,
    pub include: bool,
}

/// What `Catalog.parseDestDictionary` reads out of a dictionary with an action or a destination.
#[derive(Debug, Clone, Default)]
pub struct ActionData {
    /// The validated absolute URL (`url`), with a trailing slash where pdf.js's URL normalisation adds one.
    pub url: Option<String>,
    /// The URL as the file holds it (`unsafeUrl`).
    pub unsafe_url: Option<String>,
    pub dest: Option<Dest>,
    /// A named action (`NextPage`, `Print`...).
    pub action: Option<String>,
    pub new_window: Option<bool>,
    pub set_ocg_state: Option<SetOcgState>,
    pub reset_form: Option<ResetForm>,
}

/// One bookmark.
#[derive(Debug, Clone)]
pub struct OutlineItem {
    pub action: Option<String>,
    pub dest: Option<Dest>,
    pub url: Option<String>,
    pub unsafe_url: Option<String>,
    pub new_window: Option<bool>,
    pub set_ocg_state: Option<SetOcgState>,
    pub title: String,
    /// `[r, g, b]`, black unless the item has a non-black `/C`.
    pub color: [u8; 3],
    pub count: Option<i64>,
    pub bold: bool,
    pub italic: bool,
    pub items: Vec<OutlineItem>,
}

fn format_error(message: impl Into<String>) -> PdfError {
    PdfError::Format(message.into())
}

/// A PDF string as the JavaScript string pdf.js's lexer makes of it: one char per byte.
pub(crate) fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// The bytes of a name or a latin-1 string.
fn latin1_bytes(text: &str) -> Vec<u8> {
    text.chars().map(|c| c as u32 as u8).collect()
}

/// `stringToUTF8String`: the characters, all below 256, read as UTF-8 bytes; the text itself when they are not.
fn string_to_utf8_string(text: &str) -> String {
    if text.chars().any(|c| (c as u32) > 255) {
        return text.to_owned();
    }
    String::from_utf8(latin1_bytes(text)).unwrap_or_else(|_| text.to_owned())
}

/// `createValidAbsoluteUrl`: the URL `url` names (against `base`), when its protocol is one pdf.js opens.
pub(crate) fn create_valid_absolute_url(url: &str, base: Option<&str>, add_default_protocol: bool) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    let mut url = url.to_owned();
    if add_default_protocol && url.starts_with("www.") && url.matches('.').count() >= 2 {
        url = format!("http://{url}");
    }
    let url = string_to_utf8_string(&url);
    let parsed = match base {
        Some(base) => {
            let base = Url::parse(base).ok()?;
            Url::options().base_url(Some(&base)).parse(&url).ok()?
        }
        None => Url::parse(&url).ok()?,
    };
    match parsed.scheme() {
        "http" | "https" | "ftp" | "mailto" | "tel" => Some(parsed.as_str().to_owned()),
        _ => None,
    }
}

/// `isValidExplicitDest`.
fn is_valid_explicit_dest(dest: &Obj) -> bool {
    let Obj::Array(items) = dest else {
        return false;
    };
    if items.len() < 2 {
        return false;
    }
    if !matches!(items[0], Obj::Ref(_)) && items[0].as_int().is_none() {
        return false;
    }
    let Obj::Name(zoom) = &items[1] else {
        return false;
    };
    let args = &items[2..];
    let mut allow_null = true;
    match &**zoom {
        "XYZ" => {
            if args.len() < 2 || args.len() > 3 {
                return false;
            }
        }
        "Fit" | "FitB" => return args.is_empty(),
        "FitH" | "FitBH" | "FitV" | "FitBV" => {
            if args.len() > 1 {
                return false;
            }
        }
        "FitR" => {
            if args.len() != 4 {
                return false;
            }
            allow_null = false;
        }
        _ => return false,
    }
    args.iter().all(|arg| matches!(arg, Obj::Num(_)) || (allow_null && matches!(arg, Obj::Null)))
}

/// `JSON.stringify` of an explicit destination as pdf.js's objects stringify (a name is `{"name":...}`, a reference
/// `{"num":...,"gen":...}`).
fn json_of(obj: &Obj) -> String {
    match obj {
        Obj::Null => "null".to_owned(),
        Obj::Bool(b) => b.to_string(),
        Obj::Num(n) if n.is_finite() => mixdog_js::number_to_string(*n),
        Obj::Num(_) => "null".to_owned(),
        Obj::Str(s) => format!("{:?}", latin1(s)),
        Obj::Name(n) => format!("{{\"name\":{:?}}}", &**n),
        Obj::Ref(r) => format!("{{\"num\":{},\"gen\":{}}}", r.num, r.generation),
        Obj::Array(items) => {
            let parts: Vec<String> = items.iter().map(json_of).collect();
            format!("[{}]", parts.join(","))
        }
        _ => "{}".to_owned(),
    }
}

/// `fetchRemoteDest`: the destination of a remote-go-to action as text appended to the file's URL.
fn fetch_remote_dest(xref: &Xref, action: &Dict) -> Result<Option<String>> {
    let dest = xref.get(action, "D")?;
    if !crate::oplist::truthy(&dest) {
        return Ok(None);
    }
    Ok(match &dest {
        Obj::Name(name) => Some(string_to_pdf_string(&latin1_bytes(name), true)),
        Obj::Str(bytes) => Some(string_to_pdf_string(bytes, true)),
        other if is_valid_explicit_dest(other) => Some(json_of(other)),
        _ => None,
    })
}

/// `FileSpec.filename`.
fn file_spec_filename(xref: &Xref, spec: &Dict) -> Result<String> {
    for key in ["UF", "F", "Unix", "Mac", "DOS"] {
        if spec.has(key) {
            if let Obj::Str(bytes) = xref.get(spec, key)? {
                return Ok(string_to_pdf_string(&bytes, true).replace("\\\\", "\\").replace("\\/", "/").replace('\\', "/"));
            }
            return Ok(String::new());
        }
    }
    Ok(String::new())
}

/// `recoverJsURL`: the URL of `app.launchURL("...")`, `window.open('...')` and `xfa.host.gotoURL(...)`.
fn recover_js_url(text: &str) -> Option<(String, bool)> {
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace());
    let lower = trimmed.to_ascii_lowercase();
    let method = ["app.launchurl", "window.open", "xfa.host.gotourl"].into_iter().find(|m| lower.starts_with(m))?;
    let matched_method = &trimmed[..method.len()];
    let rest = &trimmed[method.len()..];
    let rest = rest.strip_prefix('(')?;
    let quote = rest.chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let rest = &rest[1..];
    let end = rest.find(['\'', '"'])?;
    let url = &rest[..end];
    let rest = &rest[end + quote.len_utf8()..];
    let new_window_arg;
    if rest.starts_with(')') {
        new_window_arg = None;
    } else {
        let rest = rest.strip_prefix(',')?;
        let rest = rest.trim_start_matches(|c: char| c.is_whitespace());
        let word_len = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
        if word_len == 0 || !rest[word_len..].starts_with(')') {
            return None;
        }
        new_window_arg = Some(&rest[..word_len]);
    }
    if url.is_empty() {
        return None;
    }
    let new_window = matched_method == "app.launchURL" && new_window_arg == Some("true");
    Some((url.to_owned(), new_window))
}

/// `Catalog.parseDestDictionary`: the action (or the destination) of an outline item or a link annotation. The
/// actions of an embedded-file go-to (`GoToE`) and the structure-element fallback of a destination-less item are not
/// read.
pub fn parse_dest_dictionary(xref: &Xref, dest_dict: &Dict, doc_base_url: Option<&str>) -> Result<ActionData> {
    let mut result = ActionData::default();
    let mut action = xref.get(dest_dict, "A")?;
    if !matches!(action, Obj::Dict(_)) {
        if dest_dict.has("Dest") {
            action = xref.get(dest_dict, "Dest")?;
        } else {
            action = xref.get(dest_dict, "AA")?;
            if let Obj::Dict(additional) = &action {
                if additional.has("D") {
                    action = xref.get(additional, "D")?;
                } else if additional.has("U") {
                    action = xref.get(additional, "U")?;
                }
            }
        }
    }
    let mut url: Option<String> = None;
    let mut dest: Obj = Obj::Null;
    if let Obj::Dict(action) = &action {
        let Obj::Name(action_type) = xref.get(action, "S")? else {
            tracing::warn!("parseDestDictionary: Invalid type in Action dictionary.");
            return Ok(result);
        };
        match &*action_type {
            "ResetForm" => {
                let flags = xref.get(action, "Flags")?.as_num().unwrap_or(0.0);
                let include = ((flags as i64) & 1) == 0;
                let mut fields = Vec::new();
                let mut refs = Vec::new();
                if let Obj::Array(items) = xref.get(action, "Fields")? {
                    for item in items.iter() {
                        match item {
                            Obj::Ref(r) => refs.push(r.to_string()),
                            Obj::Str(s) => fields.push(string_to_pdf_string(s, false)),
                            _ => {}
                        }
                    }
                }
                result.reset_form = Some(ResetForm { fields, refs, include });
            }
            "URI" => match xref.get(action, "URI")? {
                Obj::Name(name) => url = Some(format!("/{name}")),
                Obj::Str(s) => url = Some(latin1(&s)),
                _ => {}
            },
            "GoTo" => dest = xref.get(action, "D")?,
            "Launch" | "GoToR" => {
                let mut target = match xref.get(action, "F")? {
                    Obj::Dict(spec) => Some(file_spec_filename(xref, &spec)?),
                    Obj::Str(s) => Some(latin1(&s)),
                    _ => None,
                };
                if let Some(file) = target.as_mut() {
                    if let Some(remote) = fetch_remote_dest(xref, action)? {
                        let head = file.split('#').next().unwrap_or("").to_owned();
                        *file = format!("{head}#{remote}");
                    }
                    if let Obj::Bool(new_window) = xref.get(action, "NewWindow")? {
                        result.new_window = Some(new_window);
                    }
                }
                url = target;
            }
            "GoToE" => {
                tracing::warn!("parseDestDictionary - unimplemented \"GoToE\" action.");
            }
            "Named" => {
                if let Obj::Name(named) = xref.get(action, "N")? {
                    result.action = Some(named.to_string());
                }
            }
            "SetOCGState" => {
                let preserve_rb = xref.get(action, "PreserveRB")?;
                if let Obj::Array(state) = xref.get(action, "State")?
                    && !state.is_empty()
                {
                    let mut entries = Vec::new();
                    for element in state.iter() {
                        match element {
                            Obj::Name(name) if matches!(&**name, "ON" | "OFF" | "Toggle") => {
                                entries.push(name.to_string());
                            }
                            Obj::Ref(r) => entries.push(r.to_string()),
                            _ => {}
                        }
                    }
                    if entries.len() == state.len() {
                        result.set_ocg_state = Some(SetOcgState { state: entries, preserve_rb: !matches!(preserve_rb, Obj::Bool(false)) });
                    }
                }
            }
            "JavaScript" => {
                let js = match xref.get(action, "JS")? {
                    Obj::Stream(stream) => {
                        let bytes = stream.decode(xref.filters().as_ref(), xref.guard())?;
                        Some(latin1(&bytes))
                    }
                    Obj::Str(s) => Some(latin1(&s)),
                    _ => None,
                };
                if let Some(js) = js {
                    let text = string_to_pdf_string(&latin1_bytes(&js), true);
                    if let Some((found, new_window)) = recover_js_url(&text) {
                        url = Some(found);
                        result.new_window = Some(new_window);
                    }
                }
            }
            "SubmitForm" => {}
            other => tracing::warn!("parseDestDictionary - unsupported action: \"{other}\"."),
        }
    } else if dest_dict.has("Dest") {
        dest = xref.get(dest_dict, "Dest")?;
    }
    if let Some(url) = url {
        if let Some(absolute) = create_valid_absolute_url(&url, doc_base_url, true) {
            result.url = Some(absolute);
        }
        result.unsafe_url = Some(url);
    }
    if crate::oplist::truthy(&dest) {
        match dest {
            Obj::Name(name) => {
                result.dest = Some(Dest::Named(string_to_pdf_string(&latin1_bytes(&name), true)));
            }
            Obj::Str(bytes) => {
                result.dest = Some(Dest::Named(string_to_pdf_string(&bytes, true)));
            }
            Obj::Array(items) if is_valid_explicit_dest(&Obj::Array(items.clone())) => {
                result.dest = Some(Dest::Explicit(items.to_vec()));
            }
            _ => {}
        }
    }
    Ok(result)
}

/// `Catalog.baseUrl`: the document's `/URI /Base`, when it is a usable absolute URL.
pub fn base_url(document: &Document) -> Result<Option<String>> {
    let xref = document.xref();
    let Some(catalog) = xref.root() else {
        return Ok(None);
    };
    if let Obj::Dict(uri) = xref.get(&catalog, "URI")?
        && let Obj::Str(base) = xref.get(&uri, "Base")?
    {
        return Ok(create_valid_absolute_url(&latin1(&base), None, false));
    }
    Ok(None)
}

/// `Catalog.documentOutline`: the bookmarks in reading order, `None` when the document has none or they cannot be
/// read (pdf.js logs `Unable to read document outline.`); a cancellation or a budget failure propagates.
pub fn get_outline(document: &Document) -> Result<Option<Vec<OutlineItem>>> {
    match read_document_outline(document) {
        Ok(items) => Ok(items),
        Err(e) if e.is_fatal() => Err(e),
        Err(_) => {
            tracing::warn!("Unable to read document outline.");
            Ok(None)
        }
    }
}

struct Node {
    item: OutlineItem,
    children: Vec<usize>,
}

fn read_document_outline(document: &Document) -> Result<Option<Vec<OutlineItem>>> {
    let xref = document.xref();
    let Some(catalog) = xref.root() else {
        return Ok(None);
    };
    let Obj::Dict(outlines) = xref.get(&catalog, "Outlines")? else {
        return Ok(None);
    };
    let Some(Obj::Ref(first)) = outlines.get_raw("First").cloned() else {
        return Ok(None);
    };
    let base = base_url(document)?;
    let mut nodes: Vec<Node> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut queue: VecDeque<(Ref, Option<usize>)> = VecDeque::new();
    let mut processed: HashSet<Ref> = HashSet::new();
    queue.push_back((first, None));
    processed.insert(first);
    while let Some((reference, parent)) = queue.pop_front() {
        document.guard().tick()?;
        let outline_dict = match xref.fetch(reference, false)? {
            Obj::Null => continue,
            Obj::Dict(d) => d,
            _ => {
                return Err(format_error("Cannot read properties of a non-dictionary outline item"));
            }
        };
        if !outline_dict.has("Title") {
            tracing::warn!("Invalid outline item encountered.");
        }
        let data = parse_dest_dictionary(xref, &outline_dict, base.as_deref())?;
        let title = match xref.get(&outline_dict, "Title")? {
            Obj::Str(bytes) => string_to_pdf_string(&bytes, false),
            _ => String::new(),
        };
        let flags = xref.get(&outline_dict, "F")?.as_num().unwrap_or(0.0);
        let flags = if flags.is_nan() { 0 } else { flags as i64 };
        let color = match xref.get_array(&outline_dict, "C")? {
            Obj::Array(values) if values.len() == 3 => {
                let numbers: Option<Vec<f64>> = values.iter().map(Obj::as_num).collect();
                match numbers {
                    Some(c) if c[0] != 0.0 || c[1] != 0.0 || c[2] != 0.0 => ColorSpace::rgb().get_rgb(&c, 0)?,
                    _ => [0, 0, 0],
                }
            }
            _ => [0, 0, 0],
        };
        let count = xref.get(&outline_dict, "Count")?.as_int();
        let index = nodes.len();
        nodes.push(Node {
            item: OutlineItem {
                action: data.action,
                dest: data.dest,
                url: data.url,
                unsafe_url: data.unsafe_url,
                new_window: data.new_window,
                set_ocg_state: data.set_ocg_state,
                title,
                color,
                count,
                bold: flags & 2 != 0,
                italic: flags & 1 != 0,
                items: Vec::new(),
            },
            children: Vec::new(),
        });
        match parent {
            Some(p) => nodes[p].children.push(index),
            None => roots.push(index),
        }
        if let Some(Obj::Ref(next)) = outline_dict.get_raw("First")
            && processed.insert(*next)
        {
            queue.push_back((*next, Some(index)));
        }
        if let Some(Obj::Ref(next)) = outline_dict.get_raw("Next")
            && processed.insert(*next)
        {
            queue.push_back((*next, parent));
        }
    }
    if roots.is_empty() {
        return Ok(None);
    }
    fn build(nodes: &mut Vec<Option<Node>>, index: usize) -> OutlineItem {
        let node = nodes[index].take().expect("an outline node is attached once");
        let mut item = node.item;
        item.items = node.children.into_iter().map(|child| build(nodes, child)).collect();
        item
    }
    let mut slots: Vec<Option<Node>> = nodes.into_iter().map(Some).collect();
    Ok(Some(roots.into_iter().map(|r| build(&mut slots, r)).collect()))
}

// ---- named destinations ----------------------------------------------------------------------------------------------

/// `fetchDest`: a destination array, or the `/D` of a destination dictionary, when it is valid.
fn fetch_dest(xref: &Xref, value: Obj) -> Result<Option<Vec<Obj>>> {
    let value = match value {
        Obj::Dict(d) => xref.get(&d, "D")?,
        other => other,
    };
    Ok(match value {
        Obj::Array(items) if is_valid_explicit_dest(&Obj::Array(items.clone())) => Some(items.to_vec()),
        _ => None,
    })
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn units_of_string(obj: &Obj) -> Option<Vec<u16>> {
    match obj {
        Obj::Str(bytes) => Some(bytes.iter().map(|&b| u16::from(b)).collect()),
        _ => None,
    }
}

/// `NameTree.get`: the value under `key` (compared as JavaScript compares strings), `None` when it is not there.
fn name_tree_get(xref: &Xref, root: &Obj, key: &[u16]) -> Result<Option<Obj>> {
    let mut node = xref.fetch_if_ref(root, false)?;
    let mut loops = 0;
    loop {
        let Obj::Dict(dict) = &node else {
            return Ok(None);
        };
        if !dict.has("Kids") {
            break;
        }
        loops += 1;
        if loops > 10 {
            tracing::warn!("Search depth limit reached for \"Names\" tree.");
            return Ok(None);
        }
        let Obj::Array(kids) = xref.get(dict, "Kids")? else {
            return Ok(None);
        };
        let mut l: isize = 0;
        let mut r: isize = kids.len() as isize - 1;
        let mut found: Option<Obj> = None;
        while l <= r {
            let m = ((l + r) >> 1) as usize;
            let kid = xref.fetch_if_ref(&kids[m], false)?;
            let Obj::Dict(kid_dict) = &kid else {
                return Ok(None);
            };
            let Obj::Array(limits) = xref.get(kid_dict, "Limits")? else {
                return Ok(None);
            };
            let low = limits.first().map(|o| xref.fetch_if_ref(o, false)).transpose()?;
            let high = limits.get(1).map(|o| xref.fetch_if_ref(o, false)).transpose()?;
            let low = low.as_ref().and_then(units_of_string).unwrap_or_default();
            let high = high.as_ref().and_then(units_of_string).unwrap_or_default();
            if key < low.as_slice() {
                r = m as isize - 1;
            } else if key > high.as_slice() {
                l = m as isize + 1;
            } else {
                found = Some(kid);
                break;
            }
        }
        match found {
            Some(kid) => node = kid,
            None => return Ok(None),
        }
    }
    let Obj::Dict(dict) = &node else {
        return Ok(None);
    };
    if let Obj::Array(entries) = xref.get(dict, "Names")? {
        let mut l: isize = 0;
        let mut r: isize = entries.len() as isize - 2;
        while l <= r {
            let tmp = (l + r) >> 1;
            let m = (tmp + (tmp & 1)) as usize;
            let current = xref.fetch_if_ref(&entries[m], false)?;
            let current = units_of_string(&current).unwrap_or_default();
            if key < current.as_slice() {
                r = m as isize - 2;
            } else if key > current.as_slice() {
                l = m as isize + 2;
            } else {
                return Ok(entries.get(m + 1).cloned());
            }
        }
    }
    Ok(None)
}

/// `NameTree.getAll`: every key and value of the tree.
fn name_tree_all(xref: &Xref, root: &Obj) -> Result<Vec<(Obj, Obj)>> {
    let mut out = Vec::new();
    let mut processed: HashSet<Ref> = HashSet::new();
    if let Obj::Ref(r) = root {
        processed.insert(*r);
    }
    let mut queue: Vec<Obj> = vec![root.clone()];
    let mut at = 0;
    while at < queue.len() {
        let node = queue[at].clone();
        at += 1;
        let Obj::Dict(dict) = xref.fetch_if_ref(&node, false)? else {
            continue;
        };
        if dict.has("Kids") {
            let Obj::Array(kids) = xref.get(&dict, "Kids")? else {
                continue;
            };
            for kid in kids.iter() {
                if let Obj::Ref(r) = kid
                    && !processed.insert(*r)
                {
                    return Err(format_error("Duplicate entry in \"Names\" tree."));
                }
                queue.push(kid.clone());
            }
            continue;
        }
        let Obj::Array(entries) = xref.get(&dict, "Names")? else {
            continue;
        };
        let mut i = 0;
        while i < entries.len() {
            let key = xref.fetch_if_ref(&entries[i], false)?;
            let value = match entries.get(i + 1) {
                Some(v) => xref.fetch_if_ref(v, false)?,
                None => Obj::Null,
            };
            out.push((key, value));
            i += 2;
        }
    }
    Ok(out)
}

/// The two places named destinations live: `/Names /Dests` (a name tree) and the catalog's `/Dests` dictionary.
enum DestSource {
    Tree(Obj),
    Dictionary(Arc<Dict>),
}

fn dest_sources(xref: &Xref) -> Result<Vec<DestSource>> {
    let mut out = Vec::new();
    let Some(catalog) = xref.root() else {
        return Ok(out);
    };
    if let Obj::Dict(names) = xref.get(&catalog, "Names")?
        && names.has("Dests")
    {
        out.push(DestSource::Tree(names.get_raw("Dests").cloned().unwrap_or(Obj::Null)));
    }
    if catalog.has("Dests")
        && let Obj::Dict(dests) = xref.get(&catalog, "Dests")?
    {
        out.push(DestSource::Dictionary(dests));
    }
    Ok(out)
}

/// `Catalog.getDestination`: the explicit destination a name stands for, `None` when there is none.
pub fn get_destination(document: &Document, id: &str) -> Result<Option<Vec<Obj>>> {
    let xref = document.xref();
    let sources = dest_sources(xref)?;
    let key = units(id);
    for source in &sources {
        let value = match source {
            DestSource::Tree(root) => match name_tree_get(xref, root, &key)? {
                Some(raw) => xref.fetch_if_ref(&raw, false)?,
                None => Obj::Null,
            },
            DestSource::Dictionary(dict) => xref.get(dict, id)?,
        };
        if let Some(dest) = fetch_dest(xref, value)? {
            return Ok(Some(dest));
        }
    }
    // `destinations`: every entry, the keys decoded as PDF text strings.
    let mut all: HashMap<String, Vec<Obj>> = HashMap::new();
    for source in &sources {
        match source {
            DestSource::Tree(root) => {
                for (key, value) in name_tree_all(xref, root)? {
                    if let (Obj::Str(bytes), Some(dest)) = (&key, fetch_dest(xref, value)?) {
                        all.insert(string_to_pdf_string(bytes, true), dest);
                    }
                }
            }
            DestSource::Dictionary(dict) => {
                for key in dict.keys().map(str::to_owned).collect::<Vec<_>>() {
                    let value = xref.get(dict, &key)?;
                    if let Some(dest) = fetch_dest(xref, value)? {
                        all.entry(string_to_pdf_string(&latin1_bytes(&key), true)).or_insert(dest);
                    }
                }
            }
        }
    }
    Ok(all.remove(id))
}

// ---- page index ------------------------------------------------------------------------------------------------------

/// `Catalog.getPageIndex`: the 0-based index of the page the reference names, counted by walking up the page tree
/// and adding the sizes of the siblings before each node.
pub fn get_page_index(document: &Document, page_ref: Ref) -> Result<usize> {
    let xref = document.xref();
    let mut total: usize = 0;
    let mut reference = page_ref;
    let mut visited: HashSet<Ref> = HashSet::new();
    visited.insert(page_ref);
    loop {
        document.guard().tick()?;
        let node = xref.fetch(reference, false)?;
        if reference == page_ref {
            let is_page = match &node {
                Obj::Dict(d) => matches!(xref.get(d, "Type")?, Obj::Name(ref t) if &**t == "Page") || (!d.has("Type") && d.has("Contents")),
                _ => false,
            };
            if !is_page {
                return Err(format_error("The reference does not point to a /Page dictionary."));
            }
        }
        if matches!(node, Obj::Null) {
            break;
        }
        let Obj::Dict(node) = node else {
            return Err(format_error("Node must be a dictionary."));
        };
        let parent_ref = node.get_raw("Parent").cloned();
        if let Some(Obj::Ref(r)) = &parent_ref
            && !visited.insert(*r)
        {
            return Err(format_error("Pages tree contains circular reference."));
        }
        let parent = xref.get(&node, "Parent")?;
        if !crate::oplist::truthy(&parent) {
            break;
        }
        let Obj::Dict(parent) = parent else {
            return Err(format_error("Parent must be a dictionary."));
        };
        let kids = xref.get(&parent, "Kids")?;
        if !crate::oplist::truthy(&kids) {
            break;
        }
        let Obj::Array(kids) = kids else {
            return Err(format_error("Kids must be an array."));
        };
        let mut found = false;
        let mut siblings: Vec<Ref> = Vec::new();
        for kid in kids.iter() {
            let Obj::Ref(kid) = kid else {
                return Err(format_error("Kid must be a reference."));
            };
            if *kid == reference {
                found = true;
                break;
            }
            siblings.push(*kid);
        }
        if !found {
            return Err(format_error("Kid reference not found in parent's kids."));
        }
        for sibling in siblings {
            let Obj::Dict(kid) = xref.fetch(sibling, false)? else {
                return Err(format_error("Kid node must be a dictionary."));
            };
            if kid.has("Count") {
                match xref.get(&kid, "Count")?.as_int() {
                    Some(count) if count >= 0 => total += count as usize,
                    _ => return Err(format_error("Count must be a (positive) integer.")),
                }
            } else {
                total += 1;
            }
        }
        match parent_ref {
            Some(Obj::Ref(r)) => reference = r,
            _ => break,
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_destinations_follow_the_argument_counts() {
        let name = |s: &str| Obj::name(s);
        let n = Obj::Num;
        let valid = Obj::Array(Arc::new(vec![n(0.0), name("XYZ"), n(1.0), n(2.0), Obj::Null]));
        assert!(is_valid_explicit_dest(&valid));
        let fit = Obj::Array(Arc::new(vec![Obj::Ref(Ref::new(4, 0)), name("Fit")]));
        assert!(is_valid_explicit_dest(&fit));
        let bad = Obj::Array(Arc::new(vec![n(0.0), name("Fit"), n(1.0)]));
        assert!(!is_valid_explicit_dest(&bad));
        let rect_with_null = Obj::Array(Arc::new(vec![n(0.0), name("FitR"), n(1.0), Obj::Null, n(3.0), n(4.0)]));
        assert!(!is_valid_explicit_dest(&rect_with_null));
    }

    #[test]
    fn urls_get_pdfjs_normalisation() {
        assert_eq!(create_valid_absolute_url("http://example.com", None, true).as_deref(), Some("http://example.com/"));
        assert_eq!(create_valid_absolute_url("www.example.com", None, true).as_deref(), Some("http://www.example.com/"));
        assert_eq!(create_valid_absolute_url("javascript:alert(1)", None, true), None);
        assert_eq!(create_valid_absolute_url("page.html", Some("http://a.test/dir/"), false).as_deref(), Some("http://a.test/dir/page.html"));
        assert_eq!(create_valid_absolute_url("", None, true), None);
    }

    #[test]
    fn utf8_urls_are_read_from_their_bytes() {
        let bytes = "http://a.test/é".as_bytes();
        let text = latin1(bytes);
        assert_eq!(create_valid_absolute_url(&text, None, false).as_deref(), Some("http://a.test/%C3%A9"));
    }

    #[test]
    fn javascript_urls_are_recovered() {
        assert_eq!(recover_js_url("app.launchURL('http://x.test', true)"), Some(("http://x.test".to_owned(), true)));
        assert_eq!(recover_js_url("  window.open(\"http://y.test\")"), Some(("http://y.test".to_owned(), false)));
        assert_eq!(recover_js_url("this.print()"), None);
    }

    #[test]
    fn name_tree_keys_compare_as_utf16() {
        assert!(units("a") < units("b"));
        assert_eq!(units_of_string(&Obj::string(b"ab")), Some(vec![97, 98]));
    }
}
