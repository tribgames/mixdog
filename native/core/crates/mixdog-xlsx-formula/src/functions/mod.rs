//! The function library of the formula engine. A library module (math, statistics, text and dates, financial,
//! engineering) is one file here with a `pub const FUNCTIONS: Table` of its upper-case names, dotted ones included,
//! and is added in two places below: its `mod` line and its entry in `TABLES`. The registry is built from `TABLES`
//! once; a name listed twice is a mistake the registry test reports.

use crate::registry::Table;

mod certified;
mod distributions;
mod jstat;
mod special;
mod statistical;

// Library modules, one line each: `mod math;`

mod database;
mod datetime;
pub mod information;
pub mod logical;
mod lookup;
/// The tables of the library modules, one line each: `math::FUNCTIONS,`
pub mod math;
mod text;

mod bessel;
mod complex;
mod engineering;

mod financial;

pub const TABLES: &[Table] = &[
    financial::FUNCTIONS,
    engineering::FUNCTIONS,
    complex::FUNCTIONS,
    statistical::FUNCTIONS,
    distributions::FUNCTIONS,
    math::FUNCTIONS,
    logical::FUNCTIONS,
    information::FUNCTIONS,
    text::FUNCTIONS,
    datetime::FUNCTIONS,
    lookup::FUNCTIONS,
    database::FUNCTIONS,
];

/// Whether `name` is a distribution function: it reads its arguments left to right itself (Excel reports the first
/// error value or uncoercible text in argument order), so the evaluator must not answer with the first error value.
pub(crate) fn orders_its_own_errors(name: &str) -> bool {
    distributions::FUNCTIONS.iter().any(|(n, _)| *n == name)
}
