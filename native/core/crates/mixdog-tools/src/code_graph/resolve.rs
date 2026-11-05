//! Import specifier -> indexed file. Resolves the relative and module-path forms the outline
//! rules emit for the JS family, Python and C-style includes; a specifier that names no
//! indexed file contributes no edge (it stays visible as a raw import).

use std::collections::HashSet;

const JS_EXTENSIONS: [&str; 9] = [
    ".mjs", ".js", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".json",
];

/// `a/b/../c/./d` -> `a/c/d`; `None` when it climbs above the root.
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

fn dir_of(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

fn join(dir: &str, spec: &str) -> Option<String> {
    if dir.is_empty() {
        normalize(spec)
    } else {
        normalize(&format!("{dir}/{spec}"))
    }
}

fn resolve_js_base(base: &str, files: &HashSet<String>) -> Option<String> {
    if files.contains(base) {
        return Some(base.to_string());
    }
    // `./x.js` written for a `.ts` source.
    let stem = JS_EXTENSIONS
        .iter()
        .find_map(|ext| base.strip_suffix(ext))
        .filter(|_| base.rfind('.') > base.rfind('/'));
    if let Some(stem) = stem {
        for ext in JS_EXTENSIONS {
            let candidate = format!("{stem}{ext}");
            if files.contains(&candidate) {
                return Some(candidate);
            }
        }
    }
    for ext in JS_EXTENSIONS {
        let candidate = format!("{base}{ext}");
        if files.contains(&candidate) {
            return Some(candidate);
        }
    }
    for ext in JS_EXTENSIONS {
        let candidate = format!("{base}/index{ext}");
        if files.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn resolve_python(rel: &str, spec: &str, files: &HashSet<String>) -> Option<String> {
    let dots = spec.chars().take_while(|c| *c == '.').count();
    let module = spec[dots..].replace('.', "/");
    let bases: Vec<String> = if dots > 0 {
        let mut dir = dir_of(rel).to_string();
        for _ in 1..dots {
            dir = dir_of(&dir).to_string();
        }
        vec![join(&dir, &module)?]
    } else {
        let sibling = join(dir_of(rel), &module);
        std::iter::once(module).chain(sibling).collect()
    };
    for base in bases {
        for candidate in [format!("{base}.py"), format!("{base}/__init__.py")] {
            if files.contains(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_one(rel: &str, lang: &str, spec: &str, files: &HashSet<String>) -> Option<String> {
    match lang {
        "javascript" | "typescript" => {
            if spec.starts_with('.') {
                resolve_js_base(&join(dir_of(rel), spec)?, files)
            } else {
                None
            }
        }
        "python" => resolve_python(rel, spec, files),
        "c" | "cpp" | "objc" => {
            let candidate = join(dir_of(rel), spec)?;
            files.contains(&candidate).then_some(candidate)
        }
        _ => None,
    }
}

pub(super) fn resolve_imports(
    rel: &str,
    lang: &str,
    raw: &[String],
    files: &HashSet<String>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for spec in raw {
        if let Some(target) = resolve_one(rel, lang, spec, files)
            && !out.contains(&target)
        {
            out.push(target);
        }
    }
    out
}
