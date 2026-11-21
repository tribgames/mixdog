//! The functions a language definition holds, ported by hand: the `on:begin` / `on:end` callbacks and the
//! compiler extension of highlight.js 10.7.3. The data names them by id (`{"cb": "<id>"}`); the dump fails on a
//! function that is not in this table.

use super::callbacks_extra;
use super::{Raw, RawObject};
use crate::engine::compile::{Compiler, Extension};
use crate::engine::{Hook, MatchView, Response};

/// The hook of an id, from this table or from `callbacks_extra`.
pub(crate) fn hook(id: &str) -> Option<Hook> {
    match id {
        "shebang" => Some(shebang),
        "endSameAsBeginBegin" => Some(end_same_as_begin_begin),
        "endSameAsBeginEnd" => Some(end_same_as_begin_end),
        "isTrulyOpeningTag" => Some(is_truly_opening_tag),
        "skipIfHasPrecedingDot" => Some(skip_if_has_preceding_dot),
        other => callbacks_extra::hook(other),
    }
}

/// The compiler extension of an id.
pub(crate) fn extension(id: &str) -> Option<Extension> {
    match id {
        "beforeMatch" => Some(before_match),
        other => callbacks_extra::extension(other),
    }
}

/// `SHEBANG`'s `on:begin`: only a `#!` at the very start of the text is a shebang.
fn shebang(m: &MatchView<'_>, response: &mut Response<'_>) {
    if m.index != 0 {
        response.ignore_match();
    }
}

/// `END_SAME_AS_BEGIN`'s `on:begin`: remember the first group.
fn end_same_as_begin_begin(m: &MatchView<'_>, response: &mut Response<'_>) {
    response.data.begin_match = m.group(1).map(<[u16]>::to_vec);
}

/// `END_SAME_AS_BEGIN`'s `on:end`: the end must repeat what the begin captured.
fn end_same_as_begin_end(m: &MatchView<'_>, response: &mut Response<'_>) {
    if response.data.begin_match.as_deref() != m.group(1) {
        response.ignore_match();
    }
}

/// `skipIfhasPrecedingDot`: a keyword after a dot is a property name.
fn skip_if_has_preceding_dot(m: &MatchView<'_>, response: &mut Response<'_>) {
    if m.index > 0 && m.input[m.index - 1] == u16::from(b'.') {
        response.ignore_match();
    }
}

/// `isTrulyOpeningTag` of javascript.js: `<Name` is a JSX tag when what follows is not another `<` and, for
/// `>`, a closing tag `</Name` exists later in the text.
fn is_truly_opening_tag(m: &MatchView<'_>, response: &mut Response<'_>) {
    let after = m.index + m.lexeme().len();
    match m.input.get(after) {
        Some(&next) if next == u16::from(b'<') => response.ignore_match(),
        Some(&next) if next == u16::from(b'>') => {
            // "</" + match[0].slice(1)
            let mut tag: Vec<u16> = "</".encode_utf16().collect();
            tag.extend_from_slice(m.lexeme().get(1..).unwrap_or(&[]));
            let found = m.input.get(after..).is_some_and(|rest| rest.windows(tag.len()).any(|w| w == tag.as_slice()));
            if !found {
                response.ignore_match();
            }
        }
        _ => {}
    }
}

fn source_of(value: Option<&Raw>) -> &str {
    value.and_then(Raw::source).unwrap_or("")
}

/// r.js's compiler extension: a mode with `beforeMatch` begins at `[beforeMatch][begin]`, and the mode itself
/// moves into a `starts` of the begin that ends with its parent.
fn before_match(compiler: &mut Compiler, id: usize, _parent: Option<usize>) -> Result<(), String> {
    let Some(before) = compiler.nodes[id].truthy("beforeMatch").cloned() else {
        return Ok(());
    };
    if compiler.nodes[id].truthy("starts").is_some() {
        return Err("beforeMatch cannot be used with starts".to_string());
    }
    let mut original = compiler.nodes[id].clone();
    original.frozen = false;
    compiler.nodes[id].fields.clear();

    let begin = format!("{}(?={})", source_of(Some(&before)), source_of(original.get("begin")));
    original.set("endsParent", Raw::Bool(true));
    original.remove("beforeMatch");
    let original_id = compiler.new_node(original);
    let starts =
        RawObject { frozen: false, fields: vec![("relevance".to_string(), Raw::Num(0.0)), ("contains".to_string(), Raw::Arr(vec![Raw::Obj(original_id)]))] };
    let starts_id = compiler.new_node(starts);
    let node = &mut compiler.nodes[id];
    node.set("begin", Raw::Str(begin));
    node.set("starts", Raw::Obj(starts_id));
    node.set("relevance", Raw::Num(0.0));
    Ok(())
}
