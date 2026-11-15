//! The Rust SVG rasteriser against what sharp 0.35.5 (libvips 8.18.7, librsvg 2.63.2) answered for the same SVGs
//! (`fixtures/office-svg/golden.json`, recorded by `benchmarks/rust-core/recorders/record-office-svg.mjs` from the product's own sharp;
//! re-record with `twin_live_svg`, the replay itself never starts Node).
//!
//! A case is an SVG and a list of steps: `metadata` (what `sharp(svg, { density }).metadata()` says), `raster` (`sharp(svg, { density }).png()`),
//! `fill` (the same with `resize(width, height, { fit: 'fill' })`, the pptx HTML build's `addSvg`) and `pdf` (the PDF page's logo: the declared
//! size, then a raster at density `round(72 * scale)`). The SVGs are the kit's own (icons, the orb's radial gradients, the motifs), logos and a
//! corpus of every way of stating a size.
//!
//! Tolerance, and why: sizes, error sentences, the density a logo is drawn at and the declared size are equal exactly (the recorded error text of
//! an XML syntax error is libxml's, which is not reproduced: only its `Input buffer has corrupt header` start is). Pixels, compared
//! premultiplied in all four channels, must be the same picture as the recorded one by the shared rule of
//! `mixdog_office_base::twin::pixels` (owner decision 2026-11-16: cairo and tiny-skia cover a curved edge with different sub-pixel
//! samples and ramp a gradient their own way): equal sizes, a mean difference per channel of at most 1 of 255, no channel of any 4x4
//! block average more than 24 away. The `tolerance` recorded with a case is not read. Text is not in the recording (sharp draws it with
//! fontconfig's faces, which a recording cannot pin); the faces of the font registry are checked separately.
//!
//! The test measures every step before it decides and prints the difference of each (largest, mean) to stderr.

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::Unlaned;
use mixdog_office_base::twin;
use mixdog_office_base::twin::pixels::{self, Picture};
use mixdog_raster::Image;
use mixdog_raster::RasterError;
use mixdog_raster::svg;
use mixdog_raster::svg::SvgFonts;
use serde_json::Value;

fn unsigned(step: &Value, key: &str) -> u32 {
    step[key].as_u64().unwrap_or_else(|| panic!("`{key}` is missing")) as u32
}

/// The recorded error sentence against ours.
fn error_matches(recorded: &str, ours: &RasterError) -> bool {
    if recorded.starts_with("Input buffer has corrupt header: glib:") {
        ours.message().starts_with("Input buffer has corrupt header")
    } else {
        recorded == ours.message()
    }
}

