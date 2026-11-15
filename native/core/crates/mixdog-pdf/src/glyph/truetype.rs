//! TrueType and OpenType outlines: the sfnt table directory, `cmap` segments and `glyf` contours, following pdf.js
//! `font_renderer.js` (`parseCmap`, `parseGlyfTable`, `compileGlyf`).

use super::{error, CmapRange, Commands, Result, LINE_TO, MOVE_TO, QUADRATIC_CURVE_TO};

const OUT_OF_BOUNDS: &str = "Offset is outside the bounds of the DataView";

pub(crate) fn u8_at(data: &[u8], pos: usize) -> Option<u8> {
    data.get(pos).copied()
}

pub(crate) fn u16_at(data: &[u8], pos: usize) -> Result<u16> {
    match data.get(pos..pos.saturating_add(2)) {
        Some(b) => Ok(u16::from_be_bytes([b[0], b[1]])),
        None => error(OUT_OF_BOUNDS),
    }
}

pub(crate) fn i16_at(data: &[u8], pos: usize) -> Result<i16> {
    u16_at(data, pos).map(|v| v as i16)
}

pub(crate) fn u32_at(data: &[u8], pos: usize) -> Result<u32> {
    match data.get(pos..pos.saturating_add(4)) {
        Some(b) => Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
        None => error(OUT_OF_BOUNDS),
    }
}

/// `Uint8Array.subarray(start, end)`: bounds are clamped, a backwards range is empty.
pub(crate) fn subarray(data: &[u8], start: usize, end: usize) -> &[u8] {
    let end = end.min(data.len());
    let start = start.min(end);
    &data[start..end]
}

/// The tables of an sfnt that the renderer reads.
#[derive(Debug, Default)]
pub struct SfntTables {
    pub cmap: Option<Vec<CmapRange>>,
    pub glyf: Option<Vec<u8>>,
    pub loca: Option<Vec<u8>>,
    pub units_per_em: Option<u16>,
    pub index_to_loc_format: Option<u16>,
    pub cff: Option<Vec<u8>>,
}

/// The table walk of `FontRendererFactory.create`: later tables of the same tag replace earlier ones; a directory or a
/// table that reads past the end of the file is an error, as the `DataView` reads of pdf.js are.
pub fn read_sfnt(data: &[u8]) -> Result<SfntTables> {
    let mut tables = SfntTables::default();
    let num_tables = usize::from(u16_at(data, 4)?);
    let mut p = 12usize;
    for _ in 0..num_tables {
        let tag = subarray(data, p, p + 4);
        let offset = u32_at(data, p + 8)? as usize;
        let length = u32_at(data, p + 12)? as usize;
        match tag {
            b"cmap" => tables.cmap = Some(parse_cmap(data, offset)?),
            b"glyf" => tables.glyf = Some(subarray(data, offset, offset + length).to_vec()),
            b"loca" => tables.loca = Some(subarray(data, offset, offset + length).to_vec()),
            b"head" => {
                tables.units_per_em = Some(u16_at(data, offset + 18)?);
                tables.index_to_loc_format = Some(u16_at(data, offset + 50)?);
            }
            b"CFF " => tables.cff = Some(subarray(data, offset, offset + length).to_vec()),
            _ => {}
        }
        p += 16;
    }
    Ok(tables)
}

