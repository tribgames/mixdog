//! The early errors V8 raises for a classic (sloppy, non-module) script that the tree-sitter grammar accepts.
//! The walk is over a tree that has no ERROR or MISSING node. Anything the walk does not model is rejected:
//! a wrong "invalid" only keeps a `node -e` body inline, a wrong "ok" would hoist a body Node itself rejects.

use std::collections::HashMap;
use std::collections::HashSet;

use tree_sitter::Node;

use crate::message as msg;
use crate::message::Reason;
use crate::scope::ScopeKind;
use crate::scope::Scopes;

type Check = Result<(), Reason>;

/// Nesting beyond this is answered "invalid": the walk is recursive and runs on a worker's small stack.
const MAX_DEPTH: usize = 200;

const ALWAYS_RESERVED: &[&str] = &[
    "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else", "enum",
    "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof", "new", "null",
    "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with",
];

const STRICT_RESERVED: &[&str] =
    &["implements", "interface", "let", "package", "private", "protected", "public", "static", "yield"];

/// What `await` or `yield` is at a point of the code.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kw {
    /// An operator (inside an async function or a generator).
    Operator,
    /// An ordinary identifier (sloppy code outside them).
    Identifier,
    /// Neither (a class static block, the parameters of an async function, an arrow nested in an async function).
    Reserved,
}

#[derive(Clone, Copy)]
struct Cx {
    strict: bool,
    await_kw: Kw,
    yield_kw: Kw,
    in_function: bool,
    new_target: bool,
    super_prop: bool,
    super_call: bool,
    no_arguments: bool,
    breakable: bool,
    in_loop: bool,
}

impl Cx {
    fn script(strict: bool) -> Self {
        Self {
            strict,
            await_kw: Kw::Identifier,
            yield_kw: Kw::Identifier,
            in_function: false,
            new_target: false,
            super_prop: false,
            super_call: false,
            no_arguments: false,
            breakable: false,
            in_loop: false,
        }
    }

    /// The code of a class field initializer or a static block: a method-like body without `return`.
    fn initializer(self) -> Self {
        Self {
            in_function: false,
            await_kw: Kw::Reserved,
            yield_kw: Kw::Reserved,
            no_arguments: true,
            new_target: true,
            super_prop: true,
            super_call: false,
            breakable: false,
            in_loop: false,
            ..self
        }
    }

