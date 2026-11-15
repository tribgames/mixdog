//! `PowerPoint-NotesText` and `Snapshot-PowerPoint` of `office-com-host.ps1`: the deck as the model reads it.
//!
//! Every chain the script walks per shape is walked once and reused where the script caches it (the text frame, range, font
//! and the second text frame), and read again where the script reads it again (a loop's count at each step, `Table` at each
//! cell): the replayed call logs hold the port to the same calls in the same order. A read the script wraps in `try` is
//! wrapped here and answers `$null` (or what its `catch` gives); a list the script appends to inside a `try` keeps what was
//! appended before a failure.

use crate::actions::document::items_of;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::office::item_of;
use crate::ps::Value;
use crate::ps::collate::SortOptions;
use crate::ps::collate::sort_values;
use crate::ps::convert;
use crate::ps::convert::color_hex;
use crate::ps::payload;
use crate::ps::pipeline_items;

use super::as_value;
use super::count_of;
use super::double_of;
use super::has_ink;
use super::int_of;
use super::long_cast;
use super::or_null;
use super::ordered;
use super::string_of;
use super::truth;

/// The preset geometry names of the OOXML vocabulary, by `AutoShapeType`.
fn preset_name(auto: i32) -> Option<&'static str> {
    Some(match auto {
        1 => "rect",
        2 => "parallelogram",
        3 => "trapezoid",
        4 => "diamond",
        5 => "roundRect",
        6 => "octagon",
        7 => "triangle",
        8 => "rtTriangle",
        9 => "ellipse",
        10 => "hexagon",
        11 => "plus",
        12 => "pentagon",
        13 => "can",
        14 => "cube",
        15 => "bevel",
        16 => "foldedCorner",
        18 => "donut",
        20 => "blockArc",
        25 => "arc",
        26 => "bracketPair",
        27 => "bracePair",
        29 => "leftBracket",
        30 => "rightBracket",
        31 => "leftBrace",
        32 => "rightBrace",
        33 => "rightArrow",
        34 => "leftArrow",
        35 => "upArrow",
        36 => "downArrow",
        37 => "leftRightArrow",
        38 => "upDownArrow",
        51 => "homePlate",
        52 => "chevron",
        105 => "wedgeRectCallout",
        106 => "wedgeRoundRectCallout",
        107 => "wedgeEllipseCallout",
        _ => return None,
    })
}

fn to_index(number: i64) -> i32 {
    i32::try_from(number).unwrap_or(i32::MAX)
}

/// `PowerPoint-NotesText`: the text of the notes page's body placeholder (type 2), empty where there is none; any failure ends
/// the search with what was found.
pub fn notes_text(slide: &Com) -> String {
    let mut text = String::new();
    let _ = (|| -> Result<()> {
        let shapes = slide.member("NotesPage")?.member("Shapes")?;
        for notes_shape in items_of(&shapes)? {
            let kind = notes_shape.member("PlaceholderFormat").and_then(|format| format.member("Type")).and_then(|kind| int_of(&kind));
            if !kind.is_ok_and(|kind| kind == 2) {
                continue;
            }
            if truth(&notes_shape.member("HasTextFrame")?) && truth(&notes_shape.member("TextFrame")?.member("HasText")?) {
                text = string_of(&notes_shape.member("TextFrame")?.member("TextRange")?.member("Text")?);
            }
            break;
        }
        Ok(())
    })();
    text
}

/// What one shape's text chains give, read once.
struct TextChains {
    text: Value,
    frame: Com,
    range: Com,
    font: Com,
    range2: Com,
}

fn read_text_chains(shape: &Com) -> TextChains {
    let mut chains = TextChains { text: Value::Null, frame: Com::Null, range: Com::Null, font: Com::Null, range2: Com::Null };
    let _ = (|| -> Result<()> {
        if truth(&shape.member("HasTextFrame")?) {
            chains.frame = shape.member("TextFrame")?;
            chains.range = chains.frame.member("TextRange")?;
            chains.font = chains.range.member("Font")?;
            if truth(&chains.frame.member("HasText")?) {
                chains.text = Value::String(string_of(&chains.range.member("Text")?));
            }
            if let Ok(range2) = shape.member("TextFrame2").and_then(|frame| frame.member("TextRange")) {
                chains.range2 = range2;
            }
        }
        Ok(())
    })();
    chains
}

