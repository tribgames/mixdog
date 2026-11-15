//! The JPEG 2000 container and codestream reader against the corpus of `record-office-jpx.mjs`
//! (`native/core/fixtures/office-jpx`): per case, the structure the writer put in (marker parameters, tile and
//! precinct geometry, packet order, empty flags, code-block passes, segments and lengths) and what OpenJPEG, as pdf.js
//! 6.4.299 runs it, reported for the file (dimensions, components, that it decodes).

use std::path::PathBuf;

use mixdog_pdf::codec::jpx::markers::{Progression, TileParams};
use mixdog_pdf::codec::jpx::tiles::TileStructure;
use mixdog_pdf::codec::jpx::{self, Image};
use serde_json::Value;

fn fixtures() -> PathBuf {
    let manifest =
        std::env::var_os("CARGO_MANIFEST_DIR").map_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")), PathBuf::from);
    manifest.join("../../fixtures/office-jpx")
}

fn expected() -> Value {
    serde_json::from_str(&mixdog_testkit::read_string(fixtures().join("expected.json"))).expect("expected.json parses")
}

fn load(case: &Value) -> Vec<u8> {
    mixdog_testkit::read(fixtures().join(case["file"].as_str().unwrap()))
}

fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn progression(v: u64) -> Progression {
    [Progression::Lrcp, Progression::Rlcp, Progression::Rpcl, Progression::Pcrl, Progression::Cprl][v as usize]
}

