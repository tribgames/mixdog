//! The vertical grid fitting FreeType's auto-hinter does in its light mode, which is what Skia's FreeType scaler leaves a
//! glyph with when the text is drawn with sub-pixel positioning (`@napi-rs/canvas` on Windows): the outline is scaled so
//! that the x-height lands on a whole pixel, the blue zones (baseline, x-height, cap height, ascender and descender) are
//! snapped to the pixel grid, the horizontal stems between them are placed on it (their width is not changed in light
//! mode), and every other point follows by interpolation. Nothing moves horizontally.
//!
//! This is the Latin module of the auto-hinter (`aflatin.c` and `afhints.c`) for the vertical dimension, in the same 26.6
//! and 16.16 integer arithmetic, so the pixel rows come out where FreeType's do. Hebrew goes through the same module with
//! the blue strings FreeType has for it (`afblue.dat`); Hangul, kana and the ideographs go through the CJK module
//! (`afcjk.c`): blue zones from its own strings, segments linked as in the Latin module, edges found with its width limit
//! and the nearest edge, no x-height fitting, and of its edge fitting the blue stage only (see `hint_edges`). Other
//! alphabets are hinted with the Latin blue zones.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;

use ttf_parser::GlyphId;
use ttf_parser::OutlineBuilder;

use crate::face::Face;

const DIR_NONE: i8 = 4;
const DIR_RIGHT: i8 = 1;
const DIR_UP: i8 = 2;
const DIR_LEFT: i8 = -1;
const DIR_DOWN: i8 = -2;

/// The kind of a contour point: on the curve, or a control point of a conic (quadratic) or cubic segment.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tag {
    On,
    Conic,
    Cubic,
}

/// A point of a glyph outline in font units.
#[derive(Clone, Copy, Debug)]
pub struct RawPoint {
    pub x: i32,
    pub y: i32,
    pub tag: Tag,
}

// ---- fixed point as FreeType does it ---------------------------------------------------------------------------------

fn mul_fix(a: i64, b: i64) -> i64 {
    let sign = if (a < 0) != (b < 0) { -1 } else { 1 };
    let product = (a.abs() * b.abs() + 0x8000) >> 16;
    sign * product
}

fn div_fix(a: i64, b: i64) -> i64 {
    if b == 0 {
        return 0x7fff_ffff;
    }
    let sign = if (a < 0) != (b < 0) { -1 } else { 1 };
    let (a, b) = (a.abs(), b.abs());
    sign * (((a << 16) + (b >> 1)) / b)
}

fn mul_div(a: i64, b: i64, c: i64) -> i64 {
    if c == 0 {
        return 0x7fff_ffff;
    }
    let sign = if ((a < 0) != (b < 0)) != (c < 0) { -1 } else { 1 };
    sign * ((a.abs() * b.abs() + (c.abs() >> 1)) / c.abs())
}

fn pix_round(value: i64) -> i64 {
    (value + 32) & !63
}

// ---- outlines --------------------------------------------------------------------------------------------------------

struct Gather {
    contours: Vec<Vec<RawPoint>>,
    current: Vec<RawPoint>,
}

impl Gather {
    fn finish(&mut self) {
        let mut contour = std::mem::take(&mut self.current);
        if contour.len() > 1 {
            let (first, last) = (contour[0], contour[contour.len() - 1]);
            if last.tag == Tag::On && last.x == first.x && last.y == first.y {
                contour.pop();
            }
        }
        if !contour.is_empty() {
            self.contours.push(contour);
        }
    }

    fn push(&mut self, x: f32, y: f32, tag: Tag) {
        self.current.push(RawPoint { x: x.round() as i32, y: y.round() as i32, tag });
    }
}

impl OutlineBuilder for Gather {
    fn move_to(&mut self, x: f32, y: f32) {
        self.finish();
        self.push(x, y, Tag::On);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        self.push(x, y, Tag::On);
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.push(x1, y1, Tag::Conic);
        self.push(x, y, Tag::On);
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.push(x1, y1, Tag::Cubic);
        self.push(x2, y2, Tag::Cubic);
        self.push(x, y, Tag::On);
    }

    fn close(&mut self) {
        self.finish();
    }
}

/// The contours of a glyph as the font stores them: the on-curve points a quadratic outline implies between two control
/// points are not points of the outline.
pub fn raw_outline(face: &ttf_parser::Face<'_>, glyph: u16) -> Option<Vec<Vec<RawPoint>>> {
    let mut gather = Gather { contours: Vec::new(), current: Vec::new() };
    face.outline_glyph(GlyphId(glyph), &mut gather)?;
    gather.finish();
    let mut contours = Vec::new();
    for contour in gather.contours {
        let n = contour.len();
        let mut kept = Vec::with_capacity(n);
        for (index, point) in contour.iter().enumerate() {
            if point.tag == Tag::On && n >= 3 {
                let (before, after) = (contour[(index + n - 1) % n], contour[(index + 1) % n]);
                if before.tag == Tag::Conic && after.tag == Tag::Conic && point.x * 2 == before.x + after.x && point.y * 2 == before.y + after.y {
                    continue;
                }
            }
            kept.push(*point);
        }
        if kept.len() > 1 {
            contours.push(kept);
        }
    }
    Some(contours)
}

/// `FT_Outline_Get_Orientation`: true when the outer contours run clockwise with y up (the TrueType convention).
fn is_truetype_orientation(contours: &[Vec<RawPoint>]) -> bool {
    let mut area: i64 = 0;
    for contour in contours {
        let n = contour.len();
        for index in 0..n {
            let (a, b) = (contour[index], contour[(index + 1) % n]);
            area += i64::from(a.x) * i64::from(b.y) - i64::from(b.x) * i64::from(a.y);
        }
    }
    area <= 0
}

// ---- metrics of a face -----------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Blue {
    ref_org: i64,
    shoot_org: i64,
    top: bool,
    adjustment: bool,
    ascender: i64,
    descender: i64,
}

/// The blue zones and standard stem widths of one script's style of a face, in font units.
#[derive(Debug)]
struct Zones {
    blues: Vec<Blue>,
    widths: Vec<i64>,
    edge_distance_threshold: i64,
}

/// What the auto-hinter learns about a face once: its blue zones and its standard stem widths, per script module, in font
/// units. The Hebrew and CJK ones are worked out the first time a glyph of that script is hinted.
#[derive(Debug)]
pub struct Metrics {
    upem: i64,
    latin: Zones,
    hebrew: OnceLock<Zones>,
    cjk: OnceLock<Zones>,
}

/// The script module that grid-fits a character.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Script {
    Latin,
    Hebrew,
    Cjk,
}

struct BlueString {
    chars: &'static str,
    top: bool,
    adjustment: bool,
}

