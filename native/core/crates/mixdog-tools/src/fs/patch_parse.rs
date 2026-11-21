//! V4A envelope parser: `*** Begin Patch` … `*** End Patch` into sections, as Node's `parseV4APatch`.

use mixdog_js::js_trim;
use mixdog_js::js_trim_end;

use super::patch_hunk::Hunk;
use super::patch_hunk::Kind;
use super::patch_hunk::Section;
use super::patch_hunk::is_eof_marker;

const MOVE_TO: &str = "*** Move to:";

/// A V4A patch starts with its envelope or a file header (BOM and CRLF ignored).
pub(super) fn is_v4a(patch: &str) -> bool {
    let text = prepare(patch);
    let t = text.trim_start();
    ["*** Begin Patch", "*** Add File:", "*** Update File:", "*** Delete File:"].iter().any(|p| t.starts_with(p))
}

fn prepare(patch: &str) -> String {
    patch.strip_prefix('\u{FEFF}').unwrap_or(patch).replace("\r\n", "\n")
}

/// Header path with the decorations models add stripped: a trailing ` ***`, a tab suffix, quotes.
fn strip_metadata(raw: &str) -> String {
    let mut text = js_trim(raw).to_owned();
    if text.is_empty() {
        return text;
    }
    if let Some(before) = text.strip_suffix("***") {
        let trimmed = js_trim_end(before);
        if trimmed.len() < before.len() {
            text = trimmed.to_owned();
        }
    }
    if let Some(tab) = text.find('\t') {
        text = js_trim_end(&text[..tab]).to_owned();
    }
    if let Some(quote) = text.chars().next().filter(|c| (*c == '"' || *c == '\'') && text.len() > 1)
        && let Some(end) = text[1..].find(quote).map(|e| e + 1)
    {
        text = text[1..end].to_owned();
    }
    text
}

fn normalise_path(raw: &str) -> String {
    let p = strip_metadata(raw);
    if p.is_empty() {
        return p;
    }
    let p = p.strip_prefix(['"', '\'']).unwrap_or(&p);
    let p = p.strip_suffix(['"', '\'']).unwrap_or(p);
    p.replace('\\', "/")
}

fn normalise_anchor(raw: &str) -> String {
    let t = js_trim_end(raw);
    let t = t.strip_suffix("@@").map_or(t, js_trim_end);
    js_trim(t).to_owned()
}

