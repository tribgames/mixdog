//! The in-process recalculation engine of the xlsx backend, used when LibreOffice is absent: Excel formulas evaluated in
//! this process, so a workbook can carry cached values on a machine without it. A port of
//! `portable/xlsx-formula-engine.mjs`. The tokenizer, the precedence, the reference resolution and the coercions are the
//! engine's own; the function bodies are the library modules registered in [`functions`], which follow the argument
//! conventions of `@formulajs/formulajs` ([`coerce`]). A formula this engine cannot read is refused
//! ([`UnsupportedFormula`]), never guessed: a wrong number inside a model is worse than a cell the reader can see was
//! never calculated.
//!
//! Every `Math.*` call goes through [`mixdog_js::math`] so a result equals V8's bit for bit, and a number becomes text
//! through `mixdog_js` number formatting.

pub mod coerce;
mod eval;
pub mod functions;
mod parse;
pub mod registry;
mod token;
mod value;

pub use eval::{Context, Extent, MAX_RANGE_CELLS, evaluate_formula, evaluate_formula_with};
pub use registry::{Function, Registry, Table, library};
pub use token::{FormulaReference, formula_references, translate_shared_formula};
pub use value::{ErrorValue, Failure, UnsupportedFormula, Value, cell_error_of, is_blank, is_formula_error};
