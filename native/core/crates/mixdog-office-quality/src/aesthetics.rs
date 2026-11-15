//! `design-aesthetics.mjs`: the aesthetic review of rendered pages: page roles, per-role density targets, the issues the
//! render can raise (contrast, density, rhythm, repetition) and the score (version 2). The sampling is
//! [`crate::aesthetics_metrics`].

use mixdog_js::math::{max, to_fixed};
use mixdog_js::{js_to_lowercase, js_trim, json_number, number_to_string};
use mixdog_office_base::values::clamp;
use serde_json::{Map, Value, json};

use crate::aesthetics_metrics::{
    PageMetric, deviation, mean, metric_distance, rendered_aesthetic_metric, rounded, structure_similarity,
};
use crate::issue::issue_with;
use crate::{field, is_truthy, text_or};

/// What a role asks of a page: the foreground and spatial coverage ranges and the quadrants that should be occupied.
struct RoleTarget {
    foreground: [f64; 2],
    spatial: [f64; 2],
    quadrants: f64,
}

/// Calibrated against nine frontier decks (280 rendered pages, September 2026): their content pages read
/// foregroundCoverage 0.024-0.088 at the tenth percentile and 0.09-0.42 at the median, spatialCoverage 0.07-0.65 /
/// 0.35-0.76. The floors sit under those tenth percentiles so a sparse but authored frontier page is not scored as
/// empty.
fn role_target(role: &str) -> RoleTarget {
    let (foreground, spatial, quadrants) = match role {
        "opening" => ([0.035, 0.24], [0.16, 0.5], 2.0),
        "closing" => ([0.03, 0.22], [0.16, 0.5], 2.0),
        // Section and statement beats carry one thesis and air, like a cover.
        "section" => ([0.03, 0.24], [0.16, 0.5], 2.0),
        // A diagram's evidence is native shapes on tinted fields and hairlines; the sampler reads a fraction of it
        // as foreground, so the floor sits low.
        "diagram" => ([0.015, 0.44], [0.08, 0.74], 3.0),
        // A picture slide is mostly picture: the sampler reads the whole frame as foreground, so the ceiling is
        // open and the floor is the frame itself.
        "picture" => ([0.12, 1.0], [0.3, 1.0], 3.0),
        "chart" => ([0.05, 0.42], [0.3, 0.78], 3.0),
        "timeline" => ([0.05, 0.46], [0.3, 0.78], 3.0),
        "allocation" => ([0.04, 0.42], [0.25, 0.75], 3.0),
        "scorecard" => ([0.05, 0.48], [0.3, 0.78], 3.0),
        _ => ([0.03, 0.44], [0.2, 0.74], 3.0),
    };
    RoleTarget { foreground, spatial, quadrants }
}

/// The page's role: an explicit one (a string, or an object's `visualType`, `slideRole`, `role`), else its place.
/// The deck role decides beats before the visual type does: a statement slide carrying one metric is still a beat.
fn normalized_page_role(page: f64, page_count: usize, page_roles: &Value) -> &'static str {
    let key = number_to_string(page);
    // `pageRoles[page] || pageRoles[String(page)]` is one lookup: a number key is its text.
    let explicit = field(page_roles, &key).filter(|value| is_truthy(Some(*value)));
    let lowered = |value: Option<&Value>| js_to_lowercase(js_trim(&text_or(value, "")));
    let (normalized, slide_role) = match explicit {
        None => (String::new(), String::new()),
        Some(Value::String(text)) => (js_to_lowercase(js_trim(text)), String::new()),
        Some(object) => {
            let chosen = ["visualType", "slideRole", "role"].iter().find_map(|name| field(object, name).filter(|value| is_truthy(Some(*value))));
            (lowered(chosen), lowered(field(object, "slideRole")))
        }
    };
    if normalized.contains("cover") || normalized.contains("opening") || page == 1.0 {
        return "opening";
    }
    if normalized.contains("closing") || normalized.contains("decision-close") || page == page_count as f64 {
        return "closing";
    }
    if slide_role.contains("section") || slide_role.contains("statement") || normalized.contains("section") || normalized.contains("statement") {
        return "section";
    }
    if normalized.contains("diagram") {
        return "diagram";
    }
    if normalized.contains("picture") || normalized.contains("photo") || normalized.contains("image") {
        return "picture";
    }
    if normalized.contains("chart") {
        return "chart";
    }
    if normalized.contains("timeline") || normalized.contains("process") || normalized.contains("roadmap") {
        return "timeline";
    }
    if normalized.contains("allocation") || normalized.contains("comparison") || normalized.contains("matrix") {
        return "allocation";
    }
    if normalized.contains("scorecard") || normalized.contains("metric") {
        return "scorecard";
    }
    "content"
}

