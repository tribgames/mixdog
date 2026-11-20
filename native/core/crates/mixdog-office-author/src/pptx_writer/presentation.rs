//! The presentation (`PptxGenJS`): its layouts, document properties and slides, and the package it writes: content
//! types, root relationships, `docProps`, the presentation part and its relationships, the theme, the slide layout,
//! the slides with their relationships and notes, the master, the notes master and the media, created in the order
//! pptxgenjs's `exportPresentation` creates them.

use mixdog_ooxml::zipio::Package;

use super::charts::{ChartData, ChartKind, ChartOptions};
use super::slide::{Slide, SlideNumber};
use super::theme::{
    LAYOUT_RELS, MASTER_RELS, NOTES_MASTER, NOTES_MASTER_RELS, PRES_PROPS, ROOT_RELS, TABLE_STYLES, ThemeFonts, VIEW_PROPS, layout_xml, master_xml,
    notes_slide_rels_xml, theme_xml,
};
use super::{CRLF, EMU, Layout, encode_xml_entities, round};

/// The chart parts counted so far in this process, as the library counts them.
static CHART_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The folders `exportPresentation` creates first, in its order.
const FOLDERS: [&str; 19] = [
    "_rels",
    "docProps",
    "ppt",
    "ppt/_rels",
    "ppt/charts",
    "ppt/charts/_rels",
    "ppt/embeddings",
    "ppt/media",
    "ppt/slideLayouts",
    "ppt/slideLayouts/_rels",
    "ppt/slideMasters",
    "ppt/slideMasters/_rels",
    "ppt/slides",
    "ppt/slides/_rels",
    "ppt/theme",
    "ppt/notesMasters",
    "ppt/notesMasters/_rels",
    "ppt/notesSlides",
    "ppt/notesSlides/_rels",
];

const REL_BASE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// A presentation being written.
#[derive(Debug, Clone)]
pub struct Presentation {
    layouts: Vec<(String, Layout)>,
    layout: Layout,
    title: String,
    subject: String,
    author: String,
    company: String,
    revision: String,
    rtl_mode: bool,
    theme: ThemeFonts,
    slides: Vec<Slide>,
    master_slide_number: Option<SlideNumber>,
    layout_slide_number: Option<SlideNumber>,
}

impl Default for Presentation {
    fn default() -> Self {
        Self::new()
    }
}

impl Presentation {
    /// `new PptxGenJS()`: the 16:9 sheet, the default properties, no slides.
    pub fn new() -> Self {
        let layout = |name: &str, width: f64, height: f64| Layout { name: name.to_owned(), width, height };
        Self {
            layouts: vec![
                ("LAYOUT_4x3".to_owned(), layout("screen4x3", 9_144_000.0, 6_858_000.0)),
                ("LAYOUT_16x9".to_owned(), layout("screen16x9", 9_144_000.0, 5_143_500.0)),
                ("LAYOUT_16x10".to_owned(), layout("screen16x10", 9_144_000.0, 5_715_000.0)),
                ("LAYOUT_WIDE".to_owned(), layout("custom", 12_192_000.0, 6_858_000.0)),
            ],
            layout: layout("screen16x9", 9_144_000.0, 5_143_500.0),
            title: "PptxGenJS Presentation".to_owned(),
            subject: "PptxGenJS Presentation".to_owned(),
            author: "PptxGenJS".to_owned(),
            company: "PptxGenJS".to_owned(),
            revision: "1".to_owned(),
            rtl_mode: false,
            theme: ThemeFonts::default(),
            slides: Vec::new(),
            master_slide_number: None,
            layout_slide_number: None,
        }
    }

    /// `pres.layout = key`: one of `LAYOUT_4x3`, `LAYOUT_16x9`, `LAYOUT_16x10`, `LAYOUT_WIDE` or a name given to
    /// [`Presentation::define_layout`]. Slides added after it have its size.
    pub fn set_layout(&mut self, key: &str) -> Result<(), String> {
        match self.layouts.iter().find(|(name, _)| name == key) {
            Some((_, layout)) => {
                self.layout = layout.clone();
                Ok(())
            }
            None => Err("UNKNOWN-LAYOUT".to_owned()),
        }
    }

