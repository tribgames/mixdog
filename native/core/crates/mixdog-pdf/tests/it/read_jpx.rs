//! The JPEG 2000 reader's structure pass: the parameters of the main header, the boxes of a JP2 file, the tile-parts
//! a codestream holds, and what it refuses or tolerates in damaged input. The codestreams are assembled here from the
//! markers of ITU-T T.800: one 8-bit grey component, tiles of 8 x 8 samples, one decomposition level (two resolutions,
//! so two packets per tile), every packet empty.

use mixdog_pdf::codec::jpx::{self, markers::Progression};

fn be16(value: u16) -> [u8; 2] {
    value.to_be_bytes()
}

fn be32(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

/// A codestream of an image `width` samples wide and 8 high in tiles of 8 x 8, with the tile-parts of `tiles`.
fn codestream(width: u32, tiles: &[u16]) -> Vec<u8> {
    let mut out = vec![0xFF, 0x4F];
    // SIZ: Lsiz 41, Rsiz, Xsiz, Ysiz, XOsiz, YOsiz, XTsiz, YTsiz, XTOsiz, YTOsiz, Csiz, then Ssiz XRsiz YRsiz.
    out.extend([0xFF, 0x51]);
    out.extend(be16(41));
    out.extend(be16(0));
    for value in [width, 8, 0, 0, 8, 8, 0, 0] {
        out.extend(be32(value));
    }
    out.extend(be16(1));
    out.extend([7, 1, 1]);
    // COD: Lcod 12, Scod 0, LRCP, one layer, no multiple component transform, one level, 64 x 64 blocks, plain
    // block style, the reversible 5-3 transform.
    out.extend([0xFF, 0x52]);
    out.extend(be16(12));
    out.extend([0, 0]);
    out.extend(be16(1));
    out.extend([0, 1, 4, 4, 0, 1]);
    // QCD: no quantization with two guard bits, one exponent for each of the four subbands.
    out.extend([0xFF, 0x5C]);
    out.extend(be16(7));
    out.push(2 << 5);
    out.extend([0x48, 0x50, 0x50, 0x58]);
    for &tile in tiles {
        // SOT: Lsot 10, tile index, tile-part length (12 + SOD + two packets), part 0 of 1; then SOD and the packets.
        out.extend([0xFF, 0x90]);
        out.extend(be16(10));
        out.extend(be16(tile));
        out.extend(be32(16));
        out.extend([0, 1]);
        out.extend([0xFF, 0x93, 0x00, 0x00]);
    }
    out.extend([0xFF, 0xD9]);
    out
}

fn position_of(data: &[u8], marker: [u8; 2]) -> usize {
    data.windows(2).position(|w| w == marker).expect("marker present")
}

fn jp2(codestream: &[u8], codestream_box_length: Option<u32>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend(be32(12));
    out.extend(*b"jP  ");
    out.extend([0x0D, 0x0A, 0x87, 0x0A]);
    out.extend(be32(20));
    out.extend(*b"ftyp");
    out.extend(*b"jp2 ");
    out.extend(be32(0));
    out.extend(*b"jp2 ");
    out.extend(be32(8 + 22 + 15));
    out.extend(*b"jp2h");
    // ihdr: height, width, components, bits per component minus one, compression type 7, two flags.
    out.extend(be32(22));
    out.extend(*b"ihdr");
    out.extend(be32(8));
    out.extend(be32(8));
    out.extend(be16(1));
    out.extend([7, 7, 0, 0]);
    // colr: method 1 (enumerated), precedence, approximation, enumerated colour space 17 (grey scale).
    out.extend(be32(15));
    out.extend(*b"colr");
    out.extend([1, 0, 0]);
    out.extend(be32(17));
    out.extend(be32(codestream_box_length.unwrap_or(8 + codestream.len() as u32)));
    out.extend(*b"jp2c");
    out.extend_from_slice(codestream);
    out
}

#[test]
fn the_main_header_gives_the_image_geometry_and_the_coding_parameters() {
    let image = jpx::parse(&codestream(16, &[0, 1])).expect("a codestream");
    assert!(image.container.is_none(), "a bare codestream has no JP2 boxes");
    let siz = &image.codestream.siz;
    assert_eq!((siz.x0, siz.y0, siz.x1, siz.y1), (0, 0, 16, 8));
    assert_eq!((siz.tile_w, siz.tile_h, siz.tile_x0, siz.tile_y0), (8, 8, 0, 0));
    assert_eq!((siz.width(), siz.height()), (16, 8));
    assert_eq!(siz.comps.len(), 1);
    assert_eq!((siz.comps[0].precision, siz.comps[0].signed, siz.comps[0].dx, siz.comps[0].dy), (8, false, 1, 1));

    let main = &image.codestream.main;
    assert_eq!(main.progression, Progression::Lrcp);
    assert_eq!((main.layers, main.mct, main.sop, main.eph), (1, 0, false, false));
    let coding = &main.comps[0].coding;
    assert_eq!(coding.levels, 1);
    assert!(coding.reversible);
    assert_eq!(coding.style, 0);
    assert_eq!(main.comps[0].quant.guard, 2);
    assert_eq!(main.comps[0].quant.style, 0);

    assert_eq!(image.codestream.tile_count(), 2);
    assert!(image.codestream.has_tile(0) && image.codestream.has_tile(1));
    let tile = image.codestream.tile(0).expect("a tile").expect("present");
    assert_eq!(tile.packets.len(), 2, "one layer, two resolutions, one component");
}

#[test]
fn a_jp2_file_gives_its_boxes_and_its_codestream() {
    let data = jp2(&codestream(8, &[0]), None);
    let image = jpx::parse(&data).expect("a JP2 file");
    let info = image.container.expect("a container");
    assert_eq!(info.brand, Some(*b"jp2 "));
    let header = info.header.as_ref().expect("the image header box");
    assert_eq!((header.width, header.height, header.components, header.bpc, header.compression), (8, 8, 1, 7, 7));
    let colour = info.colour().expect("the colour box");
    assert_eq!((colour.method, colour.enumerated), (1, Some(17)));
    assert_eq!(info.codestream.end, data.len());
    assert_eq!(image.codestream.siz.width(), 8);
}

#[test]
fn a_codestream_box_of_length_zero_runs_to_the_end_of_the_file() {
    let data = jp2(&codestream(8, &[0]), Some(0));
    let image = jpx::parse(&data).expect("a JP2 file");
    assert_eq!(image.container.expect("a container").codestream.end, data.len());
    assert_eq!(image.codestream.tile_count(), 1);
}

#[test]
fn a_tile_the_codestream_leaves_out_is_absent() {
    let image = jpx::parse(&codestream(16, &[1])).expect("a codestream");
    assert!(!image.codestream.has_tile(0));
    assert!(image.codestream.has_tile(1));
    assert!(image.codestream.tile(0).expect("no failure").is_none());
}

#[test]
fn a_codestream_cut_short_is_read_as_far_as_it_goes() {
    let data = codestream(8, &[0]);
    let cut = &data[..data.len() - 3];
    let image = jpx::parse(cut).expect("the header and the tile start are there");
    assert!(image.codestream.truncated);
    assert!(!jpx::parse(&data).expect("whole").codestream.truncated);
}

#[test]
fn damaged_input_is_an_error() {
    assert!(jpx::parse(&[]).is_err());
    assert!(jpx::parse(b"not a jpeg 2000 file").is_err());
    let data = codestream(8, &[0]);

    let mut without_siz = data.clone();
    without_siz[2] = 0xFF;
    without_siz[3] = 0x52;
    assert!(jpx::parse(&without_siz).is_err(), "the size marker must follow the start of the codestream");

    let mut without_cod = data.clone();
    let cod = position_of(&without_cod, [0xFF, 0x52]);
    without_cod[cod + 1] = 0x64; // a comment marker now
    assert!(jpx::parse(&without_cod).is_err(), "the main header needs its coding style");

    let mut bad_tile = data.clone();
    let sot = position_of(&bad_tile, [0xFF, 0x90]);
    bad_tile[sot + 4..sot + 6].copy_from_slice(&be16(9));
    assert!(jpx::parse(&bad_tile).is_err(), "tile 9 is outside a grid of one tile");

    let mut unsigned_box = jp2(&data, None);
    unsigned_box[4] = b'x';
    assert!(jpx::parse(&unsigned_box).is_err(), "a JP2 file starts with its signature box");
}

#[test]
fn high_throughput_blocks_are_refused() {
    let mut data = codestream(8, &[0]);
    let cod = position_of(&data, [0xFF, 0x52]);
    data[cod + 12] |= 0x40;
    let error = jpx::parse(&data).err().expect("an error");
    assert!(error.message().contains("high-throughput"), "{error}");
}

#[test]
fn code_blocks_over_the_standard_limits_are_refused() {
    let cod = position_of(&codestream(8, &[0]), [0xFF, 0x52]);
    // Exponents are stored minus two: 9 is a width of 2^11, past the largest of 2^10.
    let mut wide = codestream(8, &[0]);
    wide[cod + 10] = 9;
    assert!(jpx::parse(&wide).is_err());
    // 2^10 by 2^4 is allowed alone but its area, 2^14, is past 2^12.
    let mut large = codestream(8, &[0]);
    large[cod + 10] = 8;
    assert!(jpx::parse(&large).is_err());
}

// ---- pixels ---------------------------------------------------------------------------------------------------------

use jpx::output::{self, Options};

use crate::read_support::{MqEncoder, pack_bits};

#[test]
fn a_tile_without_coded_data_decodes_to_the_mid_level_and_an_absent_tile_to_zero() {
    // Every coefficient is zero, so each sample is the level shift of an 8-bit unsigned component: 128.
    let whole = jpx::parse(&codestream(16, &[0, 1])).expect("a codestream");
    let decoded = output::decode(&whole, Options::default()).expect("decodes");
    assert_eq!((decoded.width(), decoded.height(), decoded.component_count()), (16, 8, 1));
    let pixels = decoded.to_pixels(4);
    assert_eq!((pixels.width, pixels.height, pixels.components), (16, 8, 1));
    assert!(pixels.data.iter().all(|&sample| sample == 128), "{:?}", pixels.data);

    // The second tile is left out: its samples stay 0.
    let partial = jpx::parse(&codestream(16, &[1])).expect("a codestream");
    let pixels = output::decode(&partial, Options::default()).expect("decodes").to_pixels(4);
    for row in pixels.data.chunks(16) {
        assert_eq!(&row[..8], &[0; 8]);
        assert_eq!(&row[8..], &[128; 8]);
    }
}

/// A 1 x 1 codestream whose only sample has the coefficient `5` (or `-5`), coded as T.800 prescribes: no wavelet
/// levels, one 1 x 1 code-block with three bit planes (so one clean-up pass, then a significance pass, a refinement
/// pass and a clean-up pass for each of the two lower planes: 7 passes) in a single codeword.
fn one_sample(negative: bool) -> Vec<u8> {
    // Contexts: 0 zero-coding with no significant neighbour (starts in state 4), 9 sign coding with no neighbours,
    // 14 first refinement without significant neighbours, 16 later refinements.
    let mut coder = MqEncoder::new(19, &[(0, 4), (17, 3), (18, 46)]);
    coder.encode(0, 1); // plane 2, clean-up: the sample becomes significant
    coder.encode(9, u8::from(negative)); // its sign (the sign context has no flip without neighbours)
    coder.encode(14, 0); // plane 1, refinement: bit 1 of 101
    coder.encode(16, 1); // plane 0, refinement: bit 0 of 101
    let block = coder.finish(false);
    assert!(block.len() < 32);
    // Packet header: non-empty, included in the first layer, 9 - 3 = 6 empty planes (tag tree: six 0 and a 1),
    // 7 passes (1111 00001), no Lblock increase, the length in 3 + floor(log2 7) = 5 bits.
    let header = pack_bits(&format!("1 1 0000001 111100001 0 {:05b}", block.len()));
    assert!(!header.contains(&0xFF));
    let packet = [header, block].concat();

    let mut out = vec![0xFF, 0x4F, 0xFF, 0x51];
    out.extend(41u16.to_be_bytes());
    out.extend(0u16.to_be_bytes());
    for value in [1u32, 1, 0, 0, 1, 1, 0, 0] {
        out.extend(value.to_be_bytes());
    }
    out.extend(1u16.to_be_bytes());
    out.extend([7, 1, 1]);
    // COD: LRCP, one layer, no colour transform, zero levels, 64 x 64 blocks, reversible.
    out.extend([0xFF, 0x52, 0, 12, 0, 0, 0, 1, 0, 0, 4, 4, 0, 1]);
    // QCD: no quantization, two guard bits, exponent 8 for the one subband: Mb = 2 + 8 - 1 = 9 planes.
    out.extend([0xFF, 0x5C, 0, 4, 2 << 5, 8 << 3]);
    out.extend([0xFF, 0x90, 0, 10, 0, 0]);
    out.extend(((12 + 2 + packet.len()) as u32).to_be_bytes());
    out.extend([0, 1, 0xFF, 0x93]);
    out.extend(packet);
    out.extend([0xFF, 0xD9]);
    out
}

#[test]
fn a_coded_coefficient_is_added_to_or_taken_from_the_level_shift() {
    for (negative, expected) in [(false, 133u8), (true, 123)] {
        let image = jpx::parse(&one_sample(negative)).expect("a codestream");
        let pixels = output::decode(&image, Options::default()).expect("decodes").to_pixels(4);
        assert_eq!(pixels.data, [expected], "negative: {negative}");
    }
}

// ---- a lossless round trip -------------------------------------------------------------------------------------------

/// An 8 x 8 test plane with gradients and detail, so that every band has several non-zero coefficients.
fn plane(seed: u32) -> Vec<Vec<u8>> {
    (0..8u32)
        .map(|y| (0..8u32).map(|x| (20 + (17 * x + 9 * y + (x * y + seed) % 5 * 11 + seed * 23) % 200) as u8).collect())
        .collect()
}

#[test]
fn one_wavelet_level_over_a_tile_with_many_coefficients_per_block_decodes_to_the_input() {
    let input = plane(0);
    let image = jpx::parse(&crate::read_jpx_encode::encode(&[input.clone()])).expect("a codestream");
    assert_eq!(image.codestream.main.comps[0].coding.levels, 1);
    let pixels = output::decode(&image, Options::default()).expect("decodes").to_pixels(4);
    assert_eq!((pixels.width, pixels.height, pixels.components), (8, 8, 1));
    assert_eq!(pixels.data, input.concat());
}

#[test]
fn three_components_with_the_reversible_colour_transform_decode_to_the_input() {
    let input = [plane(1), plane(2), plane(3)];
    let image = jpx::parse(&crate::read_jpx_encode::encode(&input)).expect("a codestream");
    assert_eq!(image.codestream.main.mct, 1);
    let pixels = output::decode(&image, Options::default()).expect("decodes").to_pixels(4);
    assert_eq!((pixels.width, pixels.height, pixels.components), (8, 8, 3));
    let interleaved: Vec<u8> =
        (0..64).flat_map(|i| [input[0].concat()[i], input[1].concat()[i], input[2].concat()[i]]).collect();
    assert_eq!(pixels.data, interleaved);
}

// ---- several levels, layers, precincts and the irreversible transform ------------------------------------------------

use crate::read_jpx_encode::{Settings, encode_with, irreversible_bound};

/// A 32 x 32 plane with gradients and detail.
fn large_plane(seed: u32) -> Vec<Vec<u8>> {
    (0..32u32)
        .map(|y| (0..32u32).map(|x| (20 + (17 * x + 9 * y + (x * y + seed) % 5 * 11 + seed * 23) % 200) as u8).collect())
        .collect()
}

fn decoded(settings: Settings, input: &[Vec<Vec<u8>>]) -> (Vec<u8>, jpx::Image) {
    let image = jpx::parse(&encode_with(input, settings)).expect("a codestream");
    let pixels = output::decode(&image, Options::default()).expect("decodes").to_pixels(4);
    (pixels.data, image)
}

#[test]
fn two_and_three_wavelet_levels_decode_to_the_input() {
    let input = [large_plane(1)];
    for levels in [2usize, 3] {
        let (pixels, image) = decoded(Settings::reversible(levels), &input);
        assert_eq!(image.codestream.main.comps[0].coding.levels as usize, levels);
        assert_eq!(pixels, input[0].concat(), "{levels} levels");
    }
}

#[test]
fn quality_layers_and_small_precincts_decode_to_the_input() {
    let input = [large_plane(2), large_plane(3), large_plane(4)];
    for layers in [1usize, 3] {
        let settings = Settings { layers, precincts: true, ..Settings::reversible(2) };
        let (pixels, image) = decoded(settings, &input);
        assert_eq!(image.codestream.main.layers as usize, layers);
        let interleaved: Vec<u8> =
            (0..1024).flat_map(|i| [input[0].concat()[i], input[1].concat()[i], input[2].concat()[i]]).collect();
        assert_eq!(pixels, interleaved, "{layers} layers");
    }
}

#[test]
fn the_irreversible_transform_is_within_what_the_quantization_step_allows() {
    // Every coefficient is quantized with the step 2^-3, so each is wrong by less than one step; the synthesis is
    // linear, so a pixel is wrong by less than the step times the sum of the absolute responses of all coefficients at
    // that pixel (computed from the synthesis itself), and the output is rounded to a whole level.
    let input = [large_plane(5)];
    let bound = irreversible_bound(32, 32, 2);
    assert!(bound < 3.0, "the bound is a small one: {bound}");
    let settings = Settings { irreversible: true, ..Settings::reversible(2) };
    let (pixels, image) = decoded(settings, &input);
    assert!(!image.codestream.main.comps[0].coding.reversible);
    let worst = pixels.iter().zip(input[0].concat()).map(|(&a, b)| (i32::from(a) - i32::from(b)).abs()).max().unwrap();
    assert!(f64::from(worst) <= bound.floor(), "worst error {worst}, bound {bound}");
}

// ---- every coding variant of the decoder -------------------------------------------------------------------------------

use crate::read_jpx_encode::{BYPASS, Packed, PREDICT, RESET, SEGSYM, TERMALL, VSC, encode_samples, synthesis_error};

/// A plane of `rows` x `columns` samples of `precision` bits with gradients and detail (signed ones centred on 0).
fn wave(rows: usize, columns: usize, seed: usize, precision: u32, signed: bool) -> Vec<Vec<i32>> {
    (0..rows)
        .map(|y| {
            (0..columns)
                .map(|x| {
                    let base = (17 * x + 9 * y + (x * y + seed) % 5 * 11 + seed * 23) % 200 + 20;
                    let v = if precision >= 8 { (base << (precision - 8)) + (x * y + seed) % (1 << (precision - 8)) } else { base >> (8 - precision) };
                    v as i32 - if signed { 1 << (precision - 1) } else { 0 }
                })
                .collect()
        })
        .collect()
}

/// The 8-bit interleaved pixels the reader delivers for components of the given precision.
fn delivered(planes: &[Vec<Vec<i32>>], precision: u32, signed: bool) -> Vec<u8> {
    let (rows, columns) = (planes[0].len(), planes[0][0].len());
    let reduce = |v: i32| -> u8 {
        let v = i64::from(v);
        (if precision > 8 { v >> (precision - 8) } else if precision < 8 { v * 255 / ((1i64 << precision) - 1) } else { v }).clamp(0, 255) as u8
            * u8::from(!signed || v >= 0)
    };
    (0..rows).flat_map(|y| (0..columns).flat_map(move |x| planes.iter().map(move |p| p[y][x]))).map(reduce).collect()
}

fn decode_samples(planes: &[Vec<Vec<i32>>], settings: &Settings) -> (Vec<u8>, jpx::Image) {
    let image = jpx::parse(&encode_samples(planes, settings)).expect("a codestream");
    let pixels = output::decode(&image, Options::default()).expect("decodes").to_pixels(4);
    (pixels.data, image)
}

fn lossless(planes: &[Vec<Vec<i32>>], settings: &Settings) -> jpx::Image {
    let (pixels, image) = decode_samples(planes, settings);
    assert_eq!(pixels, delivered(planes, settings.precision, settings.signed));
    image
}

fn three(rows: usize, columns: usize) -> Vec<Vec<Vec<i32>>> {
    (1..=3).map(|seed| wave(rows, columns, seed, 8, false)).collect()
}

#[test]
fn several_code_blocks_per_band_are_found_through_the_tag_trees() {
    // 8 x 8 blocks over bands of up to 32 x 16 samples: grids of blocks several tag-tree levels deep, blocks never
    // included (all zero) mixed with blocks first included in the second layer.
    for layers in [1, 3] {
        let mut plane = wave(32, 64, 4, 8, false);
        for row in plane.iter_mut().take(16) {
            row[..16].fill(90); // a flat corner: its blocks have no coded coefficients
        }
        let settings = Settings { block: Some(3), layers, ..Settings::reversible(2) };
        let image = lossless(&[plane], &settings);
        let tile = image.codestream.tile(0).unwrap().unwrap();
        let blocks: usize = tile.components[0].resolutions.iter().flat_map(|r| &r.bands).map(|b| b.precincts[0].blocks.len()).sum();
        assert!(blocks > 20, "{blocks} code-blocks");
        assert!(tile.components[0].resolutions[2].bands[0].precincts[0].cw > 3);
    }
}

#[test]
fn every_code_block_style_decodes_to_the_input() {
    let input = [wave(32, 32, 6, 8, false)];
    let styles = [BYPASS, RESET, TERMALL, VSC, PREDICT, SEGSYM, BYPASS | TERMALL, RESET | SEGSYM | VSC, 0x3F];
    for style in styles {
        let settings = Settings { block: Some(4), style, ..Settings::reversible(1) };
        let image = lossless(&input, &settings);
        assert_eq!(image.codestream.main.comps[0].coding.style, style);
        let tile = image.codestream.tile(0).unwrap().unwrap();
        let most = tile.components[0].resolutions.iter().flat_map(|r| &r.bands).flat_map(|b| &b.precincts[0].blocks).map(|b| b.segments.len()).max().unwrap();
        if style & TERMALL != 0 {
            assert!(most > 10, "style {style:#x}: {most} segments");
        } else if style & BYPASS != 0 {
            assert!(most > 3, "style {style:#x}: {most} segments");
        } else {
            assert_eq!(most, 1, "style {style:#x}");
        }
    }
}

#[test]
fn the_five_progression_orders_and_progression_changes_read_every_packet() {
    let input = three(32, 32);
    for progression in 0..5u8 {
        let settings = Settings { progression, layers: 2, precincts: true, ..Settings::reversible(2) };
        let image = lossless(&input, &settings);
        let tile = image.codestream.tile(0).unwrap().unwrap();
        assert!(!tile.truncated, "progression {progression}");
        assert_eq!(tile.packets.len(), 2 * 3 * (1 + 1 + 4), "progression {progression}: layers, components, precincts");
    }
    // Resolutions 0 and 1 first in RLCP, then everything in CPRL (the packets already read are not read again).
    let settings = Settings { layers: 2, precincts: true, poc: vec![[0, 0, 2, 2, 3, 1], [0, 0, 2, 3, 3, 4]], ..Settings::reversible(2) };
    let image = lossless(&input, &settings);
    assert_eq!(image.codestream.main.pocs.len(), 2);
    assert!(!image.codestream.tile(0).unwrap().unwrap().truncated);
}

#[test]
fn start_of_packet_and_end_of_packet_header_markers_are_skipped() {
    let input = three(32, 32);
    let settings = Settings { sop: true, eph: true, layers: 2, ..Settings::reversible(2) };
    let image = lossless(&input, &settings);
    assert!(image.codestream.main.sop && image.codestream.main.eph);
}

#[test]
fn packet_headers_may_be_packed_in_the_main_header_or_the_tile_part_headers() {
    let input = three(32, 32);
    for packed in [Packed::Main, Packed::Tile] {
        for eph in [false, true] {
            let settings = Settings { packed, eph, tile: Some((16, 16)), parts: 2, layers: 2, ..Settings::reversible(2) };
            let image = lossless(&input, &settings);
            assert_eq!(image.codestream.tile_count(), 4);
            assert_eq!(image.codestream.tile_part_count(0), 2);
        }
    }
}

#[test]
fn tiles_and_tile_parts_may_come_in_any_order_and_carry_length_markers() {
    let input = three(32, 32);
    for interleave in [false, true] {
        let settings = Settings { tile: Some((16, 16)), parts: 3, interleave, side_markers: true, layers: 2, ..Settings::reversible(2) };
        let image = lossless(&input, &settings);
        let stream = &image.codestream;
        assert_eq!(stream.tlm.len(), 4 * 3);
        assert_eq!(stream.comments, [vec![0, 1, b'j', b'p', b'x']]);
        assert_eq!(stream.crg.as_ref().map(Vec::len), Some(12));
        assert_eq!(stream.tile_part_count(3), 3);
        let lengths = stream.packet_lengths(0);
        let tile = stream.tile(0).unwrap().unwrap();
        assert_eq!(lengths.len(), tile.packets.len());
        assert!(lengths.iter().zip(&tile.packets).all(|(&l, p)| l >= p.data_len));
    }
}

#[test]
fn components_with_their_own_levels_styles_and_sampling_decode_to_the_input() {
    // COC and QCC: component 1 has three levels and bypass, component 2 one level and reset coding.
    let input = three(32, 32);
    let settings = Settings { components: vec![(2, 0), (3, BYPASS), (1, RESET)], ..Settings::reversible(2) };
    let image = lossless(&input, &settings);
    let levels: Vec<u8> = image.codestream.main.comps.iter().map(|c| c.coding.levels).collect();
    assert_eq!(levels, [2, 3, 1]);
    // Chroma at half size in both directions, replicated onto the grid of the first component.
    let planes = vec![wave(32, 32, 1, 8, false), wave(16, 16, 2, 8, false), wave(16, 16, 3, 8, false)];
    let settings = Settings { subsampling: vec![(1, 1), (2, 2), (2, 2)], ..Settings::reversible(2) };
    let (pixels, _) = decode_samples(&planes, &settings);
    let expected: Vec<u8> = (0..32).flat_map(|y| (0..32).flat_map({ let planes = &planes; move |x| [planes[0][y][x], planes[1][y / 2][x / 2], planes[2][y / 2][x / 2]] })).map(|v| v as u8).collect();
    assert_eq!(pixels, expected);
}

#[test]
fn precisions_and_signed_samples_are_delivered_as_eight_bit_pixels() {
    for (precision, signed) in [(12u32, false), (4, false), (8, true), (1, false)] {
        let input = [wave(16, 16, 7, precision, signed)];
        let settings = Settings { precision, signed, ..Settings::reversible(2) };
        lossless(&input, &settings);
    }
}

#[test]
fn a_region_of_interest_shift_is_taken_out_again() {
    let input = three(32, 32);
    let settings = Settings { roi: true, ..Settings::reversible(2) };
    let image = lossless(&input, &settings);
    assert!(image.codestream.main.comps.iter().all(|c| c.roi_shift == 12));
}

/// The error of a pixel of three components with the irreversible colour transform: each is wrong by the synthesis error
/// `e`; red is luma plus 1.402 times Cr, green luma less 0.344 Cb and 0.714 Cr, blue luma plus 1.772 Cb, so the sum of
/// the factors of the worst, blue, is 2.772; and half a level for the rounding.
fn colour_bound(e: f64) -> f64 {
    2.772 * e + 0.5
}

fn worst_error(pixels: &[u8], expected: &[u8]) -> f64 {
    f64::from(pixels.iter().zip(expected).map(|(&a, &b)| (i32::from(a) - i32::from(b)).abs()).max().unwrap())
}

#[test]
fn the_irreversible_colour_transform_and_derived_quantization_stay_within_their_bounds() {
    // Three 32 x 32 components with two levels, exponents for every band, with the irreversible colour transform.
    let input = three(32, 32);
    let expected = delivered(&input, 8, false);
    let settings = Settings { irreversible: true, ..Settings::reversible(2) };
    let (pixels, image) = decode_samples(&input, &settings);
    assert_eq!(image.codestream.main.mct, 1);
    let bound = colour_bound(synthesis_error(32, 32, 2, 8, false));
    assert!(worst_error(&pixels, &expected) <= bound.floor(), "bound {bound}");
    // A second size and level combination, 16 rows of 64 samples over three levels, with the steps derived from the
    // LL step (E.5): a larger step in the finer bands makes the bound larger.
    let wide: Vec<_> = (1..=3).map(|seed| wave(16, 64, seed, 8, false)).collect();
    let settings = Settings { irreversible: true, derived: true, ..Settings::reversible(3) };
    let (pixels, image) = decode_samples(&wide, &settings);
    assert_eq!(image.codestream.main.comps[0].quant.style, 1);
    let bound = colour_bound(synthesis_error(16, 64, 3, 8, true));
    let worst = worst_error(&pixels, &delivered(&wide, 8, false));
    assert!(worst <= bound.floor(), "worst error {worst}, bound {bound}");
    // The same without the colour transform: a single component.
    let single = [wave(64, 16, 9, 8, false)];
    let settings = Settings { irreversible: true, derived: true, ..Settings::reversible(3) };
    let (pixels, _) = decode_samples(&single, &settings);
    let bound = synthesis_error(64, 16, 3, 8, true) + 0.5;
    let worst = worst_error(&pixels, &delivered(&single, 8, false));
    assert!(worst <= bound.floor(), "worst error {worst}, bound {bound}");
}

// ---- geometry: odd sizes, offsets, several tiles ------------------------------------------------------------------------

use crate::read_jpx_encode::general_bound;

#[test]
fn odd_sizes_and_image_and_tile_offsets_decode_to_the_input() {
    // (rows, columns, levels, image origin, tile size, tile origin): single samples, one line, odd sizes at odd offsets,
    // and an image cut into tiles of odd sizes from a tile origin that is not the image origin.
    let cases = [
        (13, 11, 2, (0, 0), None, (0, 0)),
        (13, 11, 2, (3, 2), None, (0, 0)),
        (1, 9, 2, (0, 0), None, (0, 0)),
        (9, 1, 1, (1, 1), None, (0, 0)),
        (1, 1, 1, (0, 0), None, (0, 0)),
        (1, 1, 1, (1, 1), None, (0, 0)),
        (7, 6, 3, (5, 7), None, (0, 0)),
        (13, 15, 2, (3, 2), Some((6, 5)), (1, 0)),
    ];
    for (n, (rows, columns, levels, origin, tile, tile_origin)) in cases.into_iter().enumerate() {
        let input = [wave(rows, columns, n + 1, 8, false)];
        let settings = Settings { origin, tile, tile_origin, ..Settings::reversible(levels) };
        let image = lossless(&input, &settings);
        assert_eq!((image.codestream.siz.x0 as usize, image.codestream.siz.y0 as usize), origin, "case {n}");
        if tile.is_some() {
            assert_eq!(image.codestream.tile_count(), 9);
        }
    }
    // Three components with the colour transform, over odd tiles.
    let input: Vec<_> = (1..=3).map(|seed| wave(13, 15, seed, 8, false)).collect();
    lossless(&input, &Settings { origin: (3, 2), tile: Some((6, 5)), tile_origin: (1, 0), ..Settings::reversible(2) });
    // Chroma at half the size, rounded up, in an image of odd size.
    let planes = vec![wave(13, 15, 1, 8, false), wave(7, 8, 2, 8, false), wave(7, 8, 3, 8, false)];
    let settings = Settings { subsampling: vec![(1, 1), (2, 2), (2, 2)], ..Settings::reversible(1) };
    let (pixels, _) = decode_samples(&planes, &settings);
    let expected: Vec<u8> = (0..13)
        .flat_map(|y| (0..15).flat_map({ let planes = &planes; move |x| [planes[0][y][x], planes[1][y / 2][x / 2], planes[2][y / 2][x / 2]] }))
        .map(|v| v as u8)
        .collect();
    assert_eq!(pixels, expected);
}

#[test]
fn the_irreversible_transform_over_odd_sizes_and_offsets_stays_within_its_bound() {
    // A line of one sample at an odd position is halved by the synthesis (T.800 F.3.6, for the 9-7 as for the 5-3): the
    // cases of one row or column at an odd offset are in the list.
    for (n, (rows, columns, levels, origin)) in [(13, 11, 2, (3, 2)), (1, 9, 2, (0, 0)), (9, 1, 1, (0, 0)), (10, 7, 1, (1, 0)), (1, 1, 1, (1, 1)), (9, 1, 1, (1, 0)), (1, 9, 1, (0, 1))].into_iter().enumerate() {
        let input = [wave(rows, columns, n + 4, 8, false)];
        let settings = Settings { irreversible: true, origin, ..Settings::reversible(levels) };
        let (pixels, _) = decode_samples(&input, &settings);
        let bound = general_bound(rows, columns, levels, origin);
        let worst = worst_error(&pixels, &delivered(&input, 8, false));
        assert!(worst <= bound.floor(), "case {n}: worst error {worst}, bound {bound}");
    }
}

// ---- tile headers, packed headers, length markers, many components ---------------------------------------------------------

#[test]
fn a_tile_part_header_may_override_the_coding_style_and_the_progression_of_its_tile() {
    // The main header says two levels, and the second component three; tile 1 says one level for all of them in its own
    // COD (the main header's COC no longer applies to it) and a progression change of its own.
    let input: Vec<_> = (1..=3).map(|seed| wave(32, 32, seed, 8, false)).collect();
    let settings = Settings {
        tile: Some((16, 32)),
        components: vec![(2, 0), (3, 0), (2, 0)],
        tile_levels: vec![None, Some(1)],
        tile_poc: vec![[0, 0, 1, 2, 3, 4], [0, 0, 2, 3, 3, 0]],
        layers: 2,
        ..Settings::reversible(2)
    };
    let image = lossless(&input, &settings);
    let stream = &image.codestream;
    let tile0 = stream.tile_params(0).unwrap();
    let tile1 = stream.tile_params(1).unwrap();
    assert_eq!(tile0.comps.iter().map(|c| c.coding.levels).collect::<Vec<_>>(), [2, 3, 2]);
    assert_eq!(tile1.comps.iter().map(|c| c.coding.levels).collect::<Vec<_>>(), [1, 1, 1]);
    assert_eq!(tile1.pocs.len(), 2);
    assert!(tile0.pocs.is_empty());
}

#[test]
fn packed_headers_in_several_markers_and_open_ended_and_listed_tile_parts_are_read() {
    let input = three(32, 32);
    for packed in [Packed::Main, Packed::Tile] {
        let settings = Settings { packed, split_markers: true, tile: Some((16, 16)), parts: 2, layers: 2, ..Settings::reversible(2) };
        lossless(&input, &settings);
    }
    // The last tile-part has the length 0: it runs to the end.
    let settings = Settings { open_ended: true, tile: Some((16, 16)), parts: 2, ..Settings::reversible(2) };
    lossless(&input, &settings);
    // The three forms of the tile-part length marker.
    for tlm_variant in 0..3 {
        let settings = Settings { side_markers: true, tlm_variant, tile: Some((16, 16)), ..Settings::reversible(2) };
        let image = lossless(&input, &settings);
        assert_eq!(image.codestream.tlm.len(), 4, "variant {tlm_variant}");
        assert_eq!(image.codestream.tlm.iter().map(|e| e.tile.is_some()).collect::<Vec<_>>(), vec![tlm_variant != 1; 4]);
    }
}

#[test]
fn more_than_256_components_use_two_byte_component_numbers() {
    let input: Vec<_> = (0..257).map(|k| wave(4, 4, k, 8, false)).collect();
    let settings = Settings { roi: true, poc: vec![[0, 0, 1, 2, 257, 0], [0, 0, 1, 3, 257, 1]], components: vec![(1, 0); 1].into_iter().chain(std::iter::repeat((2, 0)).take(256)).collect(), ..Settings::reversible(2) };
    let (pixels, image) = decode_samples(&input, &settings);
    assert_eq!(image.codestream.siz.comps.len(), 257);
    assert_eq!(image.codestream.main.comps[0].coding.levels, 1);
    assert_eq!(image.codestream.main.comps[256].roi_shift, 12);
    assert_eq!(image.codestream.main.pocs.len(), 2);
    // Only the first four components are delivered.
    assert_eq!(pixels, delivered(&input[..4], 8, false));
}

// ---- the JP2 container: palettes, channel definitions, colour spaces ------------------------------------------------------

use output::ColourSpace;

fn jp2_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = be32(8 + body.len() as u32).to_vec();
    out.extend(kind);
    out.extend_from_slice(body);
    out
}

