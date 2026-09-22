// The single language registry.
//
// Scan uses ast-grep's 28 builtin grammars plus objc / zig / r, which are
// implemented here on top of the tree-sitter grammar crates mixdog-graph
// links directly — 31 scan languages in total.
//
// `LANG_INFOS` is the one table both capabilities read:
//   * `extensions`      — every extension the ast-grep scan accepts.
//   * `extract_extensions` — the subset that makes a file a GRAPH SOURCE
//     file (walk / --files / --manifest / tokens / imports / symbols). Empty
//     means the language is scan-only, which is how json/yaml/markdown/css/
//     html/nix stay out of the graph even though ast-grep can parse them
//     (markdown even ships a default outline rule).
//   * `scan` — ast-grep rules can run.
//
// A language is an EXTRACTION language when it has extraction extensions AND
// at least one outline rule is loaded for it (`outline::has_rules`), so the
// extraction registry follows the rule bundle: solidity/haskell/hcl join the
// moment `rules/outline/*.yml` covers them, and a language whose rules are
// removed stops producing graph nodes instead of silently producing none.
//
// Extension → scan language differs from `lang_for` in one place: `.tsx` is
// parsed with ast-grep's `tsx` grammar (TSX and TypeScript are separate
// tree-sitter grammars and a TSX file does not parse as TypeScript), whereas
// the graph folds both into the `typescript` language id.
//
// `language:` in a rule YAML accepts the ast-grep names (`TypeScript`, `Tsx`,
// `CSharp`, `Php`, `Cpp`, `Markdown`, …), every ast-grep alias (`ts`, `cs`,
// `md`, …) and our own lowercase ids — including `objc` / `objectivec` /
// `objective-c`, `zig` and `r` — case-insensitively.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::str::FromStr;
use std::sync::LazyLock;

use ast_grep_core::language::Language;
use ast_grep_core::matcher::{Pattern, PatternBuilder, PatternError};
use ast_grep_core::meta_var::MetaVariable;
use ast_grep_core::tree_sitter::{LanguageExt, StrDoc, TSLanguage};
use ast_grep_language::SupportLang;
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer};

// ast-grep replaces the `$` of a meta variable with an "expando" char before
// handing the pattern to tree-sitter, because most grammars reject `$` as an
// identifier character. This mirrors ast-grep-language's private helper: a run
// of `$` becomes the expando char when it introduces a named meta variable
// (`$A`, `$$A`, `$$$A`) or an anonymous multi meta variable (`$$$`).
fn pre_process_pattern(expando: char, query: &str) -> Cow<'_, str> {
    let mut ret = Vec::with_capacity(query.len());
    let mut dollar_count = 0;
    for c in query.chars() {
        if c == '$' {
            dollar_count += 1;
            continue;
        }
        let need_replace = matches!(c, 'A'..='Z' | '_') || dollar_count == 3;
        let sigil = if need_replace { expando } else { '$' };
        ret.extend(std::iter::repeat_n(sigil, dollar_count));
        dollar_count = 0;
        ret.push(c);
    }
    let sigil = if dollar_count == 3 { expando } else { '$' };
    ret.extend(std::iter::repeat_n(sigil, dollar_count));
    Cow::Owned(ret.into_iter().collect())
}

// One custom language = grammar + expando char. The expando char must be a
// valid identifier character in the grammar, otherwise every meta variable
// pattern fails to parse (see the per-language tests in scan.rs).
macro_rules! custom_lang {
    ($lang:ident, $grammar:path, $expando:expr) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub struct $lang;

        impl Language for $lang {
            fn kind_to_id(&self, kind: &str) -> u16 {
                self.get_ts_language().id_for_node_kind(kind, true)
            }
            fn field_to_id(&self, field: &str) -> Option<u16> {
                self.get_ts_language()
                    .field_id_for_name(field)
                    .map(|f| f.get())
            }
            fn expando_char(&self) -> char {
                $expando
            }
            fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
                pre_process_pattern(self.expando_char(), query)
            }
            fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
                builder.build(|src| StrDoc::try_new(src, *self))
            }
        }

        impl LanguageExt for $lang {
            fn get_ts_language(&self) -> TSLanguage {
                $grammar.into()
            }
        }
    };
}

// Objective-C: the grammar accepts `$` inside identifiers (a GCC/Clang
// extension the tree-sitter-objc lexer keeps), so no expando is needed.
custom_lang!(ObjC, tree_sitter_objc::LANGUAGE, '$');
// Zig identifiers are ASCII-only, so a non-ASCII expando cannot work.
// `_` is a valid identifier start and the pattern text is never written out.
custom_lang!(Zig, tree_sitter_zig::LANGUAGE, '_');
// R identifiers accept unicode letters; `µ` keeps `$` free for R's own
// list-index operator (`x$field`) which is common in patterns.
custom_lang!(R, tree_sitter_r::LANGUAGE, 'µ');

