//! The catalog failure store against Node's (`fixtures/catalog-errors/golden.json`,
//! `record-catalog-errors.mjs`): the failures `recordProviderCatalogOutcome` held for each scenario,
//! re-recorded from the errors Rust would raise for the same failure.
//!
//! The kind is NOT taken from Node's answer. A Rust boundary types a failure from facts (the status,
//! the provider's code, the transport fault) with `retry::classify::kind_of`, and a catalog listing
//! that missed its deadline is stamped by the catalog itself (`store::deadline_error`); the rendered
//! `catalogError.errorKind` is compared whole, so a case where the typed mapping and Node's verdict
//! differ fails here unless it is listed in `KNOWN_DIFFERENCES`.
