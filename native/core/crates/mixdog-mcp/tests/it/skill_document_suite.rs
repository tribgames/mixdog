//! Writing a skill's name, description and trigger into its `SKILL.md`: the keys it is given are set, everything else the author
//! wrote stays as it was, and a value is printed so that it reads back as the same text.

use mixdog_mcp::skill_frontmatter::Fields;
use mixdog_mcp::skill_frontmatter::create_document;
use mixdog_mcp::skill_frontmatter::update_document;
use mixdog_mcp::skills::DESCRIPTION_MAX;
use mixdog_mcp::skills::SkillDocumentError;
use mixdog_mcp::skills::parse_document;

fn fields<'a>(name: &'a str, description: &'a str, when_to_use: &'a str) -> Fields<'a> {
    Fields { name, description, when_to_use }
}

#[test]
fn a_new_skill_is_the_frontmatter_a_blank_line_and_the_trimmed_instructions() {
    let document = create_document(&fields(" demo ", " Does a thing. ", ""), "\n  Step one.\r\nStep two.\n\n").unwrap();
    assert_eq!(document, "---\nname: demo\ndescription: Does a thing.\n---\n\nStep one.\nStep two.\n");
    let trigger = create_document(&fields("demo", "Does a thing.", "when asked"), "Body").unwrap();
    assert_eq!(trigger, "---\nname: demo\ndescription: Does a thing.\nwhen_to_use: when asked\n---\n\nBody\n");
}

#[test]
fn a_value_that_would_read_back_as_another_type_or_spans_lines_is_written_so_it_reads_back_as_the_same_text() {
    for description in ["true", "123", "null", "has: colon", "- dash", "multi\nline text"] {
        let document = create_document(&fields("demo", description, ""), "Body").unwrap();
        let parsed = parse_document(&document).unwrap();
        assert_eq!(parsed.description, description, "{document:?}");
    }
    let quoted = create_document(&fields("demo", "true", ""), "Body").unwrap();
    assert!(quoted.contains("description: \"true\"\n"), "{quoted:?}");
}

#[test]
fn an_edit_changes_the_three_keys_and_keeps_the_rest_of_the_frontmatter_as_written() {
    let before = "---\n# the author's note\nname: old-name\nowner: team-a  # who to ask\ndescription: \"Old text\"\n---\n\nOld body\n";
    let after = update_document(before, &fields("new-name", "New text", "use it"), "New body").unwrap();
    assert_eq!(
        after,
        "---\n# the author's note\nname: new-name\nowner: team-a  # who to ask\ndescription: \"New text\"\nwhen_to_use: use it\n---\n\nNew body\n"
    );
}

#[test]
fn an_empty_trigger_in_an_edit_removes_the_key_and_the_document_still_reads_back() {
    let before = "---\nname: demo\ndescription: Does a thing.\nwhen_to_use: when asked\n---\n\nBody\n";
    let after = update_document(before, &fields("demo", "Does a thing.", ""), "Body").unwrap();
    assert!(!after.contains("when_to_use"), "{after:?}");
    assert_eq!(parse_document(&after).unwrap().description, "Does a thing.");
}

#[test]
fn what_cannot_be_stored_is_refused_with_its_own_reason() {
    let ok = fields("demo", "Does a thing.", "");
    assert!(matches!(create_document(&fields("", "d", ""), "b"), Err(SkillDocumentError::NameRequired)));
    assert!(matches!(create_document(&fields("Demo", "d", ""), "b"), Err(SkillDocumentError::NameCharset)));
    assert!(matches!(create_document(&fields("-demo", "d", ""), "b"), Err(SkillDocumentError::NameHyphens)));
    assert!(matches!(create_document(&fields("demo", "  ", ""), "b"), Err(SkillDocumentError::DescriptionRequired)));
    let long = "x".repeat(DESCRIPTION_MAX + 1);
    assert!(matches!(create_document(&fields("demo", &long, ""), "b"), Err(SkillDocumentError::DescriptionTooLong)));
    assert!(matches!(create_document(&ok, " \n "), Err(SkillDocumentError::InstructionsRequired)));
    assert!(matches!(update_document("no frontmatter here", &ok, "b"), Err(SkillDocumentError::NoFrontmatter)));
    // The longest description the limit allows is stored.
    let longest = "x".repeat(DESCRIPTION_MAX);
    assert!(create_document(&fields("demo", &longest, ""), "b").is_ok());
}