fn placeholder_of(shape: &Com, shape_type: i32) -> Value {
    or_null((|| -> Result<Value> {
        if shape_type != 14 {
            return Ok(Value::Null);
        }
        let kind = int_of(&shape.member("PlaceholderFormat")?.member("Type")?)?;
        let index = int_of(&shape.member("PlaceholderFormat")?.member("Index")?)?;
        Ok(ordered(vec![("type", Value::Int(kind)), ("index", Value::Int(index))]))
    })())
}

fn group_of(shape: &Com, shape_type: i32) -> Value {
    or_null((|| -> Result<Value> {
        if shape_type != 6 {
            return Ok(Value::Null);
        }
        let mut items = Vec::new();
        let mut group_index = 1;
        while group_index <= count_of(&shape.member("GroupItems")?)? {
            let item = item_of(&shape.member("GroupItems")?, to_index(group_index))?;
            items.push(ordered(vec![
                ("index", Value::Int(to_index(group_index))),
                ("name", Value::String(string_of(&item.member("Name")?))),
                ("type", Value::Int(int_of(&item.member("Type")?)?)),
            ]));
            group_index += 1;
        }
        Ok(ordered(vec![("count", Value::Int(to_index(items.len() as i64))), ("items", Value::Array(items))]))
    })())
}

fn crop_of(shape: &Com, shape_type: i32) -> Value {
    or_null((|| -> Result<Value> {
        if shape_type != 13 {
            return Ok(Value::Null);
        }
        let side = |name: &str| -> Result<Value> { Ok(Value::Double(double_of(&shape.member("PictureFormat")?.member(name)?)?)) };
        let left = side("CropLeft")?;
        let right = side("CropRight")?;
        let top = side("CropTop")?;
        let bottom = side("CropBottom")?;
        Ok(ordered(vec![("left", left), ("right", right), ("top", top), ("bottom", bottom)]))
    })())
}

fn table_of(shape: &Com) -> Value {
    or_null((|| -> Result<Value> {
        if !truth(&shape.member("HasTable")?) {
            return Ok(Value::Null);
        }
        let table_rows = || -> Result<Com> { shape.member("Table")?.member("Rows") };
        let table_columns = || -> Result<Com> { shape.member("Table")?.member("Columns") };
        let mut rows = Vec::new();
        let mut row_index = 1;
        while row_index <= count_of(&table_rows()?)? {
            let mut cells = Vec::new();
            let mut column_index = 1;
            while column_index <= count_of(&table_columns()?)? {
                let cell = shape.member("Table")?.call_member("Cell", &[Com::I4(to_index(row_index)), Com::I4(to_index(column_index))])?;
                let text = cell.member("Shape")?.member("TextFrame")?.member("TextRange")?.member("Text")?;
                cells.push(Value::String(string_of(&text)));
                column_index += 1;
            }
            rows.push(Value::Array(cells));
            row_index += 1;
        }
        let row_count = int_of(&table_rows()?.member("Count")?)?;
        let column_count = int_of(&table_columns()?.member("Count")?)?;
        Ok(ordered(vec![("rows", Value::Int(row_count)), ("columns", Value::Int(column_count)), ("values", Value::Array(rows))]))
    })())
}

/// The preset geometry in the OOXML vocabulary the portable snapshot reports; empty where the type has none or a read fails.
fn geometry_of(shape: &Com, shape_type: i32) -> String {
    let mut geometry = String::new();
    let _ = (|| -> Result<()> {
        if shape_type == 9 {
            geometry = "line".to_owned();
        } else if shape_type == 5 {
            geometry = "custGeom".to_owned();
        } else if shape_type == 1 || shape_type == 14 {
            let auto = int_of(&shape.member("AutoShapeType")?)?;
            if auto > 0 {
                geometry = preset_name(auto).map_or_else(|| format!("auto{auto}"), str::to_owned);
            }
        }
        Ok(())
    })();
    geometry
}

