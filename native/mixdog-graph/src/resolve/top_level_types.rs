// THE ONE REGEX SURVIVOR: `topLevelTypes`.
//
// Every other file-level field now comes from the parse tree — tokens and
// package/namespace/goPackage from the outline walk, imports and symbols from
// the rules. `topLevelTypes` cannot follow, because its VALUE SET is not the
// set of declared types: the pattern is a plain word scan, so it also reports
// * the word after a keyword pair — `enum class Mode` yields `class`;
// * matches in prose — a doc comment saying "the struct value is …" yields
//   `value`, and this repo's own C# sources carry `value`, `child`, `raw`,
//   `is`, `accessible`, … in `topLevelTypes` today.
// Those strings are not noise the graph can drop: `java`/`kotlin` import
// resolution indexes `<packageName>.<type>` by exactly these strings
// (`type_by_fqcn`), and the field is part of the reused-node protocol the JS
// side sends back on `--files`. An AST rule can only ever report real type
// declarations, which is a DIFFERENT set, so the scan stays a regex and the
// `regex` crate stays a dependency.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

struct TypePatterns {
    type_decl_jks: Regex,
    go_type: Regex,
}

impl TypePatterns {
    fn new() -> Self {
        let type_decl_jks = Regex::new(
            r"\b(?:class|interface|enum|record|object|struct)\s+([A-Za-z_][A-Za-z0-9_]*)",
        )
        .unwrap();
        let go_type = Regex::new(r"(?m)^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b").unwrap();
        TypePatterns {
            type_decl_jks,
            go_type,
        }
    }
}

/// The `topLevelTypes` of a file's text: compiled once per process, shared by
/// the executable's graph modes and the Rust core's code graph.
pub fn extract_top_level_types(text: &str, lang: &str) -> Vec<String> {
    static PATTERNS: OnceLock<TypePatterns> = OnceLock::new();
    let p = PATTERNS.get_or_init(TypePatterns::new);
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut keep = |name: &str| {
        if seen.insert(name.to_string()) {
            out.push(name.to_string());
        }
    };
    match lang {
        "java" | "kotlin" | "csharp" => {
            for line in text.lines() {
                if let Some(m) = p.type_decl_jks.captures(line).and_then(|cap| cap.get(1)) {
                    keep(m.as_str());
                }
            }
        }
        "go" => {
            for m in p.go_type.captures_iter(text).filter_map(|cap| cap.get(1)) {
                keep(m.as_str());
            }
        }
        _ => {}
    }
    out
}
