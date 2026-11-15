//! The office authoring runners. This crate holds, module by module, the ports of `src/runtime/office/authoring/`:
//! the composition brief a script or an HTML deck opens with (`brief`), read back as information (the slide plan,
//! the directions, the fact sheet) and held against the saved deck by the review and by the author gates; the review
//! artifacts (`review_artifacts`: the receipt and the labelled contact sheet of `contact_sheet`) and the note of which
//! HTML a session's file was built from (`source_drift`). `docx_build` is the Word HTML builder (`authoring/docx-html-build.mjs`: the flow
//! `measure_docx` read from the browser becomes WordprocessingML written block by block on the portable writer) and
//! `docx_html_runner` the Word HTML runner (`authoring/docx-html-runner.mjs`: measure, photograph the captures, print the same HTML
//! as the review reference, build, keep `<document>.mixdog-source.html` and the page images of the print).
//! `xlsx_build` is the Excel HTML builder (`authoring/xlsx-html-build.mjs`: the sheets `measure_xlsx` read from the browser become a
//! workbook on a column grid cut at the browser's box edges, written through the workbook batch of mixdog-ooxml) and `xlsx_html_runner`
//! the Excel HTML runner (`authoring/xlsx-html-runner.mjs`: measure, photograph the pictures and each section, build, keep
//! `<workbook>.mixdog-source.html` and the sheet pictures).

pub mod brief;
pub mod contact_sheet;
pub mod review_artifacts;
pub mod source_drift;
pub mod cdp;
pub mod geometry;
pub mod html_browser;
pub mod icons;
pub mod measure_deck;
pub mod page;
pub mod pptx_writer;
pub mod measure_docx;
pub mod measure_xlsx;
pub mod pdf_print;
pub mod normalize;
pub mod receipt;
pub mod pptx_build;
pub mod pptx_html_runner;
pub mod docx_build;
pub mod docx_html_runner;
pub mod xlsx_build;
pub mod xlsx_html_runner;
