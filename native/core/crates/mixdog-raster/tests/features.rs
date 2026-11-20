//! What the raster crate does for a caller: the 2D canvas, SVG rasterisation, the image operations and compositing.

use mixdog_raster::canvas::{Canvas, FillRule};
use mixdog_raster::ops::{self, Fit, Kernel, Position, ResizeOptions};
use mixdog_raster::svg::{self, SvgFonts};
use mixdog_raster::{Blend, Image, Overlay, Placement, composite, stats};

fn at(image: &Image, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * image.width() + x) * 4) as usize;
    let p = image.rgba();
    [p[i], p[i + 1], p[i + 2], p[i + 3]]
}

fn canvas(width: u32, height: u32) -> Canvas {
    Canvas::new(width, height).unwrap()
}

fn solid(width: u32, height: u32, colour: [u8; 4]) -> Image {
    Image::create(width, height, 4, colour).unwrap()
}

// ---- canvas ----

#[test]
fn a_filled_rectangle_has_the_exact_colour_inside_and_nothing_outside() {
    let mut c = canvas(10, 10);
    assert!(c.set_fill_color("#ff8000"));
    c.fill_rect(2.0, 3.0, 4.0, 2.0);
    let image = c.to_image().unwrap();
    for y in 0..10 {
        for x in 0..10 {
            let inside = (2..6).contains(&x) && (3..5).contains(&y);
            let want = if inside { [255, 128, 0, 255] } else { [0, 0, 0, 0] };
            assert_eq!(at(&image, x, y), want, "pixel {x},{y}");
        }
    }
}

#[test]
fn an_edge_on_a_half_pixel_is_covered_by_about_half() {
    let mut c = canvas(6, 2);
    c.set_fill_color("#000000");
    c.fill_rect(0.0, 0.0, 2.5, 2.0);
    let image = c.to_image().unwrap();
    assert_eq!(at(&image, 1, 0)[3], 255);
    let edge = at(&image, 2, 0)[3];
    assert!((120..=136).contains(&edge), "edge alpha {edge}");
    assert_eq!(at(&image, 3, 0)[3], 0);
}

#[test]
fn a_filled_circle_is_solid_inside_empty_outside_and_its_area_is_within_half_a_pixel_of_pi_r_squared() {
    // The fill is an anti-aliasing scan converter in fixed point, so mirrored rim pixels are not required to match
    // each other; what a caller can rely on is where the shape is solid, where it is empty, and that the total
    // coverage is that of a circle whose edge is moved by at most half a pixel.
    let mut c = canvas(40, 40);
    c.set_fill_color("#000000");
    c.begin_path();
    c.arc(20.0, 20.0, 12.0, 0.0, std::f32::consts::TAU, false).unwrap();
    c.fill(FillRule::Winding);
    let image = c.to_image().unwrap();
    let mut area = 0.0f64;
    for y in 0..40 {
        for x in 0..40 {
            let a = at(&image, x, y)[3];
            area += f64::from(a) / 255.0;
            // A pixel whose centre is more than 1.5 px from the edge cannot be touched by it.
            let distance = (f64::from(x) + 0.5 - 20.0).hypot(f64::from(y) + 0.5 - 20.0);
            if distance <= 12.0 - 1.5 {
                assert_eq!(a, 255, "inside {x},{y}");
            } else if distance >= 12.0 + 1.5 {
                assert_eq!(a, 0, "outside {x},{y}");
            }
        }
    }
    let (inner, outer) = (std::f64::consts::PI * 11.5 * 11.5, std::f64::consts::PI * 12.5 * 12.5);
    assert!((inner..=outer).contains(&area), "area {area} outside {inner}..{outer}");
}

#[test]
fn a_clip_limits_later_fills_and_restore_lifts_it() {
    let mut c = canvas(10, 10);
    c.set_fill_color("#0000ff");
    c.save();
    c.begin_path();
    c.rect(0.0, 0.0, 5.0, 10.0);
    c.clip(FillRule::Winding);
    c.fill_rect(0.0, 0.0, 10.0, 10.0);
    c.restore();
    c.fill_rect(0.0, 0.0, 10.0, 2.0);
    let image = c.to_image().unwrap();
    assert_eq!(at(&image, 4, 5), [0, 0, 255, 255]);
    assert_eq!(at(&image, 5, 5)[3], 0);
    assert_eq!(at(&image, 9, 1), [0, 0, 255, 255]);
}

