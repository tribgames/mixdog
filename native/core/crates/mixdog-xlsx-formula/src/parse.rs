//! The precedence parser of the formula engine: comparison, then `&`, then `+ -`, then `* /`, then `^`, then the unary
//! sign (which binds tighter than the power, so `-2^2` is 4), then the postfix `%`. A level of left-associative
//! operators is one flat chain, so a formula of ten thousand terms is not ten thousand levels of tree.

use mixdog_js::string_to_number;

use crate::token::{Token, TokenKind, tokenize};
use crate::value::{UnsupportedFormula, Value, cell_error_of};

/// How deep a formula may nest (parentheses, call arguments, the right side of an operator) before the engine refuses
/// it. Excel itself stops at 64 levels; the Node engine ran out of stack at about a thousand.
pub(crate) const MAX_NESTING: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BinaryOperator {
    Equal,
    NotEqual,
    Less,
    Greater,
    LessOrEqual,
    GreaterOrEqual,
    Concat,
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
}

impl BinaryOperator {
    fn of(text: &str) -> Option<Self> {
        Some(match text {
            "=" => Self::Equal,
            "<>" => Self::NotEqual,
            "<" => Self::Less,
            ">" => Self::Greater,
            "<=" => Self::LessOrEqual,
            ">=" => Self::GreaterOrEqual,
            "&" => Self::Concat,
            "+" => Self::Add,
            "-" => Self::Subtract,
            "*" => Self::Multiply,
            "/" => Self::Divide,
            "^" => Self::Power,
            _ => return None,
        })
    }
}

/// The operators of each precedence level, loosest first.
const LEVELS: [&[BinaryOperator]; 5] = [
    &[
        BinaryOperator::Equal,
        BinaryOperator::NotEqual,
        BinaryOperator::Less,
        BinaryOperator::Greater,
        BinaryOperator::LessOrEqual,
        BinaryOperator::GreaterOrEqual,
    ],
    &[BinaryOperator::Concat],
    &[BinaryOperator::Add, BinaryOperator::Subtract],
    &[BinaryOperator::Multiply, BinaryOperator::Divide],
    &[BinaryOperator::Power],
];

#[derive(Debug, Clone)]
pub(crate) enum Node {
    Literal(Value),
    /// The text of a reference as written.
    Reference(String),
    /// A name the workbook may define.
    Name(String),
    Call { name: String, args: Vec<Node> },
    /// The operand divided by a hundred `count` times.
    Percent { operand: Box<Node>, count: usize },
    /// The signs in front of the operand, outermost first: true for `-`.
    Unary { negations: Vec<bool>, operand: Box<Node> },
    /// `first op rest[0].0 rest[0].1 op ...`, read left to right.
    Chain { first: Box<Node>, rest: Vec<(BinaryOperator, Node)> },
}

struct Cursor {
    tokens: Vec<Token>,
    at: usize,
    depth: usize,
}

impl Cursor {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn take(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.at).cloned();
        if token.is_some() {
            self.at += 1;
        }
        token
    }
}

fn refuse(reason: impl Into<String>) -> UnsupportedFormula {
    UnsupportedFormula { reason: reason.into() }
}

/// Excel stores every function it gained after 2007 with an `_xlfn.` prefix, and a worksheet-only one with `_xlws.` on
/// top of that: the file holds `_xlfn.TEXTJOIN` where the author typed `TEXTJOIN`.
fn function_name(text: &str) -> String {
    let upper = text.to_uppercase();
    let without_fn = upper.strip_prefix("_XLFN.").unwrap_or(&upper);
    without_fn.strip_prefix("_XLWS.").unwrap_or(without_fn).to_owned()
}

fn parse_call_args(cursor: &mut Cursor) -> Result<Vec<Node>, UnsupportedFormula> {
    cursor.take(); // the "(" the name looked ahead to
    let mut args = Vec::new();
    if cursor.peek().is_some_and(|token| token.kind == TokenKind::Close) {
        cursor.take();
        return Ok(args);
    }
    loop {
        args.push(parse_expression(cursor)?);
        let Some(next) = cursor.take() else { return Err(refuse("the call is never closed")) };
        match next.kind {
            TokenKind::Close => return Ok(args),
            TokenKind::Comma => {}
            _ => return Err(refuse(format!("unexpected \"{}\" in a call", next.text))),
        }
    }
}

