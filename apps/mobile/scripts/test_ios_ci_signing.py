"""Run: python -m unittest apps/mobile/scripts/test_ios_ci_signing.py"""

import base64
import datetime
import importlib.util
import os
import pathlib
import sys
import tempfile
import types
import unittest
import urllib.parse
from unittest import mock

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.modules.setdefault("jwt", types.ModuleType("jwt"))  # auth is faked below
spec = importlib.util.spec_from_file_location("ics", HERE / "ios-ci-signing.py")
ics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ics)

NOW = datetime.datetime(2026, 10, 12, tzinfo=datetime.timezone.utc)
APPLE_CA = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
SERIAL = 0x0A1B2C3D4E5F
APP, EXT = ics.PROFILES["io.mixdog.app"], ics.PROFILES["io.mixdog.app.NotificationService"]


def signed(public_key, expires, serial=SERIAL):
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Apple Distribution: Test")])
    return (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(public_key).serial_number(serial)
            .not_valid_before(NOW - datetime.timedelta(days=300)).not_valid_after(expires)
            .sign(APPLE_CA, hashes.SHA256()))


def query(path):
    return {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlsplit(path).query).items()}


def profile(pid, name, state, cert_ids):
    return {"id": pid,
            "attributes": {"name": name, "profileState": state, "uuid": f"uuid-{pid}",
                           "profileContent": base64.b64encode(f"content-{pid}".encode()).decode()},
            "relationships": {"certificates": {"data": [{"type": "certificates", "id": c} for c in cert_ids]}}}


class Fake:
    def __init__(self, certificates=(), profiles=None):
        self.certificates, self.profiles = list(certificates), profiles or {}
        self.calls = []

    def __call__(self, method, path, body=None, tolerate=()):
        self.calls.append((method, path, body))
        if method == "GET" and path.startswith("/certificates?"):
            return {"data": self.certificates}
        if method == "GET" and path.startswith("/profiles?"):
            return {"data": self.profiles.get(query(path)["filter[name]"], [])}
        if method == "GET" and path.startswith("/bundleIds?"):
            identifier = query(path)["filter[identifier]"]
            return {"data": [{"id": f"B-{identifier}", "attributes": {"identifier": identifier}}]}
        if method == "POST" and path == "/profiles":
            attrs, rel = body["data"]["attributes"], body["data"]["relationships"]
            return {"data": profile("NEW", attrs["name"], "ACTIVE",
                                    [c["id"] for c in rel["certificates"]["data"]])}
        if method == "POST" and path == "/certificates":
            csr = x509.load_pem_x509_csr(body["data"]["attributes"]["csrContent"].encode())
            cert = signed(csr.public_key(), NOW + datetime.timedelta(days=365), serial=77)
            return {"data": {"id": "CNEW", "attributes": {
                "expirationDate": "2027-10-12T00:00:00.000+00:00",
                "certificateContent": base64.b64encode(cert.public_bytes(serialization.Encoding.DER)).decode()}}}
        return {}


