//! The design review of an Office document: `src/runtime/office/quality/design-review.mjs` (fonts and colours read straight
//! from the saved shapes, discipline, the deck-scale readings, the composition sequence) with the modules it is built
//! from: [`authored`] (rules that hold for authored decks), [`critique`] (the model's visual critique and its
//! acknowledgement gate), [`diversity`] (how the pages of a deck differ), [`rubric`] (a deck's score) and
//! [`slide_roles`] (roles read from saved shapes). Inputs and outputs are JSON values with the key order Node writes, so
//! the wording and the numbers are Node's.
//!
//! The deck page receipt and the authoring brief live in `mixdog-office-author`, which itself uses this crate, so the
//! readings reach the review through [`AuthorReads`]; the author crate (or the caller that holds both) answers it.

use mixdog_js::{
    is_js_space, js_to_lowercase, js_trim, math, number_to_radix, number_to_string, string_to_number, to_number_of, utf16_len, value_to_string,
};
use mixdog_office_base::values::truthy;
use mixdog_office_design::composition::review_office_composition_sequence;
use mixdog_office_design::design_system::resolve_office_design;
use mixdog_office_design::discipline::{
    MAX_ACCENT_HUE_FAMILIES, MAX_FONT_FAMILIES_PER_SLIDE, font_family_key, is_motif_shape, is_picture_shape, is_safe_font_family,
    saturated_hue_families,
};
use mixdog_office_design::native_design::uses_native_office_design;
use mixdog_office_design::tokens::hex;
use serde_json::{Map, Value, json};

use crate::document_design_review::review_native_document_design;
use crate::issue::issue_with;
use crate::pipeline::is_advisory_office_issue;
use crate::structure::{list, num0, review_office_structure, text, trimmed};
use crate::{field, field_of, is_truthy, strict_equals, template_text};

pub mod authored;
pub mod critique;
pub mod diversity;
pub mod rubric;
pub mod slide_roles;

pub use critique::{pptx_visual_review_acknowledged, review_pptx_visual_critique};
pub use slide_roles::{infer_pptx_slide_roles, is_pptx_diagram_slide, is_pptx_picture_slide, is_pptx_statement_slide};

use authored::{authored_background_ladder, is_card_grid_slide, is_ornamental_stripe, ladder_color, slide_size};
use diversity::review_pptx_deck_diversity;
use slide_roles::{Size, is_pptx_specimen_slide};

/// What the review reads from the authoring side of an Office document: the page receipt of a saved slide and the
/// readings of the deck's authoring brief (`authoring/pptx-receipt.mjs`, `authoring/pptx-brief.mjs`).
pub trait AuthorReads {
    /// `slideReceipt(slide)` on the wide canvas.
    fn slide_receipt(&self, slide: &Value) -> Value;
    /// `isShowcaseBrief(brief)`: a deck read from the back of a room; an absent brief is `null`.
    fn is_showcase_brief(&self, brief: &Value) -> bool;
    /// `reviewBriefPromises(document, brief)`: the skeleton each plan line promised.
    fn review_brief_promises(&self, document: &Value, brief: &Value) -> Vec<Value>;
    /// `reviewFactCoverage(document, brief)`: figures the slides show that no fact backs.
    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value>;
    /// `reviewSourceGrounding(brief)`: facts whose source a reader cannot open.
    fn review_source_grounding(&self, brief: &Value) -> Vec<Value>;
}

/// `Number(value.toFixed(digits))`.
pub(crate) fn fixed(value: f64, digits: usize) -> f64 {
    string_to_number(&math::to_fixed(value, digits))
}

/// `.replace(/\s+/g, ' ').trim()`.
pub(crate) fn squash(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_space = false;
    for c in value.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    js_trim(&out).to_owned()
}

/// `list.sort()` over strings: by UTF-16 code units.
pub(crate) fn utf16_sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    list
}

fn design_issue(code: &str, path: &str, message: &str) -> Value {
    issue_with(code, path, message, "design-review", "warning")
}