fn jp2_file(stream: &[u8], children: &[Vec<u8>], components: u16) -> Vec<u8> {
    let mut ihdr = Vec::new();
    ihdr.extend(be32(8));
    ihdr.extend(be32(8));
    ihdr.extend(be16(components));
    ihdr.extend([7, 7, 0, 0]);
    let mut header = jp2_box(b"ihdr", &ihdr);
    header.extend(children.concat());
    let mut out = jp2_box(b"jP  ", &[0x0D, 0x0A, 0x87, 0x0A]);
    out.extend(jp2_box(b"ftyp", b"jp2 \0\0\0\0jp2 "));
    out.extend(jp2_box(b"jp2h", &header));
    out.extend(jp2_box(b"jp2c", stream));
    out
}

fn colr(enumerated: u32) -> Vec<u8> {
    let mut body = vec![1, 0, 0];
    body.extend(be32(enumerated));
    jp2_box(b"colr", &body)
}

fn pixels_of(file: &[u8], options: Options) -> (Vec<u8>, output::DecodedImage) {
    let image = jpx::parse(file).expect("a JP2 file");
    let decoded = output::decode(&image, options).expect("decodes");
    (decoded.to_pixels(4).data, decoded)
}

#[test]
fn a_palette_turns_the_indices_of_a_component_into_colour_channels() {
    let indices: Vec<Vec<i32>> = (0..8).map(|y| (0..8).map(|x| ((x + y) % 4) as i32).collect()).collect();
    let stream = encode_samples(&[indices.clone()], &Settings::reversible(1));
    let palette = [[11u8, 50, 200], [22, 51, 199], [33, 52, 198], [44, 53, 197]];
    let mut pclr = be16(4).to_vec();
    pclr.extend([3, 7, 7, 7]);
    pclr.extend(palette.concat());
    let cmap: Vec<u8> = (0..3u8).flat_map(|column| [0, 0, 1, column]).collect();
    let file = jp2_file(&stream, &[colr(16), jp2_box(b"pclr", &pclr), jp2_box(b"cmap", &cmap)], 1);
    let (pixels, decoded) = pixels_of(&file, Options::default());
    let expected: Vec<u8> = indices.iter().flatten().flat_map(|&i| palette[i as usize]).collect();
    assert_eq!(pixels, expected);
    assert_eq!(decoded.colour, ColourSpace::Srgb);
    // A reader that wants the indices (an indexed PDF colour space) leaves the palette alone.
    let (pixels, _) = pixels_of(&file, Options { ignore_palette: true });
    assert_eq!(pixels, indices.iter().flatten().map(|&i| i as u8).collect::<Vec<_>>());
}