/// `[double]<chain>` inside `try`, `$null` when it throws.
fn double_or_null(read: impl FnOnce() -> Result<Com>) -> Value {
    or_null(read().and_then(|value| double_of(&value)).map(Value::Double))
}

/// `[int]$reference.Visible -ne 0` inside `try`.
fn visible_of(reference: &Com) -> Value {
    or_null(reference.member("Visible").and_then(|visible| int_of(&visible)).map(|visible| Value::Bool(visible != 0)))
}

fn shadow_of(shadow: &Com) -> Value {
    or_null((|| -> Result<Value> {
        let visible = int_of(&shadow.member("Visible")?)?;
        let color = double_of(&shadow.member("ForeColor")?.member("RGB")?)?;
        let number = |name: &str| -> Result<Value> { Ok(Value::Double(double_of(&shadow.member(name)?)?)) };
        let transparency = number("Transparency")?;
        let blur = number("Blur")?;
        let offset_x = number("OffsetX")?;
        let offset_y = number("OffsetY")?;
        Ok(ordered(vec![
            ("visible", Value::Int(visible)),
            ("color", Value::Double(color)),
            ("transparency", transparency),
            ("blur", blur),
            ("offsetX", offset_x),
            ("offsetY", offset_y),
        ]))
    })())
}

fn text_frame_of(chains: &TextChains) -> Value {
    or_null((|| -> Result<Value> {
        let margin = |name: &str| -> Result<Value> { Ok(Value::Double(double_of(&chains.frame.member(name)?)?)) };
        let left = margin("MarginLeft")?;
        let top = margin("MarginTop")?;
        let right = margin("MarginRight")?;
        let bottom = margin("MarginBottom")?;
        let spacing = double_of(&chains.range.member("ParagraphFormat")?.member("SpaceBefore")?)?;
        Ok(ordered(vec![
            ("marginLeft", left),
            ("marginTop", top),
            ("marginRight", right),
            ("marginBottom", bottom),
            ("paragraphSpacing", Value::Double(spacing)),
        ]))
    })())
}

fn text_bounds_of(range2: &Com) -> Value {
    or_null((|| -> Result<Value> {
        let width = double_of(&range2.member("BoundWidth")?)?;
        let height = double_of(&range2.member("BoundHeight")?)?;
        Ok(ordered(vec![("width", Value::Double(width)), ("height", Value::Double(height))]))
    })())
}

/// The colour of the font as `RRGGBB`: the range's, or for a range of mixed colours the first of its first eight runs that
/// holds text; `$null` where none is a colour.
fn font_color_of(chains: &TextChains, font_rgb: Option<i64>) -> Value {
    or_null((|| -> Result<Value> {
        let mut rgb = font_rgb.ok_or_else(|| Error::host("font colour unread"))?;
        if !(0..=16_777_215).contains(&rgb) {
            let run_total = count_of(&chains.range.call_member("Runs", &[])?)?.min(8);
            for run_index in 1..=run_total {
                let run = chains.range.call_member("Runs", &[Com::I4(to_index(run_index)), Com::I4(1)])?;
                if has_ink(&string_of(&run.member("Text")?)) {
                    rgb = long_cast(&run.member("Font")?.member("Color")?.member("RGB")?)?;
                    break;
                }
            }
        }
        Ok(if (0..=16_777_215).contains(&rgb) { Value::String(color_hex(rgb)) } else { Value::Null })
    })())
}

fn font_of(chains: &TextChains, font_size: Option<f64>, font_rgb: Option<i64>) -> Value {
    or_null((|| -> Result<Value> {
        let name = string_of(&chains.font.member("Name")?);
        let size = font_size.ok_or_else(|| Error::host("font size unread"))?;
        let bold = int_of(&chains.font.member("Bold")?)?;
        let italic = int_of(&chains.font.member("Italic")?)?;
        let color = font_color_of(chains, font_rgb);
        Ok(ordered(vec![
            ("name", Value::String(name)),
            ("size", Value::Double(size)),
            ("bold", Value::Int(bold)),
            ("italic", Value::Int(italic)),
            ("color", color),
        ]))
    })())
}

