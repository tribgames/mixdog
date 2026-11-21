//! PostScript calculator functions (PDF function type 4) as pdf.js 6.4 evaluates them.
//!
//! pdf.js parses the program (`postscript/lexer.js`, `postscript/ast.js`), rebuilds its stack effect as an expression
//! tree with constant folding and common-subexpression marking (`PSStackToTree`), and runs the tree as WebAssembly
//! (`wasm_compiler.js`: the default, `useWasm`) or, when no tree can be built, with its stack interpreter
//! (`PSStackBasedInterpreter`). The tree changes results in places (constant folding, `x 2 exp` as `x * x`, `mod` as
//! `a - trunc(a / b) * b`, `sin` and `cos` after a truncating modulo), so this module builds the same tree, emits the
//! same instruction sequence as a small stack code and interprets that, with the wasm operations' semantics (a
//! conversion of `NaN` or of an out-of-range number to an integer traps and is an error here). `min` and `max` are not
//! PostScript tokens of pdf.js's lexer (an unknown word reads as the number 0), and the tree only creates them from
//! `if` patterns.
//!
//! The math functions are `mixdog_js::math` where it has V8's algorithms (`pow`, `ln`, `min`, `max`, `round`); `sin`,
//! `cos`, `atan2` and `log10` are the platform's, which agree with V8's fdlibm except in the last bit on a few inputs.
//!
//! Not carried over: the interpreter fallback keeps its stack in the call (pdf.js shares one static array across
//! functions, so a program that reads below its own stack sees values of an earlier call); a program of more than
//! [`MAX_COMPILED_TOKENS`] tokens goes straight to the interpreter (the tree builder recurses).

use std::cell::RefCell;
use std::collections::HashMap;

use mixdog_js::math as js;

use crate::error::{Guard, PdfError, Result};

/// `MAX_STACK_SIZE` of pdf.js's tree builder and the size of its interpreter's stack.
const MAX_STACK_SIZE: usize = 100;
/// Programs longer than this are not turned into a tree (the recursion of the builder is bounded by it).
pub const MAX_COMPILED_TOKENS: usize = 4096;
/// Nesting of `{ }` blocks one program may have.
const MAX_BLOCK_DEPTH: usize = 256;
const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;
const RAD_TO_DEG: f64 = 180.0 / std::f64::consts::PI;

fn format_error(message: &str) -> PdfError {
    PdfError::Format(message.to_owned())
}

// ---- tokens and the program ----------------------------------------------------------------------------------------

/// The operators of pdf.js's `TOKEN` table (`min` and `max` only occur inside the tree).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    True,
    False,
    Add,
    Sub,
    Mul,
    Div,
    Idiv,
    Mod,
    Exp,
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    And,
    Or,
    Xor,
    Bitshift,
    Abs,
    Neg,
    Ceiling,
    Floor,
    Round,
    Truncate,
    Not,
    Sqrt,
    Sin,
    Cos,
    Ln,
    Log,
    Atan,
    Cvi,
    Cvr,
    Dup,
    Exch,
    Pop,
    Copy,
    Index,
    Roll,
    If,
    IfElse,
    Min,
    Max,
}

fn operator_named(name: &str) -> Option<Op> {
    Some(match name {
        "true" => Op::True,
        "false" => Op::False,
        "add" => Op::Add,
        "sub" => Op::Sub,
        "mul" => Op::Mul,
        "div" => Op::Div,
        "idiv" => Op::Idiv,
        "mod" => Op::Mod,
        "exp" => Op::Exp,
        "eq" => Op::Eq,
        "ne" => Op::Ne,
        "gt" => Op::Gt,
        "ge" => Op::Ge,
        "lt" => Op::Lt,
        "le" => Op::Le,
        "and" => Op::And,
        "or" => Op::Or,
        "xor" => Op::Xor,
        "bitshift" => Op::Bitshift,
        "abs" => Op::Abs,
        "neg" => Op::Neg,
        "ceiling" => Op::Ceiling,
        "floor" => Op::Floor,
        "round" => Op::Round,
        "truncate" => Op::Truncate,
        "not" => Op::Not,
        "sqrt" => Op::Sqrt,
        "sin" => Op::Sin,
        "cos" => Op::Cos,
        "ln" => Op::Ln,
        "log" => Op::Log,
        "atan" => Op::Atan,
        "cvi" => Op::Cvi,
        "cvr" => Op::Cvr,
        "dup" => Op::Dup,
        "exch" => Op::Exch,
        "pop" => Op::Pop,
        "copy" => Op::Copy,
        "index" => Op::Index,
        "roll" => Op::Roll,
        "if" => Op::If,
        "ifelse" => Op::IfElse,
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug)]
enum Tok {
    Number(f64),
    LBrace,
    RBrace,
    Op(Op),
    Eof,
}

/// `postscript/lexer.js`.
struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn skip_comment(&mut self) {
        let from = &self.data[self.pos..];
        let lf = from.iter().position(|&b| b == b'\n').map(|i| self.pos + i);
        let cr = from.iter().position(|&b| b == b'\r').map(|i| self.pos + i);
        let end = self.data.len();
        let eol = lf.unwrap_or(end).min(cr.unwrap_or(end));
        self.pos = (eol + 1).min(end);
    }

    /// `/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iy` at the position: the length of the match.
    fn number_match(&self) -> Option<usize> {
        let d = self.data;
        let mut i = self.pos;
        if i < d.len() && (d[i] == b'+' || d[i] == b'-') {
            i += 1;
        }
        let digits = |mut at: usize| {
            let start = at;
            while at < d.len() && d[at].is_ascii_digit() {
                at += 1;
            }
            (at, at > start)
        };
        let (after_int, has_int) = digits(i);
        if has_int {
            i = after_int;
            if i < d.len() && d[i] == b'.' {
                i = digits(i + 1).0;
            }
        } else if i < d.len() && d[i] == b'.' {
            let (after_frac, has_frac) = digits(i + 1);
            if !has_frac {
                return None;
            }
            i = after_frac;
        } else {
            return None;
        }
        if i < d.len() && (d[i] == b'e' || d[i] == b'E') {
            let mut j = i + 1;
            if j < d.len() && (d[j] == b'+' || d[j] == b'-') {
                j += 1;
            }
            let (after_exp, has_exp) = digits(j);
            if has_exp {
                i = after_exp;
            }
        }
        Some(i - self.pos)
    }

    /// `_getNumber`. pdf.js answers 0 without moving when there is no number (or it is not finite) and so never
    /// leaves the word; that is an error here.
    fn get_number(&mut self) -> Result<Tok> {
        let len = self.number_match().ok_or_else(|| format_error("PostScript function: unreadable number."))?;
        let text = std::str::from_utf8(&self.data[self.pos..self.pos + len]).map_err(|_| format_error("PostScript function: unreadable number."))?;
        let number: f64 = text.parse().map_err(|_| format_error("PostScript function: unreadable number."))?;
        if !number.is_finite() {
            return Err(format_error("PostScript function: unreadable number."));
        }
        self.pos += len;
        Ok(Tok::Number(number))
    }

    /// `_getOperator`: a word of `a-z`; one that is not an operator reads as the number 0.
    fn get_operator(&mut self) -> Tok {
        let start = self.pos;
        while self.pos < self.data.len() && self.data[self.pos].is_ascii_lowercase() {
            self.pos += 1;
        }
        let word = std::str::from_utf8(&self.data[start..self.pos]).unwrap_or("");
        match operator_named(word) {
            Some(op) => Tok::Op(op),
            None => Tok::Number(0.0),
        }
    }

    fn next(&mut self) -> Result<Tok> {
        while self.pos < self.data.len() {
            let ch = self.data[self.pos];
            self.pos += 1;
            match ch {
                0x00 | 0x09 | 0x0a | 0x0c | 0x0d | 0x20 => {}
                0x25 => self.skip_comment(),
                0x7b => return Ok(Tok::LBrace),
                0x7d => return Ok(Tok::RBrace),
                0x2b | 0x2d | 0x2e | b'0'..=b'9' => {
                    self.pos -= 1;
                    return self.get_number();
                }
                b'a'..=b'z' => {
                    self.pos -= 1;
                    return Ok(self.get_operator());
                }
                _ => return Ok(Tok::Number(0.0)),
            }
        }
        Ok(Tok::Eof)
    }
}

#[derive(Clone, Debug)]
enum Instr {
    Number(f64),
    Op(Op),
    If(Vec<Instr>),
    IfElse(Vec<Instr>, Vec<Instr>),
}

/// `postscript/ast.js` `Parser`.
struct Parser<'a> {
    lexer: Lexer<'a>,
    token: Tok,
    count: usize,
}

impl<'a> Parser<'a> {
    fn advance(&mut self) -> Result<()> {
        self.token = self.lexer.next()?;
        Ok(())
    }

    fn expect_rbrace(&mut self) -> Result<()> {
        if !matches!(self.token, Tok::RBrace) {
            return Err(format_error("PostScript function: expected token id 2."));
        }
        self.advance()
    }

