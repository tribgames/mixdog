//! What the HEIF container says about the primary image that `avif-parse` does not hand out: the type of the primary
//! item (an AV1 picture or something libheif's HEVC plugin would be needed for), the transformative properties
//! (`clap` crop, `irot` rotation, `imir` mirror) in the order the primary item lists them, and the `colr` colour
//! information (an `nclx` triple or an ICC profile). libheif applies the transformations while it decodes and libvips
//! takes the colour information from it, so sharp's pixels have them applied.
//!
//! The container was already accepted by `avif-parse` (or is an HEVC file, whose items are not read at all): a box
//! that does not parse here simply contributes nothing.

/// The four-character code and the body of one box.
struct Boxed<'a> {
    kind: [u8; 4],
    body: &'a [u8],
}

/// The boxes laid one after another in `data`; a box that overruns `data` ends the walk.
fn boxes(data: &[u8]) -> impl Iterator<Item = Boxed<'_>> {
    let mut rest = data;
    std::iter::from_fn(move || {
        if rest.len() < 8 {
            return None;
        }
        let size = u32::from_be_bytes(rest[..4].try_into().ok()?);
        let kind: [u8; 4] = rest[4..8].try_into().ok()?;
        let (header, total) = match size {
            0 => (8, rest.len()),
            1 => (16, usize::try_from(u64::from_be_bytes(rest.get(8..16)?.try_into().ok()?)).ok()?),
            _ => (8, usize::try_from(size).ok()?),
        };
        if total < header || total > rest.len() {
            return None;
        }
        let found = Boxed { kind, body: &rest[header..total] };
        rest = &rest[total..];
        Some(found)
    })
}

fn find<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).find(|found| &found.kind == kind).map(|found| found.body)
}

fn be16(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn be32(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

/// A rational number as the `clap` box stores it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Fraction {
    numerator: i64,
    denominator: i64,
}

impl Fraction {
    fn new(numerator: i64, denominator: u32) -> Option<Self> {
        (denominator != 0).then_some(Self { numerator, denominator: i64::from(denominator) })
    }
}

/// `clap`: the clean aperture, a crop box given by its size and the offset of its centre from the image's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct CleanAperture {
    width: Fraction,
    height: Fraction,
    horizontal_offset: Fraction,
    vertical_offset: Fraction,
}

/// `floor(numerator / denominator)` for a positive denominator.
fn floor_div(numerator: i128, denominator: i128) -> i128 {
    numerator.div_euclid(denominator)
}

/// One crop axis: the first column (or row) kept and how many are kept, as libheif computes them: the size is the
/// aperture size rounded to the nearest integer, the position is `offset + (extent - 1) / 2 - (size - 1) / 2`
/// rounded down, and the box is kept inside the picture.
fn crop_axis(extent: u32, size: Fraction, offset: Fraction) -> (u32, u32) {
    // Fractions of 32-bit parts multiply past 64 bits.
    let extent = i128::from(extent);
    let (size_n, size_d, offset_n, offset_d) = (i128::from(size.numerator), i128::from(size.denominator), i128::from(offset.numerator), i128::from(offset.denominator));
    // The aperture size rounded half up.
    let kept = floor_div(2 * size_n + size_d, 2 * size_d).clamp(1, extent);
    // offset + (extent - 1) / 2 - (size - 1) / 2 over the common denominator 2 * offset.d * size.d.
    let numerator = 2 * offset_n * size_d + (extent - 1) * offset_d * size_d - (size_n - size_d) * offset_d;
    let first = floor_div(numerator, 2 * offset_d * size_d).clamp(0, extent - kept);
    (u32::try_from(first).unwrap_or(0), u32::try_from(kept).unwrap_or(1))
}

impl CleanAperture {
    /// `(left, top, width, height)` of the kept box in a picture of `width` by `height`.
    pub(crate) fn window(&self, width: u32, height: u32) -> (u32, u32, u32, u32) {
        let (left, kept_width) = crop_axis(width, self.width, self.horizontal_offset);
        let (top, kept_height) = crop_axis(height, self.height, self.vertical_offset);
        (left, top, kept_width, kept_height)
    }
}

/// A transformative property of the primary item.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Transform {
    Crop(CleanAperture),
    /// `irot`: counter-clockwise quarter turns, 1 to 3.
    Rotate(u8),
    /// `imir`: the axis bit; 0 turns the picture upside down, 1 left for right (libheif's vertical and horizontal
    /// mirror directions).
    Mirror(u8),
}

/// `colr`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Colour {
    /// `nclx`: the matrix coefficients code and whether the range is full.
    Nclx { matrix: u16, full_range: bool },
    /// `prof` or `rICC`: an ICC profile.
    Icc(Vec<u8>),
}

/// What the container says about the primary item.
#[derive(Default, Debug)]
pub(crate) struct Container {
    /// The `infe` item type of the primary item (`av01`, `hvc1`, ...).
    pub item_type: Option<[u8; 4]>,
    pub transforms: Vec<Transform>,
    pub colours: Vec<Colour>,
}

