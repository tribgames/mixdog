// Single language registry for mixdog-graph.
// Extension → language, interned names, and comment-family used by import
// extraction / symbol search. Adding a language starts here.

#[allow(dead_code)]
pub const LANGUAGES: &[&str] = &[
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
];

/// Source extensions the dependents path-classifier should treat as files.
#[allow(dead_code)]
pub const SOURCE_EXTENSION_PATTERN: &str = r"\.(mjs|cjs|js|jsx|mts|cts|ts|tsx|json|py|pyi|go|rb|rs|java|kt|kts|c|h|cc|cpp|cxx|hpp|hxx|hh|cs|php|swift|scala|sc|sh|bash|zsh|lua|dart|m|mm|ex|exs|zig|r)$";

pub enum CommentFamily {
    Curly { mask_strings: bool },
    Hash,
    Lua,
}

pub fn lang_static(name: &str) -> &'static str {
    match name {
        "javascript" => "javascript",
        "typescript" => "typescript",
        "python" => "python",
        "go" => "go",
        "rust" => "rust",
        "java" => "java",
        "kotlin" => "kotlin",
        "csharp" => "csharp",
        "ruby" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "c" => "c",
        "cpp" => "cpp",
        "scala" => "scala",
        "bash" => "bash",
        "lua" => "lua",
        "dart" => "dart",
        "objc" => "objc",
        "elixir" => "elixir",
        "zig" => "zig",
        "r" => "r",
        _ => "",
    }
}

pub fn lang_for(ext: &str) -> Option<&'static str> {
    match ext {
        "js" | "mjs" | "cjs" | "jsx" => Some("javascript"),
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "py" | "pyi" => Some("python"),
        "go" => Some("go"),
        "rs" => Some("rust"),
        "java" => Some("java"),
        "kt" | "kts" => Some("kotlin"),
        "cs" => Some("csharp"),
        "rb" => Some("ruby"),
        "php" => Some("php"),
        "swift" => Some("swift"),
        "c" | "h" => Some("c"),
        "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh" => Some("cpp"),
        "scala" | "sc" => Some("scala"),
        "sh" | "bash" | "zsh" => Some("bash"),
        "lua" => Some("lua"),
        "dart" => Some("dart"),
        "m" | "mm" => Some("objc"),
        "ex" | "exs" => Some("elixir"),
        "zig" => Some("zig"),
        "r" | "R" => Some("r"),
        _ => None,
    }
}

/// `for_symbol_search` masks string bodies so identifiers inside literals
/// are not treated as call sites. Import extraction keeps quoted specs.
pub fn comment_family(lang: &str, for_symbol_search: bool) -> CommentFamily {
    match lang {
        "python" | "ruby" | "bash" | "elixir" | "r" => CommentFamily::Hash,
        "lua" => CommentFamily::Lua,
        "swift" => CommentFamily::Curly { mask_strings: true },
        _ => CommentFamily::Curly {
            mask_strings: for_symbol_search,
        },
    }
}