const LATIN_STRINGS: [BlueString; 6] = [
    BlueString { chars: "THEZOCQS", top: true, adjustment: false },
    BlueString { chars: "HEZLOCUS", top: false, adjustment: false },
    BlueString { chars: "fijkdbh", top: true, adjustment: false },
    BlueString { chars: "uvxzoesc", top: true, adjustment: true },
    BlueString { chars: "nrxzoesc", top: false, adjustment: false },
    BlueString { chars: "pqgjy", top: false, adjustment: false },
];

/// `afblue.dat`, Hebrew: the tops of ascending letters, the bottoms of the letters on the baseline and the descenders.
const HEBREW_STRINGS: [BlueString; 3] = [
    BlueString { chars: "\u{5d1}\u{5d3}\u{5d4}\u{5d7}\u{5da}\u{5db}\u{5dd}\u{5e1}", top: true, adjustment: false },
    BlueString { chars: "\u{5d1}\u{5d8}\u{5db}\u{5dd}\u{5e1}\u{5e6}", top: false, adjustment: false },
    BlueString { chars: "\u{5e7}\u{5da}\u{5df}\u{5e3}\u{5e5}", top: false, adjustment: false },
];

/// `afblue.dat`, CJK (vertical zones): the characters whose top (or bottom) edge defines the zone. A `|` would start the
/// characters that define the flat value, those before it define the filled one.
const CJK_TOP: &str = "\u{4ed6}\u{4eec}\u{4f60}\u{4f86}\u{5011}\u{5230}\u{548c}\u{5730}\u{5979}\u{5c06}\u{5c07}\u{5c31}\u{5e74}\u{5f97}\u{60c5}\u{6700}\u{6837}\u{6a23}\u{7406}\u{80fd}\u{8aaa}\u{8fd9}\u{901a}";
const CJK_BOTTOM: &str = "\u{4e2a}\u{4eec}\u{4f60}\u{4f86}\u{5011}\u{5230}\u{548c}\u{5730}\u{5979}\u{5c06}\u{5c07}\u{5c31}\u{5e74}\u{5f97}\u{60c5}\u{6700}\u{6837}\u{6a23}\u{7406}\u{80fd}\u{8aaa}\u{8fd9}\u{901a}";

/// The module a character is hinted by (`af_get_char_index` picks the style from the script of the character).
pub fn script_of(character: char) -> Script {
    match character as u32 {
        0x0590..=0x05FF | 0xFB1D..=0xFB4F => Script::Hebrew,
        0x1100..=0x11FF
        | 0x2E80..=0x2FDF
        | 0x3000..=0x30FF
        | 0x3100..=0x312F
        | 0x3130..=0x318F
        | 0x3190..=0x31FF
        | 0x3200..=0x33FF
        | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF
        | 0xA960..=0xA97F
        | 0xAC00..=0xD7FF
        | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F
        | 0xFF00..=0xFFEF
        | 0x20000..=0x2FFFF => Script::Cjk,
        _ => Script::Latin,
    }
}

impl Metrics {
    fn new(face: &ttf_parser::Face<'_>) -> Self {
        let upem = i64::from(face.units_per_em().max(1));
        Self { upem, latin: Zones::latin(face, upem, &LATIN_STRINGS, 'o'), hebrew: OnceLock::new(), cjk: OnceLock::new() }
    }

    fn zones(&self, face: &ttf_parser::Face<'_>, script: Script) -> &Zones {
        match script {
            Script::Latin => &self.latin,
            Script::Hebrew => self.hebrew.get_or_init(|| Zones::latin(face, self.upem, &HEBREW_STRINGS, '\u{5dd}')),
            Script::Cjk => self.cjk.get_or_init(|| Zones::cjk(face, self.upem)),
        }
    }
}

/// The reference and overshoot values of a zone from the extremum values found for its characters (the median of each).
fn zone_of(rounds: &mut [i64], flats: &mut [i64], top: bool, adjustment: bool, ascender: i64, descender: i64) -> Option<Blue> {
    if flats.is_empty() && rounds.is_empty() {
        return None;
    }
    rounds.sort_unstable();
    flats.sort_unstable();
    let (mut reference, mut shoot) = if flats.is_empty() {
        let value = rounds[rounds.len() / 2];
        (value, value)
    } else if rounds.is_empty() {
        let value = flats[flats.len() / 2];
        (value, value)
    } else {
        (flats[flats.len() / 2], rounds[rounds.len() / 2])
    };
    if shoot != reference {
        let over_ref = shoot > reference;
        if top ^ over_ref {
            let middle = (shoot + reference) / 2;
            reference = middle;
            shoot = middle;
        }
    }
    Some(Blue { ref_org: reference, shoot_org: shoot, top, adjustment, ascender, descender })
}

impl Zones {
    fn latin(face: &ttf_parser::Face<'_>, upem: i64, strings: &[BlueString], standard: char) -> Self {
        let blues = latin_blues(face, upem, strings);
        let (widths, edge_distance_threshold) = widths_of(face, upem, standard);
        Self { blues, widths, edge_distance_threshold }
    }

    /// `af_cjk_metrics_init_blues` (vertical) and `af_cjk_metrics_init_widths` (the standard character is U+7530).
    fn cjk(face: &ttf_parser::Face<'_>, upem: i64) -> Self {
        let mut blues = Vec::new();
        for (string, top) in [(CJK_TOP, true), (CJK_BOTTOM, false)] {
            let (mut fills, mut flats): (Vec<i64>, Vec<i64>) = (Vec::new(), Vec::new());
            let mut fill = true;
            let (mut ascender, mut descender) = (i64::MIN, i64::MAX);
            for character in string.chars() {
                if character == '|' {
                    fill = false;
                    continue;
                }
                let Some(glyph) = face.glyph_index(character) else { continue };
                let Some(contours) = raw_outline(face, glyph.0) else { continue };
                if contours.iter().map(Vec::len).sum::<usize>() <= 2 {
                    continue;
                }
                let mut best: Option<i64> = None;
                for contour in contours.iter().filter(|contour| contour.len() > 1) {
                    for point in contour {
                        let y = i64::from(point.y);
                        ascender = ascender.max(y);
                        descender = descender.min(y);
                        if best.is_none_or(|current| if top { y > current } else { y < current }) {
                            best = Some(y);
                        }
                    }
                }
                let Some(best) = best else { continue };
                if fill {
                    fills.push(best);
                } else {
                    flats.push(best);
                }
            }
            if let Some(blue) = zone_of(&mut fills, &mut flats, top, false, ascender, descender) {
                blues.push(blue);
            }
        }
        let (widths, edge_distance_threshold) = widths_of(face, upem, '\u{7530}');
        Self { blues, widths, edge_distance_threshold }
    }
}