fn range_fit(value: f64, [minimum, maximum]: [f64; 2]) -> f64 {
    if value >= minimum && value <= maximum {
        return 1.0;
    }
    if value < minimum {
        return clamp(value / max(0.001, minimum), 0.0, 1.0);
    }
    clamp((1.0 - value) / max(0.001, 1.0 - maximum), 0.0, 1.0)
}

fn palette_discipline(metric: &PageMetric, role: &str, format: &str) -> f64 {
    // A workbook with no accent hue, or one, is neutral by design: nothing to penalise, and no xlsx gate reads it.
    if format == "xlsx" && metric.palette_hue_count <= 1 {
        return 1.0;
    }
    // Frontier content pages carry the accent on 3-70% of their foreground; a page with no saturated hue at all is a
    // normal frontier page, and a single hue owning the whole page (dominance 1.0) is the common case.
    let accent_range = if matches!(role, "opening" | "closing" | "section") { [0.05, 0.8] } else { [0.03, 0.7] };
    let hue_count = metric.palette_hue_count;
    let hue_score = if hue_count == 0 {
        0.8
    } else if hue_count <= 3 {
        1.0
    } else {
        clamp(1.0 - (hue_count as f64 - 3.0) * 0.14, 0.0, 1.0)
    };
    let dominant_score = if hue_count == 0 { 0.8 } else { range_fit(metric.palette_dominance, [0.4, 1.0]) };
    clamp(range_fit(metric.accent_coverage, accent_range) * 0.4 + hue_score * 0.35 + dominant_score * 0.25, 0.0, 1.0)
}

struct Composition {
    density_fit: f64,
    score: f64,
}

fn role_aware_composition(metric: &PageMetric, role: &str) -> Composition {
    let target = role_target(role);
    let density_fit =
        mean(&[range_fit(metric.foreground_coverage, target.foreground), range_fit(metric.spatial_coverage, target.spatial)]);
    let quadrant_fit = clamp(metric.occupied_quadrants as f64 / target.quadrants, 0.0, 1.0);
    // Balance and quadrant spread only mean something once the role's density is met; an empty page is not
    // "balanced", so both are weighted by density.
    let presence = clamp(density_fit, 0.0, 1.0).sqrt();
    Composition {
        density_fit,
        score: clamp(density_fit * 0.45 + presence * (metric.spatial_balance * 0.35 + quadrant_fit * 0.2), 0.0, 1.0),
    }
}

fn aesthetic_issue(code: &str, path: &str, message: &str) -> Value {
    issue_with(code, path, message, "aesthetic-review", "warning")
}

fn content_pages(pages: &[PageMetric]) -> &[PageMetric] {
    if pages.len() >= 3 { &pages[1..pages.len() - 1] } else { pages.get(1..).unwrap_or(&[]) }
}