    fn looping(self) -> Self {
        Self { breakable: true, in_loop: true, ..self }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FnMode {
    /// A function declaration cannot be the statement here.
    No,
    /// The branch of an `if`: sloppy code may declare a plain function there (in a scope of its own).
    IfBranch,
    /// The body of a label.
    Labeled,
}

struct Label {
    name: String,
    is_loop: bool,
}

struct PrivEntry {
    getter: bool,
    setter: bool,
    other: bool,
    is_static: bool,
}

struct Facts {
    is_static: bool,
    is_async: bool,
    is_gen: bool,
    getter: bool,
    setter: bool,
}

fn kids(node: Node<'_>) -> Vec<Node<'_>> {
    let mut cursor = node.walk();
    node.children(&mut cursor).collect()
}

fn named_kids(node: Node<'_>) -> Vec<Node<'_>> {
    kids(node).into_iter().filter(|child| child.is_named() && child.kind() != "comment").collect()
}

fn has_child_kind(node: Node<'_>, kind: &str) -> bool {
    kids(node).iter().any(|child| child.kind() == kind)
}

fn has_line_terminator(gap: &str) -> bool {
    gap.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

fn first_duplicate(names: &[String]) -> Option<&str> {
    let mut seen = HashSet::new();
    names.iter().find(|name| !seen.insert(name.as_str())).map(String::as_str)
}

fn ident_ok(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else { return false };
    if !(first == '$' || first == '_' || unicode_ident::is_xid_start(first)) {
        return false;
    }
    chars.all(|c| c == '$' || c == '_' || c == '\u{200C}' || c == '\u{200D}' || unicode_ident::is_xid_continue(c))
}

fn check_binding_name(text: &str, strict: bool) -> Check {
    if strict {
        if text == "eval" || text == "arguments" {
            return Err(Reason::Msg(msg::STRICT_EVAL_ARGUMENTS));
        }
        if STRICT_RESERVED.contains(&text) {
            return Err(Reason::Msg(msg::STRICT_RESERVED));
        }
    }
    Ok(())
}

fn chain_has_optional(start: Node<'_>) -> bool {
    let mut node = start;
    loop {
        let next = match node.kind() {
            "member_expression" | "subscript_expression" => node.child_by_field_name("object"),
            "call_expression" => node.child_by_field_name("function"),
            _ => return false,
        };
        if has_child_kind(node, "optional_chain") {
            return true;
        }
        match next {
            Some(inner) => node = inner,
            None => return false,
        }
    }
}

fn method_facts(node: Node<'_>) -> Facts {
    let name = node.child_by_field_name("name").map(|n| n.id());
    let mut facts = Facts { is_static: false, is_async: false, is_gen: false, getter: false, setter: false };
    for child in kids(node) {
        if Some(child.id()) == name {
            break;
        }
        match child.kind() {
            "static" => facts.is_static = true,
            "async" => facts.is_async = true,
            "*" => facts.is_gen = true,
            "get" => facts.getter = true,
            "set" => facts.setter = true,
            _ => {}
        }
    }
    facts
}

fn declare_private(
    map: &mut HashMap<String, PrivEntry>,
    name: &str,
    getter: bool,
    setter: bool,
    is_static: bool,
) -> Check {
    if name == "#constructor" {
        return Err(Reason::Msg(msg::FIELD_CONSTRUCTOR));
    }
    match map.get_mut(name) {
        None => {
            map.insert(name.to_owned(), PrivEntry { getter, setter, other: !getter && !setter, is_static });
            Ok(())
        }
        Some(entry) => {
            let pair = !entry.other
                && ((getter && !entry.getter && entry.setter) || (setter && !entry.setter && entry.getter));
            if !pair || entry.is_static != is_static {
                return Err(Reason::PrivateDuplicate(name.to_owned()));
            }
            entry.getter |= getter;
            entry.setter |= setter;
            Ok(())
        }
    }
}

/// Everything in `source` the grammar accepts but a classic script does not.
pub fn check(root: Node<'_>, source: &str) -> Check {
    let mut checker =
        Checker { src: source, scopes: Scopes::new(), labels: Vec::new(), privates: Vec::new(), depth: 0 };
    checker.prescan(root)?;
    let top = named_kids(root);
    let cx = Cx::script(checker.directive_strict(&top));
    for statement in kids(root) {
        checker.visit(statement, cx)?;
    }
    Ok(())
}

struct Checker<'s> {
    src: &'s str,
    scopes: Scopes,
    labels: Vec<Label>,
    privates: Vec<HashMap<String, PrivEntry>>,
    depth: usize,
}

impl<'s> Checker<'s> {
    fn text(&self, node: Node<'_>) -> &'s str {
        self.src.get(node.start_byte()..node.end_byte()).unwrap_or("")
    }

    fn gap(&self, from: usize, to: usize) -> &'s str {
        self.src.get(from..to).unwrap_or("")
    }

    /// The constructs no classic script holds, wherever they sit, and the shape of every name.
    fn prescan(&self, root: Node<'_>) -> Check {
        let mut cursor = root.walk();
        loop {
            self.forbidden(cursor.node())?;
            if cursor.goto_first_child() {
                continue;
            }
            loop {
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() {
                    return Ok(());
                }
            }
        }
    }

    fn forbidden(&self, node: Node<'_>) -> Check {
        match node.kind() {
            "import_statement" => Err(Reason::ImportOutsideModule),
            "export_statement" => Err(Reason::Unexpected("Unexpected token 'export'".to_owned())),
            "html_comment" | "html_character_reference" | "decorator" | "using_declaration" => {
                Err(Reason::Msg(msg::INVALID_TOKEN))
            }
            kind if kind.starts_with("jsx_") => Err(Reason::Msg(msg::INVALID_TOKEN)),
            "hash_bang_line" => {
                if node.start_byte() == 0 {
                    Ok(())
                } else {
                    Err(Reason::Msg(msg::INVALID_TOKEN))
                }
            }
            "identifier" | "property_identifier" | "shorthand_property_identifier"
            | "shorthand_property_identifier_pattern" | "statement_identifier" | "undefined" => {
                if ident_ok(self.text(node)) {
                    Ok(())
                } else {
                    Err(Reason::Msg(msg::INVALID_TOKEN))
                }
            }
            "private_property_identifier" => {
                if ident_ok(self.text(node).trim_start_matches('#')) {
                    Ok(())
                } else {
                    Err(Reason::Msg(msg::INVALID_TOKEN))
                }
            }
            _ => Ok(()),
        }
    }

    fn directive_strict(&self, statements: &[Node<'_>]) -> bool {
        for statement in statements {
            match statement.kind() {
                "hash_bang_line" => continue,
                "expression_statement" => match named_kids(*statement).as_slice() {
                    [expr] if expr.kind() == "string" => {
                        let raw = self.text(*expr);
                        if raw == "\"use strict\"" || raw == "'use strict'" {
                            return true;
                        }
                    }
                    _ => return false,
                },
                _ => return false,
            }
        }
        false
    }

    fn bound_names(&self, node: Node<'_>, out: &mut Vec<String>) {
        match node.kind() {
            "identifier" | "undefined" | "shorthand_property_identifier_pattern" => {
                out.push(self.text(node).to_owned());
            }
            "pair_pattern" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.bound_names(value, out);
                }
            }
            "assignment_pattern" | "object_assignment_pattern" => {
                if let Some(left) = node.child_by_field_name("left") {
                    self.bound_names(left, out);
                }
            }
            "rest_pattern" | "array_pattern" | "object_pattern" | "formal_parameters" => {
                for child in named_kids(node) {
                    self.bound_names(child, out);
                }
            }
            _ => {}
        }
    }

    fn visit_children(&mut self, node: Node<'_>, cx: Cx) -> Check {
        for child in kids(node) {
            self.visit(child, cx)?;
        }
        Ok(())
    }

    fn visit(&mut self, node: Node<'_>, cx: Cx) -> Check {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(Reason::Msg(msg::TOO_DEEP));
        }
        let result = self.dispatch(node, cx);
        self.depth -= 1;
        result
    }

    fn dispatch(&mut self, node: Node<'_>, cx: Cx) -> Check {
        match node.kind() {
            "comment" => Ok(()),
            "statement_block" => self.visit_block(node, cx),
            "function_declaration" | "generator_function_declaration" => self.visit_function_declaration(node, cx),
            "function_expression" | "generator_function" | "arrow_function" | "method_definition" => {
                self.function_like(node, cx, false)
            }
            "class_declaration" | "class" => self.visit_class(node, cx),
            "lexical_declaration" | "variable_declaration" => self.visit_declaration(node, cx),
            "for_statement" => self.visit_for(node, cx),
            "for_in_statement" => self.visit_for_in(node, cx),
            "while_statement" | "do_statement" => self.visit_while(node, cx),
            "if_statement" => self.visit_if(node, cx),
            "labeled_statement" => self.visit_labeled(node, cx),
            "break_statement" => self.visit_break(node, cx),
            "continue_statement" => self.visit_continue(node, cx),
            "return_statement" => {
                if !cx.in_function {
                    return Err(Reason::IllegalReturn);
                }
                self.visit_children(node, cx)
            }
            "with_statement" => self.visit_with(node, cx),
            "switch_statement" => self.visit_switch(node, cx),
            "try_statement" => self.visit_try(node, cx),
            "throw_statement" => self.visit_throw(node, cx),
            "identifier" | "undefined" | "shorthand_property_identifier" | "shorthand_property_identifier_pattern"
            | "statement_identifier" => self.visit_ident(node, cx),
            "private_property_identifier" => self.visit_private_ref(node),
            "await_expression" => self.visit_await(node, cx),
            "yield_expression" => self.visit_yield(node, cx),
            "meta_property" => Self::visit_meta_property(node, cx),
            "super" => Self::visit_super(node, cx),
            "call_expression" => self.visit_call(node, cx),
            "new_expression" => self.visit_new(node, cx),
            "binary_expression" => self.visit_binary(node, cx),
            "unary_expression" => self.visit_unary(node, cx),
            "update_expression" => self.visit_update(node, cx),
            "assignment_expression" => self.visit_assignment(node, cx, true),
            "augmented_assignment_expression" => self.visit_assignment(node, cx, false),
            "object" => self.visit_object(node, cx),
            "pair" | "pair_pattern" => self.visit_pair(node, cx),
            "number" => self.visit_number(node, cx),
            "string" => self.visit_string(node, cx),
            "template_string" => self.visit_template(node, cx),
            "regex" => self.visit_regex(node),
            _ => self.visit_children(node, cx),
        }
    }

    fn visit_ident(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let text = self.text(node);
        if ALWAYS_RESERVED.contains(&text) {
            return Err(Reason::Msg(msg::RESERVED_WORD));
        }
        if cx.strict && STRICT_RESERVED.contains(&text) {
            return Err(Reason::Msg(msg::STRICT_RESERVED));
        }
        match text {
            "await" if cx.await_kw != Kw::Identifier => Err(Reason::Msg(msg::RESERVED_WORD)),
            "yield" if cx.yield_kw != Kw::Identifier => Err(Reason::Msg(msg::RESERVED_WORD)),
            "arguments" if cx.no_arguments => Err(Reason::Msg(msg::ARGUMENTS_IN_INITIALIZER)),
            _ => Ok(()),
        }
    }

    fn visit_private_ref(&self, node: Node<'_>) -> Check {
        let name = self.text(node);
        if self.privates.iter().any(|names| names.contains_key(name)) {
            Ok(())
        } else {
            Err(Reason::PrivateUndeclared(name.to_owned()))
        }
    }

    fn visit_block(&mut self, node: Node<'_>, cx: Cx) -> Check {
        self.scopes.push(ScopeKind::Block);
        self.visit_children(node, cx)?;
        self.scopes.pop();
        Ok(())
    }

    /// A statement that is the whole body of `if`, a loop, `with` or a label.
    fn visit_sub(&mut self, node: Node<'_>, cx: Cx, mode: FnMode) -> Check {
        match node.kind() {
            "lexical_declaration" | "class_declaration" => Err(Reason::Msg(msg::SINGLE_STATEMENT_DECLARATION)),
            "function_declaration" | "generator_function_declaration" => {
                let plain = node.kind() == "function_declaration" && !has_child_kind(node, "async");
                if mode == FnMode::No || !plain || cx.strict {
                    return Err(Reason::Msg(msg::SINGLE_STATEMENT_DECLARATION));
                }
                if mode == FnMode::IfBranch {
                    self.scopes.push(ScopeKind::Block);
                    self.visit(node, cx)?;
                    self.scopes.pop();
                    return Ok(());
                }
                self.visit(node, cx)
            }
            _ => self.visit(node, cx),
        }
    }

    fn visit_function_declaration(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if let Some(name) = node.child_by_field_name("name") {
            let plain = node.kind() == "function_declaration" && !has_child_kind(node, "async");
            self.visit_ident(name, cx)?;
            self.scopes.declare_function(self.text(name), plain, cx.strict)?;
        }
        self.function_like(node, cx, false)
    }

    fn function_like(&mut self, node: Node<'_>, cx: Cx, derived_ctor: bool) -> Check {
        let kind = node.kind();
        let is_arrow = kind == "arrow_function";
        let is_method = kind == "method_definition";
        let facts = if is_method {
            method_facts(node)
        } else {
            Facts {
                is_static: false,
                is_async: has_child_kind(node, "async"),
                is_gen: kind.starts_with("generator_function"),
                getter: false,
                setter: false,
            }
        };
        let params = node.child_by_field_name("parameters");
        let single = node.child_by_field_name("parameter");
        let body = node.child_by_field_name("body").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;

        if is_arrow {
            self.check_arrow_layout(node)?;
        }

        let mut names = Vec::new();
        let mut simple = true;
        let mut count = 0;
        let mut rest = false;
        if let Some(p) = params {
            self.bound_names(p, &mut names);
            for child in named_kids(p) {
                count += 1;
                rest |= child.kind() == "rest_pattern";
                simple &= matches!(child.kind(), "identifier" | "undefined");
            }
        }
        if let Some(s) = single {
            self.bound_names(s, &mut names);
        }
        if facts.getter && count != 0 {
            return Err(Reason::Msg(msg::GETTER_PARAMETERS));
        }
        if facts.setter && (count != 1 || rest) {
            return Err(Reason::Msg(msg::SETTER_PARAMETERS));
        }

        let own_directive = body.kind() == "statement_block" && self.directive_strict(&named_kids(body));
        if own_directive && !simple {
            return Err(Reason::Msg(msg::USE_STRICT_NON_SIMPLE));
        }
        let strict = cx.strict || own_directive;
        if first_duplicate(&names).is_some() && (strict || !simple || is_arrow || is_method) {
            return Err(Reason::Msg(msg::DUPLICATE_PARAM));
        }
        for name in &names {
            check_binding_name(name, strict)?;
        }
        if let Some(name) = node.child_by_field_name("name").filter(|_| !is_method) {
            check_binding_name(self.text(name), strict)?;
        }

        let mut inner = cx;
        inner.strict = strict;
        inner.in_function = true;
        inner.breakable = false;
        inner.in_loop = false;
        if !is_arrow {
            inner.new_target = true;
            inner.super_prop = is_method;
            inner.super_call = derived_ctor;
            inner.no_arguments = false;
        }
        inner.await_kw = if facts.is_async {
            Kw::Operator
        } else if is_arrow && cx.await_kw != Kw::Identifier {
            Kw::Reserved
        } else {
            Kw::Identifier
        };
        inner.yield_kw = if facts.is_gen {
            Kw::Operator
        } else if is_arrow && cx.yield_kw != Kw::Identifier {
            Kw::Reserved
        } else {
            Kw::Identifier
        };
        let mut param_cx = inner;
        if facts.is_async {
            param_cx.await_kw = Kw::Reserved;
        }
        if facts.is_gen {
            param_cx.yield_kw = Kw::Reserved;
        }

        let saved_labels = std::mem::take(&mut self.labels);
        self.scopes.push(ScopeKind::Function);
        self.scopes.add_params(&names);
        if let Some(p) = params {
            self.visit(p, param_cx)?;
        }
        if let Some(s) = single {
            self.visit(s, param_cx)?;
        }
        if body.kind() == "statement_block" {
            for statement in kids(body) {
                self.visit(statement, inner)?;
            }
        } else {
            self.visit(body, inner)?;
        }
        self.scopes.pop();
        self.labels = saved_labels;
        Ok(())
    }

    /// `async` and `=>` may not be separated from what they belong to by a line break.
    fn check_arrow_layout(&self, node: Node<'_>) -> Check {
        let children = kids(node);
        for (index, child) in children.iter().enumerate() {
            if child.kind() == "=>" && index > 0 {
                let before = children[index - 1];
                if has_line_terminator(self.gap(before.end_byte(), child.start_byte())) {
                    return Err(Reason::Unexpected("Unexpected token '=>'".to_owned()));
                }
            }
            if child.kind() == "async"
                && let Some(after) = children.get(index + 1)
                && has_line_terminator(self.gap(child.end_byte(), after.start_byte()))
            {
                return Err(Reason::Msg(msg::INVALID_TOKEN));
            }
        }
        Ok(())
    }

    fn visit_class(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let mut class_cx = cx;
        class_cx.strict = true;
        if has_child_kind(node, "decorator") {
            return Err(Reason::Msg(msg::INVALID_TOKEN));
        }
        if let Some(name) = node.child_by_field_name("name") {
            let text = self.text(name);
            check_binding_name(text, true)?;
            self.visit_ident(name, class_cx)?;
            if node.kind() == "class_declaration" {
                self.scopes.declare_lexical(text)?;
            }
        }
        let mut derived = false;
        for child in kids(node) {
            if child.kind() == "class_heritage" {
                derived = true;
                self.visit(child, class_cx)?;
            }
        }
        let body = node.child_by_field_name("body").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
        self.visit_class_body(body, class_cx, derived)
    }

    fn visit_class_body(&mut self, body: Node<'_>, cx: Cx, derived: bool) -> Check {
        let members = named_kids(body);
        let mut names: HashMap<String, PrivEntry> = HashMap::new();
        for member in &members {
            let (name, facts) = match member.kind() {
                "method_definition" => (member.child_by_field_name("name"), method_facts(*member)),
                "field_definition" => (
                    member.child_by_field_name("property"),
                    Facts {
                        is_static: has_child_kind(*member, "static"),
                        is_async: false,
                        is_gen: false,
                        getter: false,
                        setter: false,
                    },
                ),
                _ => continue,
            };
            if let Some(name) = name.filter(|n| n.kind() == "private_property_identifier") {
                declare_private(&mut names, self.text(name), facts.getter, facts.setter, facts.is_static)?;
            }
        }
        self.privates.push(names);
        let mut constructors = 0;
        for member in members {
            match member.kind() {
                "method_definition" => {
                    let facts = method_facts(member);
                    let name = member.child_by_field_name("name");
                    let named = name.map(|n| self.property_key(n)).unwrap_or_default();
                    let is_ctor = !facts.is_static && named == "constructor";
                    if is_ctor {
                        if facts.getter || facts.setter || facts.is_async || facts.is_gen {
                            return Err(Reason::Msg(msg::SPECIAL_CONSTRUCTOR));
                        }
                        constructors += 1;
                        if constructors > 1 {
                            return Err(Reason::Msg(msg::DUPLICATE_CONSTRUCTOR));
                        }
                    }
                    if facts.is_static && named == "prototype" {
                        return Err(Reason::Msg(msg::STATIC_PROTOTYPE));
                    }
                    if let Some(name) = name {
                        self.visit(name, cx)?;
                    }
                    self.function_like(member, cx, is_ctor && derived)?;
                }
                "field_definition" => {
                    let is_static = has_child_kind(member, "static");
                    let name = member.child_by_field_name("property");
                    let named = name.map(|n| self.property_key(n)).unwrap_or_default();
                    if named == "constructor" {
                        return Err(Reason::Msg(msg::FIELD_CONSTRUCTOR));
                    }
                    if is_static && named == "prototype" {
                        return Err(Reason::Msg(msg::STATIC_PROTOTYPE));
                    }
                    if let Some(name) = name {
                        self.visit(name, cx)?;
                    }
                    if let Some(value) = member.child_by_field_name("value") {
                        self.visit(value, cx.initializer())?;
                    }
                }
                "class_static_block" => {
                    let saved_labels = std::mem::take(&mut self.labels);
                    self.scopes.push(ScopeKind::Function);
                    if let Some(block) = member.child_by_field_name("body") {
                        for statement in kids(block) {
                            self.visit(statement, cx.initializer())?;
                        }
                    }
                    self.scopes.pop();
                    self.labels = saved_labels;
                }
                _ => return Err(Reason::Msg(msg::UNMODELED)),
            }
        }
        self.privates.pop();
        Ok(())
    }

    /// The name a member key spells when it is not computed (`constructor`, `'prototype'`), else "".
    fn property_key(&self, key: Node<'_>) -> String {
        let text = self.text(key);
        match key.kind() {
            "property_identifier" => text.to_owned(),
            "string" if text.len() >= 2 && !text.contains('\\') => text[1..text.len() - 1].to_owned(),
            _ => String::new(),
        }
    }

    fn visit_declaration(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let lexical = node.kind() == "lexical_declaration";
        let is_const = lexical && has_child_kind(node, "const");
        for declarator in kids(node) {
            if declarator.kind() != "variable_declarator" {
                continue;
            }
            let name = declarator.child_by_field_name("name").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
            let value = declarator.child_by_field_name("value");
            let is_pattern = !matches!(name.kind(), "identifier" | "undefined");
            if value.is_none() && (is_const || is_pattern) {
                return Err(Reason::Msg(if is_const {
                    msg::MISSING_CONST_INIT
                } else {
                    msg::MISSING_DESTRUCTURING_INIT
                }));
            }
            let mut names = Vec::new();
            self.bound_names(name, &mut names);
            for bound in &names {
                check_binding_name(bound, cx.strict)?;
                if lexical {
                    if bound == "let" {
                        return Err(Reason::Msg(msg::RESERVED_WORD));
                    }
                    self.scopes.declare_lexical(bound)?;
                } else {
                    self.scopes.declare_var(bound)?;
                }
            }
            self.visit(name, cx)?;
            if let Some(value) = value {
                self.visit(value, cx)?;
            }
        }
        Ok(())
    }

    fn visit_for(&mut self, node: Node<'_>, cx: Cx) -> Check {
        self.scopes.push(ScopeKind::Block);
        for field in ["initializer", "condition", "increment"] {
            if let Some(part) = node.child_by_field_name(field) {
                self.visit(part, cx)?;
            }
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_sub(body, cx.looping(), FnMode::No)?;
        }
        self.scopes.pop();
        Ok(())
    }

    fn visit_for_in(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let is_await = has_child_kind(node, "await");
        if is_await && cx.await_kw != Kw::Operator {
            return Err(Reason::AwaitOutsideAsync);
        }
        let op = node.child_by_field_name("operator").map_or("", |n| self.text(n));
        if is_await && op != "of" {
            return Err(Reason::Msg(msg::INVALID_LHS_FOR));
        }
        let kind = node.child_by_field_name("kind").map(|n| self.text(n));
        let left = node.child_by_field_name("left").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
        self.scopes.push(ScopeKind::Block);
        match kind {
            Some(k @ ("var" | "let" | "const")) => {
                let mut names = Vec::new();
                self.bound_names(left, &mut names);
                for name in &names {
                    check_binding_name(name, cx.strict)?;
                    if k == "var" {
                        self.scopes.declare_var(name)?;
                    } else {
                        if name == "let" {
                            return Err(Reason::Msg(msg::RESERVED_WORD));
                        }
                        self.scopes.declare_lexical(name)?;
                    }
                }
            }
            Some(_) => return Err(Reason::Msg(msg::UNMODELED)),
            None => self.check_target(left, cx.strict, true, msg::INVALID_LHS_FOR)?,
        }
        if let Some(value) = node.child_by_field_name("value") {
            let allowed = kind == Some("var") && op == "in" && !cx.strict && left.kind() == "identifier";
            if !allowed {
                return Err(Reason::Msg(msg::INVALID_TOKEN));
            }
            self.visit(value, cx)?;
        }
        self.visit(left, cx)?;
        if let Some(right) = node.child_by_field_name("right") {
            self.visit(right, cx)?;
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_sub(body, cx.looping(), FnMode::No)?;
        }
        self.scopes.pop();
        Ok(())
    }

    fn visit_while(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if let Some(condition) = node.child_by_field_name("condition") {
            self.visit(condition, cx)?;
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_sub(body, cx.looping(), FnMode::No)?;
        }
        Ok(())
    }

    fn visit_if(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if let Some(condition) = node.child_by_field_name("condition") {
            self.visit(condition, cx)?;
        }
        if let Some(branch) = node.child_by_field_name("consequence") {
            self.visit_sub(branch, cx, FnMode::IfBranch)?;
        }
        if let Some(alternative) = node.child_by_field_name("alternative") {
            for branch in named_kids(alternative) {
                self.visit_sub(branch, cx, FnMode::IfBranch)?;
            }
        }
        Ok(())
    }

    fn visit_labeled(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let label = node.child_by_field_name("label").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
        let body = node.child_by_field_name("body").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
        let name = self.text(label);
        if self.labels.iter().any(|existing| existing.name == name) {
            return Err(Reason::DuplicateLabel(name.to_owned()));
        }
        self.visit_ident(label, cx)?;
        let mut target = body;
        while target.kind() == "labeled_statement" {
            match target.child_by_field_name("body") {
                Some(next) => target = next,
                None => break,
            }
        }
        let is_loop =
            matches!(target.kind(), "for_statement" | "for_in_statement" | "while_statement" | "do_statement");
        self.labels.push(Label { name: name.to_owned(), is_loop });
        self.visit_sub(body, cx, FnMode::Labeled)?;
        self.labels.pop();
        Ok(())
    }

    fn visit_break(&self, node: Node<'_>, cx: Cx) -> Check {
        match node.child_by_field_name("label") {
            Some(label) => {
                let name = self.text(label);
                if !self.labels.iter().any(|existing| existing.name == name) {
                    return Err(Reason::UndefinedLabel(name.to_owned()));
                }
            }
            None => {
                if !cx.breakable {
                    return Err(Reason::Msg(msg::ILLEGAL_BREAK));
                }
            }
        }
        Ok(())
    }

    fn visit_continue(&self, node: Node<'_>, cx: Cx) -> Check {
        match node.child_by_field_name("label") {
            Some(label) => {
                let name = self.text(label);
                match self.labels.iter().find(|existing| existing.name == name) {
                    None => return Err(Reason::UndefinedLabel(name.to_owned())),
                    Some(found) if !found.is_loop => return Err(Reason::Msg(msg::ILLEGAL_CONTINUE)),
                    Some(_) => {}
                }
            }
            None => {
                if !cx.in_loop {
                    return Err(Reason::Msg(msg::ILLEGAL_CONTINUE));
                }
            }
        }
        Ok(())
    }

    fn visit_with(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if cx.strict {
            return Err(Reason::Msg(msg::STRICT_WITH));
        }
        if let Some(object) = node.child_by_field_name("object") {
            self.visit(object, cx)?;
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_sub(body, cx, FnMode::No)?;
        }
        Ok(())
    }

    fn visit_switch(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if let Some(value) = node.child_by_field_name("value") {
            self.visit(value, cx)?;
        }
        if let Some(body) = node.child_by_field_name("body") {
            let mut switch_cx = cx;
            switch_cx.breakable = true;
            self.scopes.push(ScopeKind::Block);
            self.visit_children(body, switch_cx)?;
            self.scopes.pop();
        }
        Ok(())
    }

    fn visit_try(&mut self, node: Node<'_>, cx: Cx) -> Check {
        for child in kids(node) {
            if child.kind() == "catch_clause" {
                self.visit_catch(child, cx)?;
            } else {
                self.visit(child, cx)?;
            }
        }
        Ok(())
    }

    fn visit_catch(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let param = node.child_by_field_name("parameter");
        let mut names = Vec::new();
        if let Some(p) = param {
            self.bound_names(p, &mut names);
        }
        if let Some(name) = first_duplicate(&names) {
            return Err(Reason::Redeclared(name.to_owned()));
        }
        for name in &names {
            check_binding_name(name, cx.strict)?;
        }
        let simple = param.is_none_or(|p| p.kind() == "identifier");
        self.scopes.push(ScopeKind::Catch { simple });
        self.scopes.add_params(&names);
        if let Some(p) = param {
            self.visit(p, cx)?;
        }
        if let Some(body) = node.child_by_field_name("body") {
            for statement in kids(body) {
                self.visit(statement, cx)?;
            }
        }
        self.scopes.pop();
        Ok(())
    }

    fn visit_throw(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let children = kids(node);
        if let (Some(keyword), Some(expr)) = (children.first(), named_kids(node).first())
            && has_line_terminator(self.gap(keyword.end_byte(), expr.start_byte()))
        {
            return Err(Reason::Msg(msg::NEWLINE_AFTER_THROW));
        }
        self.visit_children(node, cx)
    }

    fn check_target(&self, node: Node<'_>, strict: bool, allow_pattern: bool, reason: &'static str) -> Check {
        let invalid = || Err(Reason::Msg(reason));
        match node.kind() {
            "identifier" | "undefined" => self.check_assigned_name(node, strict),
            "shorthand_property_identifier_pattern" if allow_pattern => self.check_assigned_name(node, strict),
            "member_expression" | "subscript_expression" => {
                if has_child_kind(node, "optional_chain") {
                    invalid()
                } else {
                    Ok(())
                }
            }
            "parenthesized_expression" => match named_kids(node).as_slice() {
                [inner] => self.check_target(*inner, strict, false, reason),
                _ => invalid(),
            },
            "array_pattern" | "object_pattern" if allow_pattern => {
                for child in named_kids(node) {
                    self.check_target(child, strict, true, reason)?;
                }
                Ok(())
            }
            "assignment_pattern" | "object_assignment_pattern" if allow_pattern => {
                match node.child_by_field_name("left") {
                    Some(left) => self.check_target(left, strict, true, reason),
                    None => invalid(),
                }
            }
            "pair_pattern" if allow_pattern => match node.child_by_field_name("value") {
                Some(value) => self.check_target(value, strict, true, reason),
                None => invalid(),
            },
            "rest_pattern" if allow_pattern => match named_kids(node).first() {
                Some(target) => self.check_target(*target, strict, true, reason),
                None => invalid(),
            },
            _ => invalid(),
        }
    }

    fn check_assigned_name(&self, node: Node<'_>, strict: bool) -> Check {
        let text = self.text(node);
        if strict && (text == "eval" || text == "arguments") {
            return Err(Reason::Msg(msg::STRICT_EVAL_ARGUMENTS));
        }
        Ok(())
    }

    fn visit_assignment(&mut self, node: Node<'_>, cx: Cx, patterns: bool) -> Check {
        let left = node.child_by_field_name("left").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
        self.check_target(left, cx.strict, patterns, msg::INVALID_LHS_ASSIGN)?;
        self.visit_children(node, cx)
    }

    fn visit_update(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let argument = node.child_by_field_name("argument").ok_or(Reason::Msg(msg::INVALID_TOKEN))?;
        self.check_target(argument, cx.strict, false, msg::INVALID_LHS_UPDATE)?;
        if let Some(operator) = node.child_by_field_name("operator") {
            let postfix = operator.start_byte() >= argument.end_byte();
            if postfix && has_line_terminator(self.gap(argument.end_byte(), operator.start_byte())) {
                return Err(Reason::Msg(msg::INVALID_TOKEN));
            }
        }
        self.visit_children(node, cx)
    }

    fn visit_unary(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let operator = self.operator_of(node);
        if let Some(argument) = node.child_by_field_name("argument") {
            if argument.kind() == "binary_expression" && self.operator_of(argument) == "**" {
                return Err(Reason::Msg(msg::EXPONENT_UNARY));
            }
            if operator == "delete" {
                let mut target = argument;
                while target.kind() == "parenthesized_expression" {
                    match named_kids(target).as_slice() {
                        [inner] => target = *inner,
                        _ => break,
                    }
                }
                match target.kind() {
                    "identifier" | "undefined" if cx.strict => return Err(Reason::Msg(msg::STRICT_DELETE)),
                    "member_expression" | "subscript_expression" => {
                        let private = target
                            .child_by_field_name("property")
                            .is_some_and(|p| p.kind() == "private_property_identifier");
                        if private {
                            return Err(Reason::Msg(msg::PRIVATE_DELETE));
                        }
                    }
                    _ => {}
                }
            }
        }
        self.visit_children(node, cx)
    }

    fn operator_of(&self, node: Node<'_>) -> &'s str {
        node.child_by_field_name("operator").map_or("", |n| self.text(n))
    }

    fn visit_binary(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let operator = self.operator_of(node);
        let left = node.child_by_field_name("left");
        let right = node.child_by_field_name("right");
        if operator == "**"
            && let Some(left) = left
            && (left.kind() == "unary_expression"
                || (left.kind() == "await_expression" && cx.await_kw == Kw::Operator))
        {
            return Err(Reason::Msg(msg::EXPONENT_UNARY));
        }
        let mixes = |child: Option<Node<'_>>, wanted: &[&str]| {
            child.is_some_and(|c| c.kind() == "binary_expression" && wanted.contains(&self.operator_of(c)))
        };
        let clash = match operator {
            "??" => mixes(left, &["||", "&&"]) || mixes(right, &["||", "&&"]),
            "||" | "&&" => mixes(left, &["??"]) || mixes(right, &["??"]),
            _ => false,
        };
        if clash {
            return Err(Reason::Unexpected("Unexpected token '??'".to_owned()));
        }
        self.visit_children(node, cx)
    }

    fn visit_call(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let function = node.child_by_field_name("function");
        let arguments = node.child_by_field_name("arguments");
        if function.is_some_and(|f| f.kind() == "import") {
            let ok = arguments.is_some_and(|a| {
                a.kind() == "arguments" && matches!(named_kids(a).as_slice(), [one] if one.kind() != "spread_element")
            });
            if !ok {
                return Err(Reason::Msg(msg::IMPORT_CALL));
            }
        }
        if arguments.is_some_and(|a| a.kind() == "template_string")
            && (has_child_kind(node, "optional_chain") || function.is_some_and(chain_has_optional))
        {
            return Err(Reason::Msg(msg::OPTIONAL_CHAIN_TEMPLATE));
        }
        self.visit_children(node, cx)
    }

    fn visit_new(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if node.child_by_field_name("constructor").is_some_and(chain_has_optional) {
            return Err(Reason::Msg(msg::OPTIONAL_CHAIN_NEW));
        }
        self.visit_children(node, cx)
    }

    fn visit_meta_property(node: Node<'_>, cx: Cx) -> Check {
        match node.child(0).map(|c| c.kind()) {
            Some("import") => Err(Reason::ImportMeta),
            Some("new") if cx.new_target => Ok(()),
            _ => Err(Reason::Msg(msg::NEW_TARGET)),
        }
    }

    fn visit_super(node: Node<'_>, cx: Cx) -> Check {
        let Some(parent) = node.parent() else { return Err(Reason::Msg(msg::SUPER_UNEXPECTED)) };
        let is_field = |name: &str| parent.child_by_field_name(name).map(|n| n.id()) == Some(node.id());
        match parent.kind() {
            "call_expression" if is_field("function") && cx.super_call => Ok(()),
            "member_expression" | "subscript_expression"
                if is_field("object") && cx.super_prop && !has_child_kind(parent, "optional_chain") =>
            {
                let private = parent
                    .child_by_field_name("property")
                    .is_some_and(|p| p.kind() == "private_property_identifier");
                if private { Err(Reason::Msg(msg::SUPER_UNEXPECTED)) } else { Ok(()) }
            }
            _ => Err(Reason::Msg(msg::SUPER_UNEXPECTED)),
        }
    }

    fn visit_await(&mut self, node: Node<'_>, cx: Cx) -> Check {
        match cx.await_kw {
            Kw::Operator => {}
            Kw::Reserved => return Err(Reason::AwaitOutsideAsync),
            Kw::Identifier => {
                // `await` is an identifier here: only an operand that continues an identifier expression
                // (`await(x)`, `await[x]`, `await + x`, a tagged template) reads as legal code.
                let operand = named_kids(node).last().copied().ok_or(Reason::AwaitOutsideAsync)?;
                let rest = self.src.as_bytes().get(operand.start_byte()..).unwrap_or(&[]);
                let legal = match rest.first() {
                    Some(b'(' | b'[' | b'`') => true,
                    Some(b'+') => rest.get(1) != Some(&b'+'),
                    Some(b'-') => rest.get(1) != Some(&b'-'),
                    _ => false,
                };
                if !legal {
                    return Err(Reason::AwaitOutsideAsync);
                }
            }
        }
        self.visit_children(node, cx)
    }

    fn visit_yield(&mut self, node: Node<'_>, cx: Cx) -> Check {
        match cx.yield_kw {
            Kw::Operator => {}
            Kw::Reserved => return Err(Reason::Msg(msg::RESERVED_WORD)),
            Kw::Identifier => {
                if cx.strict || !named_kids(node).is_empty() || has_child_kind(node, "*") {
                    return Err(Reason::Msg(msg::UNMODELED));
                }
            }
        }
        self.visit_children(node, cx)
    }

    fn visit_object(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let mut protos = 0;
        for child in named_kids(node) {
            if child.kind() != "pair" {
                continue;
            }
            let Some(key) = child.child_by_field_name("key") else { continue };
            let text = self.text(key);
            let is_proto = match key.kind() {
                "property_identifier" => text == "__proto__",
                "string" => {
                    let inner = text.get(1..text.len().saturating_sub(1)).unwrap_or("");
                    inner == "__proto__" || (inner.contains('\\') && inner.len() >= "__proto__".len())
                }
                _ => false,
            };
            if is_proto {
                protos += 1;
            }
        }
        if protos > 1 {
            return Err(Reason::Msg(msg::DUPLICATE_PROTO));
        }
        self.visit_children(node, cx)
    }

    fn visit_pair(&mut self, node: Node<'_>, cx: Cx) -> Check {
        if node.child_by_field_name("key").is_some_and(|k| k.kind() == "private_property_identifier") {
            return Err(Reason::Msg(msg::INVALID_TOKEN));
        }
        self.visit_children(node, cx)
    }

    fn visit_number(&self, node: Node<'_>, cx: Cx) -> Check {
        number_error(self.text(node), cx.strict)?;
        let next = self.src.get(node.end_byte()..).and_then(|rest| rest.chars().next());
        if next.is_some_and(|c| c == '\\' || c == '$' || c == '_' || unicode_ident::is_xid_continue(c)) {
            return Err(Reason::Msg(msg::INVALID_TOKEN));
        }
        Ok(())
    }

    fn visit_string(&self, node: Node<'_>, cx: Cx) -> Check {
        for child in kids(node) {
            if child.kind() == "escape_sequence" {
                self.escape_error(child, cx.strict, true)?;
            }
        }
        Ok(())
    }

    fn visit_template(&mut self, node: Node<'_>, cx: Cx) -> Check {
        let tagged = node.parent().is_some_and(|p| {
            p.kind() == "call_expression" && p.child_by_field_name("arguments").map(|a| a.id()) == Some(node.id())
        });
        for child in kids(node) {
            match child.kind() {
                "escape_sequence" if !tagged => self.escape_error(child, true, true)?,
                "template_substitution" => self.visit(child, cx)?,
                _ => {}
            }
        }
        Ok(())
    }

    /// `forbid_octal`: legacy octal and `\8` `\9` escapes are errors; `shape`: `\x` and `\u` must be well formed.
    fn escape_error(&self, node: Node<'_>, forbid_octal: bool, shape: bool) -> Check {
        let text = self.text(node);
        let bytes = text.as_bytes();
        let bad = Err(Reason::Msg(msg::INVALID_TOKEN));
        match bytes.get(1) {
            Some(b'x') => {
                if shape && !(bytes.len() == 4 && bytes[2..].iter().all(u8::is_ascii_hexdigit)) {
                    return bad;
                }
            }
            Some(b'u') => {
                if shape && !unicode_escape_ok(&text[2..]) {
                    return bad;
                }
            }
            Some(b'0'..=b'7') => {
                let digit_follows = matches!(self.src.as_bytes().get(node.end_byte()), Some(b'8' | b'9'));
                let legacy = bytes.len() > 2 || bytes[1] != b'0' || digit_follows;
                if legacy && forbid_octal {
                    return Err(Reason::Msg(msg::STRICT_OCTAL_ESCAPE));
                }
            }
            Some(b'8' | b'9') => {
                if forbid_octal {
                    return Err(Reason::Msg(msg::STRICT_OCTAL_ESCAPE));
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn visit_regex(&self, node: Node<'_>) -> Check {
        let pattern = node.child_by_field_name("pattern").map_or("", |n| self.text(n));
        let flags = node.child_by_field_name("flags").map_or("", |n| self.text(n));
        let mut seen = HashSet::new();
        for flag in flags.chars() {
            if !"dgimsuvy".contains(flag) || !seen.insert(flag) {
                return Err(Reason::Msg(msg::INVALID_REGEX_FLAGS));
            }
        }
        if seen.contains(&'u') && seen.contains(&'v') {
            return Err(Reason::Msg(msg::INVALID_REGEX_FLAGS));
        }
        let engine_flags: String = flags.chars().filter(|c| "imsuv".contains(*c)).collect();
        match regress::Regex::with_flags(pattern, engine_flags.as_str()) {
            Ok(_) => Ok(()),
            Err(_) => Err(Reason::InvalidRegex(format!("/{pattern}/{flags}: Invalid regular expression"))),
        }
    }
}

fn unicode_escape_ok(rest: &str) -> bool {
    if let Some(braced) = rest.strip_prefix('{') {
        let Some(digits) = braced.strip_suffix('}') else { return false };
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let significant = digits.trim_start_matches('0');
        return significant.is_empty()
            || (significant.len() <= 6 && u32::from_str_radix(significant, 16).is_ok_and(|v| v <= 0x10_FFFF));
    }
    rest.len() == 4 && rest.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Digits of one run with single separators between digits: the count, or None when a separator is misplaced.
fn scan_digits(bytes: &[u8], at: &mut usize, radix_ok: fn(u8) -> bool) -> Option<usize> {
    let mut count = 0;
    let mut after_separator = false;
    while let Some(&c) = bytes.get(*at) {
        if radix_ok(c) {
            count += 1;
            after_separator = false;
        } else if c == b'_' {
            if count == 0 || after_separator {
                return None;
            }
            after_separator = true;
        } else {
            break;
        }
        *at += 1;
    }
    if after_separator {
        return None;
    }
    Some(count)
}

fn decimal_digit(c: u8) -> bool {
    c.is_ascii_digit()
}

fn hex_digit(c: u8) -> bool {
    c.is_ascii_hexdigit()
}

fn octal_digit(c: u8) -> bool {
    (b'0'..=b'7').contains(&c)
}

fn binary_digit(c: u8) -> bool {
    c == b'0' || c == b'1'
}

/// A numeric literal's own validity (separators, legacy octal, BigInt suffix).
fn number_error(text: &str, strict: bool) -> Check {
    let invalid = || Err(Reason::Msg(msg::INVALID_TOKEN));
    let separator = || Err(Reason::Msg(msg::NUMERIC_SEPARATOR));
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return invalid();
    }
    if bytes[0] == b'0' && matches!(bytes.get(1), Some(b'x' | b'X' | b'o' | b'O' | b'b' | b'B')) {
        let radix_ok: fn(u8) -> bool = match bytes[1] {
            b'x' | b'X' => hex_digit,
            b'o' | b'O' => octal_digit,
            _ => binary_digit,
        };
        let mut at = 2;
        let Some(count) = scan_digits(bytes, &mut at, radix_ok) else { return separator() };
        if count == 0 {
            return invalid();
        }
        if bytes.get(at) == Some(&b'n') {
            at += 1;
        }
        return if at == bytes.len() { Ok(()) } else { invalid() };
    }
    if bytes[0] == b'0' && bytes.get(1).is_some_and(|c| c.is_ascii_digit() || *c == b'_') {
        if bytes[1] == b'_' {
            return separator();
        }
        if strict {
            return Err(Reason::Msg(msg::STRICT_OCTAL));
        }
        if bytes.contains(&b'_') {
            return separator();
        }
        let digits = bytes.iter().take_while(|c| c.is_ascii_digit()).count();
        if bytes[..digits].iter().all(|c| octal_digit(*c)) {
            // Legacy octal: nothing may follow the digits.
            return if digits == bytes.len() { Ok(()) } else { invalid() };
        }
        // A leading zero followed by an 8 or 9 is a decimal; it has no BigInt form.
        if bytes.contains(&b'n') {
            return invalid();
        }
    }
    let mut at = 0;
    let mut fraction_or_exponent = false;
    if bytes[0] == b'.' {
        at = 1;
        let Some(count) = scan_digits(bytes, &mut at, decimal_digit) else { return separator() };
        if count == 0 {
            return invalid();
        }
        fraction_or_exponent = true;
    } else {
        let Some(count) = scan_digits(bytes, &mut at, decimal_digit) else { return separator() };
        if count == 0 {
            return invalid();
        }
        if bytes.get(at) == Some(&b'.') {
            at += 1;
            fraction_or_exponent = true;
            if bytes.get(at) == Some(&b'_') {
                return separator();
            }
            if scan_digits(bytes, &mut at, decimal_digit).is_none() {
                return separator();
            }
        }
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        fraction_or_exponent = true;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let Some(count) = scan_digits(bytes, &mut at, decimal_digit) else { return separator() };
        if count == 0 {
            return invalid();
        }
    }
    if bytes.get(at) == Some(&b'n') && !fraction_or_exponent {
        at += 1;
    }
    if at == bytes.len() { Ok(()) } else { invalid() }
}
