//! The content-stream reader of `getTextContent`: pdf.js's `EvaluatorPreprocessor` (`opMap`, the operands collected
//! against each operator's count, the tolerance of too many and too few operands, the run of invalid path operators
//! that ends a stream) with the `StateManager` of the text state: `q`, `Q` and `cm` are applied as they are read.

use std::sync::{Arc, OnceLock};

use crate::error::{PdfError, Result};
use crate::lexer::{CommandArgs, KnownCommands, Lexer};
use crate::object::Obj;
use crate::parser::Parser;
use crate::stream::ByteStream;
use crate::xref::Xref;

use super::state::StateManager;

/// `EvaluatorPreprocessor.MAX_INVALID_PATH_OPS`.
const MAX_INVALID_PATH_OPS: usize = 10;
/// The most operands one operator takes (`Too many arguments`).
const MAX_ARGS: usize = 33;

/// The operators `getTextContent` acts on; every other operator of `opMap` is [`TextOp::Other`] (it still takes its
/// operands from the stream).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextOp {
    Save,
    Restore,
    Transform,
    BeginText,
    EndText,
    SetCharSpacing,
    SetWordSpacing,
    SetHScale,
    SetLeading,
    SetFont,
    SetTextRise,
    MoveText,
    SetLeadingMoveText,
    SetTextMatrix,
    NextLine,
    ShowText,
    ShowSpacedText,
    NextLineShowText,
    NextLineSetSpacingShowText,
    SetGState,
    PaintXObject,
    BeginMarkedContent,
    BeginMarkedContentProps,
    EndMarkedContent,
    /// A path operator (`fn >= OPS.moveTo && fn <= OPS.endPath`).
    Path,
    Other,
}

/// What an `opMap` entry says: the operator, its operand count and whether fewer operands are accepted.
#[derive(Clone, Copy)]
struct Spec {
    op: TextOp,
    num_args: usize,
    variable_args: bool,
}

const fn spec(op: TextOp, num_args: usize) -> Option<Spec> {
    Some(Spec { op, num_args, variable_args: false })
}

const fn variable(num_args: usize) -> Option<Spec> {
    Some(Spec { op: TextOp::Other, num_args, variable_args: true })
}

/// `EvaluatorPreprocessor.opMap`. An entry without a spec is pdf.js's `null` (it only keeps the lexer joining
/// `BMC`, `BDC`, `true`...) or `BI` / `ID`, which the parser consumes.
const OP_MAP: &[(&str, Option<Spec>)] = &[
    ("w", spec(TextOp::Other, 1)),
    ("J", spec(TextOp::Other, 1)),
    ("j", spec(TextOp::Other, 1)),
    ("M", spec(TextOp::Other, 1)),
    ("d", spec(TextOp::Other, 2)),
    ("ri", spec(TextOp::Other, 1)),
    ("i", spec(TextOp::Other, 1)),
    ("gs", spec(TextOp::SetGState, 1)),
    ("q", spec(TextOp::Save, 0)),
    ("Q", spec(TextOp::Restore, 0)),
    ("cm", spec(TextOp::Transform, 6)),
    ("m", spec(TextOp::Path, 2)),
    ("l", spec(TextOp::Path, 2)),
    ("c", spec(TextOp::Path, 6)),
    ("v", spec(TextOp::Path, 4)),
    ("y", spec(TextOp::Path, 4)),
    ("h", spec(TextOp::Path, 0)),
    ("re", spec(TextOp::Path, 4)),
    ("S", spec(TextOp::Path, 0)),
    ("s", spec(TextOp::Path, 0)),
    ("f", spec(TextOp::Path, 0)),
    ("F", spec(TextOp::Path, 0)),
    ("f*", spec(TextOp::Path, 0)),
    ("B", spec(TextOp::Path, 0)),
    ("B*", spec(TextOp::Path, 0)),
    ("b", spec(TextOp::Path, 0)),
    ("b*", spec(TextOp::Path, 0)),
    ("n", spec(TextOp::Path, 0)),
    ("W", spec(TextOp::Other, 0)),
    ("W*", spec(TextOp::Other, 0)),
    ("BT", spec(TextOp::BeginText, 0)),
    ("ET", spec(TextOp::EndText, 0)),
    ("Tc", spec(TextOp::SetCharSpacing, 1)),
    ("Tw", spec(TextOp::SetWordSpacing, 1)),
    ("Tz", spec(TextOp::SetHScale, 1)),
    ("TL", spec(TextOp::SetLeading, 1)),
    ("Tf", spec(TextOp::SetFont, 2)),
    ("Tr", spec(TextOp::Other, 1)),
    ("Ts", spec(TextOp::SetTextRise, 1)),
    ("Td", spec(TextOp::MoveText, 2)),
    ("TD", spec(TextOp::SetLeadingMoveText, 2)),
    ("Tm", spec(TextOp::SetTextMatrix, 6)),
    ("T*", spec(TextOp::NextLine, 0)),
    ("Tj", spec(TextOp::ShowText, 1)),
    ("TJ", spec(TextOp::ShowSpacedText, 1)),
    ("'", spec(TextOp::NextLineShowText, 1)),
    ("\"", spec(TextOp::NextLineSetSpacingShowText, 3)),
    ("d0", spec(TextOp::Other, 2)),
    ("d1", spec(TextOp::Other, 6)),
    ("CS", spec(TextOp::Other, 1)),
    ("cs", spec(TextOp::Other, 1)),
    ("SC", variable(4)),
    ("SCN", variable(33)),
    ("sc", variable(4)),
    ("scn", variable(33)),
    ("G", spec(TextOp::Other, 1)),
    ("g", spec(TextOp::Other, 1)),
    ("RG", spec(TextOp::Other, 3)),
    ("rg", spec(TextOp::Other, 3)),
    ("K", spec(TextOp::Other, 4)),
    ("k", spec(TextOp::Other, 4)),
    ("sh", spec(TextOp::Other, 1)),
    ("BI", None),
    ("ID", None),
    ("EI", spec(TextOp::Other, 1)),
    ("Do", spec(TextOp::PaintXObject, 1)),
    ("MP", spec(TextOp::Other, 1)),
    ("DP", spec(TextOp::Other, 2)),
    ("BMC", spec(TextOp::BeginMarkedContent, 1)),
    ("BDC", spec(TextOp::BeginMarkedContentProps, 2)),
    ("EMC", spec(TextOp::EndMarkedContent, 0)),
    ("BX", spec(TextOp::Other, 0)),
    ("EX", spec(TextOp::Other, 0)),
    ("BM", None),
    ("BD", None),
    ("true", None),
    ("fa", None),
    ("fal", None),
    ("fals", None),
    ("false", None),
    ("nu", None),
    ("nul", None),
    ("null", None),
];

