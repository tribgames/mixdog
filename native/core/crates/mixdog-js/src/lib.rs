//! JavaScript semantics for the core, in one place: the `\s` white-space set and `trim`,
//! `slice` by UTF-16 units, `Number(...)` coercion, ECMAScript regular expressions with V8's
//! error text. Ported from V8 / the Node product; each piece is tested against Node's output.

mod array_sort;
pub mod device_paths;
#[cfg(feature = "fixture-tools")]
pub mod fixture_tools;
mod json;
mod json_error;
mod json_parse;
mod locale_compare;
pub mod math;
mod number;
mod regex;
mod regex_error;
mod text;
pub mod time;
pub mod token_estimate;

pub use array_sort::js_sort_by;
pub use json::ordered_keys as js_object_keys;
pub use json::quote as json_quote;
pub use json::quoted_cut_utf16_len as json_cut_utf16_len;
pub use json::stringify as json_stringify;
pub use json::stringify_indent as json_stringify_indent;
pub use json::stringify_indent_parsed as json_stringify_indent_parsed;
pub use json::stringify_sorted as json_stringify_sorted;
pub use json::stringify_sorted_outside_arrays as json_stringify_sorted_outside_arrays;
pub use json_error::v8_json_parse_error;
pub use json_parse::JsonSyntaxError;
pub use json_parse::parse as json_parse;
pub use json_parse::parsed_text as json_parsed_text;
pub use locale_compare::default_locale_tag;
pub use locale_compare::locale_compare;
pub use locale_compare::locale_compare_en;
pub use locale_compare::locale_compare_en_base;
pub use locale_compare::locale_compare_en_numeric;
pub use number::NoPrimitive;
pub use number::json_number;
pub use number::number_to_string;
pub use number::string_to_number;
pub use number::to_number;
pub use number::to_number_of;
pub use number::try_to_number;
pub use number::try_to_number_of;
pub use number::try_value_to_string;
pub use number::value_to_string;
pub use regex::Caps;
pub use regex::JsRegex;
pub use regex_error::js_regex_error;
pub use text::Utf16Cut;
pub use text::cut_utf16;
pub use text::is_js_space;
pub use text::js_to_lowercase;
pub use text::js_trim;
pub use text::js_trim_end;
pub use text::js_trim_start;
pub use text::js_words;
pub use text::slice_utf16;
pub use text::utf16_len;