/// Every language the `--scan` mode can parse: ast-grep's builtins plus the
/// three grammars mixdog-graph adds on top.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScanLang {
    Builtin(SupportLang),
    ObjC,
    Zig,
    R,
}

macro_rules! dispatch {
    ($me:expr, $method:ident $(, $arg:expr)*) => {
        match $me {
            ScanLang::Builtin(lang) => lang.$method($($arg),*),
            ScanLang::ObjC => ObjC.$method($($arg),*),
            ScanLang::Zig => Zig.$method($($arg),*),
            ScanLang::R => R.$method($($arg),*),
        }
    };
}

impl Language for ScanLang {
    fn kind_to_id(&self, kind: &str) -> u16 {
        dispatch!(self, kind_to_id, kind)
    }
    fn field_to_id(&self, field: &str) -> Option<u16> {
        dispatch!(self, field_to_id, field)
    }
    fn meta_var_char(&self) -> char {
        dispatch!(self, meta_var_char)
    }
    fn expando_char(&self) -> char {
        dispatch!(self, expando_char)
    }
    fn extract_meta_var(&self, source: &str) -> Option<MetaVariable> {
        dispatch!(self, extract_meta_var, source)
    }
    fn pre_process_pattern<'q>(&self, query: &'q str) -> Cow<'q, str> {
        dispatch!(self, pre_process_pattern, query)
    }
    // Patterns are parsed as `ScanLang` documents so the meta-variable
    // extraction used while building the pattern is this enum's, not the
    // inner language's (they agree, but the doc type must be consistent).
    fn build_pattern(&self, builder: &PatternBuilder) -> Result<Pattern, PatternError> {
        builder.build(|src| StrDoc::try_new(src, *self))
    }
    fn from_path<P: AsRef<Path>>(path: P) -> Option<Self> {
        scan_lang_for_path(path.as_ref())
    }
}

impl LanguageExt for ScanLang {
    fn get_ts_language(&self) -> TSLanguage {
        dispatch!(self, get_ts_language)
    }
}

impl ScanLang {
    /// Stable id used in `--scan` output and in `--langs`.
    pub fn id(&self) -> &'static str {
        match self {
            ScanLang::ObjC => "objc",
            ScanLang::Zig => "zig",
            ScanLang::R => "r",
            ScanLang::Builtin(lang) => support_lang_id(*lang),
        }
    }
}

impl fmt::Display for ScanLang {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

/// `language:` in rule YAML accepts our ids plus every ast-grep alias
/// (`ts`, `cs`, `md`, `objective-c`, …), case-insensitively.
impl FromStr for ScanLang {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        for (alias, lang) in CUSTOM_ALIASES {
            if s.eq_ignore_ascii_case(alias) {
                return Ok(*lang);
            }
        }
        SupportLang::from_str(s)
            .map(ScanLang::Builtin)
            .map_err(|_| format!("unsupported language `{s}`"))
    }
}

impl<'de> Deserialize<'de> for ScanLang {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ScanLangVisitor;
        impl Visitor<'_> for ScanLangVisitor {
            type Value = ScanLang;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an ast-grep language name")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                ScanLang::from_str(v).map_err(de::Error::custom)
            }
        }
        deserializer.deserialize_str(ScanLangVisitor)
    }
}

const CUSTOM_ALIASES: &[(&str, ScanLang)] = &[
    ("objc", ScanLang::ObjC),
    ("objectivec", ScanLang::ObjC),
    ("objective-c", ScanLang::ObjC),
    ("zig", ScanLang::Zig),
    ("r", ScanLang::R),
];

fn support_lang_id(lang: SupportLang) -> &'static str {
    use SupportLang as S;
    match lang {
        S::Bash => "bash",
        S::C => "c",
        S::Cpp => "cpp",
        S::CSharp => "csharp",
        S::Css => "css",
        S::Dart => "dart",
        S::Elixir => "elixir",
        S::Go => "go",
        S::Haskell => "haskell",
        S::Hcl => "hcl",
        S::Html => "html",
        S::Java => "java",
        S::JavaScript => "javascript",
        S::Json => "json",
        S::Kotlin => "kotlin",
        S::Lua => "lua",
        S::Markdown => "markdown",
        S::Nix => "nix",
        S::Php => "php",
        S::Python => "python",
        S::Ruby => "ruby",
        S::Rust => "rust",
        S::Scala => "scala",
        S::Solidity => "solidity",
        S::Swift => "swift",
        S::Tsx => "tsx",
        S::TypeScript => "typescript",
        S::Yaml => "yaml",
    }
}