fn latin_blues(face: &ttf_parser::Face<'_>, upem: i64, strings: &[BlueString]) -> Vec<Blue> {
    let mut blues = Vec::new();
    let flat_threshold = upem / 14;
    for string in strings {
            let (mut rounds, mut flats): (Vec<i64>, Vec<i64>) = (Vec::new(), Vec::new());
            let (mut ascender, mut descender) = (i64::MIN, i64::MAX);
            for character in string.chars.chars() {
                let Some(glyph) = face.glyph_index(character) else { continue };
                let Some(contours) = raw_outline(face, glyph.0) else { continue };
                let mut best: Option<(usize, usize)> = None;
                let mut best_y = 0_i64;
                for (index, contour) in contours.iter().enumerate() {
                    if contour.len() < 2 {
                        continue;
                    }
                    for (at, point) in contour.iter().enumerate() {
                        let y = i64::from(point.y);
                        ascender = ascender.max(y);
                        descender = descender.min(y);
                        let better = match best {
                            None => true,
                            Some(_) => {
                                if string.top {
                                    y > best_y
                                } else {
                                    y < best_y
                                }
                            }
                        };
                        if better {
                            best = Some((index, at));
                            best_y = y;
                        }
                    }
                }
                let Some((index, at)) = best else { continue };
                let contour = &contours[index];
                let n = contour.len();
                let best_x = i64::from(contour[at].x);
                let (mut first_seg, mut last_seg) = (at, at);
                let (mut on_first, mut on_last): (Option<usize>, Option<usize>) = if contour[at].tag == Tag::On { (Some(at), Some(at)) } else { (None, None) };
                let mut prev = at;
                loop {
                    prev = (prev + n - 1) % n;
                    let dist = (i64::from(contour[prev].y) - best_y).abs();
                    if dist > 5 && (i64::from(contour[prev].x) - best_x).abs() <= 20 * dist {
                        break;
                    }
                    first_seg = prev;
                    if contour[prev].tag == Tag::On {
                        on_first = Some(prev);
                        if on_last.is_none() {
                            on_last = Some(prev);
                        }
                    }
                    if prev == at {
                        break;
                    }
                }
                let mut next = at;
                loop {
                    next = (next + 1) % n;
                    let dist = (i64::from(contour[next].y) - best_y).abs();
                    if dist > 5 && (i64::from(contour[next].x) - best_x).abs() <= 20 * dist {
                        break;
                    }
                    last_seg = next;
                    if contour[next].tag == Tag::On {
                        on_last = Some(next);
                        if on_first.is_none() {
                            on_first = Some(next);
                        }
                    }
                    if next == at {
                        break;
                    }
                }
                let round = match (on_first, on_last) {
                    (Some(a), Some(b)) if (i64::from(contour[b].x) - i64::from(contour[a].x)).abs() > flat_threshold => false,
                    _ => contour[first_seg].tag != Tag::On || contour[last_seg].tag != Tag::On,
                };
                if round {
                    rounds.push(best_y);
                } else {
                    flats.push(best_y);
                }
            }
            let Some(blue) = zone_of(&mut rounds, &mut flats, string.top, string.adjustment, ascender, descender) else { continue };
            blues.push(blue);
    }
    blues
}

/// `af_latin_metrics_init_widths` (and its CJK twin): the stem widths of the standard character, almost identical ones
/// merged, and the edge distance threshold taken from the narrowest.
fn widths_of(face: &ttf_parser::Face<'_>, upem: i64, standard: char) -> (Vec<i64>, i64) {
    let mut stem_widths: Vec<i64> = Vec::new();
    if let Some(glyph) = face.glyph_index(standard) {
        if let Some(contours) = raw_outline(face, glyph.0) {
            let truetype = is_truetype_orientation(&contours);
            let mut hints = Hints::load(&contours, upem, truetype);
            hints.compute_segments();
            hints.link_segments(0);
            for (index, segment) in hints.segments.iter().enumerate() {
                if let Some(link) = segment.link {
                    if hints.segments[link].link == Some(index) && link > index {
                        stem_widths.push((segment.pos - hints.segments[link].pos).abs());
                    }
                }
            }
        }
    }
    stem_widths.sort_unstable();
    // Almost identical widths become one (the mean of each cluster within a hundredth of the em).
    let threshold = upem / 100;
    let mut widths: Vec<i64> = Vec::new();
    let mut at = 0;
    while at < stem_widths.len() {
        let first = stem_widths[at];
        let mut sum = 0;
        let mut count = 0;
        while at < stem_widths.len() && stem_widths[at] - first <= threshold {
            sum += stem_widths[at];
            count += 1;
            at += 1;
        }
        widths.push(sum / count);
    }
    let standard_width = widths.first().copied().unwrap_or(50 * upem / 2048);
    (widths, standard_width / 5)
}

// ---- one glyph -------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Pt {
    fx: i64,
    fy: i64,
    ox: i64,
    oy: i64,
    x: i64,
    y: i64,
    tag: Tag,
    in_dir: i8,
    out_dir: i8,
    weak: bool,
    touched: bool,
}

#[derive(Clone)]
struct Segment {
    dir: i8,
    contour: usize,
    first: usize,
    last: usize,
    round: bool,
    pos: i64,
    min_coord: i64,
    max_coord: i64,
    /// Half the spread of the segment's heights (`segment->delta`) and its extent along the stem (`segment->height`).
    delta: i64,
    height: i64,
    link: Option<usize>,
    serif: Option<usize>,
    score: i64,
    edge: Option<usize>,
}

#[derive(Clone)]
struct Edge {
    fpos: i64,
    opos: i64,
    pos: i64,
    dir: i8,
    round: bool,
    link: Option<usize>,
    serif: Option<usize>,
    blue: Option<(usize, bool)>,
    segments: Vec<usize>,
    done: bool,
    scale: i64,
}

struct Hints {
    points: Vec<Pt>,
    contours: Vec<std::ops::Range<usize>>,
    upem: i64,
    major_dir: i8,
    segments: Vec<Segment>,
    edges: Vec<Edge>,
    /// The edges are found as the CJK module does (`af_cjk_hints_compute_edges`).
    cjk: bool,
}

fn direction(dx: i64, dy: i64) -> i8 {
    let (dir, long, short) = if dy >= dx {
        if dy >= -dx { (DIR_UP, dy, dx) } else { (DIR_LEFT, -dx, dy) }
    } else if dy >= -dx {
        (DIR_RIGHT, dx, dy)
    } else {
        (DIR_DOWN, -dy, dx)
    };
    if long.abs() <= (short * 14).abs() { DIR_NONE } else { dir }
}

fn hypot_approx(x: i64, y: i64) -> i64 {
    let (x, y) = (x.abs(), y.abs());
    let (long, short) = if x > y { (x, y) } else { (y, x) };
    long + (3 * short >> 3)
}

fn corner_is_flat(in_x: i64, in_y: i64, out_x: i64, out_y: i64) -> bool {
    let (ax, ay) = (in_x + out_x, in_y + out_y);
    let (d_in, d_out, d_hypot) = (hypot_approx(in_x, in_y), hypot_approx(out_x, out_y), hypot_approx(ax, ay));
    d_in + d_out - d_hypot < (d_hypot >> 4)
}