/// What one rendered page can be faulted for on its own reading: its contrast, the two density gates a slide answers,
/// and the worksheet's clutter.
fn page_gate_issues(metric: &PageMetric, format: &str, page_count: usize, role: &str) -> Vec<Value> {
    let mut issues = Vec::new();
    // Beat pages (section/statement) are sparse on purpose; density gates apply to inner pages that carry evidence.
    let beat_page = role == "section";
    // A diagram role is granted from the saved shapes, so the canvas is not empty however little of its tinted fields
    // and hairlines the sampler sees at the document scale; its density still weighs on the composition score.
    let density_gated = !beat_page && role != "diagram";
    let page_text = number_to_string(metric.page);
    // The mean foreground delta drops when tinted fields make up most of the foreground; the marks are judged by the
    // ink decile.
    if metric.foreground_coverage >= 0.008 && metric.foreground_contrast < 0.15 && metric.ink_contrast < 0.35 {
        issues.push(aesthetic_issue(
            "low_visual_contrast",
            &format!("/{}[{page_text}]", if format == "pptx" { "slide" } else { "page" }),
            &format!(
                "Rendered foreground contrast is {}; foreground and background are too similar.",
                to_fixed(metric.foreground_contrast, 2)
            ),
        ));
    }
    let inner = metric.page > 1.0 && metric.page < page_count as f64;
    // Under the frontier tenth percentile on both reads.
    if format == "pptx" && density_gated && inner && metric.foreground_coverage < 0.012 && metric.entropy < 0.1 {
        issues.push(aesthetic_issue(
            "slide_visual_density_low",
            &format!("/slide[{page_text}]"),
            "The content slide has too little visual evidence or hierarchy for a presentation canvas.",
        ));
    }
    // These floors sit under every reference deck's tenth percentile (foreground 0.024, spatial 0.07-0.18).
    if format == "pptx" && !beat_page && inner && density_gated && metric.foreground_coverage < 0.025 && metric.spatial_coverage < 0.15 {
        issues.push(aesthetic_issue(
            "under_composed_slide",
            &format!("/slide[{page_text}]"),
            "The rendered content slide leaves too much of the canvas visually inactive for its evidence load.",
        ));
    }
    if format == "xlsx" && metric.foreground_coverage > 0.62 && metric.entropy > 0.45 && metric.edge_density > 0.28 {
        issues.push(aesthetic_issue(
            "worksheet_visual_clutter",
            &format!("/page[{page_text}]"),
            "The worksheet render is visually saturated; separate the dashboard from supporting detail.",
        ));
    }
    issues
}

struct Rhythm {
    page_count: usize,
    feature_spread: f64,
    adjacent_change: f64,
    repeated_pairs: usize,
    maximum_similarity: f64,
}

impl Rhythm {
    fn to_value(&self) -> Value {
        json!({
            "pageCount": self.page_count,
            "featureSpread": json_number(self.feature_spread),
            "adjacentChange": json_number(self.adjacent_change),
            "repeatedPairs": self.repeated_pairs,
            "maximumSimilarity": json_number(self.maximum_similarity),
        })
    }
}

