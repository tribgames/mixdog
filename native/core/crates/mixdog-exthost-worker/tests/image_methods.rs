//! The image and attached-document methods as the real worker serves them, driven through the pool over `ext_worker_dev`: what
//! each call answers for a good image, for bytes no decoder takes, and for a call that is malformed. Images are built here.
#![cfg(feature = "test-support")]

use std::path::Path;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_exthost::ExtHostConfig;
use mixdog_exthost::ExtHostPool;
use mixdog_exthost::RenderBrowserConfig;
use mixdog_protocol::ThreadId;
use serde_json::Value;
use serde_json::json;

fn pool() -> ExtHostPool {
    ExtHostPool::new(ExtHostConfig {
        program: PathBuf::from(mixdog_testkit::bin_exe!("ext_worker_dev")),
        args: Vec::new(),
        workers: 1,
        pending_cap: 64,
        spawn_io: mixdog_rt::testing::tokens().spawn_io,
        render_browser: RenderBrowserConfig { command: None, profile_root: std::env::temp_dir().join("mixdog-exthost-worker-image-tests"), no_sandbox: false },
    })
    .expect("the pool starts")
}

async fn ask(pool: &ExtHostPool, method: &str, params: Value) -> Result<Value, ExtError> {
    finish(pool, ExtCall { thread: ThreadId::from("image-methods"), method: method.to_owned(), params, paths: Vec::new() }).await
}