impl Hints {
    /// The glyph's points in font units, with their directions and weak flags (`af_glyph_hints_reload`).
    fn load(contours: &[Vec<RawPoint>], upem: i64, truetype: bool) -> Self {
        let mut points = Vec::new();
        let mut ranges = Vec::new();
        for contour in contours {
            let start = points.len();
            for point in contour {
                points.push(Pt {
                    fx: i64::from(point.x),
                    fy: i64::from(point.y),
                    ox: 0,
                    oy: 0,
                    x: 0,
                    y: 0,
                    tag: point.tag,
                    in_dir: DIR_NONE,
                    out_dir: DIR_NONE,
                    weak: false,
                    touched: false,
                });
            }
            ranges.push(start..points.len());
        }
        for range in &ranges {
            let n = range.len();
            for offset in 0..n {
                let (here, before, after) = (range.start + offset, range.start + (offset + n - 1) % n, range.start + (offset + 1) % n);
                let (in_x, in_y) = (points[here].fx - points[before].fx, points[here].fy - points[before].fy);
                let (out_x, out_y) = (points[after].fx - points[here].fx, points[after].fy - points[here].fy);
                let (in_dir, out_dir) = (direction(in_x, in_y), direction(out_x, out_y));
                let mut weak = false;
                if points[here].tag != Tag::On {
                    weak = true;
                } else if out_dir == in_dir {
                    if out_dir != DIR_NONE || corner_is_flat(in_x, in_y, out_x, out_y) {
                        weak = true;
                    }
                } else if out_dir == -in_dir {
                    weak = true;
                }
                points[here].in_dir = in_dir;
                points[here].out_dir = out_dir;
                points[here].weak = weak;
            }
        }
        // The lower edge of a stem is the major direction: it runs left for clockwise contours, right for the others.
        let major_dir = if truetype { DIR_LEFT } else { DIR_RIGHT };
        Self { points, contours: ranges, upem, major_dir, segments: Vec::new(), edges: Vec::new(), cjk: false }
    }

    fn next_of(&self, contour: usize, index: usize) -> usize {
        let range = &self.contours[contour];
        if index + 1 == range.end { range.start } else { index + 1 }
    }

    fn prev_of(&self, contour: usize, index: usize) -> usize {
        let range = &self.contours[contour];
        if index == range.start { range.end - 1 } else { index - 1 }
    }

    /// `af_latin_hints_compute_segments` for the vertical dimension: runs of points that go along the major direction (or
    /// against it) are the segments of horizontal stems.
    fn compute_segments(&mut self) {
        self.segments.clear();
        let major = self.major_dir;
        let flat_threshold = self.upem / 14;
        let mut segment_dir = major;
        loop {
            for contour in 0..self.contours.len() {
                let range = self.contours[contour].clone();
                if range.len() < 2 {
                    continue;
                }
                let mut point = range.start;
                let mut last = self.prev_of(contour, point);
                if self.points[last].out_dir.abs() == major.abs() && self.points[point].out_dir.abs() == major.abs() {
                    // Already on an edge: find where it starts.
                    last = point;
                    loop {
                        point = self.prev_of(contour, point);
                        if self.points[point].out_dir.abs() != major.abs() {
                            point = self.next_of(contour, point);
                            break;
                        }
                        if point == last {
                            break;
                        }
                    }
                }
                last = point;
                let mut passed = false;
                let mut on_edge = false;
                let (mut min_pos, mut max_pos) = (i64::MAX, i64::MIN);
                let (mut min_on_pos, mut max_on_pos) = (32000_i64, -32000_i64);
                let mut current: Option<usize> = None;
                loop {
                    if on_edge {
                        let u = self.points[point].fy;
                        min_pos = min_pos.min(u);
                        max_pos = max_pos.max(u);
                        if self.points[point].tag == Tag::On {
                            min_on_pos = min_on_pos.min(u);
                            max_on_pos = max_on_pos.max(u);
                        }
                        if self.points[point].out_dir != segment_dir || point == last {
                            if let Some(index) = current.take() {
                                let first = self.segments[index].first;
                                let control = self.points[first].tag != Tag::On || self.points[point].tag != Tag::On;
                                let segment = &mut self.segments[index];
                                segment.last = point;
                                segment.pos = (min_pos + max_pos) >> 1;
                                if control && (max_on_pos - min_on_pos) < flat_threshold {
                                    segment.round = true;
                                }
                                let v_last = self.points[point].fx;
                                let v_first = self.points[first].fx;
                                segment.min_coord = v_last.min(v_first);
                                segment.max_coord = v_last.max(v_first);
                                segment.height = segment.max_coord - segment.min_coord;
                                segment.delta = (max_pos - min_pos) >> 1;
                            }
                            on_edge = false;
                        }
                    }
                    if point == last {
                        if passed {
                            break;
                        }
                        passed = true;
                    }
                    if !on_edge && self.points[point].out_dir == segment_dir {
                        let u = self.points[point].fy;
                        min_pos = u;
                        max_pos = u;
                        if self.points[point].tag == Tag::On {
                            min_on_pos = u;
                            max_on_pos = u;
                        } else {
                            min_on_pos = 32000;
                            max_on_pos = -32000;
                        }
                        self.segments.push(Segment {
                            dir: segment_dir,
                            contour,
                            first: point,
                            last: point,
                            round: false,
                            pos: u,
                            min_coord: self.points[point].fx,
                            max_coord: self.points[point].fx,
                            delta: 0,
                            height: 0,
                            link: None,
                            serif: None,
                            score: 32000,
                            edge: None,
                        });
                        current = Some(self.segments.len() - 1);
                        on_edge = true;
                    }
                    point = self.next_of(contour, point);
                }
            }
            if segment_dir == major {
                segment_dir = -major;
            } else {
                break;
            }
        }
    }

    /// `af_latin_hints_link_segments`: pairs the segments that form the two sides of a stem.
    fn link_segments(&mut self, max_width: i64) {
        let len_threshold = (8 * self.upem / 2048).max(1);
        let len_score = 6000 * self.upem / 2048;
        let dist_score = 3000;
        let count = self.segments.len();
        for index1 in 0..count {
            if self.segments[index1].dir != self.major_dir {
                continue;
            }
            for index2 in 0..count {
                if index1 == index2 {
                    continue;
                }
                let (dir1, dir2) = (self.segments[index1].dir, self.segments[index2].dir);
                if dir1 + dir2 != 0 || self.segments[index2].pos <= self.segments[index1].pos {
                    continue;
                }
                let dist = self.segments[index2].pos - self.segments[index1].pos;
                let min = self.segments[index1].min_coord.max(self.segments[index2].min_coord);
                let max = self.segments[index1].max_coord.min(self.segments[index2].max_coord);
                let len = max - min;
                if len >= len_threshold {
                    let dist_demerit = if max_width != 0 {
                        let delta = (dist << 10) / max_width - (1 << 10);
                        if delta > 10000 {
                            32000
                        } else if delta > 0 {
                            delta * delta / dist_score
                        } else {
                            0
                        }
                    } else {
                        dist
                    };
                    let score = dist_demerit + len_score / len;
                    if score < self.segments[index1].score {
                        self.segments[index1].score = score;
                        self.segments[index1].link = Some(index2);
                    }
                    if score < self.segments[index2].score {
                        self.segments[index2].score = score;
                        self.segments[index2].link = Some(index1);
                    }
                }
            }
        }
        for index in 0..count {
            if let Some(other) = self.segments[index].link {
                if self.segments[other].link != Some(index) {
                    self.segments[index].link = None;
                    self.segments[index].serif = self.segments[other].link;
                }
            }
        }
    }