/// The table the lexer joins commands by and the inline-image end search counts operands with. pdf.js's `null`
/// entries are known to the lexer but name no operator, so the search treats them as unknown (an operand count no
/// run reaches); `BI` and `ID` take none.
fn known_commands() -> Arc<KnownCommands> {
    static KNOWN: OnceLock<Arc<KnownCommands>> = OnceLock::new();
    KNOWN
        .get_or_init(|| {
            let mut map = KnownCommands::new();
            for &(name, entry) in OP_MAP {
                let args = match entry {
                    Some(spec) => CommandArgs { num_args: spec.num_args, variable_args: spec.variable_args },
                    None if name == "BI" || name == "ID" => CommandArgs { num_args: 0, variable_args: false },
                    None => CommandArgs { num_args: usize::MAX, variable_args: false },
                };
                map.insert(name.to_owned(), args);
            }
            Arc::new(map)
        })
        .clone()
}

fn spec_of(name: &str) -> Option<Spec> {
    OP_MAP.iter().find(|(n, _)| *n == name).and_then(|&(_, spec)| spec)
}

/// A number operand as JavaScript reads it: anything else is NaN.
pub fn number_at(args: &[Obj], at: usize) -> f64 {
    args.get(at).and_then(Obj::as_num).unwrap_or(f64::NAN)
}

/// `EvaluatorPreprocessor`.
pub struct Preprocessor<'x> {
    parser: Parser<'x>,
    non_processed: Vec<Obj>,
    is_path_op: bool,
    num_invalid_path_ops: usize,
}

impl<'x> Preprocessor<'x> {
    pub fn new(content: Vec<u8>, xref: &'x Xref) -> Result<Self> {
        let lexer = Lexer::with_known_commands(ByteStream::from_vec(content), xref.guard().clone(), Some(known_commands()));
        Ok(Preprocessor { parser: Parser::new(lexer, Some(xref), false, false)?, non_processed: Vec::new(), is_path_op: false, num_invalid_path_ops: 0 })
    }