#[test]
fn channel_definitions_put_each_channel_where_its_association_says() {
    let planes: Vec<_> = (1..=3).map(|seed| wave(8, 8, seed, 8, false)).collect();
    let settings = Settings { colour: false, ..Settings::reversible(1) };
    let stream = encode_samples(&planes, &settings);
    // Channel 0 is the third colour, channel 2 the first.
    let mut cdef = be16(3).to_vec();
    for (channel, association) in [(0u16, 3u16), (1, 2), (2, 1)] {
        cdef.extend(be16(channel));
        cdef.extend(be16(0));
        cdef.extend(be16(association));
    }
    let file = jp2_file(&stream, &[colr(16), jp2_box(b"cdef", &cdef)], 3);
    let (pixels, _) = pixels_of(&file, Options::default());
    let expected: Vec<u8> = (0..64).flat_map(|i| [planes[2][i / 8][i % 8], planes[1][i / 8][i % 8], planes[0][i / 8][i % 8]]).map(|v| v as u8).collect();
    assert_eq!(pixels, expected);
    // Opacity channels are listed, premultiplied or not.
    let mut cdef = be16(2).to_vec();
    for (channel, kind, association) in [(0u16, 0u16, 1u16), (1, 2, 0)] {
        cdef.extend([be16(channel), be16(kind), be16(association)].concat());
    }
    let two = encode_samples(&planes[..2], &settings);
    let image = jpx::parse(&jp2_file(&two, &[colr(17), jp2_box(b"cdef", &cdef)], 2)).unwrap();
    assert_eq!(image.container.unwrap().alpha_channels(), [(1, true)]);
}

