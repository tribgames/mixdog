"""Run: python -m unittest apps/mobile/scripts/test_testflight_submit.py"""

import importlib.util
import io
import pathlib
import sys
import types
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.modules.setdefault("jwt", types.ModuleType("jwt"))  # auth is faked below
spec = importlib.util.spec_from_file_location("tfs", HERE / "testflight-submit.py")
tfs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tfs)


class Fake:
    def __init__(self, builds, locs=(), review=None, existing=None, group_post=None, members=None):
        self.builds, self.locs, self.review = list(builds), list(locs), review
        self.existing = existing  # body of GET /builds/{id}/betaAppReviewSubmission
        self.group_post = group_post  # exception raised by POST to the group
        self.members = members if members is not None else []  # GET pages, in order
        self.calls = []

    def __call__(self, method, path, body=None, tolerate=()):
        self.calls.append((method, path, body))
        if path.startswith("/builds?"):
            return {"data": [self.builds.pop(0)]} if self.builds else {"data": []}
        if path.endswith("/betaBuildLocalizations?limit=200"):
            return {"data": self.locs}
        if "/betaGroups" in path:
            if method == "POST":
                if self.group_post:
                    raise self.group_post
                return {}
            return self.members.pop(0) if len(self.members) > 1 else (self.members[0] if self.members else {"data": []})
        if path.endswith("/betaAppReviewSubmissions"):
            if isinstance(self.review, BaseException):
                raise self.review
            return self.review if self.review is not None else {"data": {"id": "r"}}
        if path.endswith("/betaAppReviewSubmission"):
            return self.existing if self.existing is not None else {"data": None}
        return {}


def build(state):
    return {"id": "B1", "attributes": {"processingState": state}}


