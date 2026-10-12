#!/usr/bin/env python3
"""App Store signing for CI with one long-lived Apple Distribution certificate.

The certificate and its private key are the .p12 in the repository secrets
IOS_DIST_P12_BASE64 and IOS_DIST_P12_PASSWORD; CI never creates or revokes a
certificate.

`check` reads the .p12 the workflow decoded to $RUNNER_TEMP/dist.p12, warns
when its certificate expires within 30 days and fails once it has expired.

`setup` finds that certificate in App Store Connect by serial number and
installs the App Store profiles bound to it for the app and its Notification
Service Extension: an active profile is reused, stale ones (bound to a replaced
certificate, invalid) are deleted and recreated. No device registration is
needed.

`issue` runs locally, once and again to renew: it creates the certificate from
a fresh key that never touches disk and stores the .p12 and its random password
in the repository secrets through `gh secret set`. Revoke the replaced
certificate only after App Store Connect has processed the last build signed
with it (a revoked signature fails processing with ITMS-90035).

Env: ASC_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER; `check` and `setup` also
RUNNER_TEMP and IOS_DIST_P12_PASSWORD.
"""

import base64
import datetime
import os
import pathlib
import secrets
import subprocess
import sys
import urllib.parse

from asc_api import call
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

PROFILES = {
    "io.mixdog.app": "Mixdog CI App Store",
    "io.mixdog.app.NotificationService": "Mixdog CI NotificationService App Store",
}
REPO = "tribgames/mixdog"
SECRET_P12 = "IOS_DIST_P12_BASE64"
SECRET_PASSWORD = "IOS_DIST_P12_PASSWORD"
WARN_BEFORE = datetime.timedelta(days=30)
RENEW = "renew it with `python3 apps/mobile/scripts/ios-ci-signing.py issue` (apps/mobile/README.md)"


def certificate():
    p12 = pathlib.Path(os.environ["RUNNER_TEMP"], "dist.p12").read_bytes()
    return pkcs12.load_key_and_certificates(p12, os.environ[SECRET_PASSWORD].encode())[1]


def check(now=None):
    expires = certificate().not_valid_after_utc
    left = expires - (now or datetime.datetime.now(datetime.timezone.utc))
    if left <= datetime.timedelta(0):
        print(f"::error title=iOS distribution certificate expired::It expired on {expires:%Y-%m-%d}; {RENEW}.")
        sys.exit(1)
    if left < WARN_BEFORE:
        print(f"::warning title=iOS distribution certificate expires soon::"
              f"It expires on {expires:%Y-%m-%d} ({left.days} days left); {RENEW}.")
    else:
        print(f"Distribution certificate valid until {expires:%Y-%m-%d}.")


def certificate_id(cert):
    found = call("GET", "/certificates?" + urllib.parse.urlencode(
        {"filter[certificateType]": "DISTRIBUTION", "limit": 200}))
    for item in found["data"]:
        if int(item["attributes"]["serialNumber"], 16) == cert.serial_number:
            return item["id"]
    print(f"::error title=iOS distribution certificate not in App Store Connect::"
          f"Serial {cert.serial_number:X} from {SECRET_P12} is not an active Apple Distribution "
          f"certificate (revoked?); {RENEW}.")
    sys.exit(1)


def bundle_id(identifier):
    found = call("GET", "/bundleIds?" + urllib.parse.urlencode({"filter[identifier]": identifier, "limit": 200}))
    for item in found["data"]:
        if item["attributes"]["identifier"] == identifier:
            return item["id"]
    created = call("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {
        "identifier": identifier, "name": identifier.replace(".", " "), "platform": "IOS"}}})
    return created["data"]["id"]


def profile(identifier, name, cert_id):
    found = call("GET", "/profiles?" + urllib.parse.urlencode(
        {"filter[name]": name, "include": "certificates", "limit": 200}))
    named = [item for item in found["data"] if item["attributes"]["name"] == name]
    for item in named:
        bound = {cert["id"] for cert in item["relationships"]["certificates"]["data"]}
        if item["attributes"]["profileState"] == "ACTIVE" and cert_id in bound:
            return item
    for item in named:
        call("DELETE", f"/profiles/{item['id']}")
    return call("POST", "/profiles", {"data": {
        "type": "profiles",
        "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
        "relationships": {
            "bundleId": {"data": {"type": "bundleIds", "id": bundle_id(identifier)}},
            "certificates": {"data": [{"type": "certificates", "id": cert_id}]},
        }}})["data"]


def setup():
    cert = certificate()
    cert_id = certificate_id(cert)
    print(f"Distribution certificate {cert_id}, valid until {cert.not_valid_after_utc:%Y-%m-%d}.")
    dirs = [pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles",
            pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    for identifier, name in PROFILES.items():
        item = profile(identifier, name, cert_id)
        content = base64.b64decode(item["attributes"]["profileContent"])
        for d in dirs:
            (d / f"{item['attributes']['uuid']}.mobileprovision").write_bytes(content)


def issue():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Mixdog CI")]))
           .sign(key, hashes.SHA256()))
    cert = call("POST", "/certificates", {"data": {"type": "certificates", "attributes": {
        "certificateType": "DISTRIBUTION",
        "csrContent": csr.public_bytes(serialization.Encoding.PEM).decode()}}})["data"]
    print(f"Created Apple Distribution certificate {cert['id']}, "
          f"valid until {cert['attributes']['expirationDate']}.")

    password = secrets.token_urlsafe(32)
    der = base64.b64decode(cert["attributes"]["certificateContent"])
    # The legacy PKCS#12 algorithms: macOS `security import` rejects the modern ones.
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder()
                  .kdf_rounds(50000)
                  .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                  .hmac_hash(hashes.SHA1())
                  .build(password.encode()))
    p12 = pkcs12.serialize_key_and_certificates(
        b"Mixdog CI", key, x509.load_der_x509_certificate(der), None, encryption)
    for name, value in ((SECRET_P12, base64.b64encode(p12).decode()), (SECRET_PASSWORD, password)):
        subprocess.run(["gh", "secret", "set", name, "--repo", REPO], input=value.encode(), check=True)


if __name__ == "__main__":
    {"check": check, "setup": setup, "issue": issue}[sys.argv[1]]()