#[test]
fn an_sycc_image_becomes_rgb_whatever_the_subsampling_of_its_chroma() {
    // Y at full size; Cb and Cr at full size, half the width, or half the width and height.
    for (sampling, columns, rows) in [((1, 1), 8, 8), ((2, 1), 4, 8), ((2, 2), 4, 4)] {
        let planes = vec![wave(8, 8, 1, 8, false), wave(rows, columns, 2, 8, false), wave(rows, columns, 3, 8, false)];
        let settings = Settings { colour: false, subsampling: vec![(1, 1), sampling, sampling], ..Settings::reversible(1) };
        let file = jp2_file(&encode_samples(&planes, &settings), &[colr(18)], 3);
        let (pixels, decoded) = pixels_of(&file, Options::default());
        assert_eq!(decoded.colour, ColourSpace::Srgb, "{sampling:?}");
        for y in 0..8 {
            for x in 0..8 {
                let luma = f64::from(planes[0][y][x]);
                let cb = f64::from(planes[1][y / sampling.1][x / sampling.0]) - 128.0;
                let cr = f64::from(planes[2][y / sampling.1][x / sampling.0]) - 128.0;
                let exact = [luma + 1.402 * cr, luma - 0.344_136 * cb - 0.714_136 * cr, luma + 1.772 * cb];
                for (k, value) in exact.iter().enumerate() {
                    // The conversion truncates where the formula would round: one level at most apart.
                    let want = value.clamp(0.0, 255.0);
                    let got = f64::from(pixels[(y * 8 + x) * 3 + k]);
                    assert!((got - want).abs() <= 1.0, "{sampling:?} at ({x}, {y}) channel {k}: {got} for {want}");
                }
            }
        }
    }
}

