use super::*;

fn hunk(old_start: usize, lines: &[&str]) -> Hunk {
    Hunk {
        old_start,
        lines: lines.iter().map(|s| (*s).to_string()).collect(),
    }
}

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = env::temp_dir().join(format!("mixdog-patch-test-{tag}-{nanos}"));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn create_new_refuses_an_existing_target_and_keeps_its_content() {
    let dir = temp_dir("create-new");
    let path = dir.join("f.txt");
    atomic_write_create_new(&path, b"first\n").expect("first create");
    assert_eq!(fs::read(&path).unwrap(), b"first\n");
    let err = atomic_write_create_new(&path, b"second\n").expect_err("no overwrite");
    assert!(
        err.contains("create target already exists"),
        "unexpected: {err}"
    );
    assert_eq!(fs::read(&path).unwrap(), b"first\n");
    // Rollback of a create is still a plain removal.
    let plan = PlannedWrite {
        kind: EntryKind::Create,
        path: path.clone(),
        original: None,
        next: Some(b"first\n".to_vec()),
        snapshot: None,
        content_hash: None,
    };
    rollback_plan(&plan).expect("created file is removed");
    assert!(!path.exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn add_file_plans_an_existing_regular_target_as_atomic_replace() {
    let dir = temp_dir("add-overwrite");
    let path = dir.join("f.txt");
    fs::write(&path, b"old\n").unwrap();
    let planned = plan_entry(
        &fs::canonicalize(&dir).unwrap(),
        Entry {
            old_file: "/dev/null".to_string(),
            new_file: "f.txt".to_string(),
            hunks: vec![hunk(0, &["+new"])],
        },
        2,
        "f.txt".to_string(),
    )
    .expect("existing regular Add File target should be replaceable");
    assert_eq!(planned.plan.kind, EntryKind::Modify);
    assert_eq!(planned.plan.original.as_deref(), Some(b"old\n".as_slice()));
    persist_plan(&planned.plan, &fs::canonicalize(&dir).unwrap()).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new\n");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn rollback_failures_are_aggregated_into_the_batch_error() {
    assert_eq!(format_rollback_failure("write failed", &[]), "write failed");
    let many: Vec<String> = (0..7).map(|i| format!("rollback a{i}: denied")).collect();
    let msg = format_rollback_failure("write failed", &many);
    assert!(
        msg.starts_with("write failed; rollback incomplete"),
        "unexpected: {msg}"
    );
    assert!(msg.contains("rollback a0: denied"), "unexpected: {msg}");
    assert!(msg.contains("(+2 more)"), "unexpected: {msg}");
    assert!(
        !msg.contains("rollback a5"),
        "report must stay bounded: {msg}"
    );
}

#[test]
fn a_failed_create_whose_cleanup_also_fails_reports_the_partial_file() {
    let dir = temp_dir("create-cleanup");
    let path = dir.join("partial.txt");
    // Write fails, and the cleanup removal fails too: both must be named,
    // and the partial file really is still on disk afterwards.
    let err = atomic_write_create_new_with(
        &path,
        b"payload\n",
        |_file, _bytes| Err(io::Error::other("disk full")),
        |_path| Err(io::Error::other("remove denied")),
    )
    .expect_err("failed write must be reported");
    assert!(err.contains("disk full"), "unexpected: {err}");
    assert!(err.contains("cleanup incomplete"), "unexpected: {err}");
    assert!(err.contains("remove denied"), "unexpected: {err}");
    assert!(
        path.exists(),
        "the report must match the disk: partial file kept"
    );

    // Cleanup that succeeds leaves no partial file and no cleanup clause.
    let path2 = dir.join("cleaned.txt");
    let err2 = atomic_write_create_new_with(
        &path2,
        b"payload\n",
        |_file, _bytes| Err(io::Error::other("disk full")),
        |path: &Path| fs::remove_file(path),
    )
    .expect_err("failed write must be reported");
    assert!(err2.contains("disk full"), "unexpected: {err2}");
    assert!(!err2.contains("cleanup incomplete"), "unexpected: {err2}");
    assert!(!path2.exists());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_failed_batch_rolls_back_what_it_can_and_reports_what_it_cannot() {
    let dir = temp_dir("rb-loop");
    let created = dir.join("created.txt");
    fs::write(&created, b"ours\n").unwrap();
    let plans = vec![
        // Restorable: the file this batch created is removed again.
        PlannedWrite {
            kind: EntryKind::Create,
            path: created.clone(),
            original: None,
            next: Some(b"ours\n".to_vec()),
            snapshot: None,
            content_hash: None,
        },
        // Unrestorable: its parent directory does not exist.
        PlannedWrite {
            kind: EntryKind::Modify,
            path: dir.join("gone").join("f.txt"),
            original: Some(b"old\n".to_vec()),
            next: Some(b"new\n".to_vec()),
            snapshot: None,
            content_hash: None,
        },
    ];
    let errors = rollback_applied(&plans, vec![0, 1]);
    assert_eq!(
        errors.len(),
        1,
        "only the unrestorable entry reports: {errors:?}"
    );
    assert!(
        !created.exists(),
        "the restorable entry must be rolled back"
    );
    let msg = format_rollback_failure("persist failed", &errors);
    assert!(
        msg.starts_with("persist failed; rollback incomplete"),
        "unexpected: {msg}"
    );
    assert!(
        msg.contains("f.txt"),
        "the unrestored path must be named: {msg}"
    );
    fs::remove_dir_all(&dir).ok();
}

#[cfg(windows)]
#[test]
fn windows_atomic_replace_retries_only_lock_style_errors() {
    assert!(is_transient_windows_replace_error(
        &io::Error::from_raw_os_error(5)
    ));
    assert!(is_transient_windows_replace_error(
        &io::Error::from_raw_os_error(32)
    ));
    assert!(is_transient_windows_replace_error(
        &io::Error::from_raw_os_error(33)
    ));
    assert!(!is_transient_windows_replace_error(
        &io::Error::from_raw_os_error(2)
    ));
}

#[test]
fn normalized_tier_matches_typographic_interior_context() {
    // Source whose INTERIOR context line carries an em-dash (U+2014), a
    // non-breaking space (U+00A0), and curly double quotes (U+201C/U+201D).
    // The patch is authored in plain ASCII. Without the Unicode-
    // normalization tier this interior context line would mismatch and the
    // hunk would be rejected (interior content drift is not tolerated by the
    // outer-context fuzz budget); with it, the hunk applies at zero fuzz.
    let source = "old first\nconfig\u{00A0}\u{2014} \u{201C}value\u{201D}\nold last\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(
            1,
            &[
                "-old first",
                "+new first",
                " config - \"value\"",
                "-old last",
                "+new last",
            ],
        )],
    };

    let applied = apply_exact_bytes(source.as_bytes(), &entry, 2)
        .expect("ASCII patch should apply against typographic source");

    // The context line is copied verbatim from the source (typography
    // preserved); only the surrounding delete/add lines change.
    let expected = "new first\nconfig\u{00A0}\u{2014} \u{201C}value\u{201D}\nnew last\n";
    assert_eq!(String::from_utf8_lossy(&applied.bytes), expected);
}