class Tests(unittest.TestCase):
    def run_main(self, fake):
        with mock.patch.object(tfs.asc_api, "call", fake), mock.patch.object(tfs.time, "sleep"):
            tfs.main("1.2.3", "7")

    def test_full_flow_creates_and_updates(self):
        fake = Fake([build("PROCESSING"), build("VALID")],
                    locs=[{"id": "L1", "attributes": {"locale": "ko"}}])
        self.run_main(fake)
        calls = [(m, p) for m, p, _ in fake.calls]
        self.assertIn(("PATCH", "/betaBuildLocalizations/L1"), calls)
        self.assertIn(("POST", "/betaBuildLocalizations"), calls)
        self.assertIn(("POST", f"/betaGroups/{tfs.DEFAULT_GROUP}/relationships/builds"), calls)
        self.assertEqual(calls[-1], ("POST", "/betaAppReviewSubmissions"))
        self.assertIn("filter%5Bversion%5D=7", fake.calls[0][1])

    def test_accepts_existing_review_on_409(self):
        conflict = tfs.asc_api.AscError("POST", "/betaAppReviewSubmissions", 409, "{dup}")
        existing = {"data": {"id": "R1", "attributes": {"betaReviewState": "WAITING_FOR_REVIEW"}}}
        fake = Fake([build("VALID")], review=conflict, existing=existing)
        with mock.patch("builtins.print") as out:
            self.run_main(fake)
        self.assertEqual(fake.calls[-1][:2], ("GET", "/builds/B1/betaAppReviewSubmission"))
        self.assertTrue(any("WAITING_FOR_REVIEW" in str(c) for c in out.call_args_list))

    def group_calls(self, fake):
        return [(m, p) for m, p, _ in fake.calls if "/betaGroups" in p]

    def test_group_add_success_does_not_tolerate_or_poll(self):
        fake = Fake([build("VALID")])
        seen = []
        def spy(method, path, body=None, tolerate=()):
            if method == "POST" and "/betaGroups" in path:
                seen.append(tolerate)
            return fake(method, path, body, tolerate)
        with mock.patch.object(tfs.asc_api, "call", spy), mock.patch.object(tfs.time, "sleep"):
            tfs.main("1.2.3", "7")
        self.assertEqual(seen, [()])
        self.assertEqual([m for m, _ in self.group_calls(fake)], ["POST"])

    def test_group_conflict_with_verified_member_succeeds(self):
        conflict = tfs.asc_api.AscError("POST", "/betaGroups/g/relationships/builds", 409, "{member}")
        fake = Fake([build("VALID")], group_post=conflict,
                    members=[{"data": [{"id": "OTHER"}, {"id": "B1"}]}])
        self.run_main(fake)
        self.assertEqual([m for m, _ in self.group_calls(fake)], ["POST", "GET"])
        self.assertEqual(fake.calls[-1][:2], ("POST", "/betaAppReviewSubmissions"))

    def test_group_conflict_waits_for_membership_to_appear(self):
        conflict = tfs.asc_api.AscError("POST", "/betaGroups/g/relationships/builds", 409, "{later}")
        fake = Fake([build("VALID")], group_post=conflict,
                    members=[{"data": []}, {"data": []}, {"data": [{"id": "B1"}]}])
        self.run_main(fake)
        self.assertEqual([m for m, _ in self.group_calls(fake)], ["POST", "GET", "GET", "GET"])

    def test_group_conflict_with_absent_build_fails_with_body(self):
        conflict = tfs.asc_api.AscError("POST", "/betaGroups/g/relationships/builds", 409, "{rejected}")
        fake = Fake([build("VALID")], group_post=conflict, members=[{"data": [{"id": "OTHER"}]}])
        with mock.patch.object(tfs.asc_api, "call", fake), mock.patch.object(tfs.time, "sleep") as sleep, \
                self.assertRaises(SystemExit) as ctx:
            tfs.main("1.2.3", "7")
        self.assertIn("409", str(ctx.exception))
        self.assertIn("{rejected}", str(ctx.exception))
        self.assertNotIn(("POST", "/betaAppReviewSubmissions"), [(m, p) for m, p, _ in fake.calls])
        self.assertEqual(len([1 for m, _ in self.group_calls(fake) if m == "GET"]), tfs.GROUP_CHECKS)
        self.assertEqual(sleep.call_count, tfs.GROUP_CHECKS - 1)

    def test_group_non_conflict_error_is_raised(self):
        err = tfs.asc_api.AscError("POST", "/betaGroups/g/relationships/builds", 403, "{forbidden}")
        fake = Fake([build("VALID")], group_post=err)
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(fake)
        self.assertIn("{forbidden}", str(ctx.exception))
        self.assertEqual([m for m, _ in self.group_calls(fake)], ["POST"])

    def test_group_membership_follows_pagination(self):
        api = tfs.asc_api.API
        fake = Fake([], members=[
            {"data": [{"id": "A"}], "links": {"next": api + "/betaGroups/g/relationships/builds?cursor=2"}},
            {"data": [{"id": "B1"}]},
        ])
        with mock.patch.object(tfs.asc_api, "call", fake):
            self.assertTrue(tfs.group_has_build("B1", "g"))
        self.assertEqual([p for _, p, _ in fake.calls],
                         ["/betaGroups/g/relationships/builds?limit=200",
                          "/betaGroups/g/relationships/builds?cursor=2"])

    def test_409_without_existing_submission_fails_with_body(self):
        conflict = tfs.asc_api.AscError("POST", "/betaAppReviewSubmissions", 409, "{apple says no}")
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(Fake([build("VALID")], review=conflict))
        self.assertIn("409", str(ctx.exception))
        self.assertIn("{apple says no}", str(ctx.exception))

    def existing_review(self, attributes):
        conflict = tfs.asc_api.AscError("POST", "/betaAppReviewSubmissions", 409, "{dup}")
        existing = {"data": {"id": "R1", "attributes": attributes}}
        return Fake([build("VALID")], review=conflict, existing=existing)

    def test_existing_review_rejected_or_unknown_state_fails(self):
        for attrs, label in (({"betaReviewState": "REJECTED"}, "REJECTED"),
                             ({}, "UNKNOWN"),
                             ({"betaReviewState": "SOMETHING_ELSE"}, "SOMETHING_ELSE")):
            with self.subTest(label), self.assertRaises(SystemExit) as ctx:
                self.run_main(self.existing_review(attrs))
            self.assertIn("{dup}", str(ctx.exception))
            self.assertIn(label, str(ctx.exception))

    def test_existing_review_accepted_states_succeed(self):
        for state in ("WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"):
            with self.subTest(state), mock.patch("builtins.print") as out:
                self.run_main(self.existing_review({"betaReviewState": state}))
                self.assertTrue(any(state in str(c) for c in out.call_args_list))

    def test_timeout_error_without_submission_fails(self):
        err = tfs.asc_api.AscError("POST", "/betaAppReviewSubmissions", None, "TimeoutError: timed out")
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(Fake([build("VALID")], review=err))
        self.assertIn("timed out", str(ctx.exception))

    def test_call_passes_timeout_and_keeps_error_body(self):
        asc = tfs.asc_api
        res = mock.MagicMock()
        res.__enter__.return_value.read.return_value = b"{}"
        with mock.patch.object(asc, "token", return_value="t"), \
                mock.patch.object(asc.urllib.request, "urlopen", return_value=res) as op:
            asc.call("GET", "/x")
        self.assertEqual(op.call_args.kwargs["timeout"], asc.TIMEOUT)
        self.assertLessEqual(asc.TIMEOUT, 60)
        http = asc.urllib.error.HTTPError("u", 409, "Conflict", {}, io.BytesIO(b'{"errors":1}'))
        with mock.patch.object(asc, "token", return_value="t"), \
                mock.patch.object(asc.urllib.request, "urlopen", side_effect=http):
            with self.assertRaises(asc.AscError) as ctx:
                asc.call("POST", "/x", {})
            self.assertEqual((ctx.exception.status, ctx.exception.body), (409, '{"errors":1}'))
            self.assertEqual(asc.call("POST", "/x", {}, tolerate=(409,)), {})

    def test_invalid_fails(self):
        with self.assertRaises(SystemExit) as ctx:
            self.run_main(Fake([build("INVALID")]))
        self.assertIn("INVALID", str(ctx.exception))

    def test_timeout(self):
        ticks = iter([0, 0, 10**6])
        with mock.patch.object(tfs.asc_api, "call", Fake([])), self.assertRaises(SystemExit):
            tfs.wait_valid("1.2.3", "7", sleep=lambda s: None, clock=lambda: next(ticks))


if __name__ == "__main__":
    unittest.main()
