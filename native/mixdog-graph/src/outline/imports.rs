// Import specs in the exact shape the resolvers expect.
//
// A rule reports the specifier node it matched; the per-language shaping — the
// quotes, the `#include` delimiters, Rust's `mod::` prefix, the PHP and Elixir
// brace groups that expand into several edges — happens here. The
// SOURCE-IMPORT CONTRACT (what is and is not an edge) is in the module header
// of `src/outline.rs`.

/// Import spec(s) in the exact shape the resolvers expect, from the rule name
/// (already the spec node for most languages) plus the matched source text.
pub(super) fn import_specs(lang: &str, ast_kind: &str, name: &str, text: &str) -> Vec<String> {
    let name = name.trim();
    match lang {
        "php" => match ast_kind {
            "namespace_use_declaration" | "use_declaration" => expand_php_use_spec(name),
            _ => single(strip_quotes(name)),
        },
        "elixir" => {
            let spec = leading_elixir_alias(name);
            if spec.is_empty() {
                Vec::new()
            } else {
                expand_elixir_alias_spec(spec)
            }
        }
        "rust" => match ast_kind {
            // `mod x;` is a `mod::x` edge for the resolver.
            "mod_item" => single(format!("mod::{name}")),
            _ => single(name.to_string()),
        },
        "scala" | "swift" => single(leading_dotted_path(name)),
        // `#include "a.h"` and `#include <a.h>` both resolve on the bare path;
        // an unquoted `#include MACRO` was never an import edge.
        "c" | "cpp" => match delimited_include(name, text) {
            Some(spec) => single(spec),
            None => Vec::new(),
        },
        "objc" => match ast_kind {
            "preproc_import" | "preproc_include" => match delimited_include(name, text) {
                Some(spec) => single(spec),
                None => Vec::new(),
            },
            _ => single(strip_quotes(name)),
        },
        "java" | "kotlin" | "csharp" => single(name.to_string()),
        _ => single(strip_quotes(name)),
    }
}

fn single(spec: String) -> Vec<String> {
    let trimmed = spec.trim().to_string();
    if trimmed.is_empty() {
        Vec::new()
    } else {
        vec![trimmed]
    }
}

fn strip_quotes(spec: &str) -> String {
    let spec = spec.trim();
    let bytes = spec.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        let quoted = matches!(first, b'"' | b'\'' | b'`') && first == last;
        if quoted {
            return spec[1..spec.len() - 1].to_string();
        }
    }
    spec.to_string()
}

/// `"a.h"` / `<a.h>` → `a.h`; `#include MACRO` is not an include edge. A rule
/// may strip the delimiters itself, so the directive text decides when the
/// name arrives bare.
fn delimited_include(spec: &str, directive: &str) -> Option<String> {
    let spec = spec.trim();
    if let Some(inner) = spec
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| {
            spec.strip_prefix('<')
                .and_then(|rest| rest.strip_suffix('>'))
        })
    {
        return Some(inner.to_string());
    }
    let quoted = directive.contains('"') || directive.contains('<');
    quoted.then(|| spec.to_string())
}

/// Leading `A.b.c` run of an import spec: Scala selector braces / wildcards
/// and Swift trailing tokens are not part of the resolvable path.
fn leading_dotted_path(spec: &str) -> String {
    let spec = spec.trim();
    let mut end = 0usize;
    for (index, ch) in spec.char_indices() {
        let ok = if index == 0 {
            ch.is_ascii_alphabetic() || ch == '_'
        } else {
            ch.is_ascii_alphanumeric() || ch == '_' || ch == '.'
        };
        if !ok {
            break;
        }
        end = index + ch.len_utf8();
    }
    let path = &spec[..end];
    let path = path.strip_suffix("._").unwrap_or(path);
    path.trim_end_matches('.').to_string()
}

/// Leading `Foo.Bar` / `Foo.{Bar, Baz}` alias of an Elixir import argument.
fn leading_elixir_alias(spec: &str) -> &str {
    let spec = spec.trim();
    if !spec.starts_with(|ch: char| ch.is_ascii_uppercase()) {
        return "";
    }
    let bytes = spec.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.' {
            index += 1;
            continue;
        }
        if byte == b'{' {
            if let Some(close) = spec[index..].find('}') {
                return &spec[..index + close + 1];
            }
        }
        break;
    }
    &spec[..index]
}

/// `A\{B, C}` → `A\B`, `A\C`; a plain spec passes through.
pub fn expand_php_use_spec(spec: &str) -> Vec<String> {
    let spec = spec.trim();
    let Some(open) = spec.find('{') else {
        return vec![spec.to_string()];
    };
    let prefix = spec[..open].trim().trim_end_matches('\\');
    let inner = spec[open + 1..].trim().trim_end_matches('}').trim();
    inner
        .split(',')
        .filter_map(|part| {
            let mut name = part.trim();
            if let Some(index) = name.find(" as ") {
                name = name[..index].trim();
            }
            if name.is_empty() || name == "*" {
                return None;
            }
            Some(if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}\\{name}")
            })
        })
        .collect()
}

