//! Which face sets which character: Skia's family match and its CSS style matching, then one face per character.
//!
//! What `@napi-rs/canvas` does with a `ctx.font`, as measured against it:
//!
//! * each family of the list is looked up by its exact registered name; a name that is not registered (a generic such
//!   as `serif` included) is skipped;
//! * within a family the face is chosen by CSS style matching (width, then slant, then weight);
//! * when no family of the list is registered, the family of the first registered face stands in;
//! * a character is set in the first matched face whose cmap has it; the system is not asked for a face that has it,
//!   so a character no face has is the `.notdef` glyph of the first matched face.

use mixdog_fsio::ReadProof;

use crate::css_font::ParsedFont;
use crate::face::FontStyle;
use crate::face::Slant;
use crate::registry::FaceId;
use crate::registry::Registry;

/// The index in `styles` of the face Skia's CSS style matching picks for `pattern`; the first of equal scores wins.
pub fn match_style(styles: &[FontStyle], pattern: FontStyle) -> Option<usize> {
    const SLANT_SCORE: [[i32; 3]; 3] = [[3, 1, 2], [1, 3, 2], [1, 2, 3]];
    let slant_index = |slant: Slant| match slant {
        Slant::Upright => 0,
        Slant::Italic => 1,
        Slant::Oblique => 2,
    };
    let weight = i32::from(pattern.weight);
    let width = i32::from(pattern.width);
    let mut best: Option<((i32, i32, i32), usize)> = None;
    for (index, current) in styles.iter().enumerate() {
        let current_width = i32::from(current.width);
        let width_score = if width <= 5 {
            if current_width <= width { 10 - width + current_width } else { 10 - current_width }
        } else if current_width > width {
            10 + width - current_width
        } else {
            current_width
        };
        let slant_score = SLANT_SCORE[slant_index(pattern.slant)][slant_index(current.slant)];
        let current_weight = i32::from(current.weight);
        let weight_score = if weight == current_weight {
            1000
        } else if weight <= 500 {
            let preferred = if (400..450).contains(&weight) && (450..=500).contains(&current_weight) { 500 } else { 0 };
            preferred + if current_weight <= weight { 1000 - weight + current_weight } else { 1000 - current_weight }
        } else if current_weight > weight {
            1000 + weight - current_weight
        } else {
            current_weight
        };
        let score = (width_score, slant_score, weight_score);
        if best.is_none_or(|(top, _)| top < score) {
            best = Some((score, index));
        }
    }
    best.map(|(_, index)| index)
}

/// The matched faces of a font in family-list order, and whether the default family stood in.
pub fn chain_ids(registry: &Registry, font: &ParsedFont) -> (Vec<FaceId>, bool) {
    let pattern = font.style();
    let pick = |ids: &[FaceId]| {
        let styles: Vec<FontStyle> = ids.iter().map(|id| registry.face(*id).style).collect();
        match_style(&styles, pattern).map(|index| ids[index])
    };
    let mut faces: Vec<FaceId> = Vec::new();
    for name in &font.families {
        if let Some(id) = registry.family(name).and_then(pick) {
            if !faces.contains(&id) {
                faces.push(id);
            }
        }
    }
    if !faces.is_empty() {
        return (faces, false);
    }
    (registry.default_family().and_then(pick).into_iter().collect(), true)
}

/// The faces a font resolves to, parsed once for glyph lookups.
pub struct Chain<'r> {
    registry: &'r Registry,
    ids: Vec<FaceId>,
    default: bool,
    parsed: Vec<Option<ttf_parser::Face<'r>>>,
}

impl<'r> Chain<'r> {
    /// The chain of `font`; the files of its faces are read when they were not yet (a face whose file cannot be read
    /// sets nothing).
    pub fn new<P: ReadProof>(proof: &P, registry: &'r Registry, font: &ParsedFont) -> Self {
        let (ids, default) = chain_ids(registry, font);
        let parsed = ids
            .iter()
            .map(|id| {
                let face = registry.face(*id);
                face.ensure_loaded(proof).ok().and_then(|_| face.parsed())
            })
            .collect();
        Self { registry, ids, default, parsed }
    }

    /// True when no face is registered at all.
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    /// True when no family of the list was registered and the default family stands in.
    pub fn is_default(&self) -> bool {
        self.default
    }

    /// The matched faces in family-list order.
    pub fn ids(&self) -> &[FaceId] {
        &self.ids
    }