/// The plan of a slide number (`plansBySlide.get(n)`): the last plan that names it; a plan with no number matches a
/// slide with none (a `Map` key `NaN` is found).
fn plan_for(plans: &[Value], slide: f64) -> Option<&Value> {
    plans.iter().rev().find(|plan| {
        let number = to_number_of(field(plan, "slide"));
        number == slide || (number.is_nan() && slide.is_nan())
    })
}

fn background_color(slide: &Value) -> String {
    match hex(field_of(field(slide, "background"), "color"), Value::String(String::new())) {
        Value::String(color) => color,
        _ => String::new(),
    }
}

/// `pptxExpectedSlideRole(slide, slides, deck, plansBySlide)` for the slide whose index is `index` in a deck of `count`.
fn expected_slide_role(index: Option<&Value>, count: usize, deck: &Value, plans: &[Value]) -> &'static str {
    let plan = plan_for(plans, to_number_of(index));
    let planned = js_to_lowercase(&if is_truthy(field_of(plan, "slideRole")) { text(field_of(plan, "slideRole")) } else { text(field_of(plan, "kind")) });
    for known in ["cover", "content", "section", "closing"] {
        if planned == known {
            return known;
        }
    }
    let one = Value::from(1);
    if strict_equals(index, Some(&one)) {
        return "cover";
    }
    if list(field(deck, "sectionSlides")).iter().any(|section| strict_equals(Some(section), index)) {
        return "section";
    }
    if count >= 3 && strict_equals(index, Some(&Value::from(count))) {
        return "closing";
    }
    "content"
}

/// `pptxExpectedBackgroundRole(slide, slides, deck, plansBySlide)`: the role the plan names, else the deck's role for the
/// slide's own role (absent when the deck names none).
fn expected_background_role(index: Option<&Value>, count: usize, deck: &Value, plans: &[Value]) -> Option<String> {
    let planned = trimmed(field_of(plan_for(plans, to_number_of(index)), "backgroundRole"));
    if !planned.is_empty() {
        return Some(planned);
    }
    field_of(field(deck, "roles"), expected_slide_role(index, count, deck, plans)).map(value_to_string)
}

