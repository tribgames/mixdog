//! Registering font files: a registered face keeps the bytes it was verified with, a collection registers every member
//! or none, and a directory scan lists members without loading their bytes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use mixdog_fonts::Face;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!("mixdog-font-features-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        mixdog_fsio::create_dir(&Unlaned, &path).expect("unique directory");
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = mixdog_fsio::remove_file(&Unlaned, self.0.join("snapshot.ttc"));
        let _ = mixdog_fsio::remove_file(&Unlaned, self.0.join("snapshot.ttf"));
        let _ = mixdog_fsio::remove_dir(&Unlaned, &self.0);
    }
}

/// The regular (400) or bold (700) face the repository carries.
fn face_bytes(bold: bool) -> Vec<u8> {
    let name = if bold { "LiberationSans-Bold.ttf" } else { "LiberationSans-Regular.ttf" };
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts").join(name);
    mixdog_fsio::read(&Unlaned, path).unwrap()
}

/// The two faces wrapped in a TrueType collection; table offsets become absolute.
fn collection() -> Vec<u8> {
    let fonts = [face_bytes(false), face_bytes(true)];
    let mut bytes = b"ttcf\0\x01\0\0\0\0\0\x02".to_vec();
    bytes.resize(20, 0);
    for (index, mut font) in fonts.into_iter().enumerate() {
        while !bytes.len().is_multiple_of(4) {
            bytes.push(0);
        }
        let base = u32::try_from(bytes.len()).unwrap();
        bytes[12 + index * 4..16 + index * 4].copy_from_slice(&base.to_be_bytes());
        let tables = usize::from(u16::from_be_bytes(font[4..6].try_into().unwrap()));
        for table in 0..tables {
            let at = 12 + table * 16 + 8;
            let offset = u32::from_be_bytes(font[at..at + 4].try_into().unwrap());
            font[at..at + 4].copy_from_slice(&(offset + base).to_be_bytes());
        }
        bytes.extend(font);
    }
    bytes
}

#[test]
fn a_registered_face_keeps_its_verified_bytes_when_the_file_is_replaced_or_removed() {
    let scratch = Scratch::new();
    let path = scratch.0.join("snapshot.ttf");
    let bytes = face_bytes(false);
    mixdog_fsio::write(&Unlaned, &path, &bytes).unwrap();
    let direct = Face::described(&path, &bytes).unwrap();
    let mut registry = Registry::new();
    let id = registry.register_described(&path, &bytes, Some("Pinned")).unwrap();
    let before = registry.face(id).parsed().unwrap().glyph_index('A');
    mixdog_fsio::write(&Unlaned, &path, face_bytes(true)).unwrap();
    assert_eq!(registry.register_file(&Unlaned, &path, Some("Pinned")).unwrap(), id);
    mixdog_fsio::remove_file(&Unlaned, &path).unwrap();
    assert_eq!(direct.ensure_loaded(&Unlaned).unwrap().as_ref(), bytes.as_slice());
    assert_eq!(registry.face(id).ensure_loaded(&Unlaned).unwrap().as_ref(), bytes.as_slice());
    assert_eq!(registry.face(id).parsed().unwrap().glyph_index('A'), before);
    assert_eq!(registry.face(id).style.weight, 400);
    assert_eq!(registry.len(), 1);
}

#[test]
fn a_directory_scan_lists_every_collection_member_once_and_loads_no_bytes() {
    let scratch = Scratch::new();
    let path = scratch.0.join("snapshot.ttc");
    let bytes = collection();
    mixdog_fsio::write(&Unlaned, &path, &bytes).unwrap();
    let mut registry = Registry::new();
    assert_eq!(registry.register_dir(&Unlaned, &scratch.0), 2);
    assert_eq!(registry.register_dir(&Unlaned, &scratch.0), 0);
    assert_eq!(registry.len(), 2);
    assert_eq!((registry.face(0).index(), registry.face(1).index()), (0, 1));
    assert_eq!((registry.face(0).style.weight, registry.face(1).style.weight), (400, 700));
    for id in 0..2 {
        assert_eq!(registry.face(id).path(), Some(path.as_path()));
        assert!(registry.face(id).bytes().is_none(), "a scan keeps no font bytes");
    }
    assert_eq!(registry.face(1).ensure_loaded(&Unlaned).unwrap().as_ref(), bytes.as_slice());
    assert!(registry.face(1).parsed().unwrap().glyph_index('A').is_some());
    assert!(registry.face(0).bytes().is_none(), "using one face does not load its neighbours' files");
    let mut aliased = Registry::new();
    assert_eq!(aliased.register_bytes(&path, bytes, Some("Collection")).unwrap(), vec![0, 1]);
    assert_eq!(aliased.family("Collection"), Some(&[0, 1][..]));
}

