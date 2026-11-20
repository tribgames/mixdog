//! Opening a document and walking its page tree: the failures of a file that is no document, the properties a page
//! inherits from its ancestors, the page box and rotation rules, the viewport, and a page count that disagrees with
//! the tree.

use mixdog_pdf::Obj;
use mixdog_pdf::document::{Document, Exception, OpenOptions, wrap_reason};

use crate::read_support::{build, open};

fn pages_tree(objects: &[(u32, &str)]) -> Vec<u8> {
    let mut all: Vec<(u32, Vec<u8>)> = vec![(1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec())];
    all.extend(objects.iter().map(|(n, body)| (*n, body.as_bytes().to_vec())));
    build(&all)
}

#[test]
fn text_that_is_not_a_document_is_an_invalid_structure() {
    let error = Document::open(b"just some text, not a document".to_vec(), &OpenOptions::default()).err().expect("text is no PDF");
    let exception = wrap_reason(&error);
    assert_eq!(exception.name, "InvalidPDFException");
    assert_eq!(exception.message, "Invalid PDF structure.");
}

#[test]
fn an_empty_file_says_its_size_is_zero() {
    let error = Document::open(Vec::new(), &OpenOptions::default()).err().expect("empty");
    assert_eq!(
        wrap_reason(&error),
        Exception { name: "InvalidPDFException", code: None, message: "The PDF file is empty, i.e. its size is zero bytes.".to_owned() }
    );
}

#[test]
fn a_page_inherits_boxes_and_rotation_from_the_nodes_above_it() {
    let bytes = pages_tree(&[
        (2, "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 3 /MediaBox [0 0 300 400] /Rotate 90 >>"),
        (3, "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 5 0 R] /Count 2 >>"),
        (4, "<< /Type /Page /Parent 3 0 R >>"),
        (5, "<< /Type /Page /Parent 3 0 R /MediaBox [0 0 100 50] /Rotate 0 >>"),
        (6, "<< /Type /Page /Parent 2 0 R /CropBox [50 50 500 500] /UserUnit 2 >>"),
    ]);
    let document = open(bytes);
    assert_eq!(document.num_pages(), 3);

    let inherited = document.page(0).expect("page 1");
    assert_eq!(inherited.view, [0.0, 0.0, 300.0, 400.0]);
    assert!(matches!(inherited.rotate, Obj::Num(n) if n == 90.0));
    let viewport = inherited.viewport(1.0);
    assert_eq!((viewport.width, viewport.height), (400.0, 300.0), "a quarter turn swaps the sides");

    let own = document.page(1).expect("page 2");
    assert_eq!(own.view, [0.0, 0.0, 100.0, 50.0]);
    assert!(matches!(own.rotate, Obj::Num(n) if n == 0.0));
    // Unrotated: the y axis is flipped and the origin moves to the top left corner.
    assert_eq!(own.viewport(1.0).transform, [1.0, 0.0, 0.0, -1.0, 0.0, 50.0]);
    assert_eq!(own.viewport(2.0).transform, [2.0, 0.0, 0.0, -2.0, 0.0, 100.0]);

    // The crop box is cut to the media box; a user unit multiplies the scale; the rotation is inherited.
    let cropped = document.page(2).expect("page 3");
    assert_eq!(cropped.view, [50.0, 50.0, 300.0, 400.0]);
    assert_eq!(cropped.user_unit, 2.0);
    let viewport = cropped.viewport(1.0);
    assert_eq!((viewport.width, viewport.height), (700.0, 500.0));
}

#[test]
fn a_page_without_a_usable_box_is_letter_size_and_odd_rotations_are_normalised() {
    let bytes = pages_tree(&[
        (2, "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>"),
        (3, "<< /Type /Page /Parent 2 0 R >>"),
        (4, "<< /Type /Page /Parent 2 0 R /MediaBox [10 10 10 90] /Rotate -90 >>"),
        (5, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /CropBox [200 200 300 300] /Rotate 450 >>"),
        (6, "<< /Type /Page /Parent 2 0 R /MediaBox [100 100 0 0] /Rotate 45 /UserUnit -3 >>"),
    ]);
    let document = open(bytes);
    let letter = document.page(0).expect("page 1");
    assert_eq!(letter.media_box, [0.0, 0.0, 612.0, 792.0]);

    let empty_box = document.page(1).expect("page 2");
    assert_eq!(empty_box.media_box, [0.0, 0.0, 612.0, 792.0], "a box without area is no box");
    assert!(matches!(empty_box.rotate, Obj::Num(n) if n == 270.0));

    let apart = document.page(2).expect("page 3");
    assert_eq!(apart.view, [0.0, 0.0, 100.0, 100.0], "a crop box that misses the media box is ignored");
    assert!(matches!(apart.rotate, Obj::Num(n) if n == 90.0));

    let odd = document.page(3).expect("page 4");
    assert_eq!(odd.media_box, [0.0, 0.0, 100.0, 100.0], "corners given in any order are normalised");
    assert!(matches!(odd.rotate, Obj::Num(n) if n == 0.0), "45 degrees is no rotation");
    assert_eq!(odd.user_unit, 1.0, "a user unit must be positive");
}

#[test]
fn the_pages_found_in_the_tree_win_over_a_wrong_count() {
    let bytes = pages_tree(&[
        (2, "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 5 >>"),
        (3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>"),
        (4, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 20 20] >>"),
    ]);
    let document = open(bytes);
    assert_eq!(document.num_pages(), 2);
    assert_eq!(document.page(1).expect("the second page").view, [0.0, 0.0, 20.0, 20.0]);
    assert!(document.page(2).is_err(), "there is no third page");
}