    fn parse(&mut self) -> Result<Vec<Instr>> {
        self.advance()?;
        if !matches!(self.token, Tok::LBrace) {
            return Err(format_error("PostScript function: expected token id 1."));
        }
        self.advance()?;
        let block = self.parse_block(0)?;
        self.expect_rbrace()?;
        if !matches!(self.token, Tok::Eof) {
            tracing::debug!("PostScript function: unexpected content after closing brace.");
        }
        Ok(block)
    }

    fn parse_block(&mut self, depth: usize) -> Result<Vec<Instr>> {
        if depth > MAX_BLOCK_DEPTH {
            return Err(format_error("PostScript function: blocks nested too deeply."));
        }
        let mut instructions = Vec::new();
        loop {
            self.count += 1;
            match self.token {
                Tok::Number(value) => {
                    instructions.push(Instr::Number(value));
                    self.advance()?;
                }
                Tok::LBrace => {
                    self.advance()?;
                    let then_block = self.parse_block(depth + 1)?;
                    self.expect_rbrace()?;
                    match self.token {
                        Tok::Op(Op::If) => {
                            self.advance()?;
                            instructions.push(Instr::If(then_block));
                        }
                        Tok::LBrace => {
                            self.advance()?;
                            let else_block = self.parse_block(depth + 1)?;
                            self.expect_rbrace()?;
                            if !matches!(self.token, Tok::Op(Op::IfElse)) {
                                return Err(format_error("PostScript function: expected token id 44."));
                            }
                            self.advance()?;
                            instructions.push(Instr::IfElse(then_block, else_block));
                        }
                        _ => {
                            return Err(format_error("PostScript function: a procedure block must be followed by 'if' or '{…} ifelse'."));
                        }
                    }
                }
                Tok::RBrace | Tok::Eof => return Ok(instructions),
                Tok::Op(Op::If) | Tok::Op(Op::IfElse) => {
                    return Err(format_error("PostScript function: unexpected 'if' operator."));
                }
                Tok::Op(op) => {
                    instructions.push(Instr::Op(op));
                    self.advance()?;
                }
            }
        }
    }
}

// ---- JavaScript values ---------------------------------------------------------------------------------------------

/// A constant of the tree: a JavaScript number or boolean.
#[derive(Clone, Copy, Debug)]
enum Val {
    Num(f64),
    Bool(bool),
}

impl Val {
    fn num(self) -> f64 {
        match self {
            Val::Num(n) => n,
            Val::Bool(true) => 1.0,
            Val::Bool(false) => 0.0,
        }
    }

    fn truthy(self) -> bool {
        match self {
            Val::Num(n) => n != 0.0 && !n.is_nan(),
            Val::Bool(b) => b,
        }
    }

    /// `===`.
    fn strict_eq(self, other: Val) -> bool {
        match (self, other) {
            (Val::Num(a), Val::Num(b)) => a == b,
            (Val::Bool(a), Val::Bool(b)) => a == b,
            _ => false,
        }
    }

    fn is_num(self, expected: f64) -> bool {
        matches!(self, Val::Num(n) if n == expected)
    }

    fn is_bool(self, expected: bool) -> bool {
        matches!(self, Val::Bool(b) if b == expected)
    }
}

/// `ToInt32`.
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let mut m = x.trunc() % 4_294_967_296.0;
    if m < 0.0 {
        m += 4_294_967_296.0;
    }
    (m as u64 as u32) as i32
}

fn js_atan_degrees(y: f64, x: f64) -> f64 {
    let degrees = y.atan2(x) * RAD_TO_DEG;
    if degrees < 0.0 { degrees + 360.0 } else { degrees }
}

fn js_sin_cos_argument(v: f64) -> f64 {
    v % 360.0 * std::f64::consts::PI / 180.0
}

/// `_evalBinaryConst`: `a` is the deeper operand, `b` the top one.
fn eval_binary_const(op: Op, a: Val, b: Val) -> Option<Val> {
    let (x, y) = (a.num(), b.num());
    let zero_divisor = b.is_num(0.0);
    Some(match op {
        Op::Add => Val::Num(x + y),
        Op::Sub => Val::Num(x - y),
        Op::Mul => Val::Num(x * y),
        Op::Div => Val::Num(if !zero_divisor { x / y } else { 0.0 }),
        Op::Idiv => Val::Num(if !zero_divisor { (x / y).trunc() } else { 0.0 }),
        Op::Mod => Val::Num(if !zero_divisor { x - (x / y).trunc() * y } else { 0.0 }),
        Op::Exp => {
            let r = js::pow(x, y);
            if r.is_finite() {
                Val::Num(r)
            } else {
                return None;
            }
        }
        Op::Atan => Val::Num(js_atan_degrees(x, y)),
        Op::Eq => Val::Bool(a.strict_eq(b)),
        Op::Ne => Val::Bool(!a.strict_eq(b)),
        Op::Gt => Val::Bool(x > y),
        Op::Ge => Val::Bool(x >= y),
        Op::Lt => Val::Bool(x < y),
        Op::Le => Val::Bool(x <= y),
        Op::And => match a {
            Val::Bool(_) => {
                if a.truthy() {
                    b
                } else {
                    a
                }
            }
            Val::Num(_) => Val::Num(f64::from(to_int32(x) & to_int32(y))),
        },
        Op::Or => match a {
            Val::Bool(_) => {
                if a.truthy() {
                    a
                } else {
                    b
                }
            }
            Val::Num(_) => Val::Num(f64::from(to_int32(x) | to_int32(y))),
        },
        Op::Xor => match a {
            Val::Bool(_) => Val::Bool(!a.strict_eq(b)),
            Val::Num(_) => Val::Num(f64::from(to_int32(x) ^ to_int32(y))),
        },
        Op::Bitshift => {
            let count = (to_int32(y) as u32) & 31;
            if y >= 0.0 {
                Val::Num(f64::from(to_int32(x).wrapping_shl(count)))
            } else {
                let count = (to_int32(-y) as u32) & 31;
                Val::Num(f64::from(to_int32(x) >> count))
            }
        }
        Op::Min => Val::Num(js::min(x, y)),
        Op::Max => Val::Num(js::max(x, y)),
        _ => return None,
    })
}

/// `_evalUnaryConst`.
fn eval_unary_const(op: Op, v: Val) -> Option<Val> {
    let x = v.num();
    Some(match op {
        Op::Abs => Val::Num(x.abs()),
        Op::Neg => Val::Num(-x),
        Op::Ceiling => Val::Num(x.ceil()),
        Op::Floor => Val::Num(x.floor()),
        Op::Round => Val::Num(js::round(x)),
        Op::Truncate => Val::Num(x.trunc()),
        Op::Sqrt => {
            let r = x.sqrt();
            if r.is_finite() {
                Val::Num(r)
            } else {
                return None;
            }
        }
        Op::Sin => Val::Num(js_sin_cos_argument(x).sin()),
        Op::Cos => Val::Num(js_sin_cos_argument(x).cos()),
        Op::Ln => {
            let r = js::ln(x);
            if r.is_finite() {
                Val::Num(r)
            } else {
                return None;
            }
        }
        Op::Log => {
            let r = x.log10();
            if r.is_finite() {
                Val::Num(r)
            } else {
                return None;
            }
        }
        Op::Cvi => Val::Num(x.trunc()),
        Op::Cvr => v,
        Op::Not => match v {
            Val::Bool(b) => Val::Bool(!b),
            Val::Num(_) => Val::Num(f64::from(!to_int32(x))),
        },
        _ => return None,
    })
}

// ---- the expression tree (`PSStackToTree`) -------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ValueType {
    Numeric,
    Boolean,
    Unknown,
}

type Id = usize;

#[derive(Clone, Copy, Debug)]
enum Kind {
    Arg(usize),
    Const(Val),
    Unary { op: Op, operand: Id },
    Binary { op: Op, first: Id, second: Id },
    Ternary { cond: Id, then: Id, otherwise: Id },
}

#[derive(Clone, Copy, Debug)]
struct Node {
    kind: Kind,
    value_type: ValueType,
    shared: bool,
    shared_count: u32,
}

fn unary_value_type(op: Op, operand: ValueType) -> ValueType {
    if op == Op::Not { operand } else { ValueType::Numeric }
}

fn binary_value_type(op: Op, first: ValueType, second: ValueType) -> ValueType {
    match op {
        Op::Eq | Op::Ne | Op::Gt | Op::Ge | Op::Lt | Op::Le => ValueType::Boolean,
        Op::And | Op::Or | Op::Xor => {
            if first == second && first != ValueType::Unknown {
                first
            } else {
                ValueType::Unknown
            }
        }
        _ => ValueType::Numeric,
    }
}

fn is_binary_op(op: Op) -> bool {
    matches!(
        op,
        Op::Add
            | Op::Sub
            | Op::Mul
            | Op::Div
            | Op::Idiv
            | Op::Mod
            | Op::Exp
            | Op::Atan
            | Op::Eq
            | Op::Ne
            | Op::Gt
            | Op::Ge
            | Op::Lt
            | Op::Le
            | Op::And
            | Op::Or
            | Op::Xor
            | Op::Bitshift
    )
}