#[test]
fn the_colour_space_and_the_other_boxes_of_a_jp2_file_are_reported() {
    let stream = encode_samples(&[wave(8, 8, 1, 8, false)], &Settings::reversible(1));
    for (code, expected) in [(16, ColourSpace::Srgb), (17, ColourSpace::Gray), (12, ColourSpace::Cmyk), (24, ColourSpace::Eycc), (18, ColourSpace::Sycc), (99, ColourSpace::Unspecified)] {
        let (_, decoded) = pixels_of(&jp2_file(&stream, &[colr(code)], 1), Options::default());
        assert_eq!(decoded.colour, expected, "enumerated colour space {code}");
    }
    // An ICC profile (method 2), a second colour box that is ignored, per-component depths, and both resolution boxes:
    // capture 1/2 x 10^3 = 500 vertically and 3/4 x 10^2 = 75 horizontally, display 72/254 x 10^4 both ways.
    let mut icc = vec![2, 5, 1];
    icc.extend([1, 2, 3, 4]);
    let resolution = |first: [u8; 10]| first.to_vec();
    let capture = resolution([0, 1, 0, 2, 0, 3, 0, 4, 3, 2]);
    let display = resolution([0, 72, 0, 254, 0, 72, 0, 254, 4, 4]);
    let res = [jp2_box(b"resc", &capture), jp2_box(b"resd", &display)].concat();
    let children = [jp2_box(b"colr", &icc), colr(16), jp2_box(b"bpcc", &[7]), jp2_box(b"res ", &res)];
    let image = jpx::parse(&jp2_file(&stream, &children, 1)).unwrap();
    let info = image.container.unwrap();
    assert_eq!(info.colours.len(), 2);
    let first = info.colour().unwrap();
    assert_eq!((first.method, first.precedence, first.approximation, first.enumerated, first.profile.clone()), (2, 5, 1, None, vec![1, 2, 3, 4]));
    assert_eq!(info.bits_per_component, [7]);
    let (cv, ch) = info.capture_resolution.unwrap();
    assert!((cv - 500.0).abs() < 1e-9 && (ch - 75.0).abs() < 1e-9, "{cv} {ch}");
    let (dv, dh) = info.display_resolution.unwrap();
    assert!((dv - 72.0 / 254.0 * 1e4).abs() < 1e-6 && (dh - dv).abs() < 1e-9, "{dv} {dh}");
}

