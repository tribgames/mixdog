// Repo-relative path algebra shared by every resolver.
//
// Every path in this layer is repo-relative and forward-slash normalized (the
// same form as `FileRecord.rel`), and the graph root is the empty string "".
// `std::path` cannot answer here: it works in OS-separator space and has no
// lexical `..` collapsing, while resolution must answer in the exact string
// space the fileSet is keyed on.

// Mirror of JS `_normalizeImportSpec`: trim + backslash→forward-slash.
pub(crate) fn normalize_import_spec(spec: &str) -> String {
    spec.trim().replace('\\', "/")
}

// dirname for a repo-relative path. "a/b/c.ts" → "a/b"; "c.ts" → "".
pub(crate) fn rel_dir(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(i) => &rel[..i],
        None => "",
    }
}

// Owned parent of a repo-relative dir. "a/b" → "a"; "a" → ""; "" → "".
pub(crate) fn dirname_str(d: &str) -> String {
    match d.rfind('/') {
        Some(i) => d[..i].to_string(),
        None => String::new(),
    }
}

// Repo-relative analogue of `pathResolve(base, spec)`: join `base` (a
// repo-relative dir) with `spec`, collapse `.`/`..` segments, and emit a
// forward-slash repo-relative path. Leading `..` that escapes the root is
// preserved as a literal `..` segment so the result can never spuriously
// match a repo-relative fileSet entry (which never contains `..`).
pub(crate) fn path_join_norm(base: &str, spec: &str) -> String {
    let combined = if base.is_empty() {
        spec.to_string()
    } else {
        format!("{}/{}", base, spec)
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_none_or(|p| *p == "..") {
                    parts.push("..");
                } else {
                    parts.pop();
                }
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

// `dir` is `ancestor` itself or lies below it. "a/b" is under "a", "ab" is
// not; the root "" contains only "" and absolute-looking "/…" paths, exactly
// like the `"{ancestor}/"` prefix test it replaces.
pub(crate) fn is_same_or_under(dir: &str, ancestor: &str) -> bool {
    dir.strip_prefix(ancestor)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

pub(crate) fn file_stem_rel(rel: &str) -> Option<&str> {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.')
        .map(|(stem, _)| stem)
        .filter(|s| !s.is_empty())
}

// Relative path from an ancestor dir `from` to `to` (both repo-relative).
pub(crate) fn rel_strip_prefix(from: &str, to: &str) -> String {
    if from.is_empty() {
        to.to_string()
    } else if to == from {
        String::new()
    } else if let Some(tail) = to.strip_prefix(&format!("{}/", from)) {
        tail.to_string()
    } else {
        to.to_string()
    }
}
