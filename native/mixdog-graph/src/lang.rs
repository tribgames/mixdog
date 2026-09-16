// Graph-language view of the registry in `scan_lang.rs`.
//
// Extension → language id and interned names derive from `LANG_INFOS`, so a
// language exists here exactly when the registry says it has graph extensions
// AND outline rules. Adding a language starts in `scan_lang.rs` plus a rule
// file.
//
// There is no comment/string masking layer any more: tokens, symbols and the
// standalone symbol search all read the parse tree, where a comment or a
// string body simply is not an identifier node.

use crate::scan_lang::{self, LANG_INFOS};

/// Every language that produces graph nodes right now.
#[allow(dead_code)]
pub fn languages() -> Vec<&'static str> {
    LANG_INFOS
        .iter()
        .filter(|info| info.extract())
        .map(|info| info.id)
        .collect()
}

/// Source extensions the dependents path-classifier should treat as files.
#[allow(dead_code)]
pub fn source_extension_pattern() -> &'static str {
    scan_lang::source_extension_pattern()
}

pub fn lang_static(name: &str) -> &'static str {
    scan_lang::graph_lang_id(name)
}

pub fn lang_for(ext: &str) -> Option<&'static str> {
    scan_lang::graph_lang_for_ext(ext)
}
