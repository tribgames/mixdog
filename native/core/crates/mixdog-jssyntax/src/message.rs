//! The text of a rejection, in V8's words for the classes the check detects. Message parity is best effort: no
//! caller decides anything from the text (the shell tool's hoist uses only the verdict).

use tree_sitter::Node;

pub const INVALID_TOKEN: &str = "Invalid or unexpected token";
pub const TOO_DEEP: &str = "Maximum call stack size exceeded";
pub const ILLEGAL_BREAK: &str = "Illegal break statement";
pub const ILLEGAL_CONTINUE: &str = "Illegal continue statement: no surrounding iteration statement";
pub const NEW_TARGET: &str = "new.target expression is not allowed here";
pub const SUPER_UNEXPECTED: &str = "'super' keyword unexpected here";
pub const INVALID_LHS_ASSIGN: &str = "Invalid left-hand side in assignment";
pub const INVALID_LHS_UPDATE: &str = "Invalid left-hand side expression in postfix operation";
pub const INVALID_LHS_FOR: &str = "Invalid left-hand side in for-loop";
pub const STRICT_WITH: &str = "Strict mode code may not include a with statement";
pub const STRICT_OCTAL: &str = "Octal literals are not allowed in strict mode.";
pub const STRICT_OCTAL_ESCAPE: &str = "Octal escape sequences are not allowed in strict mode.";
pub const STRICT_RESERVED: &str = "Unexpected strict mode reserved word";
pub const STRICT_EVAL_ARGUMENTS: &str = "Unexpected eval or arguments in strict mode";
pub const STRICT_DELETE: &str = "Delete of an unqualified identifier in strict mode.";
pub const RESERVED_WORD: &str = "Unexpected reserved word";
pub const DUPLICATE_PROTO: &str = "Duplicate __proto__ fields are not allowed in object literals";
pub const INVALID_REGEX_FLAGS: &str = "Invalid regular expression flags";
pub const PRIVATE_DELETE: &str = "Private fields can not be deleted";
pub const NUMERIC_SEPARATOR: &str = "Numeric separators are not allowed here.";
pub const MISSING_CONST_INIT: &str = "Missing initializer in const declaration";
pub const MISSING_DESTRUCTURING_INIT: &str = "Missing initializer in destructuring declaration";
pub const DUPLICATE_PARAM: &str = "Duplicate parameter name not allowed in this context";
pub const USE_STRICT_NON_SIMPLE: &str = "Illegal 'use strict' directive in function with non-simple parameter list";
pub const ARGUMENTS_IN_INITIALIZER: &str =
    "'arguments' is not allowed in class field initializer or static initialization block";
pub const SINGLE_STATEMENT_DECLARATION: &str = "Lexical declaration cannot appear in a single-statement context";
pub const DUPLICATE_CONSTRUCTOR: &str = "A class may only have one constructor";
pub const SPECIAL_CONSTRUCTOR: &str = "Class constructor may not be an accessor, a generator or async";
pub const FIELD_CONSTRUCTOR: &str = "Classes may not have a field named 'constructor'";
pub const STATIC_PROTOTYPE: &str = "Classes may not have a static property named 'prototype'";
pub const GETTER_PARAMETERS: &str = "Getter must not have any formal parameters.";
pub const SETTER_PARAMETERS: &str = "Setter must have exactly one formal parameter.";
pub const NEWLINE_AFTER_THROW: &str = "Illegal newline after throw";
pub const OPTIONAL_CHAIN_TEMPLATE: &str = "Invalid tagged template on optional chain";
pub const OPTIONAL_CHAIN_NEW: &str = "Invalid optional chain from new expression";
pub const EXPONENT_UNARY: &str = "Unary operator used immediately before exponentiation expression. Parenthesis must be used to disambiguate operator precedence";
pub const IMPORT_CALL: &str = "Dynamic import must have exactly one argument";
pub const UNMODELED: &str = "Unexpected token";

/// Why a source is not a classic script.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Reason {
    ImportOutsideModule,
    AwaitOutsideAsync,
    ImportMeta,
    IllegalReturn,
    UnexpectedEnd,
    Redeclared(String),
    /// A token the grammar did not expect (`Unexpected token 'x'`, `Unexpected identifier 'x'`, ...).
    Unexpected(String),
    UndefinedLabel(String),
    DuplicateLabel(String),
    PrivateUndeclared(String),
    PrivateDuplicate(String),
    InvalidRegex(String),
    /// A fixed message from the constants above.
    Msg(&'static str),
}

impl Reason {
    pub fn text(&self) -> String {
        match self {
            Self::ImportOutsideModule => "Cannot use import statement outside a module".to_owned(),
            Self::AwaitOutsideAsync => {
                "await is only valid in async functions and the top level bodies of modules".to_owned()
            }
            Self::ImportMeta => "Cannot use 'import.meta' outside a module".to_owned(),
            Self::IllegalReturn => "Illegal return statement".to_owned(),
            Self::UnexpectedEnd => "Unexpected end of input".to_owned(),
            Self::Redeclared(name) | Self::PrivateDuplicate(name) => {
                format!("Identifier '{name}' has already been declared")
            }
            Self::Unexpected(what) => what.clone(),
            Self::UndefinedLabel(name) => format!("Undefined label '{name}'"),
            Self::DuplicateLabel(name) => format!("Label '{name}' has already been declared"),
            Self::PrivateUndeclared(name) => {
                format!("Private field '{name}' must be declared in an enclosing class")
            }
            Self::InvalidRegex(source) => format!("Invalid regular expression: {source}"),
            Self::Msg(text) => (*text).to_owned(),
        }
    }
}

/// The token an unexpected-token message names: V8 words identifiers, numbers and strings by their class.
fn unexpected(leaf: Node<'_>, source: &str) -> Reason {
    let text = source.get(leaf.start_byte()..leaf.end_byte()).unwrap_or("");
    if text.is_empty() || text.len() > 40 || text.contains(char::is_whitespace) {
        return Reason::Msg(INVALID_TOKEN);
    }
    let what = match leaf.kind() {
        "identifier" | "property_identifier" | "shorthand_property_identifier" => {
            format!("Unexpected identifier '{text}'")
        }
        "number" => "Unexpected number".to_owned(),
        "string" | "string_fragment" | "template_string" => "Unexpected string".to_owned(),
        _ => format!("Unexpected token '{text}'"),
    };
    Reason::Unexpected(what)
}

fn first_leaf(node: Node<'_>) -> Node<'_> {
    let mut current = node;
    while let Some(child) = current.child(0) {
        current = child;
    }
    current
}

/// The message for a grammar error: the first ERROR or MISSING node decides.
pub fn grammar(root: Node<'_>, source: &str) -> Reason {
    let end = source.trim_end().len();
    let mut cursor = root.walk();
    loop {
        let node = cursor.node();
        if node.is_error() || node.is_missing() {
            if node.is_missing() || node.start_byte() >= end {
                return Reason::UnexpectedEnd;
            }
            let leaf = first_leaf(node);
            if leaf.end_byte() >= end && node.end_byte() >= end && node.child_count() > 1 {
                return Reason::UnexpectedEnd;
            }
            return unexpected(leaf, source);
        }
        if node.has_error() && cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return Reason::Msg(INVALID_TOKEN);
            }
        }
    }
}