#[test]
fn a_collection_with_a_broken_later_member_registers_nothing() {
    let mut bytes = collection();
    bytes[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
    let mut registry = Registry::new();
    assert!(registry.register_bytes(Path::new("not-read.ttc"), bytes, None).is_err());
    assert!(registry.is_empty());
}

// ---- measuring and fitting text

use mixdog_fonts::autohint;
use mixdog_fonts::measure::{MeasureOptions, faces_of, measure_parsed, measure_text};

fn liberation(registry: &mut Registry, name: &str, family: &str) -> usize {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts").join(name);
    let bytes = mixdog_fsio::read(&Unlaned, &path).unwrap();
    registry.register_described(&path, &bytes, Some(family)).unwrap()
}

/// A width is rounded to a hundredth in single precision.
fn assert_close(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-4, "{actual} vs {expected}");
}

fn regular_only() -> Registry {
    let mut registry = Registry::new();
    liberation(&mut registry, "LiberationSans-Regular.ttf", "Lib");
    registry
}

#[test]
fn a_width_is_the_scaled_advances_summed_and_the_longest_line_wins() {
    let registry = regular_only();
    // H is 1479 units of a 2048 em: 11.5546875 px at 16 px, shown to a hundredth.
    let one = measure_text(&Unlaned, &registry, "16px Lib", "H").unwrap();
    assert_close(one.width, 11.55);
    assert_close(measure_text(&Unlaned, &registry, "16px Lib", "HH").unwrap().width, 23.11);
    assert_close(measure_text(&Unlaned, &registry, "32px Lib", "H").unwrap().width, 23.11);
    assert_close(measure_text(&Unlaned, &registry, "16px Lib", "HH\nH").unwrap().width, 23.11);
}

#[test]
fn the_font_box_is_the_face_ascender_and_descender_at_the_size_and_empty_text_measures_nothing() {
    let registry = regular_only();
    let face = registry.face(0);
    let upem = f64::from(face.units_per_em);
    let metrics = measure_text(&Unlaned, &registry, "20px Lib", "H").unwrap();
    assert!((metrics.font_bounding_box_ascent - f64::from(face.metrics.ascender) / upem * 20.0).abs() < 1e-4);
    assert!((metrics.font_bounding_box_descent + f64::from(face.metrics.descender) / upem * 20.0).abs() < 1e-4);
    assert_eq!(metrics.alphabetic_baseline, metrics.font_bounding_box_ascent);
    let empty = measure_text(&Unlaned, &registry, "20px Lib", "").unwrap();
    assert_eq!((empty.width, empty.font_bounding_box_ascent, empty.actual_bounding_box_right), (0.0, 0.0, 0.0));
}

#[test]
fn letter_spacing_adds_to_every_advance() {
    let registry = regular_only();
    let font = mixdog_fonts::css_font::parse("16px Lib").unwrap();
    let spaced = measure_parsed(&Unlaned, &registry, &font, "HH", &MeasureOptions { letter_spacing: 2.0 }).unwrap();
    assert_close(spaced.width, 27.11);
}

#[test]
fn a_text_with_a_nul_or_a_font_without_a_size_is_refused() {
    let registry = regular_only();
    assert!(measure_text(&Unlaned, &registry, "16px Lib", "a\0b").is_err());
    assert!(measure_text(&Unlaned, &registry, "Lib", "ab").is_err());
}

