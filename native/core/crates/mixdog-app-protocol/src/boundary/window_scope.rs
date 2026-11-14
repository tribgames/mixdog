//! Which methods a window-scoped connection may call, from one table (`window_methods.json`), parsed once.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use serde::Deserialize;

/// The table's version; a change of the table's meaning raises it.
pub const WINDOW_SCOPE_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Table<'a> {
    version: u32,
    #[serde(borrow)]
    methods: BTreeSet<&'a str>,
}

/// A method a window-scoped connection may not call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowDenial {
    pub method: String,
}

fn table() -> &'static Table<'static> {
    static TABLE: OnceLock<Table<'static>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let table: Table<'static> = serde_json::from_str(include_str!("window_methods.json")).expect("window_methods.json is the table");
        assert_eq!(table.version, WINDOW_SCOPE_VERSION, "window_methods.json is version {WINDOW_SCOPE_VERSION}");
        table
    })
}

/// Whether a window-scoped connection may call `method`: only the methods the table lists.
pub fn allows(method: &str) -> Result<(), WindowDenial> {
    if table().methods.contains(method) { Ok(()) } else { Err(WindowDenial { method: method.to_owned() }) }
}

/// Every method the table names.
#[cfg(test)]
pub(super) fn table_methods() -> impl Iterator<Item = &'static str> {
    table().methods.iter().copied()
}