#[test]
fn boxes_of_every_length_form_are_read_and_broken_ones_refused() {
    let stream = encode_samples(&[wave(8, 8, 1, 8, false)], &Settings::reversible(1));
    // A codestream box with the 64-bit length (LBox 1, XLBox).
    let mut file = jp2_file(&stream, &[colr(16)], 1);
    let start = file.len() - stream.len() - 8;
    file.truncate(start);
    file.extend(be32(1));
    file.extend(*b"jp2c");
    file.extend((16 + stream.len() as u64).to_be_bytes());
    file.extend_from_slice(&stream);
    assert_eq!(jpx::parse(&file).unwrap().codestream.siz.width(), 8);
    // A box that ends inside its 64-bit length, a box shorter than its own header, a file with no codestream.
    let mut cut = file[..start + 12].to_vec();
    assert!(jpx::parse(&cut).is_err());
    cut = jp2_file(&stream, &[colr(16)], 1);
    let at = cut.len() - stream.len() - 8;
    cut[at..at + 4].copy_from_slice(&be32(4));
    assert!(jpx::parse(&cut).is_err());
    let no_stream = jp2_file(&stream, &[colr(16)], 1)[..at].to_vec();
    assert!(jpx::parse(&no_stream).is_err());
}

// ---- what a damaged header must not be taken for -----------------------------------------------------------------------

