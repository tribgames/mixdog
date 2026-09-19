// Fixtures shared by the outline unit tests: one source string in, one slice
// of the extracted answer out, so each responsibility module can assert on the
// part of the pipeline it owns without restating the plumbing.

use super::rules::intern_kind;
use super::symbols::{extract, SymbolInfo};
use crate::scan_lang::scan_lang_for_ext;

/// `(kind, name, startLine)` for one source, in emission order.
pub(super) fn symbols(
    graph_lang: &str,
    ext: &str,
    source: &str,
) -> Vec<(&'static str, String, u32)> {
    let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
    extract(source, graph_lang, lang)
        .symbols
        .into_iter()
        .map(|symbol| (symbol.kind, symbol.name, symbol.start_line))
        .collect()
}

pub(super) fn kinds(graph_lang: &str, ext: &str, source: &str) -> Vec<(&'static str, String)> {
    symbols(graph_lang, ext, source)
        .into_iter()
        .map(|(kind, name, _)| (kind, name))
        .collect()
}

pub(super) fn imports(graph_lang: &str, ext: &str, source: &str) -> Vec<String> {
    let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
    extract(source, graph_lang, lang).imports
}

pub(super) fn named(pairs: &[(&str, &str)]) -> Vec<(&'static str, String)> {
    pairs
        .iter()
        .map(|(kind, name)| (intern_kind(kind), (*name).to_string()))
        .collect()
}

/// Full v2 records, in emission order.
pub(super) fn records(graph_lang: &str, ext: &str, source: &str) -> Vec<SymbolInfo> {
    let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
    extract(source, graph_lang, lang).symbols
}

pub(super) fn record<'a>(symbols: &'a [SymbolInfo], name: &str) -> &'a SymbolInfo {
    symbols
        .iter()
        .find(|symbol| symbol.name == name)
        .unwrap_or_else(|| panic!("no symbol `{name}` in {symbols:?}"))
}

pub(super) fn tokens(graph_lang: &str, ext: &str, source: &str) -> Vec<String> {
    let lang = scan_lang_for_ext(ext).expect("fixture extension has a language");
    extract(source, graph_lang, lang).tokens
}
