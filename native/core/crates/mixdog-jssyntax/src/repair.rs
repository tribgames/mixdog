//! Sources V8 compiles that the tree-sitter grammar cannot read: the grammar has no rule for a call as the target of
//! an assignment (`f() = 1`, `for (f() of x)`; V8 compiles them and throws when they run), for a parenthesized name
//! inside a destructuring pattern (`[(a)] = b`) or for the escapes a tagged template may hold (`` f`\u` ``). Each is
//! rewritten into a source the grammar reads, and the early-error pass then judges the rewritten one: a call target
//! is wrapped in parentheses, a bad escape of a tagged template gets a letter that makes it a good one, the
//! parentheses around a name in a pattern are blanked (and remembered, a binding pattern may not hold them).

use tree_sitter::{Node, Parser, Tree};

pub(crate) struct Repaired {
    pub source: String,
    pub tree: Tree,
    /// Byte offsets of the blanked parentheses.
    pub blanked: Vec<usize>,
}

/// The repaired source and its tree, when a repair applies (the tree may still hold errors).
pub(crate) fn repair(parser: &mut Parser, source: &str, tree: &Tree) -> Option<Repaired> {
    let mut wraps: Vec<(usize, usize)> = Vec::new();
    let mut letters: Vec<usize> = Vec::new();
    collect(tree.root_node(), source, &mut wraps, &mut letters);
    let mut text = source.to_owned();
    let mut changed = false;
    if !letters.is_empty() {
        let mut bytes = text.into_bytes();
        for at in &letters {
            bytes[*at] = b'n';
        }
        text = String::from_utf8(bytes).ok()?;
        changed = true;
    }
    if !wraps.is_empty() {
        let mut points: Vec<(usize, u8)> = Vec::new();
        for (start, end) in &wraps {
            points.push((*start, b'('));
            points.push((*end, b')'));
        }
        // Later positions first, so earlier ones stay valid; at one position a `)` goes in before a `(`.
        points.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        for (at, byte) in points {
            text.insert(at, char::from(byte));
        }
        changed = true;
    }
    let mut blanked = Vec::new();
    if changed {
        let again = parser.parse(&text, None)?;
        if !again.root_node().has_error() {
            return Some(Repaired { source: text, tree: again, blanked });
        }
    }
    let (blanked_text, offsets) = blank_pattern_parens(&text);
    if !offsets.is_empty() {
        blanked = offsets;
        text = blanked_text;
        changed = true;
    }
    if !changed {
        return None;
    }
    let again = parser.parse(&text, None)?;
    if !blanked.chunks(2).all(|pair| in_pattern(again.root_node(), &text, pair)) {
        // `x = { (a) }`, `class A { (a) }`: the blanked parentheses were not around a target of a pattern, and
        // V8 rejects what the blanking made readable.
        return None;
    }
    Some(Repaired { source: text, tree: again, blanked })
}

/// The name or member chain between the blanked parentheses `pair` is an element of an array pattern, the target
/// of a rest element, the value of a property of an object pattern or the left of a default in a pattern.
fn in_pattern(root: Node<'_>, text: &str, pair: &[usize]) -> bool {
    let [open, close] = *pair else { return false };
    let inner = text.get(open + 1..close).unwrap_or("");
    let begin = open + 1 + (inner.len() - inner.trim_start().len());
    let end = close - (inner.len() - inner.trim_end().len());
    if begin >= end {
        return false;
    }
    let Some(mut node) = root.named_descendant_for_byte_range(begin, end) else { return false };
    while let Some(parent) = node.parent().filter(|p| p.start_byte() == begin && p.end_byte() == end) {
        node = parent;
    }
    if node.start_byte() != begin || node.end_byte() != end {
        return false;
    }
    let Some(parent) = node.parent() else { return false };
    let is_field = |field: &str| parent.child_by_field_name(field).is_some_and(|child| child.id() == node.id());
    match parent.kind() {
        "array_pattern" | "rest_pattern" => true,
        "pair_pattern" => is_field("value"),
        "assignment_pattern" => is_field("left"),
        _ => false,
    }
}

