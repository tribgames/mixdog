//! The precedence parser of the formula engine: comparison, then `&`, then `+ -`, then `* /`, then `^`, then the unary
//! sign (which binds tighter than the power, so `-2^2` is 4), then the postfix `%`. A level of left-associative
//! operators is one flat chain, so a formula of ten thousand terms is not ten thousand levels of tree.

use mixdog_js::string_to_number;

use crate::token::{Token, TokenKind, tokenize};
use crate::value::{UnsupportedFormula, Value, cell_error_of};

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

/// Nodes hold arena indices, so constructing, evaluating and dropping a deeply
/// nested formula does not consume the native call stack.
#[derive(Debug, Clone)]
pub(crate) enum Node {
    Literal(Value),
    Reference(String),
    Name(String),
    Call { name: String, args: Vec<usize> },
    Percent { operand: usize, count: usize },
    Unary { negations: Vec<bool>, operand: usize },
    Chain { first: usize, rest: Vec<(BinaryOperator, usize)> },
}

#[derive(Debug, Default)]
pub(crate) struct Tree {
    pub nodes: Vec<Node>,
    pub root: usize,
}

impl Tree {
    fn push(&mut self, node: Node) -> usize {
        let id = self.nodes.len();
        self.nodes.push(node);
        id
    }

    /// Append a defined-name expression to the same arena without moving existing ids.
    pub fn append(&mut self, formula: &str) -> Result<usize, UnsupportedFormula> {
        parse_tokens(tokenize(formula)?, self)
    }
}

