//! The hints a refused name is answered with: `editDistance`, `subjectTokens`, `operationSuggestions`, `didYouMean`
//! and `fieldCorrections` of `capabilities.mjs`. A suggestion is worth a retry only when it reads as a typo of what was
//! written or names the same subject: nearest-neighbour alone hands back unrelated names (`source` for `op`), and a
//! wrong hint costs a whole round trip, so unrelated candidates are dropped and the caller is given the real list.

use std::collections::HashSet;

use mixdog_js::{js_to_lowercase, locale_compare, utf16_len};

/// `editDistance(left, right)`: Levenshtein distance over UTF-16 code units, as `a[i - 1] === b[j - 1]` compares them.
pub fn edit_distance(left: &str, right: &str) -> usize {
    let a: Vec<u16> = left.encode_utf16().collect();
    let b: Vec<u16> = right.encode_utf16().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut diagonal = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let previous = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(diagonal + usize::from(a[i - 1] != b[j - 1]));
            diagonal = previous;
        }
    }
    row[b.len()]
}

/// `subjectTokens(name)`: what a name is about, ignoring the verb it starts with. `add_toc` and `insert_toc` are the
/// same subject under two verbs, which is how a caller usually misses a name.
fn subject_tokens(name: &str) -> HashSet<String> {
    js_to_lowercase(name).split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).filter(|part| !part.is_empty()).skip(1).map(str::to_owned).collect()
}

/// `operationSuggestions(operation, operations)`: up to three candidates that read as a typo of `operation` or name its
/// subject, nearest first, ties in the default locale's collation order.
pub fn operation_suggestions<'a>(operation: &str, candidates: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let length = utf16_len(operation);
    let budget = (length / 3).max(1);
    let subject = subject_tokens(operation);
    let token = js_to_lowercase(operation);
    let mut found: Vec<(usize, &str)> = candidates
        .into_iter()
        .filter_map(|candidate| {
            let distance = edit_distance(operation, candidate);
            let same_subject = subject_tokens(candidate).iter().any(|part| subject.contains(part));
            let near = distance <= budget
                || same_subject
                || (length >= 3 && js_to_lowercase(candidate).contains(&token))
                || (length >= 4 && (candidate.starts_with(operation) || operation.starts_with(candidate)));
            near.then_some((distance, candidate))
        })
        .collect();
    found.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| locale_compare(left.1, right.1)));
    found.into_iter().take(3).map(|(_, candidate)| candidate.to_owned()).collect()
}

/// `didYouMean(candidates)`: the sentence that follows a refusal, or nothing.
pub fn did_you_mean(candidates: &[String]) -> String {
    if candidates.is_empty() { String::new() } else { format!(" Did you mean: {}?", candidates.join(", ")) }
}

/// `fieldCorrections(fields, allowed)`: `field→candidate` for each field whose nearest allowed name differs from it.
pub fn field_corrections(fields: &[String], allowed: &[String]) -> Vec<String> {
    fields
        .iter()
        .filter_map(|field| {
            let candidate = operation_suggestions(field, allowed.iter().map(String::as_str)).into_iter().next()?;
            (candidate != *field).then(|| format!("{field}→{candidate}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPERATIONS: [&str; 6] = ["add_chart", "add_table", "insert_toc", "insert_rows", "set_cell", "append_text"];

    #[test]
    fn distance_counts_single_edits() {
        assert_eq!(edit_distance("add_chrt", "add_chart"), 1);
        assert_eq!(edit_distance("", "abc"), 3);
        assert_eq!(edit_distance("same", "same"), 0);
        assert_eq!(edit_distance("검토", "검수"), 1);
    }

    #[test]
    fn a_typo_is_suggested() {
        assert_eq!(operation_suggestions("add_chrt", OPERATIONS), ["add_chart"]);
    }

    #[test]
    fn the_same_subject_under_another_verb_is_suggested() {
        assert_eq!(operation_suggestions("add_toc", OPERATIONS), ["insert_toc"]);
    }

    #[test]
    fn an_unrelated_name_gets_nothing() {
        let allowed = ["chartType", "range", "title"];
        assert!(operation_suggestions("source", allowed).is_empty());
        assert_eq!(did_you_mean(&[]), "");
    }

    #[test]
    fn a_containing_name_is_suggested() {
        assert_eq!(operation_suggestions("chart", ["chartType", "range"]), ["chartType"]);
    }

    #[test]
    fn corrections_name_the_nearest_allowed_field() {
        let allowed = vec!["chartType".to_owned(), "range".to_owned()];
        assert_eq!(field_corrections(&["chartTipe".to_owned(), "source".to_owned()], &allowed), ["chartTipe→chartType"]);
        assert_eq!(did_you_mean(&["a→b".to_owned(), "c→d".to_owned()]), " Did you mean: a→b, c→d?");
    }

    #[test]
    fn ties_and_the_cap_follow_distance_then_collation() {
        let found = operation_suggestions("set_row", ["set_rows", "set_cow", "set_row_a", "set_rowx", "zzz"]);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0], "set_cow");
    }
}