    /// `read`: the next operator with exactly the operands it takes. Operands that do not fit are carried to the
    /// neighbouring operators, an operator with too few is skipped, and a run of ten invalid path operators is a
    /// format error. `q`, `Q` and `cm` update the state manager as they are read. `None` is the end of the stream.
    pub fn read(&mut self, manager: &mut StateManager) -> Result<Option<(TextOp, Vec<Obj>)>> {
        let mut args: Vec<Obj> = Vec::new();
        loop {
            let obj = self.parser.get_obj(None)?;
            match &obj {
                Obj::Cmd(cmd) => {
                    let Some(spec) = spec_of(cmd) else {
                        tracing::warn!("Unknown command \"{cmd}\".");
                        continue;
                    };
                    let num_args = spec.num_args;
                    let mut args_length = args.len();
                    if !self.is_path_op {
                        self.num_invalid_path_ops = 0;
                    }
                    self.is_path_op = spec.op == TextOp::Path;
                    if !spec.variable_args {
                        if args_length != num_args {
                            while args_length > num_args {
                                self.non_processed.push(args.remove(0));
                                args_length -= 1;
                            }
                            while args_length < num_args && !self.non_processed.is_empty() {
                                if let Some(carried) = self.non_processed.pop() {
                                    args.insert(0, carried);
                                }
                                args_length += 1;
                            }
                        }
                        if args_length < num_args {
                            let partial = format!("command {cmd}: expected {num_args} args, but received {args_length} args.");
                            if self.is_path_op {
                                self.num_invalid_path_ops += 1;
                                if self.num_invalid_path_ops > MAX_INVALID_PATH_OPS {
                                    return Err(PdfError::Format(format!("Invalid {partial}")));
                                }
                            }
                            tracing::warn!("Skipping {partial}");
                            args.clear();
                            continue;
                        }
                    } else if args_length > num_args {
                        tracing::debug!("Command {cmd}: expected [0, {num_args}] args, but received {args_length} args.");
                    }
                    match spec.op {
                        TextOp::Save => manager.save(),
                        TextOp::Restore => manager.restore(),
                        TextOp::Transform => {
                            let m: Vec<f64> = (0..6).map(|i| number_at(&args, i)).collect();
                            manager.transform(&m);
                        }
                        _ => {}
                    }
                    return Ok(Some((spec.op, args)));
                }
                Obj::Eof => return Ok(None),
                Obj::Null => {}
                _ => {
                    args.push(obj);
                    if args.len() > MAX_ARGS {
                        return Err(PdfError::Format("Too many arguments".to_owned()));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Document, OpenOptions};
    use crate::text::state::TextState;

    fn document() -> Document {
        let pdf = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
                   2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
                   3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>\nendobj\n\
                   trailer\n<< /Root 1 0 R /Size 4 >>\n%%EOF\n";
        Document::open(pdf.as_bytes().to_vec(), &OpenOptions::default()).expect("a document")
    }

    fn read_all(content: &str) -> (Vec<(TextOp, Vec<Obj>)>, StateManager) {
        let document = document();
        let mut manager = StateManager::new(TextState::new());
        let mut pre = Preprocessor::new(content.as_bytes().to_vec(), document.xref()).expect("a reader");
        let mut found = Vec::new();
        while let Some(operation) = pre.read(&mut manager).expect("an operator") {
            found.push(operation);
        }
        (found, manager)
    }

    #[test]
    fn surplus_operands_go_to_the_next_operator_and_a_short_one_is_skipped() {
        let (ops, _) = read_all("1 2 3 Td Tj 5 Td BT");
        let kinds: Vec<TextOp> = ops.iter().map(|(op, _)| *op).collect();
        assert_eq!(kinds, vec![TextOp::MoveText, TextOp::ShowText, TextOp::BeginText]);
        assert_eq!(number_at(&ops[0].1, 0), 2.0);
        assert_eq!(number_at(&ops[0].1, 1), 3.0);
        assert_eq!(number_at(&ops[1].1, 0), 1.0);
    }

    #[test]
    fn q_cm_and_q_are_applied_while_reading() {
        let (_, manager) = read_all("q 2 0 0 2 0 0 cm Q q 3 0 0 3 0 0 cm");
        assert_eq!(manager.state.ctm[0], 3.0);
    }

    #[test]
    fn unknown_commands_are_dropped_with_their_place() {
        let (ops, _) = read_all("1 0 0 1 5 5 Tm xyz BT");
        let kinds: Vec<TextOp> = ops.iter().map(|(op, _)| *op).collect();
        assert_eq!(kinds, vec![TextOp::SetTextMatrix, TextOp::BeginText]);
    }

    #[test]
    fn a_run_of_invalid_path_operators_ends_the_stream() {
        let document = document();
        let mut manager = StateManager::new(TextState::new());
        let mut pre = Preprocessor::new(b"l l l l l l l l l l l l BT".to_vec(), document.xref()).expect("a reader");
        let mut outcome = Ok(None);
        for _ in 0..20 {
            outcome = pre.read(&mut manager);
            if outcome.is_err() {
                break;
            }
        }
        assert!(outcome.is_err());
    }

    #[test]
    fn more_than_thirty_three_operands_is_an_error() {
        let document = document();
        let mut manager = StateManager::new(TextState::new());
        let content = format!("{} Tj", "1 ".repeat(40));
        let mut pre = Preprocessor::new(content.into_bytes(), document.xref()).expect("a reader");
        assert!(pre.read(&mut manager).is_err());
    }
}
