//! `design-review-authored.mjs`: rules that must hold for authored (script) decks as well as composed ones. A composed
//! deck carries slide plans and the design tokens it was drawn with; an authored deck carries neither, so these helpers
//! read the deck's own ladder and geometry instead of the composer's plan.

use mixdog_js::math;
use mixdog_office_design::discipline::relative_luminance;
use serde_json::Value;

use super::slide_roles::{DEFAULT_SLIDE, Size};
use crate::structure::{text, trimmed};
use crate::{field, field_of, is_truthy};

/// pt from the slide edge that reads as page chrome.
const EDGE_ZONE: f64 = 60.0;
/// pt below a title that reads as an accent rule.
const UNDER_TITLE_GAP: f64 = 40.0;
/// pt between a vertical rule and the text hanging from it.
const HANGING_GUTTER: f64 = 40.0;
const TITLE_SIZE: f64 = 24.0;
/// pt; same top or left means the same grid line.
const ROW_TOLERANCE: f64 = 6.0;
/// pt; anything shorter is a label, not a card.
const CARD_MIN_HEIGHT: f64 = 60.0;
/// chars; cards carry copy, nodes carry names.
const CARD_MIN_TEXT: usize = 20;
/// A running head or foot: the page's own small chrome text.
const CHROME_TEXT_SIZE: f64 = 14.0;
const CHROME_GAP: f64 = 16.0;

/// `num(value)`: the number, or 0 when it is not a finite one.
fn num(value: Option<&Value>) -> f64 {
    let parsed = mixdog_js::to_number_of(value);
    if parsed.is_finite() { parsed } else { 0.0 }
}

fn has_text(shape: &Value) -> bool {
    !trimmed(field(shape, "text")).is_empty()
}

/// `slideSize(document)`: the deck's slide size in points, the wide layout when it saved none.
pub fn slide_size(document: &Value) -> Size {
    let width = num(field(document, "slideWidth"));
    let height = num(field(document, "slideHeight"));
    Size { width: if width == 0.0 { DEFAULT_SLIDE.width } else { width }, height: if height == 0.0 { DEFAULT_SLIDE.height } else { height } }
}

/// The deck's own two backgrounds: the field the cover or closing takes, and the canvas of the body pages.
#[derive(Clone, Debug, PartialEq)]
pub struct BackgroundLadder {
    pub inverse: String,
    pub canvas: String,
}

/// Perceived lightness of a background hex, 0-1; an unreadable value sorts last.
fn background_lightness(color: &str) -> f64 {
    relative_luminance(color).unwrap_or(0.0)
}

/// `authoredBackgroundLadder(backgrounds, tokenColors)`: the most common background is the canvas and the color
/// farthest from it in lightness is the inverse field. `None` when the deck shares any background with the design
/// tokens: the composer's plan applies instead.
pub fn authored_background_ladder(backgrounds: &[String], token_colors: Option<&Value>) -> Option<BackgroundLadder> {
    let tokens: Vec<String> = token_colors
        .and_then(Value::as_object)
        .map(|colors| colors.values().map(|color| text(Some(color)).to_uppercase()).filter(|color| !color.is_empty()).collect())
        .unwrap_or_default();
    if backgrounds.iter().any(|color| tokens.contains(color)) {
        return None;
    }
    let mut counts: Vec<(&String, usize)> = Vec::new();
    for color in backgrounds {
        match counts.iter_mut().find(|(known, _)| *known == color) {
            Some((_, count)) => *count += 1,
            None => counts.push((color, 1)),
        }
    }
    let mut by_count = counts.clone();
    by_count.sort_by(|left, right| right.1.cmp(&left.1));
    let canvas = by_count.first().map(|(color, _)| (*color).clone()).or_else(|| backgrounds.first().cloned())?;
    let distance = |color: &str| math::abs(background_lightness(color) - background_lightness(&canvas));
    let mut others: Vec<&String> = counts.iter().map(|(color, _)| *color).filter(|color| **color != canvas).collect();
    others.sort_by(|left, right| distance(right).total_cmp(&distance(left)));
    let inverse = others.first().map_or_else(|| canvas.clone(), |color| (*color).clone());
    Some(BackgroundLadder { inverse, canvas })
}

