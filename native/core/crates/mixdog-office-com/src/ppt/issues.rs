//! `Issues-PowerPoint` of `office-com-host.ps1`: what is wrong with a deck that a reader should be told: fonts that are not
//! installed, pictures without alternative text, text that overflows its shape, sits outside the slide or near its edge, is
//! too small or too faint on its fill, placeholders left empty, charts without data, text shapes laid over each other, slides
//! of text alone, and, for a deck backed by a model, numbers whose notes cite no source.
//!
//! The script reads each shape's geometry once and works on those numbers. Its `[single]` values are widened to `[double]`
//! wherever it computes with them (PowerShell does arithmetic on a `[single]` in `[double]`), and a failure anywhere in a
//! shape's text checks ends that shape's checks and nothing else, with the issues found before it kept.

use crate::actions::document::items_of;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::issues::missing_font_issue;
use crate::issues::office_issue;
use crate::office::Env;
use crate::office::long_of;
use crate::platform::FontSet;
use crate::ps::Value;
use crate::ps::collate::strings_equal_ignore_case;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::pipeline_items;
use crate::ps::text;

use super::as_value;
use super::count_of;
use super::double_of;
use super::int_of;
use super::ink::color_contrast_ratio;
use super::long_cast;
use super::single_of;
use super::snapshot::notes_text;
use super::string_of;
use super::truth;

/// How much of the smaller of two text shapes another must cover to be reported.
const OVERLAP_SHARE: f64 = 0.25;

/// What the notes of a model-backed deck must hold for a slide that has numbers: a source, or a workbook cell.
const SOURCE_PATTERN: &str = r"(?i)source\s*:|[\w .-]+!\$?[A-Z]{1,3}\$?\d+";

/// The geometry of one text shape, read once.
struct TextBox {
    index: usize,
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    area: f64,
}

/// What one slide's pass counts.
#[derive(Default)]
struct SlideCounts {
    text_shapes: usize,
    visual_shapes: usize,
    large_text_shapes: usize,
    dominant_text_shapes: usize,
    text_boxes: Vec<TextBox>,
}

/// What a shape's text chains give, each inside the failure the script tolerates.
struct Chains {
    frame: Com,
    range: Com,
    font: Com,
    bounds: Com,
    fill: Com,
}

fn read_chains(shape: &Com) -> Chains {
    let frame = (|| -> Result<Com> {
        if truth(&shape.member("HasTextFrame")?) { shape.member("TextFrame") } else { Ok(Com::Null) }
    })()
    .unwrap_or(Com::Null);
    let range = (|| -> Result<Com> { if truth(&frame) { frame.member("TextRange") } else { Ok(Com::Null) } })().unwrap_or(Com::Null);
    let font = (|| -> Result<Com> { if truth(&range) { range.member("Font") } else { Ok(Com::Null) } })().unwrap_or(Com::Null);
    let bounds = (|| -> Result<Com> { if truth(&frame) { shape.member("TextFrame2")?.member("TextRange") } else { Ok(Com::Null) } })().unwrap_or(Com::Null);
    let fill = shape.member("Fill").unwrap_or(Com::Null);
    Chains { frame, range, font, bounds, fill }
}

/// The geometry of the shape on the slide, as the script holds it: single-precision values.
struct Frame {
    left: f32,
    top: f32,
    width: f32,
    height: f32,
}

impl Frame {
    fn read(shape: &Com) -> Result<Frame> {
        Ok(Frame {
            left: single_of(&shape.member("Left")?)?,
            top: single_of(&shape.member("Top")?)?,
            width: single_of(&shape.member("Width")?)?,
            height: single_of(&shape.member("Height")?)?,
        })
    }

    fn right(&self) -> f64 {
        f64::from(self.left) + f64::from(self.width)
    }

    fn bottom(&self) -> f64 {
        f64::from(self.top) + f64::from(self.height)
    }
}

