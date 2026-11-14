//! `shared/page-sizes.mjs`: paper sizes in points (72 per inch), portrait. One table serves the PDF writer and Word's
//! set_page, so `letter` means the same sheet in both.

use mixdog_js::{js_to_lowercase, to_number, value_to_string};
use serde_json::Value;

const PAGE_SIZES: [(&str, [f64; 2]); 6] = [
    ("a3", [841.89, 1190.55]),
    ("a4", [595.28, 841.89]),
    ("a5", [419.53, 595.28]),
    ("letter", [612.0, 792.0]),
    ("legal", [612.0, 1008.0]),
    ("tabloid", [792.0, 1224.0]),
];

/// `[width, height]` in points for a named size or a `[width, height]` pair (`None` is an absent value); the error
/// is the text Node throws, naming the choices.
pub fn page_size_points(value: Option<&Value>, label: &str) -> Result<[f64; 2], String> {
    let size = match value {
        Some(Value::Array(pair)) if pair.len() == 2 => [to_number(&pair[0]), to_number(&pair[1])],
        _ => {
            let shown = value.map_or_else(|| "undefined".to_owned(), value_to_string);
            let named = js_to_lowercase(&shown);
            match PAGE_SIZES.iter().find(|(name, _)| *name == named) {
                Some((_, size)) => *size,
                None => {
                    let names: Vec<&str> = PAGE_SIZES.iter().map(|(name, _)| *name).collect();
                    return Err(format!("Unknown {label}: {shown}; use {} or [width, height] in points", names.join(", ")));
                }
            }
        }
    };
    if !size.iter().all(|side| side.is_finite() && *side > 0.0) {
        return Err(format!("{label} must be two positive numbers in points"));
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn named_and_paired_sizes() {
        assert_eq!(page_size_points(Some(&json!("A4")), "page size"), Ok([595.28, 841.89]));
        assert_eq!(page_size_points(Some(&json!([100, "200"])), "page size"), Ok([100.0, 200.0]));
    }

    #[test]
    fn errors_name_the_choices() {
        assert_eq!(
            page_size_points(Some(&json!("b5")), "page size").unwrap_err(),
            "Unknown page size: b5; use a3, a4, a5, letter, legal, tabloid or [width, height] in points"
        );
        assert_eq!(
            page_size_points(None, "page").unwrap_err(),
            "Unknown page: undefined; use a3, a4, a5, letter, legal, tabloid or [width, height] in points"
        );
        assert_eq!(page_size_points(Some(&json!([0, 5])), "page").unwrap_err(), "page must be two positive numbers in points");
        assert!(page_size_points(Some(&json!([1, 2, 3])), "page").unwrap_err().starts_with("Unknown page: 1,2,3;"));
    }
}