fn is_unary_op(op: Op) -> bool {
    matches!(
        op,
        Op::Abs | Op::Neg | Op::Ceiling | Op::Floor | Op::Round | Op::Truncate | Op::Sqrt | Op::Sin | Op::Cos | Op::Ln | Op::Log | Op::Cvi | Op::Cvr | Op::Not
    )
}

fn is_idempotent_unary(op: Op) -> bool {
    matches!(op, Op::Abs | Op::Ceiling | Op::Cvi | Op::Cvr | Op::Floor | Op::Round | Op::Truncate)
}

fn negated_comparison(op: Op) -> Option<Op> {
    Some(match op {
        Op::Eq => Op::Ne,
        Op::Ne => Op::Eq,
        Op::Lt => Op::Ge,
        Op::Le => Op::Gt,
        Op::Gt => Op::Le,
        Op::Ge => Op::Lt,
        _ => return None,
    })
}

struct Tree<'g> {
    nodes: Vec<Node>,
    failed: bool,
    error: Option<PdfError>,
    guard: &'g Guard,
}

impl<'g> Tree<'g> {
    fn add(&mut self, kind: Kind, value_type: ValueType) -> Id {
        self.nodes.push(Node { kind, value_type, shared: false, shared_count: 0 });
        self.nodes.len() - 1
    }

    fn constant(&mut self, value: Val) -> Id {
        let value_type = if matches!(value, Val::Bool(_)) { ValueType::Boolean } else { ValueType::Numeric };
        self.add(Kind::Const(value), value_type)
    }

    fn const_value(&self, id: Id) -> Option<Val> {
        match self.nodes[id].kind {
            Kind::Const(v) => Some(v),
            _ => None,
        }
    }

    fn vt(&self, id: Id) -> ValueType {
        self.nodes[id].value_type
    }

    /// `_nodesEqual`.
    fn nodes_equal(&self, a: Id, b: Id) -> bool {
        if a == b {
            return true;
        }
        match (self.nodes[a].kind, self.nodes[b].kind) {
            (Kind::Arg(x), Kind::Arg(y)) => x == y,
            (Kind::Const(x), Kind::Const(y)) => x.strict_eq(y),
            (Kind::Unary { op: o1, operand: p1 }, Kind::Unary { op: o2, operand: p2 }) => o1 == o2 && self.nodes_equal(p1, p2),
            (Kind::Binary { op: o1, first: f1, second: s1 }, Kind::Binary { op: o2, first: f2, second: s2 }) => {
                o1 == o2 && self.nodes_equal(f1, f2) && self.nodes_equal(s1, s2)
            }
            (Kind::Ternary { cond: c1, then: t1, otherwise: e1 }, Kind::Ternary { cond: c2, then: t2, otherwise: e2 }) => {
                self.nodes_equal(c1, c2) && self.nodes_equal(t1, t2) && self.nodes_equal(e1, e2)
            }
            _ => false,
        }
    }

    fn make_binary(&mut self, op: Op, first: Id, second: Id) -> Id {
        if let (Some(f), Some(s)) = (self.const_value(first), self.const_value(second))
            && let Some(v) = eval_binary_const(op, s, f)
        {
            return self.constant(v);
        }
        if self.nodes_equal(first, second)
            && let Some(id) = self.simplify_equal_operands(op, first)
        {
            return id;
        }
        if let Some(b) = self.const_value(first)
            && let Some(id) = self.simplify_constant_first(op, b, first, second)
        {
            return id;
        }
        if let Some(a) = self.const_value(second)
            && let Some(id) = self.simplify_constant_second(op, a, first, second)
        {
            return id;
        }
        let value_type = binary_value_type(op, self.vt(first), self.vt(second));
        self.add(Kind::Binary { op, first, second }, value_type)
    }

    fn simplify_equal_operands(&mut self, op: Op, operand: Id) -> Option<Id> {
        Some(match op {
            Op::Sub => self.constant(Val::Num(0.0)),
            Op::Xor => {
                let boolean = self.vt(operand) == ValueType::Boolean;
                self.constant(if boolean { Val::Bool(false) } else { Val::Num(0.0) })
            }
            Op::And | Op::Or | Op::Min | Op::Max => operand,
            Op::Eq | Op::Ge | Op::Le => self.constant(Val::Bool(true)),
            Op::Ne | Op::Gt | Op::Lt => self.constant(Val::Bool(false)),
            _ => return None,
        })
    }

    /// `b` is the value of `first`, the top operand.
    fn simplify_constant_first(&mut self, op: Op, b: Val, first: Id, second: Id) -> Option<Id> {
        Some(match op {
            Op::Add if b.is_num(0.0) => second,
            Op::Sub if b.is_num(0.0) => second,
            Op::Mul => {
                if b.is_num(1.0) {
                    second
                } else if b.is_num(0.0) {
                    first
                } else if b.is_num(-1.0) {
                    self.make_unary(Op::Neg, second)
                } else {
                    return None;
                }
            }
            Op::Div if !b.is_num(0.0) => {
                let reciprocal = self.constant(Val::Num(1.0 / b.num()));
                self.make_binary(Op::Mul, reciprocal, second)
            }
            Op::Idiv if b.is_num(1.0) => second,
            Op::Exp => {
                if b.is_num(1.0) {
                    second
                } else if b.is_num(-1.0) {
                    let one = self.constant(Val::Num(1.0));
                    self.make_binary(Op::Div, second, one)
                } else if b.is_num(0.5) {
                    self.make_unary(Op::Sqrt, second)
                } else if b.is_num(0.25) {
                    let once = self.make_unary(Op::Sqrt, second);
                    self.make_unary(Op::Sqrt, once)
                } else if b.is_num(2.0) {
                    self.make_binary(Op::Mul, second, second)
                } else if b.is_num(3.0) {
                    let square = self.make_binary(Op::Mul, second, second);
                    self.make_binary(Op::Mul, square, second)
                } else if b.is_num(4.0) {
                    let square = self.make_binary(Op::Mul, second, second);
                    self.make_binary(Op::Mul, square, square)
                } else if b.is_num(0.0) {
                    self.constant(Val::Num(1.0))
                } else {
                    return None;
                }
            }
            Op::And => {
                if b.is_bool(true) {
                    second
                } else if b.is_bool(false) {
                    first
                } else {
                    return None;
                }
            }
            Op::Or => {
                if b.is_bool(false) {
                    second
                } else if b.is_bool(true) {
                    first
                } else {
                    return None;
                }
            }
            Op::Min => {
                if let Kind::Binary { op: Op::Max, first: inner, .. } = self.nodes[second].kind
                    && let Some(v) = self.const_value(inner)
                    && v.num() >= b.num()
                {
                    first
                } else {
                    return None;
                }
            }
            Op::Max => {
                if let Kind::Binary { op: Op::Min, first: inner, .. } = self.nodes[second].kind
                    && let Some(v) = self.const_value(inner)
                    && v.num() <= b.num()
                {
                    first
                } else {
                    return None;
                }
            }
            _ => return None,
        })
    }

    /// `a` is the value of `second`, the deeper operand.
    fn simplify_constant_second(&mut self, op: Op, a: Val, first: Id, second: Id) -> Option<Id> {
        Some(match op {
            Op::Add if a.is_num(0.0) => first,
            Op::Sub if a.is_num(0.0) => self.make_unary(Op::Neg, first),
            Op::Mul => {
                if a.is_num(1.0) {
                    first
                } else if a.is_num(0.0) {
                    second
                } else if a.is_num(-1.0) {
                    self.make_unary(Op::Neg, first)
                } else {
                    return None;
                }
            }
            Op::And => {
                if a.is_bool(true) {
                    first
                } else if a.is_bool(false) {
                    second
                } else {
                    return None;
                }
            }
            Op::Or => {
                if a.is_bool(false) {
                    first
                } else if a.is_bool(true) {
                    second
                } else {
                    return None;
                }
            }
            _ => return None,
        })
    }

    fn make_unary(&mut self, op: Op, operand: Id) -> Id {
        if let Some(v) = self.const_value(operand)
            && let Some(folded) = eval_unary_const(op, v)
        {
            return self.constant(folded);
        }
        if op == Op::Not
            && let Kind::Binary { op: inner, first, second } = self.nodes[operand].kind
            && let Some(negated) = negated_comparison(inner)
        {
            return self.add(Kind::Binary { op: negated, first, second }, ValueType::Boolean);
        }
        if op == Op::Neg
            && let Kind::Binary { op: Op::Sub, first, second } = self.nodes[operand].kind
        {
            return self.make_binary(Op::Sub, second, first);
        }
        if let Kind::Unary { op: inner, operand: deeper } = self.nodes[operand].kind {
            if (op == Op::Neg && inner == Op::Neg) || (op == Op::Not && inner == Op::Not) {
                return deeper;
            }
            if op == Op::Abs && inner == Op::Neg {
                return self.make_unary(Op::Abs, deeper);
            }
            if is_idempotent_unary(op) && op == inner {
                return operand;
            }
        }
        let value_type = unary_value_type(op, self.vt(operand));
        self.add(Kind::Unary { op, operand }, value_type)
    }