    /// `af_latin_hints_compute_edges`: segments at the same height become one edge.
    fn compute_edges(&mut self, edge_distance_threshold: i64, scale: i64) {
        let mut threshold = mul_fix(edge_distance_threshold, scale);
        if threshold > 64 / 4 {
            threshold = 64 / 4;
        }
        let threshold = div_fix(threshold, scale);
        // The CJK module leaves out the segments wider than a pixel (their spread is more than half a pixel either way) and
        // puts a segment on the nearest edge instead of the first one in reach.
        let width_threshold = div_fix(32, scale);
        let cjk = self.cjk;
        let mut edges: Vec<Edge> = Vec::new();
        for index in 0..self.segments.len() {
            let segment = &self.segments[index];
            if segment.dir == DIR_NONE || (cjk && segment.delta > width_threshold) {
                continue;
            }
            let reaches = |edge: &Edge| (segment.pos - edge.fpos).abs() < threshold && edge.dir == segment.dir;
            let found = if cjk {
                edges.iter().enumerate().filter(|(_, edge)| reaches(edge)).min_by_key(|(at, edge)| ((segment.pos - edge.fpos).abs(), *at)).map(|(at, _)| at)
            } else {
                edges.iter().position(reaches)
            };
            match found {
                Some(at) => edges[at].segments.push(index),
                None => edges.push(Edge {
                    fpos: segment.pos,
                    opos: mul_fix(segment.pos, scale),
                    pos: mul_fix(segment.pos, scale),
                    dir: segment.dir,
                    round: false,
                    link: None,
                    serif: None,
                    blue: None,
                    segments: vec![index],
                    done: false,
                    scale: 0,
                }),
            }
        }
        // Sorted by height, stable: a new edge goes after the edges at the same height.
        let mut order: Vec<usize> = (0..edges.len()).collect();
        order.sort_by_key(|at| edges[*at].fpos);
        let mut position_of = vec![0; edges.len()];
        for (new, old) in order.iter().enumerate() {
            position_of[*old] = new;
        }
        let mut sorted: Vec<Edge> = order.iter().map(|old| edges[*old].clone()).collect();
        for (index, edge) in sorted.iter().enumerate() {
            for segment in &edge.segments {
                self.segments[*segment].edge = Some(index);
            }
        }
        for index in 0..sorted.len() {
            let (mut is_round, mut is_straight) = (0, 0);
            let (mut link, mut serif) = (sorted[index].link, sorted[index].serif);
            for &segment_index in &sorted[index].segments.clone() {
                let segment = self.segments[segment_index].clone();
                if segment.round {
                    is_round += 1;
                } else {
                    is_straight += 1;
                }
                let is_serif = segment.serif.is_some_and(|other| self.segments[other].edge.is_some_and(|edge| edge != index));
                let linked = segment.link.is_some_and(|other| self.segments[other].edge.is_some());
                if linked || is_serif {
                    let (mut other_edge, other_segment) = if is_serif { (serif, segment.serif) } else { (link, segment.link) };
                    let Some(other_segment) = other_segment else { continue };
                    match other_edge {
                        Some(existing) => {
                            let edge_delta = (sorted[index].fpos - sorted[existing].fpos).abs();
                            let seg_delta = (segment.pos - self.segments[other_segment].pos).abs();
                            if seg_delta < edge_delta {
                                other_edge = self.segments[other_segment].edge;
                            }
                        }
                        None => other_edge = self.segments[other_segment].edge,
                    }
                    if is_serif {
                        serif = other_edge;
                        if cjk {
                            if let Some(other) = other_edge {
                                sorted[other].serif = Some(index);
                            }
                        }
                    } else {
                        link = other_edge;
                    }
                }
            }
            sorted[index].link = link;
            sorted[index].serif = serif;
            sorted[index].round = is_round > 0 && is_round >= is_straight;
            if sorted[index].serif.is_some() && sorted[index].link.is_some() {
                sorted[index].serif = None;
            }
        }
        // The edges' serif and link point at edges, so a stem edge is marked as a serif target here.
        self.edges = sorted;
    }

    /// `af_latin_hints_compute_blue_edges`: the blue zone each edge belongs to, if any.
    fn compute_blue_edges(&mut self, blues: &[ScaledBlue], upem: i64, scale: i64) {
        for edge in &mut self.edges {
            let mut best_dist = mul_fix(upem / 40, scale);
            if best_dist > 32 {
                best_dist = 32;
            }
            let mut best: Option<(usize, bool)> = None;
            for (index, blue) in blues.iter().enumerate() {
                if !blue.active {
                    continue;
                }
                let is_major_dir = edge.dir == self.major_dir;
                if blue.top ^ is_major_dir {
                    let mut dist = mul_fix((edge.fpos - blue.ref_org).abs(), scale);
                    if dist < best_dist {
                        best_dist = dist;
                        best = Some((index, false));
                    }
                    if edge.round && dist != 0 {
                        let is_under_ref = edge.fpos < blue.ref_org;
                        if blue.top ^ is_under_ref {
                            dist = mul_fix((edge.fpos - blue.shoot_org).abs(), scale);
                            if dist < best_dist {
                                best_dist = dist;
                                best = Some((index, true));
                            }
                        }
                    }
                }
            }
            if best.is_some() {
                edge.blue = best;
            }
        }
    }

