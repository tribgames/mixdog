//! Open JSON values. Used only where today's wire carries an open record
//! (`Readonly<Record<string, unknown>>` or `unknown` in the 1.4.5 contract);
//! the exact shape of such a value is pinned by the domain's golden-twin suite.

pub type JsonValue = serde_json::Value;
pub type JsonObject = serde_json::Map<String, serde_json::Value>;