/// `[Math]::Abs` of the text bounds turned back into the shape's own frame: a turned shape reports its text bounds upright
/// on the slide.
fn upright_bounds(turn: f64, bound_width: f32, bound_height: f32) -> (f32, f32) {
    if (turn % 180.0).abs() <= 0.01 {
        return (bound_width, bound_height);
    }
    let radians = turn * std::f64::consts::PI / 180.0;
    let cos = radians.cos().abs();
    let sin = radians.sin().abs();
    let det = cos * cos - sin * sin;
    if det.abs() <= 0.2 {
        return (bound_width, bound_height);
    }
    let (width, height) = (f64::from(bound_width), f64::from(bound_height));
    (((width * cos - height * sin) / det) as f32, ((height * cos - width * sin) / det) as f32)
}

/// The text checks of one shape that has text and is not a motif. A failure ends them and keeps what was found.
fn inspect_text(
    shape: &Com,
    chains: &Chains,
    frame: &Frame,
    path: &str,
    shape_index: usize,
    slide_size: (f32, f32),
    fonts: &FontSet,
    counts: &mut SlideCounts,
    issues: &mut Vec<Value>,
) -> Result<()> {
    counts.text_shapes += 1;
    counts.text_boxes.push(TextBox {
        index: shape_index,
        left: f64::from(frame.left),
        top: f64::from(frame.top),
        right: frame.right(),
        bottom: frame.bottom(),
        area: f64::from(frame.width) * f64::from(frame.height),
    });
    let bound_width = single_of(&chains.bounds.member("BoundWidth")?)?;
    let bound_height = single_of(&chains.bounds.member("BoundHeight")?)?;
    let turn = shape.member("Rotation").and_then(|rotation| double_of(&rotation)).unwrap_or(0.0);
    let (bound_width, bound_height) = upright_bounds(turn, bound_width, bound_height);
    // A word-wrapped box cannot overflow sideways (PowerPoint folds at the box width), yet the width of the bounds of a wrapped
    // line can read a little past the box: the width is a defect only when wrap is off, or the excess is well past the slop.
    let word_wrap = chains.frame.member("WordWrap").and_then(|wrap| int_of(&wrap)).map_or(true, |wrap| wrap != 0);
    let width_slop = if word_wrap { 6.0 } else { 1.0 };
    // The bounds carry an allowance past the last glyph of a line, 0.2 to 0.33 em across faces.
    let run_size = chains.font.member("Size").and_then(|size| single_of(&size)).unwrap_or(0.0);
    let line_end = if run_size > 0.0 && run_size < 1000.0 { 0.2 * f64::from(run_size) } else { 0.0 };
    if (f64::from(bound_width) - line_end) > (f64::from(frame.width) + width_slop) || f64::from(bound_height) > (f64::from(frame.height) + 1.0) {
        issues.push(office_issue("warning", "text_overflow", path, "Text bounds exceed the containing shape."));
    }
    if let Some(issue) = missing_font_issue(fonts, &string_of(&chains.font.member("Name")?), path) {
        issues.push(issue);
    }
    let font_size = single_of(&chains.font.member("Size")?)?;
    if font_size >= 34.0 {
        counts.large_text_shapes += 1;
    }
    if font_size >= 42.0 {
        counts.dominant_text_shapes += 1;
    }
    // Page chrome (kickers, badges, captions, source lines) is one short line at caption size; it may be 9 pt and sit nearer
    // the edge. Body copy keeps the 12 pt and 18 pt floors.
    let shape_text = string_of(&chains.range.member("Text")?);
    let is_chrome = font_size > 0.0 && font_size <= 12.0 && shape_text.trim().encode_utf16().count() <= 90 && !shape_text.contains(['\r', '\n']);
    if font_size > 0.0 && font_size < 9.0 {
        let message = format!("Text uses {} pt; nothing on a slide should be smaller than 9 pt.", convert::format_single(font_size));
        issues.push(office_issue("warning", "small_font", path, &message));
    } else if font_size > 0.0 && font_size < 12.0 && !is_chrome {
        let message = format!("Text uses {} pt; presentation body text should normally be at least 12 pt.", convert::format_single(font_size));
        issues.push(office_issue("warning", "small_font", path, &message));
    }
    let (slide_width, slide_height) = (f64::from(slide_size.0), f64::from(slide_size.1));
    let (left, top) = (f64::from(frame.left), f64::from(frame.top));
    if left < 0.0 || top < 0.0 || frame.right() > slide_width + 1.0 || frame.bottom() > slide_height + 1.0 {
        issues.push(office_issue("warning", "text_outside_slide", path, "Text shape extends outside the slide boundary."));
    }
    let edge_margin: f64 = if is_chrome { 10.0 } else { 18.0 };
    if left < edge_margin || top < edge_margin || frame.right() > slide_width - edge_margin || frame.bottom() > slide_height - edge_margin {
        issues.push(office_issue("warning", "edge_margin", path, &format!("Text is within {edge_margin} pt of a slide edge.")));
    }
    let _ = (|| -> Result<()> {
        let fill_color = (|| -> Result<i64> {
            if truth(&chains.fill) && truth(&chains.fill.member("Visible")?) { long_cast(&chains.fill.member("ForeColor")?.member("RGB")?) } else { Ok(-1) }
        })()
        .unwrap_or(-1);
        let font_color = chains.font.member("Color").and_then(|color| color.member("RGB")).and_then(|rgb| long_cast(&rgb)).unwrap_or(-1);
        if fill_color >= 0 && font_color >= 0 {
            let contrast = color_contrast_ratio(font_color, fill_color);
            if contrast < 3.0 {
                let rounded = convert::round_digits(contrast, 2).map_err(Error::host)?;
                let message = format!("Text-to-fill contrast ratio is {}:1.", convert::format_double(rounded));
                issues.push(office_issue("warning", "low_contrast", path, &message));
            }
        }
        Ok(())
    })();
    Ok(())
}

