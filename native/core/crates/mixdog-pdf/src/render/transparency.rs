//! Transparency: `beginGroup`, `endGroup`, soft masks and what is painted under one (`src/display/canvas.js`).
//!
//! A group that needs isolation is painted on a canvas of its own, the size of its bounding box on the page, and
//! composited with the constant alpha and blend mode in force when it ends. A group with a soft mask is not composited:
//! its canvas becomes the mask, an alpha value for every pixel of the page (the luminosity of the group over the
//! backdrop colour, or its alpha, through the transfer function), and the `SMask` entry of a graphics state parameter
//! dictionary selects it. While a mask is selected everything painted goes to a transparent layer first; the layer is
//! multiplied by the mask and composited with the blend mode in force when the mask was selected, which is how pdf.js
//! paints in its soft-mask mode.

use std::sync::Arc;

use mixdog_raster::canvas::skia::{BlendMode, Color, FilterQuality, Pixmap, PixmapPaint, Transform};
use mixdog_raster::canvas::{Bitmap, Canvas, CompositeOperation, FillRule, Path2D};

use crate::error::Result;
use crate::object::Obj;
use crate::oplist::events::{GStateValue, Group};
use crate::oplist::gstate::BBOX_INIT;

use super::painter::{Painter, axial_bounding_box, intersect, raster, rect_path};
use super::pattern::moved;
use super::shading::apply_transfer;

/// `smaskStack`'s entry while the group of a soft mask is painted.
pub(super) struct SmaskMeta {
    offset_x: i32,
    offset_y: i32,
    subtype: String,
    backdrop: Option<String>,
    transfer_map: Option<Vec<u8>>,
}

/// `tempSMask`: a finished mask group, waiting for the graphics state that selects it.
pub(super) struct SmaskSource {
    canvas: Canvas,
    meta: SmaskMeta,
}

/// The soft mask in force (`activeSMask`): the alpha of every pixel of the group's canvas, and the alpha everywhere
/// else on the page.
pub(super) struct ActiveSMask {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    alpha: Vec<u8>,
    outside: u8,
    /// The `globalCompositeOperation` the layer is composited with.
    blend: &'static str,
}

/// `SkMulDiv255Round`: a channel scaled by an alpha.
fn mul255(channel: u8, alpha: u8) -> u8 {
    let product = u32::from(channel) * u32::from(alpha) + 128;
    ((product + (product >> 8)) >> 8) as u8
}