/// pdf.js `parseCmap`: the segments of the first subtable (one-table cmap) or of the one at the second record's offset,
/// format 4 or 12. Any other format is an error.
fn parse_cmap(data: &[u8], start: usize) -> Result<Vec<CmapRange>> {
    let offset = if u16_at(data, start + 2)? == 1 {
        u32_at(data, start + 8)?
    } else {
        u32_at(data, start + 16)?
    } as usize;
    let base = start + offset;
    let format = u16_at(data, base)?;
    if format == 4 {
        let seg_count = usize::from(u16_at(data, base + 6)? >> 1);
        let mut p = base + 14;
        let mut ranges: Vec<CmapRange> = Vec::with_capacity(seg_count);
        for _ in 0..seg_count {
            ranges.push(CmapRange {
                start: 0,
                end: u32::from(u16_at(data, p)?),
                id_delta: 0,
                ids: None,
            });
            p += 2;
        }
        p += 2;
        for range in ranges.iter_mut() {
            range.start = u32::from(u16_at(data, p)?);
            p += 2;
        }
        for range in ranges.iter_mut() {
            range.id_delta = i64::from(u16_at(data, p)?);
            p += 2;
        }
        for range in ranges.iter_mut() {
            let mut id_offset = usize::from(u16_at(data, p)?);
            if id_offset != 0 {
                let count = (i64::from(range.end) - i64::from(range.start) + 1).max(0) as usize;
                let mut ids = Vec::with_capacity(count.min(0x10000));
                for _ in 0..count {
                    ids.push(u16_at(data, p + id_offset)?);
                    id_offset += 2;
                }
                range.ids = Some(ids);
            }
            p += 2;
        }
        Ok(ranges)
    } else if format == 12 {
        let groups = u32_at(data, base + 12)? as usize;
        let mut p = base + 16;
        let mut ranges = Vec::new();
        for _ in 0..groups {
            let start = u32_at(data, p)?;
            let end = u32_at(data, p + 4)?;
            let glyph = u32_at(data, p + 8)?;
            ranges.push(CmapRange {
                start,
                end,
                id_delta: i64::from(glyph) - i64::from(start),
                ids: None,
            });
            p += 12;
        }
        Ok(ranges)
    } else {
        error(format!("unsupported cmap: {format}"))
    }
}

/// The glyph table of a TrueType font: each glyph's bytes of `glyf` cut by `loca`.
#[derive(Debug)]
pub struct TrueTypeFont {
    glyphs: Vec<Vec<u8>>,
}

impl TrueTypeFont {
    /// pdf.js `parseGlyfTable`; `long_offsets` is `indexToLocFormat`.
    pub fn new(glyf: &[u8], loca: &[u8], long_offsets: bool) -> Result<Self> {
        let decode = |at: usize| -> Result<usize> {
            if long_offsets {
                u32_at(loca, at).map(|v| v as usize)
            } else {
                u16_at(loca, at).map(|v| 2 * usize::from(v))
            }
        };
        let item = if long_offsets { 4 } else { 2 };
        let mut glyphs = Vec::new();
        let mut start = decode(0)?;
        let mut j = item;
        while j < loca.len() {
            let end = decode(j)?;
            glyphs.push(subarray(glyf, start, end).to_vec());
            start = end;
            j += item;
        }
        Ok(Self { glyphs })
    }

    pub fn glyph(&self, id: usize) -> Option<&[u8]> {
        self.glyphs.get(id).map(Vec::as_slice)
    }

    /// pdf.js `compileGlyf` for glyph `id` into `cmds`.
    pub(crate) fn compile(&self, id: usize, cmds: &mut Commands) -> Result<()> {
        self.compile_glyf(id, cmds, &mut Vec::new())
    }