    /// `af_latin_hint_edges`: where each edge ends up, in 26.6 pixels.
    fn hint_edges(&mut self, blues: &[ScaledBlue]) {
        let count = self.edges.len();
        let mut anchor: Option<usize> = None;
        let mut has_serifs = 0;
        let fit_of = |edge: &Edge| -> i64 {
            let (index, shoot) = edge.blue.expect("a blue edge");
            if shoot { blues[index].shoot_fit } else { blues[index].ref_fit }
        };
        for index in 0..count {
            if self.edges[index].done {
                continue;
            }
            let mut edge1 = None;
            let mut edge2 = self.edges[index].link;
            if self.edges[index].blue.is_some() {
                edge1 = Some(index);
            } else if let Some(other) = edge2 {
                if self.edges[other].blue.is_some() {
                    edge1 = Some(other);
                    edge2 = Some(index);
                }
            }
            let Some(edge1) = edge1 else { continue };
            self.edges[edge1].pos = fit_of(&self.edges[edge1]);
            self.edges[edge1].done = true;
            if let Some(edge2) = edge2 {
                if self.edges[edge2].blue.is_none() {
                    self.align_linked(edge1, edge2);
                    self.edges[edge2].done = true;
                }
            }
            if anchor.is_none() {
                anchor = Some(index);
            }
        }
        // The CJK module stops here: an edge that is no blue edge and no stem of one keeps its own place (the point
        // alignment that follows still moves what lies between the fitted edges). The recorded pixels show the stems of
        // Hangul at their unhinted rows; placing them as the Latin module does (the stem and serif stages of
        // `af_cjk_hint_edges`, which this file ports for Latin) moved them by up to 0.8 px and left the recorded line
        // further from Skia's (largest 4x4 block 35.6 against 22.6 with the blue stage alone).
        if self.cjk {
            return;
        }
        for index in 0..count {
            if self.edges[index].done {
                continue;
            }
            let Some(edge2) = self.edges[index].link else {
                has_serifs += 1;
                continue;
            };
            if self.edges[edge2].blue.is_some() {
                self.align_linked(edge2, index);
                self.edges[index].done = true;
                continue;
            }
            match anchor {
                None => {
                    let org_len = self.edges[edge2].opos - self.edges[index].opos;
                    let cur_len = org_len;
                    let (u_off, d_off) = if cur_len <= 64 { (32, 32) } else { (38, 26) };
                    if cur_len < 96 {
                        let org_center = self.edges[index].opos + (org_len >> 1);
                        let mut cur_pos1 = pix_round(org_center);
                        let error1 = (org_center - (cur_pos1 - u_off)).abs();
                        let error2 = (org_center - (cur_pos1 + d_off)).abs();
                        if error1 < error2 {
                            cur_pos1 -= u_off;
                        } else {
                            cur_pos1 += d_off;
                        }
                        self.edges[index].pos = cur_pos1 - cur_len / 2;
                        self.edges[edge2].pos = self.edges[index].pos + cur_len;
                    } else {
                        self.edges[index].pos = pix_round(self.edges[index].opos);
                    }
                    anchor = Some(index);
                    self.edges[index].done = true;
                    self.align_linked(index, edge2);
                }
                Some(anchor_index) => {
                    let anchor_pos = self.edges[anchor_index].pos;
                    let anchor_opos = self.edges[anchor_index].opos;
                    let mut org_pos = anchor_pos + (self.edges[index].opos - anchor_opos);
                    let mut org_len = self.edges[edge2].opos - self.edges[index].opos;
                    let mut org_center = org_pos + (org_len >> 1);
                    let cur_len = org_len;
                    if self.edges[edge2].done {
                        self.edges[index].pos = self.edges[edge2].pos - cur_len;
                    } else if cur_len < 96 {
                        let mut cur_pos1 = pix_round(org_center);
                        let (u_off, d_off) = if cur_len <= 64 { (32, 32) } else { (38, 26) };
                        let delta1 = (org_center - (cur_pos1 - u_off)).abs();
                        let delta2 = (org_center - (cur_pos1 + d_off)).abs();
                        if delta1 < delta2 {
                            cur_pos1 -= u_off;
                        } else {
                            cur_pos1 += d_off;
                        }
                        self.edges[index].pos = cur_pos1 - cur_len / 2;
                        self.edges[edge2].pos = cur_pos1 + cur_len / 2;
                    } else {
                        org_pos = anchor_pos + (self.edges[index].opos - anchor_opos);
                        org_len = self.edges[edge2].opos - self.edges[index].opos;
                        org_center = org_pos + (org_len >> 1);
                        let cur_pos1 = pix_round(org_pos);
                        let delta1 = (cur_pos1 + (cur_len >> 1) - org_center).abs();
                        let cur_pos2 = pix_round(org_pos + org_len) - cur_len;
                        let delta2 = (cur_pos2 + (cur_len >> 1) - org_center).abs();
                        self.edges[index].pos = if delta1 < delta2 { cur_pos1 } else { cur_pos2 };
                        self.edges[edge2].pos = self.edges[index].pos + cur_len;
                    }
                    self.edges[index].done = true;
                    self.edges[edge2].done = true;
                    if index > 0 && self.edges[index].pos < self.edges[index - 1].pos {
                        self.edges[index].pos = self.edges[index - 1].pos;
                    }
                }
            }
        }
        if has_serifs > 0 || anchor.is_none() {
            for index in 0..count {
                if self.edges[index].done {
                    continue;
                }
                let mut delta = 1000;
                if let Some(serif) = self.edges[index].serif {
                    delta = (self.edges[serif].opos - self.edges[index].opos).abs();
                }
                if delta < 64 + 16 {
                    let serif = self.edges[index].serif.expect("a serif");
                    self.edges[index].pos = self.edges[serif].pos + (self.edges[index].opos - self.edges[serif].opos);
                } else if anchor.is_none() {
                    self.edges[index].pos = pix_round(self.edges[index].opos);
                    anchor = Some(index);
                } else {
                    let before = (0..index).rev().find(|at| self.edges[*at].done);
                    let after = (index + 1..count).find(|at| self.edges[*at].done);
                    if let (Some(before), Some(after)) = (before, after) {
                        if self.edges[after].opos == self.edges[before].opos {
                            self.edges[index].pos = self.edges[before].pos;
                        } else {
                            self.edges[index].pos = self.edges[before].pos
                                + mul_div(self.edges[index].opos - self.edges[before].opos, self.edges[after].pos - self.edges[before].pos, self.edges[after].opos - self.edges[before].opos);
                        }
                    } else {
                        let anchor_index = anchor.expect("an anchor");
                        self.edges[index].pos = self.edges[anchor_index].pos + ((self.edges[index].opos - self.edges[anchor_index].opos + 16) & !31);
                    }
                }
                self.edges[index].done = true;
                if index > 0 && self.edges[index].pos < self.edges[index - 1].pos {
                    self.edges[index].pos = self.edges[index - 1].pos;
                }
                if index + 1 < count && self.edges[index + 1].done && self.edges[index].pos > self.edges[index + 1].pos {
                    self.edges[index].pos = self.edges[index + 1].pos;
                }
            }
        }
    }

    /// `af_latin_align_linked_edge`: the stem keeps its width (light mode does not adjust stems).
    fn align_linked(&mut self, base: usize, stem: usize) {
        let dist = self.edges[stem].opos - self.edges[base].opos;
        self.edges[stem].pos = self.edges[base].pos + dist;
    }

