//! `pdf.ocr` (`pdfOcr` of `src/ext-host/methods.mjs`): the recognised text of pages of a PDF over a file inside the approved
//! paths, as `[{page, text}]`. Read-only: the pages are rendered in memory. `dataDir` (falsy: the office data directory) holds
//! the engine and the language data downloaded on first use; `languages` is an array or a `+`-joined string (`eng+kor` by default).

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_office_base::data_dir::default_office_data_dir;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_pdf::{OcrContext, recognize_pdf_page_texts};
use serde_json::{Value, json};

use super::js_string;
use super::pdf_render::{failure, fonts, lanes};
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::{HandlerResult, Outcome, Registry};

pub(super) fn register(registry: &mut Registry) {
    registry.register("pdf.ocr", ocr);
}

/// JavaScript truthiness of a parameter.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `dataDir || defaultOfficeDataDir()`.
fn data_dir(params: &Value) -> Result<PathBuf, CodedError> {
    match params.get("dataDir").filter(|value| truthy(value)) {
        Some(value) => Ok(PathBuf::from(js_string(Some(value)))),
        None => default_office_data_dir().map_err(|error| CodedError::failed(error.to_string())),
    }
}

/// The pages of the call: each array item as the whole page number it names; a page that names none (a fraction, a negative,
/// not a number) is 0, which the render refuses as a page out of range. A parameter that is no array holds no pages.
fn page_numbers(params: &Value) -> Vec<usize> {
    let Some(Value::Array(items)) = params.get("pages") else { return Vec::new() };
    items
        .iter()
        .map(|item| {
            let number = mixdog_js::to_number(item);
            if number.is_finite() && number.fract() == 0.0 && number >= 1.0 { number as usize } else { 0 }
        })
        .collect()
}

async fn ocr(ctx: CallCtx) -> HandlerResult {
    let file = ctx.approved_path(&js_string(ctx.params.get("path")), "")?;
    let data_dir = data_dir(&ctx.params)?;
    let pages = page_numbers(&ctx.params);
    let context = OcrContext::new(lanes()?, fonts().await?, Arc::new(NoWriteNote), data_dir);
    let texts = recognize_pdf_page_texts(&context, &file, &pages, ctx.params.get("languages"), Some(ctx.cancel.clone()))
        .await
        .map_err(|error| failure(&ctx, &error))?;
    Ok(Outcome::value(Value::Array(texts.into_iter().map(|text| json!({"page": text.page, "text": text.text})).collect())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_whole_numbers_and_anything_else_is_zero() {
        assert_eq!(page_numbers(&json!({"pages": [1, "2", 1.5, -1, null, "x"]})), vec![1, 2, 0, 0, 0, 0]);
        assert!(page_numbers(&json!({"pages": 3})).is_empty());
        assert!(page_numbers(&json!({})).is_empty());
    }

    #[test]
    fn a_data_dir_is_the_given_one_unless_it_is_falsy() {
        assert_eq!(data_dir(&json!({"dataDir": "/d"})).unwrap(), PathBuf::from("/d"));
        assert_eq!(data_dir(&json!({"dataDir": ""})).unwrap(), data_dir(&json!({})).unwrap());
    }
}