    fn make_ternary(&mut self, cond: Id, then: Id, otherwise: Id) -> Id {
        if let Some(v) = self.const_value(cond) {
            return if v.truthy() { then } else { otherwise };
        }
        if self.nodes_equal(then, otherwise) {
            return then;
        }
        if let (Some(t), Some(e)) = (self.const_value(then), self.const_value(otherwise)) {
            if t.is_bool(true) && e.is_bool(false) {
                return cond;
            }
            if t.is_bool(false) && e.is_bool(true) {
                return self.make_unary(Op::Not, cond);
            }
        }
        if let Kind::Binary { op: cop, first: cf, second: cs } = self.nodes[cond].kind {
            if cop == Op::Gt || cop == Op::Ge {
                if self.nodes_equal(then, cf) && self.nodes_equal(otherwise, cs) {
                    return self.make_binary(Op::Min, cf, cs);
                }
                if self.nodes_equal(then, cs) && self.nodes_equal(otherwise, cf) {
                    return self.make_binary(Op::Max, cf, cs);
                }
            } else if cop == Op::Lt || cop == Op::Le {
                if self.nodes_equal(then, cf) && self.nodes_equal(otherwise, cs) {
                    return self.make_binary(Op::Max, cf, cs);
                }
                if self.nodes_equal(then, cs) && self.nodes_equal(otherwise, cf) {
                    return self.make_binary(Op::Min, cf, cs);
                }
            }
        }
        let value_type = if self.vt(then) == self.vt(otherwise) { self.vt(then) } else { ValueType::Unknown };
        self.add(Kind::Ternary { cond, then, otherwise }, value_type)
    }

    fn fail(&mut self) {
        self.failed = true;
    }

    fn eval_block_from(&mut self, instructions: &[Instr], start: usize, stack: &mut Vec<Id>) {
        let mut idx = start;
        while idx < instructions.len() {
            if self.failed {
                break;
            }
            if let Err(error) = self.guard.tick() {
                self.error = Some(error);
                self.fail();
                break;
            }
            match &instructions[idx] {
                Instr::Number(value) => {
                    let id = self.constant(Val::Num(*value));
                    stack.push(id);
                    if stack.len() > MAX_STACK_SIZE {
                        self.fail();
                    }
                }
                Instr::Op(op) => self.eval_op(*op, stack),
                Instr::If(then_block) => {
                    let Some(cond) = stack.pop() else {
                        self.fail();
                        break;
                    };
                    let saved = stack.clone();
                    self.eval_block_from(then_block, 0, stack);
                    if self.failed {
                        break;
                    }
                    if stack.len() == saved.len() {
                        for i in 0..stack.len() {
                            if stack[i] != saved[i] {
                                stack[i] = self.make_ternary(cond, stack[i], saved[i]);
                            }
                        }
                    } else if stack.len() > saved.len() {
                        if let Some(v) = self.const_value(cond) {
                            if !v.truthy() {
                                *stack = saved;
                            }
                            idx += 1;
                            continue;
                        }
                        let mut true_stack = stack.clone();
                        self.eval_block_from(instructions, idx + 1, &mut true_stack);
                        if self.failed {
                            break;
                        }
                        let mut false_stack = saved;
                        self.eval_block_from(instructions, idx + 1, &mut false_stack);
                        if self.failed {
                            break;
                        }
                        self.pad_equal(&mut true_stack, &mut false_stack);
                        stack.clear();
                        for i in 0..true_stack.len() {
                            let joined = self.make_ternary(cond, true_stack[i], false_stack[i]);
                            stack.push(joined);
                        }
                        return;
                    } else {
                        self.fail();
                    }
                }
                Instr::IfElse(then_block, else_block) => {
                    let Some(cond) = stack.pop() else {
                        self.fail();
                        break;
                    };
                    let mut then_stack = stack.clone();
                    self.eval_block_from(then_block, 0, &mut then_stack);
                    if self.failed {
                        break;
                    }
                    let mut else_stack = stack.clone();
                    self.eval_block_from(else_block, 0, &mut else_stack);
                    if self.failed {
                        break;
                    }
                    self.pad_equal(&mut then_stack, &mut else_stack);
                    stack.clear();
                    for i in 0..then_stack.len() {
                        let joined = self.make_ternary(cond, then_stack[i], else_stack[i]);
                        stack.push(joined);
                    }
                }
            }
            idx += 1;
        }
    }

    fn pad_equal(&mut self, a: &mut Vec<Id>, b: &mut Vec<Id>) {
        if a.len() != b.len() {
            let zero = self.constant(Val::Num(0.0));
            while a.len() < b.len() {
                a.push(zero);
            }
            while b.len() < a.len() {
                b.push(zero);
            }
        }
    }

    fn eval_op(&mut self, op: Op, stack: &mut Vec<Id>) {
        if is_binary_op(op) {
            if stack.len() < 2 {
                self.fail();
                return;
            }
            let first = stack.pop().unwrap_or(0);
            let second = stack.pop().unwrap_or(0);
            let id = self.make_binary(op, first, second);
            stack.push(id);
            return;
        }
        if is_unary_op(op) {
            let Some(operand) = stack.pop() else {
                self.fail();
                return;
            };
            let id = self.make_unary(op, operand);
            stack.push(id);
            return;
        }
        match op {
            Op::True | Op::False => {
                let id = self.constant(Val::Bool(op == Op::True));
                stack.push(id);
                if stack.len() > MAX_STACK_SIZE {
                    self.fail();
                }
            }
            Op::Dup => match stack.last().copied() {
                None => self.fail(),
                Some(top) => {
                    stack.push(top);
                    if stack.len() > MAX_STACK_SIZE {
                        self.fail();
                    }
                }
            },
            Op::Exch => {
                if stack.len() < 2 {
                    self.fail();
                    return;
                }
                let a = stack.pop().unwrap_or(0);
                let b = stack.pop().unwrap_or(0);
                stack.push(a);
                stack.push(b);
            }
            Op::Pop => {
                if stack.pop().is_none() {
                    self.fail();
                }
            }
            Op::Copy => {
                let Some(n_node) = stack.pop() else {
                    self.fail();
                    return;
                };
                match self.const_value(n_node) {
                    Some(v) => {
                        let n = i64::from(to_int32(v.num()));
                        if n == 0 {
                        } else if n < 0 || n > stack.len() as i64 {
                            self.fail();
                        } else {
                            let from = stack.len() - n as usize;
                            let tail: Vec<Id> = stack[from..].to_vec();
                            stack.extend(tail);
                            if stack.len() > MAX_STACK_SIZE {
                                self.fail();
                            }
                        }
                    }
                    None => self.fail(),
                }
            }
            Op::Index => {
                let Some(n_node) = stack.pop() else {
                    self.fail();
                    return;
                };
                match self.const_value(n_node) {
                    Some(v) => {
                        let n = i64::from(to_int32(v.num()));
                        if n < 0 || n >= stack.len() as i64 {
                            self.fail();
                        } else {
                            let at = stack.len() - 1 - n as usize;
                            let picked = stack[at];
                            stack.push(picked);
                        }
                    }
                    None => self.fail(),
                }
            }
            Op::Roll => {
                if stack.len() < 2 {
                    self.fail();
                    return;
                }
                let j_node = stack.pop().unwrap_or(0);
                let n_node = stack.pop().unwrap_or(0);
                match (self.const_value(n_node), self.const_value(j_node)) {
                    (Some(nv), Some(jv)) => {
                        let n = i64::from(to_int32(nv.num()));
                        if n == 0 {
                        } else if n < 0 || n > stack.len() as i64 {
                            self.fail();
                        } else {
                            let j = (i64::from(to_int32(jv.num())) % n + n) % n;
                            if j > 0 {
                                let from = stack.len() - n as usize;
                                let slice: Vec<Id> = stack.split_off(from);
                                let cut = (n - j) as usize;
                                stack.extend_from_slice(&slice[cut..]);
                                stack.extend_from_slice(&slice[..cut]);
                            }
                        }
                    }
                    _ => self.fail(),
                }
            }
            _ => self.fail(),
        }
    }

    /// `PSStackToTree.evaluate`: the final stack, bottom first; `None` when no tree can be built.
    fn evaluate(&mut self, program: &[Instr], num_inputs: usize) -> Option<Vec<Id>> {
        if num_inputs > MAX_STACK_SIZE {
            return None;
        }
        let mut stack: Vec<Id> = (0..num_inputs).map(|i| self.add(Kind::Arg(i), ValueType::Numeric)).collect();
        self.eval_block_from(program, 0, &mut stack);
        if self.failed {
            return None;
        }
        self.mark_shared(&stack);
        Some(stack)
    }

