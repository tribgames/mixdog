#!/usr/bin/env python3
"""unittest discovery with a structured result: one JSON line per terminal case or suite, written to the file named by MIXDOG_PY_EVIDENCE.

    python3 py-runner.py --start-dir apps/mobile/scripts --pattern "test_*.py"

The console output is unittest's own (-v). A case is final only after its teardown and cleanups: the outcome is recorded at stopTest.
A skip carries its reason as data (a JSON string, whatever quotes it holds); a skipped fixture (setUpClass, setUpModule, an import
that skips) is a suite observation that the reconciler expands to the declared tests under it; unexpected successes, expected
failures, failures and errors are never passes.
"""

import argparse
import json
import os
import re
import sys
import unittest

ROOT = os.getcwd()
HOLDER = re.compile(r"^(setUpClass|setUpModule|tearDownClass|tearDownModule) \((.+)\)$")


def relative(module_name):
    module = sys.modules.get(module_name)
    path = getattr(module, "__file__", None)
    if not path:
        return None
    return os.path.relpath(path, ROOT).replace(os.sep, "/")


class EvidenceResult(unittest.TextTestResult):
    def __init__(self, *args, out=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._out = out
        self._outcome = {}

    def _emit(self, record):
        self._out.write(json.dumps(record) + "\n")
        self._out.flush()

    def _case_id(self, test):
        file = relative(type(test).__module__)
        if file is None:
            return None
        return ["python", file, type(test).__name__, test._testMethodName]

    def _suite_id(self, holder):
        match = HOLDER.match(holder.description)
        if not match:
            return None
        dotted = match.group(2)
        if match.group(1).endswith("Class"):
            module, _, cls = dotted.rpartition(".")
        else:
            module, cls = dotted, ""
        file = relative(module)
        return None if file is None else ["python-suite", file, cls]

    def _set(self, test, status, reason=""):
        if isinstance(test, unittest.suite._ErrorHolder):
            identity = self._suite_id(test)
            self._emit(
                {
                    "kind": "suite",
                    "id": identity or ["python-suite", "unresolved", test.description],
                    "status": status,
                    "reasonCode": "uncoded",
                    "reasonText": reason,
                }
            )
            return
        # a failure outranks everything the case recorded before
        previous = self._outcome.get(test)
        if previous is not None and previous[0] in ("fail",):
            return
        self._outcome[test] = (status, reason)

    def startTest(self, test):
        super().startTest(test)
        self._outcome[test] = None

    def addSuccess(self, test):
        super().addSuccess(test)
        if self._outcome.get(test) is None:
            self._outcome[test] = ("pass", "")

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self._set(test, "skip", reason)

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self._set(test, "fail", str(err[1]))

    def addError(self, test, err):
        super().addError(test, err)
        self._set(test, "fail", str(err[1]))

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self._set(test, "xfail", "")

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self._set(test, "fail", "unexpected success")

    def addSubTest(self, test, subtest, err):
        super().addSubTest(test, subtest, err)
        if err is not None:
            self._set(test, "fail", str(err[1]))

    def stopTest(self, test):
        super().stopTest(test)
        outcome = self._outcome.pop(test, None)
        if isinstance(test, unittest.suite._ErrorHolder):
            return
        identity = self._case_id(test)
        if identity is None:
            identity = ["python", "unresolved", test.id()]
        if outcome is None:
            self._emit(
                {
                    "kind": "case",
                    "id": identity,
                    "status": "fail",
                    "reasonCode": "no-outcome",
                    "reasonText": "the runner recorded no outcome",
                }
            )
            return
        status, reason = outcome
        record = {"kind": "case", "id": identity, "status": status}
        if status in ("skip", "xfail"):
            record["reasonCode"] = "uncoded"
            record["reasonText"] = reason
        elif status == "fail":
            record["reasonText"] = reason
        self._emit(record)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-dir", required=True)
    parser.add_argument("--pattern", default="test*.py")
    args = parser.parse_args()
    target = os.environ["MIXDOG_PY_EVIDENCE"]
    start = os.path.abspath(args.start_dir)
    sys.path.insert(0, start)
    suite = unittest.defaultTestLoader.discover(
        start, pattern=args.pattern, top_level_dir=start
    )
    with open(target, "a", encoding="utf-8") as out:
        runner = unittest.TextTestRunner(
            verbosity=2, resultclass=lambda *a, **k: EvidenceResult(*a, out=out, **k)
        )
        result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)


if __name__ == "__main__":
    main()