    /// `pres.defineLayout({ name, width, height })`, in inches.
    pub fn define_layout(&mut self, name: &str, width: f64, height: f64) {
        let layout = Layout { name: name.to_owned(), width: round(width * EMU), height: round(height * EMU) };
        match self.layouts.iter_mut().find(|(key, _)| key == name) {
            Some(entry) => entry.1 = layout,
            None => self.layouts.push((name.to_owned(), layout)),
        }
    }

    /// The size of the sheet new slides are made on.
    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    pub fn set_title(&mut self, title: &str) {
        self.title = title.to_owned();
    }

    pub fn set_subject(&mut self, subject: &str) {
        self.subject = subject.to_owned();
    }

    pub fn set_author(&mut self, author: &str) {
        self.author = author.to_owned();
    }

    pub fn set_company(&mut self, company: &str) {
        self.company = company.to_owned();
    }

    pub fn set_revision(&mut self, revision: &str) {
        self.revision = revision.to_owned();
    }

    pub fn set_rtl_mode(&mut self, rtl: bool) {
        self.rtl_mode = rtl;
    }

    /// `pres.theme = { headFontFace, bodyFontFace }`.
    pub fn set_theme(&mut self, theme: ThemeFonts) {
        self.theme = theme;
    }

    /// What `addChart` leaves behind when it throws while reading its data: the library has counted the chart already, so the next one is numbered after it.
    pub fn count_failed_chart(&mut self) {
        CHART_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    /// `slide.addChart(type, data, options)` on the slide at `index`.
    pub fn add_chart(&mut self, index: usize, kind: ChartKind, data: Vec<ChartData>, options: ChartOptions) -> Result<(), String> {
        // pptxgenjs keeps `_chartCounter` at module level: chart part numbers keep rising across the decks of one process.
        let id = CHART_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let slide = self.slides.get_mut(index).ok_or_else(|| format!("no slide {index}"))?;
        slide.add_chart(kind, data, options, id)
    }

    /// `pres.addSlide()`: a new last slide on the current sheet.
    pub fn add_slide(&mut self) -> &mut Slide {
        self.slides.push(Slide::new(self.slides.len() + 1, self.layout.clone()));
        let last = self.slides.len() - 1;
        &mut self.slides[last]
    }

    /// The slide at `index` (0 is the first).
    pub fn slide_mut(&mut self, index: usize) -> Option<&mut Slide> {
        self.slides.get_mut(index)
    }

    /// The number of slides.
    pub fn slide_count(&self) -> usize {
        self.slides.len()
    }

    /// `slide.slideNumber = props` on the slide at `index`: the number is on that slide, and the master and the
    /// layout of the whole deck take it too (the other slides do not).
    pub fn set_slide_number(&mut self, index: usize, props: SlideNumber) -> Result<(), String> {
        let slide = self.slides.get_mut(index).ok_or_else(|| format!("no slide {index}"))?;
        slide.slide_number = Some(props.clone());
        self.master_slide_number = Some(props.clone());
        self.layout_slide_number = Some(props);
        Ok(())
    }

    /// `[Content_Types].xml` (`makeXmlContTypes`).
    fn content_types_xml(&self) -> String {
        let mut xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{CRLF}");
        xml.push_str("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">");
        xml.push_str("<Default Extension=\"xml\" ContentType=\"application/xml\"/>");
        xml.push_str("<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>");
        xml.push_str("<Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>");
        xml.push_str("<Default Extension=\"jpg\" ContentType=\"image/jpg\"/>");
        xml.push_str("<Default Extension=\"svg\" ContentType=\"image/svg+xml\"/>");
        xml.push_str("<Default Extension=\"png\" ContentType=\"image/png\"/>");
        xml.push_str("<Default Extension=\"gif\" ContentType=\"image/gif\"/>");
        xml.push_str("<Default Extension=\"m4v\" ContentType=\"video/mp4\"/>");
        xml.push_str("<Default Extension=\"mp4\" ContentType=\"video/mp4\"/>");
        for slide in &self.slides {
            for rel in &slide.rels_media {
                if rel.mime != "image" && rel.mime != "online" && rel.mime != "chart" && rel.extn != "m4v" && !xml.contains(&rel.mime) {
                    xml.push_str(&format!("<Default Extension=\"{}\" ContentType=\"{}\"/>", rel.extn, rel.mime));
                }
            }
        }
        xml.push_str("<Default Extension=\"vml\" ContentType=\"application/vnd.openxmlformats-officedocument.vmlDrawing\"/>");
        xml.push_str("<Default Extension=\"xlsx\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\"/>");
        xml.push_str(
            "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>",
        );
        xml.push_str("<Override PartName=\"/ppt/notesMasters/notesMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml\"/>");
        for (at, slide) in self.slides.iter().enumerate() {
            let index = at + 1;
            xml.push_str(&format!("<Override PartName=\"/ppt/slideMasters/slideMaster{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>"));
            xml.push_str(&format!(
                "<Override PartName=\"/ppt/slides/slide{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"
            ));
            for chart in slide.charts() {
                xml.push_str(&format!(
                    "<Override PartName=\"{}\" ContentType=\"application/vnd.openxmlformats-officedocument.drawingml.chart+xml\"/>",
                    chart.target()
                ));
            }
        }
        xml.push_str("<Override PartName=\"/ppt/presProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presProps+xml\"/>");
        xml.push_str("<Override PartName=\"/ppt/viewProps.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml\"/>");
        xml.push_str("<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>");
        xml.push_str(
            "<Override PartName=\"/ppt/tableStyles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml\"/>",
        );
        xml.push_str("<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>");
        for index in 1..=self.slides.len() {
            xml.push_str(&format!("<Override PartName=\"/ppt/notesSlides/notesSlide{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml\"/>"));
        }
        xml.push_str(" <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>");
        xml.push_str(" <Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>");
        xml.push_str("</Types>");
        xml
    }

    /// `docProps/app.xml` (`makeXmlApp`).
    fn app_xml(&self) -> String {
        let count = self.slides.len();
        let titles: String = (1..=count).map(|index| format!("<vt:lpstr>Slide {index}</vt:lpstr>")).collect();
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{CRLF}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\">\n\t<TotalTime>0</TotalTime>\n\t<Words>0</Words>\n\t<Application>Microsoft Office PowerPoint</Application>\n\t<PresentationFormat>On-screen Show (16:9)</PresentationFormat>\n\t<Paragraphs>0</Paragraphs>\n\t<Slides>{count}</Slides>\n\t<Notes>{count}</Notes>\n\t<HiddenSlides>0</HiddenSlides>\n\t<MMClips>0</MMClips>\n\t<ScaleCrop>false</ScaleCrop>\n\t<HeadingPairs>\n\t\t<vt:vector size=\"6\" baseType=\"variant\">\n\t\t\t<vt:variant><vt:lpstr>Fonts Used</vt:lpstr></vt:variant>\n\t\t\t<vt:variant><vt:i4>2</vt:i4></vt:variant>\n\t\t\t<vt:variant><vt:lpstr>Theme</vt:lpstr></vt:variant>\n\t\t\t<vt:variant><vt:i4>1</vt:i4></vt:variant>\n\t\t\t<vt:variant><vt:lpstr>Slide Titles</vt:lpstr></vt:variant>\n\t\t\t<vt:variant><vt:i4>{count}</vt:i4></vt:variant>\n\t\t</vt:vector>\n\t</HeadingPairs>\n\t<TitlesOfParts>\n\t\t<vt:vector size=\"{}\" baseType=\"lpstr\">\n\t\t\t<vt:lpstr>Arial</vt:lpstr>\n\t\t\t<vt:lpstr>Calibri</vt:lpstr>\n\t\t\t<vt:lpstr>Office Theme</vt:lpstr>\n\t\t\t{titles}\n\t\t</vt:vector>\n\t</TitlesOfParts>\n\t<Company>{}</Company>\n\t<LinksUpToDate>false</LinksUpToDate>\n\t<SharedDoc>false</SharedDoc>\n\t<HyperlinksChanged>false</HyperlinksChanged>\n\t<AppVersion>16.0000</AppVersion>\n\t</Properties>",
            count + 3,
            self.company
        )
    }

    /// `docProps/core.xml` (`makeXmlCore`): created and modified are the moment of writing.
    fn core_xml(&self) -> String {
        let now = iso_now();
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\t<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">\n\t\t<dc:title>{}</dc:title>\n\t\t<dc:subject>{}</dc:subject>\n\t\t<dc:creator>{}</dc:creator>\n\t\t<cp:lastModifiedBy>{}</cp:lastModifiedBy>\n\t\t<cp:revision>{}</cp:revision>\n\t\t<dcterms:created xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:created>\n\t\t<dcterms:modified xsi:type=\"dcterms:W3CDTF\">{now}</dcterms:modified>\n\t</cp:coreProperties>",
            encode_xml_entities(&self.title),
            encode_xml_entities(&self.subject),
            encode_xml_entities(&self.author),
            encode_xml_entities(&self.author),
            self.revision
        )
    }