    /// `af_glyph_hints_align_edge_points`, `align_strong_points` and `align_weak_points` for the vertical dimension.
    fn align_points(&mut self) {
        for edge in &self.edges {
            for &segment_index in &edge.segments {
                let (first, last) = (self.segments[segment_index].first, self.segments[segment_index].last);
                let contour = self.segments[segment_index].contour;
                let mut point = first;
                loop {
                    self.points[point].y = edge.pos;
                    self.points[point].touched = true;
                    if point == last {
                        break;
                    }
                    point = {
                        let range = &self.contours[contour];
                        if point + 1 == range.end { range.start } else { point + 1 }
                    };
                }
            }
        }
        if !self.edges.is_empty() {
            for index in 0..self.points.len() {
                if self.points[index].touched || self.points[index].weak {
                    continue;
                }
                let u = self.strong_position(self.points[index].fy, self.points[index].oy);
                self.points[index].y = u;
                self.points[index].touched = true;
            }
        }
        // Weak points: interpolated between the touched points of their contour (TrueType's IUP).
        for contour in 0..self.contours.len() {
            let range = self.contours[contour].clone();
            let touched: Vec<usize> = range.clone().filter(|at| self.points[*at].touched).collect();
            if touched.is_empty() {
                continue;
            }
            if touched.len() == 1 {
                let reference = touched[0];
                let delta = self.points[reference].y - self.points[reference].oy;
                for at in range {
                    if at != reference {
                        self.points[at].y = self.points[at].oy + delta;
                    }
                }
                continue;
            }
            for pair in 0..touched.len() {
                let (a, b) = (touched[pair], touched[(pair + 1) % touched.len()]);
                let mut inner = Vec::new();
                let mut at = a;
                loop {
                    at = self.next_of(contour, at);
                    if at == b {
                        break;
                    }
                    inner.push(at);
                }
                self.interpolate_between(&inner, a, b);
            }
        }
    }

    /// Where a strong point goes: shifted with the first or last edge, on an edge, or between the two edges around it.
    fn strong_position(&mut self, fu: i64, ou: i64) -> i64 {
        let count = self.edges.len();
        let (first, last) = (&self.edges[0], &self.edges[count - 1]);
        if first.fpos - fu >= 0 {
            return first.pos - (first.opos - ou);
        }
        if fu - last.fpos >= 0 {
            return last.pos + (ou - last.opos);
        }
        let after = if count <= 8 {
            let mut at = 0;
            while at < count && self.edges[at].fpos < fu {
                at += 1;
            }
            if at < count && self.edges[at].fpos == fu {
                return self.edges[at].pos;
            }
            at
        } else {
            let (mut min, mut max) = (0, count);
            while min < max {
                let mid = (max + min) >> 1;
                let fpos = self.edges[mid].fpos;
                if fu < fpos {
                    max = mid;
                } else if fu > fpos {
                    min = mid + 1;
                } else {
                    return self.edges[mid].pos;
                }
            }
            min
        };
        self.interpolate(after, fu)
    }

    fn interpolate(&mut self, after: usize, fu: i64) -> i64 {
        let before = after - 1;
        if self.edges[before].scale == 0 {
            self.edges[before].scale = div_fix(self.edges[after].pos - self.edges[before].pos, self.edges[after].fpos - self.edges[before].fpos);
        }
        self.edges[before].pos + mul_fix(fu - self.edges[before].fpos, self.edges[before].scale)
    }

    fn interpolate_between(&mut self, inner: &[usize], ref1: usize, ref2: usize) {
        if inner.is_empty() {
            return;
        }
        let (mut r1, mut r2) = (ref1, ref2);
        if self.points[r1].oy > self.points[r2].oy {
            std::mem::swap(&mut r1, &mut r2);
        }
        let (o1, o2) = (self.points[r1].oy, self.points[r2].oy);
        let (h1, h2) = (self.points[r1].y, self.points[r2].y);
        let (d1, d2) = (h1 - o1, h2 - o2);
        if o1 == o2 || d1 == d2 {
            for &at in inner {
                let o = self.points[at].oy;
                self.points[at].y = if o <= o1 {
                    o + d1
                } else if o >= o2 {
                    o + d2
                } else {
                    o + d1
                };
            }
        } else {
            let scale = div_fix(h2 - h1, o2 - o1);
            for &at in inner {
                let o = self.points[at].oy;
                self.points[at].y = if o <= o1 {
                    o + d1
                } else if o >= o2 {
                    o + d2
                } else {
                    h1 + mul_fix(o - o1, scale)
                };
            }
        }
    }
}

#[derive(Clone, Copy)]
struct ScaledBlue {
    ref_org: i64,
    shoot_org: i64,
    ref_fit: i64,
    shoot_fit: i64,
    top: bool,
    active: bool,
}

/// One hinted glyph: its contours in pixels relative to the pen, y up, with the kinds of their points.
pub struct HintedGlyph {
    pub contours: Vec<Vec<(f32, f32, Tag)>>,
}

impl Metrics {
    /// The vertical scale (16.16) after the x-height has been fitted to the pixel grid, and the blue zones at it
    /// (`af_latin_metrics_scale_dim`).
    fn scale_vertical(&self, zones: &Zones, ppem_y: i64) -> (i64, Vec<ScaledBlue>) {
        let mut scale = div_fix(ppem_y, self.upem);
        if let Some(blue) = zones.blues.iter().find(|blue| blue.adjustment) {
            let scaled = mul_fix(blue.shoot_org, scale);
            let fitted = (scaled + 40) & !63;
            if scaled != fitted {
                let new_scale = mul_div(scale, fitted, scaled);
                let mut max_height = self.upem;
                for blue in &zones.blues {
                    max_height = max_height.max(blue.ascender).max(-blue.descender);
                }
                let dist = mul_fix(max_height, new_scale - scale).abs() & !127;
                if dist == 0 {
                    scale = new_scale;
                }
            }
        }
        let blues = zones
            .blues
            .iter()
            .map(|blue| {
                let ref_cur = mul_fix(blue.ref_org, scale);
                let shoot_cur = mul_fix(blue.shoot_org, scale);
                let mut zone = ScaledBlue { ref_org: blue.ref_org, shoot_org: blue.shoot_org, ref_fit: ref_cur, shoot_fit: shoot_cur, top: blue.top, active: false };
                let dist = mul_fix(blue.ref_org - blue.shoot_org, scale);
                if (-48..=48).contains(&dist) {
                    let delta1 = blue.shoot_org - blue.ref_org;
                    let mut delta2 = mul_fix(delta1.abs(), scale);
                    delta2 = if delta2 < 32 {
                        0
                    } else if delta2 < 64 {
                        32 + (((delta2 - 32) + 16) & !31)
                    } else {
                        pix_round(delta2)
                    };
                    if delta1 < 0 {
                        delta2 = -delta2;
                    }
                    zone.ref_fit = pix_round(ref_cur);
                    zone.shoot_fit = zone.ref_fit + delta2;
                    zone.active = true;
                }
                zone
            })
            .collect();
        (scale, blues)
    }