    fn compile_glyf(&self, id: usize, cmds: &mut Commands, visited: &mut Vec<usize>) -> Result<()> {
        let Some(code) = self.glyph(id) else {
            return Ok(());
        };
        if code.is_empty() {
            return Ok(());
        }
        if visited.contains(&id) {
            tracing::warn!("compileGlyf: skipping recursive composite glyph reference.");
            return Ok(());
        }
        visited.push(id);
        let mut first_point: Option<[f64; 2]> = None;
        let number_of_contours = i16_at(code, 0)?;
        let mut i = 10usize;
        // `code[i]` past the end is `undefined`: arithmetic on it is NaN, a flag byte tests as 0.
        let byte_f = |at: usize| -> f64 { u8_at(code, at).map_or(f64::NAN, f64::from) };
        if number_of_contours < 0 {
            loop {
                let flags = u16_at(code, i)?;
                let glyph_index = usize::from(u16_at(code, i + 2)?);
                i += 4;
                let arg1: f64;
                let arg2: f64;
                if flags & 0x01 != 0 {
                    if flags & 0x02 != 0 {
                        arg1 = f64::from(i16_at(code, i)?);
                        arg2 = f64::from(i16_at(code, i + 2)?);
                    } else {
                        arg1 = f64::from(u16_at(code, i)?);
                        arg2 = f64::from(u16_at(code, i + 2)?);
                    }
                    i += 4;
                } else if flags & 0x02 != 0 {
                    let (a, b) = (u8_at(code, i), u8_at(code, i + 1));
                    let (Some(a), Some(b)) = (a, b) else {
                        return error(OUT_OF_BOUNDS);
                    };
                    arg1 = f64::from(a as i8);
                    arg2 = f64::from(b as i8);
                    i += 2;
                } else {
                    arg1 = byte_f(i);
                    arg2 = byte_f(i + 1);
                    i += 2;
                }
                let (x, y) = if flags & 0x02 != 0 {
                    (arg1, arg2)
                } else {
                    (0.0, 0.0)
                };
                let (mut scale_x, mut scale_y, mut scale01, mut scale10) = (1.0, 1.0, 0.0, 0.0);
                let float214 =
                    |at: usize| -> Result<f64> { Ok(f64::from(i16_at(code, at)?) / 16384.0) };
                if flags & 0x08 != 0 {
                    scale_x = float214(i)?;
                    scale_y = scale_x;
                    i += 2;
                } else if flags & 0x40 != 0 {
                    scale_x = float214(i)?;
                    scale_y = float214(i + 2)?;
                    i += 4;
                } else if flags & 0x80 != 0 {
                    scale_x = float214(i)?;
                    scale01 = float214(i + 2)?;
                    scale10 = float214(i + 4)?;
                    scale_y = float214(i + 6)?;
                    i += 8;
                }
                if glyph_index < self.glyphs.len() {
                    cmds.save();
                    cmds.transform(&[scale_x, scale01, scale10, scale_y, x, y]);
                    self.compile_glyf(glyph_index, cmds, visited)?;
                    cmds.restore();
                }
                if flags & 0x20 == 0 {
                    break;
                }
            }
        } else {
            let mut end_pts = Vec::with_capacity(usize::try_from(number_of_contours).unwrap_or(0));
            for _ in 0..number_of_contours {
                end_pts.push(usize::from(u16_at(code, i)?));
                i += 2;
            }
            let instruction_length = usize::from(u16_at(code, i)?);
            i += 2 + instruction_length;
            let number_of_points = end_pts.last().map_or(0, |last| last + 1);
            // (flags, x, y); a flag byte past the end is `undefined`, which tests as 0.
            let mut points: Vec<(u32, f64, f64)> = Vec::new();
            while points.len() < number_of_points {
                let flags = u32::from(u8_at(code, i).unwrap_or(0));
                i += 1;
                let mut repeat: Option<usize> = Some(1);
                if flags & 0x08 != 0 {
                    repeat = u8_at(code, i).map(|r| 1 + usize::from(r));
                    i += 1;
                }
                for _ in 0..repeat.unwrap_or(0) {
                    points.push((flags, 0.0, 0.0));
                }
            }
            let mut x = 0.0f64;
            for point in points.iter_mut().take(number_of_points) {
                match point.0 & 0x12 {
                    0x00 => {
                        x += f64::from(i16_at(code, i)?);
                        i += 2;
                    }
                    0x02 => {
                        x -= byte_f(i);
                        i += 1;
                    }
                    0x12 => {
                        x += byte_f(i);
                        i += 1;
                    }
                    _ => {}
                }
                point.1 = x;
            }
            let mut y = 0.0f64;
            for point in points.iter_mut().take(number_of_points) {
                match point.0 & 0x24 {
                    0x00 => {
                        y += f64::from(i16_at(code, i)?);
                        i += 2;
                    }
                    0x04 => {
                        y -= byte_f(i);
                        i += 1;
                    }
                    0x24 => {
                        y += byte_f(i);
                        i += 1;
                    }
                    _ => {}
                }
                point.2 = y;
            }
            let mut start_point = 0usize;
            for &end_point in &end_pts {
                let from = start_point.min(points.len());
                let to = (end_point + 1).min(points.len()).max(from);
                let mut contour: Vec<(u32, f64, f64)> = points[from..to].to_vec();
                let (Some(&first), Some(&last)) = (contour.first(), contour.last()) else {
                    return error("Cannot read properties of undefined (reading 'flags')");
                };
                if first.0 & 1 != 0 {
                    contour.push(first);
                } else if last.0 & 1 != 0 {
                    contour.insert(0, last);
                } else {
                    let p = (1, (first.1 + last.1) / 2.0, (first.2 + last.2) / 2.0);
                    contour.insert(0, p);
                    contour.push(p);
                }
                move_to(cmds, &mut first_point, contour[0].1, contour[0].2);
                let mut j = 1usize;
                while j < contour.len() {
                    let point = contour[j];
                    if point.0 & 1 != 0 {
                        cmds.add(LINE_TO, &[point.1, point.2]);
                    } else {
                        let Some(next) = contour.get(j + 1).copied() else {
                            return error("Cannot read properties of undefined (reading 'flags')");
                        };
                        if next.0 & 1 != 0 {
                            cmds.add(QUADRATIC_CURVE_TO, &[point.1, point.2, next.1, next.2]);
                            j += 1;
                        } else {
                            cmds.add(
                                QUADRATIC_CURVE_TO,
                                &[
                                    point.1,
                                    point.2,
                                    (point.1 + next.1) / 2.0,
                                    (point.2 + next.2) / 2.0,
                                ],
                            );
                        }
                    }
                    j += 1;
                }
                start_point = end_point + 1;
            }
        }
        visited.retain(|&v| v != id);
        Ok(())
    }
}

