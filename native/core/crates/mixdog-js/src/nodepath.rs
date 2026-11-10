//! The parts of Node's `path` the turn review reads (`resolve`, `relative`, `isAbsolute`), in both
//! flavours, so a recorded root and a written file relate the way Node relates them on every
//! platform. Rust's own `Path` does not collapse `..` or fold drive letters, which the review's
//! keys depend on.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    Win32,
    Posix,
}

impl Style {
    pub const fn host() -> Self {
        if cfg!(windows) { Style::Win32 } else { Style::Posix }
    }


    fn is_sep(self, c: char) -> bool {
        c == '/' || (self == Style::Win32 && c == '\\')
    }
}

fn cwd() -> String {
    std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "/".to_owned())
}

/// `normalizeString` of Node's path module.
fn normalize_string(path: &[char], allow_above_root: bool, sep: char, is_sep: impl Fn(char) -> bool) -> String {
    let mut res: Vec<char> = Vec::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code = '\0';
    for i in 0..=path.len() {
        if i < path.len() {
            code = path[i];
        } else if is_sep(code) {
            break;
        } else {
            code = '/';
        }
        if is_sep(code) {
            if last_slash == i as isize - 1 || dots == 1 {
                // a doubled separator or a `.` segment adds nothing
            } else if dots == 2 {
                let n = res.len();
                let ends_dotdot = n >= 2 && res[n - 1] == '.' && res[n - 2] == '.';
                if n < 2 || last_segment_length != 2 || !ends_dotdot {
                    if n > 2 {
                        match res.iter().rposition(|c| *c == sep) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(index) => {
                                res.truncate(index);
                                last_segment_length = match res.iter().rposition(|c| *c == sep) {
                                    Some(prev) => res.len() - 1 - prev,
                                    None => res.len(),
                                };
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    } else if n != 0 {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(sep);
                    }
                    res.extend(['.', '.']);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push(sep);
                }
                res.extend(&path[(last_slash + 1) as usize..i]);
                last_segment_length = (i as isize - last_slash - 1) as usize;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res.into_iter().collect()
}

fn is_device_root(c: char) -> bool {
    c.is_ascii_alphabetic()
}

/// `path.resolve(...parts)` (the last absolute part wins; the process directory completes a
/// relative result).
pub fn resolve(style: Style, parts: &[&str]) -> String {
    match style {
        Style::Posix => resolve_posix(parts),
        Style::Win32 => resolve_win32(parts),
    }
}

fn resolve_posix(parts: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    let current = cwd();
    for i in (-1..parts.len() as isize).rev() {
        let path: &str = if i >= 0 {
            let p = parts[i as usize];
            if p.is_empty() {
                continue;
            }
            p
        } else {
            &current
        };
        resolved = format!("{path}/{resolved}");
        absolute = path.starts_with('/');
        if absolute {
            break;
        }
    }
    let chars: Vec<char> = resolved.chars().collect();
    let tail = normalize_string(&chars, !absolute, '/', |c| c == '/');
    if absolute {
        format!("/{tail}")
    } else if tail.is_empty() {
        ".".to_owned()
    } else {
        tail
    }
}

fn resolve_win32(parts: &[&str]) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;
    let current = cwd();
    let is_sep = |c: char| c == '/' || c == '\\';
    for i in (-1..parts.len() as isize).rev() {
        let path: String = if i >= 0 {
            let p = parts[i as usize];
            if p.is_empty() {
                continue;
            }
            p.to_owned()
        } else if resolved_device.is_empty() {
            current.clone()
        } else {
            let from_env = std::env::var(format!("={resolved_device}")).ok().filter(|v| !v.is_empty());
            let p = from_env.unwrap_or_else(|| current.clone());
            let head: String = p.chars().take(2).collect::<String>().to_lowercase();
            if head != resolved_device.to_lowercase() && p.chars().nth(2) == Some('\\') {
                format!("{resolved_device}\\")
            } else {
                p
            }
        };
        let chars: Vec<char> = path.chars().collect();
        let len = chars.len();
        let mut root_end = 0usize;
        let mut device = String::new();
        let mut absolute = false;
        let code = chars.first().copied().unwrap_or('\0');
        if len == 1 {
            if is_sep(code) {
                root_end = 1;
                absolute = true;
            }
        } else if is_sep(code) {
            absolute = true;
            if is_sep(chars[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !is_sep(chars[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part: String = chars[last..j].iter().collect();
                    last = j;
                    while j < len && is_sep(chars[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_sep(chars[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            let second: String = chars[last..j].iter().collect();
                            device = format!("\\\\{first_part}\\{second}");
                            root_end = j;
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if is_device_root(code) && len > 1 && chars[1] == ':' {
            device = chars[..2].iter().collect();
            root_end = 2;
            if len > 2 && is_sep(chars[2]) {
                absolute = true;
                root_end = 3;
            }
        }
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if device.to_lowercase() != resolved_device.to_lowercase() {
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            let rest: String = chars[root_end.min(len)..].iter().collect();
            resolved_tail = format!("{rest}\\{resolved_tail}");
            resolved_absolute = absolute;
            if absolute && !resolved_device.is_empty() {
                break;
            }
        }
    }
    let tail_chars: Vec<char> = resolved_tail.chars().collect();
    let tail = normalize_string(&tail_chars, !resolved_absolute, '\\', is_sep);
    if resolved_absolute {
        format!("{resolved_device}\\{tail}")
    } else {
        let joined = format!("{resolved_device}{tail}");
        if joined.is_empty() { ".".to_owned() } else { joined }
    }
}

/// `path.isAbsolute`.
pub fn is_absolute(style: Style, path: &str) -> bool {
    let chars: Vec<char> = path.chars().take(3).collect();
    let Some(&first) = chars.first() else { return false };
    match style {
        Style::Posix => first == '/',
        Style::Win32 => {
            if style.is_sep(first) {
                return true;
            }
            is_device_root(first) && chars.get(1) == Some(&':') && chars.get(2).is_some_and(|c| style.is_sep(*c))
        }
    }
}

/// `path.relative(from, to)`.
pub fn relative(style: Style, from: &str, to: &str) -> String {
    match style {
        Style::Posix => relative_posix(from, to),
        Style::Win32 => relative_win32(from, to),
    }
}

fn relative_posix(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from = resolve_posix(&[from]);
    let to = resolve_posix(&[to]);
    if from == to {
        return String::new();
    }
    let from: Vec<char> = from.chars().collect();
    let to: Vec<char> = to.chars().collect();
    let from_start = 1usize;
    let from_end = from.len();
    let from_len = from_end - from_start;
    let to_start = 1usize;
    let to_len = to.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let f = from[from_start + i];
        if f != to[to_start + i] {
            break;
        } else if f == '/' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if to[to_start + i] == '/' {
                return to[to_start + i + 1..].iter().collect();
            }
            if i == 0 {
                return to[to_start + i..].iter().collect();
            }
        } else if from_len > length {
            if from[from_start + i] == '/' {
                last_common_sep = i as isize;
            } else if i == 0 {
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    let mut k = from_start as isize + last_common_sep + 1;
    while k <= from_end as isize {
        if k == from_end as isize || from[k as usize] == '/' {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        k += 1;
    }
    let rest: String = to[(to_start as isize + last_common_sep) as usize..].iter().collect();
    format!("{out}{rest}")
}

fn relative_win32(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from_orig = resolve_win32(&[from]);
    let to_orig = resolve_win32(&[to]);
    if from_orig == to_orig {
        return String::new();
    }
    // Node lower-cases each whole string (`toLowerCase`, which may change its length: `İ` becomes two units) and then reads positions
    // of the lower-cased strings, in UTF-16 units, and slices the original `to` at them (String.prototype.slice, which clamps). The
    // same here, unit for unit, so a length-changing character gives Node's answer and never an out-of-range slice.
    let from: Vec<u16> = crate::js_to_lowercase(&from_orig).encode_utf16().collect();
    let to: Vec<u16> = crate::js_to_lowercase(&to_orig).encode_utf16().collect();
    if from == to {
        return String::new();
    }
    // A lower-casing that changed a length: Node compares segment by segment instead (path.js `win32.relative`).
    if crate::utf16_len(&from_orig) != from.len() || crate::utf16_len(&to_orig) != to.len() {
        let mut from_split: Vec<&str> = from_orig.split('\\').collect();
        let mut to_split: Vec<&str> = to_orig.split('\\').collect();
        if from_split.last() == Some(&"") {
            from_split.pop();
        }
        if to_split.last() == Some(&"") {
            to_split.pop();
        }
        let length = from_split.len().min(to_split.len());
        let i = (0..length).find(|&i| crate::js_to_lowercase(from_split[i]) != crate::js_to_lowercase(to_split[i])).unwrap_or(length);
        if i == 0 {
            return to_orig;
        }
        if i == length {
            if to_split.len() > length {
                return to_split[i..].join("\\");
            }
            if from_split.len() > length {
                return format!("{}..", "..\\".repeat(from_split.len() - 1 - i));
            }
            return String::new();
        }
        return format!("{}{}", "..\\".repeat(from_split.len() - i), to_split[i..].join("\\"));
    }
    let to_orig_units: Vec<u16> = to_orig.encode_utf16().collect();
    let slice = |start: usize, end: usize| -> String {
        let end = end.min(to_orig_units.len());
        String::from_utf16_lossy(&to_orig_units[start.min(end)..end])
    };
    const SEP: u16 = b'\\' as u16;
    let mut from_start = 0usize;
    while from_start < from.len() && from[from_start] == SEP {
        from_start += 1;
    }
    let mut from_end = from.len();
    while from_end > from_start + 1 && from[from_end - 1] == SEP {
        from_end -= 1;
    }
    let from_len = from_end - from_start;
    let mut to_start = 0usize;
    while to_start < to.len() && to[to_start] == SEP {
        to_start += 1;
    }
    let mut to_end = to.len();
    while to_end > to_start + 1 && to[to_end - 1] == SEP {
        to_end -= 1;
    }
    let to_len = to_end - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0usize;
    while i < length {
        let f = from[from_start + i];
        if f != to[to_start + i] {
            break;
        } else if f == SEP {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i != length {
        if last_common_sep == -1 {
            return to_orig;
        }
    } else {
        if to_len > length {
            if to[to_start + i] == SEP {
                return slice(to_start + i + 1, usize::MAX);
            }
            if i == 2 {
                return slice(to_start + i, usize::MAX);
            }
        }
        if from_len > length {
            if from[from_start + i] == SEP {
                last_common_sep = i as isize;
            } else if i == 2 {
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }
    let mut out = String::new();
    let mut k = from_start as isize + last_common_sep + 1;
    while k <= from_end as isize {
        if k == from_end as isize || from[k as usize] == SEP {
            out.push_str(if out.is_empty() { ".." } else { "\\.." });
        }
        k += 1;
    }
    let to_start = (to_start as isize + last_common_sep) as usize;
    if !out.is_empty() {
        return format!("{out}{}", slice(to_start, to_end));
    }
    let mut to_start = to_start;
    if to_orig_units.get(to_start) == Some(&SEP) {
        to_start += 1;
    }
    slice(to_start, to_end)
}

/// The host's `resolve`/`relative`/`isAbsolute`.
pub fn resolve_host(parts: &[&str]) -> String {
    resolve(Style::host(), parts)
}

pub fn relative_host(from: &str, to: &str) -> String {
    relative(Style::host(), from, to)
}

pub fn is_absolute_host(path: &str) -> bool {
    is_absolute(Style::host(), path)
}

/// `rel.split(/[\\/]+/)`: the first piece is empty for a leading separator, and a run of
/// separators is one boundary.
pub fn split_segments(path: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut in_run = false;
    for (index, c) in path.char_indices() {
        if c == '/' || c == '\\' {
            if !in_run {
                out.push(&path[start..index]);
                in_run = true;
            }
            start = index + c.len_utf8();
        } else {
            in_run = false;
        }
    }
    out.push(&path[start..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `path.win32.relative` as Node answers it where the lower-cased comparison meets a character whose lower case has another
    /// length (`İ`), characters outside the BMP and the other case-insensitive pairs (`testdata/path_relative.json`, written by Node).
    #[test]
    fn win32_relative_is_nodes_where_lower_casing_changes_lengths() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../testdata/path_relative.json")).unwrap();
        let rows = golden["rows"].as_array().unwrap();
        for row in rows {
            let (from, to) = (row["from"].as_str().unwrap(), row["to"].as_str().unwrap());
            assert_eq!(relative(Style::Win32, from, to), row["relative"].as_str().unwrap(), "{from:?} -> {to:?}");
        }
        assert_eq!(rows.len(), 21);
    }
}
