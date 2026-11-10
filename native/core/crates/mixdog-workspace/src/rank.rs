//! One ranking rule for project paths (port of `shared/file-match.ts`).
//! Folders are paths ending in `/`.

use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileMatch {
    pub tier: u8,
    pub start: usize,
    pub end: usize,
}

pub fn normalize_query(query: &str) -> String {
    query.trim().replace('\\', "/").to_lowercase()
}

fn starts_word(entry: &[char], index: usize) -> bool {
    let before = entry[index - 1];
    if matches!(before, '-' | '_' | '.' | ' ') {
        return true;
    }
    let c = entry[index];
    c.is_uppercase() && !before.is_uppercase()
}

/// Best tier first: 0 name equals query (sans extension), 1 name prefix, 2 word start in
/// name, 3 name contains, 4 path segment prefix, 5 path contains. Offsets are in chars.
pub fn match_file(path: &str, query: &str) -> Option<FileMatch> {
    let needle: Vec<char> = normalize_query(query).chars().collect();
    if needle.is_empty() {
        return Some(FileMatch { tier: 0, start: 0, end: 0 });
    }
    let entry: Vec<char> = path.strip_suffix('/').unwrap_or(path).chars().collect();
    let lower: Vec<char> = entry.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let base = entry.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    let name = &lower[base..];
    let hit = |tier, start: usize| Some(FileMatch { tier, start, end: start + needle.len() });
    let at = |hay: &[char], i: usize| hay.len() >= i + needle.len() && hay[i..i + needle.len()] == needle[..];
    let dot = name.iter().rposition(|c| *c == '.');
    if name == &needle[..] || dot.is_some_and(|d| d > 0 && name[..d] == needle[..]) {
        return hit(0, base);
    }
    if at(name, 0) {
        return hit(1, base);
    }
    for i in 1..name.len() {
        if at(name, i) && starts_word(&entry, base + i) {
            return hit(2, base + i);
        }
    }
    if let Some(i) = (0..name.len()).find(|&i| at(name, i)) {
        return hit(3, base + i);
    }
    for i in 0..lower.len() {
        if (i == 0 || lower[i - 1] == '/') && at(&lower, i) {
            return hit(4, i);
        }
    }
    (0..lower.len()).find(|&i| at(&lower, i)).and_then(|i| hit(5, i))
}

fn segment_count(path: &str) -> usize {
    path.split('/').count() - usize::from(path.ends_with('/'))
}

/// Tier, then fewer segments, then shorter path, then `localeCompare` (ICU) of the paths.
pub fn compare(left: (&str, &FileMatch), right: (&str, &FileMatch)) -> Ordering {
    left.1
        .tier
        .cmp(&right.1.tier)
        .then(segment_count(left.0).cmp(&segment_count(right.0)))
        .then(left.0.encode_utf16().count().cmp(&right.0.encode_utf16().count()))
        .then(mixdog_js::locale_compare(left.0, right.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiers() {
        assert_eq!(match_file("src/Main.rs", "main").unwrap().tier, 0);
        assert_eq!(match_file("src/main_loop.rs", "main").unwrap().tier, 1);
        assert_eq!(match_file("src/app-main.rs", "main").unwrap().tier, 2);
        assert_eq!(match_file("src/xmainx.rs", "main").unwrap().tier, 3);
        assert_eq!(match_file("main/x.rs", "main").unwrap().tier, 4);
        assert_eq!(match_file("amain/x.rs", "main").unwrap().tier, 5);
        assert!(match_file("a/b.rs", "mn").is_none());
    }

    #[test]
    fn order() {
        let a = match_file("a/m.rs", "m").unwrap();
        let b = match_file("m.rs", "m").unwrap();
        assert_eq!(compare(("m.rs", &b), ("a/m.rs", &a)), Ordering::Less);
    }

    /// Equal tier, segments and length fall to `localeCompare` (ICU: lowercase before its capital, accents after their letter), where a byte
    /// compare puts every capital first.
    #[test]
    fn ties_break_as_node_locale_compare_does() {
        let hit = |p: &str| (p.to_owned(), match_file(p, "m").unwrap());
        let (lower, upper) = (hit("m.rs"), hit("M.rs"));
        assert_eq!(compare((&lower.0, &lower.1), (&upper.0, &upper.1)), Ordering::Less);
        assert_eq!(compare((&upper.0, &upper.1), (&lower.0, &lower.1)), Ordering::Greater);
    }
}