    fn mark_shared(&mut self, outputs: &[Id]) {
        let mut counts: HashMap<Id, u32> = HashMap::new();
        let mut order: Vec<Id> = Vec::new();
        fn visit(tree: &Tree, node: Id, counts: &mut HashMap<Id, u32>, order: &mut Vec<Id>) {
            match tree.nodes[node].kind {
                Kind::Arg(_) | Kind::Const(_) => return,
                _ => {}
            }
            let seen = counts.entry(node).or_insert(0);
            *seen += 1;
            if *seen > 1 {
                return;
            }
            order.push(node);
            match tree.nodes[node].kind {
                Kind::Unary { operand, .. } => visit(tree, operand, counts, order),
                Kind::Binary { first, second, .. } => {
                    visit(tree, first, counts, order);
                    visit(tree, second, counts, order);
                }
                Kind::Ternary { cond, then, otherwise } => {
                    visit(tree, cond, counts, order);
                    visit(tree, then, counts, order);
                    visit(tree, otherwise, counts, order);
                }
                _ => {}
            }
        }
        for &output in outputs {
            visit(self, output, &mut counts, &mut order);
        }
        for node in order {
            let count = counts[&node];
            if count > 1 {
                self.nodes[node].shared = true;
                self.nodes[node].shared_count = count;
            }
        }
    }
}

// ---- the stack code (`PsWasmCompiler`) -----------------------------------------------------------------------------

/// One instruction of the code `wasm_compiler.js` emits. Integer (`i32`) values live on the same stack as the numbers
/// they equal.
#[derive(Clone, Copy, Debug)]
enum Inst {
    LocalGet(u32),
    LocalSet(u32),
    LocalTee(u32),
    F64(f64),
    I32(i32),
    Abs,
    Neg,
    Ceil,
    Floor,
    Trunc,
    Sqrt,
    Add,
    Sub,
    Mul,
    Div,
    Min,
    Max,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Eqz,
    And32,
    Or32,
    Xor32,
    Shl,
    ShrS,
    TruncI32,
    Select,
    Sin,
    Cos,
    Atan2,
    Log,
    Log10,
    Pow,
    /// `if`: where to continue when the condition is 0 (just after the matching `else`).
    If(usize),
    /// `else`: where the matching `end` is.
    Else(usize),
    End,
    /// The byte 0 that `_compileModNode` emits for the opcode `drop` it does not have: a trap.
    Unreachable,
    /// Store of output `i` (after the clamp the code before it computes).
    Store(u32),
}

struct Gen<'t> {
    tree: &'t Tree<'t>,
    code: Vec<Inst>,
    next_local: u32,
    free_locals: Vec<u32>,
    shared_locals: HashMap<Id, (u32, u32)>,
    open: Vec<usize>,
}

impl<'t> Gen<'t> {
    fn alloc_local(&mut self) -> u32 {
        self.free_locals.pop().unwrap_or_else(|| {
            let local = self.next_local;
            self.next_local += 1;
            local
        })
    }

    fn release_local(&mut self, local: u32) {
        self.free_locals.push(local);
    }

    fn push_if(&mut self) {
        self.open.push(self.code.len());
        self.code.push(Inst::If(0));
    }

    fn push_else(&mut self) {
        if let Some(at) = self.open.pop() {
            self.code[at] = Inst::If(self.code.len() + 1);
        }
        self.open.push(self.code.len());
        self.code.push(Inst::Else(0));
    }

    fn push_end(&mut self) {
        if let Some(at) = self.open.pop() {
            match self.code[at] {
                Inst::If(_) => self.code[at] = Inst::If(self.code.len()),
                _ => self.code[at] = Inst::Else(self.code.len()),
            }
        }
        self.code.push(Inst::End);
    }

    fn compile_node(&mut self, id: Id) -> bool {
        let node = self.tree.nodes[id];
        if node.shared {
            if let Some(entry) = self.shared_locals.get_mut(&id) {
                let local = entry.0;
                entry.1 = entry.1.wrapping_sub(1);
                let release = entry.1 == 0;
                self.code.push(Inst::LocalGet(local));
                if release {
                    self.release_local(local);
                }
                return true;
            }
            if !self.compile_node_impl(id) {
                return false;
            }
            let local = self.alloc_local();
            self.shared_locals.insert(id, (local, node.shared_count - 1));
            self.code.push(Inst::LocalTee(local));
            return true;
        }
        self.compile_node_impl(id)
    }

    fn compile_node_impl(&mut self, id: Id) -> bool {
        match self.tree.nodes[id].kind {
            Kind::Arg(index) => {
                self.code.push(Inst::LocalGet(index as u32));
                true
            }
            Kind::Const(v) => {
                self.code.push(Inst::F64(v.num()));
                true
            }
            Kind::Unary { op, operand } => self.compile_unary(id, op, operand),
            Kind::Binary { op, first, second } => self.compile_binary(op, first, second),
            Kind::Ternary { cond, then, otherwise } => self.compile_ternary(cond, then, otherwise),
        }
    }

    fn compile_sin_cos(&mut self, op: Op, operand: Id) -> bool {
        let local = self.alloc_local();
        let ok = self.compile_node(operand);
        if ok {
            self.code.push(Inst::LocalSet(local));
            self.code.push(Inst::LocalGet(local));
            self.code.push(Inst::LocalGet(local));
            self.code.push(Inst::F64(360.0));
            self.code.push(Inst::Div);
            self.code.push(Inst::Trunc);
            self.code.push(Inst::F64(360.0));
            self.code.push(Inst::Mul);
            self.code.push(Inst::Sub);
            self.code.push(Inst::F64(DEG_TO_RAD));
            self.code.push(Inst::Mul);
            self.code.push(if op == Op::Sin { Inst::Sin } else { Inst::Cos });
        }
        self.release_local(local);
        ok
    }

    fn compile_unary(&mut self, id: Id, op: Op, operand: Id) -> bool {
        if op == Op::Sin || op == Op::Cos {
            return self.compile_sin_cos(op, operand);
        }
        if op == Op::Not {
            return match self.tree.nodes[id].value_type {
                ValueType::Boolean => {
                    if !self.compile_as_bool(operand) {
                        return false;
                    }
                    self.code.push(Inst::Eqz);
                    true
                }
                ValueType::Numeric => {
                    if !self.compile_node(operand) {
                        return false;
                    }
                    self.code.push(Inst::TruncI32);
                    self.code.push(Inst::I32(-1));
                    self.code.push(Inst::Xor32);
                    true
                }
                ValueType::Unknown => false,
            };
        }
        if !self.compile_node(operand) {
            return false;
        }
        match op {
            Op::Abs => self.code.push(Inst::Abs),
            Op::Neg => self.code.push(Inst::Neg),
            Op::Sqrt => self.code.push(Inst::Sqrt),
            Op::Floor => self.code.push(Inst::Floor),
            Op::Ceiling => self.code.push(Inst::Ceil),
            Op::Round => {
                self.code.push(Inst::F64(0.5));
                self.code.push(Inst::Add);
                self.code.push(Inst::Floor);
            }
            Op::Truncate => self.code.push(Inst::Trunc),
            Op::Cvi => self.code.push(Inst::TruncI32),
            Op::Cvr => {}
            Op::Ln => self.code.push(Inst::Log),
            Op::Log => self.code.push(Inst::Log10),
            _ => return false,
        }
        true
    }

    fn compile_safe_div(&mut self, first: Id, second: Id, truncate: bool) -> bool {
        let tmp = self.alloc_local();
        let ok = self.compile_node(second) && self.compile_node(first);
        if ok {
            self.code.push(Inst::LocalTee(tmp));
            self.code.push(Inst::Div);
            if truncate {
                self.code.push(Inst::Trunc);
            }
            self.code.push(Inst::F64(0.0));
            self.code.push(Inst::LocalGet(tmp));
            self.code.push(Inst::F64(0.0));
            self.code.push(Inst::Ne);
            self.code.push(Inst::Select);
        }
        self.release_local(tmp);
        ok
    }

    fn compile_bitshift(&mut self, first: Id, second: Id) -> bool {
        let Some(Val::Num(shift)) = self.tree.const_value(first) else {
            return false;
        };
        if shift.fract() != 0.0 || !shift.is_finite() {
            return false;
        }
        if !self.compile_node(second) {
            return false;
        }
        self.code.push(Inst::TruncI32);
        if shift > 0.0 {
            self.code.push(Inst::I32(to_int32(shift)));
            self.code.push(Inst::Shl);
        } else if shift < 0.0 {
            self.code.push(Inst::I32(to_int32(-shift)));
            self.code.push(Inst::ShrS);
        }
        true
    }

    fn compile_mod(&mut self, first: Id, second: Id) -> bool {
        let divisor = self.tree.const_value(first);
        if let Some(v) = divisor
            && v.is_num(0.0)
        {
            if !self.compile_node(second) {
                return false;
            }
            self.code.push(Inst::Unreachable);
            self.code.push(Inst::F64(0.0));
            return true;
        }
        let local_a = self.alloc_local();
        let ok = self.compile_mod_body(first, second, divisor, local_a);
        self.release_local(local_a);
        ok
    }