/// How much the content pages differ from each other, and the two findings a deck that repeats itself earns. Only a
/// deck has rhythm; every other format reports the empty reading.
fn deck_rhythm(measured: &[PageMetric], format: &str) -> (Rhythm, Vec<Value>) {
    let empty = Rhythm { page_count: measured.len(), feature_spread: 0.0, adjacent_change: 0.0, repeated_pairs: 0, maximum_similarity: 0.0 };
    if format != "pptx" {
        return (empty, Vec::new());
    }
    let content = content_pages(measured);
    let column = |read: fn(&PageMetric) -> f64| deviation(&content.iter().map(read).collect::<Vec<_>>());
    let feature_spread = mean(&[
        column(|metric| metric.background_luminance),
        column(|metric| metric.colorfulness_score),
        column(|metric| metric.entropy),
        column(|metric| metric.edge_density),
        column(|metric| metric.foreground_coverage),
    ]);
    let adjacent: Vec<f64> = content.windows(2).map(|pair| metric_distance(&pair[0], &pair[1])).collect();
    let mut repeated_pairs = 0usize;
    let mut maximum_similarity = 0.0f64;
    for left in 0..content.len() {
        for right in left + 1..content.len() {
            let similarity = structure_similarity(&content[left].structure, &content[right].structure);
            maximum_similarity = max(maximum_similarity, similarity);
            if similarity >= 0.985 {
                repeated_pairs += 1;
            }
        }
    }
    let rhythm = Rhythm {
        page_count: measured.len(),
        feature_spread: rounded(feature_spread, 4),
        adjacent_change: rounded(mean(&adjacent), 4),
        repeated_pairs,
        maximum_similarity: rounded(maximum_similarity, 4),
    };
    let mut issues = Vec::new();
    if content.len() >= 4 && rhythm.feature_spread < 0.06 && rhythm.adjacent_change < 0.065 && rhythm.maximum_similarity >= 0.9 {
        issues.push(aesthetic_issue(
            "flat_visual_rhythm",
            "/",
            "Rendered content slides keep nearly the same background, density, color, and complexity; introduce deliberate deck rhythm.",
        ));
    }
    if content.len() >= 4 && repeated_pairs as f64 >= max(2.0, (content.len() as f64 / 2.0).ceil()) {
        issues.push(aesthetic_issue(
            "repeated_render_composition",
            "/",
            &format!("{repeated_pairs} content-slide pairs share a near-identical rendered structure."),
        ));
    }
    (rhythm, issues)
}

struct Score {
    contrast: f64,
    palette: f64,
    rhythm: f64,
    composition: f64,
    overall: f64,
}

/// The v2 score: the four dimensions the pages and the deck's rhythm read, and the weighted overall the frontier gate
/// compares against. `palettes` and `compositions` are the per-page readings, in page order.
fn aesthetic_score(pages: &[PageMetric], palettes: &[f64], compositions: &[f64], rhythm: &Rhythm, format: &str) -> Score {
    let contrasts: Vec<f64> = pages
        .iter()
        .map(|metric| clamp((max(max(metric.contrast_span, metric.foreground_contrast), metric.ink_contrast) - 0.1) / 0.65, 0.0, 1.0))
        .collect();
    let contrast = mean(&contrasts);
    let palette = mean(palettes);
    let composition = mean(compositions);
    let rhythm_score = if format == "pptx" {
        clamp(rhythm.feature_spread * 3.5 + rhythm.adjacent_change * 3.0 + (1.0 - rhythm.maximum_similarity) * 0.25, 0.0, 1.0)
    } else {
        1.0
    };
    Score {
        contrast,
        palette,
        rhythm: rhythm_score,
        composition,
        overall: contrast * 0.32 + palette * 0.18 + rhythm_score * 0.2 + composition * 0.3,
    }
}

fn page_value(metric: &PageMetric, role: &str, density_fit: f64, palette: f64, composition: f64) -> Value {
    let mut map = Map::new();
    let mut put = |key: &str, value: Value| {
        map.insert(key.to_owned(), value);
    };
    put("page", json_number(metric.page));
    put("width", json_number(metric.width));
    put("height", json_number(metric.height));
    put("backgroundLuminance", json_number(metric.background_luminance));
    put("luminanceMean", json_number(metric.luminance_mean));
    put("contrastSpan", json_number(metric.contrast_span));
    put("foregroundContrast", json_number(metric.foreground_contrast));
    put("inkContrast", json_number(metric.ink_contrast));
    put("colorfulness", json_number(metric.colorfulness));
    put("colorfulnessScore", json_number(metric.colorfulness_score));
    put("accentCoverage", json_number(metric.accent_coverage));
    put("paletteHueCount", json!(metric.palette_hue_count));
    put("paletteDominance", json_number(metric.palette_dominance));
    put("entropy", json_number(metric.entropy));
    put("edgeDensity", json_number(metric.edge_density));
    put("foregroundCoverage", json_number(metric.foreground_coverage));
    put("spatialCoverage", json_number(metric.spatial_coverage));
    put("spatialBalance", json_number(metric.spatial_balance));
    put("occupiedQuadrants", json!(metric.occupied_quadrants));
    put("role", json!(role));
    put("densityFit", json_number(rounded(density_fit, 4)));
    put("paletteDiscipline", json_number(rounded(palette, 4)));
    put("compositionScore", json_number(rounded(composition, 4)));
    Value::Object(map)
}