/// One shape of a slide.
fn inspect_shape(
    slide: &Com,
    shape: &Com,
    shape_index: usize,
    slide_size: (f32, f32),
    fonts: &FontSet,
    counts: &mut SlideCounts,
    issues: &mut Vec<Value>,
) -> Result<()> {
    let path = format!("/slide[{}]/shape[{shape_index}]", string_of(&slide.member("SlideIndex")?));
    let _ = (|| -> Result<()> {
        let kind = int_of(&shape.member("Type")?)?;
        if [1, 3, 6, 13, 21, 28].contains(&kind) || truth(&shape.member("HasChart")?) || truth(&shape.member("HasTable")?) {
            counts.visual_shapes += 1;
        }
        Ok(())
    })();
    let _ = (|| -> Result<()> {
        if long_of(&shape.member("Type")?) == Some(13) && string_of(&shape.member("AlternativeText")?).trim().is_empty() {
            issues.push(office_issue("warning", "missing_alt_text", &path, "Picture has no alternative text."));
        }
        Ok(())
    })();
    // Named motif shapes are deliberate decoration (ghosted numerals, halos): never held to the legibility rules.
    let is_motif = shape.member("Name").is_ok_and(|name| string_of(&name).starts_with("Mixdog Motif"));
    let chains = read_chains(shape);
    let frame = Frame::read(shape)?;
    let _ = (|| -> Result<()> {
        if truth(&chains.frame) && truth(&chains.frame.member("HasText")?) && !is_motif {
            inspect_text(shape, &chains, &frame, &path, shape_index, slide_size, fonts, counts, issues)?;
        }
        Ok(())
    })();
    let _ = (|| -> Result<()> {
        if long_of(&shape.member("Type")?) == Some(14) && !(truth(&chains.frame) && truth(&chains.frame.member("HasText")?)) {
            let placeholder_type = int_of(&shape.member("PlaceholderFormat")?.member("Type")?)?;
            if (1..=7).contains(&placeholder_type) {
                issues.push(office_issue("warning", "empty_placeholder", &path, "A visible content placeholder is still empty."));
            }
        }
        Ok(())
    })();
    let chart = (|| -> Result<()> {
        if truth(&shape.member("HasChart")?) && count_of(&shape.member("Chart")?.call_member("SeriesCollection", &[])?)? == 0 {
            issues.push(office_issue("error", "empty_chart", &format!("{path}/chart"), "Chart has no data series."));
        }
        Ok(())
    })();
    if chart.is_err() && truth(&shape.member("HasChart")?) {
        issues.push(office_issue("error", "broken_chart", &format!("{path}/chart"), "Chart data could not be inspected."));
    }
    Ok(())
}