/// The sizes and colours in use: a uniform range answers in two reads, a mixed one is walked run by run (the first 40 runs
/// that hold text) and the distinct values are listed sorted.
fn runs_of(chains: &TextChains, font_size: Option<f64>, font_rgb: Option<i64>) -> Value {
    or_null((|| -> Result<Value> {
        let has_text = matches!(&chains.text, Value::String(text) if !text.is_empty());
        if !truth(&chains.font) || !has_text {
            return Ok(Value::Null);
        }
        let (Some(range_size), Some(rgb)) = (font_size, font_rgb) else {
            return Err(Error::host("range font unread"));
        };
        let range_color = rgb as f64;
        if range_size > 0.0 && range_color >= 0.0 {
            return Ok(ordered(vec![
                ("sizes", Value::Array(vec![Value::Double(range_size)])),
                ("colors", Value::Array(vec![Value::Double(range_color)])),
            ]));
        }
        let mut sizes = Vec::new();
        let mut colors = Vec::new();
        let run_count = count_of(&chains.range.call_member("Runs", &[])?)?.min(40);
        for run_index in 1..=run_count {
            let run = chains.range.call_member("Runs", &[Com::I4(to_index(run_index)), Com::I4(1)])?;
            if has_ink(&string_of(&run.member("Text")?)) {
                sizes.push(Value::Double(double_of(&run.member("Font")?.member("Size")?)?));
                colors.push(Value::Double(double_of(&run.member("Font")?.member("Color")?.member("RGB")?)?));
            }
        }
        let unique = SortOptions { descending: false, unique: true };
        Ok(ordered(vec![("sizes", Value::Array(sort_values(&sizes, unique))), ("colors", Value::Array(sort_values(&colors, unique)))]))
    })())
}

fn series_of(chart: &Com) -> Value {
    let read = || -> Result<Value> {
        let mut items = Vec::new();
        let mut series_index = 1;
        while series_index <= count_of(&chart.call_member("SeriesCollection", &[])?)? {
            let series = item_of(&chart.call_member("SeriesCollection", &[])?, to_index(series_index))?;
            let name = string_of(&series.member("Name")?);
            let chart_type = or_null(series.member("ChartType").and_then(|value| int_of(&value)).map(Value::Int));
            let axis_group = or_null(series.member("AxisGroup").and_then(|value| int_of(&value)).map(Value::Int));
            let trendline_count = series
                .call_member("Trendlines", &[])
                .and_then(|trendlines| count_of(&trendlines))
                .ok()
                .and_then(|count| i32::try_from(count).ok())
                .unwrap_or(0);
            let has_error_bars = series.member("HasErrorBars").is_ok_and(|value| truth(&value));
            let has_data_labels = truth(&series.member("HasDataLabels")?);
            let data_labels = if truth(&series.member("HasDataLabels")?) {
                let label = |member: &str| -> Result<Com> { series.call_member("DataLabels", &[])?.member(member) };
                let show_value = truth(&label("ShowValue")?);
                let show_category = truth(&label("ShowCategoryName")?);
                let number_format = string_of(&label("NumberFormat")?);
                let position = int_of(&label("Position")?)?;
                ordered(vec![
                    ("showValue", Value::Bool(show_value)),
                    ("showCategoryName", Value::Bool(show_category)),
                    ("numberFormat", Value::String(number_format)),
                    ("position", Value::Int(position)),
                ])
            } else {
                Value::Null
            };
            items.push(ordered(vec![
                ("index", Value::Int(to_index(series_index))),
                ("name", Value::String(name)),
                ("formula", Value::string("")),
                ("chartType", chart_type),
                ("axisGroup", axis_group),
                ("trendlineCount", Value::Int(trendline_count)),
                ("hasErrorBars", Value::Bool(has_error_bars)),
                ("hasDataLabels", Value::Bool(has_data_labels)),
                ("dataLabels", data_labels),
            ]));
            series_index += 1;
        }
        Ok(Value::Array(items))
    };
    read().unwrap_or_else(|_| Value::Array(Vec::new()))
}