    /// Hints a glyph at the given size (26.6 pixels per em, across and down). `None` when the glyph has no outline.
    pub fn hint(&self, face: &ttf_parser::Face<'_>, glyph: u16, ppem_x: i64, ppem_y: i64) -> Option<HintedGlyph> {
        self.hint_script(face, glyph, ppem_x, ppem_y, Script::Latin)
    }

    /// Hints a glyph with the module of `script`.
    pub fn hint_script(&self, face: &ttf_parser::Face<'_>, glyph: u16, ppem_x: i64, ppem_y: i64, script: Script) -> Option<HintedGlyph> {
        // The style of a glyph comes from the character the font maps to it. The .notdef glyph (an unmapped character) is
        // covered by no script and gets the fallback style, which is the CJK one when the CJK module is built
        // (`AF_STYLE_FALLBACK` = `AF_STYLE_HANI_DFLT` in afglobal.h, applied in `af_face_globals_compute_style_coverage`).
        let script = if glyph == 0 { Script::Cjk } else { script };
        let zones = self.zones(face, script);
        let contours = raw_outline(face, glyph)?;
        let truetype = is_truetype_orientation(&contours);
        let x_scale = div_fix(ppem_x, self.upem);
        let (y_scale, blues) = self.scale_vertical(zones, ppem_y);
        let mut hints = Hints::load(&contours, self.upem, truetype);
        hints.cjk = script == Script::Cjk;
        for point in &mut hints.points {
            point.ox = mul_fix(point.fx, x_scale);
            point.oy = mul_fix(point.fy, y_scale);
            point.x = point.ox;
            point.y = point.oy;
        }
        hints.compute_segments();
        hints.link_segments(if script == Script::Cjk { 0 } else { zones.widths.last().copied().unwrap_or(0) });
        hints.compute_edges(zones.edge_distance_threshold, y_scale);
        hints.compute_blue_edges(&blues, self.upem, y_scale);
        hints.hint_edges(&blues);
        hints.align_points();
        let mut out = Vec::with_capacity(hints.contours.len());
        for range in &hints.contours {
            out.push(range.clone().map(|at| (hints.points[at].x as f32 / 64.0, hints.points[at].y as f32 / 64.0, hints.points[at].tag)).collect());
        }
        Some(HintedGlyph { contours: out })
    }
}

/// The outline at a size without hinting: the contours as the font stores them, scaled by `scale_x` and `scale_y` pixels per
/// font unit.
pub fn scaled_outline(face: &ttf_parser::Face<'_>, glyph: u16, scale_x: f32, scale_y: f32) -> Option<HintedGlyph> {
    let contours = raw_outline(face, glyph)?;
    Some(HintedGlyph { contours: contours.iter().map(|contour| contour.iter().map(|p| (p.x as f32 * scale_x, p.y as f32 * scale_y, p.tag)).collect()).collect() })
}

/// The control box of contours (px, y up) grown by `half_width` on every side, with the miter tips of a stroke of that
/// half width (Skia's join: miter, limit 4) at the corners sharp enough to have one. `None` when there is no point.
pub fn stroked_bounds(contours: &[Vec<(f32, f32, Tag)>], half_width: f32) -> Option<(f32, f32, f32, f32)> {
    let (mut x_min, mut x_max, mut y_min, mut y_max) = (f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, f32::NEG_INFINITY);
    for contour in contours {
        for point in contour {
            x_min = x_min.min(point.0);
            x_max = x_max.max(point.0);
            y_min = y_min.min(point.1);
            y_max = y_max.max(point.1);
        }
    }
    if !x_min.is_finite() {
        return None;
    }
    if half_width <= 0.0 {
        return Some((x_min, x_max, y_min, y_max));
    }
    let (mut bx_min, mut bx_max, mut by_min, mut by_max) = (x_min - half_width, x_max + half_width, y_min - half_width, y_max + half_width);
    for contour in contours {
        let n = contour.len();
        for index in 0..n {
            if contour[index].2 != Tag::On {
                continue;
            }
            let here = (contour[index].0, contour[index].1);
            let toward = |step: isize| -> Option<(f32, f32)> {
                let mut at = index as isize;
                for _ in 1..n {
                    at = (at + step).rem_euclid(n as isize);
                    let other = (contour[at as usize].0, contour[at as usize].1);
                    let length = (other.0 - here.0).hypot(other.1 - here.1);
                    if length > 1e-6 {
                        return Some(((other.0 - here.0) / length, (other.1 - here.1) / length));
                    }
                }
                None
            };
            let (Some(back), Some(forward)) = (toward(-1), toward(1)) else { continue };
            // The directions of travel: into the vertex and out of it.
            let (t1, t2) = ((-back.0, -back.1), forward);
            let dot = t1.0 * t2.0 + t1.1 * t2.1;
            if 1.0 + dot < 0.125 || 1.0 + dot > 1.999_9 {
                continue;
            }
            let (n1, n2) = ((-t1.1, t1.0), (-t2.1, t2.0));
            let cross = t1.0 * t2.1 - t1.1 * t2.0;
            // The tip lies on the outer side of the turn: to the right of a left turn, to the left of a right turn.
            let side = if cross > 0.0 { -1.0 } else { 1.0 };
            let (mx, my) = ((n1.0 + n2.0) / (1.0 + dot), (n1.1 + n2.1) / (1.0 + dot));
            let tip = (here.0 + side * half_width * mx, here.1 + side * half_width * my);
            bx_min = bx_min.min(tip.0);
            bx_max = bx_max.max(tip.0);
            by_min = by_min.min(tip.1);
            by_max = by_max.max(tip.1);
        }
    }
    Some((bx_min, bx_max, by_min, by_max))
}

// ---- cache ------------------------------------------------------------------------------------------------------------

type CacheKey = (usize, usize, u32);

struct Cached {
    // Keeps the bytes the key points at alive, so the address is never reused for another font while the entry lives.
    _data: Arc<[u8]>,
    metrics: Arc<Metrics>,
}

fn cache() -> &'static Mutex<HashMap<CacheKey, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, Cached>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The auto-hinter's metrics of a loaded face, computed once.
pub fn metrics_of(face: &Face) -> Option<Arc<Metrics>> {
    let data = face.bytes()?;
    let key = (Arc::as_ptr(data) as *const u8 as usize, data.len(), face.index());
    if let Some(found) = cache().lock().ok()?.get(&key) {
        return Some(Arc::clone(&found.metrics));
    }
    let parsed = face.parsed()?;
    let metrics = Arc::new(Metrics::new(&parsed));
    cache().lock().ok()?.insert(key, Cached { _data: Arc::clone(data), metrics: Arc::clone(&metrics) });
    Some(metrics)
}
