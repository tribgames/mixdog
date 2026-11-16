//! Banner text: Markdown parsed first (so a clipped delimiter cannot leak into the banner), then
//! clipped at the last whole sentence that fits.

use mixdog_js::{is_js_space, js_words};
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
    let text = js_words(&plain_text(markdown)).collect::<Vec<_>>().join(" ");
    let characters: Vec<char> = text.chars().collect();
    if characters.len() <= LIMIT {
        return text;
    }
    // One character past the limit, so a period that ends exactly at it still sees the space after.
    let probe = &characters[..=LIMIT];
    let sentence_end = (0..probe.len().saturating_sub(1))
        .rev()
        .find(|&i| "。！？.!?".contains(probe[i]) && is_js_space(probe[i + 1]));
    if let Some(index) = sentence_end
        && index + 1 >= MIN_SENTENCE {
        return probe[..=index].iter().collect();
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

    /// `desktop-turn-notifier.test.mjs` "notification text removes Markdown syntax without damaging paths, links or Unicode".
    #[test]
    fn paths_links_unicode_and_unpaired_hangul_strong_read_as_plain_text() {
        assert_eq!(
            preview("# 완료\n\n**굵게**와 *강조*, `src/a_b.ts`\n- [결과](https://example.com)\n> 확인"),
            "완료 굵게와 강조, src/a_b.ts 결과 확인"
        );
        assert_eq!(preview("![설명](image.png)\n\n```ts\nconst x = 1;\n```"), "설명");
        assert_eq!(preview("결과입니다.\n\n| 이름 | 값 |\n|---|---|\n| a | 1 |"), "결과입니다.");
        assert_eq!(
            preview("**VPS(폰에서 여는 웹앱):**는 바로 바뀝니다. **`v1.0.6`**로 올라갔습니다."),
            "VPS(폰에서 여는 웹앱):는 바로 바뀝니다. v1.0.6로 올라갔습니다."
        );
        let sentence = "작업을 마쳤고 변경 사항을 모두 확인했습니다. 테스트도 통과했고 커밋 준비가 끝났습니다. 배포는 요청하실 때 바로 진행하겠습니다.";
        assert_eq!(preview(&format!("{sentence} {}", "추가 설명이 계속 이어집니다 ".repeat(10))), sentence);
        assert_eq!(preview("a_b_c & <https://example.com>"), "a_b_c & https://example.com");
        assert_eq!(preview(&"😀".repeat(161)), format!("{}…", "😀".repeat(159)));
        assert_eq!(preview(&format!("**{}**", "a".repeat(161))), format!("{}…", "a".repeat(159)));
    }
}