/// `reviewRenderedOfficeAesthetics(images, { format, pageRoles })`: the review of the rendered page images (objects
/// with `data` as base64, `page` or `pages`, `width`, `height`). An image that cannot be decoded is an error, as it
/// was a rejection in Node.
pub fn review_rendered_office_aesthetics(images: &[Value], format: &str, page_roles: &Value) -> Result<Value, String> {
    let normalized = js_to_lowercase(format);
    let mut measured = Vec::new();
    for (index, image) in images.iter().enumerate() {
        if let Some(metric) = rendered_aesthetic_metric(image, index)? {
            measured.push(metric);
        }
    }
    // One role per page: the density gates and the composition score below read the same reading.
    let roles: Vec<&'static str> = measured.iter().map(|metric| normalized_page_role(metric.page, measured.len(), page_roles)).collect();
    let mut issues = Vec::new();
    for (metric, role) in measured.iter().zip(&roles) {
        issues.extend(page_gate_issues(metric, &normalized, measured.len(), role));
    }
    let (rhythm, rhythm_issues) = deck_rhythm(&measured, &normalized);
    issues.extend(rhythm_issues);
    let compositions: Vec<Composition> = measured.iter().zip(&roles).map(|(metric, role)| role_aware_composition(metric, role)).collect();
    let palettes: Vec<f64> = measured.iter().zip(&roles).map(|(metric, role)| rounded(palette_discipline(metric, role, &normalized), 4)).collect();
    let composition_scores: Vec<f64> = compositions.iter().map(|composition| rounded(composition.score, 4)).collect();
    let score = aesthetic_score(&measured, &palettes, &composition_scores, &rhythm, &normalized);
    let pages: Vec<Value> = measured
        .iter()
        .enumerate()
        .map(|(index, metric)| page_value(metric, roles[index], compositions[index].density_fit, palettes[index], compositions[index].score))
        .collect();
    if normalized == "pptx" && measured.len() >= 5 && score.overall < 0.62 {
        issues.push(aesthetic_issue(
            "frontier_aesthetic_score_low",
            "/",
            &format!("Rendered aesthetics v2 score is {}; frontier decks require at least 0.62.", to_fixed(score.overall, 2)),
        ));
    }
    let confidence = clamp(measured.len() as f64 / if normalized == "pptx" { 6.0 } else { 1.0 }, 0.0, 1.0);
    Ok(json!({
        "ok": issues.is_empty(),
        "format": normalized,
        "scoreVersion": 2,
        "score": json_number(rounded(score.overall, 4)),
        "confidence": json_number(rounded(confidence, 4)),
        "dimensions": {
            "contrast": json_number(rounded(score.contrast, 4)),
            "palette": json_number(rounded(score.palette, 4)),
            "rhythm": json_number(rounded(score.rhythm, 4)),
            "composition": json_number(rounded(score.composition, 4)),
        },
        "rhythm": rhythm.to_value(),
        "pages": pages,
        "issues": issues,
    }))
}

#[cfg(test)]
mod tests {
    use mixdog_raster::canvas::Canvas;
    use serde_json::{Value, json};

    use super::*;
    use crate::rendered::test_pages::{page_image, rect};
    use crate::rendered::{RenderedOptions, review_rendered_office_pages};

    fn image(page: u32, draw: impl FnOnce(&mut Canvas)) -> Value {
        page_image(page, 320, 180, draw)
    }

    fn review(images: &[Value], format: &str, page_roles: Value) -> Value {
        let options = RenderedOptions { format: format.to_owned(), page_roles, ..RenderedOptions::default() };
        review_rendered_office_pages(images, &options).expect("review")
    }

    fn has(review: &Value, code: &str) -> bool {
        review["issues"].as_array().expect("issues").iter().any(|entry| entry["code"] == code)
    }