/// The text shapes laid over each other: the overlap of a pair is at least a quarter of the smaller one.
fn overlap_issues(slide: &Com, boxes: &[TextBox], issues: &mut Vec<Value>) -> Result<()> {
    for (left_at, left) in boxes.iter().enumerate() {
        for right in &boxes[left_at + 1..] {
            // Double arithmetic: the whole-number overload rounded each overlap to whole points.
            let x = (left.right.min(right.right) - left.left.max(right.left)).max(0.0);
            let y = (left.bottom.min(right.bottom) - left.top.max(right.top)).max(0.0);
            let intersection = x * y;
            let smallest = left.area.min(right.area);
            if smallest > 0.0 && (intersection / smallest) >= OVERLAP_SHARE {
                let path = format!("/slide[{}]", string_of(&slide.member("SlideIndex")?));
                let message = format!("Text shapes {} and {} overlap by at least 25%.", left.index, right.index);
                issues.push(office_issue("warning", "shape_overlap", &path, &message));
            }
        }
    }
    Ok(())
}

/// The text of every shape of the slide, joined by a space; each shape is read as the pipeline reaches it.
fn all_text_of(slide: &Com) -> Result<String> {
    let mut texts = Vec::new();
    if let Some(shapes) = slide.member("Shapes")?.as_obj() {
        for item in shapes.enumerate()? {
            let item = item?;
            let _ = (|| -> Result<()> {
                if truth(&item.member("HasTextFrame")?) && truth(&item.member("TextFrame")?.member("HasText")?) {
                    texts.push(string_of(&item.member("TextFrame")?.member("TextRange")?.member("Text")?));
                }
                Ok(())
            })();
        }
    }
    Ok(texts.join(" "))
}

/// `Issues-PowerPoint`: the list of issues.
pub fn issues_powerpoint(env: &Env<'_>, document: &Obj, payload: &Value) -> Result<Value> {
    let presentation = as_value(document);
    let mut issues: Vec<Value> = Vec::new();
    let fonts = env.platform.installed_office_fonts();
    let pages = payload::property(payload, "pages");
    let model_backed = strings_equal_ignore_case(&convert::to_ps_string(&payload::property(payload, "auditProfile")), "model-backed-deck");
    for slide in items_of(&presentation.member("Slides")?)? {
        if convert::to_bool(&pages) {
            let wanted: Vec<i32> = pipeline_items(&pages).iter().map(|page| convert::to_int(page).map_err(Error::host)).collect::<Result<_>>()?;
            if !wanted.contains(&int_of(&slide.member("SlideIndex")?)?) {
                continue;
            }
        }
        let mut counts = SlideCounts::default();
        let slide_width = single_of(&presentation.member("PageSetup")?.member("SlideWidth")?)?;
        let slide_height = single_of(&presentation.member("PageSetup")?.member("SlideHeight")?)?;
        for (at, shape) in items_of(&slide.member("Shapes")?)?.iter().enumerate() {
            inspect_shape(&slide, shape, at + 1, (slide_width, slide_height), &fonts, &mut counts, &mut issues)?;
        }
        overlap_issues(&slide, &counts.text_boxes, &mut issues)?;
        let typographic_visual = counts.dominant_text_shapes > 0 || counts.large_text_shapes >= 2;
        let slide_index = int_of(&slide.member("SlideIndex")?)?;
        let boundary_slide = slide_index == 1 || {
            let index = int_of(&slide.member("SlideIndex")?)?;
            index == int_of(&presentation.member("Slides")?.member("Count")?)?
        };
        if counts.text_shapes > 0 && counts.visual_shapes == 0 && !typographic_visual && !boundary_slide {
            let path = format!("/slide[{}]", string_of(&slide.member("SlideIndex")?));
            issues.push(office_issue("warning", "text_only_slide", &path, "Slide contains text but no visual shape, chart, table, diagram, or picture."));
        }
        if model_backed {
            let all_text = all_text_of(&slide)?;
            let notes = notes_text(&slide);
            if text::is_match(&all_text, r"\d", false).map_err(Error::host)? && text::is_not_match(&notes, SOURCE_PATTERN, false).map_err(Error::host)? {
                let path = format!("/slide[{}]", string_of(&slide.member("SlideIndex")?));
                let message = "Model-backed deck slide contains numbers but its notes do not cite a workbook cell or source.";
                issues.push(office_issue("warning", "number_without_source", &path, message));
            }
        }
    }
    Ok(Value::Array(issues))
}