#[test]
fn far_exact_block_beats_nearer_normalized_block() {
    // Two candidate blocks for the same single-line delete:
    //   idx 1: a NEAR typographic variant (em-dash + curly quotes) that
    //          only matches the ASCII patch after Unicode normalization.
    //   idx 5: a FAR exact ASCII match.
    // The hunk targets old_start=2 (target_idx=1), so the normalized block
    // sits at distance 0 and the exact block at distance 4. Before the
    // norm_count tiebreak, both scored fuzz 0 and the nearer normalized
    // block would have won (mis-anchoring onto typographic source). The fix
    // requires a block that matched WITHOUT normalization to always win,
    // regardless of distance.
    let source = concat!(
        "alpha\n",
        "config \u{2014} \u{201C}x\u{201D}\n", // idx 1: normalized-only, NEAR
        "beta\n",
        "gamma\n",
        "delta\n",
        "config - \"x\"\n", // idx 5: exact ASCII, FAR
        "omega\n",
    );
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(2, &["-config - \"x\"", "+config - \"y\""])],
    };

    let applied = apply_exact_bytes(source.as_bytes(), &entry, 2)
        .expect("hunk should apply via the far exact block");

    // The FAR exact block (idx 5) must be the one replaced; the NEAR
    // typographic line (idx 1) must remain byte-for-byte untouched.
    let expected = concat!(
        "alpha\n",
        "config \u{2014} \u{201C}x\u{201D}\n",
        "beta\n",
        "gamma\n",
        "delta\n",
        "config - \"y\"\n",
        "omega\n",
    );
    assert_eq!(String::from_utf8_lossy(&applied.bytes), expected);
}