/// Scan language for a file extension. The extension is matched
/// case-insensitively (`.R` and `.r` are both R).
pub fn scan_lang_for_ext(ext: &str) -> Option<ScanLang> {
    use SupportLang as S;
    let lowered = ext.to_ascii_lowercase();
    let builtin = match lowered.as_str() {
        "js" | "mjs" | "cjs" | "jsx" => S::JavaScript,
        "ts" | "mts" | "cts" => S::TypeScript,
        "tsx" => S::Tsx,
        "py" | "pyi" | "py3" | "bzl" | "bazel" => S::Python,
        "go" => S::Go,
        "rs" => S::Rust,
        "java" => S::Java,
        "kt" | "kts" | "ktm" => S::Kotlin,
        "cs" => S::CSharp,
        "rb" | "rbw" | "gemspec" => S::Ruby,
        "php" => S::Php,
        "swift" => S::Swift,
        "c" | "h" => S::C,
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" | "c++" | "cu" | "ino" => S::Cpp,
        "scala" | "sc" | "sbt" => S::Scala,
        "sh" | "bash" | "zsh" | "bats" | "cgi" | "command" | "env" | "fcgi" | "ksh" | "tmux"
        | "tool" => S::Bash,
        "lua" => S::Lua,
        "dart" => S::Dart,
        "ex" | "exs" => S::Elixir,
        "css" | "scss" => S::Css,
        "hs" => S::Haskell,
        "hcl" | "nomad" | "tf" | "tfvars" | "workflow" => S::Hcl,
        "html" | "htm" | "xhtml" => S::Html,
        "json" => S::Json,
        "md" | "markdown" => S::Markdown,
        "nix" => S::Nix,
        "sol" => S::Solidity,
        "yaml" | "yml" => S::Yaml,
        "m" | "mm" => return Some(ScanLang::ObjC),
        "zig" => return Some(ScanLang::Zig),
        "r" => return Some(ScanLang::R),
        _ => return None,
    };
    Some(ScanLang::Builtin(builtin))
}

pub fn scan_lang_for_path(path: &Path) -> Option<ScanLang> {
    path.extension()
        .and_then(|ext| ext.to_str())
        .and_then(scan_lang_for_ext)
}

/// One row of the registry (and of `--langs`). `extensions` is every
/// extension ast-grep can parse for this language; `extract_extensions` is
/// the subset that makes a file a graph source file.
pub struct LangInfo {
    pub id: &'static str,
    pub extensions: &'static [&'static str],
    pub extract_extensions: &'static [&'static str],
    pub scan: bool,
}

impl LangInfo {
    /// Extraction capability: graph extensions plus loaded outline rules.
    pub fn extract(&self) -> bool {
        !self.extract_extensions.is_empty() && crate::outline::has_rules(self.id)
    }
}