/// `#rrggbb` as its three bytes.
fn parse_hex(color: &str) -> Option<[u8; 3]> {
    let hex = color.strip_prefix('#').filter(|hex| hex.len() == 6)?;
    let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

/// The straight value of a premultiplied channel.
fn straight(channel: u8, alpha: u8) -> f64 {
    if alpha == 0 { 0.0 } else { (f64::from(channel) * 255.0 / f64::from(alpha)).round().min(255.0) }
}

/// `0.3 * r + 0.59 * g + 0.11 * b`.
fn luma(r: f64, g: f64, b: f64) -> f64 {
    0.3 * r + 0.59 * g + 0.11 * b
}

impl ActiveSMask {
    /// `_prepareSMaskCanvas` and `_bakeSMaskCanvas` without canvas filters (Node's canvas has none): the pixels of the
    /// mask group as one alpha value each. A luminosity mask is the group painted over its backdrop colour and
    /// weighed `0.3, 0.59, 0.11`; an alpha mask is the group's alpha. The transfer function maps either.
    fn build(source: SmaskSource, blend: &'static str) -> Self {
        let SmaskSource { canvas, meta } = source;
        let luminosity = meta.subtype == "Luminosity";
        let transfer = meta.transfer_map.as_deref();
        let backdrop = meta.backdrop.as_deref().and_then(parse_hex);
        let map = |value: u8| transfer.map_or(value, |t| t.get(usize::from(value)).copied().unwrap_or(0));
        let pixmap = canvas.pixmap();
        let mut alpha = Vec::with_capacity(canvas.width() as usize * canvas.height() as usize);
        for pixel in pixmap.data().chunks_exact(4) {
            let a = pixel[3];
            let value = if luminosity {
                let (r, g, b) = match backdrop {
                    // The group is painted over the backdrop colour: `destination-atop` of an opaque fill.
                    Some(color) => {
                        let over = |c: u8, back: u8| f64::from(c) + f64::from(mul255(back, 255 - a));
                        (over(pixel[0], color[0]), over(pixel[1], color[1]), over(pixel[2], color[2]))
                    }
                    None => (straight(pixel[0], a), straight(pixel[1], a), straight(pixel[2], a)),
                };
                map((luma(r, g, b) + 0.5) as i32 as u8)
            } else {
                map(a)
            };
            alpha.push(value);
        }
        // Outside the group's canvas the mask is what a layer without paint gives: the backdrop's own luminosity, or
        // the transfer function of nothing. An alpha mask without a transfer function is nothing there.
        let prepared = luminosity || (meta.subtype == "Alpha" && transfer.is_some());
        let outside = if !prepared {
            0
        } else if luminosity && let Some(color) = backdrop {
            map((luma(f64::from(color[0]), f64::from(color[1]), f64::from(color[2])) + 0.5).floor() as u8)
        } else {
            map(0)
        };
        Self { x: meta.offset_x, y: meta.offset_y, width: canvas.width(), height: canvas.height(), alpha, outside, blend }
    }

    fn alpha_at(&self, x: i32, y: i32) -> u8 {
        let (dx, dy) = (x - self.x, y - self.y);
        if dx < 0 || dy < 0 || dx as u32 >= self.width || dy as u32 >= self.height {
            return self.outside;
        }
        self.alpha[dy as usize * self.width as usize + dx as usize]
    }

    /// `destination-in` with the mask: every channel of the layer is scaled by the mask's alpha at its pixel.
    fn apply(&self, layer: &mut Pixmap) {
        let (width, height) = (layer.width() as i32, layer.height() as i32);
        let data = layer.data_mut();
        for y in 0..height {
            for x in 0..width {
                let mask = self.alpha_at(x, y);
                if mask == 255 {
                    continue;
                }
                let at = (y as usize * width as usize + x as usize) * 4;
                for channel in &mut data[at..at + 4] {
                    *channel = if mask == 0 { 0 } else { mul255(*channel, mask) };
                }
            }
        }
    }
}

/// The clip of a group: its bounding box moved by the group's matrix.
fn group_clip(bbox: &[f32; 4], matrix: Option<&[f64; 6]>) -> Path2D {
    let clip = rect_path(f64::from(bbox[0]), f64::from(bbox[1]), f64::from(bbox[2]), f64::from(bbox[3]));
    match matrix {
        Some(m) => moved(&clip, m),
        None => clip,
    }
}

/// `#convertGroupToGray`: the colours of the group as the grey of their luminance, the alpha kept.
fn convert_to_gray(canvas: &mut Canvas) -> Result<()> {
    let mut data = canvas.get_image_data(0, 0, canvas.width(), canvas.height()).map_err(raster)?;
    for pixel in data.data_mut().chunks_exact_mut(4) {
        let gray = (f64::from(pixel[0]) * 0.2126 + f64::from(pixel[1]) * 0.7152 + f64::from(pixel[2]) * 0.0722 + 0.5) as i32 as u8;
        pixel[0] = gray;
        pixel[1] = gray;
        pixel[2] = gray;
    }
    canvas.put_image_data(&data, 0, 0, None);
    Ok(())
}

impl Painter<'_> {
    /// `copyCtxState`: the styles and line state of one canvas onto another.
    fn copy_canvas_state(&self, to: &mut Canvas) {
        to.set_fill_style(self.canvas.fill_style().clone());
        to.set_stroke_style(self.canvas.stroke_style().clone());
        to.set_line_width(self.canvas.line_width());
        to.set_line_cap(self.current.line_cap);
        to.set_line_join(self.current.line_join);
        to.set_miter_limit(self.current.miter_limit);
        to.set_line_dash(self.canvas.line_dash());
        to.set_line_dash_offset(self.current.dash_phase as f32);
    }

    /// `beginGroup`.
    pub(super) fn begin_group(&mut self, group: &Group) -> Result<()> {
        if !self.content_visible {
            return Ok(());
        }
        self.save();
        let in_smask_mode = self.current.active_smask.is_some();
        if in_smask_mode {
            self.current.active_smask = None;
        }
        let plain = (!group.needs_isolation || (!group.isolated && !group.has_soft_mask))
            && !group.knockout
            && !group.is_gray
            && self.canvas.global_alpha() == 1.0
            && self.canvas.global_composite_operation() == CompositeOperation::SourceOver
            && !in_smask_mode;
        if plain {
            if let Some(bbox) = &group.bbox {
                self.canvas.clip_path2d(&group_clip(bbox, group.matrix.as_ref()), FillRule::Winding);
            }
            self.group_stack.push(None);
            return Ok(());
        }
        let current_transform = self.canvas.get_transform();
        if let Some(m) = &group.matrix {
            self.canvas.transform(m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32, m[4] as f32, m[5] as f32);
        }
        let canvas_bounds = [0.0, 0.0, f64::from(self.canvas.width()), f64::from(self.canvas.height())];
        let bounds = match &group.bbox {
            Some(bbox) => {
                let mut out = BBOX_INIT.map(f64::from);
                axial_bounding_box(&bbox.map(f64::from), &self.ctm(), &mut out);
                intersect(&out, &canvas_bounds).unwrap_or([0.0; 4])
            }
            None => canvas_bounds,
        };
        let offset_x = bounds[0].floor();
        let offset_y = bounds[1].floor();
        let drawn_width = (bounds[2].ceil() - offset_x).max(1.0);
        let drawn_height = (bounds[3].ceil() - offset_y).max(1.0);
        self.current.start_new_path_and_clip_box([0.0, 0.0, drawn_width, drawn_height]);
        let mut group_canvas = Canvas::new(drawn_width as u32, drawn_height as u32).map_err(raster)?;
        group_canvas.translate(-offset_x as f32, -offset_y as f32);
        group_canvas.transform(
            current_transform[0],
            current_transform[1],
            current_transform[2],
            current_transform[3],
            current_transform[4],
            current_transform[5],
        );
        if let Some(bbox) = &group.bbox {
            group_canvas.clip_path2d(&group_clip(bbox, group.matrix.as_ref()), FillRule::Winding);
        }
        if let Some(smask) = &group.smask {
            self.smask_stack.push(SmaskMeta {
                offset_x: offset_x as i32,
                offset_y: offset_y as i32,
                subtype: smask.subtype.clone(),
                backdrop: smask.backdrop.clone(),
                transfer_map: smask.transfer_map.clone(),
            });
        } else {
            self.canvas.set_transform(1.0, 0.0, 0.0, 1.0, 0.0, 0.0);
            self.canvas.translate(offset_x as f32, offset_y as f32);
            self.canvas.save();
        }
        self.copy_canvas_state(&mut group_canvas);
        let parent = std::mem::replace(&mut self.canvas, group_canvas);
        self.set_gstate(&[
            ("BM".to_owned(), GStateValue::BlendMode("source-over")),
            ("ca".to_owned(), GStateValue::Value(Obj::Num(1.0))),
            ("CA".to_owned(), GStateValue::Value(Obj::Num(1.0))),
            ("TR".to_owned(), GStateValue::Transfer(None)),
        ]);
        self.group_stack.push(Some(parent));
        Ok(())
    }

    /// `endGroup`.
    pub(super) fn end_group(&mut self, group: &Group) -> Result<()> {
        if !self.content_visible {
            return Ok(());
        }
        let Some(slot) = self.group_stack.pop() else {
            return Ok(());
        };
        let Some(parent) = slot else {
            self.restore();
            return Ok(());
        };
        let mut group_canvas = std::mem::replace(&mut self.canvas, parent);
        if group.is_gray {
            convert_to_gray(&mut group_canvas)?;
        }
        if group.smask.is_some() {
            if let Some(meta) = self.smask_stack.pop() {
                self.temp_smask = Some(SmaskSource { canvas: group_canvas, meta });
            }
            self.restore();
            return Ok(());
        }
        // The matrix of the canvas the group is drawn with: the offset of the group on the page.
        self.canvas.restore();
        let placement = self.canvas.get_transform();
        self.restore();
        if let Some(maps) = self.current.transfer.clone() {
            apply_transfer(&mut group_canvas, &maps)?;
        }
        let bitmap = Bitmap::from_canvas(&group_canvas);
        self.in_smask_layer(move |painter| {
            painter.canvas.save();
            painter.canvas.set_transform(placement[0], placement[1], placement[2], placement[3], placement[4], placement[5]);
            painter.canvas.draw_image(&bitmap, 0.0, 0.0);
            painter.canvas.restore();
            Ok(())
        })
    }

    /// The `SMask` entry of a graphics state parameter dictionary: the finished mask group is selected, or none.
    pub(super) fn set_smask(&mut self, selected: bool) {
        let source = self.temp_smask.take();
        if !selected {
            self.current.active_smask = None;
            return;
        }
        let was_active = self.current.active_smask.is_some();
        match source {
            Some(source) => {
                let blend = self.current.blend_mode;
                self.current.active_smask = Some(Arc::new(ActiveSMask::build(source, blend)));
                if !was_active {
                    // `beginSMaskMode`: what is painted from here on is painted `source-over` on the layer.
                    self.canvas.set_global_composite_operation("source-over");
                    self.current.blend_mode = "source-over";
                }
            }
            None => self.current.active_smask = None,
        }
    }

    /// `paint` as one element of the page: when a soft mask is selected it paints on a transparent layer that is then
    /// multiplied by the mask and composited (`compose`), otherwise it paints in place.
    pub(super) fn in_smask_layer(&mut self, paint: impl FnOnce(&mut Self) -> Result<()>) -> Result<()> {
        let Some(mask) = self.current.active_smask.clone() else {
            return paint(self);
        };
        if self.in_layer {
            return paint(self);
        }
        self.in_layer = true;
        let backdrop = self.canvas.pixmap().clone();
        self.canvas.pixmap_mut().fill(Color::TRANSPARENT);
        let result = paint(self);
        self.in_layer = false;
        let mut layer = std::mem::replace(self.canvas.pixmap_mut(), backdrop);
        mask.apply(&mut layer);
        let clip = self.canvas.clip_mask().cloned();
        let blend = CompositeOperation::parse(mask.blend).map_or(BlendMode::SourceOver, CompositeOperation::blend_mode);
        let composite = PixmapPaint { opacity: 1.0, blend_mode: blend, quality: FilterQuality::Nearest };
        self.canvas.pixmap_mut().draw_pixmap(0, 0, layer.as_ref(), &composite, Transform::identity(), clip.as_ref());
        result
    }

    /// The canvas the painter began on: groups left open by a list that does not close them are dropped.
    pub(super) fn into_base_canvas(mut self) -> Canvas {
        while let Some(slot) = self.group_stack.pop() {
            if let Some(parent) = slot {
                self.canvas = parent;
            }
        }
        self.canvas
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask_canvas(rgba: [u8; 4]) -> Canvas {
        let mut canvas = Canvas::new(2, 2).expect("canvas");
        canvas.set_fill_color(&format!("rgba({}, {}, {}, {})", rgba[0], rgba[1], rgba[2], f64::from(rgba[3]) / 255.0));
        canvas.fill_rect(0.0, 0.0, 2.0, 2.0);
        canvas
    }

    fn source(canvas: Canvas, subtype: &str, backdrop: Option<&str>, transfer_map: Option<Vec<u8>>) -> SmaskSource {
        SmaskSource { canvas, meta: SmaskMeta { offset_x: 10, offset_y: 20, subtype: subtype.to_owned(), backdrop: backdrop.map(str::to_owned), transfer_map } }
    }

    #[test]
    fn a_luminosity_mask_weighs_the_colours_over_the_backdrop() {
        let white = ActiveSMask::build(source(mask_canvas([255, 255, 255, 255]), "Luminosity", Some("#000000"), None), "source-over");
        assert_eq!(white.alpha_at(10, 20), 255);
        let red = ActiveSMask::build(source(mask_canvas([255, 0, 0, 255]), "Luminosity", Some("#000000"), None), "source-over");
        // 0.3 * 255 + 0.5 = 77.
        assert_eq!(red.alpha_at(11, 21), 77);
        // Painted transparent over a white backdrop the group is white.
        let clear = ActiveSMask::build(source(mask_canvas([0, 0, 0, 0]), "Luminosity", Some("#ffffff"), None), "source-over");
        assert_eq!(clear.alpha_at(10, 20), 255);
    }

    #[test]
    fn outside_the_group_a_luminosity_mask_is_the_backdrop() {
        let black = ActiveSMask::build(source(mask_canvas([255, 255, 255, 255]), "Luminosity", Some("#000000"), None), "source-over");
        assert_eq!(black.alpha_at(0, 0), 0);
        assert_eq!(black.alpha_at(12, 20), 0, "just past the right edge");
        let white = ActiveSMask::build(source(mask_canvas([255, 255, 255, 255]), "Luminosity", Some("#ffffff"), None), "source-over");
        assert_eq!(white.alpha_at(0, 0), 255);
    }

    #[test]
    fn an_alpha_mask_is_the_alpha_and_the_transfer_function_maps_it() {
        let plain = ActiveSMask::build(source(mask_canvas([0, 0, 0, 128]), "Alpha", None, None), "source-over");
        assert_eq!(plain.alpha_at(10, 20), 128);
        assert_eq!(plain.alpha_at(0, 0), 0);
        let inverted: Vec<u8> = (0..=255u8).rev().collect();
        let mapped = ActiveSMask::build(source(mask_canvas([0, 0, 0, 255]), "Alpha", None, Some(inverted)), "source-over");
        assert_eq!(mapped.alpha_at(10, 20), 0);
        assert_eq!(mapped.alpha_at(0, 0), 255, "outside, nothing maps to the transfer of zero");
    }

    #[test]
    fn the_mask_scales_every_channel_of_the_layer() {
        let mask = ActiveSMask::build(source(mask_canvas([0, 0, 0, 128]), "Alpha", None, None), "source-over");
        let mut layer = Canvas::new(14, 24).expect("layer");
        layer.set_fill_color("#ff0000");
        layer.fill_rect(0.0, 0.0, 14.0, 24.0);
        let mut pixmap = layer.into_pixmap();
        mask.apply(&mut pixmap);
        let at = |x: usize, y: usize| pixmap.data()[(y * 14 + x) * 4..(y * 14 + x) * 4 + 4].to_vec();
        assert_eq!(at(10, 20), vec![128, 0, 0, 128]);
        assert_eq!(at(1, 1), vec![0, 0, 0, 0]);
    }

    #[test]
    fn colours_become_the_grey_of_their_luminance() {
        let mut canvas = Canvas::new(1, 1).expect("canvas");
        canvas.set_fill_color("#ff0000");
        canvas.fill_rect(0.0, 0.0, 1.0, 1.0);
        convert_to_gray(&mut canvas).expect("converted");
        let pixel = canvas.get_image_data(0, 0, 1, 1).expect("pixel");
        // 255 * 0.2126 + 0.5 = 54.
        assert_eq!(pixel.data(), &[54, 54, 54, 255]);
    }
}