fn review_pptx_theme(document: &Value, design: &Value, issues: &mut Vec<Value>) {
    let slides = list(field(document, "slides"));
    let deck = field(design, "deck");
    let Some(deck) = deck.filter(|deck| is_truthy(field(deck, "enforce"))) else { return };
    if field(deck, "backgroundMode").and_then(Value::as_str) == Some("custom") || slides.len() < 2 {
        return;
    }
    let plans = list(field(design, "slidePlans"));
    let slide_count = f64::max(slides.len() as f64, num0(field(document, "slideCount")));
    let role_slides: Vec<Value> = (1..=(slide_count as usize)).map(Value::from).collect();
    let backgrounds: Vec<String> = slides.iter().map(background_color).collect();
    if backgrounds.iter().any(String::is_empty) {
        return;
    }
    // An authored deck drew its own palette: judge it against its own ladder (cover = inverse, dominant content color =
    // canvas), not the composer's. A brief gives an authored deck slide plans too, so plan presence does not mean the
    // composer drew it; only a plan that names the background role does.
    let composed_backgrounds = plans.iter().any(|plan| !trimmed(field(plan, "backgroundRole")).is_empty());
    let colors = field_of(field(design, "tokens"), "colors");
    let own_ladder = if composed_backgrounds { None } else { authored_background_ladder(&backgrounds, colors) };
    let color_for = |role: Option<&str>| -> String {
        let key = role.unwrap_or("undefined");
        match &own_ladder {
            Some(ladder) => ladder_color(ladder, key).to_uppercase(),
            None => text(field_of(colors, key)).to_uppercase(),
        }
    };
    let mut mismatches: Vec<String> = Vec::new();
    for (at, slide) in slides.iter().enumerate() {
        let index = field(slide, "index");
        let role = expected_background_role(index, role_slides.len(), deck, plans);
        let expected = color_for(role.as_deref());
        // With its own ladder the author decides which slide takes the inverse field (a light cover with a dark closing is
        // a composition, not an error); only a third color, outside the deck's own two backgrounds, is drift.
        let allowed = own_ladder.as_ref().is_some_and(|ladder| backgrounds[at] == ladder.inverse || backgrounds[at] == ladder.canvas);
        if !expected.is_empty() && backgrounds[at] != expected && !allowed {
            mismatches.push(format!("{}:{}→{}", template_text(index), backgrounds[at], role.as_deref().unwrap_or("undefined")));
        }
    }
    if !mismatches.is_empty() {
        issues.push(design_issue(
            "theme_background_drift",
            "/",
            &format!("Slide backgrounds violate the {} deck plan ({}).", template_text(field(deck, "backgroundMode")), mismatches.join(", ")),
        ));
    }
    let complete_plan = !role_slides.is_empty() && role_slides.iter().all(|slide| plan_for(plans, to_number_of(Some(slide))).is_some());
    let is_content = |index: Option<&Value>| expected_slide_role(index, role_slides.len(), deck, plans) == "content";
    let content_colors: Vec<String> = if complete_plan {
        role_slides
            .iter()
            .filter(|slide| is_content(Some(*slide)))
            .map(|slide| color_for(expected_background_role(Some(slide), role_slides.len(), deck, plans).as_deref()))
            .filter(|color| !color.is_empty())
            .collect()
    } else if slides.len() as f64 == slide_count {
        slides.iter().filter(|slide| is_content(field(slide, "index"))).map(background_color).collect()
    } else {
        Vec::new()
    };
    let mut counts: Vec<(&String, usize)> = Vec::new();
    for color in &content_colors {
        match counts.iter_mut().find(|(known, _)| *known == color) {
            Some((_, count)) => *count += 1,
            None => counts.push((color, 1)),
        }
    }
    let dominant = counts.iter().map(|(_, count)| *count).max().unwrap_or(0);
    // A brief that declares a concept or a palette owns its fields: body slides in colour are its design.
    let brief = field(design, "brief");
    let declared_fields = is_truthy(field_of(brief, "concept")) || is_truthy(field_of(brief, "palette"));
    if !declared_fields && !content_colors.is_empty() && (dominant as f64 / content_colors.len() as f64) < 0.75 {
        issues.push(design_issue("theme_body_backgrounds", "/", "Content slides use multiple background colors instead of one dominant canvas."));
    }
}

/// Both snapshots report a text colour as RRGGBB; a fill from Microsoft Office is still a BGR long.
fn com_color_hex(value: Option<&Value>) -> String {
    if let Some(Value::String(written)) = value {
        let trimmed = js_trim(written);
        let digits = trimmed.strip_prefix('#').unwrap_or(trimmed);
        if digits.len() == 6 && digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return digits.to_uppercase();
        }
    }
    let number = to_number_of(value);
    if !number.is_finite() || number < 0.0 {
        return String::new();
    }
    let blue = math::floor(number / 65_536.0) % 256.0;
    let green = math::floor(number / 256.0) % 256.0;
    let red = number % 256.0;
    [red, green, blue]
        .iter()
        .map(|channel| format!("{:0>2}", number_to_radix(*channel, 16.0).unwrap_or_default()))
        .collect::<String>()
        .to_uppercase()
}

fn shape_font_families(shape: &Value) -> Vec<String> {
    let names: Vec<String> = match field(shape, "fonts") {
        Some(Value::Array(fonts)) => fonts.iter().map(|name| text(Some(name))).collect(),
        _ => vec![text(field_of(field(shape, "font"), "name"))],
    };
    let mut families: Vec<String> = Vec::new();
    for name in names {
        let key = font_family_key(&name);
        if !key.is_empty() && !families.contains(&key) {
            families.push(key);
        }
    }
    families
}

fn shape_colors(shape: &Value) -> Vec<String> {
    if let Some(Value::Array(colors)) = field(shape, "colors") {
        return colors.iter().map(|color| value_to_string(color).to_uppercase()).collect();
    }
    [com_color_hex(field_of(field(shape, "font"), "color")), com_color_hex(field_of(field(shape, "fill"), "color"))].into_iter().filter(|color| !color.is_empty()).collect()
}

