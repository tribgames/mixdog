use std::cmp::Ordering;

use mixdog_js::json_number;
use serde_json::Map;
use serde_json::Value;

/// One category of the context: its key and the label a surface shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContextCategory {
    pub key: &'static str,
    pub label: &'static str,
}

/// `CONTEXT_CATEGORIES`.
pub const CONTEXT_CATEGORIES: [ContextCategory; 11] = [
    ContextCategory { key: "system", label: "System messages" },
    ContextCategory { key: "user", label: "User messages" },
    ContextCategory { key: "assistant", label: "Assistant messages" },
    ContextCategory { key: "reasoning", label: "Reasoning tokens" },
    ContextCategory { key: "toolResults", label: "Tool results" },
    ContextCategory { key: "attachments", label: "Attachments" },
    ContextCategory { key: "tools", label: "System tools" },
    ContextCategory { key: "mcp", label: "MCP tools" },
    ContextCategory { key: "agents", label: "Custom agents" },
    ContextCategory { key: "memory", label: "Memory files" },
    ContextCategory { key: "skills", label: "Skills" },
];

/// `contextShares(weights, total)`: `total` split by the weights into whole numbers that add up to it (the largest
/// remainders take the units the floors leave), so no category is counted twice.
pub fn context_shares(weights: &[f64], total: f64) -> Vec<f64> {
    let sum: f64 = weights.iter().sum();
    if sum == 0.0 || sum.is_nan() {
        return vec![0.0; weights.len()];
    }
    let exact: Vec<f64> = weights.iter().map(|weight| weight / sum * total).collect();
    let mut shares: Vec<f64> = exact.iter().map(|value| value.floor()).collect();
    let mut remaining = total - shares.iter().sum::<f64>();
    let mut order: Vec<usize> = (0..exact.len()).collect();
    order.sort_by(|&a, &b| (exact[b] - shares[b] - (exact[a] - shares[a])).partial_cmp(&0.0).unwrap_or(Ordering::Equal));
    for index in order {
        let before = remaining;
        remaining -= 1.0;
        if before <= 0.0 {
            break;
        }
        shares[index] += 1.0;
    }
    shares
}

/// A category's key with the tokens it holds, as `buildContextMap` takes it.
#[derive(Clone, Debug, PartialEq)]
pub struct CategoryTokens {
    pub key: String,
    pub tokens: f64,
}

/// The options of `buildContextMap`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ContextMapOptions {
    pub window_tokens: f64,
    pub cells: f64,
    pub fit: bool,
}

impl Default for ContextMapOptions {
    fn default() -> Self {
        Self { window_tokens: 0.0, cells: 128.0, fit: false }
    }
}

/// What `buildContextMap` returns.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextMap {
    /// One key per cell of the map, in category order, the free window last.
    pub cells: Vec<String>,
    pub block_tokens: f64,
    pub scale_tokens: f64,
    pub occupied: f64,
    pub overflow: bool,
}

impl ContextMap {
    /// The object Node builds.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("cells".into(), Value::Array(self.cells.iter().cloned().map(Value::String).collect()));
        map.insert("blockTokens".into(), json_number(self.block_tokens));
        map.insert("scaleTokens".into(), json_number(self.scale_tokens));
        map.insert("occupied".into(), json_number(self.occupied));
        map.insert("overflow".into(), Value::Bool(self.overflow));
        Value::Object(map)
    }
}