/// The merged registry: the graph languages first, then the scan-only ones.
/// Every entry is scannable today.
pub const LANG_INFOS: &[LangInfo] = &[
    LangInfo {
        id: "javascript",
        extensions: &["js", "mjs", "cjs", "jsx"],
        extract_extensions: &["js", "mjs", "cjs", "jsx"],
        scan: true,
    },
    LangInfo {
        id: "typescript",
        extensions: &["ts", "tsx", "mts", "cts"],
        extract_extensions: &["ts", "tsx", "mts", "cts"],
        scan: true,
    },
    LangInfo {
        id: "python",
        extensions: &["py", "pyi", "py3", "bzl", "bazel"],
        extract_extensions: &["py", "pyi"],
        scan: true,
    },
    LangInfo {
        id: "go",
        extensions: &["go"],
        extract_extensions: &["go"],
        scan: true,
    },
    LangInfo {
        id: "rust",
        extensions: &["rs"],
        extract_extensions: &["rs"],
        scan: true,
    },
    LangInfo {
        id: "java",
        extensions: &["java"],
        extract_extensions: &["java"],
        scan: true,
    },
    LangInfo {
        id: "kotlin",
        extensions: &["kt", "kts", "ktm"],
        extract_extensions: &["kt", "kts"],
        scan: true,
    },
    LangInfo {
        id: "csharp",
        extensions: &["cs"],
        extract_extensions: &["cs"],
        scan: true,
    },
    LangInfo {
        id: "ruby",
        extensions: &["rb", "rbw", "gemspec"],
        extract_extensions: &["rb"],
        scan: true,
    },
    LangInfo {
        id: "php",
        extensions: &["php"],
        extract_extensions: &["php"],
        scan: true,
    },
    LangInfo {
        id: "swift",
        extensions: &["swift"],
        extract_extensions: &["swift"],
        scan: true,
    },
    LangInfo {
        id: "c",
        extensions: &["c", "h"],
        extract_extensions: &["c", "h"],
        scan: true,
    },
    LangInfo {
        id: "cpp",
        extensions: &["cpp", "cc", "cxx", "hpp", "hxx", "hh", "c++", "cu", "ino"],
        extract_extensions: &["cpp", "cc", "cxx", "hpp", "hxx", "hh"],
        scan: true,
    },
    LangInfo {
        id: "scala",
        extensions: &["scala", "sc", "sbt"],
        extract_extensions: &["scala", "sc"],
        scan: true,
    },
    LangInfo {
        id: "bash",
        extensions: &[
            "sh", "bash", "zsh", "bats", "cgi", "command", "env", "fcgi", "ksh", "tmux", "tool",
        ],
        extract_extensions: &["sh", "bash", "zsh"],
        scan: true,
    },
    LangInfo {
        id: "lua",
        extensions: &["lua"],
        extract_extensions: &["lua"],
        scan: true,
    },
    LangInfo {
        id: "dart",
        extensions: &["dart"],
        extract_extensions: &["dart"],
        scan: true,
    },
    LangInfo {
        id: "objc",
        extensions: &["m", "mm"],
        extract_extensions: &["m", "mm"],
        scan: true,
    },
    LangInfo {
        id: "elixir",
        extensions: &["ex", "exs"],
        extract_extensions: &["ex", "exs"],
        scan: true,
    },
    LangInfo {
        id: "zig",
        extensions: &["zig"],
        extract_extensions: &["zig"],
        scan: true,
    },
    LangInfo {
        id: "r",
        extensions: &["r", "R"],
        extract_extensions: &["r", "R"],
        scan: true,
    },
    LangInfo {
        id: "solidity",
        extensions: &["sol"],
        extract_extensions: &["sol"],
        scan: true,
    },
    LangInfo {
        id: "haskell",
        extensions: &["hs"],
        extract_extensions: &["hs"],
        scan: true,
    },
    LangInfo {
        id: "hcl",
        extensions: &["hcl", "nomad", "tf", "tfvars", "workflow"],
        extract_extensions: &["hcl", "tf", "tfvars"],
        scan: true,
    },
    // Never graph source files: a data/markup language has no symbol or
    // import contract here, and markdown is excluded on purpose even though
    // ast-grep ships a default outline rule for it.
    LangInfo {
        id: "css",
        extensions: &["css", "scss"],
        extract_extensions: &[],
        scan: true,
    },
    LangInfo {
        id: "html",
        extensions: &["html", "htm", "xhtml"],
        extract_extensions: &[],
        scan: true,
    },
    LangInfo {
        id: "json",
        extensions: &["json"],
        extract_extensions: &[],
        scan: true,
    },
    LangInfo {
        id: "markdown",
        extensions: &["markdown", "md"],
        extract_extensions: &[],
        scan: true,
    },
    LangInfo {
        id: "nix",
        extensions: &["nix"],
        extract_extensions: &[],
        scan: true,
    },
    LangInfo {
        id: "tsx",
        extensions: &["tsx"],
        extract_extensions: &[],
        scan: true,
    },
    LangInfo {
        id: "yaml",
        extensions: &["yaml", "yml"],
        extract_extensions: &[],
        scan: true,
    },
];

/// Every `(extension, graph language id)` pair that makes a file a graph
/// source file, in registry order: one definition for the lookup map and the
/// classifier pattern below.
fn graph_source_extensions() -> impl Iterator<Item = (&'static str, &'static str)> {
    LANG_INFOS
        .iter()
        .filter(|info| info.extract())
        .flat_map(|info| {
            info.extract_extensions
                .iter()
                .map(move |extension| (*extension, info.id))
        })
}

/// Graph language id for a source extension, or `None` when the extension is
/// not a graph source file. Case-sensitive, like the extension table.
pub fn graph_lang_for_ext(ext: &str) -> Option<&'static str> {
    static BY_EXT: LazyLock<HashMap<&'static str, &'static str>> =
        LazyLock::new(|| graph_source_extensions().collect());
    BY_EXT.get(ext).copied()
}

/// Interned graph language id, or `""` when the name is not a graph language
/// (a scan-only language, or one whose outline rules are gone).
pub fn graph_lang_id(name: &str) -> &'static str {
    LANG_INFOS
        .iter()
        .find(|info| info.id == name && info.extract())
        .map(|info| info.id)
        .unwrap_or("")
}

