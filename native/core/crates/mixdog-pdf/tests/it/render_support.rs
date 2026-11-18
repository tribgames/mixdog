//! Helpers of the rendering tests: a one-page PDF assembled from a content stream, rendered to RGBA.

use std::sync::Arc;

use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::render::{RenderOptions, render_page};

pub fn stream(dict: &str, bytes: &[u8]) -> Vec<u8> {
    [format!("<< {dict} /Length {} >>\nstream\n", bytes.len()).as_bytes(), bytes, b"\nendstream"].concat()
}

/// A one-page PDF with `media_box`, `page_extra` page entries, the resource dictionary body `resources`, and `extra`
/// objects numbered from 5 (1 is the catalog, 2 the page tree, 3 the page, 4 its content).
pub fn pdf(media_box: &str, page_extra: &str, content: &str, resources: &str, extra: &[Vec<u8>]) -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}] {page_extra} /Contents 4 0 R /Resources << {resources} >> >>"
        )
        .into_bytes(),
        stream("", content.as_bytes()),
    ];
    objects.extend(extra.iter().cloned());
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    let size = objects.len() + 1;
    out.extend_from_slice(format!("xref\n0 {size}\n0000000000 65535 f \n").as_bytes());
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes());
    out
}

pub struct Rendered {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

impl Rendered {
    pub fn at(&self, x: usize, y: usize) -> [u8; 4] {
        let i = (y * self.width + x) * 4;
        [self.rgba[i], self.rgba[i + 1], self.rgba[i + 2], self.rgba[i + 3]]
    }
}

pub fn render_scaled(bytes: Vec<u8>, scale: f64) -> Rendered {
    let options = OpenOptions { use_system_fonts: false, ..OpenOptions::default() };
    let document = Document::open(Arc::<[u8]>::from(bytes), &options).expect("opens");
    let page = document.page(0).expect("page");
    let rendered = render_page(&document, &page, &RenderOptions { scale, fonts: None, drawing: None }).expect("renders");
    Rendered { width: rendered.width() as usize, height: rendered.height() as usize, rgba: rendered.rgba().expect("pixels") }
}

/// A 20 x 20 point page with `content` and `resources`, rendered at scale 1.
pub fn render(content: &str, resources: &str, extra: &[Vec<u8>]) -> Rendered {
    render_scaled(pdf("0 0 20 20", "", content, resources, extra), 1.0)
}

pub const WHITE: [u8; 4] = [255, 255, 255, 255];