fn collect(node: Node<'_>, source: &str, wraps: &mut Vec<(usize, usize)>, letters: &mut Vec<usize>) {
    let mut cursor = node.walk();
    loop {
        let current = cursor.node();
        if current.kind() == "call_expression" && is_target(current, source) {
            wraps.push((current.start_byte(), current.end_byte()));
        }
        if current.kind() == "template_string" && current.has_error() && is_tagged(current) {
            bad_escapes(source, current.start_byte(), current.end_byte(), letters);
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

fn is_tagged(template: Node<'_>) -> bool {
    template.parent().is_some_and(|parent| {
        parent.kind() == "call_expression" && parent.child_by_field_name("arguments").map(|arguments| arguments.id()) == Some(template.id())
    })
}

/// A call that is followed by an assignment operator, or that stands as the left of a `for (... of|in ...)` head
/// the grammar could not read.
fn is_target(call: Node<'_>, source: &str) -> bool {
    let after = source.get(call.end_byte()..).unwrap_or("").trim_start();
    let operator = ["**=", "<<=", ">>>=", ">>=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^="].iter().any(|op| after.starts_with(op));
    let plain = after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>");
    if operator || plain {
        // The logical assignments start with two characters of their own and match none of these.
        return true;
    }
    let of_or_in = after.strip_prefix("of").or_else(|| after.strip_prefix("in"));
    if of_or_in.is_some_and(|rest| rest.starts_with(|c: char| c.is_whitespace() || c == '(' || c == '[' || c == '{')) {
        let before = source.get(..call.start_byte()).unwrap_or("").trim_end();
        if let Some(head) = before.strip_suffix('(') {
            let head = head.trim_end();
            let head = head.strip_suffix("await").map_or(head, str::trim_end);
            return head.ends_with("for");
        }
    }
    false
}

/// The offsets of the character after each backslash of a template that is no escape of a template tag.
fn bad_escapes(source: &str, start: usize, end: usize, out: &mut Vec<usize>) {
    let bytes = source.as_bytes();
    let mut at = start;
    let mut depth = 0usize;
    while at < end {
        match bytes[at] {
            b'$' if depth == 0 && bytes.get(at + 1) == Some(&b'{') => {
                depth = 1;
                at += 2;
                continue;
            }
            b'{' if depth > 0 => depth += 1,
            b'}' if depth > 0 => depth -= 1,
            b'\\' if depth == 0 => {
                let next = at + 1;
                match bytes.get(next) {
                    Some(b'u') => {
                        let rest = &bytes[next + 1..end.min(bytes.len())];
                        let braced = rest.first() == Some(&b'{');
                        let ok = if braced {
                            rest.iter().position(|b| *b == b'}').is_some_and(|close| close > 1 && rest[1..close].iter().all(u8::is_ascii_hexdigit))
                        } else {
                            rest.len() >= 4 && rest[..4].iter().all(u8::is_ascii_hexdigit)
                        };
                        if !ok {
                            out.push(next);
                        }
                    }
                    Some(b'x') => {
                        let rest = &bytes[next + 1..end.min(bytes.len())];
                        if !(rest.len() >= 2 && rest[..2].iter().all(u8::is_ascii_hexdigit)) {
                            out.push(next);
                        }
                    }
                    Some(b'1'..=b'9') => out.push(next),
                    Some(b'0') if bytes.get(next + 1).is_some_and(u8::is_ascii_digit) => out.push(next),
                    _ => {}
                }
                at += 2;
                continue;
            }
            _ => {}
        }
        at += 1;
    }
}

/// `[(a)] = b`, `({a: (b.c)} = d)`: the parentheses around a name or a member chain that sits between the
/// punctuation of a pattern are replaced by spaces.
fn blank_pattern_parens(source: &str) -> (String, Vec<usize>) {
    let bytes = source.as_bytes();
    let mut out = bytes.to_vec();
    let mut offsets = Vec::new();
    let name_start = |b: u8| b.is_ascii_alphabetic() || b == b'_' || b == b'$';
    let name_part = |b: u8| name_start(b) || b.is_ascii_digit();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'(' {
            let mut cursor = at + 1;
            while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                cursor += 1;
            }
            let begin = cursor;
            while bytes.get(cursor).is_some_and(|b| name_start(*b)) {
                cursor += 1;
                while bytes.get(cursor).is_some_and(|b| name_part(*b)) {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b'.') && bytes.get(cursor + 1).is_some_and(|b| name_start(*b)) {
                    cursor += 1;
                } else {
                    break;
                }
            }
            if cursor > begin {
                while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b')') {
                    let before = source[..at].trim_end();
                    let after = source[cursor + 1..].trim_start();
                    let opens = before.ends_with(['[', ',', ':', '{']) || before.ends_with("...");
                    let closes = after.starts_with([']', ',', '}']) || (after.starts_with('=') && !after.starts_with("==") && !after.starts_with("=>"));
                    if opens && closes {
                        out[at] = b' ';
                        out[cursor] = b' ';
                        offsets.push(at);
                        offsets.push(cursor);
                        at = cursor + 1;
                        continue;
                    }
                }
            }
        }
        at += 1;
    }
    (String::from_utf8(out).unwrap_or_else(|_| source.to_owned()), offsets)
}