fn has_text(shape: &Value) -> bool {
    !trimmed(field(shape, "text")).is_empty()
}

fn shapes_of(slide: &Value) -> &[Value] {
    list(field(slide, "shapes"))
}

/// Fonts and colors are read straight from the saved shapes, so a deck that slipped past authoring (template edits,
/// add_textbox, COM sessions) still answers to the same discipline as an authored scene.
fn review_pptx_discipline(slides: &[Value], design: &Value, issues: &mut Vec<Value>) {
    let mut unsafe_fonts: Vec<String> = Vec::new();
    let mut deck_colors: Vec<String> = Vec::new();
    for slide in slides {
        let mut families: Vec<String> = Vec::new();
        for shape in shapes_of(slide) {
            if !has_text(shape) {
                continue;
            }
            for family in shape_font_families(shape) {
                if !families.contains(&family) {
                    families.push(family.clone());
                }
                if !is_safe_font_family(&family) && !unsafe_fonts.contains(&family) {
                    unsafe_fonts.push(family);
                }
            }
            // Chart series colours encode data categories; they do not count toward the accent hue families.
            if is_truthy(field(shape, "chart")) {
                continue;
            }
            for color in shape_colors(shape) {
                if !deck_colors.contains(&color) {
                    deck_colors.push(color);
                }
            }
        }
        if families.len() > MAX_FONT_FAMILIES_PER_SLIDE as usize {
            issues.push(design_issue(
                "font_family_overuse",
                &format!("/slide[{}]", template_text(field(slide, "index"))),
                &format!("Slide mixes {} font families ({}); keep display, body, and data only.", families.len(), families.join(", ")),
            ));
        }
    }
    let deck = field(design, "deck");
    let scratch = !is_truthy(deck) || field_of(deck, "templateMode").and_then(Value::as_str) == Some("scratch");
    if !unsafe_fonts.is_empty() && scratch && !is_truthy(field_of(field(design, "review"), "allowUnsafeFonts")) {
        issues.push(design_issue(
            "unsafe_font_family",
            "/",
            &format!(
                "Deck uses fonts outside the safe list: {}. The face is fine if it is installed, but recipients without it see a substitute in Word, PowerPoint, or Excel; embed or ship the font, or accept the substitution.",
                unsafe_fonts.join(", ")
            ),
        ));
    }
    let hue_families = saturated_hue_families(&deck_colors);
    if hue_families.len() > MAX_ACCENT_HUE_FAMILIES as usize {
        issues.push(design_issue(
            "accent_hue_overuse",
            "/",
            &format!("Deck spreads saturated color across {} hue families; keep one dominant accent and at most one secondary.", hue_families.len()),
        ));
    }
}

/// An auto shape is Office's MsoShapeType 1 or the OOXML element.
fn is_auto_shape(shape: &Value) -> bool {
    to_number_of(field(shape, "type")) == 1.0 || field(shape, "type").and_then(Value::as_str) == Some("p:sp")
}

fn normalized_shape_signature(slide: &Value) -> String {
    let rounded = |shape: &Value, key: &str| number_to_string(math::round(num0(field(shape, key)) / 24.0));
    let parts: Vec<String> = shapes_of(slide)
        .iter()
        .filter(|shape| has_text(shape))
        .map(|shape| {
            let kind = match field(shape, "type") {
                None | Some(Value::Null) => String::new(),
                Some(value) => value_to_string(value),
            };
            [kind, rounded(shape, "left"), rounded(shape, "top"), rounded(shape, "width"), rounded(shape, "height")].join(":")
        })
        .collect();
    utf16_sorted(parts).join("|")
}

/// One slide read on its own: the issues it earns, plus what it contributes to the deck-scale reading: whether it
/// carries native evidence, whether it is another card grid, and the composition signature a content page repeats.
struct SlideRead {
    issues: Vec<Value>,
    native_evidence: bool,
    card_grid: bool,
    signature: String,
}