fn refused(outcome: Result<Value, ExtError>) -> (String, String) {
    match outcome {
        Err(ExtError::Failed { code, message }) => (code, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

const JUNK: &[u8] = b"not an image at all";

fn flat_png(width: u32, height: u32, rgb: [u8; 3]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for &b in bytes {
            crc ^= u32::from(b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let body = [&kind[..], data].concat();
        [(data.len() as u32).to_be_bytes().to_vec(), body.clone(), crc32(&body).to_be_bytes().to_vec()].concat()
    }
    let mut row = vec![0u8];
    for _ in 0..width {
        row.extend_from_slice(&rgb);
    }
    let raw: Vec<u8> = (0..height).flat_map(|_| row.clone()).collect();
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + u32::from(x)) % 65521;
        b = (b + a) % 65521;
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, part) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        zlib.extend_from_slice(&(part.len() as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(part.len() as u16)).to_le_bytes());
        zlib.extend_from_slice(part);
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = [width.to_be_bytes(), height.to_be_bytes()].concat();
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    [vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk(b"IHDR", &ihdr), chunk(b"IDAT", &zlib), chunk(b"IEND", &[])].concat()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_probe_answers_the_decoded_size_and_calls_bytes_no_decoder_takes_invalid() {
    let pool = pool();
    let png = flat_png(300, 200, [20, 200, 20]);
    assert_eq!(ask(&pool, "image.probe", json!({"data": b64(&png)})).await.unwrap(), json!({"ok": {"width": 300, "height": 200}}));
    assert_eq!(ask(&pool, "image.probe", json!({"data": b64(JUNK)})).await.unwrap(), json!({"error": "invalid"}));
    let (code, message) = refused(ask(&pool, "image.probe", json!({"data": 7})).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_validate_accepts_a_decodable_image_and_refuses_other_bytes() {
    let pool = pool();
    let png = flat_png(40, 30, [200, 20, 20]);
    assert_eq!(ask(&pool, "image.validate", json!({"data": b64(&png), "format": "png"})).await.unwrap(), json!({"ok": true}));
    assert_eq!(ask(&pool, "image.validate", json!({"data": b64(JUNK), "format": "png"})).await.unwrap(), json!({"error": "invalid"}));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_jpeg_fits_the_box_and_enlarges_only_when_allowed() {
    let pool = pool();
    let png = flat_png(300, 200, [20, 200, 20]);
    let reencode = |width: u32, height: u32, enlarge: bool, quality: u32| json!({"data": b64(&png), "width": width, "height": height, "allowEnlargement": enlarge, "quality": quality});
    let jpeg_of = |answer: &Value| STANDARD.decode(answer["ok"]["data"].as_str().expect("an encoded image")).unwrap();

    // A box the picture fills exactly: the same size comes back as a JPEG (it starts FF D8).
    let fitted = ask(&pool, "image.jpeg", reencode(150, 100, false, 80)).await.unwrap();
    assert_eq!((fitted["ok"]["width"].as_u64(), fitted["ok"]["height"].as_u64()), (Some(150), Some(100)));
    assert_eq!(&jpeg_of(&fitted)[..2], &[0xff, 0xd8]);
    // A box beyond the picture leaves it at its own size, unless enlarging is allowed.
    let held = ask(&pool, "image.jpeg", reencode(600, 400, false, 80)).await.unwrap();
    assert_eq!((held["ok"]["width"].as_u64(), held["ok"]["height"].as_u64()), (Some(300), Some(200)));
    let lifted = ask(&pool, "image.jpeg", reencode(600, 400, true, 80)).await.unwrap();
    assert_eq!((lifted["ok"]["width"].as_u64(), lifted["ok"]["height"].as_u64()), (Some(600), Some(400)));
    // Quality is 1 to 100: outside it the call is `invalid`, not a crash.
    assert_eq!(ask(&pool, "image.jpeg", reencode(150, 100, false, 0)).await.unwrap(), json!({"error": "invalid"}));
    assert_eq!(ask(&pool, "image.jpeg", reencode(150, 100, false, 101)).await.unwrap(), json!({"error": "invalid"}));
    // Bytes no decoder takes.
    let junk = json!({"data": b64(JUNK), "width": 10, "height": 10, "allowEnlargement": false, "quality": 80});
    assert_eq!(ask(&pool, "image.jpeg", junk).await.unwrap(), json!({"error": "invalid"}));
    // A malformed call is refused with the parameter's name.
    let mut bad = reencode(150, 100, false, 80);
    bad["width"] = json!("wide");
    assert_eq!(refused(ask(&pool, "image.jpeg", bad).await), ("invalid_params".to_owned(), "width must be an integer".to_owned()));
    let mut bad = reencode(150, 100, false, 80);
    bad["allowEnlargement"] = json!("yes");
    assert_eq!(refused(ask(&pool, "image.jpeg", bad).await), ("invalid_params".to_owned(), "allowEnlargement must be a boolean".to_owned()));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_fit_answers_the_fitted_image_or_why_it_is_left_out() {
    let pool = pool();
    let png = flat_png(300, 200, [20, 200, 20]);
    let answer = ask(&pool, "image.fit", json!({"data": b64(&png), "ext": "png", "maxRawBytes": 1_000_000})).await.unwrap();
    let ok = &answer["ok"];
    assert_eq!((&ok["dimensions"]["originalWidth"], &ok["dimensions"]["displayWidth"]), (&json!(300), &json!(300)));
    assert_eq!((&ok["mimeType"], &ok["recompressed"]), (&json!("image/png"), &json!(false)), "one that fits comes back as itself");
    // Over the agent's ceiling at every quality, and bytes no decoder takes.
    assert_eq!(ask(&pool, "image.fit", json!({"data": b64(&png), "ext": "png", "maxRawBytes": 8})).await.unwrap(), json!({"error": "too_large"}));
    assert_eq!(ask(&pool, "image.fit", json!({"data": b64(JUNK), "ext": "png", "maxRawBytes": 1_000_000})).await.unwrap(), json!({"error": "invalid"}));
    let unbounded = refused(ask(&pool, "image.fit", json!({"data": b64(&png), "ext": "png"})).await);
    assert_eq!(unbounded, ("invalid_params".to_owned(), "maxRawBytes must be a whole number".to_owned()));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_resize_reports_both_sizes_and_nothing_for_an_empty_file() {
    let pool = pool();
    let png = flat_png(300, 200, [20, 200, 20]);
    let answer = ask(&pool, "image.resize", json!({"data": b64(&png), "ext": "png"})).await.unwrap();
    let ok = &answer["ok"];
    assert_eq!((&ok["dimensions"]["originalWidth"], &ok["dimensions"]["originalHeight"]), (&json!(300), &json!(200)));
    assert_eq!(ok["mimeType"], "image/png", "a PNG that fits comes back as itself");
    let data = STANDARD.decode(ok["data"].as_str().unwrap()).unwrap();
    let probed = ask(&pool, "image.probe", json!({"data": b64(&data)})).await.unwrap();
    assert_eq!(probed["ok"]["width"], ok["dimensions"]["displayWidth"], "the answer decodes at the size it reports");
    assert_eq!(probed["ok"]["height"], ok["dimensions"]["displayHeight"]);
    // No bytes, no answer; bytes no decoder takes carry the decoder's sentence.
    assert_eq!(ask(&pool, "image.resize", json!({"data": "", "ext": "png"})).await.unwrap(), json!({"ok": null}));
    let corrupt = ask(&pool, "image.resize", json!({"data": b64(JUNK), "ext": "png"})).await.unwrap();
    assert_eq!(corrupt["error"], "invalid");
    assert!(!corrupt["message"].as_str().unwrap().is_empty());
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_still_makes_a_webp_and_judges_the_variant_before_the_data() {
    let pool = pool();
    let png = flat_png(300, 200, [20, 200, 20]);
    for variant in ["thumb", "display"] {
        let answer = ask(&pool, "image.still", json!({"data": b64(&png), "variant": variant})).await.unwrap();
        assert_eq!(answer["ok"]["extension"], ".webp", "{variant}");
        let data = STANDARD.decode(answer["ok"]["data"].as_str().unwrap()).unwrap();
        assert_eq!((&data[..4], &data[8..12]), (&b"RIFF"[..], &b"WEBP"[..]), "{variant}");
    }
    // A source that does not decode has no rendition: null, not an error.
    assert_eq!(ask(&pool, "image.still", json!({"data": b64(JUNK), "variant": "thumb"})).await.unwrap(), json!({"ok": null}));
    // An unknown variant is refused even for bad data, and one that is absent prints as `undefined`.
    let unknown = refused(ask(&pool, "image.still", json!({"data": b64(JUNK), "variant": "huge"})).await);
    assert_eq!(unknown, ("invalid_params".to_owned(), "unknown rendition variant: huge".to_owned()));
    let absent = refused(ask(&pool, "image.still", json!({"data": b64(&png)})).await);
    assert_eq!(absent, ("invalid_params".to_owned(), "unknown rendition variant: undefined".to_owned()));
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn media_office_text_is_null_for_bytes_that_are_no_office_document() {
    let pool = pool();
    let garbage = json!({"data": b64(JUNK), "filename": "notes.docx"});
    assert_eq!(ask(&pool, "media.officeText", garbage).await.unwrap(), json!({"text": null}));
    let (code, message) = refused(ask(&pool, "media.officeText", json!({"data": 7, "filename": "a.docx"})).await);
    assert_eq!((code.as_str(), message.as_str()), ("invalid_params", "data must be a base64 string"));
    pool.close().await;
}
/// A one-page PDF whose page draws `text` (nothing when empty), with a correct cross-reference table.
fn one_page_pdf(text: &str) -> Vec<u8> {
    let content = if text.is_empty() { String::new() } else { format!("BT /F1 24 Tf 72 700 Td ({text}) Tj ET") };
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len() + 1),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (number, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", number + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes());
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pdf_text_reads_the_text_layer_and_counts_the_pages_that_have_one() {
    let pool = pool();
    // A page has a text layer when its text holds at least 16 characters besides white space (`PDF_TEXT_LAYER_MIN_CHARS`,
    // mixdog-pdf/src/inspect.rs): this sentence has 35.
    let sentence = "The quick brown fox jumps over the lazy dog";
    let with_text = one_page_pdf(sentence);
    let text = ask(&pool, "media.pdfText", json!({"data": b64(&with_text)})).await.unwrap();
    assert!(text["text"].as_str().unwrap().contains(sentence), "{text}");
    let counts = ask(&pool, "media.pdfCounts", json!({"data": b64(&with_text)})).await.unwrap();
    assert_eq!((&counts["counts"]["pageCount"], &counts["counts"]["textPages"]), (&json!(1), &json!(1)));
    assert!(counts["counts"]["textChars"].as_u64().unwrap() >= 35);
    // A few stray glyphs (10 besides white space) are not a text layer, though the text call still reads them.
    let stamp = one_page_pdf("Hello World");
    let stamped = ask(&pool, "media.pdfCounts", json!({"data": b64(&stamp)})).await.unwrap();
    assert_eq!((&stamped["counts"]["pageCount"], &stamped["counts"]["textPages"]), (&json!(1), &json!(0)));
    // A page that draws nothing is a page without a text layer: a scan.
    let blank = ask(&pool, "media.pdfCounts", json!({"data": b64(&one_page_pdf(""))})).await.unwrap();
    assert_eq!((&blank["counts"]["pageCount"], &blank["counts"]["textPages"]), (&json!(1), &json!(0)));
    // Bytes the parser rejects: counts say so in the parser's words; the text is a fixed sentence, not an error.
    let rejected = ask(&pool, "media.pdfCounts", json!({"data": b64(JUNK)})).await.unwrap();
    assert!(!rejected["rejected"].as_str().unwrap().is_empty());
    let unreadable = ask(&pool, "media.pdfText", json!({"data": b64(JUNK)})).await.unwrap();
    assert!(!unreadable["text"].as_str().unwrap().is_empty());
    pool.close().await;
}
fn gradient(width: u32, height: u32) -> mixdog_imaging::Raster {
    let mut data = Vec::new();
    for y in 0..height {
        for x in 0..width {
            data.extend_from_slice(&[(x * 255 / width) as u8, (y * 255 / height) as u8, 90]);
        }
    }
    mixdog_imaging::Raster { width, height, has_alpha: false, data }
}

const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="220"><rect width="300" height="220" fill="#336699"/></svg>"##;

// The rule: PNG, JPEG, GIF and WebP that already fit the provider's limits come back as themselves with their own media type;
// a TIFF, an SVG or an AVIF cannot be sent to a provider, so it comes out as a PNG (`image/png`) of the same size.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn image_resize_returns_png_jpeg_gif_and_webp_as_themselves_and_converts_tiff_avif_and_svg_to_png() {
    use mixdog_imaging::Format;
    use mixdog_imaging::encode::encode_in_format;

    let pool = pool();
    let raster = gradient(300, 220);
    let encoded = |format| encode_in_format(&raster, format).expect("the encoder writes it");
    let inputs: Vec<(&str, Vec<u8>, &str, &[u8])> = vec![
        ("png", encoded(Format::Png), "image/png", &[0x89, b'P', b'N', b'G']),
        ("jpeg", encoded(Format::Jpeg), "image/jpeg", &[0xff, 0xd8, 0xff]),
        ("gif", encoded(Format::Gif), "image/gif", b"GIF8"),
        ("webp", encoded(Format::Webp), "image/webp", b"RIFF"),
        ("tiff", encoded(Format::Tiff), "image/png", &[0x89, b'P', b'N', b'G']),
        ("avif", encoded(Format::Avif), "image/png", &[0x89, b'P', b'N', b'G']),
        ("svg", SVG.as_bytes().to_vec(), "image/png", &[0x89, b'P', b'N', b'G']),
    ];
    for (ext, bytes, mime, magic) in inputs {
        let answer = ask(&pool, "image.resize", json!({"data": b64(&bytes), "ext": ext})).await.unwrap();
        let ok = &answer["ok"];
        assert_eq!(ok["mimeType"], mime, "{ext}: {answer}");
        let data = STANDARD.decode(ok["data"].as_str().unwrap_or_else(|| panic!("{ext}: {answer}"))).unwrap();
        assert!(data.starts_with(magic), "{ext}: the output's first bytes");
        let dimensions = &ok["dimensions"];
        assert_eq!(
            (&dimensions["originalWidth"], &dimensions["originalHeight"], &dimensions["displayWidth"], &dimensions["displayHeight"]),
            (&json!(300), &json!(220), &json!(300), &json!(220)),
            "{ext}"
        );
        let probed = ask(&pool, "image.probe", json!({"data": ok["data"]})).await.unwrap();
        assert_eq!(probed, json!({"ok": {"width": 300, "height": 220}}), "{ext}: the output decodes at the size it reports");
        if ["png", "jpeg", "gif", "webp"].contains(&ext) {
            assert_eq!(data, bytes, "{ext}: an image that fits is answered with its own bytes");
        }
    }
    pool.close().await;
}

/// A zip of stored (uncompressed) entries.
fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffff_u32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        !crc
    }
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        let (crc, size, name_len) = (crc32(data), data.len() as u32, name.len() as u16);
        let common = |sig: u32, version_made: bool| {
            let mut head = sig.to_le_bytes().to_vec();
            if version_made {
                head.extend_from_slice(&20u16.to_le_bytes());
            }
            head.extend_from_slice(&20u16.to_le_bytes());
            head.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0x21, 0]);
            head.extend_from_slice(&crc.to_le_bytes());
            head.extend_from_slice(&size.to_le_bytes());
            head.extend_from_slice(&size.to_le_bytes());
            head.extend_from_slice(&name_len.to_le_bytes());
            head.extend_from_slice(&0u16.to_le_bytes());
            head
        };
        out.extend_from_slice(&common(0x0403_4b50, false));
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        central.extend_from_slice(&common(0x0201_4b50, true));
        central.extend_from_slice(&[0; 10]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn docx(paragraphs: &[&str]) -> Vec<u8> {
    let body: String = paragraphs.iter().map(|text| format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")).collect();
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>"#
    );
    let types = r#"<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    stored_zip(&[("[Content_Types].xml", types.as_bytes()), ("word/document.xml", document.as_bytes())])
}

fn ooxml_text_call(approved: &Path, path: &Path) -> ExtCall {
    ExtCall {
        thread: ThreadId::from("image-methods"),
        method: "ooxml.text".to_owned(),
        params: json!({"path": path.to_string_lossy(), "maxOutputBytes": 100_000}),
        paths: vec![mixdog_core_api::domain::common::AbsPath::new(approved.to_path_buf()).expect("an absolute folder")],
    }
}

async fn finish(pool: &ExtHostPool, call: ExtCall) -> Result<Value, ExtError> {
    let mut stream = pool.call(call).expect("the call is accepted");
    loop {
        if let ExtFrame::Done(outcome) = stream.next().await.expect("the stream ends with Done") {
            return outcome;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_docx_gives_its_paragraph_text_by_bytes() {
    let pool = pool();
    let bytes = docx(&["Hello World", "Second paragraph"]);
    let by_bytes = ask(&pool, "media.officeText", json!({"data": b64(&bytes), "filename": "notes.docx"})).await.unwrap();
    let text = by_bytes["text"].as_str().unwrap_or_else(|| panic!("{by_bytes}"));
    assert!(text.contains("Hello World") && text.contains("Second paragraph"), "{text:?}");
    assert!(text.find("Hello World") < text.find("Second paragraph"), "paragraphs keep their order: {text:?}");
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_docx_gives_its_paragraph_text_by_path() {
    let pool = pool();
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("notes.docx");
    std::fs::write(&path, docx(&["Hello World", "Second paragraph"])).unwrap();
    let by_path = finish(&pool, ooxml_text_call(scratch.path(), &path)).await.unwrap();
    let text = by_path["text"].as_str().unwrap_or_else(|| panic!("{by_path}"));
    assert!(text.contains("Hello World") && text.contains("Second paragraph"), "{text:?}");
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_container_budget_counts_the_package_not_a_trailing_zip_comment() {
    let pool = pool();
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("notes.docx");
    let bytes = docx(&["Hello World", "Second paragraph"]);
    std::fs::write(&path, &bytes).unwrap();
    let call = ooxml_text_call(scratch.path(), &path);
    let by_path = finish(&pool, call.clone()).await.unwrap();

    // A ZIP comment adds raw bytes, not inflated part bytes. Keep the end-of-directory record readable.
    let budget = bytes.len();
    let mut padded = bytes;
    padded[budget - 2..].copy_from_slice(&256u16.to_le_bytes());
    padded.resize(budget + 256, b'x');
    std::fs::write(&path, padded).unwrap();
    let mut bounded_call = call;
    bounded_call.params["maxContainerBytes"] = json!(budget);
    let bounded = finish(&pool, bounded_call).await.unwrap();
    assert_eq!(bounded["text"], by_path["text"]);
    pool.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_docx_outside_the_approved_folders_is_refused_and_not_read() {
    let pool = pool();
    let approved = tempfile::tempdir().unwrap();
    let elsewhere = tempfile::tempdir().unwrap();
    let outside_path = elsewhere.path().join("secret.docx");
    std::fs::write(&outside_path, docx(&["Hello World"])).unwrap();
    let outside = finish(&pool, ooxml_text_call(approved.path(), &outside_path)).await;
    match outside {
        Err(ExtError::Failed { code, message }) => {
            assert_eq!(code, "path_not_approved");
            assert_eq!(message, format!("path is not approved for this call: {}", outside_path.display()));
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    pool.close().await;
}