/// `buildContextMap(categories, { windowTokens, cells, fit })`: what the context holds and what is still open. The
/// auto-compact buffer is headroom policy, not content, and reading it as a third kind of occupancy only crowded the
/// picture; the window it reserves is already the window this map measures.
pub fn build_context_map(categories: &[CategoryTokens], options: ContextMapOptions) -> ContextMap {
    let occupied: f64 = categories.iter().map(|category| category.tokens).sum();
    let window = options.window_tokens.max(0.0);
    let free = (window - occupied).max(0.0);
    let mut segments: Vec<(&str, f64)> = categories.iter().map(|category| (category.key.as_str(), category.tokens)).collect();
    segments.push(("free", if options.fit { 0.0 } else { free }));
    let scale_tokens: f64 = segments.iter().map(|(_, tokens)| tokens).sum();
    let weights: Vec<f64> = segments.iter().map(|(_, tokens)| *tokens).collect();
    let counts = context_shares(&weights, options.cells);
    let cells = if scale_tokens != 0.0 && !scale_tokens.is_nan() {
        segments.iter().zip(&counts).flat_map(|((key, _), count)| std::iter::repeat_n((*key).to_owned(), *count as usize)).collect()
    } else {
        Vec::new()
    };
    ContextMap { cells, block_tokens: scale_tokens / options.cells, scale_tokens, occupied, overflow: window > 0.0 && occupied > window }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(key: &str, tokens: f64) -> CategoryTokens {
        CategoryTokens { key: key.to_owned(), tokens }
    }

    #[test]
    fn the_categories_are_the_eleven_rows() {
        assert_eq!(CONTEXT_CATEGORIES.len(), 11);
        assert_eq!(CONTEXT_CATEGORIES[0], ContextCategory { key: "system", label: "System messages" });
        assert_eq!(CONTEXT_CATEGORIES[10].key, "skills");
    }

    #[test]
    fn shares_conserve_the_total_and_give_leftovers_to_the_largest_remainders() {
        assert_eq!(context_shares(&[1.0, 1.0, 1.0], 10.0), vec![4.0, 3.0, 3.0]);
        assert_eq!(context_shares(&[1.0, 2.0], 3.0), vec![1.0, 2.0]);
        assert_eq!(context_shares(&[0.0, 0.0], 5.0), vec![0.0, 0.0]);
        assert_eq!(context_shares(&[], 5.0), Vec::<f64>::new());
        let shares = context_shares(&[7.0, 11.0, 13.0, 17.0], 128.0);
        assert_eq!(shares.iter().sum::<f64>(), 128.0);
    }

    #[test]
    fn the_map_leaves_the_free_window_last() {
        let map = build_context_map(&[tokens("user", 25.0), tokens("assistant", 25.0)], ContextMapOptions { window_tokens: 100.0, cells: 4.0, fit: false });
        assert_eq!(map.cells, ["user", "assistant", "free", "free"]);
        assert_eq!(map.occupied, 50.0);
        assert_eq!(map.scale_tokens, 100.0);
        assert_eq!(map.block_tokens, 25.0);
        assert!(!map.overflow);
    }

    #[test]
    fn fit_drops_the_free_window_and_overflow_is_reported() {
        let fit = build_context_map(&[tokens("user", 30.0), tokens("tools", 10.0)], ContextMapOptions { window_tokens: 100.0, cells: 4.0, fit: true });
        assert_eq!(fit.cells, ["user", "user", "user", "tools"]);
        let over = build_context_map(&[tokens("user", 150.0)], ContextMapOptions { window_tokens: 100.0, cells: 2.0, fit: false });
        assert!(over.overflow);
        assert_eq!(over.cells, ["user", "user"]);
        let empty = build_context_map(&[], ContextMapOptions::default());
        assert!(empty.cells.is_empty());
        assert_eq!(empty.block_tokens, 0.0);
        assert_eq!(ContextMapOptions::default().cells, 128.0);
    }

    #[test]
    fn the_map_value_has_the_node_shape() {
        let value = build_context_map(&[tokens("user", 50.0)], ContextMapOptions { window_tokens: 100.0, cells: 2.0, fit: false }).to_value();
        assert_eq!(value["cells"], serde_json::json!(["user", "free"]));
        assert_eq!(value["blockTokens"], serde_json::json!(50));
        assert_eq!(value["overflow"], serde_json::json!(false));
    }
}