/// A running head or foot: a hairline in the page's edge band that the page's own small chrome text (the deck name, the
/// section, the page number) sits against: a document's header rule, which divides the chrome from the body. A bar at the
/// edge with no chrome beside it stays ornament.
fn is_running_rule(shape: &Value, shapes: &[&Value]) -> bool {
    let height = num(field(shape, "height"));
    if height > 2.0 {
        return false;
    }
    let top = num(field(shape, "top"));
    let left = num(field(shape, "left"));
    let right = left + num(field(shape, "width"));
    shapes.iter().any(|other| {
        if std::ptr::eq(*other, shape) || !has_text(other) {
            return false;
        }
        let size = num(field_of(field(other, "font"), "size"));
        if size == 0.0 || size > CHROME_TEXT_SIZE {
            return false;
        }
        if num(field(other, "left")) + num(field(other, "width")) <= left || num(field(other, "left")) >= right {
            return false;
        }
        let above = top - (num(field(other, "top")) + num(field(other, "height")));
        let below = num(field(other, "top")) - (top + height);
        (above >= -2.0 && above <= CHROME_GAP) || (below >= -2.0 && below <= CHROME_GAP)
    })
}

/// `isOrnamentalStripe(shape, shapes, size)`: a thin rule is ornamentation when it hugs a slide edge or underlines a
/// title; a hairline separating two rows of content is a separator, not a stripe. `shape` is one of `shapes`.
pub fn is_ornamental_stripe(shape: &Value, shapes: &[&Value], size: Size) -> bool {
    let width = num(field(shape, "width"));
    let height = num(field(shape, "height"));
    let left = num(field(shape, "left"));
    let top = num(field(shape, "top"));
    let vertical = width <= 14.0 && height >= 180.0;
    let horizontal = height <= 7.0 && width >= 320.0;
    if !vertical && !horizontal {
        return false;
    }
    if vertical {
        // A vertical rule that text hangs from (editorial carrier) is scoped to its block: at most half the page tall,
        // with text starting within a small gutter and overlapping it. A page-height edge stripe is ornament.
        let hanging = height <= size.height * 0.5
            && shapes.iter().any(|other| {
                if std::ptr::eq(*other, shape) || !has_text(other) {
                    return false;
                }
                let gutter = num(field(other, "left")) - (left + width);
                let overlap = math::min(top + height, num(field(other, "top")) + num(field(other, "height"))) - math::max(top, num(field(other, "top")));
                (0.0..=HANGING_GUTTER).contains(&gutter) && overlap > 0.0
            });
        if hanging {
            return false;
        }
        return left < EDGE_ZONE || left + width > size.width - EDGE_ZONE;
    }
    if top < EDGE_ZONE || top + height > size.height - EDGE_ZONE {
        return !is_running_rule(shape, shapes);
    }
    if width >= size.width * 0.95 {
        return true;
    }
    // An underline shares the title's columns; a level line in a diagram beside a hero numeral does not.
    shapes.iter().any(|other| {
        if std::ptr::eq(*other, shape) || !has_text(other) {
            return false;
        }
        if num(field_of(field(other, "font"), "size")) < TITLE_SIZE {
            return false;
        }
        if num(field(other, "left")) >= left + width || num(field(other, "left")) + num(field(other, "width")) <= left {
            return false;
        }
        let bottom = num(field(other, "top")) + num(field(other, "height"));
        top >= bottom - 4.0 && top <= bottom + UNDER_TITLE_GAP
    })
}

fn contains(surface: &Value, shape: &Value) -> bool {
    num(field(shape, "left")) >= num(field(surface, "left")) - 2.0
        && num(field(shape, "top")) >= num(field(surface, "top")) - 2.0
        && num(field(shape, "left")) + num(field(shape, "width")) <= num(field(surface, "left")) + num(field(surface, "width")) + 2.0
        && num(field(shape, "top")) + num(field(shape, "height")) <= num(field(surface, "top")) + num(field(surface, "height")) + 2.0
}

fn has_copy(shape: &Value) -> bool {
    mixdog_js::utf16_len(&trimmed(field(shape, "text"))) >= CARD_MIN_TEXT
}

