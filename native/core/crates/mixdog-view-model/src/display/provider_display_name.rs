//! `runtime/shared/provider-display-name.mjs`: display names for provider ids; an unknown id displays as itself.

use mixdog_js::js_to_lowercase;

const NAMES: [(&str, &str); 23] = [
    ("openai-oauth", "OpenAI OAuth"),
    ("anthropic-oauth", "Anthropic OAuth"),
    ("grok-oauth", "Grok OAuth"),
    ("muse-code-oauth", "Muse Code"),
    ("command-code-oauth", "Command Code"),
    ("mimo-oauth", "MiMo"),
    ("cursor-oauth", "Cursor OAuth"),
    ("devin-oauth", "Devin"),
    ("antigravity-oauth", "Antigravity OAuth"),
    ("openai", "OpenAI API"),
    ("openai-api", "OpenAI API"),
    ("anthropic", "Anthropic API"),
    ("anthropic-api", "Anthropic API"),
    ("gemini", "Gemini API"),
    ("gemini-api", "Gemini API"),
    ("xai", "xAI API"),
    ("xai-api", "xAI API"),
    ("deepseek", "DeepSeek API"),
    ("deepseek-api", "DeepSeek API"),
    ("opencode-go-oauth", "OpenCode Go OAuth"),
    ("openrouter", "OpenRouter"),
    ("mixdog-local", "Local Provider"),
    ("default", "Default"),
];

/// `providerDisplayName(provider)`: the table's name for the lower-cased id, else the id, else `Provider`.
pub fn provider_display_name(provider: &str) -> String {
    let key = js_to_lowercase(provider);
    if let Some((_, name)) = NAMES.iter().find(|(id, _)| *id == key) {
        return (*name).to_owned();
    }
    if provider.is_empty() { "Provider".to_owned() } else { provider.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_ids_read_by_name_in_any_case() {
        assert_eq!(provider_display_name("openai-oauth"), "OpenAI OAuth");
        assert_eq!(provider_display_name("OpenAI"), "OpenAI API");
        assert_eq!(provider_display_name("mixdog-local"), "Local Provider");
    }

    #[test]
    fn an_unknown_id_displays_as_itself_and_an_empty_one_as_provider() {
        assert_eq!(provider_display_name("Acme-Gateway"), "Acme-Gateway");
        assert_eq!(provider_display_name(""), "Provider");
    }
}
