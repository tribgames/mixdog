//! Banner text: Markdown parsed first (so a clipped delimiter cannot leak into the banner), then
//! clipped at the last whole sentence that fits.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

const LIMIT: usize = 160;
/// A cut at a sentence end must still carry a real summary.
const MIN_SENTENCE: usize = 60;

/// Blocks whose text is code or grid, not prose.
fn skipped(tag: &Tag<'_>) -> bool {
    matches!(
        tag,
        Tag::CodeBlock(_) | Tag::Table(_) | Tag::HtmlBlock | Tag::MetadataBlock(_) | Tag::DefinitionList
    )
}

fn plain_text(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let mut out = String::new();
    // A delimiter the parser could not pair is syntax, not text; adjacent text events are one node.
    let mut text = String::new();
    let mut skip_depth = 0usize;
    let flush = |text: &mut String, out: &mut String| {
        out.push_str(&text.replace("**", ""));
        text.clear();
    };
    for event in Parser::new_ext(markdown, options) {
        if skip_depth > 0 {
            match event {
                Event::Start(_) => skip_depth += 1,
                Event::End(_) => skip_depth -= 1,
                _ => {}
            }
            continue;
        }
        match event {
            Event::Text(value) => text.push_str(&value),
            other => {
                flush(&mut text, &mut out);
                match other {
                    Event::Start(tag) if skipped(&tag) => skip_depth = 1,
                    // Blocks are separated by a space; whitespace is collapsed afterwards.
                    Event::Start(Tag::Paragraph | Tag::Heading { .. } | Tag::BlockQuote(_) | Tag::List(_) | Tag::Item)
                    | Event::End(
                        TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::BlockQuote(_) | TagEnd::List(_) | TagEnd::Item,
                    )
                    | Event::SoftBreak
                    | Event::HardBreak => out.push(' '),
                    Event::Code(value) => out.push_str(&value),
                    _ => {}
                }
            }
        }
    }
    flush(&mut text, &mut out);
    out
}

/// Native banners display text, not Markdown.
pub fn notification_preview(markdown: &str) -> String {
    let text = plain_text(markdown).split_whitespace().collect::<Vec<_>>().join(" ");
    let characters: Vec<char> = text.chars().collect();
    if characters.len() <= LIMIT {
        return text;
    }
    // One character past the limit, so a period that ends exactly at it still sees the space after.
    let probe = &characters[..=LIMIT];
    let sentence_end = (0..probe.len().saturating_sub(1))
        .rev()
        .find(|&i| "。！？.!?".contains(probe[i]) && probe[i + 1].is_whitespace());
    if let Some(index) = sentence_end {
        if index + 1 >= MIN_SENTENCE {
            return probe[..=index].iter().collect();
        }
    }
    let mut clipped: String = characters[..LIMIT - 1].iter().collect();
    clipped.push('…');
    clipped
}

#[cfg(test)]
mod tests {
    use super::notification_preview as preview;

    #[test]
    fn strips_markup_and_skips_code_and_tables() {
        assert_eq!(preview("**Done** with `fix` and [a link](http://x)\n\n```rs\nlet x;\n```\n\nNext"), "Done with fix and a link Next");
        assert_eq!(preview("| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"), "tail");
        assert_eq!(preview("![alt text](i.png) ~~gone~~ kept"), "alt text gone kept");
        assert_eq!(preview("- one\n- two\n\n> quote"), "one two quote");
        assert_eq!(preview("line one  \nline two"), "line one line two");
    }

    #[test]
    fn unpaired_strong_delimiters_do_not_show() {
        assert_eq!(preview("a **b"), "a b");
    }

    #[test]
    fn long_text_ends_on_a_whole_sentence_or_an_ellipsis() {
        let first = "This sentence is long enough to be a real summary of the work that was done today.";
        let text = format!("{first} {}", "word ".repeat(40));
        assert_eq!(preview(&text), first);
        let no_end = "word ".repeat(60);
        let out = preview(&no_end);
        assert_eq!(out.chars().count(), 160);
        assert!(out.ends_with('…'));
        let short_sentence = format!("Short one. {}", "word ".repeat(60));
        assert!(preview(&short_sentence).ends_with('…'));
    }
}
