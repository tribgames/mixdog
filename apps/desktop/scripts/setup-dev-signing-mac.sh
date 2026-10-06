#!/bin/bash
# One-time setup: a persistent self-signed code-signing identity for local
# macOS dev builds.
#
# macOS keys privacy grants (Files and Folders, Accessibility, keychain items)
# to an app's code-signing identity. An ad-hoc build has none, so every rebuild
# is a new app to macOS and every grant is asked again. dev-update-mac.sh signs
# each build with this one certificate when it exists, which keeps the identity
# stable across rebuilds. It is not a Developer ID: other Macs still reject it,
# so it serves this machine only.
#
# Trusting the certificate for code signing asks for the macOS password once.
# Re-running is safe: an existing valid identity is left alone.
set -euo pipefail

identity="${MIXDOG_DEV_SIGN_IDENTITY:-Mixdog Local Dev}"
keychain="$HOME/Library/Keychains/login.keychain-db"

identity_valid() {
	security find-identity -v -p codesigning "$keychain" | grep -qF "\"$identity\""
}

if identity_valid; then
	echo "code-signing identity ready: $identity"
	exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if security find-certificate -c "$identity" "$keychain" >/dev/null 2>&1; then
	# A previous run imported the certificate but stopped before trusting it.
	security find-certificate -c "$identity" -p "$keychain" >"$work/cert.pem"
else
	cat >"$work/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $identity
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
	# /usr/bin/openssl (LibreSSL) writes a PKCS#12 that `security import` reads.
	/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
		-keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
	pass="$(/usr/bin/openssl rand -hex 16)"
	/usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$identity" \
		-passout "pass:$pass" -out "$work/identity.p12"
	# -T lets codesign use the private key without a keychain access prompt.
	security import "$work/identity.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign >/dev/null
fi

echo "trusting '$identity' for code signing (macOS asks for your password)"
security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$work/cert.pem"

identity_valid || {
	echo "'$identity' is still not a valid code-signing identity" >&2
	exit 1
}
echo "code-signing identity ready: $identity"
echo "The first signed build asks for keychain access to this key: enter the login password and choose"
echo "'Always Allow'. 'Allow' covers one file only, and a build signs hundreds."
