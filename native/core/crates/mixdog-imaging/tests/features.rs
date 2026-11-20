//! What the image codec does for a caller: decode, detect, probe, re-encode and fit an image to the model's limits.

use mixdog_imaging::avif::{decode_avif, encode_avif};
use mixdog_imaging::encode::{encode_in_format, encode_jpeg};
use mixdog_imaging::resize::fit_inside;
use mixdog_imaging::{Branch, DECODE_PIXEL_LIMIT, ErrorClass, Format, Raster, ResizeOptions, decode, decoded_dimensions, probe, resize_image_buffer};

/// A `width` x `height` opaque RGB raster; `colour(x, y)` gives each pixel.
fn rgb(width: u32, height: u32, colour: impl Fn(u32, u32) -> [u8; 3]) -> Raster {
    let mut data = Vec::new();
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&colour(x, y));
        }
    }
    Raster { width, height, has_alpha: false, data }
}

fn solid(width: u32, height: u32, colour: [u8; 3]) -> Raster {
    rgb(width, height, |_, _| colour)
}

fn png(raster: &Raster) -> Vec<u8> {
    encode_in_format(raster, Format::Png).expect("png encodes")
}

fn pixel(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let at = ((y * width + x) * 4) as usize;
    [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
}

#[test]
fn every_format_is_recognised_by_its_first_bytes() {
    let picture = solid(8, 8, [10, 20, 30]);
    assert_eq!(Format::sniff(&png(&picture)), Some(Format::Png));
    assert_eq!(Format::sniff(&encode_jpeg(&picture, 80, 0)), Some(Format::Jpeg));
    assert_eq!(Format::sniff(&encode_in_format(&picture, Format::Webp).unwrap()), Some(Format::Webp));
    assert_eq!(Format::sniff(b"GIF89a...."), Some(Format::Gif));
    assert_eq!(Format::sniff(b"II*\0...."), Some(Format::Tiff));
    assert_eq!(Format::sniff(b"  <?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"), Some(Format::Svg));
    assert_eq!(Format::sniff(b"<html><body>not an image</body></html>"), None);
    assert_eq!(Format::sniff(b"plain text"), None);
}

#[test]
fn a_png_round_trips_pixel_for_pixel() {
    let picture = rgb(5, 3, |x, y| [(x * 40) as u8, (y * 80) as u8, 7]);
    let decoded = decode(&png(&picture), DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((decoded.width, decoded.height, decoded.format), (5, 3, Format::Png));
    assert!(!decoded.raster.has_alpha);
    assert_eq!(decoded.raster.data, picture.data);
}

#[test]
fn a_png_with_alpha_keeps_straight_colour_and_alpha() {
    let mut data = Vec::new();
    for alpha in [0u8, 64, 128, 255] {
        data.extend_from_slice(&[200, 100, 50, alpha]);
    }
    let raster = Raster { width: 4, height: 1, has_alpha: true, data: data.clone() };
    let decoded = decode(&png(&raster), DECODE_PIXEL_LIMIT).unwrap();
    assert!(decoded.raster.has_alpha);
    let back = decoded.raster.to_rgba();
    // Fully transparent pixels carry no colour; the others keep it exactly.
    assert_eq!(back[3], 0);
    assert_eq!(&back[4..], &data[4..]);
}

#[test]
fn a_jpeg_decodes_near_its_flat_colour_and_webp_lossless_is_exact_in_size() {
    let picture = solid(16, 16, [200, 40, 40]);
    let jpeg = decode(&encode_jpeg(&picture, 90, 0), DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((jpeg.width, jpeg.height, jpeg.format), (16, 16, Format::Jpeg));
    for (got, want) in jpeg.raster.to_rgba()[..3].iter().zip([200u8, 40, 40]) {
        assert!(got.abs_diff(want) <= 4, "{got} vs {want}");
    }
    let webp = decode(&encode_in_format(&picture, Format::Webp).unwrap(), DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((webp.width, webp.height, webp.format), (16, 16, Format::Webp));
}

#[test]
fn probe_and_decoded_dimensions_report_the_stored_size() {
    let bytes = png(&solid(37, 11, [1, 2, 3]));
    assert_eq!(probe(&bytes).unwrap(), (37, 11));
    assert_eq!(decoded_dimensions(&bytes).unwrap(), (37, 11));
}

#[test]
fn bytes_that_are_not_an_image_are_refused_as_invalid() {
    let error = decode(b"this is not an image at all", DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.class(), ErrorClass::Invalid);
    let truncated = png(&solid(20, 20, [9, 9, 9]));
    let error = decode(&truncated[..truncated.len() / 2], DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.class(), ErrorClass::Invalid);
}

#[test]
fn an_image_over_the_pixel_limit_is_refused_before_its_pixels_are_read() {
    let bytes = png(&solid(40, 30, [5, 5, 5]));
    // 1200 pixels against a limit of 1000.
    assert!(decode(&bytes, 1000).is_err());
    assert!(decode(&bytes, 1200).is_ok());
}

/// A JPEG with an EXIF APP1 segment (big endian) that holds the orientation tag.
fn jpeg_with_orientation(raster: &Raster, orientation: u8) -> Vec<u8> {
    let jpeg = encode_jpeg(raster, 85, 0);
    let mut exif = b"Exif\0\0MM\0*\0\0\0\x08".to_vec();
    exif.extend_from_slice(&[0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
    let length = (exif.len() + 2) as u16;
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&exif);
    out.extend_from_slice(&jpeg[2..]);
    out
}

#[test]
fn the_exif_orientation_is_reported_and_the_stored_size_is_not_rotated() {
    let bytes = jpeg_with_orientation(&solid(24, 8, [90, 90, 200]), 6);
    let decoded = decode(&bytes, DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!(decoded.orientation, 6);
    assert_eq!((decoded.width, decoded.height), (24, 8));
    assert_eq!(decode(&encode_jpeg(&solid(24, 8, [0; 3]), 85, 0), DECODE_PIXEL_LIMIT).unwrap().orientation, 1);
}

#[test]
fn svg_text_is_rasterised_at_its_declared_size_with_exact_fill_colour() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="#336699"/></svg>"##;
    let decoded = decode(svg, DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((decoded.width, decoded.height, decoded.format), (30, 20, Format::Svg));
    assert_eq!(pixel(&decoded.raster.to_rgba(), 30, 15, 10), [0x33, 0x66, 0x99, 255]);
    let resized = resize_image_buffer(svg, "svg", ResizeOptions::default()).unwrap().unwrap();
    assert_eq!(resized.mime, "image/png");
    // A picture with a short side under 200 is enlarged to 200, keeping its 3:2 aspect.
    assert_eq!((resized.dimensions.original_width, resized.dimensions.original_height), (30, 20));
    assert_eq!((resized.dimensions.display_width, resized.dimensions.display_height), (300, 200));
}

#[test]
fn an_svg_that_needs_no_resizing_is_still_handed_on_as_a_png() {
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#336699"/></svg>"##;
    let resized = resize_image_buffer(svg, "svg", ResizeOptions::default()).unwrap().unwrap();
    assert_eq!(resized.mime, "image/png");
    let back = decode(&resized.data, DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((back.width, back.height, back.format), (400, 300, Format::Png));
    assert_eq!(pixel(&back.raster.to_rgba(), 400, 200, 150), [0x33, 0x66, 0x99, 255]);
}

#[test]
fn malformed_svg_is_refused_as_invalid() {
    let error = decode(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect", DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.class(), ErrorClass::Invalid);
}

#[test]
fn an_image_that_already_fits_is_returned_unchanged() {
    let bytes = png(&solid(600, 300, [1, 2, 3]));
    let resized = resize_image_buffer(&bytes, "png", ResizeOptions::default()).unwrap().unwrap();
    assert_eq!(resized.branch, Branch::Original);
    assert_eq!(resized.data, bytes);
    assert_eq!((resized.dimensions.original_width, resized.dimensions.display_width), (600, 600));
}

#[test]
fn a_wide_image_is_fitted_inside_the_provider_box_keeping_its_aspect() {
    let bytes = png(&solid(3000, 1000, [40, 80, 120]));
    let resized = resize_image_buffer(&bytes, "png", ResizeOptions::default()).unwrap().unwrap();
    let dims = resized.dimensions;
    assert_eq!((dims.original_width, dims.original_height), (3000, 1000));
    // The provider box is 1568 wide and counted in whole patches, so the width lands on or just under it.
    assert!((1500..=1568).contains(&dims.display_width), "{}", dims.display_width);
    let ratio = f64::from(dims.display_width) / f64::from(dims.display_height);
    assert!((ratio - 3.0).abs() < 0.03, "aspect {ratio}");
    let back = decode(&resized.data, DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((back.width, back.height), (dims.display_width, dims.display_height));
    // A flat picture stays flat through resampling.
    assert_eq!(&back.raster.to_rgba()[..4], &[40, 80, 120, 255]);
}

#[test]
fn a_token_budget_too_small_for_the_picture_falls_back_to_a_smaller_jpeg() {
    let noisy = rgb(300, 300, |x, y| [(x * 7 + y * 13) as u8, (x * y) as u8, (x ^ y) as u8]);
    let bytes = png(&noisy);
    let options = ResizeOptions { max_tokens: 50, ..ResizeOptions::default() };
    let resized = resize_image_buffer(&bytes, "png", options).unwrap().unwrap();
    assert!(matches!(resized.branch, Branch::TokenJpeg | Branch::TokenFallback));
    assert_eq!(resized.mime, "image/jpeg");
    assert!(resized.data.len() < bytes.len());
}

#[test]
fn fitting_inside_a_box_keeps_the_aspect_and_never_enlarges_when_asked() {
    let picture = solid(200, 100, [10, 10, 10]);
    let smaller = fit_inside(&picture, 50, 50, true);
    assert_eq!((smaller.width, smaller.height), (50, 25));
    let kept = fit_inside(&picture, 400, 400, true);
    assert_eq!((kept.width, kept.height), (200, 100));
}

#[test]
fn an_avif_written_from_a_picture_reads_back_at_the_same_size_and_near_colour() {
    let picture = solid(32, 16, [220, 30, 30]);
    let bytes = encode_avif(&picture).expect("avif encodes");
    assert_eq!(Format::sniff(&bytes), Some(Format::Avif));
    assert_eq!(&bytes[4..12], b"ftypavif");
    let back = decode_avif(&bytes, DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((back.width, back.height), (32, 16));
    let rgba = back.raster.to_rgba();
    for (got, want) in rgba[..3].iter().zip([220u8, 30, 30]) {
        assert!(got.abs_diff(want) <= 12, "{got} vs {want}");
    }
}

#[test]
fn a_damaged_avif_is_an_invalid_image_not_a_panic() {
    let mut bytes = encode_avif(&solid(16, 16, [1, 2, 3])).unwrap();
    for cut in [bytes.len() / 2, 20] {
        let error = decode(&bytes[..cut], DECODE_PIXEL_LIMIT).unwrap_err();
        assert_eq!(error.class(), ErrorClass::Invalid);
    }
    let last = bytes.len() - 1;
    bytes[last / 2..last].fill(0xFF);
    // Damaged payload: either decodes to something of the stored size or fails as invalid.
    match decode(&bytes, DECODE_PIXEL_LIMIT) {
        Ok(decoded) => assert_eq!((decoded.width, decoded.height), (16, 16)),
        Err(error) => assert_eq!(error.class(), ErrorClass::Invalid),
    }
}

// ---- AVIF container properties ----
//
// The source is an AVIF this crate encodes; the property boxes of the HEIF container (`irot`, `imir`, `clap`, `colr`)
// are written into its `ipco` box and associated with the primary item in `ipma`, with the `iloc` offsets moved by
// the growth of the `meta` box. The decode of the patched file is compared with the decode of the unpatched one
// (the same coded picture), transformed by the rule of the property.

mod container {
    use std::sync::OnceLock;

    use super::*;

    fn be32(data: &[u8], at: usize) -> usize {
        u32::from_be_bytes(data[at..at + 4].try_into().unwrap()) as usize
    }

    /// `(kind, start, end)` of the boxes laid one after another in `data`.
    fn children(data: &[u8]) -> Vec<([u8; 4], usize, usize)> {
        let mut found = Vec::new();
        let mut at = 0;
        while at + 8 <= data.len() {
            let size = be32(data, at);
            assert!(size >= 8 && at + size <= data.len(), "box at {at} has size {size}");
            found.push((data[at + 4..at + 8].try_into().unwrap(), at, at + size));
            at += size;
        }
        found
    }

    fn boxed(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        [&((body.len() + 8) as u32).to_be_bytes()[..], kind, body].concat()
    }

    fn add(data: &mut [u8], at: usize, width: usize, delta: usize) {
        let value = match width {
            4 => be32(data, at) + delta,
            8 => u64::from_be_bytes(data[at..at + 8].try_into().unwrap()) as usize + delta,
            other => panic!("offset size {other}"),
        };
        data[at..at + width].copy_from_slice(&value.to_be_bytes()[8 - width..]);
    }

    /// `iloc` with every absolute offset moved by `delta`.
    fn shift_iloc(iloc: &mut [u8], delta: usize) {
        let body = 8;
        let version = iloc[body];
        let (offset_size, length_size) = ((iloc[body + 4] >> 4) as usize, (iloc[body + 4] & 15) as usize);
        let (base_size, index_size) = ((iloc[body + 5] >> 4) as usize, (iloc[body + 5] & 15) as usize);
        let (count, mut at) =
            if version < 2 { (u16::from_be_bytes([iloc[body + 6], iloc[body + 7]]) as usize, body + 8) } else { (be32(iloc, body + 6), body + 10) };
        for _ in 0..count {
            at += if version < 2 { 2 } else { 4 };
            if version >= 1 {
                at += 2;
            }
            at += 2;
            if base_size > 0 {
                add(iloc, at, base_size, delta);
                at += base_size;
            }
            let extents = u16::from_be_bytes([iloc[at], iloc[at + 1]]) as usize;
            at += 2;
            for _ in 0..extents {
                if version >= 1 {
                    at += index_size;
                }
                if base_size == 0 {
                    add(iloc, at, offset_size, delta);
                }
                at += offset_size + length_size;
            }
        }
    }

    /// `avif` with the property boxes `props` associated with its primary item.
    pub fn with_properties(avif: &[u8], props: &[Vec<u8>]) -> Vec<u8> {
        let (_, meta_start, meta_end) = *children(avif).iter().find(|c| &c.0 == b"meta").expect("meta");
        let meta_children = children(&avif[meta_start + 12..meta_end]);
        let inner = &avif[meta_start + 12..meta_end];
        let part = |kind: &[u8; 4]| *meta_children.iter().find(|c| &c.0 == kind).unwrap_or_else(|| panic!("no {}", String::from_utf8_lossy(kind)));
        let (_, p0, p1) = part(b"pitm");
        let pitm = &inner[p0 + 8..p1];
        let primary = if pitm[0] == 0 { u16::from_be_bytes([pitm[4], pitm[5]]) as u32 } else { be32(pitm, 4) as u32 };
        let (_, i0, i1) = part(b"iprp");
        let iprp = &inner[i0 + 8..i1];
        let prp_children = children(iprp);
        let find = |kind: &[u8; 4]| *prp_children.iter().find(|c| &c.0 == kind).unwrap_or_else(|| panic!("no {}", String::from_utf8_lossy(kind)));
        let (_, c0, c1) = find(b"ipco");
        let existing = children(&iprp[c0 + 8..c1]).len();
        let new_ipco = boxed(b"ipco", &[&iprp[c0 + 8..c1], &props.concat()[..]].concat());
        // ipma: the entries re-written with the new indices after the primary item's own.
        let (_, a0, a1) = find(b"ipma");
        let ipma = &iprp[a0 + 8..a1];
        let (version, wide) = (ipma[0], ipma[3] & 1 == 1);
        let mut rebuilt = ipma[..8].to_vec();
        let mut at = 8;
        for _ in 0..be32(ipma, 4) {
            let (id, id_len) = if version < 1 { (u16::from_be_bytes([ipma[at], ipma[at + 1]]) as u32, 2) } else { (be32(ipma, at) as u32, 4) };
            let count = ipma[at + id_len] as usize;
            let width = if wide { 2 } else { 1 };
            let list = &ipma[at + id_len + 1..at + id_len + 1 + count * width];
            rebuilt.extend_from_slice(&ipma[at..at + id_len]);
            if id == primary {
                rebuilt.push((count + props.len()) as u8);
                rebuilt.extend_from_slice(list);
                for n in 0..props.len() {
                    let index = (existing + 1 + n) as u16;
                    rebuilt.extend_from_slice(&if wide { index.to_be_bytes().to_vec() } else { vec![index as u8] });
                }
            } else {
                rebuilt.push(count as u8);
                rebuilt.extend_from_slice(list);
            }
            at += id_len + 1 + count * width;
        }
        let new_ipma = boxed(b"ipma", &rebuilt);
        let mut new_iprp_body = Vec::new();
        for (kind, start, end) in &prp_children {
            match kind {
                b"ipco" => new_ipco.iter().for_each(|b| new_iprp_body.push(*b)),
                b"ipma" => new_ipma.iter().for_each(|b| new_iprp_body.push(*b)),
                _ => new_iprp_body.extend_from_slice(&iprp[*start..*end]),
            }
        }
        let new_iprp = boxed(b"iprp", &new_iprp_body);
        let delta = new_iprp.len() - (i1 - i0);
        let mut new_meta_body = avif[meta_start + 8..meta_start + 12].to_vec();
        for (kind, start, end) in &meta_children {
            let mut piece = inner[*start..*end].to_vec();
            match kind {
                b"iprp" => piece = new_iprp.clone(),
                b"iloc" => shift_iloc(&mut piece, delta),
                _ => {}
            }
            new_meta_body.extend_from_slice(&piece);
        }
        [&avif[..meta_start], &boxed(b"meta", &new_meta_body)[..], &avif[meta_end..]].concat()
    }

    /// 16 x 8, colourful in both directions so a wrong transformation moves every pixel.
    fn source() -> &'static (Vec<u8>, Raster) {
        static SOURCE: OnceLock<(Vec<u8>, Raster)> = OnceLock::new();
        SOURCE.get_or_init(|| {
            let bytes = encode_avif(&rgb(16, 8, |x, y| [(x * 16) as u8, (y * 32) as u8, 255 - (x * 16) as u8])).expect("avif encodes");
            let base = decode_avif(&bytes, DECODE_PIXEL_LIMIT).expect("decodes").raster;
            (bytes, base)
        })
    }

    fn decoded(props: &[Vec<u8>]) -> Raster {
        let patched = with_properties(&source().0, props);
        decode_avif(&patched, DECODE_PIXEL_LIMIT).expect("the patched file decodes").raster
    }

    fn rgb_at(raster: &Raster, x: u32, y: u32) -> [u8; 3] {
        let at = ((y * raster.width + x) * 3) as usize;
        raster.data[at..at + 3].try_into().unwrap()
    }

    /// `raster` of `out_width` x `out_height` equals the base picture read through `place`.
    fn assert_is(raster: &Raster, out_width: u32, out_height: u32, place: impl Fn(u32, u32) -> (u32, u32)) {
        let base = &source().1;
        assert_eq!((raster.width, raster.height), (out_width, out_height));
        for y in 0..out_height {
            for x in 0..out_width {
                let (sx, sy) = place(x, y);
                assert_eq!(rgb_at(raster, x, y), rgb_at(base, sx, sy), "pixel {x},{y}");
            }
        }
    }

    #[test]
    fn a_patched_file_with_no_properties_decodes_as_the_original() {
        assert_is(&decoded(&[]), 16, 8, |x, y| (x, y));
    }

    #[test]
    fn irot_turns_the_picture_counter_clockwise_by_quarter_turns() {
        // One turn takes the right edge to the top: output (x, y) is the source at (w - 1 - y, x).
        assert_is(&decoded(&[boxed(b"irot", &[1])]), 8, 16, |x, y| (15 - y, x));
        assert_is(&decoded(&[boxed(b"irot", &[2])]), 16, 8, |x, y| (15 - x, 7 - y));
        assert_is(&decoded(&[boxed(b"irot", &[3])]), 8, 16, |x, y| (y, 7 - x));
        // The angle is the low two bits: 4 is no turn.
        assert_is(&decoded(&[boxed(b"irot", &[4])]), 16, 8, |x, y| (x, y));
    }

    #[test]
    fn imir_mirrors_the_picture_on_the_axis_it_names() {
        assert_is(&decoded(&[boxed(b"imir", &[0])]), 16, 8, |x, y| (x, 7 - y));
        assert_is(&decoded(&[boxed(b"imir", &[1])]), 16, 8, |x, y| (15 - x, y));
    }

    fn clap(values: [i32; 8]) -> Vec<u8> {
        boxed(b"clap", &values.iter().flat_map(|v| v.to_be_bytes()).collect::<Vec<u8>>())
    }

    #[test]
    fn clap_keeps_the_aperture_centred_or_moved_by_its_offset() {
        // 8 x 4 about the centre of 16 x 8: columns 4..12, rows 2..6.
        assert_is(&decoded(&[clap([8, 1, 4, 1, 0, 1, 0, 1])]), 8, 4, |x, y| (x + 4, y + 2));
        // The centre moved by (+2, -1): columns 6..14, rows 1..5.
        assert_is(&decoded(&[clap([8, 1, 4, 1, 2, 1, -1, 1])]), 8, 4, |x, y| (x + 6, y + 1));
    }

    #[test]
    fn transformations_apply_in_the_order_the_container_lists_them() {
        // Crop, then turn: 8 x 4 becomes 4 x 8.
        let crop_then_turn = decoded(&[clap([8, 1, 4, 1, 0, 1, 0, 1]), boxed(b"irot", &[1])]);
        assert_is(&crop_then_turn, 4, 8, |x, y| ((7 - y) + 4, x + 2));
        // Turn, then crop an 8 x 4 window out of the 8 x 16 result.
        let turn_then_crop = decoded(&[boxed(b"irot", &[1]), clap([8, 1, 4, 1, 0, 1, 0, 1])]);
        assert_is(&turn_then_crop, 8, 4, |x, y| (15 - (y + 6), x));
    }

    fn nclx(matrix: u8, full_range: bool) -> Vec<u8> {
        boxed(b"colr", &[b"nclx".as_slice(), &[0, 1, 0, 13, 0, matrix, if full_range { 0x80 } else { 0 }]].concat())
    }

    fn mean_difference(a: &Raster, b: &Raster) -> f64 {
        a.data.iter().zip(&b.data).map(|(p, q)| f64::from(p.abs_diff(*q))).sum::<f64>() / a.data.len() as f64
    }

    #[test]
    fn an_nclx_box_chooses_the_matrix_and_range_the_pixels_are_converted_with() {
        let base = &source().1;
        // The encoder writes BT.601 full range: naming exactly that changes nothing.
        assert_eq!(mean_difference(&decoded(&[nclx(6, true)]), base), 0.0);
        // Another matrix or a limited range reads the same samples as different colours.
        assert!(mean_difference(&decoded(&[nclx(1, true)]), base) > 1.0);
        assert!(mean_difference(&decoded(&[nclx(6, false)]), base) > 1.0);
    }

    /// A matrix/TRC display profile with sRGB primaries (D50 adapted) and the identity tone curve.
    fn linear_srgb_profile() -> Vec<u8> {
        let fixed = |v: f64| ((v * 65536.0).round() as i32).to_be_bytes();
        let xyz = |x: f64, y: f64, z: f64| [b"XYZ \0\0\0\0".as_slice(), &fixed(x), &fixed(y), &fixed(z)].concat();
        let tags: Vec<(&[u8; 4], Vec<u8>)> = vec![
            (b"wtpt", xyz(0.9642, 1.0, 0.8249)),
            (b"rXYZ", xyz(0.4360747, 0.2225045, 0.0139322)),
            (b"gXYZ", xyz(0.3850649, 0.7168786, 0.0971045)),
            (b"bXYZ", xyz(0.1430804, 0.0606169, 0.7141733)),
            (b"rTRC", b"curv\0\0\0\0\0\0\0\0".to_vec()),
            (b"gTRC", b"curv\0\0\0\0\0\0\0\0".to_vec()),
            (b"bTRC", b"curv\0\0\0\0\0\0\0\0".to_vec()),
        ];
        let table = 4 + tags.len() * 12;
        let mut data_at = 128 + table;
        let (mut table_bytes, mut payload) = (((tags.len()) as u32).to_be_bytes().to_vec(), Vec::new());
        for (kind, data) in &tags {
            table_bytes.extend_from_slice(*kind);
            table_bytes.extend_from_slice(&(data_at as u32).to_be_bytes());
            table_bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
            payload.extend_from_slice(data);
            data_at += data.len();
        }
        let mut header = vec![0u8; 128];
        header[8..12].copy_from_slice(&0x0210_0000u32.to_be_bytes());
        header[12..16].copy_from_slice(b"mntr");
        header[16..20].copy_from_slice(b"RGB ");
        header[20..24].copy_from_slice(b"XYZ ");
        header[36..40].copy_from_slice(b"acsp");
        header[68..72].copy_from_slice(&fixed(0.9642));
        header[72..76].copy_from_slice(&fixed(1.0));
        header[76..80].copy_from_slice(&fixed(0.8249));
        let mut profile = [header, table_bytes, payload].concat();
        let size = profile.len() as u32;
        profile[..4].copy_from_slice(&size.to_be_bytes());
        profile
    }

    #[test]
    fn an_icc_profile_takes_the_pixels_to_srgb() {
        let grey = encode_avif(&solid(16, 8, [128, 128, 128])).unwrap();
        let plain = decode_avif(&grey, DECODE_PIXEL_LIMIT).unwrap().raster;
        let profile = boxed(b"colr", &[b"prof".as_slice(), &linear_srgb_profile()].concat());
        let tagged = decode_avif(&with_properties(&grey, &[profile]), DECODE_PIXEL_LIMIT).unwrap().raster;
        // Light-linear 128/255 is 188 on the sRGB curve (1.055 * 0.502^(1/2.4) - 0.055 = 0.737).
        for (before, after) in plain.data.chunks_exact(3).zip(tagged.data.chunks_exact(3)) {
            assert!(before.iter().all(|v| v.abs_diff(128) <= 6), "{before:?}");
            assert!(after.iter().all(|v| v.abs_diff(188) <= 8), "{after:?}");
        }
    }
}

#[test]
fn an_hevc_picture_is_reported_as_invalid_with_the_decoder_sentence_a_caller_shows() {
    let heic = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic";
    assert_eq!(Format::sniff(heic), Some(Format::Avif));
    let error = resize_image_buffer(heic, "heic", ResizeOptions::default()).unwrap_err();
    assert_eq!(error.class(), ErrorClass::Invalid);
    assert!(error.message().starts_with("invalid or corrupt image data: heif: "), "{}", error.message());
    assert!(error.message().contains("HEVC"), "{}", error.message());
}

#[test]
fn every_decodable_format_leaves_the_resizer_as_a_type_a_provider_takes() {
    let picture = solid(600, 300, [40, 80, 120]);
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#285078"/></svg>"##.to_vec();
    // (input, media type of the output, format of the output bytes)
    let table: Vec<(&str, Vec<u8>, &str, Format)> = vec![
        ("png", png(&picture), "image/png", Format::Png),
        ("jpeg", encode_jpeg(&picture, 80, 0), "image/jpeg", Format::Jpeg),
        ("gif", encode_in_format(&picture, Format::Gif).unwrap(), "image/gif", Format::Gif),
        ("webp", encode_in_format(&picture, Format::Webp).unwrap(), "image/webp", Format::Webp),
        // The formats no model provider takes go on as the PNG of their pixels.
        ("tiff", encode_in_format(&picture, Format::Tiff).unwrap(), "image/png", Format::Png),
        ("svg", svg, "image/png", Format::Png),
        ("avif", encode_avif(&picture).unwrap(), "image/png", Format::Png),
    ];
    for (name, bytes, mime, format) in table {
        let resized = resize_image_buffer(&bytes, name, ResizeOptions::default()).unwrap().unwrap();
        assert_eq!(resized.mime, mime, "{name}");
        assert_eq!(Format::sniff(&resized.data), Some(format), "{name}: the bytes are what the type says");
        assert_eq!(format.media_type(), mime, "{name}");
        assert_eq!((resized.dimensions.display_width, resized.dimensions.display_height), (600, 300), "{name}");
    }
}

#[test]
fn each_format_names_its_own_media_type() {
    for (format, mime) in [
        (Format::Jpeg, "image/jpeg"),
        (Format::Png, "image/png"),
        (Format::Gif, "image/gif"),
        (Format::Webp, "image/webp"),
        (Format::Tiff, "image/tiff"),
        (Format::Svg, "image/svg+xml"),
        (Format::Avif, "image/avif"),
    ] {
        assert_eq!(format.media_type(), mime);
    }
}

#[test]
fn a_gzip_svg_is_read_and_a_gzip_bomb_is_refused_at_the_document_bound() {
    use std::io::Write;
    let gzip = |bytes: &[u8]| {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    };
    let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#336699"/></svg>"##;
    let decoded = decode(&gzip(svg), DECODE_PIXEL_LIMIT).unwrap();
    assert_eq!((decoded.format, decoded.width, decoded.height), (Format::Svg, 8, 6));
    // A few KiB of gzip that inflate to more than the 64 MiB a document may have.
    let mut bomb = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\">".to_vec();
    bomb.resize(mixdog_imaging::svg_limits::DOCUMENT_BYTES + 4096, b' ');
    let compressed = gzip(&bomb);
    assert!(compressed.len() < 256 * 1024, "{}", compressed.len());
    let error = decode(&compressed, DECODE_PIXEL_LIMIT).unwrap_err();
    assert_eq!(error.sentence(), mixdog_imaging::svg_limits::TOO_LARGE);
    assert_eq!(error.class(), ErrorClass::Invalid);
}

#[test]
fn an_svg_nested_past_the_depth_bound_is_refused_not_recursed_into() {
    let depth = mixdog_imaging::svg_limits::DEPTH + 50;
    let deep = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"4\" height=\"4\">{}{}</svg>", "<g>".repeat(depth), "</g>".repeat(depth));
    assert_eq!(decode(deep.as_bytes(), DECODE_PIXEL_LIMIT).unwrap_err().class(), ErrorClass::Invalid);
}

#[test]
fn file_extensions_name_the_codecs_formats_and_browsers_draw_all_but_tiff() {
    for (extension, format) in [
        ("png", Format::Png),
        ("JPG", Format::Jpeg),
        ("jpeg", Format::Jpeg),
        ("jfif", Format::Jpeg),
        ("gif", Format::Gif),
        ("webp", Format::Webp),
        ("tif", Format::Tiff),
        ("TIFF", Format::Tiff),
        ("svg", Format::Svg),
        ("avif", Format::Avif),
    ] {
        assert_eq!(Format::from_extension(extension), Some(format), "{extension}");
    }
    for extension in ["bmp", "heic", "txt", ""] {
        assert_eq!(Format::from_extension(extension), None, "{extension}");
    }
    assert_eq!(Format::browser_media_type("avif"), Some("image/avif"));
    assert_eq!(Format::browser_media_type("jpeg"), Some("image/jpeg"));
    assert_eq!(Format::browser_media_type("tiff"), None, "a browser does not draw TIFF");
    // Every format's own extensions lead back to it and to its media type.
    for format in Format::ALL {
        for extension in format.extensions() {
            assert_eq!(Format::from_extension(&extension[1..]), Some(format));
        }
        assert_eq!(Format::from_media_type(format.media_type()), Some(format));
    }
}

/// The desktop reads every image extension fact (media type, provider acceptance, browser drawing) from one generated
/// module; this renders it from the codec's table and fails when the committed file differs.
#[test]
fn the_desktop_image_table_is_rendered_from_the_codec() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../apps/desktop/src/shared/image-types.generated.ts");
    let committed = std::fs::read_to_string(path).expect("the generated desktop table").replace("\r\n", "\n");
    assert_eq!(committed, mixdog_imaging::format_table::typescript());
}