    fn paths(review: &Value, code: &str) -> Vec<String> {
        review["issues"]
            .as_array()
            .expect("issues")
            .iter()
            .filter(|entry| entry["code"] == code)
            .map(|entry| entry["path"].as_str().expect("path").to_owned())
            .collect()
    }

    fn deck(count: u32, draw: impl Fn(u32, &mut Canvas)) -> Vec<Value> {
        (1..=count).map(|page| image(page, |canvas| draw(page, canvas))).collect()
    }

    #[test]
    fn rendered_pptx_aesthetics_reject_a_flat_repeated_deck_and_accept_deliberate_visual_rhythm() {
        let repeated = deck(6, |_, c| {
            rect(c, "#080C12", 0.0, 0.0, 320.0, 180.0);
            rect(c, "#F8FAFC", 24.0, 20.0, 190.0, 12.0);
            rect(c, "#151D28", 24.0, 58.0, 272.0, 96.0);
            rect(c, "#58A6FF", 34.0, 70.0, 70.0, 58.0);
        });
        let flat = review(&repeated, "pptx", json!({}));
        assert!(has(&flat, "flat_visual_rhythm"));
        assert!(has(&flat, "repeated_render_composition"));

        let accents = ["#1F7A55", "#A3425A", "#276FBF", "#8F5B24"];
        let varied = deck(6, |page, c| {
            let index = page - 1;
            if index == 0 || index == 5 {
                rect(c, "#132C3F", 0.0, 0.0, 320.0, 180.0);
                rect(c, "#FFFFFF", 28.0, 60.0, 190.0, 18.0);
                return;
            }
            rect(c, "#F7F9FC", 0.0, 0.0, 320.0, 180.0);
            rect(c, "#17212C", 20.0, 16.0, 220.0, 10.0);
            let accent = accents[index as usize - 1];
            match index {
                1 => rect(c, accent, 20.0, 50.0, 92.0, 108.0),
                2 => {
                    rect(c, accent, 20.0, 58.0, 270.0, 18.0);
                    rect(c, accent, 20.0, 92.0, 210.0, 18.0);
                    rect(c, accent, 20.0, 126.0, 145.0, 18.0);
                }
                3 => {
                    rect(c, accent, 172.0, 46.0, 120.0, 112.0);
                    rect(c, "#DCE8F2", 20.0, 46.0, 124.0, 48.0);
                }
                _ => {
                    rect(c, accent, 20.0, 54.0, 72.0, 90.0);
                    rect(c, accent, 124.0, 54.0, 72.0, 90.0);
                    rect(c, accent, 228.0, 54.0, 72.0, 90.0);
                }
            }
        });
        let varied = review(&varied, "pptx", json!({}));
        assert!(!has(&varied, "flat_visual_rhythm"));
        assert!(!has(&varied, "repeated_render_composition"));
        assert_eq!(varied["aesthetics"]["scoreVersion"], 2);
        let dimensions: Vec<&str> = varied["aesthetics"]["dimensions"].as_object().expect("dimensions").keys().map(String::as_str).collect();
        assert_eq!(dimensions, ["contrast", "palette", "rhythm", "composition"]);
    }

    #[test]
    fn frontier_render_review_rejects_visually_inactive_content_slides_even_when_they_are_clean() {
        let sparse = deck(6, |page, c| {
            let edge = page == 1 || page == 6;
            rect(c, if edge { "#132C3F" } else { "#FFFFFF" }, 0.0, 0.0, 320.0, 180.0);
            // A content page under the frontier tenth percentile on both reads: a short title line and one small
            // mark on an otherwise empty canvas.
            rect(c, if edge { "#FFFFFF" } else { "#172B25" }, 24.0, 28.0, if edge { 190.0 } else { 90.0 }, if edge { 11.0 } else { 8.0 });
            if edge {
                rect(c, "#20B486", 230.0, 70.0, 56.0, 64.0);
            } else {
                rect(c, "#20B486", 238.0, 116.0, 12.0, 10.0);
            }
        });
        let result = review(&sparse, "pptx", json!({}));
        assert!(has(&result, "under_composed_slide"));
        assert!(has(&result, "frontier_aesthetic_score_low"));
    }