/// Compares one step; the failures are pushed to `problems`.
fn check_step(fonts: &SvgFonts, case: &str, svg_text: &str, step: &Value, problems: &mut Vec<String>) {
    let op = step["op"].as_str().expect("op");
    let density = step["density"].as_f64();
    let default_density = density.unwrap_or(svg::DEFAULT_DENSITY);
    let label = format!("{case} / {op} {density:?}");
    let bytes = svg_text.as_bytes();
    let expected_image = |step: &Value| Image::decode(&STANDARD.decode(step["png"].as_str().expect("png")).expect("base64")).expect("the recorded png decodes");
    let compare = |expected: &Image, actual: &Image, problems: &mut Vec<String>| {
        if (expected.width(), expected.height()) != (actual.width(), actual.height()) {
            problems.push(format!("{label}: size {}x{} but recorded {}x{}", actual.width(), actual.height(), expected.width(), expected.height()));
            return;
        }
        let (a, b) = (pixels::premultiplied(expected.rgba()), pixels::premultiplied(actual.rgba()));
        let comparison = pixels::compare(Picture::new(expected.width(), expected.height(), &a), Picture::new(actual.width(), actual.height(), &b));
        eprintln!("{label}: {}", comparison.summary());
        if let Err(why) = comparison.verdict() {
            problems.push(format!("{label}: {why}"));
        }
    };
    if let Some(recorded) = step.get("error").and_then(Value::as_str) {
        let ours = match op {
            "metadata" => svg::metadata(fonts, bytes, default_density).err(),
            "raster" => svg::rasterize(fonts, bytes, default_density).err(),
            "fill" => svg::rasterize_to(fonts, bytes, default_density, unsigned(step, "width"), unsigned(step, "height")).err(),
            _ => svg::rasterize_logo(fonts, bytes).err(),
        };
        match ours {
            Some(ours) if error_matches(recorded, &ours) => {}
            Some(ours) => problems.push(format!("{label}: error `{}` but recorded `{recorded}`", ours.message())),
            None => problems.push(format!("{label}: no error but recorded `{recorded}`")),
        }
        return;
    }
    match op {
        "metadata" => match svg::metadata(fonts, bytes, default_density) {
            Ok(meta) => {
                if (meta.width, meta.height) != (unsigned(step, "width"), unsigned(step, "height")) {
                    problems.push(format!("{label}: size {}x{} but recorded {}x{}", meta.width, meta.height, step["width"], step["height"]));
                }
                if Some(meta.density) != step["density"].as_f64() {
                    problems.push(format!("{label}: density {} but recorded {}", meta.density, step["density"]));
                }
                // sharp reports every SVG as four bands with alpha.
                assert_eq!((step["channels"].as_u64(), step["hasAlpha"].as_bool(), step["format"].as_str()), (Some(4), Some(true), Some("svg")), "{label}");
            }
            Err(error) => problems.push(format!("{label}: {error}")),
        },
        "raster" => match svg::rasterize(fonts, bytes, default_density) {
            Ok(image) => compare(&expected_image(step), &image, problems),
            Err(error) => problems.push(format!("{label}: {error}")),
        },
        "fill" => match svg::rasterize_to(fonts, bytes, default_density, unsigned(step, "width"), unsigned(step, "height")) {
            Ok(image) => compare(&expected_image(step), &image, problems),
            Err(error) => problems.push(format!("{label}: {error}")),
        },
        _ => match svg::rasterize_logo(fonts, bytes) {
            Ok(logo) => {
                if (logo.width, logo.height, logo.density) != (unsigned(step, "width"), unsigned(step, "height"), unsigned(step, "usedDensity")) {
                    problems.push(format!("{label}: declared {}x{} at {} but recorded {}x{} at {}", logo.width, logo.height, logo.density, step["width"], step["height"], step["usedDensity"]));
                }
                compare(&expected_image(step), &logo.image, problems);
            }
            Err(error) => problems.push(format!("{label}: {error}")),
        },
    }
}

#[test]
fn every_svg_has_the_recorded_size_and_pixels_within_its_tolerance() {
    let golden = twin::load_golden("office-svg");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 70, "the corpus is smaller than it was recorded");
    let fonts = SvgFonts::none();
    let mut problems = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        for step in case["steps"].as_array().expect("steps") {
            check_step(&fonts, name, case["svg"].as_str().expect("svg"), step, &mut problems);
        }
    }
    assert!(problems.is_empty(), "{} steps are not the recorded picture or answer:\n{}", problems.len(), problems.join("\n"));
}

fn lisu_registry() -> Registry {
    let mut registry = Registry::new();
    let path: PathBuf = twin::repo_root().join("native/core/fixtures/office-measure/faces/NotoSansLisu-Regular.ttf");
    registry.register_file(&Unlaned, &path, Some("Twin Lisu")).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    registry
}

fn ink(image: &Image) -> usize {
    image.rgba().chunks_exact(4).filter(|pixel| pixel[3] > 0).count()
}

#[test]
fn text_is_drawn_with_the_registered_faces_under_their_registered_names() {
    let registry = lisu_registry();
    let fonts = SvgFonts::from_registry(&Unlaned, &registry);
    let text = |family: &str| {
        format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"40\"><text x=\"4\" y=\"30\" font-size=\"28\" font-family=\"{family}\">\u{a4d0}\u{a4d1}\u{a4d2}</text></svg>")
    };
    let named = svg::rasterize(&fonts, text("Twin Lisu").as_bytes(), 72.0).expect("rendered");
    assert_eq!((named.width(), named.height()), (80, 40));
    assert!(ink(&named) > 100, "the registered face drew nothing");
    // A family that is not registered falls to the registry's first one, as the canvas does.
    let fallback = svg::rasterize(&fonts, text("No Such Family").as_bytes(), 72.0).expect("rendered");
    assert_eq!(fallback, named);
    // Without faces there is no text.
    let bare = svg::rasterize(&SvgFonts::none(), text("Twin Lisu").as_bytes(), 72.0).expect("rendered");
    assert_eq!(ink(&bare), 0);
}

/// Records again with Node and compares: `cargo test -p mixdog-raster --test twin_svg -- --ignored`.
#[test]
#[ignore = "re-records through Node (sharp)"]
fn twin_live_svg() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-svg.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_svg_has_the_recorded_size_and_pixels_within_its_tolerance();
}