class Tests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = pathlib.Path(tmp.name)
        env = mock.patch.dict(os.environ, {"RUNNER_TEMP": str(self.tmp), "IOS_DIST_P12_PASSWORD": "pw"})
        env.start()
        self.addCleanup(env.stop)

    def write_p12(self, expires):
        cert = signed(KEY.public_key(), expires)
        (self.tmp / "dist.p12").write_bytes(pkcs12.serialize_key_and_certificates(
            b"t", KEY, cert, None, serialization.BestAvailableEncryption(b"pw")))

    def run_check(self, days_left):
        self.write_p12(NOW + datetime.timedelta(days=days_left))
        with mock.patch("builtins.print") as out:
            ics.check(now=NOW)
        return " ".join(str(c) for c in out.call_args_list)

    def test_check_passes_a_valid_certificate(self):
        printed = self.run_check(200)
        self.assertNotIn("::warning", printed)
        self.assertNotIn("::error", printed)

    def test_check_warns_within_30_days(self):
        printed = self.run_check(10)
        self.assertIn("::warning", printed)
        self.assertIn("2026-10-22", printed)
        self.assertIn("ios-ci-signing.py issue", printed)

    def test_check_fails_an_expired_certificate(self):
        with self.assertRaises(SystemExit) as ctx:
            self.run_check(-1)
        self.assertEqual(ctx.exception.code, 1)

    def run_setup(self, fake):
        with mock.patch.object(ics, "call", fake), mock.patch.object(ics.pathlib.Path, "home", return_value=self.tmp), \
                mock.patch("builtins.print"):
            ics.setup()

    def test_setup_reuses_active_profile_and_recreates_stale_one(self):
        self.write_p12(NOW + datetime.timedelta(days=200))
        fake = Fake(
            certificates=[{"id": "COTHER", "attributes": {"serialNumber": "1F"}},
                          {"id": "C1", "attributes": {"serialNumber": f"00{SERIAL:x}"}}],
            profiles={APP: [profile("PAPP", APP, "ACTIVE", ["C1"])],
                      EXT: [profile("POLD", EXT, "ACTIVE", ["CREVOKED"]),
                            profile("PINV", EXT, "INVALID", ["C1"]),
                            profile("PFOREIGN", EXT + " (manual)", "ACTIVE", ["C1"])]})
        self.run_setup(fake)
        calls = [(m, p) for m, p, _ in fake.calls]
        self.assertEqual([p for m, p in calls if m == "DELETE"], ["/profiles/POLD", "/profiles/PINV"])
        self.assertFalse([p for m, p in calls if p.startswith("/certificates") and m != "GET"])
        created = [b["data"] for m, p, b in fake.calls if (m, p) == ("POST", "/profiles")]
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0]["attributes"], {"name": EXT, "profileType": "IOS_APP_STORE"})
        self.assertEqual(created[0]["relationships"]["certificates"]["data"], [{"type": "certificates", "id": "C1"}])
        self.assertEqual(created[0]["relationships"]["bundleId"]["data"]["id"], "B-io.mixdog.app.NotificationService")
        for d in ("Library/MobileDevice/Provisioning Profiles",
                  "Library/Developer/Xcode/UserData/Provisioning Profiles"):
            self.assertEqual((self.tmp / d / "uuid-PAPP.mobileprovision").read_bytes(), b"content-PAPP")
            self.assertEqual((self.tmp / d / "uuid-NEW.mobileprovision").read_bytes(), b"content-NEW")

    def test_setup_fails_when_the_certificate_is_not_in_app_store_connect(self):
        self.write_p12(NOW + datetime.timedelta(days=200))
        fake = Fake(certificates=[{"id": "COTHER", "attributes": {"serialNumber": "1F"}}])
        with mock.patch.object(ics, "call", fake), mock.patch("builtins.print") as out, \
                self.assertRaises(SystemExit) as ctx:
            ics.setup()
        self.assertEqual(ctx.exception.code, 1)
        self.assertIn(f"{SERIAL:X}", str(out.call_args_list))
        self.assertFalse([c for c in fake.calls if c[0] != "GET"])

    def test_issue_stores_the_p12_and_its_password_as_secrets(self):
        fake = Fake()
        with mock.patch.object(ics, "call", fake), mock.patch.object(ics.subprocess, "run") as run, \
                mock.patch("builtins.print") as out:
            ics.issue()
        self.assertEqual(fake.calls[0][2]["data"]["attributes"]["certificateType"], "DISTRIBUTION")
        self.assertIn("CNEW", str(out.call_args_list))
        stored = {c.args[0][3]: c.kwargs["input"].decode() for c in run.call_args_list}
        for c in run.call_args_list:
            self.assertEqual(c.args[0][:3] + c.args[0][4:], ["gh", "secret", "set", "--repo", "tribgames/mixdog"])
            self.assertTrue(c.kwargs["check"])
        self.assertEqual(sorted(stored), ["IOS_DIST_P12_BASE64", "IOS_DIST_P12_PASSWORD"])
        self.assertGreaterEqual(len(stored["IOS_DIST_P12_PASSWORD"]), 32)
        self.assertNotIn(stored["IOS_DIST_P12_PASSWORD"], str(out.call_args_list))
        key, cert, _ = pkcs12.load_key_and_certificates(
            base64.b64decode(stored["IOS_DIST_P12_BASE64"]), stored["IOS_DIST_P12_PASSWORD"].encode())
        self.assertEqual(cert.serial_number, 77)
        self.assertEqual(key.public_key().public_numbers(), cert.public_key().public_numbers())


if __name__ == "__main__":
    unittest.main()
