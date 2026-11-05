//! Globs and `.gitignore` rules (port of `globExpression` / `ignoreRules` /
//! `ignoredPath` in `project-file-search.ts`). Accumulated rules apply in order,
//! last match wins, `!` re-includes.

use regex::Regex;
use regex::RegexBuilder;

/// Regular-expression source for a glob: `**` crosses folders, `*` and `?` stay
/// inside one path segment, everything else is literal.
pub fn glob_expression(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' if chars.get(i + 1) == Some(&'*') => {
                out.push_str(".*");
                i += 1;
            }
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            c => out.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    out
}

pub fn normalize_path(value: &str) -> String {
    let value = value.replace('\\', "/");
    let mut rest = value.as_str();
    while let Some(next) = rest.strip_prefix("./") {
        rest = next.trim_start_matches('/');
    }
    rest.to_owned()
}

/// A case-insensitive matcher of one user glob (`include` / `exclude` entries).
pub fn glob_matcher(pattern: &str) -> Regex {
    let normalized = normalize_path(pattern.trim());
    let source = glob_expression(&normalized);
    let full = if normalized.contains('/') { format!("^{source}$") } else { format!("(?:^|/){source}$") };
    RegexBuilder::new(&full).case_insensitive(true).build().expect("glob expression is always valid")
}

pub fn glob_list(value: &str) -> Vec<Regex> {
    value.split(',').map(str::trim).filter(|s| !s.is_empty()).map(glob_matcher).collect()
}

#[derive(Clone, Debug)]
pub struct IgnoreRule {
    base: String,
    ignored: bool,
    directory_only: bool,
    matcher: Regex,
}

pub fn ignore_rules(source: &str, base: &str) -> Vec<IgnoreRule> {
    source
        .lines()
        .filter_map(|line| {
            let mut pattern = line.trim();
            if pattern.is_empty() || pattern.starts_with('#') {
                return None;
            }
            let ignored = !pattern.starts_with('!');
            if !ignored {
                pattern = &pattern[1..];
            }
            let directory_only = pattern.ends_with('/');
            if directory_only {
                pattern = &pattern[..pattern.len() - 1];
            }
            let anchored = pattern.starts_with('/');
            if anchored {
                pattern = &pattern[1..];
            }
            if pattern.is_empty() {
                return None;
            }
            let expression = glob_expression(pattern);
            let full = if anchored || pattern.contains('/') {
                format!("^{expression}(?:/.*)?$")
            } else {
                format!("(?:^|/){expression}(?:/.*)?$")
            };
            Some(IgnoreRule { base: base.to_owned(), ignored, directory_only, matcher: Regex::new(&full).ok()? })
        })
        .collect()
}

pub fn ignored_path(path: &str, directory: bool, rules: &[IgnoreRule]) -> bool {
    let mut ignored = false;
    for rule in rules {
        let candidate = if rule.base.is_empty() {
            Some(path)
        } else {
            path.strip_prefix(rule.base.as_str()).and_then(|rest| rest.strip_prefix('/'))
        };
        if let Some(candidate) = candidate {
            if (!rule.directory_only || directory) && rule.matcher.is_match(candidate) {
                ignored = rule.ignored;
            }
        }
    }
    ignored
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignore_last_match_wins() {
        let rules = ignore_rules("*.log\n!keep.log\nbuild/\n", "");
        assert!(ignored_path("a/x.log", false, &rules));
        assert!(!ignored_path("keep.log", false, &rules));
        assert!(ignored_path("build", true, &rules));
        assert!(!ignored_path("build", false, &rules));
    }

    #[test]
    fn globs() {
        assert!(glob_matcher("*.mjs").is_match("src/x.mjs"));
        assert!(glob_matcher("src/**").is_match("src/a/b.txt"));
        assert!(!glob_matcher("src/**").is_match("a.txt"));
    }
}