    /// `ppt/_rels/presentation.xml.rels` (`makeXmlPresentationRels`).
    fn presentation_rels_xml(&self) -> String {
        let mut xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{CRLF}");
        xml.push_str("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        xml.push_str(&format!("<Relationship Id=\"rId1\" Type=\"{REL_BASE}/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>"));
        let mut number = 1;
        for index in 1..=self.slides.len() {
            number += 1;
            xml.push_str(&format!("<Relationship Id=\"rId{number}\" Type=\"{REL_BASE}/slide\" Target=\"slides/slide{index}.xml\"/>"));
        }
        number += 1;
        xml.push_str(&format!("<Relationship Id=\"rId{number}\" Type=\"{REL_BASE}/notesMaster\" Target=\"notesMasters/notesMaster1.xml\"/>"));
        xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{REL_BASE}/presProps\" Target=\"presProps.xml\"/>", number + 1));
        xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{REL_BASE}/viewProps\" Target=\"viewProps.xml\"/>", number + 2));
        xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{REL_BASE}/theme\" Target=\"theme/theme1.xml\"/>", number + 3));
        xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"{REL_BASE}/tableStyles\" Target=\"tableStyles.xml\"/>", number + 4));
        xml.push_str("</Relationships>");
        xml
    }

    /// `ppt/presentation.xml` (`makeXmlPresentation`).
    fn presentation_xml(&self) -> String {
        let mut xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{CRLF}<p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"{REL_BASE}\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" {} saveSubsetFonts=\"1\" autoCompressPictures=\"0\">",
            if self.rtl_mode { "rtl=\"1\"" } else { "" }
        );
        xml.push_str("<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>");
        xml.push_str("<p:sldIdLst>");
        for slide in &self.slides {
            xml.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", slide.id, slide.rid));
        }
        xml.push_str("</p:sldIdLst>");
        xml.push_str(&format!("<p:notesMasterIdLst><p:notesMasterId r:id=\"rId{}\"/></p:notesMasterIdLst>", self.slides.len() + 2));
        let sheet = &self.layout;
        xml.push_str(&format!("<p:sldSz cx=\"{}\" cy=\"{}\"/>", super::num(sheet.width), super::num(sheet.height)));
        xml.push_str(&format!("<p:notesSz cx=\"{}\" cy=\"{}\"/>", super::num(sheet.height), super::num(sheet.width)));
        xml.push_str("<p:defaultTextStyle>");
        for level in 1..10 {
            xml.push_str(&format!(
                "<a:lvl{level}pPr marL=\"{}\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:defRPr sz=\"1800\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl{level}pPr>",
                (level - 1) * 457_200
            ));
        }
        xml.push_str("</p:defaultTextStyle>");
        xml.push_str("</p:presentation>");
        xml
    }

    /// The package (`exportPresentation`): every part in pptxgenjs's order.
    pub fn package(&self) -> Result<Package, String> {
        let mut package = Package::new();
        for folder in FOLDERS {
            package.folder(folder);
        }
        package.set("[Content_Types].xml", self.content_types_xml());
        package.set("_rels/.rels", ROOT_RELS);
        package.set("docProps/app.xml", self.app_xml());
        package.set("docProps/core.xml", self.core_xml());
        package.set("ppt/_rels/presentation.xml.rels", self.presentation_rels_xml());
        package.set("ppt/theme/theme1.xml", theme_xml(&self.theme));
        package.set("ppt/presentation.xml", self.presentation_xml());
        package.set("ppt/presProps.xml", PRES_PROPS);
        package.set("ppt/tableStyles.xml", TABLE_STYLES);
        package.set("ppt/viewProps.xml", VIEW_PROPS);
        package.set("ppt/slideLayouts/slideLayout1.xml", layout_xml(self.layout_slide_number.as_ref()));
        package.set("ppt/slideLayouts/_rels/slideLayout1.xml.rels", LAYOUT_RELS);
        for (index, slide) in self.slides.iter().enumerate() {
            let number = index + 1;
            package.set(&format!("ppt/slides/slide{number}.xml"), slide.xml());
            package.set(&format!("ppt/slides/_rels/slide{number}.xml.rels"), slide.rels_xml());
            package.set(&format!("ppt/notesSlides/notesSlide{number}.xml"), slide.notes_xml());
            package.set(&format!("ppt/notesSlides/_rels/notesSlide{number}.xml.rels"), notes_slide_rels_xml(number));
        }
        package.set("ppt/slideMasters/slideMaster1.xml", master_xml(self.master_slide_number.as_ref()));
        package.set("ppt/slideMasters/_rels/slideMaster1.xml.rels", MASTER_RELS);
        package.set("ppt/notesMasters/notesMaster1.xml", NOTES_MASTER);
        package.set("ppt/notesMasters/_rels/notesMaster1.xml.rels", NOTES_MASTER_RELS);
        for slide in &self.slides {
            for rel in slide.rels_media.iter().filter(|rel| !rel.is_duplicate) {
                let name = rel.target.replacen("..", "ppt", 1);
                package.set(&name, rel.bytes().map_err(|error| format!("{name}: {error}"))?);
            }
        }
        for slide in &self.slides {
            for chart in slide.charts() {
                for (name, bytes) in chart.parts()? {
                    package.set(&name, bytes);
                }
            }
        }
        Ok(package)
    }

    /// The `.pptx` file's bytes.
    pub fn write(&self) -> Result<Vec<u8>, String> {
        self.package()?.generate()
    }
}

