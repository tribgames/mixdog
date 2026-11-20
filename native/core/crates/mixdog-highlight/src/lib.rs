//! highlight.js 10.7.3 and cli-highlight 2.1.11, in Rust.
//!
//! `highlight` and `highlight_auto` return the HTML `hljs.highlight(code, { language, ignoreIllegals }).value`
//! and `hljs.highlightAuto(code, subset).value` return; `highlight_ansi` is cli-highlight's `highlight` with a
//! theme. The language definitions are the dumped data under `languages/data`; a language that is not carried
//! is reported as unsupported by `supports_language`.

mod ansi;
mod engine;
mod languages;

pub use ansi::{HighlightTheme, SgrPair, SgrStyle, colorize};
pub use engine::{HighlightError, HighlightResult};

use engine::Engine;

thread_local! {
    /// Compiling is per thread: a compiled language keeps mutable matcher state, as in Node's single thread.
    static ENGINE: Engine = Engine::new();
}

/// `hljs.highlight(code, { language, ignoreIllegals })`.
pub fn highlight(code: &str, language: &str, ignore_illegals: bool) -> Result<HighlightResult, HighlightError> {
    ENGINE.with(|engine| engine.highlight(code, language, ignore_illegals))
}

/// `hljs.highlightAuto(code, languageSubset)`; without a subset every carried language is tried.
pub fn highlight_auto(code: &str, subset: Option<&[&str]>) -> Result<HighlightResult, HighlightError> {
    ENGINE.with(|engine| engine.highlight_auto(code, subset))
}

/// `hljs.getLanguage(name)` as `cli-highlight`'s `supportsLanguage` asks it: a name or an alias, in any case.
pub fn supports_language(name: &str) -> bool {
    ENGINE.with(|engine| engine.supports_language(name))
}

/// `hljs.listLanguages()` restricted to the carried languages, in registration order.
pub fn list_languages() -> Vec<String> {
    ENGINE.with(Engine::list_languages)
}

/// cli-highlight's `highlight(code, { language, theme, ignoreIllegals })`; an empty language detects one
/// (`hljs.highlightAuto(code)`), as cli-highlight does when `options.language` is falsy.
pub fn highlight_ansi(code: &str, language: &str, theme: &HighlightTheme, ignore_illegals: bool) -> Result<String, HighlightError> {
    let result = if language.is_empty() { highlight_auto(code, None)? } else { highlight(code, language, ignore_illegals)? };
    Ok(colorize(&result.value, theme))
}
