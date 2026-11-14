# Standard fonts

The fourteen font files of pdfjs-dist 6.4.299 `standard_fonts/` (the Foxit Type 1 fonts for Courier, Times, Symbol and
ZapfDingbats, and Liberation Sans for Helvetica), copied unchanged together with their two licence texts
(`LICENSE_FOXIT`, `LICENSE_LIBERATION`).

They are the substitutes pdf.js draws for the standard 14 fonts and for a font whose file is missing, under the name
table of `glyph/substitute.rs` (pdf.js `standard_fonts.js`). `glyph::substitute::StandardFonts` reads them from this
folder only in the rendering configuration, which hands the folder in (pdf.js `standardFontDataUrl`). The office
analysis configuration never creates a `StandardFonts`, so nothing here is read there.