#[test]
fn even_odd_leaves_the_hole_of_nested_same_direction_rectangles_that_non_zero_fills() {
    let paint = |rule| {
        let mut c = canvas(12, 12);
        c.set_fill_color("#000000");
        c.begin_path();
        c.rect(0.0, 0.0, 12.0, 12.0);
        c.rect(3.0, 3.0, 6.0, 6.0);
        c.fill(rule);
        c.to_image().unwrap()
    };
    assert_eq!(at(&paint(FillRule::Winding), 6, 6)[3], 255);
    assert_eq!(at(&paint(FillRule::EvenOdd), 6, 6)[3], 0);
    assert_eq!(at(&paint(FillRule::EvenOdd), 1, 1)[3], 255);
}

#[test]
fn transforms_move_and_scale_what_is_drawn() {
    let mut c = canvas(20, 20);
    c.set_fill_color("#ff0000");
    c.translate(10.0, 4.0);
    c.scale(2.0, 3.0);
    c.fill_rect(0.0, 0.0, 3.0, 2.0); // x 10..16, y 4..10
    let image = c.to_image().unwrap();
    assert_eq!(at(&image, 10, 4), [255, 0, 0, 255]);
    assert_eq!(at(&image, 15, 9), [255, 0, 0, 255]);
    assert_eq!(at(&image, 9, 4)[3], 0);
    assert_eq!(at(&image, 16, 9)[3], 0);
    assert_eq!(at(&image, 15, 10)[3], 0);
}

#[test]
fn global_alpha_scales_the_coverage_and_clear_rect_removes_paint() {
    let mut c = canvas(4, 4);
    c.set_fill_color("#00ff00");
    c.set_global_alpha(0.5);
    c.fill_rect(0.0, 0.0, 4.0, 4.0);
    let half = at(&c.to_image().unwrap(), 1, 1);
    assert!((126..=129).contains(&half[3]), "{half:?}");
    assert_eq!((half[0], half[2]), (0, 0));
    c.clear_rect(0.0, 0.0, 2.0, 4.0);
    let image = c.to_image().unwrap();
    assert_eq!(at(&image, 1, 1)[3], 0);
    assert_eq!(at(&image, 3, 1)[3], half[3]);
}

#[test]
fn a_dashed_stroke_alternates_ink_and_gaps_of_the_stated_length() {
    let mut c = canvas(40, 6);
    c.set_stroke_color("#000000");
    c.set_line_width(2.0);
    c.set_line_dash(&[4.0, 4.0]);
    c.begin_path();
    c.move_to(0.0, 3.0);
    c.line_to(40.0, 3.0);
    c.stroke();
    let image = c.to_image().unwrap();
    for x in 0..40u32 {
        let inked = (x / 4) % 2 == 0;
        assert_eq!(at(&image, x, 3)[3], if inked { 255 } else { 0 }, "x {x}");
    }
    assert_eq!(at(&image, 2, 0)[3], 0);
}

#[test]
fn a_stroke_is_as_wide_as_the_line_width() {
    let mut c = canvas(10, 10);
    c.set_stroke_color("#000000");
    c.set_line_width(4.0);
    c.begin_path();
    c.move_to(0.0, 5.0);
    c.line_to(10.0, 5.0);
    c.stroke();
    let image = c.to_image().unwrap();
    let rows: Vec<u32> = (0..10).filter(|y| at(&image, 5, *y)[3] == 255).collect();
    assert_eq!(rows, vec![3, 4, 5, 6]);
}

// ---- SVG ----

const FONTS: fn() -> SvgFonts = SvgFonts::none;

