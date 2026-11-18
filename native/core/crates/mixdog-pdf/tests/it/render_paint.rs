//! Page rendering: fills, strokes, clipping, transforms, colour spaces and transparency, checked on pixels whose value
//! follows from the geometry.

use crate::render_support::{WHITE, pdf, render, render_scaled};

#[test]
fn the_page_is_as_large_as_its_box_times_the_scale_rounded_up() {
    let one = render_scaled(pdf("0 0 20 10", "", "", "", &[]), 1.0);
    assert_eq!((one.width, one.height), (20, 10));
    assert!(one.rgba.chunks_exact(4).all(|p| p == WHITE), "an empty page is white");
    let doubled = render_scaled(pdf("0 0 20 10", "", "", "", &[]), 2.0);
    assert_eq!((doubled.width, doubled.height), (40, 20));
    let fractional = render_scaled(pdf("0 0 10.5 10.5", "", "", "", &[]), 1.0);
    assert_eq!((fractional.width, fractional.height), (11, 11));
}

#[test]
fn a_rotated_page_swaps_its_width_and_height() {
    let page = render_scaled(pdf("0 0 20 10", "/Rotate 90", "1 0 0 rg 0 0 20 10 re f", "", &[]), 1.0);
    assert_eq!((page.width, page.height), (10, 20));
    assert_eq!(page.at(5, 10), [255, 0, 0, 255]);
}

#[test]
fn a_filled_rectangle_has_exact_colour_inside_with_the_y_axis_pointing_up() {
    // PDF y 12..16 is the rows 4..8 from the top of a 20 point page.
    let page = render("1 0 0 rg 2 12 6 4 re f", "", &[]);
    for y in 0..20 {
        for x in 0..20 {
            let inside = (2..8).contains(&x) && (4..8).contains(&y);
            assert_eq!(page.at(x, y), if inside { [255, 0, 0, 255] } else { WHITE }, "pixel {x},{y}");
        }
    }
}

#[test]
fn the_cm_operator_translates_and_scales_the_drawing() {
    let page = render("q 2 0 0 3 4 2 cm 0 0 1 rg 0 0 3 2 re f Q", "", &[]);
    // x 4..10, y 2..8 (rows 12..18).
    assert_eq!(page.at(4, 12), [0, 0, 255, 255]);
    assert_eq!(page.at(9, 17), [0, 0, 255, 255]);
    assert_eq!(page.at(10, 17), WHITE);
    assert_eq!(page.at(3, 12), WHITE);
    assert_eq!(page.at(9, 18), WHITE);
}

#[test]
fn a_stroke_is_as_wide_as_the_line_width_and_a_dash_leaves_gaps() {
    let solid = render("4 w 0 0 0 RG 0 10 m 20 10 l S", "", &[]);
    let inked: Vec<usize> = (0..20).filter(|y| solid.at(10, *y)[0] == 0).collect();
    assert_eq!(inked, vec![8, 9, 10, 11]);
    let dashed = render("2 w 0 0 0 RG [4 4] 0 d 0 10 m 20 10 l S", "", &[]);
    for x in 0..20 {
        let black = (x / 4) % 2 == 0;
        assert_eq!(dashed.at(x, 9)[0] == 0, black, "x {x}");
    }
}

#[test]
fn a_clip_restricts_a_fill_and_q_restores_the_clip() {
    let page = render("q 5 5 10 10 re W n 1 0 0 rg 0 0 20 20 re f Q 0 0 1 rg 0 0 20 2 re f", "", &[]);
    assert_eq!(page.at(10, 10), [255, 0, 0, 255]);
    assert_eq!(page.at(4, 10), WHITE);
    assert_eq!(page.at(15, 10), WHITE);
    assert_eq!(page.at(2, 2), WHITE);
    assert_eq!(page.at(2, 19), [0, 0, 255, 255]);
}

#[test]
fn even_odd_fill_leaves_a_hole_that_non_zero_fills() {
    let shape = "0 0 20 20 re 5 5 10 10 re";
    let winding = render(&format!("0 g {shape} f"), "", &[]);
    let even_odd = render(&format!("0 g {shape} f*"), "", &[]);
    assert_eq!(winding.at(10, 10)[0], 0);
    assert_eq!(even_odd.at(10, 10), WHITE);
    assert_eq!(even_odd.at(2, 2)[0], 0);
}

