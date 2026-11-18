//! Page rendering of images: RGB and grey samples, image masks painted in the fill colour, soft masks, and the
//! placement of the unit square by the current matrix.

use crate::render_support::{WHITE, render, stream};

fn image(dict: &str, samples: &[u8]) -> Vec<u8> {
    stream(&format!("/Type /XObject /Subtype /Image {dict}"), samples)
}

const FILL_PAGE: &str = "q 20 0 0 20 0 0 cm /Im Do Q";
const IMAGE: &str = "/XObject << /Im 5 0 R >>";

#[test]
fn an_rgb_image_fills_the_unit_square_with_its_quadrants_upright() {
    // Rows from the top: red, green / blue, white.
    let samples = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];
    let page = render(FILL_PAGE, IMAGE, &[image("/Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8", &samples)]);
    let near = |p: [u8; 4], want: [u8; 3]| p[..3].iter().zip(want).all(|(a, b)| a.abs_diff(b) <= 8);
    assert!(near(page.at(3, 3), [255, 0, 0]), "{:?}", page.at(3, 3));
    assert!(near(page.at(16, 3), [0, 255, 0]), "{:?}", page.at(16, 3));
    assert!(near(page.at(3, 16), [0, 0, 255]), "{:?}", page.at(3, 16));
    assert!(near(page.at(16, 16), [255, 255, 255]), "{:?}", page.at(16, 16));
}

#[test]
fn an_image_is_confined_to_the_square_the_matrix_gives_it() {
    let page = render(
        "q 10 0 0 10 5 5 cm /Im Do Q",
        IMAGE,
        &[image("/Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", &[0])],
    );
    assert_eq!(page.at(10, 10)[0], 0);
    assert_eq!(page.at(4, 10), WHITE);
    assert_eq!(page.at(15, 10), WHITE);
    assert_eq!(page.at(10, 4), WHITE);
    assert_eq!(page.at(10, 15), WHITE);
}

#[test]
fn an_image_mask_paints_the_fill_colour_where_its_bits_are_zero() {
    // Left half bit 0 (paint), right half bit 1 (leave): one row, two samples packed in the high bits.
    let mask = image("/Width 2 /Height 1 /ImageMask true /BitsPerComponent 1", &[0b0100_0000]);
    let page = render(&format!("1 0 0 rg {FILL_PAGE}"), IMAGE, &[mask]);
    assert_eq!(page.at(4, 10), [255, 0, 0, 255]);
    assert_eq!(page.at(15, 10), WHITE);
}

#[test]
fn a_soft_mask_makes_the_image_transparent_where_it_is_zero() {
    let smask = image("/Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", &[255, 0]);
    let colour = image(
        "/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R",
        &[0, 0, 255, 0, 0, 255],
    );
    let page = render(FILL_PAGE, IMAGE, &[colour, smask]);
    let opaque = page.at(3, 10);
    assert!(opaque[0] <= 8 && opaque[2] >= 247, "{opaque:?}");
    assert_eq!(page.at(17, 10), WHITE);
}