    #[test]
    fn render_review_catches_low_contrast_word_pages_and_visually_saturated_worksheets() {
        let low = page_image(1, 320, 240, |c| rect(c, "#DDDDDD", 32.0, 36.0, 256.0, 110.0));
        assert!(has(&review(&[low], "docx", json!({})), "low_visual_contrast"));

        let cluttered = image(1, |c| {
            let mut y = 0;
            while y < 180 {
                let mut x = 0;
                while x < 320 {
                    rect(c, if (x / 6 + y / 6) % 2 != 0 { "#FFFFFF" } else { "#111111" }, x as f32, y as f32, 6.0, 6.0);
                    x += 6;
                }
                y += 6;
            }
        });
        assert!(has(&review(&[cluttered], "xlsx", json!({})), "worksheet_visual_clutter"));
    }

    #[test]
    fn palette_discipline_does_not_reward_rainbow_saturation_over_a_restrained_accent_system() {
        let make = |rainbow: bool| {
            deck(6, |page, c| {
                let edge = page == 1 || page == 6;
                rect(c, if edge { "#142A3B" } else { "#F7F9FC" }, 0.0, 0.0, 320.0, 180.0);
                rect(c, if edge { "#FFFFFF" } else { "#18242F" }, 24.0, 20.0, 210.0, 12.0);
                let colours: &[&str] = if rainbow { &["#E53935", "#FB8C00", "#FDD835", "#43A047", "#1E88E5", "#8E24AA"] } else { &["#0B8F78"] };
                for (index, colour) in colours.iter().enumerate() {
                    rect(c, colour, 24.0 + index as f32 * 42.0, 58.0, if rainbow { 38.0 } else { 248.0 }, 82.0);
                }
            })
        };
        let disciplined = review(&make(false), "pptx", json!({}));
        let saturated = review(&make(true), "pptx", json!({}));
        let palette = |value: &Value| value["aesthetics"]["dimensions"]["palette"].as_f64().expect("palette");
        assert!(palette(&disciplined) > palette(&saturated), "{} vs {}", palette(&disciplined), palette(&saturated));
    }

    #[test]
    fn role_aware_composition_allows_editorial_closing_whitespace_but_expects_denser_chart_evidence() {
        let images = deck(6, |_, c| {
            rect(c, "#F7F9FC", 0.0, 0.0, 320.0, 180.0);
            rect(c, "#18313E", 28.0, 34.0, 110.0, 12.0);
            rect(c, "#178D75", 222.0, 112.0, 34.0, 24.0);
        });
        let closing = review(&images, "pptx", json!({ "3": "decision-close" }));
        let chart = review(&images, "pptx", json!({ "3": "annotated-chart" }));
        let fit = |value: &Value| value["aesthetics"]["pages"][2]["densityFit"].as_f64().expect("densityFit");
        assert!(fit(&closing) > fit(&chart), "{} vs {}", fit(&closing), fit(&chart));
    }

    #[test]
    fn a_statement_beat_is_judged_as_a_section_not_as_an_under_composed_content_slide() {
        let images = deck(5, |_, c| {
            rect(c, "#0B1F33", 0.0, 0.0, 320.0, 180.0);
            rect(c, "#F7FAFC", 28.0, 60.0, 90.0, 12.0);
        });
        let as_content = review(&images, "pptx", json!({}));
        let as_beat = review(&images, "pptx", json!({ "2": { "slideRole": "section", "visualType": "metric" } }));
        assert!(paths(&as_content, "under_composed_slide").contains(&"/slide[2]".to_owned()));
        assert!(!paths(&as_beat, "under_composed_slide").contains(&"/slide[2]".to_owned()));
        assert_eq!(as_beat["aesthetics"]["pages"][1]["role"], "section");
    }

