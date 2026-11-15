//! SVG acceptance and dimensions recorded from the original Node product.
use mixdog_imaging::{decode, resize_image_buffer, ResizeOptions, DECODE_PIXEL_LIMIT};
use serde_json::Value;

#[test]
fn svg_buffers_match_the_recorded_node_dimensions_and_pixel_colours() {
    let rows: Vec<Value> = serde_json::from_str(include_str!("svg-reference.json")).unwrap();
    assert_eq!(rows.len(), 4);
    for row in rows {
        let bytes = row["svg"].as_str().unwrap().as_bytes();
        let decoded = decode(bytes, DECODE_PIXEL_LIMIT).unwrap();
        assert_eq!(u64::from(decoded.width), row["width"].as_u64().unwrap());
        assert_eq!(u64::from(decoded.height), row["height"].as_u64().unwrap());
        // Cairo and tiny-skia quantize premultiplied alpha differently by up to
        // two channel levels; the acceptance, dimensions and alpha stay exact.
        for (actual, expected) in decoded.raster.data[..4].iter().zip(row["firstPixel"].as_array().unwrap()) {
            assert!(actual.abs_diff(expected.as_u64().unwrap() as u8) <= 2, "{}", row["name"]);
        }
        let resized = resize_image_buffer(bytes, "png", ResizeOptions::default()).unwrap().unwrap();
        assert_eq!(resized.mime, row["mime"].as_str().unwrap());
        assert_eq!(u64::from(resized.dimensions.display_width), row["dimensions"]["displayWidth"].as_u64().unwrap());
        assert_eq!(u64::from(resized.dimensions.display_height), row["dimensions"]["displayHeight"].as_u64().unwrap());
    }
}