#[test]
fn an_edge_between_pixels_is_blended_by_its_coverage() {
    let page = render("0 g 0 0 5.5 20 re f", "", &[]);
    assert_eq!(page.at(4, 3)[0], 0);
    let edge = page.at(5, 3)[0];
    assert!((118..=138).contains(&edge), "half-covered pixel is {edge}");
    assert_eq!(page.at(6, 3), WHITE);
}

#[test]
fn device_colour_spaces_fill_with_their_colours() {
    let grey = render("0.5 g 0 0 20 20 re f", "", &[]).at(10, 10);
    assert!(grey[0].abs_diff(128) <= 1 && grey[0] == grey[1] && grey[1] == grey[2], "{grey:?}");
    assert_eq!(render("0 1 0 rg 0 0 20 20 re f", "", &[]).at(3, 3), [0, 255, 0, 255]);
    let black = render("0 0 0 1 k 0 0 20 20 re f", "", &[]).at(3, 3);
    assert!(black[..3].iter().all(|c| *c < 60), "full black ink is dark: {black:?}");
    let white = render("0 0 0 0 k 0 0 20 20 re f", "", &[]).at(3, 3);
    assert_eq!(white, WHITE);
    let cyan = render("1 0 0 0 k 0 0 20 20 re f", "", &[]).at(3, 3);
    assert!(cyan[0] < 80 && cyan[2] > 200 && cyan[1] > cyan[0], "cyan ink: {cyan:?}");
}

#[test]
fn an_indexed_colour_space_maps_its_index_through_the_palette() {
    let page = render(
        "/CS0 cs 1 sc 0 0 20 20 re f",
        "/ColorSpace << /CS0 [/Indexed /DeviceRGB 1 <FF0000 0000FF>] >>",
        &[],
    );
    assert_eq!(page.at(5, 5), [0, 0, 255, 255]);
}

#[test]
fn constant_alpha_blends_a_fill_with_what_is_beneath() {
    let page = render("/G gs 1 0 0 rg 0 0 20 20 re f", "/ExtGState << /G << /ca 0.5 >> >>", &[]);
    let p = page.at(5, 5);
    assert_eq!(p[0], 255);
    assert!(p[1].abs_diff(127) <= 2 && p[2].abs_diff(127) <= 2, "{p:?}");
}

#[test]
fn a_form_xobject_is_drawn_through_its_matrix_and_its_own_resources() {
    let form = crate::render_support::stream(
        "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Matrix [1 0 0 1 5 5]",
        b"0 1 0 rg 0 0 100 100 re f",
    );
    let page = render("/Fm Do", "/XObject << /Fm 5 0 R >>", &[form]);
    // The box is clipped to 10 x 10 and moved by (5, 5): x 5..15, rows 5..15.
    assert_eq!(page.at(10, 10), [0, 255, 0, 255]);
    assert_eq!(page.at(4, 10), WHITE);
    assert_eq!(page.at(15, 10), WHITE);
    assert_eq!(page.at(10, 4), WHITE);
}

#[test]
fn an_axial_shading_runs_from_the_first_colour_to_the_second() {
    let function = b"<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>".to_vec();
    let page = render(
        "/Sh sh",
        "/Shading << /Sh << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 20 0] /Function 5 0 R /Extend [true true] >> >>",
        &[function],
    );
    let (left, middle, right) = (page.at(0, 10), page.at(10, 10), page.at(19, 10));
    assert!(left[0] > 230 && left[2] < 25, "{left:?}");
    assert!(right[2] > 230 && right[0] < 25, "{right:?}");
    assert!(middle[0].abs_diff(128) < 20 && middle[2].abs_diff(128) < 20, "{middle:?}");
    // Colour does not change along the axis' perpendicular.
    assert_eq!(page.at(10, 2), page.at(10, 18));
}

#[test]
fn a_tiling_pattern_repeats_its_cell_across_the_filled_area() {
    let pattern = crate::render_support::stream(
        "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>",
        b"1 0 0 rg 0 0 5 5 re f",
    );
    let page = render("/Pattern cs /P scn 0 0 20 20 re f", "/Pattern << /P 5 0 R >>", &[pattern]);
    // The red square of each cell sits at its lower left: pdf (2,2), (12,2), (2,12), (12,12).
    for (x, y) in [(2, 17), (12, 17), (2, 7), (12, 7)] {
        assert_eq!(page.at(x, y), [255, 0, 0, 255], "cell at {x},{y}");
    }
    for (x, y) in [(7, 12), (17, 2), (7, 2)] {
        assert_eq!(page.at(x, y), WHITE, "gap at {x},{y}");
    }
}