/// The category axis and the value axis; `$null` (the script's `@()` through `$()`) where a read fails.
fn axes_of(chart: &Com) -> Value {
    or_null((|| -> Result<Value> {
        let mut axes = Vec::new();
        for (name, axis_type) in [("category", 1), ("value", 2)] {
            let axis = chart.call_member("Axes", &[Com::I4(axis_type), Com::I4(1)])?;
            let title = if truth(&axis.member("HasTitle")?) { string_of(&axis.member("AxisTitle")?.member("Text")?) } else { String::new() };
            let minimum = double_or_null(|| axis.member("MinimumScale"));
            let maximum = double_or_null(|| axis.member("MaximumScale"));
            let major_unit = double_or_null(|| axis.member("MajorUnit"));
            let number_format = axis.member("TickLabels").and_then(|labels| labels.member("NumberFormat")).map(|format| string_of(&format)).unwrap_or_default();
            axes.push(ordered(vec![
                ("type", Value::string(name)),
                ("title", Value::String(title)),
                ("minimum", minimum),
                ("maximum", maximum),
                ("majorUnit", major_unit),
                ("numberFormat", Value::String(number_format)),
            ]));
        }
        Ok(Value::Array(axes))
    })())
}

fn chart_of(shape: &Com, slide_index: i32, shape_index: i64) -> Value {
    or_null((|| -> Result<Value> {
        if !truth(&shape.member("HasChart")?) {
            return Ok(Value::Null);
        }
        let chart = shape.member("Chart")?;
        let chart_type = int_of(&chart.member("ChartType")?)?;
        let title = if truth(&chart.member("HasTitle")?) { string_of(&chart.member("ChartTitle")?.member("Text")?) } else { String::new() };
        let series_count = int_of(&chart.call_member("SeriesCollection", &[])?.member("Count")?)?;
        let series = series_of(&chart);
        let axes = axes_of(&chart);
        Ok(ordered(vec![
            ("path", Value::String(format!("/slide[{slide_index}]/shape[{shape_index}]/chart"))),
            ("chartType", Value::Int(chart_type)),
            ("title", Value::String(title)),
            ("seriesCount", Value::Int(series_count)),
            ("series", series),
            ("axes", axes),
        ]))
    })())
}

/// One shape of a slide.
fn shape_value(slide_index: i32, shape_index: i64, shape: &Com) -> Result<Value> {
    // The shape's type is read once.
    let shape_type = int_of(&shape.member("Type")?)?;
    let chains = read_text_chains(shape);
    let fill = shape.member("Fill").unwrap_or(Com::Null);
    let line = shape.member("Line").unwrap_or(Com::Null);
    let shadow = shape.member("Shadow").unwrap_or(Com::Null);
    let placeholder = placeholder_of(shape, shape_type);
    let group = group_of(shape, shape_type);
    let crop = crop_of(shape, shape_type);
    let table = table_of(shape);
    let geometry = geometry_of(shape, shape_type);
    // The range's size and colour, read once for the font and the runs below.
    let font_size = chains.font.member("Size").and_then(|size| double_of(&size)).ok();
    let font_rgb = chains.font.member("Color").and_then(|color| color.member("RGB")).and_then(|rgb| long_cast(&rgb)).ok();
    let path = format!("/slide[{slide_index}]/shape[{shape_index}]");
    let name = string_of(&shape.member("Name")?);
    let number = |member: &str| -> Result<Value> { Ok(Value::Double(double_of(&shape.member(member)?)?)) };
    let left = number("Left")?;
    let top = number("Top")?;
    let width = number("Width")?;
    let height = number("Height")?;
    let rotation = number("Rotation")?;
    Ok(ordered(vec![
        ("path", Value::String(path)),
        ("index", Value::Int(to_index(shape_index))),
        ("name", Value::String(name)),
        ("type", Value::Int(shape_type)),
        ("geometry", Value::String(geometry)),
        ("text", chains.text.clone()),
        ("placeholder", placeholder),
        ("group", group),
        ("crop", crop),
        ("table", table),
        ("left", left),
        ("top", top),
        ("width", width),
        ("height", height),
        ("rotation", rotation),
        ("fillColor", double_or_null(|| fill.member("ForeColor")?.member("RGB"))),
        ("fillVisible", visible_of(&fill)),
        ("fillTransparency", double_or_null(|| fill.member("Transparency"))),
        ("lineColor", double_or_null(|| line.member("ForeColor")?.member("RGB"))),
        ("lineVisible", visible_of(&line)),
        ("lineTransparency", double_or_null(|| line.member("Transparency"))),
        ("shadow", shadow_of(&shadow)),
        ("textFrame", text_frame_of(&chains)),
        ("textBounds", text_bounds_of(&chains.range2)),
        ("font", font_of(&chains, font_size, font_rgb)),
        ("runs", runs_of(&chains, font_size, font_rgb)),
        ("chart", chart_of(shape, slide_index, shape_index)),
    ]))
}