/// Every grammar a graph language is parsed with. `typescript` has two (a
/// `.tsx` file does not parse with the TypeScript grammar and vice versa).
pub fn graph_lang_scan_langs(graph_lang: &str) -> Vec<ScanLang> {
    let Some(info) = LANG_INFOS.iter().find(|info| info.id == graph_lang) else {
        return Vec::new();
    };
    let mut langs = Vec::new();
    for extension in info.extract_extensions {
        if let Some(lang) = scan_lang_for_ext(extension) {
            if !langs.contains(&lang) {
                langs.push(lang);
            }
        }
    }
    langs
}

/// Graph source extensions as a regex alternation, for path classifiers.
pub fn source_extension_pattern() -> &'static str {
    static PATTERN: LazyLock<String> = LazyLock::new(|| {
        let mut extensions: Vec<&str> = Vec::new();
        for (extension, _) in graph_source_extensions() {
            if !extensions.contains(&extension) {
                extensions.push(extension);
            }
        }
        format!(r"\.({})$", extensions.join("|"))
    });
    &PATTERN
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lang::languages as extract_languages;

    #[test]
    fn registry_covers_every_scan_and_extract_language() {
        assert_eq!(LANG_INFOS.len(), 31);
        assert_eq!(LANG_INFOS.iter().filter(|l| l.scan).count(), 31);
        // Extraction is rule-driven: a language with graph extensions is a
        // graph language exactly while outline rules exist for it.
        for info in LANG_INFOS {
            assert_eq!(
                info.extract(),
                !info.extract_extensions.is_empty() && crate::outline::has_rules(info.id),
                "{} extract flag must follow the rule bundle",
                info.id
            );
        }
        // The 21 pre-Stage-2 graph languages must never drop out.
        for lang in [
            "javascript",
            "typescript",
            "python",
            "go",
            "rust",
            "java",
            "kotlin",
            "csharp",
            "ruby",
            "php",
            "swift",
            "c",
            "cpp",
            "scala",
            "bash",
            "lua",
            "dart",
            "objc",
            "elixir",
            "zig",
            "r",
        ] {
            assert!(
                extract_languages().contains(&lang),
                "{lang} must stay a graph language"
            );
        }
        // Data/markup languages never become graph source files, markdown
        // included (ast-grep ships a default outline rule for it).
        for lang in ["markdown", "json", "yaml", "css", "html", "nix", "tsx"] {
            assert!(
                !extract_languages().contains(&lang),
                "{lang} must stay scan-only"
            );
            for info in LANG_INFOS.iter().filter(|info| info.id == lang) {
                assert!(info.extract_extensions.is_empty());
            }
        }
        // every extraction language id is present and flagged
        for lang in extract_languages() {
            let info = LANG_INFOS
                .iter()
                .find(|l| l.id == lang)
                .unwrap_or_else(|| panic!("missing registry entry for {lang}"));
            assert!(info.extract(), "{lang} must be flagged extract");
        }
        // every ast-grep builtin id is present
        for lang in SupportLang::all_langs() {
            let id = support_lang_id(*lang);
            assert!(
                LANG_INFOS.iter().any(|l| l.id == id),
                "missing registry entry for {id}"
            );
        }
    }

    #[test]
    fn every_registry_extension_resolves_to_its_language() {
        for info in LANG_INFOS {
            for ext in info.extensions {
                let lang =
                    scan_lang_for_ext(ext).unwrap_or_else(|| panic!("{ext} has no scan language"));
                // `.tsx` is the one documented divergence: extraction calls it
                // typescript, scan parses it with the tsx grammar.
                let expected = if *ext == "tsx" { "tsx" } else { info.id };
                assert_eq!(lang.id(), expected, "extension {ext}");
            }
        }
    }

    #[test]
    fn language_aliases_parse() {
        assert_eq!(
            ScanLang::from_str("typescript").unwrap(),
            ScanLang::Builtin(SupportLang::TypeScript)
        );
        assert_eq!(
            ScanLang::from_str("TSX").unwrap(),
            ScanLang::Builtin(SupportLang::Tsx)
        );
        assert_eq!(ScanLang::from_str("objective-c").unwrap(), ScanLang::ObjC);
        assert_eq!(ScanLang::from_str("Zig").unwrap(), ScanLang::Zig);
        assert_eq!(ScanLang::from_str("R").unwrap(), ScanLang::R);
        assert!(ScanLang::from_str("cobol").is_err());
    }
}