fn review_pptx_slide(slide: &Value, slides: &[Value], design: &Value, plans: &[Value], size: Size) -> SlideRead {
    let mut issues = Vec::new();
    let index = field(slide, "index");
    let review = field(design, "review");
    let shapes: Vec<&Value> = shapes_of(slide).iter().filter(|shape| !is_motif_shape(shape)).collect();
    let text_shapes: Vec<&Value> = shapes.iter().copied().filter(|shape| has_text(shape)).collect();
    let pictures = shapes.iter().filter(|shape| is_picture_shape(shape)).count();
    let rich_visuals = shapes.iter().filter(|shape| is_truthy(field(shape, "chart")) || is_truthy(field(shape, "table")) || is_truthy(field(shape, "group"))).count();
    let non_text: Vec<&Value> = shapes.iter().copied().filter(|shape| !has_text(shape) && !is_truthy(field(shape, "placeholder"))).collect();
    // One statement, a band of hero numerals, or a drawn specimen (the subject itself set in three or more size/weight
    // steps down one column) is a typographic visual; an authored brief whose plan line names a statement, quote, hero,
    // or specimen carrier says so directly.
    let planned_carriers = list(field_of(field(design, "brief"), "plan"))
        .iter()
        .find(|entry| to_number_of(field(entry, "slide")) == to_number_of(index))
        .map_or(&[][..], |entry| list(field(entry, "carriers")));
    let typographic_visual = is_pptx_statement_slide(slide)
        || text_shapes.iter().filter(|shape| num0(field_of(field(shape, "font"), "size")) >= 40.0).count() >= 3
        || is_pptx_specimen_slide(&text_shapes)
        || planned_carriers.iter().any(|carrier| carrier.as_str().is_some_and(|name| ["statement", "quote", "hero", "specimen"].contains(&name)));
    let semantic_visual = text(field_of(plan_for(plans, to_number_of(index)), "visualType"));
    let inferred_diagram = (2..=8).contains(&non_text.len()) && text_shapes.len() >= 4;
    let purposeful_diagram =
        (["comparison", "diagram", "matrix", "process", "table"].contains(&semantic_visual.as_str()) && !non_text.is_empty()) || inferred_diagram;
    let native_evidence = pictures > 0 || shapes.iter().any(|shape| is_truthy(field(shape, "chart")) || is_truthy(field(shape, "table"))) || purposeful_diagram;
    // The opening slide is a cover and never owes a chart or table. Treating a short deck as all-content flagged its own
    // cover for missing evidence, a demand no author can satisfy without wrecking the cover.
    let one = Value::from(1);
    let content_slide = !strict_equals(index, Some(&one)) && !(slides.len() >= 3 && strict_equals(index, Some(&Value::from(slides.len()))));
    if content_slide
        && !text_shapes.is_empty()
        && pictures == 0
        && rich_visuals == 0
        && non_text.len() < 2
        && !typographic_visual
        && !purposeful_diagram
        && !is_truthy(field_of(review, "allowTextOnly"))
    {
        issues.push(design_issue(
            "meaningful_visual_missing",
            &format!("/slide[{}]", template_text(index)),
            "Content slide has no image, chart, table, group, or purposeful diagram.",
        ));
    }
    let text_length: usize = text_shapes.iter().map(|shape| utf16_len(&text(field(shape, "text")))).sum();
    if text_length > 650 {
        issues.push(design_issue(
            "excessive_slide_text",
            &format!("/slide[{}]", template_text(index)),
            &format!("Slide contains {text_length} characters; split or visualize the content."),
        ));
    }
    let ornamental = non_text.iter().any(|shape| is_ornamental_stripe(shape, &shapes, size));
    if ornamental && !is_truthy(field_of(review, "allowDecorativeLines")) {
        issues.push(design_issue(
            "decorative_stripe",
            &format!("/slide[{}]", template_text(index)),
            "Thin decorative stripe or rule resembles generic AI slide ornamentation.",
        ));
    }
    let auto_text: Vec<&Value> = text_shapes.iter().filter(|shape| is_auto_shape(shape)).copied().collect();
    let auto_all: Vec<&Value> = shapes.iter().filter(|shape| is_auto_shape(shape)).copied().collect();
    SlideRead {
        issues,
        native_evidence,
        card_grid: is_card_grid_slide(&auto_text, &auto_all),
        signature: if content_slide { normalized_shape_signature(slide) } else { String::new() },
    }
}