fn is_patch_marker(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    ["*** begin patch", "*** end patch"]
        .iter()
        .any(|m| lower.strip_prefix(m).is_some_and(|rest| rest.chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_'))))
}

pub(super) fn parse_v4a(patch: &str) -> Result<Vec<Section>, String> {
    let text = prepare(patch);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut b = SectionBuilder::default();
    for raw in lines {
        if is_patch_marker(raw) {
            continue;
        }
        let header = [("*** Update File:", Kind::Update), ("*** Add File:", Kind::Add), ("*** Delete File:", Kind::Delete)]
            .into_iter()
            .find_map(|(p, k)| raw.strip_prefix(p).map(|rest| (k, normalise_path(rest))));
        if let Some((kind, path)) = header {
            b.start_file(kind, path);
            continue;
        }
        let Some(current) = b.files.last_mut() else {
            return Err(format!("V4A patch line appears before a file header: {raw}"));
        };
        if current.kind == Kind::Update && raw.starts_with(MOVE_TO) {
            if current.move_path.is_some() {
                return Err(format!("V4A patch lists multiple {MOVE_TO} directives for {}", current.path));
            }
            let dest = normalise_path(&raw[MOVE_TO.len()..]);
            if dest.is_empty() {
                return Err("V4A patch contains an empty move destination path".to_owned());
            }
            current.move_path = Some(dest);
            continue;
        }
        match current.kind {
            Kind::Add => {
                current.lines.push(raw.strip_prefix('+').unwrap_or(raw).to_owned());
                continue;
            }
            Kind::Delete => continue,
            Kind::Update => {}
        }
        if raw.is_empty() {
            b.blank_line();
            continue;
        }
        if is_eof_marker(raw) {
            b.end_of_file()?;
            continue;
        }
        if let Some(rest) = raw.strip_prefix("@@") {
            b.anchor(normalise_anchor(rest));
            continue;
        }
        b.body_line(raw);
    }
    b.finish_hunk();
    let files = b.files;
    if files.iter().any(|f| f.path.is_empty()) {
        return Err("V4A patch contains an empty file path".to_owned());
    }
    if files.is_empty() {
        return Err("V4A patch contained no file sections".to_owned());
    }
    Ok(files)
}

/// The sections read so far, the `@@` anchors waiting for their hunk, and the hunk being filled; shared by the V4A and the
/// unified-as-V4A readers, which differ only in how a file starts and what an `@@` line says.
#[derive(Default)]
struct SectionBuilder {
    files: Vec<Section>,
    pending: Vec<String>,
    hunk: Option<Hunk>,
}

impl SectionBuilder {
    fn finish_hunk(&mut self) {
        if let (Some(file), Some(h)) = (self.files.last_mut(), self.hunk.take())
            && file.kind == Kind::Update
            && !h.lines.is_empty()
        {
            file.hunks.push(h);
        }
    }

    fn start_file(&mut self, kind: Kind, path: String) {
        self.finish_hunk();
        self.pending.clear();
        self.files.push(Section { kind, path, move_path: None, hunks: Vec::new(), lines: Vec::new() });
    }

    fn blank_line(&mut self) {
        if let Some(h) = self.hunk.as_mut() {
            h.lines.push(" ".to_owned());
        }
    }

    fn end_of_file(&mut self) -> Result<(), String> {
        match self.hunk.as_mut() {
            Some(h) if !h.lines.is_empty() => h.eof = true,
            _ => return Err("V4A update hunk does not contain any lines before *** End of File".to_owned()),
        }
        self.finish_hunk();
        Ok(())
    }

    /// Consecutive `@@` lines narrow one hunk's position.
    fn anchor(&mut self, anchor: String) {
        if self.hunk.as_ref().is_some_and(|h| !h.lines.is_empty()) {
            self.finish_hunk();
        }
        if let Some(h) = self.hunk.as_mut().filter(|h| h.lines.is_empty()) {
            if !anchor.is_empty() {
                h.anchors.push(anchor);
            }
            self.pending.clear();
            return;
        }
        self.pending.push(anchor);
        self.hunk = Some(Hunk { anchors: std::mem::take(&mut self.pending), lines: Vec::new(), eof: false });
    }

    fn body_line(&mut self, raw: &str) {
        let pending = &mut self.pending;
        let h = self.hunk.get_or_insert_with(|| Hunk { anchors: std::mem::take(pending), lines: Vec::new(), eof: false });
        pending.clear();
        if matches!(raw.as_bytes()[0], b' ' | b'-' | b'+') {
            h.lines.push(raw.to_owned());
        } else {
            h.lines.push(format!(" {raw}"));
        }
    }
}

// ---- opening salvage (Node `salvageV4AOpening`) ----

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `^\*\*\*\s*Begin Patch\b` (case-insensitive).
fn is_begin_patch(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("***") else { return false };
    let rest = rest.trim_start_matches(mixdog_js::is_js_space);
    rest.len() >= 11 && rest.is_char_boundary(11) && rest[..11].eq_ignore_ascii_case("begin patch") && rest[11..].chars().next().is_none_or(|c| !is_word(c))
}

fn is_end_patch(line: &str) -> bool {
    line.len() >= 13 && line.is_char_boundary(13) && line[..13].eq_ignore_ascii_case("*** End Patch")
}

fn is_file_header(line: &str) -> bool {
    ["*** Update File:", "*** Add File:", "*** Delete File:"].iter().any(|p| line.starts_with(p))
}

/// `^(?:---\s|\+\+\+\s|diff --git |Index: )`.
fn is_unified_body(line: &str) -> bool {
    let after_marker = |m: &str| line.strip_prefix(m).and_then(|r| r.chars().next()).is_some_and(mixdog_js::is_js_space);
    after_marker("---") || after_marker("+++") || line.starts_with("diff --git ") || line.starts_with("Index: ")
}

/// A lone path-looking token a model wrote where the file header belongs.
fn implied_file_path(line: &str) -> Option<String> {
    let mut t = js_trim(line).to_owned();
    if t.len() >= 5 && t.is_char_boundary(5) && t[..5].eq_ignore_ascii_case("File:") {
        t = js_trim(&t[5..]).to_owned();
    }
    if t.is_empty() || t.chars().any(mixdog_js::is_js_space) {
        return None;
    }
    if !t.chars().all(|c| is_word(c) || matches!(c, '@' | '.' | '~' | '/' | '\\' | '-')) {
        return None;
    }
    let dotted_ext = t.rfind('.').is_some_and(|dot| dot + 1 < t.len() && t[dot + 1..].chars().all(is_word));
    if !(t.contains('/') || t.contains('\\') || dotted_ext) {
        return None;
    }
    Some(normalise_path(&t))
}

/// Absorbs the malformed-but-unambiguous openings models emit instead of a clean
/// `*** Begin Patch` / `*** Update File:` header; anything else passes through untouched.
pub(super) fn salvage_opening(raw: &str) -> String {
    let prepared = prepare(raw);
    let lines: Vec<&str> = prepared.split('\n').collect();
    let Some(i) = lines.iter().position(|l| !js_trim(l).is_empty()) else { return raw.to_owned() };
    let first = lines[i];
    if !is_begin_patch(first) {
        if i > 0 && first.starts_with("*** ") && is_file_header(first) {
            return lines[i..].join("\n");
        }
        return raw.to_owned();
    }
    let mut out: Vec<String> = lines[i..].iter().map(|l| (*l).to_owned()).collect();
    out[0] = "*** Begin Patch".to_owned();
    let mut changed = i > 0 || first != "*** Begin Patch";
    let j = (1..out.len()).find(|j| !js_trim(&out[*j]).is_empty()).unwrap_or(out.len());
    if let Some(body) = out.get(j).cloned()
        && !is_file_header(&body)
        && !is_end_patch(&body)
    {
        if is_unified_body(&body) && !prepared.split('\n').any(is_file_header) {
            // A unified diff wrapped in a V4A envelope: drop the envelope.
            return out.iter().enumerate().filter(|(idx, l)| *idx != 0 && !is_end_patch(l)).map(|(_, l)| l.as_str()).collect::<Vec<_>>().join("\n");
        }
        if let Some(implied) = implied_file_path(&body) {
            out[j] = format!("*** Update File: {implied}");
            changed = true;
        }
    }
    if changed { out.join("\n") } else { raw.to_owned() }
}

// ---- unified text read as V4A (Node `parseUnifiedAsV4APatch`) ----

fn counted_header(line: &str) -> Option<&str> {
    // `^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@` and what follows it.
    let rest = line.strip_prefix("@@ -")?;
    let digits = |s: &str| s.chars().take_while(char::is_ascii_digit).count();
    let n = digits(rest);
    if n == 0 {
        return None;
    }
    let mut rest = &rest[n..];
    if let Some(r) = rest.strip_prefix(',') {
        let m = digits(r);
        if m == 0 {
            return None;
        }
        rest = &r[m..];
    }
    let rest = rest.strip_prefix(" +")?;
    let n = digits(rest);
    if n == 0 {
        return None;
    }
    let mut rest = &rest[n..];
    if let Some(r) = rest.strip_prefix(',') {
        let m = digits(r);
        if m == 0 {
            return None;
        }
        rest = &r[m..];
    }
    rest.strip_prefix(" @@")
}

/// Whether `line` is a counted unified hunk header (`@@ -a,b +c,d @@`).
pub(super) fn is_counted_header(line: &str) -> bool {
    counted_header(line).is_some()
}

/// `stripDiffPrefix`: drops a leading `a/` or `b/` unless the path is absolute.
pub(super) fn strip_diff_prefix(name: &str) -> &str {
    let absolute = name.starts_with('/')
        || name.starts_with('\\')
        || (name.len() >= 3 && name.as_bytes()[1] == b':' && matches!(name.as_bytes()[2], b'/' | b'\\') && name.as_bytes()[0].is_ascii_alphabetic());
    if absolute {
        return name;
    }
    match name.strip_prefix("a/").or_else(|| name.strip_prefix("b/")) {
        Some(rest) if !rest.is_empty() => rest,
        _ => name,
    }
}

/// How an `@@` line yields its anchor: bare rejects counted headers; counted requires one.
#[derive(Clone, Copy)]
pub(super) enum UnifiedAnchors {
    Bare,
    Counted,
}

pub(super) fn parse_unified_as_v4a(patch: &str, anchors: UnifiedAnchors) -> Result<Vec<Section>, String> {
    let label = match anchors {
        UnifiedAnchors::Bare => "unified bare patch",
        UnifiedAnchors::Counted => "unified fallback",
    };
    let text = prepare(patch);
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let resolve = |raw: &str| -> Result<String, String> {
        match anchors {
            UnifiedAnchors::Bare => {
                if is_counted_header(raw) {
                    return Err("unified bare patch cannot mix counted unified hunks with bare @@ anchors".to_owned());
                }
                Ok(normalise_anchor(&raw[2..]))
            }
            UnifiedAnchors::Counted => match counted_header(raw) {
                Some(tail) => Ok(normalise_anchor(tail)),
                None => Err(format!("unified fallback requires counted hunk header: {raw}")),
            },
        }
    };
    let mut b = SectionBuilder::default();
    let header_path = |line: &str, prefix: &str| strip_diff_prefix(&normalise_path(&line[prefix.len()..])).to_owned();
    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        i += 1;
        if ["diff --git ", "index ", "new file mode ", "deleted file mode "].iter().any(|p| raw.starts_with(p)) {
            continue;
        }
        if raw.starts_with("--- ") {
            let next = lines.get(i).copied().unwrap_or("");
            if next.starts_with("+++ ") {
                let (old_path, new_path) = (header_path(raw, "--- "), header_path(next, "+++ "));
                let kind = if old_path == "/dev/null" {
                    Kind::Add
                } else if new_path == "/dev/null" {
                    Kind::Delete
                } else {
                    Kind::Update
                };
                let path = normalise_path(if kind == Kind::Add { &new_path } else { &old_path });
                b.start_file(kind, path);
                i += 1;
                continue;
            }
            if b.files.is_empty() {
                return Err(format!("{label} missing +++ header after: {raw}"));
            }
        }
        let Some(current) = b.files.last_mut() else { continue };
        let kind = current.kind;
        if raw.is_empty() {
            if kind == Kind::Update {
                b.blank_line();
            }
            continue;
        }
        if kind == Kind::Update && is_eof_marker(raw) {
            b.end_of_file()?;
            continue;
        }
        if raw.starts_with("@@") {
            b.anchor(resolve(raw)?);
            continue;
        }
        match kind {
            Kind::Add => {
                if let Some(added) = raw.strip_prefix('+') {
                    current.lines.push(added.to_owned());
                }
                continue;
            }
            Kind::Delete => continue,
            Kind::Update => {}
        }
        b.body_line(raw);
    }
    b.finish_hunk();
    let files = b.files;
    if files.iter().any(|f| f.path.is_empty()) {
        return Err(format!("{label} contains an empty file path"));
    }
    if files.is_empty() {
        return Err(format!("{label} contained no file sections"));
    }
    Ok(files)
}
/// Node `hasUnifiedBareV4AHunk`: a unified body (`---` and `+++` lines) with an `@@` line that is
/// not a counted hunk header.
pub(super) fn has_bare_hunk(patch: &str) -> bool {
    let text = prepare(patch);
    let lines: Vec<&str> = text.split('\n').collect();
    lines.iter().any(|l| l.starts_with("--- "))
        && lines.iter().any(|l| l.starts_with("+++ "))
        && lines.iter().any(|l| l.starts_with("@@") && !is_counted_header(l))
}
