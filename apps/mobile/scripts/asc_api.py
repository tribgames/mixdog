"""App Store Connect API helpers shared by the CI scripts.

Env: ASC_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER.
"""

import json
import os
import pathlib
import time
import urllib.error
import urllib.request

import jwt

API = "https://api.appstoreconnect.apple.com/v1"


def token():
    key = pathlib.Path(os.environ["ASC_KEY_PATH"]).read_text()
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["APPLE_API_ISSUER"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        key,
        algorithm="ES256",
        headers={"kid": os.environ["APPLE_API_KEY_ID"], "typ": "JWT"},
    )


TIMEOUT = 60  # seconds per request


class AscError(SystemExit):
    """Request failure. Exits with the message when uncaught; keeps status
    (None for network errors/timeouts) and Apple's raw error body for callers."""

    def __init__(self, method, path, status, body):
        super().__init__(f"{method} {path} failed: {status} {body}")
        self.status = status
        self.body = body


def call(method, path, body=None, tolerate=()):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read()
    except urllib.error.HTTPError as err:
        if err.code in tolerate:
            return {}
        raise AscError(method, path, err.code, err.read().decode(errors="replace")) from None
    except (urllib.error.URLError, OSError) as err:
        raise AscError(method, path, None, f"{type(err).__name__}: {err}") from None
    return json.loads(raw) if raw else {}