    fn compile_mod_body(&mut self, first: Id, second: Id, divisor: Option<Val>, local_a: u32) -> bool {
        if !self.compile_node(second) {
            return false;
        }
        self.code.push(Inst::LocalTee(local_a));
        if let Some(v) = divisor {
            self.code.push(Inst::LocalGet(local_a));
            self.code.push(Inst::F64(v.num()));
            self.code.push(Inst::Div);
            self.code.push(Inst::Trunc);
            self.code.push(Inst::F64(v.num()));
            self.code.push(Inst::Mul);
            self.code.push(Inst::Sub);
            return true;
        }
        let local_b = self.alloc_local();
        let ok = self.compile_node(first);
        if ok {
            self.code.push(Inst::LocalSet(local_b));
            self.code.push(Inst::LocalGet(local_a));
            self.code.push(Inst::LocalGet(local_b));
            self.code.push(Inst::Div);
            self.code.push(Inst::Trunc);
            self.code.push(Inst::LocalGet(local_b));
            self.code.push(Inst::Mul);
            self.code.push(Inst::Sub);
            self.code.push(Inst::F64(0.0));
            self.code.push(Inst::LocalGet(local_b));
            self.code.push(Inst::F64(0.0));
            self.code.push(Inst::Ne);
            self.code.push(Inst::Select);
        }
        self.release_local(local_b);
        ok
    }

    fn compile_atan(&mut self, first: Id, second: Id) -> bool {
        let result = self.alloc_local();
        let ok = self.compile_node(second) && self.compile_node(first);
        if ok {
            self.code.push(Inst::Atan2);
            self.code.push(Inst::F64(RAD_TO_DEG));
            self.code.push(Inst::Mul);
            self.code.push(Inst::LocalTee(result));
            self.code.push(Inst::F64(0.0));
            self.code.push(Inst::Lt);
            self.push_if();
            self.code.push(Inst::LocalGet(result));
            self.code.push(Inst::F64(360.0));
            self.code.push(Inst::Add);
            self.push_else();
            self.code.push(Inst::LocalGet(result));
            self.push_end();
        }
        self.release_local(result);
        ok
    }

    fn compile_bitwise_operand(&mut self, id: Id) -> bool {
        if self.tree.nodes[id].value_type == ValueType::Boolean {
            return self.compile_as_bool(id);
        }
        if !self.compile_node(id) {
            return false;
        }
        self.code.push(Inst::TruncI32);
        true
    }

    fn compile_standard_binary(&mut self, op: Op, first: Id, second: Id) -> bool {
        let first_node = self.tree.nodes[first];
        if first == second && !matches!(first_node.kind, Kind::Arg(_) | Kind::Const(_)) && !first_node.shared {
            let tmp = self.alloc_local();
            let ok = self.compile_node(first);
            if ok {
                self.code.push(Inst::LocalTee(tmp));
                self.code.push(Inst::LocalGet(tmp));
            }
            self.release_local(tmp);
            if !ok {
                return false;
            }
        } else if !self.compile_node(second) || !self.compile_node(first) {
            return false;
        }
        let inst = match op {
            Op::Add => Inst::Add,
            Op::Sub => Inst::Sub,
            Op::Mul => Inst::Mul,
            Op::Exp => Inst::Pow,
            Op::Eq => Inst::Eq,
            Op::Ne => Inst::Ne,
            Op::Lt => Inst::Lt,
            Op::Le => Inst::Le,
            Op::Gt => Inst::Gt,
            Op::Ge => Inst::Ge,
            Op::Min => Inst::Min,
            Op::Max => Inst::Max,
            _ => return false,
        };
        self.code.push(inst);
        true
    }

    fn compile_binary(&mut self, op: Op, first: Id, second: Id) -> bool {
        match op {
            Op::Bitshift => self.compile_bitshift(first, second),
            Op::Div => self.compile_safe_div(first, second, false),
            Op::Idiv => self.compile_safe_div(first, second, true),
            Op::Mod => self.compile_mod(first, second),
            Op::Atan => self.compile_atan(first, second),
            Op::And | Op::Or | Op::Xor => {
                if !self.compile_bitwise_operand(second) || !self.compile_bitwise_operand(first) {
                    return false;
                }
                self.code.push(match op {
                    Op::And => Inst::And32,
                    Op::Or => Inst::Or32,
                    _ => Inst::Xor32,
                });
                true
            }
            _ => self.compile_standard_binary(op, first, second),
        }
    }

    /// `_compileNodeAsBoolI32`.
    fn compile_as_bool(&mut self, id: Id) -> bool {
        let node = self.tree.nodes[id];
        match node.kind {
            Kind::Binary { op, first, second } => {
                let comparison = match op {
                    Op::Eq => Some(Inst::Eq),
                    Op::Ne => Some(Inst::Ne),
                    Op::Lt => Some(Inst::Lt),
                    Op::Le => Some(Inst::Le),
                    Op::Gt => Some(Inst::Gt),
                    Op::Ge => Some(Inst::Ge),
                    _ => None,
                };
                if let Some(inst) = comparison {
                    if !self.compile_node(second) || !self.compile_node(first) {
                        return false;
                    }
                    self.code.push(inst);
                    return true;
                }
                if node.value_type == ValueType::Boolean && matches!(op, Op::And | Op::Or | Op::Xor) {
                    if !self.compile_as_bool(second) || !self.compile_as_bool(first) {
                        return false;
                    }
                    self.code.push(match op {
                        Op::And => Inst::And32,
                        Op::Or => Inst::Or32,
                        _ => Inst::Xor32,
                    });
                    return true;
                }
            }
            Kind::Unary { op: Op::Not, operand } if node.value_type == ValueType::Boolean => {
                if !self.compile_as_bool(operand) {
                    return false;
                }
                self.code.push(Inst::Eqz);
                return true;
            }
            _ => {}
        }
        if !self.compile_node(id) {
            return false;
        }
        if node.value_type == ValueType::Boolean {
            self.code.push(Inst::TruncI32);
        } else {
            self.code.push(Inst::F64(0.0));
            self.code.push(Inst::Ne);
        }
        true
    }

    fn compile_ternary(&mut self, cond: Id, then: Id, otherwise: Id) -> bool {
        if !self.compile_as_bool(cond) {
            return false;
        }
        self.push_if();
        if !self.compile_node(then) {
            return false;
        }
        self.push_else();
        if !self.compile_node(otherwise) {
            return false;
        }
        self.push_end();
        true
    }
}

/// The program as stack code, with the number of locals it needs.
struct Compiled {
    code: Vec<Inst>,
    locals: usize,
    inputs: usize,
}

fn compile_tree(program: &[Instr], domain: &[f64], range: &[f64], guard: &Guard) -> Result<Option<Compiled>> {
    let inputs = domain.len() >> 1;
    let outputs = range.len() >> 1;
    let mut tree = Tree { nodes: Vec::new(), failed: false, error: None, guard };
    let stack = tree.evaluate(program, inputs);
    if let Some(error) = tree.error.take() {
        return Err(error);
    }
    let Some(stack) = stack else {
        return Ok(None);
    };
    if stack.len() < outputs {
        return Ok(None);
    }
    let mut generator =
        Gen { tree: &tree, code: Vec::new(), next_local: inputs as u32, free_locals: Vec::new(), shared_locals: HashMap::new(), open: Vec::new() };
    for (i, &output) in stack.iter().take(outputs).enumerate() {
        if !generator.compile_node(output) {
            return Ok(None);
        }
        generator.code.push(Inst::F64(range[i * 2 + 1]));
        generator.code.push(Inst::Min);
        generator.code.push(Inst::F64(range[i * 2]));
        generator.code.push(Inst::Max);
        generator.code.push(Inst::Store(i as u32));
    }
    let locals = generator.next_local as usize;
    Ok(Some(Compiled { code: generator.code, locals, inputs }))
}

/// `i32.trunc_f64_s`: traps on `NaN` and on a number outside the `i32` range.
fn trunc_i32(x: f64) -> Result<f64> {
    if x.is_nan() || x <= -2_147_483_649.0 || x >= 2_147_483_648.0 {
        return Err(format_error("PostScript function: integer conversion trapped."));
    }
    Ok(x.trunc())
}

struct Scratch {
    locals: Vec<f64>,
    stack: Vec<f64>,
}

thread_local! {
    static SCRATCH: RefCell<Option<Scratch>> = const { RefCell::new(None) };
}

fn run_compiled(compiled: &Compiled, src: &[f64], dest: &mut [f64]) -> Result<()> {
    let mut scratch = SCRATCH.with(|slot| slot.borrow_mut().take()).unwrap_or(Scratch { locals: Vec::new(), stack: Vec::new() });
    scratch.locals.clear();
    scratch.locals.resize(compiled.locals.max(compiled.inputs), 0.0);
    for i in 0..compiled.inputs {
        scratch.locals[i] = src.get(i).copied().unwrap_or(f64::NAN);
    }
    scratch.stack.clear();
    let result = execute(&compiled.code, &mut scratch, dest);
    SCRATCH.with(|slot| *slot.borrow_mut() = Some(scratch));
    result
}