#[test]
fn an_svg_rect_is_rasterised_at_the_declared_size_with_exact_colour() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect x="0" y="0" width="10" height="10" fill="#00ff00"/></svg>"##;
    let image = svg::rasterize(&FONTS(), svg, 72.0).unwrap();
    assert_eq!((image.width(), image.height()), (20, 10));
    assert_eq!(at(&image, 4, 5), [0, 255, 0, 255]);
    assert_eq!(at(&image, 15, 5)[3], 0);
    let meta = svg::metadata(&FONTS(), svg, 72.0).unwrap();
    assert_eq!((meta.width, meta.height), (20, 10));
}

#[test]
fn a_higher_density_scales_the_svg_raster_in_proportion() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>"##;
    let image = svg::rasterize(&FONTS(), svg, 144.0).unwrap();
    assert_eq!((image.width(), image.height()), (40, 20));
}

#[test]
fn rasterising_to_a_size_fills_that_size() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="blue"/></svg>"##;
    let image = svg::rasterize_to(&FONTS(), svg, 72.0, 60, 30).unwrap();
    assert_eq!((image.width(), image.height()), (60, 30));
    assert_eq!(at(&image, 59, 29), [0, 0, 255, 255]);
}

#[test]
fn a_semi_transparent_svg_fill_keeps_straight_colour() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#ff0000" fill-opacity="0.5"/></svg>"##;
    let p = at(&svg::rasterize(&FONTS(), svg, 72.0).unwrap(), 1, 1);
    assert!((126..=129).contains(&p[3]), "{p:?}");
    assert!(p[0] >= 253 && p[1] == 0 && p[2] == 0, "{p:?}");
}

