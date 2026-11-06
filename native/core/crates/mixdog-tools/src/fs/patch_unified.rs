//! jsdiff's `parsePatch` (the `diff` package Node parses unified patches with): files, their
//! headers and counted hunks, with the same quirks and the same error texts.

use mixdog_js::is_js_space;
use mixdog_js::js_trim;

/// A hunk as jsdiff reads it: a zero-length range has its start bumped by one.
pub(super) struct RawHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<String>,
}

/// One file of the patch; a name is `None` when the patch never gave one.
#[derive(Default)]
pub(super) struct UFile {
    pub old_name: Option<String>,
    pub new_name: Option<String>,
    pub hunks: Vec<RawHunk>,
}

fn after_marker_space(line: &str, marker: &str) -> bool {
    line.strip_prefix(marker).and_then(|r| r.chars().next()).is_some_and(is_js_space)
}

fn is_git_header(line: &str) -> bool {
    line.starts_with("diff --git ")
}

/// `^diff(?: -r \w+)+\s`.
fn is_hg_header(line: &str) -> bool {
    let Some(mut rest) = line.strip_prefix("diff") else { return false };
    let mut groups = 0;
    while let Some(after) = rest.strip_prefix(" -r ") {
        let word = after.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').count();
        if word == 0 {
            break;
        }
        rest = &after[word..];
        groups += 1;
    }
    groups > 0 && rest.chars().next().is_some_and(is_js_space)
}

fn is_diff_header(line: &str) -> bool {
    is_git_header(line) || after_marker_space(line, "Index:") || is_hg_header(line)
}

fn is_file_header(line: &str) -> bool {
    after_marker_space(line, "---") || after_marker_space(line, "+++")
}

fn is_hunk_header(line: &str) -> bool {
    after_marker_space(line, "@@")
}

/// A C-style quoted name: its text and the raw length consumed, or `None` when malformed.
fn parse_quoted(s: &str) -> Option<(String, usize)> {
    let chars: Vec<char> = s.chars().collect();
    if chars.first() != Some(&'"') {
        return None;
    }
    let mut result = String::new();
    let mut j = 1;
    while j < chars.len() {
        if chars[j] == '"' {
            return Some((result, chars[..=j].iter().map(|c| c.len_utf8()).sum()));
        }
        if chars[j] == '\\' && j + 1 < chars.len() {
            j += 1;
            match chars[j] {
                'a' => result.push('\x07'),
                'b' => result.push('\x08'),
                'f' => result.push('\x0c'),
                'n' => result.push('\n'),
                'r' => result.push('\r'),
                't' => result.push('\t'),
                'v' => result.push('\x0b'),
                '\\' => result.push('\\'),
                '"' => result.push('"'),
                '0'..='7' => {
                    let octal = |at: usize| -> Option<u8> {
                        let digits: String = chars.get(at..at + 3)?.iter().collect();
                        (digits.chars().all(|c| ('0'..='7').contains(&c))).then(|| u8::from_str_radix(&digits, 8).ok()).flatten()
                    };
                    let mut bytes = vec![octal(j)?];
                    j += 3;
                    while chars.get(j) == Some(&'\\') && chars.get(j + 1).is_some_and(|c| ('0'..='7').contains(c)) {
                        bytes.push(octal(j + 1)?);
                        j += 4;
                    }
                    result.push_str(&String::from_utf8_lossy(&bytes));
                    continue;
                }
                _ => return None,
            }
        } else {
            result.push(chars[j]);
        }
        j += 1;
    }
    None
}

fn unquote_if_quoted(s: &str) -> String {
    if s.starts_with('"') {
        if let Some((name, _)) = parse_quoted(s) {
            return name;
        }
    }
    s.to_owned()
}