    #[test]
    fn a_diagram_slide_is_held_to_a_lower_under_composed_floor_than_a_text_slide() {
        // Light tinted fields and one hairline: what a brace-group or 2x2 slide leaves for the sampler.
        let images = deck(5, |_, c| {
            rect(c, "#F7F9FC", 0.0, 0.0, 320.0, 180.0);
            rect(c, "#18242F", 24.0, 20.0, 100.0, 9.0);
            rect(c, "#EEF2F6", 24.0, 50.0, 130.0, 110.0);
            rect(c, "#EEF2F6", 166.0, 50.0, 130.0, 110.0);
            rect(c, "#178D75", 60.0, 100.0, 40.0, 6.0);
        });
        let as_content = review(&images, "pptx", json!({}));
        let as_diagram = review(&images, "pptx", json!({ "3": { "visualType": "diagram" } }));
        assert!(paths(&as_content, "under_composed_slide").contains(&"/slide[3]".to_owned()));
        assert!(!paths(&as_diagram, "under_composed_slide").contains(&"/slide[3]".to_owned()));
        assert_eq!(as_diagram["aesthetics"]["pages"][2]["role"], "diagram");
        let fit = |value: &Value| value["aesthetics"]["pages"][2]["densityFit"].as_f64().expect("densityFit");
        assert!(fit(&as_diagram) > fit(&as_content));
    }

    // Past twelve pages the render groups pages into contact sheets; the review must read the pages the sheet
    // carries, never the sheet's grey field.
    #[test]
    fn the_render_review_reads_the_pages_behind_a_contact_sheet_not_the_sheet() {
        let page = |number: u32, dark: bool| {
            image(number, |c| {
                rect(c, if dark { "#0B1F33" } else { "#F7F9FC" }, 0.0, 0.0, 320.0, 180.0);
                rect(c, if dark { "#F7FAFC" } else { "#18242F" }, 24.0, 20.0, 150.0, 12.0);
                rect(c, "#178D75", 24.0, 50.0, 120.0, 90.0);
            })
        };
        let sheet = |first: u32, numbers: &[u32]| {
            let mut value = image(first, |c| rect(c, "#EEF0F4", 0.0, 0.0, 320.0, 180.0));
            value["pages"] = json!(numbers);
            value["pageImages"] = Value::Array(numbers.iter().map(|number| page(*number, *number == 1 || *number == 6)).collect());
            value
        };
        let result = review(&[sheet(1, &[1, 2, 3]), sheet(4, &[4, 5, 6])], "pptx", json!({}));
        let pages = result["aesthetics"]["pages"].as_array().expect("pages");
        let numbers: Vec<u64> = pages.iter().map(|entry| entry["page"].as_u64().expect("page")).collect();
        assert_eq!(numbers, [1, 2, 3, 4, 5, 6]);
        assert_eq!(pages[0]["role"], "opening");
        assert_eq!(pages[5]["role"], "closing");
        assert!(pages.iter().all(|entry| {
            let luminance = entry["backgroundLuminance"].as_f64().expect("backgroundLuminance");
            luminance < 0.2 || luminance > 0.9
        }));
    }

    #[test]
    fn a_page_role_comes_from_a_string_an_object_or_the_place_of_the_page() {
        let roles = json!({ "2": "Cover page", "3": { "role": "Timeline" }, "4": { "visualType": "photo", "slideRole": "statement" }, "5": 7 });
        assert_eq!(normalized_page_role(1.0, 6, &roles), "opening");
        assert_eq!(normalized_page_role(2.0, 6, &roles), "opening");
        assert_eq!(normalized_page_role(3.0, 6, &roles), "timeline");
        assert_eq!(normalized_page_role(4.0, 6, &roles), "section");
        assert_eq!(normalized_page_role(5.0, 6, &roles), "content");
        assert_eq!(normalized_page_role(6.0, 6, &roles), "closing");
    }
}