fn error_literal(text: &str) -> Value {
    // `Data!#REF!` and `#REF!B2:B4` are the error that was left where the reference was.
    let from_hash = text.rfind('#').map_or(text, |at| &text[at..]);
    let name = if from_hash.starts_with("#REF!") { "#REF!" } else { from_hash };
    cell_error_of(name).map_or_else(|| Value::Text(name.to_owned()), Value::Error)
}

fn parse_primary(cursor: &mut Cursor) -> Result<Node, UnsupportedFormula> {
    let Some(token) = cursor.take() else { return Err(refuse("the formula ends early")) };
    match token.kind {
        TokenKind::Number => Ok(Node::Literal(Value::Number(string_to_number(&token.text)))),
        TokenKind::String => {
            let inner = &token.text[1..token.text.len() - 1];
            Ok(Node::Literal(Value::Text(inner.replace("\"\"", "\"")).canonical()))
        }
        TokenKind::Error => Ok(Node::Literal(error_literal(&token.text))),
        TokenKind::Reference => Ok(Node::Reference(token.text)),
        TokenKind::Name => match token.text.to_uppercase().as_str() {
            "TRUE" => Ok(Node::Literal(Value::Bool(true))),
            "FALSE" => Ok(Node::Literal(Value::Bool(false))),
            _ => Ok(Node::Name(token.text)),
        },
        TokenKind::Call => Ok(Node::Call { name: function_name(&token.text), args: parse_call_args(cursor)? }),
        TokenKind::Open => {
            let expression = parse_expression(cursor)?;
            match cursor.take() {
                Some(closing) if closing.kind == TokenKind::Close => Ok(expression),
                _ => Err(refuse("a group is never closed")),
            }
        }
        _ => Err(refuse(format!("unexpected \"{}\"", token.text))),
    }
}

fn is_operator(token: Option<&Token>, text: &str) -> bool {
    token.is_some_and(|token| token.kind == TokenKind::Operator && token.text == text)
}

fn parse_postfix(cursor: &mut Cursor) -> Result<Node, UnsupportedFormula> {
    let node = parse_primary(cursor)?;
    let mut count = 0;
    while is_operator(cursor.peek(), "%") {
        cursor.take();
        count += 1;
    }
    Ok(if count == 0 { node } else { Node::Percent { operand: Box::new(node), count } })
}

fn parse_unary(cursor: &mut Cursor) -> Result<Node, UnsupportedFormula> {
    let mut negations = Vec::new();
    while let Some(token) = cursor.peek() {
        if token.kind != TokenKind::Operator || !(token.text == "-" || token.text == "+") {
            break;
        }
        negations.push(token.text == "-");
        cursor.take();
    }
    let operand = parse_postfix(cursor)?;
    Ok(if negations.is_empty() { operand } else { Node::Unary { negations, operand: Box::new(operand) } })
}

fn parse_level(cursor: &mut Cursor, level: usize) -> Result<Node, UnsupportedFormula> {
    let Some(operators) = LEVELS.get(level) else { return parse_unary(cursor) };
    let first = parse_level(cursor, level + 1)?;
    let mut rest = Vec::new();
    loop {
        let operator = match cursor.peek() {
            Some(token) if token.kind == TokenKind::Operator => BinaryOperator::of(&token.text).filter(|op| operators.contains(op)),
            _ => None,
        };
        let Some(operator) = operator else { break };
        cursor.take();
        rest.push((operator, parse_level(cursor, level + 1)?));
    }
    Ok(if rest.is_empty() { first } else { Node::Chain { first: Box::new(first), rest } })
}

fn parse_expression(cursor: &mut Cursor) -> Result<Node, UnsupportedFormula> {
    cursor.depth += 1;
    if cursor.depth > MAX_NESTING {
        return Err(refuse("the formula nests deeper than this engine reads"));
    }
    let node = parse_level(cursor, 0);
    cursor.depth -= 1;
    node
}

/// `parse(tokens)`.
fn parse_tokens(tokens: Vec<Token>) -> Result<Node, UnsupportedFormula> {
    let mut cursor = Cursor { tokens, at: 0, depth: 0 };
    let tree = parse_expression(&mut cursor)?;
    if let Some(token) = cursor.peek() {
        return Err(refuse(format!("unexpected \"{}\"", token.text)));
    }
    Ok(tree)
}