/// `diff --git a/<old> b/<new>`; `None` when the names cannot be told apart.
fn parse_git_header(line: &str) -> Option<(String, String)> {
    let rest = &line["diff --git ".len()..];
    if rest.starts_with('"') {
        let (old, raw_len) = parse_quoted(rest)?;
        let after = rest.get(raw_len + 1..).unwrap_or("");
        let new = if after.starts_with('"') { parse_quoted(after)?.0 } else { after.to_owned() };
        return Some((old, new));
    }
    if let Some(quote) = rest.find('"').filter(|q| *q > 0) {
        let old = rest[..quote - 1].to_owned();
        return Some((old, parse_quoted(&rest[quote..])?.0));
    }
    if rest.starts_with("a/") {
        let mut splits = Vec::new();
        let mut from = 0;
        while let Some(found) = rest.get(from + 1..).and_then(|r| r.find(" b/")) {
            let at = from + 1 + found;
            splits.push(at);
            from = at;
        }
        if !splits.is_empty() {
            let mid = splits[splits.len() / 2];
            return Some((rest[..mid].to_owned(), rest[mid + 1..].to_owned()));
        }
    }
    None
}

struct Parser<'a> {
    lines: Vec<&'a str>,
    i: usize,
}

impl Parser<'_> {
    fn line(&self) -> Option<&str> {
        self.lines.get(self.i).copied()
    }

    fn parse_file_header(&mut self, file: &mut UFile) {
        let Some(line) = self.line() else { return };
        let Some(prefix) = ["---", "+++"].into_iter().find(|p| line.strip_prefix(p).and_then(|r| r.chars().next()).is_some_and(is_js_space)) else {
            return;
        };
        let data = js_trim(&line[3..]);
        let name = data.split('\t').next().unwrap_or("");
        let name = if name.starts_with('"') { unquote_if_quoted(name) } else { name.replace("\\\\", "\\") };
        if prefix == "---" {
            file.old_name = Some(name);
        } else {
            file.new_name = Some(name);
        }
        self.i += 1;
    }

    fn parse_hunk(&mut self) -> Result<RawHunk, String> {
        let header_index = self.i;
        let header = self.lines[self.i];
        self.i += 1;
        let numbers = counted_numbers(header);
        let (old_start, old_given, new_start, new_given) = match numbers {
            Some((os, ol, ns, nl)) => (os, ol, ns, nl),
            None => (0, None, 0, None),
        };
        let mut hunk = RawHunk {
            old_start,
            old_lines: old_given.unwrap_or(1),
            new_start,
            new_lines: new_given.unwrap_or(1),
            lines: Vec::new(),
        };
        // The unified format's quirk: with a zero count the first number is one lower than expected.
        if hunk.old_lines == 0 && numbers.is_some() {
            hunk.old_start += 1;
        }
        if hunk.new_lines == 0 && numbers.is_some() {
            hunk.new_start += 1;
        }
        let (mut add, mut remove) = (0, 0);
        while self.i < self.lines.len() && (remove < hunk.old_lines || add < hunk.new_lines || self.lines[self.i].starts_with('\\')) {
            let line = self.lines[self.i];
            let operation = if line.is_empty() && self.i != self.lines.len() - 1 { Some(' ') } else { line.chars().next() };
            match operation {
                Some('+') => add += 1,
                Some('-') => remove += 1,
                Some(' ') => {
                    add += 1;
                    remove += 1;
                }
                Some('\\') => {}
                _ => return Err(format!("Hunk at line {} contained invalid line {line}", header_index + 1)),
            }
            hunk.lines.push(line.to_owned());
            self.i += 1;
        }
        if add == 0 && hunk.new_lines == 1 {
            hunk.new_lines = 0;
        }
        if remove == 0 && hunk.old_lines == 1 {
            hunk.old_lines = 0;
        }
        if add != hunk.new_lines {
            return Err(format!("Added line count did not match for hunk at line {}", header_index + 1));
        }
        if remove != hunk.old_lines {
            return Err(format!("Removed line count did not match for hunk at line {}", header_index + 1));
        }
        if let Some(next) = self.line().filter(|l| !l.is_empty() && matches!(l.as_bytes()[0], b'+' | b' ' | b'-') && !is_file_header(l)) {
            let _ = next;
            return Err(format!(
                "Hunk at line {} has more lines than expected (expected {} old lines and {} new lines)",
                header_index + 1,
                hunk.old_lines,
                hunk.new_lines
            ));
        }
        Ok(hunk)
    }

    /// One file's section; `Ok(None)` when another file's header ended it before any content.
    fn parse_index(&mut self, list: &mut Vec<UFile>) -> Result<(), String> {
        let mut file = UFile::default();
        let mut seen_diff_header = false;
        while let Some(line) = self.line() {
            if is_file_header(line) || is_hunk_header(line) {
                break;
            }
            if is_git_header(line) {
                if seen_diff_header {
                    list.push(file);
                    return Ok(());
                }
                seen_diff_header = true;
                if let Some((old, new)) = parse_git_header(line) {
                    file.old_name = Some(old);
                    file.new_name = Some(new);
                }
                self.i += 1;
                while let Some(ext) = self.line() {
                    if is_file_header(ext) || is_hunk_header(ext) || is_diff_header(ext) {
                        break;
                    }
                    for (prefix, side, mark) in [("rename from ", true, "a/"), ("rename to ", false, "b/"), ("copy from ", true, "a/"), ("copy to ", false, "b/")] {
                        if let Some(name) = ext.strip_prefix(prefix) {
                            let named = format!("{mark}{}", unquote_if_quoted(name));
                            if side {
                                file.old_name = Some(named);
                            } else {
                                file.new_name = Some(named);
                            }
                        }
                    }
                    self.i += 1;
                }
                continue;
            } else if is_diff_header(line) {
                if seen_diff_header {
                    list.push(file);
                    return Ok(());
                }
                seen_diff_header = true;
            }
            self.i += 1;
        }
        self.parse_file_header(&mut file);
        self.parse_file_header(&mut file);
        if file.old_name.is_some() != file.new_name.is_some() {
            let missing = if file.old_name.is_some() { "\"+++ ...\"" } else { "\"--- ...\"" };
            return Err(format!("Missing {missing} file header for {}", file.old_name.as_ref().or(file.new_name.as_ref()).cloned().unwrap_or_default()));
        }
        while let Some(line) = self.line() {
            if is_diff_header(line) || is_file_header(line) || line.starts_with("===================================================================") {
                break;
            }
            if is_hunk_header(line) {
                let hunk = self.parse_hunk()?;
                file.hunks.push(hunk);
            } else {
                self.i += 1;
            }
        }
        list.push(file);
        Ok(())
    }
}