fn comments_of(slide: &Com, slide_index: i32) -> Vec<Value> {
    let mut comments = Vec::new();
    let _ = (|| -> Result<()> {
        let mut comment_index = 1;
        while comment_index <= count_of(&slide.member("Comments")?)? {
            let comment = item_of(&slide.member("Comments")?, to_index(comment_index))?;
            let author = string_of(&comment.member("Author")?);
            let initials = string_of(&comment.member("AuthorInitials")?);
            let text = string_of(&comment.member("Text")?);
            let left = double_of(&comment.member("Left")?)?;
            let top = double_of(&comment.member("Top")?)?;
            comments.push(ordered(vec![
                ("path", Value::String(format!("/slide[{slide_index}]/comment[{comment_index}]"))),
                ("index", Value::Int(to_index(comment_index))),
                ("author", Value::String(author)),
                ("initials", Value::String(initials)),
                ("text", Value::String(text)),
                ("left", Value::Double(left)),
                ("top", Value::Double(top)),
            ]));
            comment_index += 1;
        }
        Ok(())
    })();
    comments
}

fn animations_of(slide: &Com) -> Vec<Value> {
    let mut animations = Vec::new();
    let _ = (|| -> Result<()> {
        let sequence = slide.member("TimeLine")?.member("MainSequence")?;
        let mut effect_index = 1;
        while effect_index <= count_of(&sequence)? {
            let effect = item_of(&sequence, to_index(effect_index))?;
            let shape = string_of(&effect.member("Shape")?.member("Name")?);
            let kind = int_of(&effect.member("EffectType")?)?;
            let trigger = int_of(&effect.member("Timing")?.member("TriggerType")?)?;
            let duration = double_of(&effect.member("Timing")?.member("Duration")?)?;
            let delay = double_of(&effect.member("Timing")?.member("TriggerDelayTime")?)?;
            animations.push(ordered(vec![
                ("index", Value::Int(to_index(effect_index))),
                ("shape", Value::String(shape)),
                ("effect", Value::Int(kind)),
                ("trigger", Value::Int(trigger)),
                ("duration", Value::Double(duration)),
                ("delay", Value::Double(delay)),
            ]));
            effect_index += 1;
        }
        Ok(())
    })();
    animations
}

/// The one-based index of the layout of the master named like the slide's, 0 where there is none.
fn layout_index_of(presentation: &Com, layout_name: &str) -> i32 {
    let mut layout_index = 0;
    let _ = (|| -> Result<()> {
        let layouts = || -> Result<Com> { presentation.member("SlideMaster")?.member("CustomLayouts") };
        let mut candidate = 1;
        while candidate <= count_of(&layouts()?)? {
            let name = string_of(&item_of(&layouts()?, to_index(candidate))?.member("Name")?);
            // `[string]::Equals(a, b, OrdinalIgnoreCase)`.
            if payload::names_equal(&name, layout_name) {
                layout_index = to_index(candidate);
                break;
            }
            candidate += 1;
        }
        Ok(())
    })();
    layout_index
}

/// `Color-Hex ([long]<chain>)`.
fn hex_of(chain: Result<Com>) -> Result<String> {
    Ok(color_hex(long_cast(&chain?)?))
}