#[test]
fn append_after_eof_line_without_trailing_newline() {
    let source = b"line1\nline2-nonl";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(2, &[" line2-nonl", "+line3"])],
    };

    let applied =
        apply_exact_bytes(source, &entry, 2).expect("append after no-trailing-newline EOF line");
    // The source had no final newline and the patch says nothing about it,
    // so the rewritten tail must not invent one (JS dispatcher parity).
    assert_eq!(
        String::from_utf8_lossy(&applied.bytes),
        "line1\nline2-nonl\nline3"
    );
}

#[test]
fn insert_only_at_eof_without_trailing_newline_adds_a_separator() {
    let source = b"root";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["+A"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("insert at EOF");
    assert_eq!(String::from_utf8_lossy(&applied.bytes), "root\nA");
}

#[test]
fn two_insert_only_hunks_at_eof_keep_source_order() {
    let source = b"root\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["+A"]), hunk(1, &["+B"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("two EOF inserts");
    assert_eq!(String::from_utf8_lossy(&applied.bytes), "root\nA\nB\n");
}

#[test]
fn insert_only_at_eof_crlf_without_trailing_newline_uses_crlf() {
    let source = b"one\r\ntwo";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(2, &["+three"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("insert at CRLF EOF");
    assert_eq!(
        String::from_utf8_lossy(&applied.bytes),
        "one\r\ntwo\r\nthree"
    );
}

#[test]
fn cr_only_update_preserves_cr() {
    let source = b"hello\rworld\r";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &[" hello", "-world", "+WORLD"])],
    };
    let applied = apply_exact_bytes(source, &entry, 2).expect("cr-only update");
    assert_eq!(&applied.bytes, b"hello\rWORLD\r");
}

#[test]
fn deleting_the_unterminated_eof_line_keeps_the_previous_terminator() {
    // "a\r\nb" with no final newline: deleting `b` must leave "a\r\n".
    // The CRLF belongs to the untouched line `a`.
    for (source, expected) in [(&b"a\r\nb"[..], &b"a\r\n"[..]), (&b"a\nb"[..], &b"a\n"[..])] {
        let entry = Entry {
            old_file: "f".to_string(),
            new_file: "f".to_string(),
            hunks: vec![hunk(1, &[" a", "-b"])],
        };
        let applied = apply_exact_bytes(source, &entry, 2).expect("tail delete");
        assert_eq!(&applied.bytes, expected);
    }
}

#[test]
fn replacement_keeps_the_replaced_line_terminator_in_a_mixed_eol_file() {
    // Context is CRLF, the replaced line is LF: the rewrite must keep that
    // line's own LF instead of folding the block onto one anchor EOL.
    let source = b"ctx\r\nold\nkeep\r\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &[" ctx", "-old", "+NEW", " keep"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("mixed-eol update");
    assert_eq!(&applied.bytes, b"ctx\r\nNEW\nkeep\r\n");
}

#[test]
fn the_engine_contract_marker_is_embedded_verbatim() {
    assert_eq!(
        std::str::from_utf8(&MIXDOG_PATCH_ENGINE_CONTRACT).expect("ascii marker"),
        ENGINE_CONTRACT_MARKER,
    );
}

#[test]
fn a_utf8_bom_is_a_file_prefix_not_line_content() {
    // Updating the FIRST line must match `alpha`, and the BOM must survive.
    let source = b"\xEF\xBB\xBFalpha\nkeep\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["-alpha", "+omega", " keep"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("bom first-line update");
    assert_eq!(&applied.bytes, b"\xEF\xBB\xBFomega\nkeep\n");
}

#[test]
fn an_insertion_lands_after_a_bom_only_prefix() {
    let source = b"\xEF\xBB\xBFalpha\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(0, &["+first"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("insert at top of bom file");
    assert_eq!(&applied.bytes, b"\xEF\xBB\xBFfirst\nalpha\n");
}

#[test]
fn duplicate_deletes_are_claimed_in_order() {
    // D/X/D → X/D must take the FINAL D's LF, not the first D's CRLF.
    let source = b"D\r\nX\nD\nT\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["-D", "-X", "-D", "+X", "+D", " T"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("duplicate deletes");
    assert_eq!(&applied.bytes, b"X\nD\nT\n");
}