/// `new Date().toISOString().replace(/\.\d\d\dZ/, 'Z')`: the present moment in UTC, to the second.
fn iso_now() -> String {
    let seconds = (mixdog_office_base::clock::now_ms() / 1000.0).floor() as u64;
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let of_day = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", of_day / 3_600, of_day % 3_600 / 60, of_day % 60)
}

#[cfg(test)]
mod tests {
    use super::super::{Dim, ImageOptions, ShapeOptions};
    use super::*;

    #[test]
    fn a_deck_has_pptxgenjs_part_names_in_its_order() {
        let mut deck = Presentation::new();
        deck.set_layout("LAYOUT_WIDE").expect("layout");
        deck.add_slide().add_shape("rect", ShapeOptions { w: Some(Dim::Number(2.0)), ..ShapeOptions::default() }).expect("shape");
        deck.add_slide();
        let names = deck.package().expect("package").names();
        assert_eq!(names[0], "_rels/");
        assert_eq!(names[18], "ppt/notesSlides/_rels/");
        assert_eq!(
            &names[19..],
            [
                "[Content_Types].xml",
                "_rels/.rels",
                "docProps/app.xml",
                "docProps/core.xml",
                "ppt/_rels/presentation.xml.rels",
                "ppt/theme/theme1.xml",
                "ppt/presentation.xml",
                "ppt/presProps.xml",
                "ppt/tableStyles.xml",
                "ppt/viewProps.xml",
                "ppt/slideLayouts/slideLayout1.xml",
                "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
                "ppt/slides/slide1.xml",
                "ppt/slides/_rels/slide1.xml.rels",
                "ppt/notesSlides/notesSlide1.xml",
                "ppt/notesSlides/_rels/notesSlide1.xml.rels",
                "ppt/slides/slide2.xml",
                "ppt/slides/_rels/slide2.xml.rels",
                "ppt/notesSlides/notesSlide2.xml",
                "ppt/notesSlides/_rels/notesSlide2.xml.rels",
                "ppt/slideMasters/slideMaster1.xml",
                "ppt/slideMasters/_rels/slideMaster1.xml.rels",
                "ppt/notesMasters/notesMaster1.xml",
                "ppt/notesMasters/_rels/notesMaster1.xml.rels",
            ]
        );
    }