#[test]
fn headers_and_tile_parts_that_break_the_standard_are_refused() {
    let data = codestream(8, &[0]);
    let siz = position_of(&data, [0xFF, 0x51]);
    let cod = position_of(&data, [0xFF, 0x52]);
    let sot = position_of(&data, [0xFF, 0x90]);
    let patched = |at: usize, bytes: &[u8]| {
        let mut copy = data.clone();
        copy[at..at + bytes.len()].copy_from_slice(bytes);
        copy
    };
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("an image offset at the image's end", patched(siz + 14, &be32(8))),
        ("a tile of no width", patched(siz + 22, &be32(0))),
        ("a tile origin past the image origin", patched(siz + 30, &be32(1))),
        ("a first tile that ends before the image begins", {
            let mut copy = patched(siz + 14, &be32(4));
            copy[siz + 22..siz + 26].copy_from_slice(&be32(4));
            copy
        }),
        ("no components", patched(siz + 38, &be16(0))),
        ("a component sampled every 0 points", patched(siz + 41, &[0])),
        ("a 32 bit component", patched(siz + 40, &[31])),
        ("more tiles than the standard allows", {
            let mut copy = patched(siz + 6, &be32(u32::MAX));
            copy[siz + 22..siz + 26].copy_from_slice(&be32(1));
            copy
        }),
        ("an unknown progression order", patched(cod + 5, &[5])),
        ("no quality layers", patched(cod + 6, &be16(0))),
        ("33 decomposition levels", patched(cod + 9, &[33])),
        ("a tile-part of length 5", patched(sot + 6, &be32(5))),
        ("a tile-part header that is not a marker", patched(sot + 12, &[0x12, 0x34])),
    ];
    for (name, bytes) in cases {
        assert!(jpx::parse(&bytes).is_err(), "{name}");
    }
    // A precinct of 1 x 1 samples above the lowest resolution cannot be split into bands.
    let precincts = Settings { precincts: true, ..Settings::reversible(2) };
    let stream = encode_samples(&[wave(32, 32, 1, 8, false)], &precincts);
    let cod = position_of(&stream, [0xFF, 0x52]);
    let mut bad = stream.clone();
    bad[cod + 15] = 0x00;
    assert!(jpx::parse(&bad).is_err(), "a precinct exponent of 0 above the lowest resolution");
    // The packet-length marker ends in the middle of a length; the tile-part lengths marker has the index size 3.
    let markers = encode_samples(&[wave(32, 32, 1, 8, false)], &Settings { side_markers: true, ..Settings::reversible(2) });
    let plt = position_of(&markers, [0xFF, 0x58]);
    let length = usize::from(u16::from_be_bytes([markers[plt + 2], markers[plt + 3]]));
    let mut open = markers.clone();
    open[plt + 2 + length - 1] |= 0x80;
    assert!(jpx::parse(&open).is_err(), "a packet length without its last byte");
    let tlm = position_of(&markers, [0xFF, 0x55]);
    let mut wide = markers.clone();
    wide[tlm + 5] = 0b0011_0000;
    assert!(jpx::parse(&wide).is_err(), "a tile index size of 3");
    // The codestream ends inside the first tile-part header.
    assert!(jpx::parse(&data[..sot + 12]).is_err());
}
