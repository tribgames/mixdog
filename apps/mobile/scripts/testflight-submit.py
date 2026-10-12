#!/usr/bin/env python3
"""Submit the just-uploaded TestFlight build to external testing.

Waits for the build (version + build number) to finish processing, sets the
"What to Test" text per locale, adds the build to the external beta group and
submits it for beta app review. Idempotent: reruns update/skip what exists.

Usage: testflight-submit.py <version> <build-number>
Env: ASC_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER,
     TESTFLIGHT_EXTERNAL_GROUP_ID (optional).
"""

import json
import os
import pathlib
import sys
import time
import urllib.parse

import asc_api

APP_ID = "6821430566"
DEFAULT_GROUP = "ef50f70b-0be0-484c-80f0-a5c178e63bef"
LOCALES = {"en-US": "what-to-test.en-US.txt", "ko": "what-to-test.ko.txt"}
TEXT_DIR = pathlib.Path(__file__).resolve().parent.parent / "testflight"
TIMEOUT = 45 * 60
POLL = 30


def find_build(version, number):
    query = urllib.parse.urlencode({
        "filter[app]": APP_ID,
        "filter[preReleaseVersion.version]": version,
        "filter[version]": number,
        "limit": 1,
    })
    data = asc_api.call("GET", "/builds?" + query).get("data", [])
    return data[0] if data else None


def wait_valid(version, number, sleep=None, clock=time.monotonic):
    sleep = sleep or time.sleep
    deadline = clock() + TIMEOUT
    while True:
        build = find_build(version, number)
        state = build["attributes"]["processingState"] if build else "NOT_FOUND_YET"
        print(f"Build {version} ({number}): {state}", flush=True)
        if state == "VALID":
            return build["id"]
        if state in ("INVALID", "FAILED"):
            sys.exit(f"Build processing {state}: {json.dumps(build['attributes'])}")
        if clock() >= deadline:
            sys.exit(f"Timed out waiting for build {version} ({number}); last state {state}")
        sleep(POLL)


def set_whats_new(build_id):
    existing = asc_api.call("GET", f"/builds/{build_id}/betaBuildLocalizations?limit=200").get("data", [])
    by_locale = {item["attributes"]["locale"]: item["id"] for item in existing}
    for locale, filename in LOCALES.items():
        text = (TEXT_DIR / filename).read_text(encoding="utf-8").strip()
        if locale in by_locale:
            asc_api.call("PATCH", f"/betaBuildLocalizations/{by_locale[locale]}", {"data": {
                "type": "betaBuildLocalizations", "id": by_locale[locale],
                "attributes": {"whatsNew": text}}})
        else:
            asc_api.call("POST", "/betaBuildLocalizations", {"data": {
                "type": "betaBuildLocalizations",
                "attributes": {"locale": locale, "whatsNew": text},
                "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}})
        print(f"What to Test set for {locale}")


def add_to_group(build_id, group_id):
    groups = asc_api.call("GET", f"/builds/{build_id}/betaGroups?limit=200").get("data", [])
    if any(group["id"] == group_id for group in groups):
        print(f"Build already in group {group_id}")
        return
    asc_api.call("POST", f"/betaGroups/{group_id}/relationships/builds",
                 {"data": [{"type": "builds", "id": build_id}]})
    print(f"Added build to group {group_id}")


ACCEPTED_REVIEW_STATES = ("WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED")


def submit_review(build_id):
    try:
        asc_api.call("POST", "/betaAppReviewSubmissions", {"data": {
            "type": "betaAppReviewSubmissions",
            "relationships": {"build": {"data": {"type": "builds", "id": build_id}}}}})
    except asc_api.AscError as err:
        # Success only if a submission for this exact build exists (409,
        # or a POST whose response was lost); otherwise report Apple's error.
        try:
            existing = asc_api.call("GET", f"/builds/{build_id}/betaAppReviewSubmission").get("data")
        except asc_api.AscError as lookup:
            sys.exit(f"{err}\nLookup of existing submission failed: {lookup}")
        if not existing:
            sys.exit(str(err))
        state = existing.get("attributes", {}).get("betaReviewState")
        if state not in ACCEPTED_REVIEW_STATES:
            sys.exit(f"{err}\nExisting beta review submission state: {state or 'UNKNOWN'}")
        print(f"Beta app review already submitted for build {build_id}: {state}")
        return
    print("Submitted for beta app review")


def main(version, number):
    group_id = os.environ.get("TESTFLIGHT_EXTERNAL_GROUP_ID") or DEFAULT_GROUP
    build_id = wait_valid(version, number)
    set_whats_new(build_id)
    add_to_group(build_id, group_id)
    submit_review(build_id)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