/// `Foo.{Bar, Baz}` → `Foo.Bar`, `Foo.Baz`; a plain alias passes through.
pub fn expand_elixir_alias_spec(spec: &str) -> Vec<String> {
    let spec = spec.trim();
    let Some(open) = spec.find('{') else {
        return vec![spec.to_string()];
    };
    let prefix = spec[..open].trim().trim_end_matches('.');
    let inner = spec[open + 1..].trim().trim_end_matches('}').trim();
    inner
        .split(',')
        .filter_map(|part| {
            let name = part.trim();
            if name.is_empty() || name == "*" {
                return None;
            }
            Some(if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}.{name}")
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::outline::test_support::imports;

    #[test]
    fn import_specs_keep_the_resolver_contract() {
        assert_eq!(
            imports(
                "javascript",
                "js",
                "import a from './a.js';\nexport { b } from './b.js';\nconst c = require('node:fs');\nconst d = await import('./d.js');\n"
            ),
            vec!["./a.js", "./b.js", "node:fs", "./d.js"]
        );
        assert_eq!(
            imports(
                "python",
                "py",
                "from __future__ import annotations\nimport os, sys\nimport a.b.c as abc\nfrom pkg.sub import thing\nfrom .rel import other\n"
            ),
            vec!["__future__", "os", "sys", "a.b.c", "pkg.sub", ".rel"]
        );
        assert_eq!(
            imports(
                "go",
                "go",
                "package p\nimport \"fmt\"\nimport (\n\t\"errors\"\n)\n"
            ),
            vec!["fmt", "errors"]
        );
        assert_eq!(
            imports(
                "rust",
                "rs",
                "use std::fmt;\npub use crate::api::X;\nmod helpers;\nmod inline { }\n"
            ),
            vec!["std::fmt", "mod::helpers"]
        );
        assert_eq!(
            imports(
                "java",
                "java",
                "import static java.util.Collections.emptyList;\nimport java.util.List;\n"
            ),
            vec!["static java.util.Collections.emptyList", "java.util.List"]
        );
        assert_eq!(
            imports("kotlin", "kt", "import a.b.C as D\nimport a.b.E\n"),
            vec!["a.b.C as D", "a.b.E"]
        );
        assert_eq!(
            imports("csharp", "cs", "using System;\nusing static System.Math;\nusing Alias = System.Text.StringBuilder;\n"),
            vec!["System", "static System.Math", "Alias = System.Text.StringBuilder"]
        );
        assert_eq!(
            imports(
                "c",
                "c",
                "#include <stdio.h>\n#include \"local.h\"\n#include MACRO\n"
            ),
            vec!["stdio.h", "local.h"]
        );
        assert_eq!(
            imports("ruby", "rb", "require 'json'\nrequire_relative 'helper'\n"),
            vec!["json", "helper"]
        );
        assert_eq!(
            imports(
                "php",
                "php",
                "<?php\nuse App\\User;\nuse App\\{Post, Comment};\nrequire 'helpers.php';\n"
            ),
            vec!["App\\User", "App\\Post", "App\\Comment", "helpers.php"]
        );
        assert_eq!(
            imports(
                "swift",
                "swift",
                "import Foundation\nimport class UIKit.UIView\n"
            ),
            vec!["Foundation", "UIKit.UIView"]
        );
        assert_eq!(
            imports(
                "scala",
                "scala",
                "import a.b.C\nimport a.b.{D, E}\nimport a.b._\n"
            ),
            vec!["a.b.C", "a.b"]
        );
        assert_eq!(
            imports("bash", "sh", "source ./lib/a.sh\n. ./lib/b.sh\n"),
            vec!["./lib/a.sh", "./lib/b.sh"]
        );
        assert_eq!(
            imports(
                "lua",
                "lua",
                "local a = require('x.y')\nlocal b = require \"z\"\n"
            ),
            vec!["x.y", "z"]
        );
        assert_eq!(
            imports(
                "dart",
                "dart",
                "import 'package:m/a.dart';\nexport 'b.dart';\npart 'c.dart';\n"
            ),
            vec!["package:m/a.dart", "b.dart", "c.dart"]
        );
        assert_eq!(
            imports(
                "objc",
                "m",
                "#import <Foundation/Foundation.h>\n#import \"Store.h\"\n@import UIKit;\n"
            ),
            vec!["Foundation/Foundation.h", "Store.h", "UIKit"]
        );
        assert_eq!(
            imports(
                "elixir",
                "ex",
                "defmodule M do\n  alias A.B\n  alias A.{C, D}\n  import E\nend\n"
            ),
            vec!["A.B", "A.C", "A.D", "E"]
        );
        assert_eq!(
            imports(
                "zig",
                "zig",
                "const std = @import(\"std\");\nconst h = @import(\"./h.zig\");\n"
            ),
            vec!["std", "./h.zig"]
        );
        assert_eq!(
            imports(
                "r",
                "r",
                "library(dplyr)\nrequire(\"stringr\")\nsource(\"./h.R\")\n"
            ),
            vec!["dplyr", "stringr", "./h.R"]
        );
    }
}