/// `@@ -a[,b] +c[,d] @@` anywhere in the line: `(a, b, c, d)`.
fn counted_numbers(line: &str) -> Option<(usize, Option<usize>, usize, Option<usize>)> {
    let digits = |s: &str| s.chars().take_while(char::is_ascii_digit).count();
    let mut from = 0;
    while let Some(found) = line[from..].find("@@ -") {
        let start = from + found;
        from = start + 1;
        let rest = &line[start + 4..];
        let n = digits(rest);
        if n == 0 {
            continue;
        }
        let old_start: usize = rest[..n].parse().ok()?;
        let mut rest = &rest[n..];
        let mut old_len = None;
        if let Some(r) = rest.strip_prefix(',') {
            let m = digits(r);
            if m == 0 {
                continue;
            }
            old_len = r[..m].parse().ok();
            rest = &r[m..];
        }
        let Some(r) = rest.strip_prefix(" +") else { continue };
        let n = digits(r);
        if n == 0 {
            continue;
        }
        let new_start: usize = r[..n].parse().ok()?;
        let mut rest = &r[n..];
        let mut new_len = None;
        if let Some(r) = rest.strip_prefix(',') {
            let m = digits(r);
            if m == 0 {
                continue;
            }
            new_len = r[..m].parse().ok();
            rest = &r[m..];
        }
        if rest.starts_with(" @@") {
            return Some((old_start, old_len, new_start, new_len));
        }
    }
    None
}

/// Node `parsePatch(prepareInput(patch))`.
pub(super) fn parse_patch(text: &str) -> Result<Vec<UFile>, String> {
    let mut parser = Parser { lines: text.split('\n').collect(), i: 0 };
    let mut list = Vec::new();
    while parser.i < parser.lines.len() {
        parser.parse_index(&mut list)?;
    }
    Ok(list)
}