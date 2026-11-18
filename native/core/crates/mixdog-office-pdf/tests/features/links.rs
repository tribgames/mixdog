//! The links the layout reports for a page: which link annotations are listed, by their flags.

use mixdog_fsio::Unlaned;
use mixdog_office_pdf::{LayoutOptions, PdfSource, extract_pdf_text_layout};

fn file(objects: &[&str]) -> Vec<u8> {
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend(format!("{} 0 obj\n{body}\nendobj\n", index + 1).as_bytes());
    }
    let start = pdf.len();
    pdf.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for at in offsets {
        pdf.extend(format!("{at:010} 00000 n \n").as_bytes());
    }
    pdf.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n", objects.len() + 1).as_bytes());
    pdf
}

fn link(flags: Option<u32>, url: &str, left: u32) -> String {
    let flags = flags.map(|f| format!("/F {f}")).unwrap_or_default();
    format!("<< /Type /Annot /Subtype /Link /Rect [{left} 10 {} 30] {flags} /A << /S /URI /URI ({url}) >> >>", left + 20)
}

#[test]
fn a_link_is_listed_unless_it_is_set_not_to_be_viewed() {
    // The links are what a viewer can offer a click on: pdf.js's list drops a link with NoView (32) and keeps one that
    // is Hidden (2), Invisible (1; a link's own Invisible bit is cleared on reading) or print-only (4). The listing
    // follows that list and does not filter further.
    let annotations = [
        link(None, "https://example.com/plain", 10),
        link(Some(2), "https://example.com/hidden", 40),
        link(Some(1), "https://example.com/invisible", 70),
        link(Some(32), "https://example.com/noview", 100),
        link(Some(4), "https://example.com/print", 130),
    ];
    let page = format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Annots [{}] >>", annotations.join(" "));
    let bytes = file(&["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", &page]);
    let layout = extract_pdf_text_layout(&Unlaned, PdfSource::Bytes(&bytes), &LayoutOptions::default()).expect("a layout");
    let urls: Vec<&str> = layout.pages[0].links.iter().filter_map(|l| l.url.as_deref()).collect();
    assert_eq!(
        urls,
        [
            "https://example.com/plain",
            "https://example.com/hidden",
            "https://example.com/invisible",
            "https://example.com/print"
        ]
    );
}
