//! Which params of a method carry blob references, from one table (`blob_fields.json`), parsed once.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Table<'a> {
    #[serde(borrow)]
    methods: BTreeMap<&'a str, Vec<&'a str>>,
}

fn table() -> &'static Table<'static> {
    static TABLE: OnceLock<Table<'static>> = OnceLock::new();
    TABLE.get_or_init(|| serde_json::from_str(include_str!("blob_fields.json")).expect("blob_fields.json is the table"))
}

/// The params fields of `method` that carry blob references; none for a method the table does not list.
pub fn fields(method: &str) -> &'static [&'static str] {
    table().methods.get(method).map(Vec::as_slice).unwrap_or_default()
}

/// Every method the table names.
#[cfg(test)]
pub(super) fn table_methods() -> impl Iterator<Item = &'static str> {
    table().methods.keys().copied()
}

#[cfg(test)]
mod tests {
    use super::fields;

    #[test]
    fn lists_the_pointers_of_a_method() {
        assert_eq!(fields("projectFs/writeText"), ["/content", "/expectedContent"]);
        assert!(fields("turn/start").contains(&"/input/prompt/*/data"));
    }

    #[test]
    fn unlisted_method_has_no_pointer() {
        assert!(fields("thread/list").is_empty());
        assert!(fields("nonsense").is_empty());
    }

    #[test]
    fn every_pointer_is_absolute_and_free_of_empty_segments() {
        for method in super::table_methods() {
            for pointer in fields(method) {
                assert!(pointer.starts_with('/') && !pointer.contains("//") && !pointer.ends_with('/'), "{method}: {pointer}");
            }
        }
    }
}