fn primary_item_id(meta: &[u8]) -> Option<u32> {
    let pitm = find(meta, b"pitm")?;
    if *pitm.first()? == 0 { be16(pitm, 4).map(u32::from) } else { be32(pitm, 4) }
}

fn item_type_of(meta: &[u8], item: u32) -> Option<[u8; 4]> {
    let iinf = find(meta, b"iinf")?;
    let entries = iinf.get(if *iinf.first()? == 0 { 6 } else { 8 }..)?;
    boxes(entries).filter(|entry| &entry.kind == b"infe").find_map(|entry| {
        let version = *entry.body.first()?;
        let (id, at) = match version {
            2 => (u32::from(be16(entry.body, 4)?), 6),
            3 => (be32(entry.body, 4)?, 8),
            _ => return None,
        };
        if id != item {
            return None;
        }
        // The protection index (2 bytes) comes before the item type.
        let kind: [u8; 4] = entry.body.get(at + 2..at + 6)?.try_into().ok()?;
        Some(kind)
    })
}

/// The 1-based property indices `ipma` associates with `item`.
fn associations(ipma: &[u8], item: u32) -> Option<Vec<usize>> {
    let version = *ipma.first()?;
    let wide = ipma.get(3)? & 1 == 1;
    let entries = be32(ipma, 4)?;
    let mut at = 8;
    for _ in 0..entries {
        let id = if version < 1 {
            let id = u32::from(be16(ipma, at)?);
            at += 2;
            id
        } else {
            let id = be32(ipma, at)?;
            at += 4;
            id
        };
        let count = usize::from(*ipma.get(at)?);
        at += 1;
        let mut found = Vec::with_capacity(count);
        for _ in 0..count {
            if wide {
                found.push(usize::from(be16(ipma, at)? & 0x7fff));
                at += 2;
            } else {
                found.push(usize::from(ipma.get(at)? & 0x7f));
                at += 1;
            }
        }
        if id == item {
            return Some(found);
        }
    }
    None
}

fn clean_aperture(body: &[u8]) -> Option<CleanAperture> {
    let signed = |at: usize| be32(body, at).map(|value| i64::from(value as i32));
    Some(CleanAperture {
        width: Fraction::new(i64::from(be32(body, 0)?), be32(body, 4)?)?,
        height: Fraction::new(i64::from(be32(body, 8)?), be32(body, 12)?)?,
        horizontal_offset: Fraction::new(signed(16)?, be32(body, 20)?)?,
        vertical_offset: Fraction::new(signed(24)?, be32(body, 28)?)?,
    })
}

fn colour(body: &[u8]) -> Option<Colour> {
    match body.get(..4)? {
        b"nclx" => Some(Colour::Nclx { matrix: be16(body, 8)?, full_range: body.get(10)? & 0x80 != 0 }),
        b"prof" | b"rICC" => Some(Colour::Icc(body[4..].to_vec())),
        _ => None,
    }
}

/// Reads the primary item's description out of `bytes`.
pub(crate) fn read(bytes: &[u8]) -> Container {
    let mut container = Container::default();
    let Some(meta) = find(bytes, b"meta").and_then(|body| body.get(4..)) else { return container };
    let Some(item) = primary_item_id(meta) else { return container };
    container.item_type = item_type_of(meta, item);
    let Some(iprp) = find(meta, b"iprp") else { return container };
    let (Some(ipco), Some(ipma)) = (find(iprp, b"ipco"), find(iprp, b"ipma")) else { return container };
    let properties: Vec<Boxed<'_>> = boxes(ipco).collect();
    for index in associations(ipma, item).unwrap_or_default() {
        let Some(property) = index.checked_sub(1).and_then(|at| properties.get(at)) else { continue };
        match &property.kind {
            b"clap" => container.transforms.extend(clean_aperture(property.body).map(Transform::Crop)),
            b"irot" => container.transforms.extend(property.body.first().map(|angle| Transform::Rotate(angle & 3)).filter(|turn| *turn != Transform::Rotate(0))),
            b"imir" => container.transforms.extend(property.body.first().map(|axis| Transform::Mirror(axis & 1))),
            b"colr" => container.colours.extend(colour(property.body)),
            _ => {}
        }
    }
    container
}

/// How much of a HEIF file there is, by what libheif says when it stops.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Shape {
    /// Nothing follows the `ftyp` box (or it is cut short).
    TooSmall,
    /// A `meta` box starts but does not end inside the file (libheif reads the whole box before any of its children).
    MetaIncomplete,
    /// Every top-level box that starts ends.
    Whole,
}