/// What only the whole deck can say: the same composition page after page, card grids past the authoring rule, and too
/// little native evidence for its length.
fn review_pptx_deck_scale(slides: usize, design: &Value, signatures: &[(String, usize)], card_grid_slides: usize, native_evidence_slides: usize) -> Vec<Value> {
    let mut issues = Vec::new();
    let review = field(design, "review");
    let content_count = if slides >= 3 { slides - 2 } else { slides.saturating_sub(1) };
    let repeated = signatures.iter().map(|(_, count)| *count).max().unwrap_or(0);
    let allow_repetition = is_truthy(field_of(review, "allowRepetition"));
    if content_count >= 4 && repeated as f64 / content_count as f64 >= 0.75 && !allow_repetition {
        issues.push(design_issue("repetitive_composition", "/", &format!("{repeated} of {content_count} content slides repeat the same composition.")));
    }
    // Matches the authoring rule: the same skeleton may appear twice per deck.
    if card_grid_slides >= 3 && !allow_repetition {
        issues.push(design_issue("card_grid_overuse", "/", &format!("{card_grid_slides} slides use repeated same-size text cards; vary the visual structure.")));
    }
    let required_native_evidence = usize::max(1, content_count.div_ceil(3));
    if slides >= 5 && native_evidence_slides < required_native_evidence && !is_truthy(field_of(review, "allowSyntheticVisuals")) {
        issues.push(design_issue(
            "native_evidence_too_weak",
            "/",
            &format!("Deck uses native image, chart, or table evidence on {native_evidence_slides} slide(s); at least {required_native_evidence} are required."),
        ));
    }
    issues
}

fn review_pptx(reads: &dyn AuthorReads, document: &Value, design: &Value) -> Vec<Value> {
    let mut issues = Vec::new();
    let slides = list(field(document, "slides"));
    let plans = list(field(design, "slidePlans"));
    let size = slide_size(document);
    review_pptx_theme(document, design, &mut issues);
    review_pptx_discipline(slides, design, &mut issues);
    // An authored deck is held to its own brief: the skeleton each plan line promised, and the fact sheet behind every
    // figure it shows.
    if let Some(brief) = field(design, "brief").filter(|brief| truthy(brief)) {
        issues.extend(reads.review_brief_promises(document, brief));
        issues.extend(reads.review_fact_coverage(document, brief));
        issues.extend(reads.review_source_grounding(brief));
    }
    let mut card_grid_slides = 0;
    let mut signatures: Vec<(String, usize)> = Vec::new();
    let mut native_evidence_slides = 0;
    for slide in slides {
        let read = review_pptx_slide(slide, slides, design, plans, size);
        issues.extend(read.issues);
        if read.native_evidence {
            native_evidence_slides += 1;
        }
        if read.card_grid {
            card_grid_slides += 1;
        }
        if !read.signature.is_empty() {
            match signatures.iter_mut().find(|(known, _)| *known == read.signature) {
                Some((_, count)) => *count += 1,
                None => signatures.push((read.signature, 1)),
            }
        }
    }
    issues.extend(review_pptx_deck_scale(slides.len(), design, &signatures, card_grid_slides, native_evidence_slides));
    issues.extend(review_pptx_deck_diversity(reads, document, design));
    issues
}

const MODEL_REVIEW: [&str; 6] = [
    "Inspect every rendered page, not only lint counts.",
    "Verify the reading order suits this document and preserves the source claims and qualifications.",
    "Trace material numbers from source through calculation to the displayed claim; reject decorative or unsupported data.",
    "Judge hierarchy, spacing, palette, and repetition by the reader and purpose, not a prescribed visual style.",
    "Confirm the design is specific to the subject, audience, and intended action.",
    "Refine the current composition before adding decoration.",
];