#[test]
fn a_backward_move_across_two_contexts_keeps_its_own_terminator() {
    // `+A` precedes its `-A`: the identity pool must span the whole hunk.
    let source = b"C1\nC2\nA\r\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["+A", " C1", " C2", "-A"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("backward move");
    assert_eq!(&applied.bytes, b"A\r\nC1\nC2\n");
}

#[test]
fn a_move_across_context_keeps_its_own_terminator() {
    // `-A`, ` MID`, `+A`: A is the same line, so it keeps its CRLF.
    let source = b"A\r\nMID\nT\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["-A", " MID", "+A", " T"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("move across context");
    assert_eq!(&applied.bytes, b"MID\nA\r\nT\n");
}

#[test]
fn a_multi_run_hunk_keeps_every_untouched_terminator() {
    // Two change runs around interior context: only op-wise mapping puts
    // MID's CRLF and T's LF back where they belong.
    let source = b"H\r\nA\nMID\r\nC\nT\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &[" H", "-A", "+A2", " MID", "-C", "+C2", " T"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("multi-run hunk");
    assert_eq!(&applied.bytes, b"H\r\nA2\nMID\r\nC2\nT\n");
}

#[test]
fn a_moved_line_does_not_drag_a_neighbouring_terminator() {
    let source = b"H\r\nA\nMID\r\nT\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &[" H", "-A", " MID", "+A", " T"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("moved line");
    assert_eq!(&applied.bytes, b"H\r\nMID\r\nA\nT\n");
}

#[test]
fn the_exact_and_fuzzy_paths_agree_byte_for_byte() {
    let source = b"H\r\nA\nMID\r\nC\nT\n";
    let lines = [" H", "-A", "+A2", " MID", "-C", "+C2", " T"];
    let exact = apply_exact_bytes(
        source,
        &Entry {
            old_file: "f".to_string(),
            new_file: "f".to_string(),
            hunks: vec![hunk(1, &lines)],
        },
        2,
    )
    .expect("exact path");
    // An out-of-range anchor forces the fuzzy seek for the same hunk.
    let fuzzy = apply_exact_bytes(
        source,
        &Entry {
            old_file: "f".to_string(),
            new_file: "f".to_string(),
            hunks: vec![hunk(99, &lines)],
        },
        2,
    )
    .expect("fuzzy path");

    assert_eq!(exact.bytes, fuzzy.bytes);
    assert_eq!(&exact.bytes, b"H\r\nA2\nMID\r\nC2\nT\n");
}

#[test]
fn a_shrinking_hunk_keeps_the_following_context_terminator() {
    // Two mixed-EOL lines collapse into one: the trailing context `keep`
    // must keep its own LF instead of inheriting a deleted line's CRLF.
    let source = b"ctx\r\nold1\nold2\r\nkeep\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &[" ctx", "-old1", "-old2", "+NEW", " keep"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("shrinking mixed-eol hunk");
    assert_eq!(&applied.bytes, b"ctx\r\nNEW\nkeep\n");
}

#[test]
fn fuzzy_replacement_keeps_the_replaced_line_terminator() {
    // An out-of-range anchor forces the fuzzy seek; the replaced line's LF
    // must survive there too.
    let source = b"ctx\r\nold\nkeep\r\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(9, &[" ctx", "-old", "+NEW", " keep"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("fuzzy mixed-eol update");
    assert_eq!(&applied.bytes, b"ctx\r\nNEW\nkeep\r\n");
}

#[test]
fn explicit_no_newline_marker_on_the_new_side_is_respected() {
    let source = b"one\ntwo\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(
            2,
            &["-two", "+two-nonl", "\\ No newline at end of file"],
        )],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("explicit marker");
    assert_eq!(String::from_utf8_lossy(&applied.bytes), "one\ntwo-nonl");
}

#[test]
fn insertion_sharing_a_position_with_a_replacement_is_rejected() {
    let source = b"one\ntwo\nthree\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        // `-2,0` inserts after line 2 (offset of line 3); the next hunk
        // replaces line 3, which starts at that same offset.
        hunks: vec![hunk(2, &["+inserted"]), hunk(3, &["-three", "+THREE"])],
    };

    let err = match apply_exact_bytes(source, &entry, 2) {
        Ok(_) => panic!("same-position insert + replacement must be refused"),
        Err(err) => err,
    };
    assert!(err.contains("same position"), "unexpected error: {err}");
}

