//! Hooks of the languages highlight.js 10.7.3 carries beyond the core set: the table `callbacks` consults after
//! its own. Only mathematica has one: the `on:begin` of its `builtin-symbol` variant.

use std::collections::HashSet;
use std::sync::OnceLock;

use crate::engine::compile::Extension;
use crate::engine::{Hook, MatchView, Response};

/// The system symbols of mathematica.js (`SYSTEM_SYMBOLS`), one per line.
const SYSTEM_SYMBOLS: &str = include_str!("data_extra/mathematica-symbols.txt");

/// The hook of an id.
pub(crate) fn hook(id: &str) -> Option<Hook> {
    match id {
        "mathematicaBuiltinSymbol" => Some(mathematica_builtin_symbol),
        _ => None,
    }
}

/// The compiler extension of an id: none beyond the one of `callbacks`.
pub(crate) fn extension(_id: &str) -> Option<Extension> {
    None
}

fn system_symbols() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| SYSTEM_SYMBOLS.lines().filter(|l| !l.is_empty()).collect())
}

/// mathematica's `on:begin`: `if (!SYSTEM_SYMBOLS_SET.has(match[0])) response.ignoreMatch()`. A symbol is
/// ASCII (`[a-zA-Z$][a-zA-Z0-9$]*`), so a lexeme with any other unit is not in the set.
fn mathematica_builtin_symbol(m: &MatchView<'_>, response: &mut Response<'_>) {
    let known = String::from_utf16(m.lexeme()).is_ok_and(|symbol| system_symbols().contains(symbol.as_str()));
    if !known {
        response.ignore_match();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_symbol_set_holds_the_system_symbols() {
        let set = system_symbols();
        assert!(set.len() > 6000);
        assert!(set.contains("Plot") && set.contains("AASTriangle"));
        assert!(!set.contains("myVariable"));
    }

    #[test]
    fn a_system_symbol_is_a_builtin_symbol_and_another_name_a_plain_symbol() {
        let html = crate::highlight("Plot[x, y] + myVar", "mathematica", true).expect("highlights").value;
        assert!(html.contains("<span class=\"hljs-built_in\">Plot</span>"));
        assert!(html.contains("<span class=\"hljs-variable\">myVar</span>"));
        assert!(!html.contains("hljs-built_in\">myVar"));
    }

    #[test]
    fn only_mathematica_has_a_hook() {
        assert!(hook("mathematicaBuiltinSymbol").is_some());
        assert!(hook("anythingElse").is_none());
    }
}
