//! The offline icon set an authoring script reaches through `ICON(name)` and an HTML page through
//! `<i data-icon="name">`: a curated Lucide subset (`assets/pptx-icons.json`) stored as inner SVG markup, so a deck is
//! drawn at any colour and size without a network or an icon library (`pptx-icons.mjs`).

use std::sync::LazyLock;

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;
use mixdog_js::number_to_string;
use serde_json::Map;
use serde_json::Value;

/// The set as it ships: `source`, `version`, `license`, `viewBox` and the `icons` table (name to inner markup).
const SET: &str = include_str!("../assets/pptx-icons.json");

/// How many names an unknown icon's error offers.
const NEAREST: usize = 8;

/// The icon set, read once.
pub struct IconSet {
    meta: Value,
    table: Map<String, Value>,
}

static ICONS: LazyLock<IconSet> = LazyLock::new(|| {
    let meta: Value = serde_json::from_str(SET).expect("assets/pptx-icons.json is valid JSON");
    let table = meta["icons"].as_object().cloned().expect("assets/pptx-icons.json has an icons table");
    IconSet { meta, table }
});

/// The set shipped with the product.
pub fn icons() -> &'static IconSet {
    &ICONS
}

/// The options of [`IconSet::svg`]: the colour as hex with or without `#`, the size in px and the stroke width.
#[derive(Clone, Debug, PartialEq)]
pub struct SvgOptions {
    pub color: String,
    pub size: f64,
    pub stroke_width: f64,
}

impl Default for SvgOptions {
    fn default() -> Self {
        Self { color: "000000".to_string(), size: 96.0, stroke_width: 2.0 }
    }
}

impl IconSet {
    fn text(&self, key: &str) -> &str {
        self.meta[key].as_str().unwrap_or_default()
    }

    /// The `viewBox` every icon is drawn in.
    pub fn view_box(&self) -> &str {
        self.text("viewBox")
    }

    /// Every icon name, in the order the set lists them (`ICON.names`).
    pub fn names(&self) -> Vec<&str> {
        self.table.keys().map(String::as_str).collect()
    }

    /// Where the set comes from, as `ICON.source` words it.
    pub fn source(&self) -> String {
        format!("{} {} ({})", self.text("source"), self.text("version"), self.text("license"))
    }

    /// The table `injectIcons` takes in the page: every name with its markup.
    pub fn table(&self) -> Value {
        Value::Object(self.table.clone())
    }

    /// The names closest to `name`, best first (at most eight): a name that contains or is contained by it counts 3,
    /// each of its words 2 as a whole word of the icon's name and 1 inside it.
    pub fn nearest(&self, name: &str) -> Vec<String> {
        let wanted = js_to_lowercase(name);
        let parts: Vec<&str> = wanted.split(['-', '_', ' ']).filter(|part| !part.is_empty()).collect();
        let compact: String = wanted.chars().filter(|c| !matches!(c, '-' | '_' | ' ')).collect();
        let mut scored: Vec<(usize, &str)> = self
            .table
            .keys()
            .map(|candidate| {
                let mut score = 0;
                let flat = candidate.replace('-', "");
                if candidate.contains(&wanted) || wanted.contains(candidate.as_str()) || flat.contains(&compact) || compact.contains(&flat) {
                    score += 3;
                }
                for part in &parts {
                    if candidate.split('-').any(|piece| piece == *part) {
                        score += 2;
                    } else if candidate.contains(part) {
                        score += 1;
                    }
                }
                (score, candidate.as_str())
            })
            .filter(|(score, _)| *score > 0)
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| locale_compare(a.1, b.1)));
        scored.into_iter().take(NEAREST).map(|(_, candidate)| candidate.to_string()).collect()
    }

    /// `ICON(name)`: the inner SVG markup of the icon, or the error that names the closest icons.
    pub fn markup(&self, name: &str) -> Result<&str, String> {
        let key = js_to_lowercase(js_trim(name));
        if let Some(markup) = self.table.get(&key).and_then(Value::as_str) {
            return Ok(markup);
        }
        let hint = self.nearest(&key);
        Err(format!(
            "ICON('{name}') is not in the icon set ({} Lucide icons).{} ICON.names lists them all.",
            self.table.len(),
            if hint.is_empty() { String::new() } else { format!(" Nearest: {}.", hint.join(", ")) }
        ))
    }

    /// `ICON.svg(name, options)`: the whole SVG at a pixel size, a stroke icon taking the colour as its stroke.
    pub fn svg(&self, name: &str, options: &SvgOptions) -> Result<String, String> {
        let hex = options.color.strip_prefix('#').unwrap_or(&options.color);
        Ok(format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{size}\" height=\"{size}\" viewBox=\"{view_box}\" fill=\"none\" stroke=\"#{hex}\" stroke-width=\"{stroke}\" stroke-linecap=\"round\" stroke-linejoin=\"round\">{markup}</svg>",
            size = number_to_string(options.size),
            view_box = self.view_box(),
            stroke = number_to_string(options.stroke_width),
            markup = self.markup(name)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_set_is_read() {
        let set = icons();
        assert_eq!(set.view_box(), "0 0 24 24");
        assert!(set.names().len() > 100);
        assert_eq!(set.names()[0], "arrow-right");
        assert_eq!(set.source(), "lucide-static 1.41.0 (ISC)");
        assert_eq!(set.table().as_object().map(Map::len), Some(set.names().len()));
    }

    #[test]
    fn a_name_is_read_trimmed_and_in_lower_case() {
        let set = icons();
        let plain = set.markup("arrow-right").unwrap();
        assert!(plain.starts_with("<path d=\"M5 12h14\""));
        assert_eq!(set.markup("  Arrow-Right ").unwrap(), plain);
    }

    #[test]
    fn an_unknown_name_is_refused_with_its_nearest_icons() {
        let set = icons();
        let error = set.markup("Arrow Rite").unwrap_err();
        assert!(error.starts_with(&format!("ICON('Arrow Rite') is not in the icon set ({} Lucide icons). Nearest: ", set.names().len())), "{error}");
        assert!(error.ends_with(" ICON.names lists them all."), "{error}");
        let nearest = set.nearest("arrow rite");
        assert!(nearest.len() <= 8);
        assert!(nearest.iter().all(|name| name.contains("arrow")), "{nearest:?}");
        // A word of the name and a name it contains rank ahead of a name that only holds a part of a word.
        assert_eq!(set.nearest("arrow-right")[0], "arrow-right");
    }

    #[test]
    fn a_name_nothing_matches_has_no_hint() {
        let error = icons().markup("zzzzqqqq").unwrap_err();
        assert!(error.contains("Lucide icons). ICON.names lists them all."), "{error}");
    }

    #[test]
    fn the_whole_svg_carries_the_colour_size_and_stroke() {
        let set = icons();
        let svg = set.svg("arrow-right", &SvgOptions { color: "#1F7A4D".into(), size: 48.0, stroke_width: 1.5 }).unwrap();
        assert!(svg.starts_with(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"48\" height=\"48\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"#1F7A4D\" stroke-width=\"1.5\""
        ));
        assert!(svg.ends_with("</svg>"));
        let default = set.svg("arrow-right", &SvgOptions::default()).unwrap();
        assert!(default.contains("width=\"96\"") && default.contains("stroke=\"#000000\"") && default.contains("stroke-width=\"2\""));
        assert!(set.svg("nothing-like-it", &SvgOptions::default()).is_err());
    }
}
