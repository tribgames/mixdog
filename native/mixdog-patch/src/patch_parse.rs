// Unified-diff parsing: entries, file headers, hunk headers and entry paths.

use super::*;

pub(crate) fn parse_patch(input: &str) -> Result<Vec<Entry>, String> {
    let normalized = input.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let mut entries = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if !lines[i].starts_with("--- ") {
            i += 1;
            continue;
        }
        let old_file = parse_file_header(lines[i], "--- ")?;
        i += 1;
        if i >= lines.len() || !lines[i].starts_with("+++ ") {
            return Err("file section missing +++ header".to_string());
        }
        let new_file = parse_file_header(lines[i], "+++ ")?;
        i += 1;

        let mut hunks = Vec::new();
        while i < lines.len() && !lines[i].starts_with("--- ") {
            if !lines[i].starts_with("@@ ") {
                i += 1;
                continue;
            }
            let (old_start, old_count, new_count) = parse_hunk_header(lines[i])?;
            i += 1;
            let mut hunk_lines = Vec::new();
            let mut old_remaining = old_count;
            let mut new_remaining = new_count;
            while i < lines.len() {
                let line = lines[i];
                // Only treat `@@ `/`--- `/`+++ ` as boundaries when the
                // declared hunk body is fully consumed. Otherwise a body
                // line like `--- x` (deletion of `-- x`) or `+++ x`
                // (addition of `++ x`) would be mis-read as a new file
                // header. The native path-escape guard in
                // `resolve_entry_path` enforces the realpath bound here.
                if old_remaining == 0
                    && new_remaining == 0
                    && (line.starts_with("@@ ")
                        || line.starts_with("--- ")
                        || line.starts_with("+++ "))
                {
                    break;
                }
                if line.starts_with('\\') {
                    hunk_lines.push(line.to_string());
                    i += 1;
                    continue;
                }
                if line.is_empty() {
                    return Err("malformed empty hunk line".to_string());
                }
                let tag = line.as_bytes()[0];
                if tag != b' ' && tag != b'-' && tag != b'+' {
                    return Err(format!("malformed hunk line: {line}"));
                }
                match tag {
                    b' ' => {
                        if old_remaining == 0 || new_remaining == 0 {
                            return Err("malformed patch: hunk body exceeds declared line counts"
                                .to_string());
                        }
                        old_remaining -= 1;
                        new_remaining -= 1;
                    }
                    b'-' => {
                        if old_remaining == 0 {
                            return Err("malformed patch: hunk body exceeds declared line counts"
                                .to_string());
                        }
                        old_remaining -= 1;
                    }
                    b'+' => {
                        if new_remaining == 0 {
                            return Err("malformed patch: hunk body exceeds declared line counts"
                                .to_string());
                        }
                        new_remaining -= 1;
                    }
                    _ => {}
                }
                hunk_lines.push(line.to_string());
                i += 1;
            }
            if old_remaining != 0 || new_remaining != 0 {
                return Err(
                    "malformed patch: incomplete hunk (EOF before declared line counts consumed)"
                        .to_string(),
                );
            }
            hunks.push(Hunk {
                old_start,
                lines: hunk_lines,
            });
        }
        entries.push(Entry {
            old_file,
            new_file,
            hunks,
        });
    }
    Ok(entries)
}

pub(crate) fn parse_file_header(line: &str, prefix: &str) -> Result<String, String> {
    let rest = line
        .strip_prefix(prefix)
        .ok_or_else(|| format!("bad file header: {line}"))?;
    // split() always yields at least one item, so next() is never None.
    let path = rest
        .split('\t')
        .next()
        .expect("split yields at least one item")
        .trim();
    if path.is_empty() {
        return Err(format!("empty file header: {line}"));
    }
    Ok(path.to_string())
}

pub(crate) fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize), String> {
    let mut parts = line.split_whitespace();
    if parts.next() != Some("@@") {
        return Err(format!("bad hunk header: {line}"));
    }
    let old = parts.next().ok_or_else(|| {
        format!("missing old range: {line}; use @@ -A,B +C,D @@ for native unified patches")
    })?;
    let old = old.strip_prefix('-').ok_or_else(|| {
        format!("bad old range: {line}; use @@ -A,B +C,D @@ for native unified patches")
    })?;
    let (old_start_str, old_count_str) = match old.split_once(',') {
        Some((s, c)) => (s, c),
        None => (old, "1"),
    };
    let old_start = old_start_str.parse::<usize>().map_err(|_| {
        format!(
            "bad old start in hunk header: {line}; use @@ -A,B +C,D @@ for native unified patches"
        )
    })?;
    let old_count = old_count_str.parse::<usize>().map_err(|_| {
        format!(
            "bad old count in hunk header: {line}; use @@ -A,B +C,D @@ for native unified patches"
        )
    })?;
    let new = parts.next().ok_or_else(|| {
        format!("missing new range: {line}; use @@ -A,B +C,D @@ for native unified patches")
    })?;
    let new = new.strip_prefix('+').ok_or_else(|| {
        format!("bad new range: {line}; use @@ -A,B +C,D @@ for native unified patches")
    })?;
    let (_, new_count_str) = match new.split_once(',') {
        Some((s, c)) => (s, c),
        None => (new, "1"),
    };
    let new_count = new_count_str.parse::<usize>().map_err(|_| {
        format!(
            "bad new count in hunk header: {line}; use @@ -A,B +C,D @@ for native unified patches"
        )
    })?;
    Ok((old_start, old_count, new_count))
}

pub(crate) fn is_dev_null(value: &str) -> bool {
    value == "/dev/null" || value == "dev/null"
}

pub(crate) fn strip_diff_prefix(value: &str) -> &str {
    value
        .strip_prefix("a/")
        .or_else(|| value.strip_prefix("b/"))
        .or_else(|| value.strip_prefix("./"))
        .unwrap_or(value)
}

pub(crate) fn resolve_entry_path(canonical_base: &Path, header: &str) -> Result<PathBuf, String> {
    let stripped = strip_diff_prefix(header);
    let rel = Path::new(stripped);
    if rel.is_absolute() {
        return Err(format!("absolute patch path rejected: {header}"));
    }
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("parent traversal rejected: {header}"));
    }
    let joined = canonical_base.join(rel);
    // Realpath guard: walk up to the nearest existing ancestor, canonicalize
    // it, and require it to stay inside the canonicalized base. This catches
    // symlinked subtrees that resolve outside the base directory even when
    // the header itself looks innocuous.
    let ancestor = nearest_existing_ancestor(&joined);
    let canonical_ancestor = fs::canonicalize(&ancestor).map_err(|e| {
        format!(
            "canonicalize ancestor {} for {header}: {e}",
            ancestor.display()
        )
    })?;
    if !canonical_ancestor.starts_with(canonical_base) {
        return Err(format!(
            "path escapes base directory: {header} resolves to {} outside {}",
            canonical_ancestor.display(),
            canonical_base.display()
        ));
    }
    Ok(joined)
}

pub(crate) fn nearest_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return current;
        }
        match current.parent() {
            Some(p) if !p.as_os_str().is_empty() => current = p.to_path_buf(),
            _ => return current,
        }
    }
}

pub(crate) fn build_create_bytes(entry: &Entry) -> Result<Vec<u8>, String> {
    if entry.hunks.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for hunk in &entry.hunks {
        let parts = parse_hunk_parts(hunk)?;
        if !parts.old.is_empty() {
            return Err(format!(
                "create patch contains source lines in {}",
                entry.new_file
            ));
        }
        append_hunk_lines(&mut out, &parts.new, "\n");
    }
    Ok(out)
}
