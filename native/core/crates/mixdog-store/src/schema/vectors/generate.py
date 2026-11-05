"""Writes frames.json and records.json, the frozen format vectors (FORMAT.md §12).

An implementation independent of the Rust crate: its own CRC-32C, its own frame encoder,
expectations stated by construction. Run from this directory: `python generate.py`.
Output is deterministic; regenerate only when FORMAT.md changes (a format change).
"""

import hashlib
import json

POLY = 0x82F63B78
HEADER_LEN = 44
HCRC_COVERED = 35
INLINE_MAX = 256 * 1024
NON_BODY_MAX = 40 * 1024
MAX_FRAME_PAYLOAD = INLINE_MAX + NON_BODY_MAX


def crc32c(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ POLY if crc & 1 else crc >> 1
    return crc ^ 0xFFFFFFFF


assert crc32c(b"123456789") == 0xE3069283


def header(ordinal: int, length: int, crc: int, hcrc_override=None) -> bytes:
    covered = f"{ordinal:016x} {length:08x} {crc:08x} ".encode()
    assert len(covered) == HCRC_COVERED
    hcrc = crc32c(covered) if hcrc_override is None else hcrc_override
    return covered + f"{hcrc:08x} ".encode()


def frame(ordinal: int, payload: bytes, crc_override=None) -> bytes:
    """A frame; `crc_override` sets a wrong payload CRC under a valid header checksum."""
    crc = crc32c(payload) if crc_override is None else crc_override
    return header(ordinal, len(payload), crc) + payload + b"\n"


def canon(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def digest(tag: str) -> str:
    return "sha256:" + hashlib.sha256(tag.encode()).hexdigest()


def hexsum(tag: str) -> str:
    return hashlib.sha256(tag.encode()).hexdigest()


LOG_ID = "4f1c2a9e0b7d3c5a6e8f9012"
OP = {"id": "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b", "method": "thread/rewind", "digest": digest("params")}
ATT = hexsum("attachment-1")
BIG = digest("big-body")
FIRST = {"ordinal": 0, "file_no": 0, "offset": 0}

# Payloads as the writer encodes them: typed fields in declaration order, None omitted,
# opaque object keys in serde_json map order (sorted by UTF-8 bytes) (FORMAT.md §5.1).
RECORDS = [
    ("session_new", {"k": "session", "v": 2, "id": "sess_daemon_1793306569908_63cc", "log_id": LOG_ID,
                     "header": {"inline": {"agent": "lead", "closed": False, "createdAt": 1793306569908,
                                           "generation": 3, "id": "sess_daemon_1793306569908_63cc",
                                           "owner": "user", "title": "시험 세션"}}}),
    ("session_fork", {"k": "session", "v": 2, "id": "sess_fork_1", "log_id": "aa00bb11cc22dd33ee44ff55",
                      "base": {"session": "sess_daemon_1793306569908_63cc", "log_id": LOG_ID,
                               "end_ordinal_exclusive": 42},
                      "op": {"id": OP["id"], "method": "thread/fork", "digest": OP["digest"],
                             "result": {"threadId": "sess_fork_1"}},
                      "header": {"inline": {"id": "sess_fork_1", "inheritedFromSessionId": "sess_daemon_1793306569908_63cc"}}}),
    ("session_migrated", {"k": "session", "v": 2, "id": "sess_v145_1", "log_id": "0d1e2f3a4b5c6d7e8f901a2b",
                          "origin": {"migration": {"manifest_sha256": hexsum("manifest"), "item_key": "session/sess_v145_1",
                                                   "source_digest": digest("observable")}},
                          "header": {"blob": {"digest": digest("header"), "bytes": 300001, "mediaType": "application/json"}}}),
    ("meta", {"k": "meta", "change": {"inline": {"set": {"archivedAt": 1793306570000, "title": "New title"},
                                                 "unset": ["detachedReason"]}}}),
    ("meta_worker", {"k": "meta", "op": {"id": OP["id"], "method": "thread/name/update", "digest": OP["digest"]},
                     "change": {"inline": {"set": {"worker": {"stage": "done", "status": "completed", "tag": "w1"}},
                                           "unset": []}}}),
    ("item_message", {"k": "item", "iid": "msg_9f2c", "turn": "run_1", "role": "user", "form": "message", "model": True,
                      "visible": True, "refs": ["sha256:" + ATT],
                      "body": {"inline": {"content": [{"attachmentRef": ATT, "textKind": "file", "type": "text"},
                                                      {"text": "줄\n바꿈 \"quote\"", "type": "text"}],
                                          "meta": {"transcript": {"messageId": "msg_9f2c"}}, "role": "user"}}}),
    ("item_marker_meta", {"k": "item", "iid": "pos:sess_v145_1:7", "role": "user", "form": "message", "model": True,
                          "visible": False, "refs": [], "body": {"inline": {"content": "skill text", "meta": "skill", "role": "user"}}}),
    ("item_display_segment", {"k": "item", "iid": "arc:3:0", "role": "user", "form": "display", "model": False, "visible": True,
                              "archive": {"seq": 3, "at": 1792567969569,
                                          "origin": {"segment": {"id": "seg3", "prev": "seg2", "count": 2, "bytes": 1234}}},
                              "refs": [], "body": {"inline": {"archived": True, "id": "hist_sess_v145_1_1", "kind": "message",
                                                              "role": "user", "text": "hello"}}}),
    ("item_display_first_segment", {"k": "item", "iid": "arch1_divider", "form": "display", "model": False, "visible": False,
                                    "archive": {"seq": 1, "at": 1792567960000,
                                                "origin": {"segment": {"id": "seg1", "count": 1, "bytes": 200}}},
                                    "refs": [], "body": {"inline": {"id": "arch1_divider", "kind": "statusdone",
                                                                    "label": "compacted", "status": "compacted"}}}),
    ("item_pending_job", {"k": "item", "iid": "msg_job_1", "role": "assistant", "form": "message", "model": False, "visible": True,
                          "archive": {"seq": 4, "at": 1792567999999,
                                      "origin": {"pending": {"divider": True, "cleared_through": 1, "max_bytes": 33554432}}},
                          "refs": [], "body": {"inline": {"content": "pending archived answer", "role": "assistant"}}}),
    ("item_user_prompt", {"k": "item", "iid": "msg_p1", "turn": "run_2", "role": "user", "form": "message", "model": True,
                          "visible": True, "prompt": {"inline": "fix it [Pasted text #1 +12 lines]"}, "refs": [],
                          "body": {"inline": {"content": "fix it\n" + "line\n" * 12, "role": "user"}}}),
    ("item_blob_body", {"k": "item", "iid": "msg_big", "turn": "run_1", "role": "tool", "form": "message", "model": True,
                        "visible": True, "refs": [BIG],
                        "body": {"blob": {"digest": BIG, "bytes": 300000, "mediaType": "application/json"}}}),
    ("amend", {"k": "amend", "iid": "msg_9f2c", "refs": [],
               "body": {"inline": {"content": "[redacted]", "role": "user"}}}),
    ("rewind", {"k": "rewind", "to_ordinal": 5, "reason": "edit", "op": OP}),
    ("rewind_clear", {"k": "rewind", "to_ordinal": 1, "reason": "clear"}),
    ("compacted", {"k": "compacted", "cid": "cmp_1", "summary_iid": "msg_sum",
                   "replacement": {"inline": [{"iid": "msg_sum", "body": {"content": "summary", "role": "user"}},
                                              {"iid": "msg_kept", "body": {"content": "kept", "role": "assistant"}}]}}),
    ("run_started", {"k": "run", "rid": "run_1", "phase": "started",
                     "attribution": {"provider": "anthropic", "model": "claude-opus", "account": "acct_1",
                                     "route": "anthropic-oauth", "preset": "default", "effort": "high"},
                     "at": 1793306569908}),
    ("run_attempt", {"k": "run", "rid": "run_1", "phase": "attempt", "attempt": {"n": 2, "delivery": "ambiguous"},
                     "at": 1793306570100}),
    ("run_completed", {"k": "run", "rid": "run_1", "phase": "completed", "at": 1793306571000}),
    ("run_migrated_conflict", {"k": "run", "rid": "ckpt:tok_77", "phase": "interrupted",
                               "detail": {"inline": {"checkpoint": {"generation": 2, "turnToken": "tok_77"},
                                                     "unrecovered": True}}}),
    ("approval_requested", {"k": "approval", "aid": "apr_1", "rid": "run_1", "phase": "requested", "at": 1793306570200,
                            "body": {"inline": {"input": {"command": "ls"}, "tool": "shell"}}}),
    ("approval_decided", {"k": "approval", "aid": "apr_1", "rid": "run_1", "phase": "decided", "by_client": "desktop-1",
                          "at": 1793306570300, "body": {"inline": {"decision": "approve"}}}),
    ("queue_enqueue", {"k": "queue", "qid": "q_1", "action": "enqueue",
                       "entry": {"inline": {"enqueuedAt": 1793306570400, "executionId": "exec_1",
                                            "message": {"content": "follow up", "role": "user"},
                                            "mode": "followup", "notificationKind": "routine"}}}),
    ("queue_dequeue", {"k": "queue", "qid": "q_1", "action": "dequeue", "reason": "delivered"}),
    ("op_fenced", {"k": "op", "op": {"id": "0190f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0c", "method": "thread/name/update",
                                     "digest": digest("other")}, "state": "fenced", "at": 1793306570500}),
    ("op_rejected", {"k": "op", "op": OP, "state": "rejected", "at": 1793306570600,
                     "detail": {"inline": {"code": -32600, "message": "turnNotActive"}}}),
    ("checkpoint", {"k": "checkpoint", "state": {"inline": {
        "log_id": LOG_ID, "covers_ordinal": 12, "history_rev": 1, "rows": 8, "visible_rows": 7,
        "context": {"ordinal": 6, "file_no": 0, "offset": 2048},
        "runs": [{"rid": "run_2", "started": {"ordinal": 10, "file_no": 0, "offset": 3100}}],
        "approvals": [{"aid": "apr_2", "rid": "run_2", "requested": {"ordinal": 11, "file_no": 0, "offset": 3300}}],
        "queue": [{"qid": "q_2", "enqueued": {"ordinal": 9, "file_no": 0, "offset": 2900}}],
        "header": {"id": "sess_daemon_1793306569908_63cc", "title": "시험 세션"}}}}),
    ("checkpoint_fork_rotated", {"k": "checkpoint", "state": {"inline": {
        "log_id": "aa00bb11cc22dd33ee44ff55", "covers_ordinal": 70000, "history_rev": 0, "rows": 0, "visible_rows": 0,
        "base": {"session": "sess_daemon_1793306569908_63cc", "log_id": LOG_ID, "end_ordinal_exclusive": 42},
        "runs": [], "approvals": [], "queue": [], "header": {}}}}),
    ("checkpoint_fork_cut", {"k": "checkpoint", "state": {"inline": {
        "log_id": "aa00bb11cc22dd33ee44ff55", "covers_ordinal": 45, "history_rev": 1, "rows": 0, "visible_rows": 0,
        "base": {"session": "sess_daemon_1793306569908_63cc", "log_id": LOG_ID, "end_ordinal_exclusive": 42},
        "base_cut": 30, "runs": [], "approvals": [], "queue": [], "header": {}}}}),
    ("checkpoint_blob", {"k": "checkpoint", "state": {"blob": {"digest": digest("state"), "bytes": 270000,
                                                               "mediaType": "application/json"}}}),
]

MANIFEST = {
    "format": 1,
    "roots": {"data": "C:/Users/u/.mixdog/data", "home": "C:/Users/u/.mixdog",
              "profile": "C:/Users/u/AppData/Roaming/mixdog-desktop"},
    "items": [
        {"key": "desktopProfile/agentRooms", "group": "desktopProfile", "kind": "agentRooms", "contract": "convert",
         "sources": [{"root": "profile", "path": "agent-rooms.json", "size": 18, "sha256": hexsum("rooms"), "secret": False}],
         "target": {"stateTable": {"table": "rooms"}}},
        {"key": "desktopProfile/notificationPreferences", "group": "desktopProfile", "kind": "notificationPreferences",
         "contract": "convert",
         "sources": [{"root": "profile", "path": "notification-preferences.json", "size": 1892, "sha256": hexsum("np"), "secret": False}],
         "target": {"configKey": {"key": "notifications"}}},
        {"key": "desktopProfile/relayE2ee", "group": "desktopProfile", "kind": "relayE2ee", "contract": "preserve",
         "sources": [{"root": "profile", "path": "relay-e2ee.json", "size": 695, "sha256": hexsum("e2ee"), "secret": True}],
         "target": {"file": {"root": "data", "path": "remote/e2ee.json"}}},
        {"key": "desktopProfile/sessionMetadata", "group": "desktopProfile", "kind": "sessionMetadata", "contract": "convert",
         "sources": [], "target": "sessions"},
        {"key": "index", "group": "data", "kind": "index", "contract": "convert", "sources": [], "target": "index"},
        {"key": "ledger", "group": "data", "kind": "ledger", "contract": "convert",
         "sources": [{"root": "data", "path": "usage/ledger.sqlite", "size": 4096, "sha256": hexsum("ledger"), "secret": False}],
         "target": "ledger"},
        {"key": "retain/data/sessions/sess_x.json.corrupt-1792542203590", "group": "data", "kind": "setAside",
         "contract": "retain",
         "sources": [{"root": "data", "path": "sessions/sess_x.json.corrupt-1792542203590", "size": 140000,
                      "sha256": hexsum("corrupt"), "secret": False}]},
        {"key": "retire/data/session-summaries.json", "group": "data", "kind": "retired", "contract": "retire",
         "sources": [{"root": "data", "path": "session-summaries.json", "size": 2400000, "sha256": hexsum("summ"), "secret": False}]},
        {"key": "session/sess_v145_1", "group": "data", "kind": "session", "contract": "convert",
         "sources": [{"root": "data", "path": "sessions/sess_v145_1.compaction-archive.jsonl", "size": 5000,
                      "sha256": hexsum("arc"), "secret": False},
                     {"root": "data", "path": "sessions/sess_v145_1.json", "size": 606000, "sha256": hexsum("json"),
                      "secret": False}],
         "target": {"session": {"id": "sess_v145_1"}}},
        {"key": "store/goals", "group": "data", "kind": "goals", "contract": "preserve",
         "sources": [{"root": "data", "path": "goals/sess_v145_1.json", "size": 900, "sha256": hexsum("goal"), "secret": False}],
         "target": {"file": {"root": "data", "path": "goals"}}},
        {"key": "store/projectsRegistry", "group": "data", "kind": "projectsRegistry", "contract": "preserve",
         "sources": [{"root": "home", "path": "projects.json", "size": 300, "sha256": hexsum("projects"), "secret": False}],
         "target": {"file": {"root": "home", "path": "projects.json"}}},
    ],
    "shared": [
        {"file": {"root": "data", "path": "agent-workers.json", "size": 622000, "sha256": hexsum("aw"), "secret": False},
         "consumers": ["session/sess_v145_1"]},
        {"file": {"root": "profile", "path": "desktop-session-metadata.json", "size": 7596, "sha256": hexsum("dsm"),
                  "secret": False},
         "consumers": ["desktopProfile/sessionMetadata", "session/sess_v145_1"]},
    ],
}

JOURNAL = [
    ("plan", {"k": "plan", "manifest_sha256": hexsum("manifest"), "items": 11}),
    ("staged", {"k": "staged", "key": "session/sess_v145_1", "output_sha256": hexsum("frames"),
                "replaced_surrogates": 2}),
    ("published", {"k": "published", "key": "session/sess_v145_1"}),
    ("verified", {"k": "verified", "key": "session/sess_v145_1", "digest": digest("observable")}),
    ("verified_retire", {"k": "verified", "key": "retire/data/session-summaries.json"}),
    ("quarantined", {"k": "quarantined", "key": "retain/data/sessions/sess_x.json.corrupt-1792542203590",
                     "code": "carried_set_aside"}),
    ("disposed", {"k": "disposed", "key": "session/sess_v145_1"}),
    ("phase", {"k": "phase", "phase": "verified_all"}),
]

COUNTS = {"verified": 9, "quarantined_expected": 1, "quarantined_unexpected": 0, "retired": 1, "retained": 1, "dangling": 2}
COMPLETE = {"format": 1, "manifest_sha256": hexsum("manifest"), "journal_end_ordinal": 25,
            "kinds": {"data": COUNTS, "desktopProfile": {"verified": 4, "quarantined_expected": 0,
                                                         "quarantined_unexpected": 0, "retired": 3, "retained": 0,
                                                         "dangling": 7261}}}
REASON = {"format": 1, "key": "retain/data/sessions/sess_x.json.corrupt-1792542203590", "code": "carried_set_aside",
          "expected": True, "detail": "set aside by 1.4.5 canonical reader",
          "sources": [{"root": "data", "path": "sessions/sess_x.json.corrupt-1792542203590", "sha256": hexsum("corrupt")}]}


def payload(name: str) -> bytes:
    return canon(dict(RECORDS)[name]).encode()


P = [payload(n) for n in ("session_new", "meta", "item_message", "run_started", "checkpoint")]


def frames(start: int, payloads) -> bytes:
    return b"".join(frame(start + i, p) for i, p in enumerate(payloads))


def clean():
    return {"end": "clean"}


def torn(off):
    return {"end": "torn", "offset": off}


def corrupt(off, ordinal, cause):
    return {"end": "corrupt", "offset": off, "ordinal": ordinal, "cause": cause}


two = frames(0, P[:2])
three = frames(0, P[:3])
f2 = frame(2, P[2])
f3 = frame(3, P[3])


def flip(data: bytes, at: int) -> bytes:
    b = bytearray(data)
    b[at] ^= 0x01
    return bytes(b)


CASES = []


def case(name, rule, data, committed, end, start=0, record_layer=True):
    CASES.append({"name": name, "rule": rule, "start_ordinal": start, "record_layer": record_layer,
                  "hex": data.hex(), "expect": {"committed": committed, "end": end}})


H = HEADER_LEN
at2 = len(two)
# Rules of FORMAT.md §3.2: 1 end, 2 zeros only, 3 header fields (the same checks for a
# complete and an incomplete header), 4 header incomplete, 5 payload not written,
# 6 payload CRC, 7 terminator not written, 8 terminator wrong, 9 committed.
case("empty_file", "1", b"", 0, clean())
case("three_frames", "9", three, 3, clean())
case("fork_start_ordinal", "9", frames(42, P[:2]), 2, clean(), start=42)
case("nul_extension_after_frames", "2", two + b"\x00" * 4096, 2, torn(at2))
case("nul_only_file", "2", b"\x00" * 512, 0, torn(0))
case("torn_inside_ordinal", "4", two + f2[:9], 2, torn(at2))
case("torn_partial_header_prefix", "4", two + f2[:30], 2, torn(at2))
case("torn_inside_hcrc_then_zeros", "4", two + f2[:40] + b"\x00" * 100, 2, torn(at2))
case("short_tail_garbage", "3", two + b"xyz", 2, corrupt(at2, 2, "ordinal"))
case("short_tail_wrong_ordinal", "3", two + frame(7, P[2])[:20], 2, corrupt(at2, 2, "ordinal"))
case("short_tail_separator_wrong", "3", two + f2[:16] + b"_" + f2[17:22], 2, corrupt(at2, 2, "header"))
case("short_tail_letter_in_len", "3", b"0000000000000000 z", 0, corrupt(0, 0, "length"))
case("short_tail_letter_in_crc", "3", b"0000000000000000 00000001 z", 0, corrupt(0, 0, "crc"))
case("short_tail_len_prefix_over_max", "3", b"0000000000000000 fff", 0, corrupt(0, 0, "length"))
case("short_tail_hcrc_wrong_space_missing", "3",
     two + header(2, len(P[2]), crc32c(P[2]), hcrc_override=0)[:H - 1], 2, corrupt(at2, 2, "header"))
case("torn_header_space_missing", "4", two + f2[:H - 1], 2, torn(at2))
case("short_tail_letter_in_hcrc","3", two + f2[:37] + b"g", 2, corrupt(at2, 2, "header"))
case("short_tail_len_over_max", "3",two + header(2, MAX_FRAME_PAYLOAD + 1, 0)[:30] + b"\x00" * 8, 2,
     corrupt(at2, 2, "length"))
case("torn_payload_partial", "5", two + f2[:H + 10], 2, torn(at2))
case("torn_payload_partial_then_zeros_past_frame_end", "5", two + f2[:H + 4] + b"\x00" * (len(P[2]) + 4096), 2,
     torn(at2))
case("torn_payload_with_hole_at_eof", "5", two + f2[:H + 5] + b"\x00" * 3 + f2[H + 8:H + 12], 2, torn(at2))
case("torn_missing_terminator", "7", two + f2[:-1], 2, torn(at2))
case("torn_missing_terminator_then_zeros", "7", two + f2[:-1] + b"\x00" * 10, 2, torn(at2))
# Review cases: complete payloads and impossible bytes are damage, never torn.
case("complete_payload_bad_crc_missing_terminator", "6", two + flip(f2, H + 5)[:-1], 2, corrupt(at2, 2, "crc"))
case("complete_payload_bad_crc_then_zeros", "6", two + flip(f2, H + 5)[:-1] + b"\x00" * 64, 2,
     corrupt(at2, 2, "crc"))
case("partial_frame_wrong_ordinal", "3", two + frame(7, P[2])[:H + 10], 2, corrupt(at2, 2, "ordinal"))
case("impossible_header_then_zeros", "3", two + b"x" * 50 + b"\x00" * 64, 2, corrupt(at2, 2, "header"))
case("lf_inside_complete_payload", "6", two + f2[:H + 6] + b"\n" + f2[H + 7:], 2, corrupt(at2, 2, "crc"))
case("crc_flip_middle_frame", "6", two[:len(frame(0, P[0]))] + flip(frame(1, P[1]), H + 3) + f2, 1,
     corrupt(len(frame(0, P[0])), 1, "crc"))
case("crc_flip_last_complete_frame", "6", two + flip(f2, H + 5), 2, corrupt(at2, 2, "crc"))
case("crc_field_wrong", "6", two + frame(2, P[2], crc_override=0), 2, corrupt(at2, 2, "crc"))
case("hcrc_field_wrong", "3", two + header(2, len(P[2]), crc32c(P[2]), hcrc_override=0) + P[2] + b"\n", 2,
     corrupt(at2, 2, "header"))
case("header_digit_flipped", "3", two + flip(f2, 3), 2, corrupt(at2, 2, "header"))
case("uppercase_hex", "3", two + f2[:14] + f2[14:16].upper().replace(b"0", b"A") + f2[16:], 2,
     corrupt(at2, 2, "header"))
case("hole_then_frame", "3", two + b"\x00" * 64 + f2, 2, corrupt(at2, 2, "header"))
case("ordinal_gap", "3", two + frame(3, P[2]), 2, corrupt(at2, 2, "ordinal"))
case("ordinal_repeat", "3", two + frame(1, P[2]), 2, corrupt(at2, 2, "ordinal"))
case("fork_wrong_start_ordinal", "3", frames(0, P[:1]), 0, corrupt(0, 42, "ordinal"), start=42)
case("len_over_max", "3", two + header(2, MAX_FRAME_PAYLOAD + 1, 0) + b"{" * 8, 2, corrupt(at2, 2, "length"))
case("terminator_wrong", "8", two + f2[:-1] + b"x" + f3, 2, corrupt(at2, 2, "framing"))
case("terminator_hole_then_frame", "8", two + f2[:-1] + b"\x00" + f3, 2, corrupt(at2, 2, "framing"))
case("payload_not_json_is_committed", "9", frame(0, b"not json"), 1, clean(), record_layer=False)
case("nul_inside_committed_frame", "9", frame(0, b'{"k":"x\x00"}') + frame(1, P[1]), 2, clean(),
     record_layer=False)

SINGLE = [{"ordinal": o, "payload": p.decode(), "hex": frame(o, p).hex()}
          for o, p in ((0, P[0]), (7, payload("rewind")), (0xFFFFFFFFFFFF, payload("queue_dequeue")))]

frames_doc = {
    "format": "mixdog-store frame vectors 1",
    "constants": {"header_len": HEADER_LEN, "hcrc_covered": HCRC_COVERED, "frame_overhead": HEADER_LEN + 1,
                  "inline_max": INLINE_MAX,
                  "max_frame_payload": MAX_FRAME_PAYLOAD, "crc32c_check_input": "123456789",
                  "crc32c_check": f"{crc32c(b'123456789'):08x}"},
    "single": SINGLE,
    "classification": CASES,
}
records_doc = {
    "format": "mixdog-store record vectors 1",
    "records": [{"name": n, "payload": canon(r)} for n, r in RECORDS],
    "journal": [{"name": n, "payload": canon(r)} for n, r in JOURNAL],
    "manifest": canon(MANIFEST),
    "complete": canon(COMPLETE),
    "reason": canon(REASON),
}
# Prompt history (FORMAT.md §8.2): the 1.4.5 key `text.trim().replace(/\s+/g, ' ')`, with
# the ECMAScript WhiteSpace + LineTerminator set (not Python's `str.isspace`, which also
# takes U+001C..U+001F and U+0085).
JS_SPACE = set("\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff") | {chr(c) for c in range(0x2000, 0x200B)}


def prompt_key(text: str) -> str:
    out, gap = [], False
    for ch in text:
        if ch in JS_SPACE:
            gap = True
            continue
        if gap and out:
            out.append(" ")
        gap = False
        out.append(ch)
    return "".join(out)


PROMPT_TEXTS = [
    "fix the build",
    "  fix   the\tbuild \n",
    "\u3000전각\u3000공백\u3000",
    "keep\u0085next-line and\u001cfile-sep",
    "\ufeffbom\u00a0nbsp\u2028ls",
    " \t\n ",
]
prompts_doc = {"keys": [{"text": t, "key": prompt_key(t)} for t in PROMPT_TEXTS]}

for name, doc in (("frames.json", frames_doc), ("records.json", records_doc), ("prompts.json", prompts_doc)):
    with open(name, "w", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