    pub fn registry(&self) -> &'r Registry {
        self.registry
    }

    /// The position in [`Chain::ids`] of the face that sets `character`: the first whose cmap has it, else the first.
    pub fn slot_for(&self, character: char) -> usize {
        self.parsed
            .iter()
            .position(|face| face.as_ref().is_some_and(|face| face.glyph_index(character).is_some()))
            .unwrap_or(0)
    }

    /// The face with this position in the chain, parsed.
    pub fn parsed(&self, slot: usize) -> Option<&ttf_parser::Face<'r>> {
        self.parsed.get(slot).and_then(Option::as_ref)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::face::Face;
    use std::sync::Arc;

    fn style(weight: u16, slant: Slant) -> FontStyle {
        FontStyle { weight, width: 5, slant }
    }

    fn pick(styles: &[FontStyle], weight: u16, slant: Slant) -> Option<usize> {
        match_style(styles, style(weight, slant))
    }

    /// The styles of Arial as `GlobalFonts.families` lists them.
    fn arial() -> Vec<FontStyle> {
        let narrow = |weight, slant| FontStyle { weight, width: 3, slant };
        vec![
            style(400, Slant::Upright),
            style(700, Slant::Upright),
            style(700, Slant::Italic),
            style(400, Slant::Italic),
            narrow(400, Slant::Upright),
            narrow(700, Slant::Upright),
            narrow(700, Slant::Italic),
            narrow(400, Slant::Italic),
            style(900, Slant::Upright),
        ]
    }

    #[test]
    fn weights_resolve_as_canvas_measured_them() {
        let arial = arial();
        for (weight, expected) in [(400, 0), (500, 0), (300, 0), (100, 0), (600, 1), (700, 1), (800, 8), (900, 8)] {
            assert_eq!(pick(&arial, weight, Slant::Upright), Some(expected), "weight {weight}");
        }
        assert_eq!(pick(&arial, 400, Slant::Italic), Some(3));
        assert_eq!(pick(&arial, 700, Slant::Italic), Some(2));
    }

    #[test]
    fn a_family_without_the_weight_matches_the_nearest_in_css_order() {
        let calibri = [style(400, Slant::Upright), style(700, Slant::Upright), style(300, Slant::Upright)];
        assert_eq!(pick(&calibri, 100, Slant::Upright), Some(2));
        assert_eq!(pick(&calibri, 350, Slant::Upright), Some(2));
        assert_eq!(pick(&calibri, 450, Slant::Upright), Some(0));
        let variable = [style(100, Slant::Upright), style(800, Slant::Upright), style(100, Slant::Upright)];
        assert_eq!(pick(&variable, 400, Slant::Upright), Some(0));
        assert_eq!(pick(&variable, 700, Slant::Upright), Some(1));
        assert_eq!(pick(&[], 400, Slant::Upright), None);
    }

    #[test]
    fn equal_scores_keep_the_first_registered() {
        let twins = [style(400, Slant::Upright), style(400, Slant::Upright)];
        assert_eq!(pick(&twins, 400, Slant::Upright), Some(0));
    }

    #[test]
    fn the_slant_comes_before_the_weight() {
        let styles = [style(700, Slant::Upright), style(400, Slant::Italic)];
        assert_eq!(pick(&styles, 700, Slant::Italic), Some(1));
        assert_eq!(pick(&styles, 400, Slant::Oblique), Some(1));
    }

    fn registry() -> Registry {
        let mut registry = Registry::new();
        for (family, weight) in [("Agency FB", 400), ("Arial", 400), ("Arial", 700), ("Malgun Gothic", 400)] {
            let mut face = Face::stub(family);
            face.style = style(weight, Slant::Upright);
            registry.register(Arc::new(face), None, None);
        }
        registry
    }

    fn font(text: &str) -> ParsedFont {
        crate::css_font::parse(text).expect("a font")
    }

    #[test]
    fn the_chain_lists_the_matched_families_in_order_and_skips_the_unregistered() {
        let registry = registry();
        assert_eq!(chain_ids(&registry, &font("bold 16px Arial, \"Malgun Gothic\"")), (vec![2, 3], false));
        assert_eq!(chain_ids(&registry, &font("16px nonexistent, Arial")), (vec![1], false));
        assert_eq!(chain_ids(&registry, &font("16px \"Malgun Gothic\", Arial")), (vec![3, 1], false));
        assert_eq!(chain_ids(&registry, &font("16px Arial, Arial")), (vec![1], false));
    }

    #[test]
    fn a_list_with_no_registered_family_is_set_in_the_first_registered_family() {
        let registry = registry();
        for text in ["16px nonexistent", "16px serif", "16px ARIAL", "16px"] {
            assert_eq!(chain_ids(&registry, &font(text)), (vec![0], true), "{text}");
        }
        assert_eq!(chain_ids(&Registry::new(), &font("16px Arial")), (Vec::new(), true));
    }
}
