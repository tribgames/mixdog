//! Model-visible texts that depend on tool names: the unknown-tool message
//! with its redirect or suggestion, byte-equal to Node's.

/// Typo aliases of builtin names (exact, case-sensitive).
const TYPO_ALIASES: [(&str, &str); 7] = [
    ("grop", "grep"),
    ("grpe", "grep"),
    ("greap", "grep"),
    ("gerp", "grep"),
    ("glbo", "glob"),
    ("gloob", "glob"),
    ("golb", "glob"),
];

/// The canonical name a typo alias or a case variant stands for, among the
/// surface's `names`; `None` when the name is not one of those.
pub fn canonical_name<'a>(name: &str, names: impl Iterator<Item = &'a str> + Clone) -> Option<&'a str> {
    if let Some((_, target)) = TYPO_ALIASES.iter().find(|(typo, _)| *typo == name) {
        return names.clone().find(|n| n == target);
    }
    if names.clone().any(|n| n == name) {
        return None;
    }
    let lower = name.to_lowercase();
    names.into_iter().find(|n| n.to_lowercase() == lower)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.to_lowercase().chars().collect();
    let b: Vec<char> = b.to_lowercase().chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut curr = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            curr[j] = (curr[j - 1] + 1).min(prev[j] + 1).min(prev[j - 1] + cost);
        }
        prev = curr;
    }
    prev[b.len()]
}

fn suggestion<'a>(name: &str, names: &[&'a str]) -> Option<&'a str> {
    if name.is_empty() {
        return None;
    }
    if let Some(canonical) = canonical_name(name, names.iter().copied()) {
        return Some(canonical);
    }
    let mut best: Option<(usize, &'a str)> = None;
    for tool in names {
        let d = edit_distance(name, tool);
        if d <= 2 && best.is_none_or(|(bd, bn)| d < bd || (d == bd && *tool < bn)) {
            best = Some((d, tool));
        }
    }
    best.map(|(_, n)| n)
}

/// `Error: unknown tool "<name>"` with a concrete redirect for a well-known
/// foreign tool name, else a did-you-mean among the surface's tools.
pub fn unknown_tool_message(name: &str, surface_names: &[&str]) -> String {
    if let Some(redirect) = mixdog_tools::foreign::redirect(name) {
        return format!("Error: unknown tool \"{name}\" — {redirect}.");
    }
    match suggestion(name, surface_names) {
        Some(s) => format!("Error: unknown tool \"{name}\". Did you mean \"{s}\"?"),
        None => format!("Error: unknown tool \"{name}\""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_suggestion_and_plain() {
        let names = ["read", "grep", "glob", "shell"];
        assert_eq!(
            unknown_tool_message("Bash", &names),
            "Error: unknown tool \"Bash\" — use the `shell` tool."
        );
        assert_eq!(
            unknown_tool_message("raed", &names),
            "Error: unknown tool \"raed\". Did you mean \"read\"?"
        );
        assert_eq!(unknown_tool_message("zzzzzzzz", &names), "Error: unknown tool \"zzzzzzzz\"");
        assert_eq!(canonical_name("Grep", names.iter().copied()), Some("grep"));
        assert_eq!(canonical_name("gerp", names.iter().copied()), Some("grep"));
        assert_eq!(canonical_name("grep", names.iter().copied()), None);
    }
}