    #[test]
    fn the_sheet_size_is_the_layout_and_an_unknown_layout_is_refused() {
        let mut deck = Presentation::new();
        assert_eq!(deck.set_layout("LAYOUT_NOPE"), Err("UNKNOWN-LAYOUT".to_owned()));
        deck.define_layout("SHEET", 10.0, 5.625);
        deck.set_layout("SHEET").expect("defined");
        deck.add_slide();
        let package = deck.package().expect("package");
        let xml = package.text("ppt/presentation.xml");
        assert!(xml.contains("<p:sldSz cx=\"9144000\" cy=\"5143500\"/><p:notesSz cx=\"5143500\" cy=\"9144000\"/>"));
        assert!(xml.contains("<p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst><p:notesMasterIdLst><p:notesMasterId r:id=\"rId3\"/>"));
    }

    #[test]
    fn a_slide_number_reaches_the_master_and_the_layout_as_null_and_1000() {
        let mut deck = Presentation::new();
        deck.add_slide();
        deck.add_slide();
        deck.set_slide_number(1, SlideNumber::default()).expect("slide number");
        let package = deck.package().expect("package");
        assert!(package.text("ppt/slides/slide2.xml").contains("<a:t>2</a:t></a:fld>"));
        assert!(!package.text("ppt/slides/slide1.xml").contains("sldNum"));
        assert!(package.text("ppt/slideMasters/slideMaster1.xml").contains("<a:t>null</a:t></a:fld>"));
        assert!(package.text("ppt/slideLayouts/slideLayout1.xml").contains("<a:t>1000</a:t></a:fld>"));
        assert!(deck.set_slide_number(5, SlideNumber::default()).is_err());
    }