/// `moveTo` of `compileGlyf`: the previous contour is closed with a line back to its first point first.
fn move_to(cmds: &mut Commands, first_point: &mut Option<[f64; 2]>, x: f64, y: f64) {
    if let Some(fp) = *first_point {
        cmds.add(LINE_TO, &fp);
    }
    *first_point = Some([x, y]);
    cmds.add(MOVE_TO, &[x, y]);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A glyph of one triangle: on-curve points (0,0) (100,0) (0,100) in short vectors.
    fn triangle() -> Vec<u8> {
        let mut g = vec![0, 1, 0, 0, 0, 0, 0, 100, 0, 100]; // one contour, bounding box
        g.extend_from_slice(&[0, 2]); // endPtsOfContours [2]
        g.extend_from_slice(&[0, 0]); // no instructions
        g.extend_from_slice(&[0x37, 0x37, 0x27]); // flags: on curve, short x and y, the third goes back in x
        g.extend_from_slice(&[0, 100, 100]); // x deltas
        g.extend_from_slice(&[0, 0, 100]); // y deltas
        g
    }

    #[test]
    fn simple_glyph_closes_the_contour_with_a_line_back_to_the_start_point_only_for_the_next_one() {
        let mut cmds = Commands::new();
        let font = TrueTypeFont {
            glyphs: vec![triangle()],
        };
        font.compile(0, &mut cmds).unwrap();
        cmds.close_path();
        let path = cmds.into_path();
        // moveTo first point, then lineTo for each further point and the repeated start point; closePath last.
        assert_eq!(path[0], MOVE_TO);
        assert_eq!(*path.last().unwrap(), super::super::CLOSE_PATH);
        assert_eq!(path.iter().filter(|&&w| w == LINE_TO).count(), 3);
    }

    #[test]
    fn a_composite_that_refers_to_itself_is_skipped() {
        // numberOfContours -1, flags 0x0003 (words, xy values), glyph 0, args 0 0.
        let mut g = vec![0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0];
        g.extend_from_slice(&[0, 3, 0, 0, 0, 0, 0, 0]);
        let font = TrueTypeFont { glyphs: vec![g] };
        let mut cmds = Commands::new();
        font.compile(0, &mut cmds).unwrap();
        assert!(cmds.into_path().is_empty());
    }

    #[test]
    fn a_format_4_cmap_maps_through_segments_and_id_arrays() {
        let mut t = vec![0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]; // header, one record at offset 12
                                                               // format 4, length, language, segCountX2 = 4, searchRange.. (6 bytes)
        t.extend_from_slice(&[0, 4, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0]);
        t.extend_from_slice(&[0, 0x42, 0xff, 0xff]); // endCode 0x42, 0xffff
        t.extend_from_slice(&[0, 0]); // reserved
        t.extend_from_slice(&[0, 0x41, 0xff, 0xff]); // startCode
        t.extend_from_slice(&[0xff, 0xc0, 0, 1]); // idDelta -64 -> 0xffc0, 1
        t.extend_from_slice(&[0, 0, 0, 0]); // idRangeOffset
        let ranges = parse_cmap(&t, 0).unwrap();
        assert_eq!(ranges.len(), 2);
        assert_eq!(super::super::lookup_cmap(&ranges, 0x41).unwrap(), 1);
        assert_eq!(super::super::lookup_cmap(&ranges, 0x42).unwrap(), 2);
        assert_eq!(super::super::lookup_cmap(&ranges, 0x43).unwrap(), 0);
    }
}