/// Where the slide's background comes from and its colour: the slide's own, else its layout's, else the master's.
fn background_of(presentation: &Com, slide: &Com, follow_master: bool) -> (&'static str, Value) {
    let mut source = if follow_master { "layout" } else { "slide" };
    let mut color: Option<String> = None;
    let _ = (|| -> Result<()> {
        if follow_master {
            color = hex_of(slide.member("CustomLayout").and_then(|layout| layout.member("Background")?.member("Fill")?.member("ForeColor")?.member("RGB"))).ok();
            if color.is_none() {
                source = "master";
                color = hex_of(presentation.member("SlideMaster").and_then(|master| master.member("Background")?.member("Fill")?.member("ForeColor")?.member("RGB"))).ok();
            }
        } else {
            color = Some(hex_of(slide.member("Background").and_then(|background| background.member("Fill")?.member("ForeColor")?.member("RGB")))?);
        }
        Ok(())
    })();
    (source, color.map_or(Value::Null, Value::String))
}

fn slide_value(presentation: &Com, slide: &Com) -> Result<Value> {
    let slide_index = int_of(&slide.member("SlideIndex")?)?;
    let mut shapes = Vec::new();
    let mut shape_index = 1;
    while shape_index <= count_of(&slide.member("Shapes")?)? {
        let shape = item_of(&slide.member("Shapes")?, to_index(shape_index))?;
        shapes.push(shape_value(slide_index, shape_index, &shape)?);
        shape_index += 1;
    }
    let notes = notes_text(slide);
    let comments = comments_of(slide, slide_index);
    let animations = animations_of(slide);
    let layout_name = slide.member("CustomLayout").and_then(|layout| layout.member("Name")).map(|name| string_of(&name)).unwrap_or_default();
    let layout_index = layout_index_of(presentation, &layout_name);
    let follow_master = slide.member("FollowMasterBackground").is_ok_and(|value| truth(&value));
    let (background_source, background_color) = background_of(presentation, slide, follow_master);
    let hidden = slide.member("SlideShowTransition").and_then(|transition| transition.member("Hidden")).is_ok_and(|value| truth(&value));
    let transition = |member: &str| -> Result<Com> { slide.member("SlideShowTransition")?.member(member) };
    let effect = transition("EntryEffect").and_then(|value| int_of(&value)).unwrap_or(0);
    let advance_on_time = transition("AdvanceOnTime").is_ok_and(|value| truth(&value));
    let advance_time = transition("AdvanceTime").and_then(|value| double_of(&value)).map_or(Value::Int(0), Value::Double);
    Ok(ordered(vec![
        ("path", Value::String(format!("/slide[{slide_index}]"))),
        ("index", Value::Int(slide_index)),
        ("hidden", Value::Bool(hidden)),
        ("layout", ordered(vec![("index", Value::Int(layout_index)), ("name", Value::String(layout_name))])),
        (
            "background",
            ordered(vec![
                ("followMaster", Value::Bool(follow_master)),
                ("source", Value::string(background_source)),
                ("color", background_color),
            ]),
        ),
        ("shapes", Value::Array(shapes)),
        ("notes", Value::String(notes)),
        ("comments", Value::Array(comments)),
        ("animations", Value::Array(animations)),
        (
            "transition",
            ordered(vec![("effect", Value::Int(effect)), ("advanceOnTime", Value::Bool(advance_on_time)), ("advanceTime", advance_time)]),
        ),
    ]))
}

/// A list the script fills inside a `try`: what was read before a failure stays.
fn kept_list(read: impl FnOnce(&mut Vec<Value>) -> Result<()>) -> Vec<Value> {
    let mut list = Vec::new();
    let _ = read(&mut list);
    list
}