fn execute(code: &[Inst], scratch: &mut Scratch, dest: &mut [f64]) -> Result<()> {
    let Scratch { locals, stack } = scratch;
    let mut pc = 0usize;
    macro_rules! pop {
        () => {
            stack.pop().unwrap_or(0.0)
        };
    }
    while pc < code.len() {
        let inst = code[pc];
        pc += 1;
        match inst {
            Inst::LocalGet(i) => stack.push(locals[i as usize]),
            Inst::LocalSet(i) => locals[i as usize] = pop!(),
            Inst::LocalTee(i) => locals[i as usize] = stack.last().copied().unwrap_or(0.0),
            Inst::F64(v) => stack.push(v),
            Inst::I32(v) => stack.push(f64::from(v)),
            Inst::Abs => unary(stack, f64::abs),
            Inst::Neg => unary(stack, |x| -x),
            Inst::Ceil => unary(stack, f64::ceil),
            Inst::Floor => unary(stack, f64::floor),
            Inst::Trunc => unary(stack, f64::trunc),
            Inst::Sqrt => unary(stack, f64::sqrt),
            Inst::Add => binary(stack, |a, b| a + b),
            Inst::Sub => binary(stack, |a, b| a - b),
            Inst::Mul => binary(stack, |a, b| a * b),
            Inst::Div => binary(stack, |a, b| a / b),
            Inst::Min => binary(stack, js::min),
            Inst::Max => binary(stack, js::max),
            Inst::Eq => binary(stack, |a, b| f64::from(u8::from(a == b))),
            Inst::Ne => binary(stack, |a, b| f64::from(u8::from(a != b))),
            Inst::Lt => binary(stack, |a, b| f64::from(u8::from(a < b))),
            Inst::Gt => binary(stack, |a, b| f64::from(u8::from(a > b))),
            Inst::Le => binary(stack, |a, b| f64::from(u8::from(a <= b))),
            Inst::Ge => binary(stack, |a, b| f64::from(u8::from(a >= b))),
            Inst::Eqz => unary(stack, |x| f64::from(u8::from(x == 0.0))),
            Inst::And32 => binary(stack, |a, b| f64::from((a as i32) & (b as i32))),
            Inst::Or32 => binary(stack, |a, b| f64::from((a as i32) | (b as i32))),
            Inst::Xor32 => binary(stack, |a, b| f64::from((a as i32) ^ (b as i32))),
            Inst::Shl => binary(stack, |a, b| f64::from((a as i32).wrapping_shl(b as i32 as u32 & 31))),
            Inst::ShrS => binary(stack, |a, b| f64::from((a as i32) >> (b as i32 as u32 & 31))),
            Inst::TruncI32 => {
                let x = pop!();
                stack.push(trunc_i32(x)?);
            }
            Inst::Select => {
                let condition = pop!();
                let when_zero = pop!();
                let when_set = pop!();
                stack.push(if condition != 0.0 { when_set } else { when_zero });
            }
            Inst::Sin => unary(stack, f64::sin),
            Inst::Cos => unary(stack, f64::cos),
            Inst::Atan2 => binary(stack, f64::atan2),
            Inst::Log => unary(stack, js::ln),
            Inst::Log10 => unary(stack, f64::log10),
            Inst::Pow => binary(stack, js::pow),
            Inst::If(otherwise) => {
                if pop!() == 0.0 {
                    pc = otherwise;
                }
            }
            Inst::Else(end) => pc = end,
            Inst::End => {}
            Inst::Unreachable => {
                return Err(format_error("PostScript function: unreachable executed."));
            }
            Inst::Store(i) => {
                let value = pop!();
                if let Some(slot) = dest.get_mut(i as usize) {
                    *slot = value;
                }
            }
        }
    }
    Ok(())
}

fn unary(stack: &mut [f64], f: impl Fn(f64) -> f64) {
    if let Some(top) = stack.last_mut() {
        *top = f(*top);
    }
}

fn binary(stack: &mut Vec<f64>, f: impl Fn(f64, f64) -> f64) {
    let b = stack.pop().unwrap_or(0.0);
    if let Some(a) = stack.last_mut() {
        *a = f(*a, b);
    }
}

// ---- the stack interpreter (`PSStackBasedInterpreter`) -------------------------------------------------------------

struct Interpreter {
    stack: [f64; MAX_STACK_SIZE],
    sp: isize,
}

impl Interpreter {
    fn get(&self, index: isize) -> f64 {
        if (0..MAX_STACK_SIZE as isize).contains(&index) { self.stack[index as usize] } else { f64::NAN }
    }

    fn set(&mut self, index: isize, value: f64) {
        if (0..MAX_STACK_SIZE as isize).contains(&index) {
            self.stack[index as usize] = value;
        }
    }

    fn push(&mut self, value: f64) {
        if self.sp < MAX_STACK_SIZE as isize {
            self.set(self.sp, value);
            self.sp += 1;
        }
    }

    fn pop(&mut self) -> f64 {
        self.sp -= 1;
        self.get(self.sp)
    }

    fn top_mut(&mut self, f: impl Fn(f64) -> f64) {
        let at = self.sp - 1;
        let value = f(self.get(at));
        self.set(at, value);
    }

    fn binary(&mut self, f: impl Fn(f64, f64) -> f64) {
        let b = self.pop();
        let at = self.sp - 1;
        let value = f(self.get(at), b);
        self.set(at, value);
    }

    fn exec_op(&mut self, op: Op) {
        match op {
            Op::True => self.push(1.0),
            Op::False => self.push(0.0),
            Op::Abs => self.top_mut(f64::abs),
            Op::Neg => self.top_mut(|x| -x),
            Op::Ceiling => self.top_mut(f64::ceil),
            Op::Floor => self.top_mut(f64::floor),
            Op::Round => self.top_mut(|x| (x + 0.5).floor()),
            Op::Truncate => self.top_mut(f64::trunc),
            Op::Sqrt => self.top_mut(f64::sqrt),
            Op::Sin => self.top_mut(|x| js_sin_cos_argument_deg(x).sin()),
            Op::Cos => self.top_mut(|x| js_sin_cos_argument_deg(x).cos()),
            Op::Ln => self.top_mut(js::ln),
            Op::Log => self.top_mut(f64::log10),
            Op::Cvi => self.top_mut(|x| f64::from(to_int32(x.trunc()))),
            Op::Cvr => {}
            Op::Not => self.top_mut(|v| if v == 0.0 || v == 1.0 { 1.0 - v } else { f64::from(!to_int32(v)) }),
            Op::Add => self.binary(|a, b| a + b),
            Op::Sub => self.binary(|a, b| a - b),
            Op::Mul => self.binary(|a, b| a * b),
            Op::Div => self.binary(|a, b| if b != 0.0 { a / b } else { 0.0 }),
            Op::Idiv => self.binary(|a, b| if b != 0.0 { (a / b).trunc() } else { 0.0 }),
            Op::Mod => self.binary(|a, b| if b != 0.0 { a % b } else { 0.0 }),
            Op::Exp => self.binary(js::pow),
            Op::Atan => self.binary(js_atan_degrees),
            Op::Eq => self.binary(|a, b| f64::from(u8::from(a == b))),
            Op::Ne => self.binary(|a, b| f64::from(u8::from(a != b))),
            Op::Gt => self.binary(|a, b| f64::from(u8::from(a > b))),
            Op::Ge => self.binary(|a, b| f64::from(u8::from(a >= b))),
            Op::Lt => self.binary(|a, b| f64::from(u8::from(a < b))),
            Op::Le => self.binary(|a, b| f64::from(u8::from(a <= b))),
            Op::And => self.binary(|a, b| f64::from(to_int32(a) & to_int32(b))),
            Op::Or => self.binary(|a, b| f64::from(to_int32(a) | to_int32(b))),
            Op::Xor => self.binary(|a, b| f64::from(to_int32(a) ^ to_int32(b))),
            Op::Bitshift => {
                let amount = to_int32(self.pop());
                let at = self.sp - 1;
                let v = to_int32(self.get(at));
                let shifted = if amount > 0 { v.wrapping_shl(amount as u32 & 31) } else { v >> ((amount.wrapping_neg()) as u32 & 31) };
                self.set(at, f64::from(shifted));
            }
            Op::Min => self.binary(js::min),
            Op::Max => self.binary(js::max),
            Op::Dup => {
                let top = self.get(self.sp - 1);
                self.push(top);
            }
            Op::Exch => {
                let a = self.pop();
                let b = self.pop();
                self.push(a);
                self.push(b);
            }
            Op::Pop => self.sp -= 1,
            Op::Copy => {
                let n = self.pop().trunc();
                let base = self.sp as f64 - n;
                let mut k = 0.0;
                while k < n {
                    let value = self.get((base + k) as isize);
                    self.push(value);
                    k += 1.0;
                }
            }
            Op::Index => {
                let i = self.pop().trunc();
                let value = self.get((self.sp as f64 - 1.0 - i) as isize);
                self.push(value);
            }
            Op::Roll => {
                let j = self.pop().trunc();
                let n = self.pop().trunc();
                if n > 1.0 && j != 0.0 {
                    let rem = (j % n + n) % n;
                    if rem != 0.0 {
                        let base = self.sp as f64 - n;
                        // `stack.slice(base, sp)` with a negative `base` counts from the end of the 100 slots.
                        let len = MAX_STACK_SIZE as f64;
                        let start = if base < 0.0 { (len + base).max(0.0) } else { base.min(len) };
                        let end = if (self.sp as f64) < 0.0 { (len + self.sp as f64).max(0.0) } else { (self.sp as f64).min(len) };
                        let sub: Vec<f64> = if start < end { self.stack[start as usize..end as usize].to_vec() } else { Vec::new() };
                        let mut k = 0.0;
                        while k < n {
                            let from = ((k - rem + n) % n) as usize;
                            self.set((base + k) as isize, sub.get(from).copied().unwrap_or(f64::NAN));
                            k += 1.0;
                        }
                    }
                }
            }
            Op::If | Op::IfElse => {}
        }
    }