fn cases() -> Vec<(String, Value)> {
    let e = expected();
    e["cases"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn check_siz(name: &str, image: &Image, c: &Value) {
    let siz = &image.codestream.siz;
    let s = &c["siz"];
    assert_eq!(
        (siz.x1 as u64, siz.y1 as u64, siz.x0 as u64, siz.y0 as u64),
        (n(&s["x1"]), n(&s["y1"]), n(&s["x0"]), n(&s["y0"])),
        "{name}: image area"
    );
    assert_eq!(
        (siz.tile_w as u64, siz.tile_h as u64, siz.tile_x0 as u64, siz.tile_y0 as u64),
        (n(&s["tileW"]), n(&s["tileH"]), n(&s["tileX0"]), n(&s["tileY0"])),
        "{name}: tile grid"
    );
    let comps = c["comps"].as_array().unwrap();
    assert_eq!(siz.comps.len(), comps.len(), "{name}: component count");
    for (i, (got, want)) in siz.comps.iter().zip(comps).enumerate() {
        assert_eq!(got.precision as u64, n(&want["precision"]), "{name}: comp {i} precision");
        assert_eq!(got.signed, want["signed"].as_bool().unwrap(), "{name}: comp {i} signed");
        assert_eq!((got.dx as u64, got.dy as u64), (n(&want["dx"]), n(&want["dy"])), "{name}: comp {i} subsampling");
    }
}

fn check_main(name: &str, image: &Image, c: &Value) {
    let main: &TileParams = &image.codestream.main;
    let m = &c["main"];
    assert_eq!(main.progression, progression(n(&m["progression"])), "{name}: progression");
    assert_eq!(main.layers as u64, n(&m["layers"]), "{name}: layers");
    assert_eq!(main.mct as u64, n(&m["mct"]), "{name}: mct");
    assert_eq!(main.sop, m["sop"].as_bool().unwrap(), "{name}: sop");
    assert_eq!(main.eph, m["eph"].as_bool().unwrap(), "{name}: eph");
    let pocs = m["pocs"].as_array().unwrap();
    assert_eq!(main.pocs.len(), pocs.len(), "{name}: poc count");
    for (got, want) in main.pocs.iter().zip(pocs) {
        assert_eq!(
            (got.res0 as u64, got.comp0 as u64, got.layer1 as u64, got.res1 as u64, got.comp1 as u64),
            (n(&want["res0"]), n(&want["comp0"]), n(&want["layer1"]), n(&want["res1"]), n(&want["comp1"])),
            "{name}: poc bounds"
        );
        assert_eq!(got.progression, progression(n(&want["prog"])), "{name}: poc progression");
    }
    for (i, (got, want)) in main.comps.iter().zip(c["comps"].as_array().unwrap()).enumerate() {
        let k = &got.coding;
        assert_eq!(k.levels as u64, n(&want["levels"]), "{name}: comp {i} levels");
        assert_eq!((k.cbw as u64, k.cbh as u64), (n(&want["cbw"]), n(&want["cbh"])), "{name}: comp {i} block size");
        assert_eq!(k.style as u64, n(&want["style"]), "{name}: comp {i} block style");
        assert_eq!(k.reversible, want["reversible"].as_bool().unwrap(), "{name}: comp {i} transform");
        match want["precincts"].as_array() {
            Some(list) => {
                let want: Vec<(u64, u64)> = list.iter().map(|p| (n(&p[0]), n(&p[1]))).collect();
                let got: Vec<(u64, u64)> = k.precincts.iter().map(|&(x, y)| (x as u64, y as u64)).collect();
                assert_eq!(got, want, "{name}: comp {i} precinct sizes");
            }
            None => assert!(k.precincts.iter().all(|&p| p == (15, 15)), "{name}: comp {i} default precincts"),
        }
        assert_eq!(got.roi_shift as u64, n(&want["roi"]), "{name}: comp {i} roi shift");
        let q = &got.quant;
        assert_eq!(q.style as u64, n(&want["quant"]["style"]), "{name}: comp {i} quant style");
        assert_eq!(q.guard as u64, n(&want["quant"]["guard"]), "{name}: comp {i} guard bits");
        let explicit: Vec<(u64, u64)> =
            q.explicit_steps().iter().map(|s| (s.expn as u64, s.mant as u64)).collect();
        let want_explicit: Vec<(u64, u64)> = want["quant"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (n(&s["expn"]), n(&s["mant"])))
            .collect();
        assert_eq!(explicit, want_explicit, "{name}: comp {i} marker steps");
        for (b, s) in want["effectiveSteps"].as_array().unwrap().iter().enumerate() {
            let got = q.step(b);
            assert_eq!((got.expn as u64, got.mant as u64), (n(&s["expn"]), n(&s["mant"])), "{name}: comp {i} band {b} step");
        }
    }
}

fn check_geometry(name: &str, tile: &TileStructure, want: &Value) {
    let comps = want["components"].as_array().unwrap();
    assert_eq!(tile.components.len(), comps.len(), "{name}: tile {} components", tile.index);
    for (ci, (got, w)) in tile.components.iter().zip(comps).enumerate() {
        let at = format!("{name}: tile {} comp {ci}", tile.index);
        assert_eq!(
            (got.x0 as u64, got.y0 as u64, got.x1 as u64, got.y1 as u64),
            (n(&w["x0"]), n(&w["y0"]), n(&w["x1"]), n(&w["y1"])),
            "{at}: bounds"
        );
        let res = w["res"].as_array().unwrap();
        assert_eq!(got.resolutions.len(), res.len(), "{at}: resolutions");
        for (ri, (gr, wr)) in got.resolutions.iter().zip(res).enumerate() {
            let at = format!("{at} res {ri}");
            assert_eq!(
                (gr.x0 as u64, gr.y0 as u64, gr.x1 as u64, gr.y1 as u64, gr.pw as u64, gr.ph as u64),
                (n(&wr["x0"]), n(&wr["y0"]), n(&wr["x1"]), n(&wr["y1"]), n(&wr["pw"]), n(&wr["ph"])),
                "{at}: bounds and precincts"
            );
            let bands = wr["bands"].as_array().unwrap();
            assert_eq!(gr.bands.len(), bands.len(), "{at}: bands");
            for (bi, (gb, wb)) in gr.bands.iter().zip(bands).enumerate() {
                let at = format!("{at} band {bi}");
                assert_eq!(gb.orient as u64, n(&wb["orient"]), "{at}: orientation");
                assert_eq!(
                    (gb.x0 as u64, gb.y0 as u64, gb.x1 as u64, gb.y1 as u64),
                    (n(&wb["x0"]), n(&wb["y0"]), n(&wb["x1"]), n(&wb["y1"])),
                    "{at}: bounds"
                );
                assert_eq!(gb.numbps as i64, wb["numbps"].as_i64().unwrap(), "{at}: bit-planes");
                assert_eq!((gb.expn as u64, gb.mant as u64), (n(&wb["expn"]), n(&wb["mant"])), "{at}: step");
                let precincts = wb["precincts"].as_array().unwrap();
                assert_eq!(gb.precincts.len(), precincts.len(), "{at}: precinct count");
                for (pi, (gp, wp)) in gb.precincts.iter().zip(precincts).enumerate() {
                    let at = format!("{at} precinct {pi}");
                    assert_eq!((gp.cw as u64, gp.ch as u64), (n(&wp["cw"]), n(&wp["ch"])), "{at}: blocks across and down");
                    let blocks = wp["blocks"].as_array().unwrap();
                    assert_eq!(gp.blocks.len(), blocks.len(), "{at}: block count");
                    for (bk, wk) in gp.blocks.iter().zip(blocks) {
                        assert_eq!(
                            (bk.x0 as u64, bk.y0 as u64, bk.x1 as u64, bk.y1 as u64),
                            (n(&wk[0]), n(&wk[1]), n(&wk[2]), n(&wk[3])),
                            "{at}: block bounds"
                        );
                    }
                }
            }
        }
    }
}

fn check_packets(name: &str, tile: &TileStructure, want: &Value) {
    let packets = want["packets"].as_array().unwrap();
    let got: Vec<[u64; 6]> = tile
        .packets
        .iter()
        .map(|p| {
            [p.layer as u64, p.resolution as u64, p.component as u64, p.precinct as u64, p.empty as u64, p.data_len as u64]
        })
        .collect();
    let want_rows: Vec<[u64; 6]> = packets
        .iter()
        .map(|p| [n(&p[0]), n(&p[1]), n(&p[2]), n(&p[3]), n(&p[4]), n(&p[5])])
        .collect();
    assert_eq!(got, want_rows, "{name}: tile {} packets (layer, resolution, component, precinct, empty, bytes)", tile.index);
    assert!(!tile.truncated, "{name}: tile {} is not truncated", tile.index);
}

fn check_blocks(name: &str, tile: &TileStructure, want: &Value) {
    let blocks = want["blocks"].as_array().unwrap();
    let mut seen = 0usize;
    for b in blocks {
        let (c, r, band, p, i) =
            (n(&b["comp"]) as usize, n(&b["res"]) as usize, n(&b["band"]) as usize, n(&b["precinct"]) as usize, n(&b["index"]) as usize);
        let blk = &tile.components[c].resolutions[r].bands[band].precincts[p].blocks[i];
        let at = format!("{name}: tile {} comp {c} res {r} band {band} precinct {p} block {i}", tile.index);
        assert_eq!(blk.numbps as i64, b["numbps"].as_i64().unwrap(), "{at}: bit-planes");
        assert_eq!(blk.passes as u64, n(&b["passes"]), "{at}: passes");
        let segs: Vec<(u64, u64)> = blk.segments.iter().map(|s| (s.passes as u64, s.len as u64)).collect();
        let want_segs: Vec<(u64, u64)> =
            b["segments"].as_array().unwrap().iter().map(|s| (n(&s[0]), n(&s[1]))).collect();
        assert_eq!(segs, want_segs, "{at}: segments");
        assert_eq!(blk.data.len() as u64, n(&b["dataLen"]), "{at}: bytes");
        seen += 1;
    }
    let included: usize = tile
        .components
        .iter()
        .flat_map(|c| &c.resolutions)
        .flat_map(|r| &r.bands)
        .flat_map(|b| &b.precincts)
        .flat_map(|p| &p.blocks)
        .filter(|b| !b.segments.is_empty())
        .count();
    assert_eq!(included, seen, "{name}: tile {} included code-blocks", tile.index);
}

#[test]
fn every_case_parses_to_the_recorded_structure() {
    for (name, c) in cases() {
        let data = load(&c);
        let image = jpx::parse(&data).unwrap_or_else(|e| panic!("{name}: {e}"));
        check_siz(&name, &image, &c);
        check_main(&name, &image, &c);
        let cs = &image.codestream;
        let tiles = c["tiles"].as_array().unwrap();
        assert_eq!(cs.tile_count() as usize, tiles.len(), "{name}: tile count");
        assert!(!cs.truncated, "{name}: codestream is whole");
        assert_eq!(cs.comments, vec![[&[0u8, 1][..], c["comment"].as_str().unwrap().as_bytes()].concat()], "{name}: COM");
        for want in tiles {
            let index = n(&want["index"]) as u32;
            assert!(cs.has_tile(index), "{name}: tile {index} present");
            assert_eq!(cs.tile_part_count(index) as u64, n(&want["parts"]), "{name}: tile {index} tile-parts");
            let params = cs.tile_params(index).unwrap();
            assert_eq!(params.progression, progression(n(&want["progression"])), "{name}: tile {index} progression");
            assert_eq!(params.layers as u64, n(&want["layers"]), "{name}: tile {index} layers");
            let tile = cs.tile(index).unwrap().expect("tile");
            assert_eq!(
                (tile.x0 as u64, tile.y0 as u64, tile.x1 as u64, tile.y1 as u64),
                (n(&want["x0"]), n(&want["y0"]), n(&want["x1"]), n(&want["y1"])),
                "{name}: tile {index} bounds"
            );
            check_geometry(&name, &tile, want);
            check_packets(&name, &tile, want);
            check_blocks(&name, &tile, want);
            if c["plt"].as_bool().unwrap() {
                assert_eq!(cs.packet_lengths(index).len(), tile.packets.len(), "{name}: tile {index} PLT lengths");
            }
        }
    }
}

#[test]
fn tlm_lists_every_tile_part() {
    for (name, c) in cases() {
        let Some(list) = c["tlm"].as_array() else { continue };
        let image = jpx::parse(&load(&c)).unwrap();
        let got: Vec<(u64, u64)> =
            image.codestream.tlm.iter().map(|e| (e.tile.unwrap() as u64, e.length as u64)).collect();
        let want: Vec<(u64, u64)> = list.iter().map(|e| (n(&e["tile"]), n(&e["length"]))).collect();
        assert_eq!(got, want, "{name}: TLM");
    }
}

#[test]
fn dimensions_and_components_equal_what_openjpeg_reports() {
    let e = expected();
    assert_eq!(e["pdfjs"]["version"], "6.4.299");
    for (name, c) in cases() {
        let image = jpx::parse(&load(&c)).unwrap();
        let siz = &image.codestream.siz;
        let oj = &c["openjpeg"];
        assert_eq!(oj["ok"], true, "{name}: OpenJPEG decodes the file");
        let props = &oj["properties"];
        assert_eq!(siz.width() as u64, n(&props["width"]), "{name}: width");
        assert_eq!(siz.height() as u64, n(&props["height"]), "{name}: height");
        assert_eq!(siz.comps.len() as u64, n(&props["componentsCount"]), "{name}: components");
        // pdf.js asks OpenJPEG for at most four components of 8 bits.
        let shown = siz.comps.len().min(4) as u64;
        assert_eq!(n(&oj["pixelBytes"]), siz.width() as u64 * siz.height() as u64 * shown, "{name}: decoded size");
    }
}

#[test]
fn node_without_wasm_url_cannot_load_openjpeg() {
    let e = expected();
    assert_eq!(e["pdfjs"]["nodeDefaultConfiguration"]["error"], "OpenJPEG failed to initialize");
}

#[test]
fn jp2_boxes_are_read() {
    let e = expected();
    let alpha = &e["cases"]["jp2-alpha"];
    let image = jpx::parse(&load(alpha)).unwrap();
    let info = image.container.expect("a JP2 container");
    assert_eq!(info.brand, Some(*b"jp2 "));
    let h = info.header.as_ref().expect("ihdr");
    assert_eq!((h.width, h.height, h.components, h.bpc), (32, 32, 4, 7));
    assert_eq!(h.compression, 7);
    let colr = info.colour().expect("colr");
    assert_eq!((colr.method, colr.enumerated), (1, Some(16)));
    assert_eq!(info.alpha_channels(), vec![(3, false)]);
    assert_eq!(info.channel_defs.len(), 4);
    assert_eq!(info.channel_defs[1].association, 2);
    let (cv, ch) = info.capture_resolution.expect("capture resolution");
    assert!((cv - 7200.0).abs() < 1e-9 && (ch - 7200.0).abs() < 1e-9);
    let (dv, dh) = info.display_resolution.expect("display resolution");
    assert!((dv - 30000.0).abs() < 1e-9 && (dh - 30000.0).abs() < 1e-9);

    let palette = &e["cases"]["jp2-palette-xl"];
    let info = jpx::parse(&load(palette)).unwrap().container.unwrap();
    let pal = info.palette.expect("pclr");
    assert_eq!((pal.entries, pal.column_depths.clone()), (4, vec![7, 7, 7]));
    assert_eq!(pal.values, vec![0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]);
    assert_eq!(info.component_map.len(), 3);
    assert_eq!((info.component_map[2].component, info.component_map[2].mapping_type, info.component_map[2].palette_column), (0, 1, 2));

    let icc = &e["cases"]["jp2-icc-open-box"];
    let data = load(icc);
    let image = jpx::parse(&data).unwrap();
    let info = image.container.unwrap();
    let colr = info.colour().unwrap();
    assert_eq!((colr.method, colr.enumerated), (2, None));
    assert_eq!(colr.profile, b"ICCPROFILE-STUB-0123456789");
    // the codestream box runs to the end of the file (LBox 0), and the tile-part length is 0: both mean "to the end"
    assert_eq!(info.codestream.end, data.len());
    assert_eq!(image.codestream.tile_part_count(0), 1);
}

#[test]
fn bare_codestream_has_no_container() {
    let e = expected();
    let data = load(&e["cases"]["gray-lossless"]);
    assert!(jpx::parse(&data).unwrap().container.is_none());
}

fn gray() -> Vec<u8> {
    load(&expected()["cases"]["gray-lossless"])
}

fn position_of(data: &[u8], marker: [u8; 2]) -> usize {
    data.windows(2).position(|w| w == marker).expect("marker present")
}

#[test]
fn truncated_codestream_reads_as_far_as_it_goes() {
    let e = expected();
    let c = &e["cases"]["rgb-lossy-tiled"];
    let data = load(c);
    let whole = jpx::parse(&data).unwrap();
    let total: usize = (0..whole.codestream.tile_count()).map(|t| whole.codestream.tile(t).unwrap().unwrap().packets.len()).sum();
    let cut = &data[..data.len() * 6 / 10];
    let part = jpx::parse(cut).unwrap();
    assert!(part.codestream.truncated);
    let mut seen = 0usize;
    let mut tile_truncated = false;
    for t in 0..part.codestream.tile_count() {
        if let Some(tile) = part.codestream.tile(t).unwrap() {
            seen += tile.packets.len();
            tile_truncated |= tile.truncated;
        }
    }
    assert!(seen > 0 && seen < total, "{seen} of {total} packets");
    assert!(tile_truncated, "the cut tile says so");
}

#[test]
fn damaged_input_is_an_error() {
    assert!(jpx::parse(&[]).is_err());
    assert!(jpx::parse(b"not a jpeg 2000 file").is_err());
    let data = gray();
    // SOC then no SIZ
    let mut broken = data.clone();
    broken[2] = 0xFF;
    broken[3] = 0x52;
    assert!(jpx::parse(&broken).is_err());
    // no COD in the main header: turn COD into a COM marker
    let mut no_cod = data.clone();
    let at = position_of(&no_cod, [0xFF, 0x52]);
    no_cod[at + 1] = 0x64;
    assert!(jpx::parse(&no_cod).is_err());
    // a tile index past the grid
    let mut bad_tile = data.clone();
    let sot = position_of(&bad_tile, [0xFF, 0x90]);
    bad_tile[sot + 4] = 0;
    bad_tile[sot + 5] = 9;
    assert!(jpx::parse(&bad_tile).is_err());
    // JP2 without the signature box
    let e = expected();
    let mut jp2 = load(&e["cases"]["jp2-alpha"]);
    jp2[4] = b'x';
    assert!(jpx::parse(&jp2).is_err());
}

#[test]
fn high_throughput_blocks_are_refused() {
    let mut data = gray();
    let cod = position_of(&data, [0xFF, 0x52]);
    data[cod + 12] |= 0x40;
    let err = jpx::parse(&data).err().expect("an error");
    assert!(err.message().contains("high-throughput"), "{err}");
}

#[test]
fn region_and_quantisation_styles_are_read_as_openjpeg_reads_them() {
    let e = expected();
    let c = &e["cases"]["coc-qcc-rgn"];
    let mut data = load(c);
    let rgn = position_of(&data, [0xFF, 0x5E]);
    data[rgn + 5] = 1; // Srgn: a style the standard does not define
    let image = jpx::parse(&data).unwrap();
    let shifts: Vec<u64> = image.codestream.main.comps.iter().map(|p| p.roi_shift as u64).collect();
    let recorded: Vec<u64> = c["comps"].as_array().unwrap().iter().map(|w| n(&w["roi"])).collect();
    assert_eq!(shifts, recorded);

    let mut data = gray();
    let qcd = position_of(&data, [0xFF, 0x5C]);
    data[qcd + 4] = (data[qcd + 4] & 0xE0) | 3; // Sqcd style 3: read as scalar expounded
    let image = jpx::parse(&data).unwrap();
    let q = &image.codestream.main.comps[0].quant;
    let len = u16::from_be_bytes([data[qcd + 2], data[qcd + 3]]) as usize - 3;
    assert_eq!((q.style, q.explicit_steps().len()), (3, len / 2));
}

#[test]
fn invalid_code_block_and_precinct_sizes_are_refused() {
    let mut data = gray();
    let cod = position_of(&data, [0xFF, 0x52]);
    data[cod + 10] = 9; // xcb = 11
    assert!(jpx::parse(&data).is_err());
    let mut data = gray();
    data[cod + 10] = 8; // xcb = 10 with ycb = 4: 14 > 12
    assert!(jpx::parse(&data).is_err());
}

#[test]
fn a_tile_the_codestream_leaves_out_is_absent() {
    let e = expected();
    let data = load(&e["cases"]["rgb-lossy-tiled"]);
    // keep the first tile-part only
    let first = position_of(&data, [0xFF, 0x90]);
    let second = first + 12 + data[first + 6..first + 10].iter().fold(0usize, |a, b| (a << 8) | *b as usize) - 12;
    let mut cut = data[..second].to_vec();
    cut.extend_from_slice(&[0xFF, 0xD9]);
    let image = jpx::parse(&cut).unwrap();
    assert!(image.codestream.has_tile(0));
    assert!(!image.codestream.has_tile(1));
    assert!(image.codestream.tile(1).unwrap().is_none());
}
