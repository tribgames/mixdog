//! Numeric and classification helpers shared by the ledger's reads and writes
//! (`usage-rollup.mjs`, `usage-measurement.mjs`).

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde_json::Number;
use serde_json::Value;

/// The cost source of a failure that reported no usage: the request log lists it, but
/// statistics and quota totals add no turn for it.
pub const NO_USAGE_COST_SOURCE: &str = "none";

/// Marks a model key as that model's Fast-mode calls.
pub const FAST_KEY: &str = "\u{0}fast";

pub fn route_key(provider: &str, model: &str, fast: bool) -> String {
    if fast {
        format!("{provider}/{model}{FAST_KEY}")
    } else {
        format!("{provider}/{model}")
    }
}

/// A finite positive number, else 0.
pub fn num(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        0.0
    }
}

/// `value || 0` for a JSON number.
pub fn json_or_zero(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| !n.is_nan())
        .unwrap_or(0.0)
}

/// The JSON a JavaScript number serializes to: an integral value is an integer.
pub fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.007_199_254_740_992e15 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

const BACKGROUND_SOURCES: [&str; 5] = [
    "memory-cycle",
    "schedule",
    "webhook",
    "native-web-search",
    "cache-warm",
];

/// A turn belongs to the user's conversation unless it came from a background runner. An
/// unknown source counts as conversation on purpose.
pub fn is_conversation_source(source_type: Option<&str>) -> bool {
    let id = source_type.map_or_else(String::new, |s| mixdog_js::js_trim(s).to_lowercase());
    !BACKGROUND_SOURCES.contains(&id.as_str())
}

/// Cursor's native agent protocol reports output deltas and context occupancy, not
/// per-request input/cache usage: both its routes are never aggregated as measured spend.
pub fn is_unmeasuring_provider(provider: &str) -> bool {
    provider == "cursor-oauth" || provider == "cursor-api"
}

/// SQL form of "this route's requests ran in Fast mode", over a stored route signature.
pub fn fast_route_sql(signature: &str) -> String {
    format!(
        "(COALESCE(json_extract(json_extract({signature},'$[5]'),'$.requestServiceTier') IN ('fast','priority','ultrafast'),0)
    AND NOT (COALESCE(json_extract({signature},'$[2]'),'')='api'
        AND COALESCE(json_extract(json_extract({signature},'$[5]'),'$.serviceTier'),'')='default'))"
    )
}

/// A stored day number as `YYYY-MM-DD`, in SQL.
pub fn day_text_sql(alias: &str) -> String {
    format!("printf('%04d-%02d-%02d',{alias}.day/10000,({alias}.day/100)%100,{alias}.day%100)")
}

impl<V> IntoIterator for Ordered<V> {
    type Item = (String, V);
    type IntoIter = std::vec::IntoIter<(String, V)>;

    fn into_iter(self) -> Self::IntoIter {
        self.items.into_iter()
    }
}

impl<V> FromIterator<(String, V)> for Ordered<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(iter: I) -> Self {
        let mut out = Ordered::default();
        for (key, value) in iter {
            out.insert(key, value);
        }
        out
    }
}

/// A string-keyed map that lists its entries in insertion order, like a JavaScript `Map`.
#[derive(Clone, Debug, PartialEq)]
pub struct Ordered<V> {
    index: std::collections::HashMap<String, usize>,
    items: Vec<(String, V)>,
}

impl<V> Default for Ordered<V> {
    fn default() -> Self {
        Self {
            index: std::collections::HashMap::new(),
            items: Vec::new(),
        }
    }
}

impl<V> Ordered<V> {
    pub fn get(&self, key: &str) -> Option<&V> {
        self.index.get(key).map(|at| &self.items[*at].1)
    }

    /// The entry for `key`, created with `make` the first time.
    pub fn entry(&mut self, key: &str, make: impl FnOnce() -> V) -> &mut V {
        let at = match self.index.get(key) {
            Some(at) => *at,
            None => {
                self.items.push((key.to_string(), make()));
                self.index.insert(key.to_string(), self.items.len() - 1);
                self.items.len() - 1
            }
        };
        &mut self.items[at].1
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        let at = *self.index.get(key)?;
        Some(&mut self.items[at].1)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.index.contains_key(key)
    }

    /// `map[key] = value`: an existing key keeps its place, a new one goes last.
    pub fn insert(&mut self, key: String, value: V) {
        match self.index.get(&key) {
            Some(at) => self.items[*at].1 = value,
            None => {
                self.index.insert(key.clone(), self.items.len());
                self.items.push((key, value));
            }
        }
    }

    /// `delete map[key]`: the others keep their order.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let at = self.index.remove(key)?;
        let (_, value) = self.items.remove(at);
        for slot in self.index.values_mut() {
            if *slot > at {
                *slot -= 1;
            }
        }
        Some(value)
    }

    pub fn values_mut(&mut self) -> impl Iterator<Item = &mut V> {
        self.items.iter_mut().map(|(_, v)| v)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.items.iter().map(|(k, v)| (k, v))
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.items.iter().map(|(_, v)| v)
    }
}

/// `Number(value)` kept only when finite and positive, else 0 (`num` of `usage-rollup.mjs`);
/// a missing value is `undefined`, which is `NaN`.
pub fn amount(value: Option<&Value>) -> f64 {
    num(value.map_or(f64::NAN, mixdog_js::to_number))
}

/// A string value trimmed like `String.prototype.trim`; anything else is empty.
pub fn trimmed(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map_or_else(String::new, |s| mixdog_js::js_trim(s).to_string())
}

/// `value === true`.
pub fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

/// Turns with a known cost: the recorded count, else every turn when the usage carries any
/// cost at all.
pub fn known_cost_turns(usage: &Value) -> f64 {
    match usage.get("costKnownTurns") {
        Some(known) if !known.is_null() => amount(Some(known)),
        _ if amount(usage.get("costUsd")) > 0.0 => amount(usage.get("turns")),
        _ => 0.0,
    }
}

/// `Math.round(value * 10 ** digits) / 10 ** digits`.
pub fn round_to(value: f64, digits: i32) -> f64 {
    let factor = mixdog_js::math::pow(10.0, f64::from(digits));
    mixdog_js::math::round(value * factor) / factor
}

/// Orders model rows by each model's combined fields (descending, in order), keeping a
/// model's Fast row directly under its normal row (`sortFastBesideModel`).
pub fn sort_fast_beside_model(
    rows: &mut [Value],
    model_of: impl Fn(&Value) -> String,
    fields: &[&str],
) {
    let mut sums: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for row in rows.iter() {
        let sum = sums
            .entry(model_of(row))
            .or_insert_with(|| vec![0.0; fields.len()]);
        for (index, field) in fields.iter().enumerate() {
            sum[index] += row.get(*field).and_then(Value::as_f64).unwrap_or(f64::NAN);
        }
    }
    rows.sort_by(|a, b| {
        let (x, y) = (&sums[&model_of(a)], &sums[&model_of(b)]);
        if let Some(lead) = (0..fields.len()).find(|i| y[*i] != x[*i]) {
            return (y[lead] - x[lead])
                .partial_cmp(&0.0)
                .unwrap_or(Ordering::Equal);
        }
        mixdog_js::locale_compare(&model_of(a), &model_of(b))
            .then_with(|| is_true(a.get("fast")).cmp(&is_true(b.get("fast"))))
    });
}