/// The tree of a formula text (without its leading `=`).
pub(crate) fn parse(formula: &str) -> Result<Node, UnsupportedFormula> {
    parse_tokens(tokenize(formula)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(node: &Node) -> String {
        match node {
            Node::Literal(Value::Number(number)) => number.to_string(),
            Node::Literal(Value::Text(text)) => format!("{text:?}"),
            Node::Literal(Value::Bool(flag)) => flag.to_string(),
            Node::Literal(Value::Error(error)) => error.message().to_owned(),
            Node::Literal(other) => format!("{other:?}"),
            Node::Reference(text) => text.clone(),
            Node::Name(text) => format!("name:{text}"),
            Node::Call { name, args } => format!("{name}({})", args.iter().map(shape).collect::<Vec<_>>().join(",")),
            Node::Percent { operand, count } => format!("({})%{count}", shape(operand)),
            Node::Unary { negations, operand } => {
                let signs: String = negations.iter().map(|negative| if *negative { '-' } else { '+' }).collect();
                format!("[{signs}{}]", shape(operand))
            }
            Node::Chain { first, rest } => {
                let mut out = format!("({}", shape(first));
                for (operator, operand) in rest {
                    out.push_str(&format!(" {operator:?} {}", shape(operand)));
                }
                out.push(')');
                out
            }
        }
    }

    fn shaped(formula: &str) -> String {
        shape(&parse(formula).expect("parses"))
    }

    fn refusal(formula: &str) -> String {
        parse(formula).expect_err("refused").reason
    }

    #[test]
    fn precedence_runs_comparison_concat_sum_product_power_sign_percent() {
        assert_eq!(shaped("2+3*4"), "(2 Add (3 Multiply 4))");
        assert_eq!(shaped("1+2+3"), "(1 Add 2 Add 3)");
        assert_eq!(shaped("-2^2"), "([-2] Power 2)");
        assert_eq!(shaped("2^3^2"), "(2 Power 3 Power 2)");
        assert_eq!(shaped("1&2=12"), "((1 Concat 2) Equal 12)");
        assert_eq!(shaped("A1<=B1+1"), "(A1 LessOrEqual (B1 Add 1))");
        assert_eq!(shaped("10%%"), "(10)%2");
        assert_eq!(shaped("--5%"), "[--(5)%1]");
        assert_eq!(shaped("(1+2)*3"), "((1 Add 2) Multiply 3)");
    }

    #[test]
    fn calls_strip_the_prefixes_excel_adds_and_read_their_arguments() {
        assert_eq!(shaped("sum(A1:A2,2)"), "SUM(A1:A2,2)");
        assert_eq!(shaped("_xlfn.TEXTJOIN(\"-\",TRUE,\"a\")"), "TEXTJOIN(\"-\",true,\"a\")");
        assert_eq!(shaped("_xlfn._xlws.SORT(A1)"), "SORT(A1)");
        assert_eq!(shaped("NA()"), "NA()");
        assert_eq!(shaped("ERROR.TYPE(#N/A)"), "ERROR.TYPE(#N/A)");
        assert_eq!(shaped("IF(a,\"x\"\"y\")"), "IF(name:a,\"x\\\"y\")");
    }

    #[test]
    fn deleted_references_are_the_ref_error() {
        assert_eq!(shaped("Data!#REF!"), "#REF!");
        assert_eq!(shaped("#REF!B2:B4+1"), "(#REF! Add 1)");
    }

    #[test]
    fn refusals_carry_the_node_texts() {
        assert_eq!(refusal("SUM(A1:A2"), "the call is never closed");
        assert_eq!(refusal("(1+2"), "a group is never closed");
        assert_eq!(refusal("1+"), "the formula ends early");
        assert_eq!(refusal("SUM(1 2)"), "unexpected \"2\" in a call");
        assert_eq!(refusal("1 2"), "unexpected \"2\"");
        assert_eq!(refusal("*1"), "unexpected \"*\"");
        assert_eq!(refusal("1)"), "unexpected \")\"");
        assert_eq!(refusal("1+@"), "unreadable character \"@\"");
    }

    #[test]
    fn nesting_is_bounded_and_long_chains_are_not() {
        // The formula itself is the first level, each group one more.
        let deep = format!("{}1{}", "(".repeat(MAX_NESTING), ")".repeat(MAX_NESTING));
        assert_eq!(refusal(&deep), "the formula nests deeper than this engine reads");
        let allowed = format!("{}1{}", "(".repeat(MAX_NESTING - 1), ")".repeat(MAX_NESTING - 1));
        assert!(parse(&allowed).is_ok());
        let long = vec!["1"; 20_000].join("+");
        assert!(matches!(parse(&long), Ok(Node::Chain { rest, .. }) if rest.len() == 19_999));
    }
}