#[test]
fn a_broken_svg_is_an_error_not_a_blank_image() {
    assert!(svg::rasterize(&FONTS(), b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect", 72.0).is_err());
    assert!(svg::rasterize(&FONTS(), b"not markup", 72.0).is_err());
}

// ---- image operations ----

#[test]
fn raw_bytes_round_trip_through_png() {
    let raw: Vec<u8> = (0..4 * 3 * 3).map(|i| (i * 7) as u8).collect();
    let image = Image::from_raw(4, 3, 3, &raw).unwrap();
    assert_eq!((image.width(), image.height(), image.channels(), image.has_alpha()), (4, 3, 3, false));
    let back = Image::decode(&image.to_png().unwrap()).unwrap();
    assert_eq!(back.to_raw(), raw);
    assert!(Image::from_raw(4, 3, 3, &raw[1..]).is_err());
}

#[test]
fn resize_fits_the_requested_box_by_each_fit_mode() {
    let source = solid(40, 20, [9, 9, 9, 255]);
    let dims = |fit, w, h| {
        let image = ops::resize(&source, &ResizeOptions { width: Some(w), height: Some(h), fit, ..ResizeOptions::default() }).unwrap();
        (image.width(), image.height())
    };
    assert_eq!(dims(Fit::Cover, 10, 10), (10, 10));
    assert_eq!(dims(Fit::Fill, 10, 10), (10, 10));
    assert_eq!(dims(Fit::Contain, 10, 10), (10, 10));
    assert_eq!(dims(Fit::Inside, 10, 10), (10, 5));
    assert_eq!(dims(Fit::Outside, 10, 10), (20, 10));
}

#[test]
fn contain_pads_with_the_background_and_cover_crops_by_position() {
    let source = Image::from_raw(2, 1, 3, &[255, 0, 0, 0, 0, 255]).unwrap();
    let padded = ops::resize(
        &source,
        &ResizeOptions {
            width: Some(2),
            height: Some(4),
            fit: Fit::Contain,
            kernel: Kernel::Nearest,
            background: [0, 255, 0, 255],
            ..ResizeOptions::default()
        },
    )
    .unwrap();
    assert_eq!(at(&padded, 0, 0), [0, 255, 0, 255]);
    assert_eq!(at(&padded, 0, 3), [0, 255, 0, 255]);
    // The 2 x 1 picture sits on one row of the 2 x 4 canvas; the other rows are background.
    let picture_rows: Vec<u32> = (0..4).filter(|y| at(&padded, 0, *y)[..3] == [255, 0, 0]).collect();
    assert_eq!(picture_rows.len(), 1);
    let row = picture_rows[0];
    assert_eq!(at(&padded, 1, row)[..3], [0, 0, 255]);

    let cropped = |position| {
        let o = ResizeOptions { width: Some(1), height: Some(1), fit: Fit::Cover, position, kernel: Kernel::Nearest, ..ResizeOptions::default() };
        at(&ops::resize(&source, &o).unwrap(), 0, 0)[..3].to_vec()
    };
    assert_eq!(cropped(Position::West), vec![255, 0, 0]);
    assert_eq!(cropped(Position::East), vec![0, 0, 255]);
}

#[test]
fn resampling_keeps_a_flat_colour_flat_with_every_kernel() {
    let source = solid(33, 21, [30, 90, 200, 255]);
    for name in ["nearest", "cubic", "mitchell", "lanczos2", "lanczos3"] {
        let kernel = Kernel::parse(name).unwrap_or_else(|| panic!("kernel {name}"));
        let image = ops::resize_exact(&source, 11, 7, kernel);
        assert_eq!((image.width(), image.height()), (11, 7));
        for y in 0..7 {
            for x in 0..11 {
                assert_eq!(at(&image, x, y), [30, 90, 200, 255], "{name} {x},{y}");
            }
        }
    }
}

#[test]
fn extract_and_extend_move_the_picture_by_the_stated_offsets() {
    let raw: Vec<u8> = (0..16).flat_map(|i| [i as u8, 0, 0, 255]).collect();
    let source = Image::from_raw(4, 4, 4, &raw).unwrap();
    let part = ops::extract(&source, 1, 2, 2, 2).unwrap();
    assert_eq!((part.width(), part.height()), (2, 2));
    assert_eq!(at(&part, 0, 0)[0], 9); // row 2, column 1
    assert_eq!(at(&part, 1, 1)[0], 14);
    assert!(ops::extract(&source, 3, 3, 2, 2).is_err());

    let wider = ops::extend(&source, 1, 2, 3, 4, [7, 8, 9, 255]);
    assert_eq!((wider.width(), wider.height()), (11, 7));
    assert_eq!(at(&wider, 0, 0), [7, 8, 9, 255]);
    assert_eq!(at(&wider, 3, 1)[0], 0);
    assert_eq!(at(&wider, 10, 6), [7, 8, 9, 255]);
}

#[test]
fn trim_cuts_a_uniform_border_and_reports_where_the_picture_starts() {
    let mut image = solid(12, 10, [255, 255, 255, 255]);
    let mut raw = image.to_raw();
    for y in 3..7 {
        for x in 4..9 {
            raw[((y * 12 + x) * 4) as usize..][..3].copy_from_slice(&[0, 0, 0]);
        }
    }
    image = Image::from_raw(12, 10, 4, &raw).unwrap();
    let trimmed = ops::trim(&image, 10.0).unwrap();
    assert_eq!((trimmed.left, trimmed.top), (4, 3));
    assert_eq!((trimmed.image.width(), trimmed.image.height()), (5, 4));
}

#[test]
fn greyscale_equalises_the_channels_and_linear_applies_a_times_plus_b() {
    let source = Image::from_raw(1, 1, 3, &[200, 100, 50]).unwrap();
    let grey = ops::greyscale(&source);
    let p = at(&grey, 0, 0);
    assert_eq!(p[0], p[1]);
    assert_eq!(p[1], p[2]);
    // Rec.709 luma of (200, 100, 50) is between its darkest and brightest channel.
    assert!((50..=200).contains(&p[0]));
    let lin = ops::linear(&source, 0.5, 10.0);
    assert_eq!(at(&lin, 0, 0)[..3], [110, 60, 35]);
}

#[test]
fn alpha_can_be_added_removed_and_flattened_onto_a_background() {
    let opaque = Image::from_raw(1, 1, 3, &[10, 20, 30]).unwrap();
    let with_alpha = opaque.ensure_alpha();
    assert!(with_alpha.has_alpha());
    assert_eq!(at(&with_alpha, 0, 0), [10, 20, 30, 255]);
    assert!(!with_alpha.remove_alpha().has_alpha());
    let clear = Image::from_raw(1, 1, 4, &[255, 0, 0, 0]).unwrap();
    let flat = clear.flatten([1, 2, 3]);
    assert!(!flat.has_alpha());
    assert_eq!(flat.rgba()[..3], [1, 2, 3]);
}

#[test]
fn stats_report_the_extremes_mean_and_their_positions() {
    let image = Image::from_raw(2, 2, 3, &[0, 0, 0, 100, 0, 0, 200, 0, 0, 100, 0, 0]).unwrap();
    let channels = stats::stats(&image);
    let red = &channels[0];
    assert_eq!((red.min, red.max), (0, 200));
    assert!((red.mean - 100.0).abs() < 1e-9);
    assert_eq!((red.min_x, red.min_y, red.max_x, red.max_y), (0, 0, 0, 1));
    assert_eq!((channels[1].min, channels[1].max), (0, 0));
}

#[test]
fn compositing_blends_over_multiply_and_dest_in_as_defined() {
    let base = solid(4, 4, [0, 0, 255, 255]);
    let red = |alpha| solid(2, 2, [255, 0, 0, alpha]);
    let place = |image: Image, blend| Overlay { image, blend, placement: Placement::At { left: 1, top: 1 } };

    let over = composite(&base, &[place(red(255), Blend::Over)]);
    assert_eq!(at(&over, 1, 1), [255, 0, 0, 255]);
    assert_eq!(at(&over, 0, 0), [0, 0, 255, 255]);
    assert_eq!(at(&over, 3, 3), [0, 0, 255, 255]);

    let half = composite(&base, &[place(red(128), Blend::Over)]);
    let p = at(&half, 1, 1);
    assert!(p[0].abs_diff(128) <= 1 && p[2].abs_diff(127) <= 1 && p[3] == 255, "{p:?}");

    // Multiply of red by blue is black; the untouched corner keeps the base.
    let multiplied = composite(&base, &[place(red(255), Blend::Multiply)]);
    assert_eq!(at(&multiplied, 1, 1)[..3], [0, 0, 0]);
    assert_eq!(at(&multiplied, 0, 0), [0, 0, 255, 255]);

    // dest-in keeps the base only where the overlay is opaque.
    let kept = composite(&base, &[place(red(255), Blend::DestIn)]);
    assert_eq!(at(&kept, 1, 1), [0, 0, 255, 255]);
    assert_eq!(at(&kept, 0, 0)[3], 0);
}

#[test]
fn a_centred_overlay_sits_in_the_middle_of_the_base() {
    let base = solid(6, 6, [0, 0, 0, 255]);
    let overlay = Overlay { image: solid(2, 2, [255, 255, 255, 255]), blend: Blend::Over, placement: Placement::Centre };
    let out = composite(&base, &[overlay]);
    assert_eq!(at(&out, 2, 2)[..3], [255, 255, 255]);
    assert_eq!(at(&out, 3, 3)[..3], [255, 255, 255]);
    assert_eq!(at(&out, 1, 1)[..3], [0, 0, 0]);
    assert_eq!(at(&out, 4, 4)[..3], [0, 0, 0]);
}

#[test]
fn a_gzip_svg_is_rasterised_and_a_gzip_bomb_or_a_too_deep_document_is_refused() {
    use std::io::Write;
    let gzip = |bytes: &[u8]| {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    };
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4"><rect width="6" height="4" fill="#00ff00"/></svg>"##;
    let image = svg::rasterize(&FONTS(), &gzip(svg), 72.0).unwrap();
    assert_eq!((image.width(), image.height()), (6, 4));
    assert_eq!(at(&image, 3, 2), [0, 255, 0, 255]);
    let mut bomb = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\">".to_vec();
    bomb.resize(mixdog_imaging::svg_limits::DOCUMENT_BYTES + 4096, b' ');
    assert!(svg::rasterize(&FONTS(), &gzip(&bomb), 72.0).is_err(), "inflation stops at the document bound");
    let depth = mixdog_imaging::svg_limits::DEPTH + 50;
    let deep = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\">{}{}</svg>", "<g>".repeat(depth), "</g>".repeat(depth));
    assert!(svg::rasterize(&FONTS(), deep.as_bytes(), 72.0).is_err(), "nesting past the bound is refused");
}