/// `reviewOfficeDesign({ format, document, design, library, auditProfile })`: the design review of a document. A native
/// Word, Excel or PDF request is wrapped structure diagnostics only; otherwise the design the request resolves to is
/// held against the saved document and the composition sequence. The error is the text Node throws for a design that
/// does not resolve.
pub fn review_office_design(
    reads: &dyn AuthorReads,
    format: &str,
    document: &Value,
    request: Option<&Value>,
    library: Option<&Value>,
    audit_profile: &str,
) -> Result<Value, String> {
    let normalized_format = js_to_lowercase(format);
    let empty = Value::Object(Map::new());
    let request = request.unwrap_or(&empty);
    if uses_native_office_design(&normalized_format, request, &[]) {
        let issues = review_office_structure(Some(&normalized_format), document, audit_profile);
        return Ok(review_native_document_design(&normalized_format, issues));
    }
    let design = resolve_office_design(&normalized_format, request, library)?;
    let review = field(&design, "review");
    let composition_review = review_office_composition_sequence(
        &normalized_format,
        field(&design, "compositions"),
        field(&design, "recentCompositions"),
        is_truthy(field_of(review, "allowRepetition")),
    );
    let profile = field(&design, "profile").cloned();
    let with_profile = |map: &mut Map<String, Value>| {
        if let Some(profile) = &profile {
            map.insert("profile".into(), profile.clone());
        }
    };
    if !is_truthy(field_of(review, "required")) {
        let mut skipped = Map::new();
        skipped.insert("ok".into(), json!(true));
        skipped.insert("status".into(), json!("skipped"));
        with_profile(&mut skipped);
        skipped.insert("issues".into(), json!([]));
        skipped.insert("composition".into(), field(&composition_review, "summary").cloned().unwrap_or(Value::Null));
        skipped.insert("requiresVisualInspection".into(), json!(false));
        return Ok(Value::Object(skipped));
    }
    let structure_issues = review_office_structure(Some(&normalized_format), document, audit_profile);
    let mut issues: Vec<Value> = if normalized_format == "pptx" {
        let mut read = review_pptx(reads, document, &design);
        read.extend(structure_issues);
        read
    } else {
        structure_issues
    };
    let repeated = field(&composition_review, "repeated").filter(|repeated| truthy(repeated));
    if let Some(repeated) = repeated
        && !issues.iter().any(|entry| field(entry, "code").and_then(Value::as_str) == Some("repetitive_composition"))
    {
        issues.push(design_issue(
            "repetitive_composition",
            "/",
            &format!(
                "{} of {} semantic compositions reuse {}.",
                template_text(field(repeated, "count")),
                template_text(field(repeated, "total")),
                template_text(field(repeated, "id"))
            ),
        ));
    }
    if field(&composition_review, "recentMatch").is_some_and(|recent| is_truthy(Some(recent))) {
        issues.push(design_issue(
            "recent_composition_repeat",
            "/",
            "The complete composition sequence matches a recent deliverable; recompose the structure while preserving brand constraints.",
        ));
    }
    // Advisory readings (layout taste, plan read-back) are reported, never graded: the review passes when nothing
    // measurable is wrong.
    let actionable = issues.iter().filter(|entry| !is_advisory_office_issue(entry)).count();
    let mut out = Map::new();
    out.insert("ok".into(), json!(actionable == 0));
    out.insert("status".into(), json!(if actionable > 0 { "needs-polish" } else { "pass" }));
    with_profile(&mut out);
    out.insert("issues".into(), Value::Array(issues));
    out.insert("composition".into(), field(&composition_review, "summary").cloned().unwrap_or(Value::Null));
    out.insert("requiresVisualInspection".into(), json!(!["csv", "tsv"].contains(&normalized_format.as_str())));
    out.insert("modelReview".into(), json!(MODEL_REVIEW));
    Ok(Value::Object(out))
}