#[test]
fn adjacent_replacements_still_apply() {
    let source = b"one\ntwo\nthree\n";
    let entry = Entry {
        old_file: "f".to_string(),
        new_file: "f".to_string(),
        hunks: vec![hunk(1, &["-one", "+ONE"]), hunk(2, &["-two", "+TWO"])],
    };

    let applied = apply_exact_bytes(source, &entry, 2).expect("adjacent hunks");
    assert_eq!(String::from_utf8_lossy(&applied.bytes), "ONE\nTWO\nthree\n");
}

#[test]
fn normalize_typographic_maps_dashes_quotes_spaces() {
    assert_eq!(
        normalize_typographic("\u{2014}a\u{00A0}b\u{2019}c\u{201D}".as_bytes()),
        "-a b'c\""
    );
}

#[test]
fn edit2_exact_curly_crlf_tiers() {
    let (tier, spans) = locate_invariant_safe_spans("hello world", "world", false).unwrap();
    assert_eq!(tier, EditTier::Exact);
    assert_eq!(spans, vec![(6, 11)]);

    // Source carries curly double quotes; the needle uses straight quotes.
    let src = "say \u{201C}hi\u{201D} now";
    let (tier, spans) = locate_invariant_safe_spans(src, "\"hi\"", false).unwrap();
    assert_eq!(tier, EditTier::Curly);
    assert_eq!(&src[spans[0].0..spans[0].1], "\u{201C}hi\u{201D}");

    // Source uses CRLF; the needle uses LF.
    let src = "a\r\nb\r\nc";
    let (tier, spans) = locate_invariant_safe_spans(src, "a\nb", false).unwrap();
    assert_eq!(tier, EditTier::Crlf);
    assert_eq!(&src[spans[0].0..spans[0].1], "a\r\nb");
}

#[test]
fn edit2_ambiguous_without_replace_all_errors() {
    let err = locate_invariant_safe_spans("x x x", "x", false).unwrap_err();
    assert!(err.contains("found"));
}

#[test]
fn edit2_overlapping_ambiguity_rejected() {
    // "aa" overlaps at idx 0 and 1 in "aaa"; must be ambiguous like the JS editor.
    let err = locate_invariant_safe_spans("aaa", "aa", false).unwrap_err();
    assert!(err.contains("found"));
    // replace_all still applies a single non-overlapping replacement.
    let (_, spans) = locate_invariant_safe_spans("aaa", "aa", true).unwrap();
    assert_eq!(spans.len(), 1);
}

#[test]
fn preserve_eol_matches_slice() {
    // multiline slice with CRLF: LF replacement upgraded to CRLF
    assert_eq!(preserve_eol(b"a\nb", b"x\r\ny", b"x\r\ny\r\n"), b"a\r\nb");
    // LF slice: untouched
    assert_eq!(preserve_eol(b"a\nb", b"x\ny", b"x\ny"), b"a\nb");
    // single-line slice in pure-CRLF file: LF -> CRLF
    assert_eq!(preserve_eol(b"a\nb", b"word", b"l1\r\nl2\r\n"), b"a\r\nb");
    // single-line slice in LF file: untouched (no mixed-EOL synthesis)
    assert_eq!(preserve_eol(b"a\nb", b"word", b"l1\nl2\n"), b"a\nb");
}

#[test]
fn edit2_replace_all_collects_all() {
    let (tier, spans) = locate_invariant_safe_spans("x x x", "x", true).unwrap();
    assert_eq!(tier, EditTier::Exact);
    assert_eq!(spans.len(), 3);
}

#[test]
fn edit2_nfc_matches_precomposed_vs_decomposed() {
    // Source has precomposed 'é' (U+00E9); needle uses decomposed e + U+0301.
    let src = "caf\u{00E9} bar";
    let needle = "caf\u{0065}\u{0301}";
    let (tier, spans) = locate_invariant_safe_spans(src, needle, false).unwrap();
    assert_eq!(tier, EditTier::Nfc);
    assert_eq!(&src[spans[0].0..spans[0].1], "caf\u{00E9}");
}

#[test]
fn edit2_nfc_respects_char_boundary() {
    // The lone combining acute must NOT match by splitting the source 'é'.
    let src = "x\u{00E9}y";
    let res = locate_invariant_safe_spans(src, "\u{0301}", false);
    assert!(res.is_err());
}