    #[test]
    fn pictures_are_written_under_media_with_their_content_type() {
        let mut deck = Presentation::new();
        let slide = deck.add_slide();
        slide.add_image(ImageOptions { data: Some("image/webp;base64,QUJD".to_owned()), ..Default::default() }).expect("image");
        slide.add_image(ImageOptions { data: Some("image/png;base64,REVG".to_owned()), ..Default::default() }).expect("image");
        let package = deck.package().expect("package");
        assert_eq!(package.file("ppt/media/image-1-1.webp"), Some(&b"ABC"[..]));
        assert_eq!(package.file("ppt/media/image-1-2.png"), Some(&b"DEF"[..]));
        let types = package.text("[Content_Types].xml");
        assert!(types.contains("<Default Extension=\"webp\" ContentType=\"image/webp\"/>"));
        assert_eq!(types.matches("Extension=\"png\"").count(), 1);
    }

    #[test]
    fn the_core_properties_carry_a_utc_time_to_the_second() {
        let core = Presentation::new().core_xml();
        let created = core.split("<dcterms:created xsi:type=\"dcterms:W3CDTF\">").nth(1).and_then(|rest| rest.split('<').next()).expect("created");
        assert_eq!(created.len(), 20);
        assert!(created.ends_with('Z') && created.as_bytes()[10] == b'T');
    }
}