#[test]
fn the_ink_of_a_capital_sits_on_whole_pixels_from_the_baseline() {
    let registry = regular_only();
    let metrics = measure_text(&Unlaned, &registry, "20px Lib", "H").unwrap();
    // Liberation Sans caps are 1409 units of 2048: 13.76 px, fitted to the grid.
    assert_eq!(metrics.actual_bounding_box_ascent, 14.0);
    assert_eq!(metrics.actual_bounding_box_descent, 0.0);
}

#[test]
fn the_auto_hinter_puts_the_cap_height_and_baseline_on_pixel_rows() {
    let face = Face::from_file(&Unlaned, &Path::new(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts/LiberationSans-Regular.ttf")).unwrap();
    let parsed = face.parsed().unwrap();
    let metrics = autohint::metrics_of(&face).unwrap();
    let glyph = parsed.glyph_index('H').unwrap().0;
    for ppem in [12_i64, 16, 20, 33] {
        let hinted = metrics.hint(&parsed, glyph, ppem * 64, ppem * 64).unwrap();
        let ys: Vec<f32> = hinted.contours.iter().flatten().map(|point| point.1).collect();
        let (low, high) = ys.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(l, h), y| (l.min(*y), h.max(*y)));
        let unhinted = 1409.0 / 2048.0 * ppem as f32;
        assert_eq!(low, 0.0, "baseline at {ppem}");
        assert_eq!(high, high.round(), "cap height at {ppem}");
        assert!((high - unhinted).abs() <= 1.0, "{high} vs {unhinted}");
    }
}

#[test]
fn a_style_request_takes_the_registered_face_and_a_missing_style_is_synthesised_from_the_upright_one() {
    let mut registry = Registry::new();
    let regular = liberation(&mut registry, "LiberationSans-Regular.ttf", "Lib");
    let bold = liberation(&mut registry, "LiberationSans-Bold.ttf", "Lib");
    assert_eq!(faces_of(&Unlaned, &registry, "16px Lib", "a").unwrap(), [('a', regular)]);
    assert_eq!(faces_of(&Unlaned, &registry, "bold 16px Lib", "a").unwrap(), [('a', bold)]);
    // No italic face is registered: the upright one answers and the canvas shears it, which widens the ink to the right.
    assert_eq!(faces_of(&Unlaned, &registry, "italic 16px Lib", "a").unwrap(), [('a', regular)]);
    let upright = measure_text(&Unlaned, &registry, "20px Lib", "H").unwrap();
    let slanted = measure_text(&Unlaned, &registry, "italic 20px Lib", "H").unwrap();
    assert_eq!(slanted.width, upright.width);
    assert!(slanted.actual_bounding_box_right > upright.actual_bounding_box_right);
    // Only a regular face: a bold request strokes it, growing the box, and keeps the advance.
    let only = regular_only();
    let faux = measure_text(&Unlaned, &only, "bold 20px Lib", "H").unwrap();
    let plain = measure_text(&Unlaned, &only, "20px Lib", "H").unwrap();
    assert_eq!(faux.width, plain.width);
    assert!(faux.actual_bounding_box_right > plain.actual_bounding_box_right);
    assert!(faux.actual_bounding_box_ascent > plain.actual_bounding_box_ascent);
}

#[test]
fn an_unregistered_family_falls_back_to_the_first_registered_one_and_an_alias_names_a_family() {
    let mut registry = Registry::new();
    let first = liberation(&mut registry, "LiberationSans-Regular.ttf", "First");
    liberation(&mut registry, "LiberationSans-Bold.ttf", "Second");
    assert_eq!(faces_of(&Unlaned, &registry, "16px Nowhere", "a").unwrap(), [('a', first)]);
    assert_eq!(faces_of(&Unlaned, &registry, "16px Nowhere, Second", "a").unwrap()[0].1, 1);
    registry.set_alias("Second", "Short");
    assert_eq!(faces_of(&Unlaned, &registry, "16px Short", "a").unwrap()[0].1, 1);
    assert!(faces_of(&Unlaned, &Registry::new(), "16px Lib", "a").is_err());
}
