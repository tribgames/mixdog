//! The function registry: the name a formula calls, dotted names included (`NORM.DIST`, `CEILING.MATH`), mapped to the
//! Rust function that answers for it. It replaces the `@formulajs/formulajs` namespace the Node engine looked names up
//! in. A function receives its arguments as the library does (an omitted argument is absent from the slice, a range is
//! an array of row arrays, an error an error value) and answers with the value the library function returns.

use std::collections::HashMap;
use std::sync::LazyLock;

use crate::functions;
use crate::value::{Failure, Value};

/// A formula function. `Err` is an exception the library function throws or a refusal.
pub type Function = fn(&[Value]) -> Result<Value, Failure>;

/// The functions of one library module: upper-case names with their dots, in any order.
pub type Table = &'static [(&'static str, Function)];

/// Excel kept every pre-2010 name beside the family it grew into and documents the pair as the same calculation:
/// `STDEV` is `STDEV.S`, `PERCENTILE` is `PERCENTILE.INC`. The library ships only the family member, so the older
/// name, which is what a workbook of that age still holds, resolves through here.
const LEGACY_FUNCTION_NAMES: [(&str, &str); 6] = [
    ("STDEV", "STDEV.S"),
    ("VAR", "VAR.S"),
    ("PERCENTILE", "PERCENTILE.INC"),
    ("QUARTILE", "QUARTILE.INC"),
    ("MODE", "MODE.SNGL"),
    ("RANK", "RANK.EQ"),
];

pub struct Registry {
    functions: HashMap<&'static str, Function>,
}

impl Registry {
    /// A registry of the functions of `tables`; a name in two tables answers with the later one.
    pub fn new(tables: &[Table]) -> Self {
        let mut functions = HashMap::new();
        for table in tables {
            for (name, function) in *table {
                functions.insert(*name, *function);
            }
        }
        Self { functions }
    }

    /// The function a formula means by `name` (upper case, prefixes stripped): the name itself, else the family member
    /// a pre-2010 name stands for.
    pub fn resolve(&self, name: &str) -> Option<Function> {
        self.functions.get(name).copied().or_else(|| {
            LEGACY_FUNCTION_NAMES
                .iter()
                .find(|(legacy, _)| *legacy == name)
                .and_then(|(_, family)| self.functions.get(family).copied())
        })
    }

    /// The names registered in more than one of `tables`.
    pub fn duplicates(tables: &[Table]) -> Vec<&'static str> {
        let mut seen = std::collections::HashSet::new();
        let mut twice = Vec::new();
        for table in tables {
            for (name, _) in *table {
                if !seen.insert(*name) {
                    twice.push(*name);
                }
            }
        }
        twice
    }
}

static LIBRARY: LazyLock<Registry> = LazyLock::new(|| Registry::new(functions::TABLES));

/// The registry of the whole library: every module `functions::TABLES` lists.
pub fn library() -> &'static Registry {
    &LIBRARY
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Number(1.0))
    }

    fn two(_: &[Value]) -> Result<Value, Failure> {
        Ok(Value::Number(2.0))
    }

    const FIRST: Table = &[("STDEV.S", one), ("NORM.DIST", one)];
    const SECOND: Table = &[("NORM.DIST", two)];

    fn answer(function: Function) -> f64 {
        match function(&[]) {
            Ok(Value::Number(number)) => number,
            other => panic!("not a number: {other:?}"),
        }
    }

    #[test]
    fn dotted_names_resolve_and_the_later_table_wins() {
        let registry = Registry::new(&[FIRST, SECOND]);
        assert_eq!(answer(registry.resolve("NORM.DIST").expect("registered")), 2.0);
        assert!(registry.resolve("NORM").is_none());
        assert!(registry.resolve("NOSUCH").is_none());
        assert_eq!(Registry::duplicates(&[FIRST, SECOND]), ["NORM.DIST"]);
    }

    #[test]
    fn a_pre_2010_name_resolves_to_its_family_member_when_it_has_no_function_of_its_own() {
        let registry = Registry::new(&[FIRST]);
        assert_eq!(answer(registry.resolve("STDEV").expect("through STDEV.S")), 1.0);
        assert!(registry.resolve("VAR").is_none());
        let own = Registry::new(&[&[("STDEV", two), ("STDEV.S", one)]]);
        assert_eq!(answer(own.resolve("STDEV").expect("own")), 2.0);
    }

    #[test]
    fn the_library_lists_each_name_once_in_upper_case() {
        assert!(Registry::duplicates(functions::TABLES).is_empty());
        for table in functions::TABLES {
            for (name, _) in *table {
                assert_eq!(*name, name.to_uppercase(), "{name}");
            }
        }
    }
}
