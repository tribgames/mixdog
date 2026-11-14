//! The function library of the formula engine. A library module (math, statistics, text and dates, financial,
//! engineering) is one file here with a `pub const FUNCTIONS: Table` of its upper-case names, dotted ones included,
//! and is added in two places below: its `mod` line and its entry in `TABLES`. The registry is built from `TABLES`
//! once; a name listed twice is a mistake the registry test reports.

use crate::registry::Table;

mod statistical;

// Library modules, one line each: `mod math;`

/// The tables of the library modules, one line each: `math::FUNCTIONS,`
pub mod math;
pub mod logical;
pub mod information;
mod text;
mod datetime;
mod lookup;
mod database;

mod engineering;
mod complex;
mod bessel;

mod financial;

pub const TABLES: &[Table] = &[
    financial::FUNCTIONS,
    engineering::FUNCTIONS, complex::FUNCTIONS,
    statistical::FUNCTIONS,
    math::FUNCTIONS, logical::FUNCTIONS, information::FUNCTIONS,
    text::FUNCTIONS, datetime::FUNCTIONS, lookup::FUNCTIONS, database::FUNCTIONS,
];