/// `Snapshot-PowerPoint`.
pub fn snapshot_powerpoint(document: &Obj, payload: &Value) -> Result<Value> {
    let presentation = as_value(document);
    let slide_total = || -> Result<i64> { count_of(&presentation.member("Slides")?) };
    let paged = convert::to_bool(&payload::property(payload, "paged"));
    let slide_offset = if paged { i64::from(convert::to_int(&payload::property(payload, "offset")).map_err(Error::host)?.max(0)) } else { 0 };
    let slide_limit = if paged { i64::from(convert::to_int(&payload::property(payload, "limit")).map_err(Error::host)?.max(1)) } else { slide_total()? };
    let pages = payload::property(payload, "pages");
    let has_pages = convert::to_bool(&pages);
    let slide_numbers: Vec<i64> = if has_pages {
        pipeline_items(&pages).iter().map(|page| convert::to_int(page).map(i64::from).map_err(Error::host)).collect::<Result<_>>()?
    } else {
        let end = slide_total()?.min(slide_offset + slide_limit);
        if end <= slide_offset { Vec::new() } else { (slide_offset + 1..=end).collect() }
    };
    let mut slides = Vec::new();
    for slide_number in slide_numbers {
        if slide_number < 1 || slide_number > slide_total()? {
            return Err(Error::host(format!("PowerPoint slide out of range: {slide_number}")));
        }
        let slide = item_of(&presentation.member("Slides")?, to_index(slide_number))?;
        slides.push(slide_value(&presentation, &slide)?);
    }
    let layouts = kept_list(|layouts| {
        let master_layouts = || -> Result<Com> { presentation.member("SlideMaster")?.member("CustomLayouts") };
        let mut layout_index = 1;
        while layout_index <= count_of(&master_layouts()?)? {
            let layout = item_of(&master_layouts()?, to_index(layout_index))?;
            layouts.push(ordered(vec![
                ("path", Value::String(format!("/layout[{layout_index}]"))),
                ("index", Value::Int(to_index(layout_index))),
                ("name", Value::String(string_of(&layout.member("Name")?))),
            ]));
            layout_index += 1;
        }
        Ok(())
    });
    let designs = kept_list(|designs| {
        let mut design_index = 1;
        while design_index <= count_of(&presentation.member("Designs")?)? {
            let design = item_of(&presentation.member("Designs")?, to_index(design_index))?;
            designs.push(ordered(vec![("index", Value::Int(to_index(design_index))), ("name", Value::String(string_of(&design.member("Name")?)))]));
            design_index += 1;
        }
        Ok(())
    });
    let path = string_of(&presentation.member("FullName")?);
    let slide_count = int_of(&presentation.member("Slides")?.member("Count")?)?;
    let slide_width = double_of(&presentation.member("PageSetup")?.member("SlideWidth")?)?;
    let slide_height = double_of(&presentation.member("PageSetup")?.member("SlideHeight")?)?;
    let theme = presentation
        .member("Designs")
        .and_then(|designs| item_of(&designs, 1))
        .and_then(|design| design.member("Name"))
        .map(|name| string_of(&name))
        .unwrap_or_default();
    let pagination = if paged {
        let returned = slides.len() as i64;
        let total = to_index(slide_total()?);
        let next_offset =
            if !has_pages && slide_offset + returned < slide_total()? { Value::Int(to_index(slide_offset + returned)) } else { Value::Null };
        ordered(vec![
            ("unit", Value::string("slide")),
            ("offset", Value::Int(to_index(slide_offset))),
            ("limit", Value::Int(to_index(slide_limit))),
            ("returned", Value::Int(to_index(returned))),
            ("total", Value::Int(total)),
            ("nextOffset", next_offset),
        ])
    } else {
        Value::Null
    };
    Ok(ordered(vec![
        ("format", Value::string("pptx")),
        ("path", Value::String(path)),
        ("slideCount", Value::Int(slide_count)),
        ("slideWidth", Value::Double(slide_width)),
        ("slideHeight", Value::Double(slide_height)),
        ("layoutCount", Value::Int(to_index(layouts.len() as i64))),
        ("layouts", Value::Array(layouts)),
        ("designCount", Value::Int(to_index(designs.len() as i64))),
        ("designs", Value::Array(designs)),
        ("slides", Value::Array(slides)),
        ("theme", Value::String(theme)),
        ("pagination", pagination),
    ]))
}