/// `isCardGridSlide(textShapes, allShapes)`: a card grid is three or more same-size filled surfaces on one grid line,
/// each carrying copy (its own or a text box inside it). Nodes, hero numbers, stage labels, staggered blocks, and
/// unfilled text columns share a size without being cards. Snapshots without fill data fall back to text blocks.
pub fn is_card_grid_slide(text_shapes: &[&Value], all_shapes: &[&Value]) -> bool {
    let fill_known = all_shapes.iter().any(|shape| is_truthy(field(shape, "fill")));
    let cards: Vec<&Value> = if fill_known {
        all_shapes
            .iter()
            .copied()
            .filter(|surface| {
                is_truthy(field(surface, "fill"))
                    && num(field(surface, "height")) >= CARD_MIN_HEIGHT
                    && (has_copy(surface) || text_shapes.iter().any(|shape| !std::ptr::eq(*shape, *surface) && has_copy(shape) && contains(surface, shape)))
            })
            .collect()
    } else {
        text_shapes.iter().copied().filter(|shape| num(field(shape, "height")) >= CARD_MIN_HEIGHT && has_copy(shape)).collect()
    };
    let mut groups: Vec<((f64, f64), Vec<&Value>)> = Vec::new();
    for shape in cards {
        let key = (math::round(num(field(shape, "width")) / 12.0), math::round(num(field(shape, "height")) / 12.0));
        match groups.iter_mut().find(|(known, _)| *known == key) {
            Some((_, members)) => members.push(shape),
            None => groups.push((key, vec![shape])),
        }
    }
    for (_, members) in &groups {
        if members.len() < 3 {
            continue;
        }
        let aligned = |axis: &str| {
            let mut lines: Vec<(f64, usize)> = Vec::new();
            for shape in members {
                let value = math::round(num(field(shape, axis)) / ROW_TOLERANCE);
                match lines.iter_mut().find(|(known, _)| *known == value) {
                    Some((_, count)) => *count += 1,
                    None => lines.push((value, 1)),
                }
            }
            lines.iter().map(|(_, count)| *count).max().unwrap_or(0) >= 3
        };
        if aligned("top") || aligned("left") {
            return true;
        }
    }
    false
}

/// The label of a ladder role as the review prints it (`inverse`, `canvas`).
pub fn ladder_color<'a>(ladder: &'a BackgroundLadder, role: &str) -> &'a str {
    match role {
        "inverse" => &ladder.inverse,
        "canvas" => &ladder.canvas,
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(left: f64, top: f64, width: f64, height: f64) -> Value {
        json!({ "left": left, "top": top, "width": width, "height": height })
    }

    #[test]
    fn a_deck_that_drew_its_own_palette_has_its_own_ladder_and_a_shared_one_defers_to_the_plan() {
        let backgrounds: Vec<String> = ["F4EFE6", "F4EFE6", "1B2A41", "F4EFE6"].iter().map(|color| (*color).to_owned()).collect();
        let ladder = authored_background_ladder(&backgrounds, Some(&json!({ "canvas": "FFFFFF" }))).expect("a ladder");
        assert_eq!(ladder, BackgroundLadder { inverse: "1B2A41".into(), canvas: "F4EFE6".into() });
        assert!(authored_background_ladder(&backgrounds, Some(&json!({ "canvas": "f4efe6" }))).is_none());
    }

    #[test]
    fn an_edge_stripe_is_ornament_and_a_running_rule_with_chrome_beside_it_is_not() {
        let size = DEFAULT_SLIDE;
        let edge = rule(0.0, 100.0, 10.0, 540.0);
        assert!(is_ornamental_stripe(&edge, &[&edge], size));
        let hairline = rule(40.0, 30.0, 880.0, 1.0);
        let chrome = json!({ "text": "Deck name", "font": { "size": 10 }, "left": 40, "top": 14, "width": 200, "height": 12 });
        assert!(is_ornamental_stripe(&hairline, &[&hairline], size));
        assert!(!is_ornamental_stripe(&hairline, &[&hairline, &chrome], size));
    }

    #[test]
    fn three_filled_cards_on_one_line_are_a_card_grid_and_two_are_not() {
        let card = |left: f64| json!({ "text": "A card carrying its own copy here", "fill": { "color": "EEEEEE" }, "left": left, "top": 100, "width": 200, "height": 120 });
        let cards = [card(40.0), card(280.0), card(520.0)];
        let refs: Vec<&Value> = cards.iter().collect();
        assert!(is_card_grid_slide(&refs, &refs));
        assert!(!is_card_grid_slide(&refs[..2], &refs[..2]));
    }
}