/// Where `bytes` stops being a HEIF file.
pub(crate) fn shape(bytes: &[u8]) -> Shape {
    let mut rest = bytes;
    let mut seen = 0;
    while rest.len() >= 8 {
        let size = usize::try_from(u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]])).unwrap_or(usize::MAX);
        let size = if size == 0 { rest.len() } else { size };
        if size > rest.len() {
            return if seen == 0 {
                Shape::TooSmall
            } else if &rest[4..8] == b"meta" {
                Shape::MetaIncomplete
            } else {
                Shape::Whole
            };
        }
        seen += 1;
        rest = &rest[size.max(8)..];
    }
    if seen <= 1 { Shape::TooSmall } else { Shape::Whole }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = u32::try_from(8 + body.len()).unwrap().to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(body);
        out
    }

    fn full(kind: &[u8; 4], version: u8, body: &[u8]) -> Vec<u8> {
        whole(kind, &[&[version, 0, 0, 0][..], body].concat())
    }

    /// A file with one item (id 1, type `item_type`) and the given property boxes, all associated with it.
    fn file(item_type: &[u8; 4], properties: &[Vec<u8>]) -> Vec<u8> {
        let infe = full(b"infe", 2, &[&[0, 1, 0, 0][..], item_type, &[0]].concat());
        let iinf = full(b"iinf", 0, &[&[0, 1][..], &infe].concat());
        let ipco = whole(b"ipco", &properties.concat());
        let mut association = vec![0, 1, u8::try_from(properties.len()).unwrap()];
        association.extend((1..=properties.len()).map(|index| u8::try_from(index).unwrap()));
        let ipma = full(b"ipma", 0, &[&[0, 0, 0, 1][..], &association].concat());
        let iprp = whole(b"iprp", &[ipco, ipma].concat());
        let meta = full(b"meta", 0, &[full(b"pitm", 0, &[0, 1]), iinf, full(b"iloc", 0, &[]), iprp].concat());
        [whole(b"ftyp", b"avif\0\0\0\0avif"), meta].concat()
    }

    fn clap_box(fields: [i64; 8]) -> Vec<u8> {
        whole(b"clap", &fields.iter().flat_map(|field| (*field as i32).to_be_bytes()).collect::<Vec<u8>>())
    }

    #[test]
    fn the_primary_items_type_transformations_and_colour_are_read_in_order() {
        let nclx = whole(b"colr", &[b"nclx".as_slice(), &[0, 1, 0, 13, 0, 1, 0x80]].concat());
        let bytes = file(b"hvc1", &[whole(b"irot", &[1]), whole(b"imir", &[1]), nclx]);
        let container = read(&bytes);
        assert_eq!(container.item_type, Some(*b"hvc1"));
        assert_eq!(container.transforms, [Transform::Rotate(1), Transform::Mirror(1)]);
        assert_eq!(container.colours, [Colour::Nclx { matrix: 1, full_range: true }]);
    }

    #[test]
    fn an_icc_profile_and_a_zero_turn_are_told_apart() {
        let icc = whole(b"colr", &[b"prof".as_slice(), &[1, 2, 3]].concat());
        let container = read(&file(b"av01", &[icc, whole(b"irot", &[4])]));
        assert_eq!(container.colours, [Colour::Icc(vec![1, 2, 3])]);
        assert!(container.transforms.is_empty());
    }

    #[test]
    fn a_container_that_does_not_parse_says_nothing() {
        let container = read(b"\0\0\0\x10ftypavif\0\0\0\0\0\0\0\x08meta");
        assert_eq!((container.item_type, container.transforms.len(), container.colours.len()), (None, 0, 0));
        assert!(read(&[]).transforms.is_empty());
    }

    #[test]
    fn a_centred_crop_keeps_the_middle_and_an_offset_moves_it() {
        let centred = clean_aperture(&clap_box([32, 1, 24, 1, 0, 1, 0, 1])[8..]).unwrap();
        assert_eq!(centred.window(64, 48), (16, 12, 32, 24));
        let moved = clean_aperture(&clap_box([30, 1, 20, 1, 2, 1, -3, 1])[8..]).unwrap();
        assert_eq!(moved.window(64, 48), (19, 11, 30, 20));
        let odd = clean_aperture(&clap_box([5, 1, 5, 1, 0, 1, 0, 1])[8..]).unwrap();
        assert_eq!(odd.window(10, 10), (2, 2, 5, 5));
        let outside = clean_aperture(&clap_box([40, 1, 40, 1, 100, 1, 100, 1])[8..]).unwrap();
        assert_eq!(outside.window(20, 20), (0, 0, 20, 20));
    }

    #[test]
    fn a_file_is_too_small_before_its_meta_box_and_incomplete_inside_it() {
        let whole_file = file(b"av01", &[]);
        let ftyp = 8 + 12;
        assert_eq!(shape(&whole_file), Shape::Whole);
        assert_eq!(shape(&whole_file[..ftyp]), Shape::TooSmall);
        assert_eq!(shape(&whole_file[..12]), Shape::TooSmall);
        assert_eq!(shape(&whole_file[..ftyp + 20]), Shape::MetaIncomplete);
        // Only the end of the meta box (its property boxes) is missing: still incomplete, as sharp recorded.
        assert_eq!(shape(&whole_file[..whole_file.len() - 6]), Shape::MetaIncomplete);
        // The meta box is whole and the item data after it is cut.
        let with_data = [whole_file, whole(b"mdat", &[0; 16])].concat();
        assert_eq!(shape(&with_data[..with_data.len() - 6]), Shape::Whole);
    }

    #[test]
    fn a_crop_with_a_zero_denominator_is_ignored() {
        assert!(clean_aperture(&clap_box([32, 0, 24, 1, 0, 1, 0, 1])[8..]).is_none());
    }
}