struct Cursor {
    tokens: Vec<Token>,
    at: usize,
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

fn error_literal(text: &str) -> Value {
    // `Data!#REF!` and `#REF!B2:B4` are the error that was left where the reference was.
    let from_hash = text.rfind('#').map_or(text, |at| &text[at..]);
    let name = if from_hash.starts_with("#REF!") { "#REF!" } else { from_hash };
    cell_error_of(name).map_or_else(|| Value::Text(name.to_owned()), Value::Error)
}

enum Work {
    Level(usize),
    Tail { level: usize, first: usize, rest: Vec<(BinaryOperator, usize)> },
    First(usize),
    Operand { level: usize, first: usize, rest: Vec<(BinaryOperator, usize)>, operator: BinaryOperator },
    Unary,
    Signs(Vec<bool>),
    Postfix,
    Primary,
    Group,
    Argument { name: String, args: Vec<usize> },
}

/// The recursive-descent grammar expressed as continuations. `last` is the
/// returned node of a child production; every continuation lives on the heap.
fn parse_tokens(tokens: Vec<Token>, tree: &mut Tree) -> Result<usize, UnsupportedFormula> {
    let mut cursor = Cursor { tokens, at: 0 };
    let mut work = vec![Work::Level(0)];
    let mut last = 0;
    while let Some(step) = work.pop() {
        match step {
            Work::Level(level) => {
                if level == LEVELS.len() {
                    work.push(Work::Unary);
                } else {
                    work.push(Work::First(level));
                    work.push(Work::Level(level + 1));
                }
            }
            Work::First(level) => work.push(Work::Tail { level, first: last, rest: Vec::new() }),
            Work::Tail { level, first, rest } => {
                let operator =
                    cursor.peek().filter(|t| t.kind == TokenKind::Operator).and_then(|t| BinaryOperator::of(&t.text)).filter(|op| LEVELS[level].contains(op));
                if let Some(operator) = operator {
                    cursor.take();
                    work.push(Work::Operand { level, first, rest, operator });
                    work.push(Work::Level(level + 1));
                } else {
                    last = if rest.is_empty() { first } else { tree.push(Node::Chain { first, rest }) };
                }
            }
            Work::Operand { level, first, mut rest, operator } => {
                rest.push((operator, last));
                work.push(Work::Tail { level, first, rest });
            }
            Work::Unary => {
                let mut signs = Vec::new();
                while cursor.peek().is_some_and(|t| t.kind == TokenKind::Operator && (t.text == "-" || t.text == "+")) {
                    signs.push(cursor.take().expect("peeked").text == "-");
                }
                work.push(Work::Signs(signs));
                work.push(Work::Postfix);
                work.push(Work::Primary);
            }
            Work::Signs(negations) => {
                if !negations.is_empty() {
                    last = tree.push(Node::Unary { negations, operand: last });
                }
            }
            Work::Postfix => {
                let mut count = 0;
                while cursor.peek().is_some_and(|t| t.kind == TokenKind::Operator && t.text == "%") {
                    cursor.take();
                    count += 1;
                }
                if count != 0 {
                    last = tree.push(Node::Percent { operand: last, count });
                }
            }
            Work::Primary => {
                let token = cursor.take().ok_or_else(|| refuse("the formula ends early"))?;
                let node = match token.kind {
                    TokenKind::Number => Node::Literal(Value::Number(string_to_number(&token.text))),
                    TokenKind::String => Node::Literal(Value::Text(token.text[1..token.text.len() - 1].replace("\"\"", "\"")).canonical()),
                    TokenKind::Error => Node::Literal(error_literal(&token.text)),
                    TokenKind::Reference => Node::Reference(token.text),
                    TokenKind::Name => match token.text.to_uppercase().as_str() {
                        "TRUE" => Node::Literal(Value::Bool(true)),
                        "FALSE" => Node::Literal(Value::Bool(false)),
                        _ => Node::Name(token.text),
                    },
                    TokenKind::Open => {
                        work.push(Work::Group);
                        work.push(Work::Level(0));
                        continue;
                    }
                    TokenKind::Call => {
                        cursor.take(); // the opening parenthesis seen by the tokenizer
                        let name = function_name(&token.text);
                        if cursor.peek().is_some_and(|t| t.kind == TokenKind::Close) {
                            cursor.take();
                            Node::Call { name, args: Vec::new() }
                        } else {
                            work.push(Work::Argument { name, args: Vec::new() });
                            work.push(Work::Level(0));
                            continue;
                        }
                    }
                    _ => return Err(refuse(format!("unexpected \"{}\"", token.text))),
                };
                last = tree.push(node);
            }
            Work::Group => {
                if !cursor.take().is_some_and(|t| t.kind == TokenKind::Close) {
                    return Err(refuse("a group is never closed"));
                }
            }
            Work::Argument { name, mut args } => {
                args.push(last);
                let next = cursor.take().ok_or_else(|| refuse("the call is never closed"))?;
                match next.kind {
                    TokenKind::Close => last = tree.push(Node::Call { name, args }),
                    TokenKind::Comma => {
                        work.push(Work::Argument { name, args });
                        work.push(Work::Level(0));
                    }
                    _ => return Err(refuse(format!("unexpected \"{}\" in a call", next.text))),
                }
            }
        }
    }
    if let Some(token) = cursor.peek() {
        return Err(refuse(format!("unexpected \"{}\"", token.text)));
    }
    Ok(last)
}

pub(crate) fn parse(formula: &str) -> Result<Tree, UnsupportedFormula> {
    let mut tree = Tree::default();
    tree.root = tree.append(formula)?;
    Ok(tree)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(tree: &Tree, id: usize) -> String {
        match &tree.nodes[id] {
            Node::Literal(Value::Number(number)) => number.to_string(),
            Node::Literal(Value::Text(text)) => format!("{text:?}"),
            Node::Literal(Value::Bool(flag)) => flag.to_string(),
            Node::Literal(Value::Error(error)) => error.message().to_owned(),
            Node::Literal(other) => format!("{other:?}"),
            Node::Reference(text) => text.clone(),
            Node::Name(text) => format!("name:{text}"),
            Node::Call { name, args } => format!("{name}({})", args.iter().map(|id| shape(tree, *id)).collect::<Vec<_>>().join(",")),
            Node::Percent { operand, count } => format!("({})%{count}", shape(tree, *operand)),
            Node::Unary { negations, operand } => {
                let signs: String = negations.iter().map(|negative| if *negative { '-' } else { '+' }).collect();
                format!("[{signs}{}]", shape(tree, *operand))
            }
            Node::Chain { first, rest } => {
                let mut out = format!("({}", shape(tree, *first));
                for (operator, operand) in rest {
                    out.push_str(&format!(" {operator:?} {}", shape(tree, *operand)));
                }
                out.push(')');
                out
            }
        }
    }

    fn shaped(formula: &str) -> String {
        let tree = parse(formula).expect("parses");
        shape(&tree, tree.root)
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
    fn deep_nesting_and_long_chains_use_heap_storage() {
        let deep = format!("{}1{}", "(".repeat(20_000), ")".repeat(20_000));
        assert!(parse(&deep).is_ok());
        let calls = format!("{}1{}", "ABS(".repeat(20_000), ")".repeat(20_000));
        assert!(parse(&calls).is_ok());
        let long = vec!["1"; 20_000].join("+");
        let tree = parse(&long).unwrap();
        assert!(matches!(&tree.nodes[tree.root], Node::Chain { rest, .. } if rest.len() == 19_999));
    }
}