    fn exec_block(&mut self, instructions: &[Instr]) {
        for instruction in instructions {
            match instruction {
                Instr::Number(value) => self.push(*value),
                Instr::Op(op) => self.exec_op(*op),
                Instr::If(then_block) => {
                    if self.pop() != 0.0 {
                        self.exec_block(then_block);
                    }
                }
                Instr::IfElse(then_block, else_block) => {
                    if self.pop() != 0.0 {
                        self.exec_block(then_block);
                    } else {
                        self.exec_block(else_block);
                    }
                }
            }
        }
    }
}

fn js_sin_cos_argument_deg(x: f64) -> f64 {
    x % 360.0 * DEG_TO_RAD
}

// ---- the function --------------------------------------------------------------------------------------------------

enum Engine {
    Compiled(Compiled),
    Interpreted { program: Vec<Instr>, inputs: usize, range: Vec<f64> },
}

/// One PostScript calculator function of a document: `new` is pdf.js's `constructPostScript`.
pub struct PostScriptFunction {
    engine: Engine,
}

impl PostScriptFunction {
    /// Parses `source` (the function stream's bytes) and builds it for `domain` and `range` (both flat lists of
    /// pairs). A program pdf.js's parser rejects is a [`PdfError::Format`]; one it cannot turn into a tree runs in the
    /// stack interpreter.
    pub fn new(source: &[u8], domain: &[f64], range: &[f64], guard: &Guard) -> Result<PostScriptFunction> {
        let mut parser = Parser { lexer: Lexer { data: source, pos: 0 }, token: Tok::Eof, count: 0 };
        let program = parser.parse()?;
        if parser.count <= MAX_COMPILED_TOKENS
            && let Some(compiled) = compile_tree(&program, domain, range, guard)?
        {
            return Ok(PostScriptFunction { engine: Engine::Compiled(compiled) });
        }
        tracing::debug!("PostScript function runs in the stack interpreter");
        Ok(PostScriptFunction { engine: Engine::Interpreted { program, inputs: domain.len() >> 1, range: range.to_vec() } })
    }

    /// Evaluates the function on `src` (its first `domain.len() / 2` values), writing `range.len() / 2` values to
    /// the start of `dest`.
    pub fn call(&self, src: &[f64], dest: &mut [f64]) -> Result<()> {
        match &self.engine {
            Engine::Compiled(compiled) => run_compiled(compiled, src, dest),
            Engine::Interpreted { program, inputs, range } => {
                let mut interpreter = Interpreter { stack: [0.0; MAX_STACK_SIZE], sp: 0 };
                for i in 0..*inputs {
                    interpreter.push(src.get(i).copied().unwrap_or(f64::NAN));
                }
                interpreter.exec_block(program);
                let outputs = range.len() >> 1;
                let base = interpreter.sp - outputs as isize;
                for i in 0..outputs {
                    let at = base + i as isize;
                    let value = if at >= 0 { interpreter.get(at) } else { 0.0 };
                    if let Some(slot) = dest.get_mut(i) {
                        *slot = js::min(js::max(value, range[i * 2]), range[i * 2 + 1]);
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn function(source: &str, inputs: usize, outputs: usize) -> PostScriptFunction {
        let domain: Vec<f64> = (0..inputs).flat_map(|_| [0.0, 1.0]).collect();
        let range: Vec<f64> = (0..outputs).flat_map(|_| [-1000.0, 1000.0]).collect();
        PostScriptFunction::new(source.as_bytes(), &domain, &range, &Guard::unbounded()).expect("parses")
    }

    fn run(f: &PostScriptFunction, src: &[f64], outputs: usize) -> Vec<f64> {
        let mut dest = vec![f64::NAN; outputs];
        f.call(src, &mut dest).expect("runs");
        dest
    }

    fn compiled(f: &PostScriptFunction) -> bool {
        matches!(f.engine, Engine::Compiled(_))
    }

    #[test]
    fn arithmetic_on_the_stack() {
        let f = function("{ dup 0.5 mul exch 1 exch sub }", 1, 2);
        assert!(compiled(&f));
        assert_eq!(run(&f, &[0.5], 2), vec![0.25, 0.5]);
    }

    #[test]
    fn ifelse_becomes_a_ternary() {
        let f = function("{ dup 0.5 gt { pop 1 } { pop 0 } ifelse }", 1, 1);
        assert!(compiled(&f));
        assert_eq!(run(&f, &[0.75], 1), vec![1.0]);
        assert_eq!(run(&f, &[0.25], 1), vec![0.0]);
    }

    #[test]
    fn power_forms_are_folded_like_pdfjs() {
        // x 2 exp is x * x, x 0.5 exp is sqrt, x 0 exp is 1
        let f = function("{ dup 2 exp exch dup 0.5 exp exch 0 exp }", 1, 3);
        assert!(compiled(&f));
        assert_eq!(run(&f, &[0.25], 3), vec![0.0625, 0.5, 1.0]);
    }

    #[test]
    fn identities_and_equal_operands_are_simplified_without_changing_results() {
        let f = function("{ dup dup sub exch 0 add 1 mul 0 exch sub }", 1, 2);
        assert!(compiled(&f));
        assert_eq!(run(&f, &[0.5], 2), vec![0.0, -0.5]);
        let f = function("{ dup dup eq exch dup ge }", 1, 2);
        assert_eq!(run(&f, &[0.5], 2), vec![1.0, 1.0]);
    }

    #[test]
    fn division_by_zero_is_zero() {
        let f = function("{ 0 div }", 1, 1);
        assert_eq!(run(&f, &[0.5], 1), vec![0.0]);
        let f = function("{ 0 idiv }", 1, 1);
        assert_eq!(run(&f, &[0.5], 1), vec![0.0]);
    }

    #[test]
    fn a_dynamic_roll_runs_in_the_interpreter() {
        let f = function("{ 1 2 3 4 index 3 mul cvi roll }", 1, 3);
        assert!(!compiled(&f));
        // `4 index` reaches below the stack and reads NaN (undefined in pdf.js), `3 mul cvi` make it 0, the roll
        // takes j = 0 and n = 3 from the top and moves nothing: 0 1 2 are left
        assert_eq!(run(&f, &[0.0], 3), vec![0.0, 1.0, 2.0]);
    }

    #[test]
    fn unknown_words_read_as_zero_and_min_is_not_an_operator() {
        let f = function("{ frobnicate min }", 1, 3);
        assert_eq!(run(&f, &[0.5], 3), vec![0.5, 0.0, 0.0]);
    }

    #[test]
    fn a_program_without_braces_is_refused() {
        let domain = [0.0, 1.0];
        let range = [0.0, 1.0];
        assert!(PostScriptFunction::new(b"dup mul", &domain, &range, &Guard::unbounded()).is_err());
        assert!(PostScriptFunction::new(b"{ dup if }", &domain, &range, &Guard::unbounded()).is_err());
        assert!(PostScriptFunction::new(b"{ + }", &domain, &range, &Guard::unbounded()).is_err());
    }

    #[test]
    fn mod_by_a_constant_zero_traps() {
        let f = function("{ 0 mod }", 1, 1);
        let mut dest = [0.0];
        assert!(f.call(&[0.5], &mut dest).is_err());
    }

    #[test]
    fn integer_conversion_of_a_huge_number_traps_when_compiled() {
        let f = function("{ 1e12 mul cvi }", 1, 1);
        assert!(compiled(&f));
        let mut dest = [0.0];
        assert!(f.call(&[1.0], &mut dest).is_err());
    }

    #[test]
    fn output_is_clamped_to_the_range() {
        let f = PostScriptFunction::new(b"{ 2 mul }", &[0.0, 1.0], &[0.0, 1.0], &Guard::unbounded()).expect("parses");
        assert_eq!(run(&f, &[0.75], 1), vec![1.0]);
        assert_eq!(run(&f, &[-1.0], 1), vec![0.0]);
    }

    #[test]
    fn to_int32_wraps_like_javascript() {
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
    }
}
