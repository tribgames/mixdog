#!/usr/bin/env python3
"""Short-lived App Store signing for CI.

`setup` creates an Apple Distribution certificate and App Store profiles for
the app and its Notification Service Extension through the App Store Connect
API, writes the certificate as a .p12 and installs the profiles. `cleanup`
deletes the profiles and revokes the certificate, so no signing identity
outlives the run and no device registration is needed.

Env: ASC_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER, RUNNER_TEMP.
"""

import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

API = "https://api.appstoreconnect.apple.com/v1"
PROFILES = {
    "io.mixdog.app": "Mixdog CI App Store",
    "io.mixdog.app.NotificationService": "Mixdog CI NotificationService App Store",
}
TEMP = pathlib.Path(os.environ["RUNNER_TEMP"])
STATE = TEMP / "ios-signing-state.json"


def token():
    key = pathlib.Path(os.environ["ASC_KEY_PATH"]).read_text()
    now = int(time.time())
    return jwt.encode(
        {"iss": os.environ["APPLE_API_ISSUER"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"},
        key,
        algorithm="ES256",
        headers={"kid": os.environ["APPLE_API_KEY_ID"], "typ": "JWT"},
    )


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as res:
            raw = res.read()
    except urllib.error.HTTPError as err:
        sys.exit(f"{method} {path} failed: {err.code} {err.read().decode(errors='replace')}")
    return json.loads(raw) if raw else {}


def bundle_id(identifier):
    found = call("GET", "/bundleIds?" + urllib.parse.urlencode({"filter[identifier]": identifier, "limit": 200}))
    for item in found["data"]:
        if item["attributes"]["identifier"] == identifier:
            return item["id"]
    created = call("POST", "/bundleIds", {"data": {"type": "bundleIds", "attributes": {
        "identifier": identifier, "name": identifier.replace(".", " "), "platform": "IOS"}}})
    return created["data"]["id"]


def delete_profiles_named(name):
    found = call("GET", "/profiles?" + urllib.parse.urlencode({"filter[name]": name, "limit": 200}))
    for item in found["data"]:
        call("DELETE", f"/profiles/{item['id']}")


def setup():
    password = base64.urlsafe_b64encode(os.urandom(18)).decode()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    csr = (x509.CertificateSigningRequestBuilder()
           .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Mixdog CI")]))
           .sign(key, hashes.SHA256()))
    cert = call("POST", "/certificates", {"data": {"type": "certificates", "attributes": {
        "certificateType": "DISTRIBUTION",
        "csrContent": csr.public_bytes(serialization.Encoding.PEM).decode()}}})["data"]
    state = {"certificate": cert["id"], "profiles": []}
    STATE.write_text(json.dumps(state))

    der = base64.b64decode(cert["attributes"]["certificateContent"])
    encryption = (serialization.PrivateFormat.PKCS12.encryption_builder()
                  .kdf_rounds(50000)
                  .key_cert_algorithm(pkcs12.PBES.PBESv1SHA1And3KeyTripleDESCBC)
                  .hmac_hash(hashes.SHA1())
                  .build(password.encode()))
    p12 = pkcs12.serialize_key_and_certificates(
        b"Mixdog CI", key, x509.load_der_x509_certificate(der), None, encryption)
    (TEMP / "dist.p12").write_bytes(p12)

    dirs = [pathlib.Path.home() / "Library/MobileDevice/Provisioning Profiles",
            pathlib.Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)
    for identifier, name in PROFILES.items():
        delete_profiles_named(name)
        profile = call("POST", "/profiles", {"data": {
            "type": "profiles",
            "attributes": {"name": name, "profileType": "IOS_APP_STORE"},
            "relationships": {
                "bundleId": {"data": {"type": "bundleIds", "id": bundle_id(identifier)}},
                "certificates": {"data": [{"type": "certificates", "id": cert["id"]}]},
            }}})["data"]
        state["profiles"].append(profile["id"])
        STATE.write_text(json.dumps(state))
        content = base64.b64decode(profile["attributes"]["profileContent"])
        for d in dirs:
            (d / f"{profile['attributes']['uuid']}.mobileprovision").write_bytes(content)

    with open(os.environ["GITHUB_ENV"], "a") as env:
        env.write(f"DIST_P12_PATH={TEMP / 'dist.p12'}\nDIST_P12_PASSWORD={password}\n")
    print(f"::add-mask::{password}")


def cleanup():
    if not STATE.exists():
        return
    state = json.loads(STATE.read_text())
    for profile in state["profiles"]:
        call("DELETE", f"/profiles/{profile}")
    call("DELETE", f"/certificates/{state['certificate']}")
    STATE.unlink()


if __name__ == "__main__":
    {"setup": setup, "cleanup": cleanup}[sys.argv[1]]()
