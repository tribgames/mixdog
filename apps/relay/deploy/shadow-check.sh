#!/usr/bin/env bash
# The shadow check of the Node -> binary switch, and the TLS suite probe that the
# switch's first step (the Node listener's suites) and the shadow check share.
#
#   shadow-check.sh run <binary> <domain> <port> [data-dir]
#   shadow-check.sh tls <host> <port> [connect-address]
#
# `run` copies DATA_DIR to a scratch directory WITHOUT feedback/ (so no queued mail
# is sent twice), starts <binary> as the mixdog-relay user with the unit's environment
# except PORT (the shadow port, which ufw must not open), DATA_DIR (the scratch copy)
# and SMTP_USER/SMTP_PASSWORD (unset), and checks:
#   1. the start-up line names the shadow port and the unit's RENDERER_DIR;
#   2. the log carries no failure line;
#   3. the device store the binary loaded is the one Node loads: a device registered
#      through the shadow port makes the binary rewrite its scratch devices.json, and
#      that file must equal what Node's own loader (from the installed Node tree) makes
#      of the original, plus the one new device. That covers the device and client
#      counts and every profile name Node clips (a cut inside an emoji included);
#   4. web push is enabled with the public key of webpush-vapid.json;
#   5. `mixdog-relay verify-release` passes against the shadow port;
#   6. the TLS protocols and suites the shadow port accepts, and the suites a
#      baseline file (TLS_BASELINE, written by `tls` against the Node listener) accepted
#      that it refuses.
# It then stops the binary and removes the scratch directory. The live service, its
# port and its DATA_DIR are never touched. Needs root (setpriv), systemctl, curl,
# openssl, sha256sum. Step 3 needs node and the installed Node tree (NODE_TREE,
# default /opt/mixdog-relay, else /opt/mixdog-relay.handover); without them it is
# reported as NOT CHECKED, not as passed.
#
# Environment: NODE_TREE, TLS_BASELINE, KEEP_SCRATCH=1 (leave the scratch directory
# for inspection; it holds a copy of the live credentials, so remove it afterwards),
# TLS_SUITES (a file of suite names, one per line, to test instead of every suite
# openssl knows). The unit's own environment values are never printed.
set -Eeuo pipefail

UNIT=mixdog-relay
RELAY_USER=mixdog-relay
FAILURES=0
SCRATCH=""
PID=""

pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
fail() {
	printf 'FAIL  %s\n' "$*" >&2
	FAILURES=$((FAILURES + 1))
}
die() {
	printf 'shadow-check: %s\n' "$*" >&2
	exit 2
}

usage() {
	echo "usage: shadow-check.sh run <binary> <domain> <port> [data-dir]" >&2
	echo "       shadow-check.sh tls <host> <port> [connect-address]" >&2
	exit 2
}

# One line per protocol and suite: `<protocol> <suite> ACCEPTED|REFUSED|UNTESTABLE`.
# Diff two outputs (Node listener, shadow port) to see what rustls refuses.
tls_suites() {
	local host="$1" port="$2" address="${3:-$1}" s out proto
	local -a suites=()
	if [[ -n "${TLS_SUITES:-}" ]]; then
		mapfile -t suites <"$TLS_SUITES"
	else
		mapfile -t suites < <(openssl ciphers -tls1_2 'ALL:!aNULL:!eNULL' | tr ':' '\n')
		suites+=(TLS_AES_256_GCM_SHA384 TLS_CHACHA20_POLY1305_SHA256 TLS_AES_128_GCM_SHA256)
	fi
	for proto in tls1 tls1_1; do
		out="$(timeout 15 openssl s_client "-$proto" -connect "$address:$port" -servername "$host" </dev/null 2>&1 || true)"
		if grep -Eq 'Cipher *(is|:) *[A-Za-z0-9_-]+' <<<"$out" && ! grep -Eq 'Cipher *(is|:) *\(?(NONE|0000)' <<<"$out"; then
			printf '%s protocol ACCEPTED\n' "$proto"
		elif grep -Eq 'unknown option|unsupported|no protocols available' <<<"$out"; then
			printf '%s protocol UNTESTABLE\n' "$proto"
		else
			printf '%s protocol REFUSED\n' "$proto"
		fi
	done
	for s in "${suites[@]}"; do
		[[ -n "$s" ]] || continue
		if [[ "$s" == TLS_* ]]; then
			out="$(timeout 15 openssl s_client -tls1_3 -ciphersuites "$s" -connect "$address:$port" -servername "$host" </dev/null 2>&1 || true)"
			proto=tls1_3
		else
			out="$(timeout 15 openssl s_client -tls1_2 -cipher "$s" -connect "$address:$port" -servername "$host" </dev/null 2>&1 || true)"
			proto=tls1_2
		fi
		if grep -Eq "Cipher *(is|:) *$s\$" <<<"$out"; then
			printf '%s %s ACCEPTED\n' "$proto" "$s"
		elif grep -Eq 'no cipher match|Unknown cipher|no ciphers available|Error with command' <<<"$out"; then
			printf '%s %s UNTESTABLE\n' "$proto" "$s"
		else
			printf '%s %s REFUSED\n' "$proto" "$s"
		fi
	done
}

cleanup() {
	local status=$?
	trap - EXIT
	if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
		kill -TERM "$PID" 2>/dev/null || true
		local waited=0
		while kill -0 "$PID" 2>/dev/null && ((waited < 50)); do
			sleep 0.2
			waited=$((waited + 1))
		done
		kill -KILL "$PID" 2>/dev/null || true
	fi
	if [[ -n "$SCRATCH" && -d "$SCRATCH" ]]; then
		if [[ "${KEEP_SCRATCH:-}" = 1 ]]; then
			info "scratch directory kept: $SCRATCH (it holds a copy of the live credentials: remove it)"
		else
			rm -rf -- "$SCRATCH"
		fi
	fi
	exit "$status"
}

# The unit's environment as KEY=VALUE lines: Environment= (drop-ins merged by systemd),
# then every EnvironmentFile (which overrides it, as systemd does).
unit_environment() {
	local line file text key value
	text="$(systemctl show "$UNIT" -p Environment --value)"
	if [[ -n "$text" ]]; then
		printf '%s' "$text" | xargs -r -n1 printf '%s\n'
	fi
	while IFS= read -r line; do
		[[ -n "$line" ]] || continue
		file="${line%% (*}"
		[[ -r "$file" ]] || continue
		while IFS= read -r text || [[ -n "$text" ]]; do
			[[ "$text" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
			key="${BASH_REMATCH[1]}"
			value="${BASH_REMATCH[2]}"
			if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
				value="${BASH_REMATCH[1]}"
			fi
			printf '%s=%s\n' "$key" "$value"
		done <"$file"
	done < <(systemctl show "$UNIT" -p EnvironmentFiles --value)
}

wait_for_line() {
	local pattern="$1" log="$2" waited=0
	while ((waited < 100)); do
		grep -Eq "$pattern" "$log" && return 0
		kill -0 "$PID" 2>/dev/null || return 1
		sleep 0.2
		waited=$((waited + 1))
	done
	return 1
}

# Node's view of the original devices.json against what the binary wrote into the
# scratch copy after one registration. Exit 0 equal, 1 different.
compare_device_store() {
	local original="$1" after="$2" tree="$3" newid="$4"
	node --input-type=module -e '
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
const [original, after, tree, newId] = process.argv.slice(1);
const { loadDeviceStore } = await import(pathToFileURL(`${tree}/lib/device-store-persistence.mjs`).href);
const expected = Object.fromEntries(loadDeviceStore(original));
const wrote = JSON.parse(readFileSync(after, "utf8"));
const added = wrote[newId];
delete wrote[newId];
const count = (rows) => ({ devices: Object.keys(rows).length, clients: Object.values(rows).reduce((n, row) => n + Object.keys(row.clients || {}).length, 0) });
const want = count(expected);
const got = count(wrote);
console.log(`node loads devices=${want.devices} clients=${want.clients}; the binary wrote devices=${got.devices} clients=${got.clients}`);
let bad = 0;
if (!added) { console.log("the registered device is not in the rewritten file"); bad++; }
for (const id of new Set([...Object.keys(expected), ...Object.keys(wrote)])) {
  if (isDeepStrictEqual(expected[id], wrote[id])) continue;
  bad++;
  if (bad <= 10) console.log(`row differs: device ${id.slice(0, 8)}${expected[id] ? "" : " (not in Node)"}${wrote[id] ? "" : " (missing from the binary)"}`);
}
process.exit(bad ? 1 : 0);
' "$original" "$after" "$tree" "$newid"
}

json_public_key() {
	sed -n 's/.*"publicKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

run_shadow() {
	local binary="${1:-}" domain="${2:-}" port="${3:-}" data="${4:-/var/lib/mixdog-relay}"
	[[ -n "$binary" && -n "$domain" && -n "$port" ]] || usage
	[[ "$(id -u)" = 0 ]] || die "run as root (the binary is started as $RELAY_USER)"
	[[ -x "$binary" ]] || die "$binary is not an executable file"
	[[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || die "the domain is not a host name"
	[[ "$port" =~ ^[0-9]+$ ]] || die "the shadow port is not a number"
	((port >= 1024 && port <= 65535 && port != 443)) || die "the shadow port must be 1024-65535 and not 443"
	[[ -d "$data" ]] || die "$data is not a directory"
	id "$RELAY_USER" >/dev/null 2>&1 || die "no user $RELAY_USER"
	command -v setpriv >/dev/null || die "setpriv (util-linux) is required"
	if ss -Hltn "sport = :$port" | grep -q .; then
		die "port $port is already listening"
	fi
	if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -Eq "^$port(/| )"; then
		die "ufw opens port $port: pick a port it does not open (the shadow must be reachable from this host only)"
	fi

	trap cleanup EXIT
	SCRATCH="$(mktemp -d /var/tmp/mixdog-shadow.XXXXXX)"
	chmod 0700 "$SCRATCH"
	mkdir "$SCRATCH/data"
	tar -C "$data" --exclude=./feedback -cf - . | tar -C "$SCRATCH/data" -xpf -
	if [[ -f "$SCRATCH/data/devices.json" ]]; then
		cp -p "$SCRATCH/data/devices.json" "$SCRATCH/devices.original.json"
	else
		: >"$SCRATCH/devices.original.json"
	fi
	chown -R "$RELAY_USER:$RELAY_USER" "$SCRATCH/data"
	info "scratch copy of $data without feedback/: $(find "$SCRATCH/data" -type f | wc -l) files"
	# The relay user may not traverse the directory the candidate was uploaded to (/root is 0700), and the binary reads
	# mobile-release.json beside itself: run a copy from the scratch directory, beside the installed tree's file.
	mkdir -m 0755 "$SCRATCH/bin"
	install -m 0755 "$binary" "$SCRATCH/bin/mixdog-relay"
	if [[ -f /opt/mixdog-relay/mobile-release.json ]]; then
		install -m 0644 /opt/mixdog-relay/mobile-release.json "$SCRATCH/bin/mobile-release.json"
	fi

	local -a envargs=()
	local pair name renderer_dir="" cert="" key=""
	while IFS= read -r pair; do
		name="${pair%%=*}"
		case "$name" in
		PORT | DATA_DIR | SMTP_USER | SMTP_PASSWORD) continue ;;
		RENDERER_DIR) renderer_dir="${pair#*=}" ;;
		TLS_CERT) cert="${pair#*=}" ;;
		TLS_KEY) key="${pair#*=}" ;;
		*) ;;
		esac
		envargs+=("$pair")
	done < <(unit_environment)
	envargs+=("PORT=$port" "DATA_DIR=$SCRATCH/data" "PATH=/usr/sbin:/usr/bin:/sbin:/bin")
	info "environment names passed on: $(printf '%s\n' "${envargs[@]}" | sed 's/=.*//' | sort -u | paste -sd' ' -); PORT and DATA_DIR replaced, SMTP_USER and SMTP_PASSWORD unset"
	local scheme=http
	if [[ -n "$cert" && -n "$key" ]]; then scheme=https; fi
	local origin="$scheme://$domain:$port"
	local log="$SCRATCH/relay.log"
	: >"$log"
	chmod 0644 "$log"
	chmod 0711 "$SCRATCH"

	(
		cd "$SCRATCH/bin"
		exec setpriv --reuid="$RELAY_USER" --regid="$RELAY_USER" --init-groups \
			env -i "${envargs[@]}" "$SCRATCH/bin/mixdog-relay" >"$log" 2>&1
	) &
	PID=$!

	# 1 start-up line
	local escaped line
	escaped="$(printf '%s' "${renderer_dir:-none}" | sed 's/[][\.*^$/+?(){}|]/\\&/g')"
	line="^\\[relay\\] $scheme listening on :$port \\(renderer: $escaped\\)\$"
	if wait_for_line "$line" "$log"; then
		pass "start-up line: $(grep -E "^\\[relay\\] $scheme listening" "$log" | head -n 1)"
	else
		fail "no start-up line within 20 s (the binary exited, or named another port or renderer); log follows"
		head -n 20 "$log" | sed 's/^/      /' >&2
		return 0
	fi

	# 2 no failure line
	local bad
	bad="$(grep -Ein 'failed|cannot read|ignoring malformed|unusable|unreadable|disabled|could not' "$log" || true)"
	if [[ -z "$bad" ]]; then
		pass "the log carries no failure line"
	else
		fail "failure lines in the log:"
		printf '%s\n' "$bad" | sed 's/^/      /' >&2
	fi

	local -a curlbase=(curl -sS --max-time 10 --resolve "$domain:$port:127.0.0.1")

	# 3 the device store
	local tree="${NODE_TREE:-/opt/mixdog-relay}"
	if [[ ! -f "$tree/lib/device-store-persistence.mjs" ]]; then tree=/opt/mixdog-relay.handover; fi
	if [[ ! -s "$SCRATCH/devices.original.json" ]]; then
		info "NOT CHECKED: $data has no devices.json (nothing to load)"
	elif ! command -v node >/dev/null || [[ ! -f "$tree/lib/device-store-persistence.mjs" ]]; then
		info "NOT CHECKED: the device store comparison needs node and the Node tree (set NODE_TREE); the counts and clipped names were not compared"
	else
		local newid secret auth code waited=0 verdict
		newid="$(cat /proc/sys/kernel/random/uuid)"
		secret="$(openssl rand -hex 16)"
		auth="$(printf '%s:%s' "$newid" "$secret" | base64 -w0)"
		code="$("${curlbase[@]}" --http1.1 -o /dev/null -w '%{http_code}' \
			-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
			-H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H "Authorization: Basic $auth" \
			--max-time 4 "$origin/desktop" 2>/dev/null || true)"
		while ! grep -q "$newid" "$SCRATCH/data/devices.json" && ((waited < 50)); do
			sleep 0.2
			waited=$((waited + 1))
		done
		if ! grep -q "$newid" "$SCRATCH/data/devices.json"; then
			fail "the shadow did not persist a newly registered device (desktop upgrade answered ${code:-nothing})"
		elif verdict="$(compare_device_store "$SCRATCH/devices.original.json" "$SCRATCH/data/devices.json" "$tree" "$newid" 2>&1)"; then
			pass "device store equals Node's view of it: $verdict"
		else
			fail "device store differs from Node's view: $verdict"
		fi
	fi

	# 4 web push
	local want got live
	want="$(json_public_key <"$SCRATCH/data/webpush-vapid.json" 2>/dev/null || true)"
	got="$("${curlbase[@]}" "$origin/webpush/key" 2>/dev/null | json_public_key || true)"
	if [[ -z "$want" ]]; then
		info "$data has no webpush-vapid.json: web push key not compared"
	elif [[ "$got" = "$want" ]]; then
		pass "web push is enabled with the public key of webpush-vapid.json"
	else
		fail "web push key differs: shadow serves '${got:-nothing}', webpush-vapid.json holds '$want'"
	fi
	live="$(curl -sS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/webpush/key" 2>/dev/null | json_public_key || true)"
	if [[ -n "$live" ]]; then
		if [[ "$live" = "$got" ]]; then pass "the live relay serves the same web push key"; else fail "the live relay serves another web push key"; fi
	fi

	# 5 verify-release
	local expected_index="" result
	if [[ -n "$renderer_dir" && -f "$renderer_dir/index.html" ]]; then
		expected_index="$(sha256sum "$renderer_dir/index.html" | awk '{print $1}')"
	fi
	if [[ -z "$expected_index" ]]; then
		info "the unit sets no RENDERER_DIR with an index.html: verify-release not run"
	elif result="$("$binary" verify-release "--origin=$origin" "--address=127.0.0.1" "--expected-index=$expected_index" 2>&1)"; then
		pass "verify-release: $result"
	else
		fail "verify-release failed: $result"
	fi

	# 6 TLS suites
	if [[ "$scheme" = https ]]; then
		local suites="$SCRATCH/shadow-tls.txt" lost
		tls_suites "$domain" "$port" 127.0.0.1 >"$suites"
		info "shadow port: $(grep -c ' ACCEPTED$' "$suites") protocols and suites accepted, $(grep -c ' REFUSED$' "$suites") refused"
		if [[ -n "${TLS_BASELINE:-}" && -r "$TLS_BASELINE" ]]; then
			lost="$(comm -23 <(grep ' ACCEPTED$' "$TLS_BASELINE" | sort) <(grep ' ACCEPTED$' "$suites" | sort) || true)"
			if [[ -z "$lost" ]]; then
				pass "the shadow port accepts every protocol and suite the Node listener accepted"
			else
				info "accepted by Node, refused by the shadow port (the owner decides whether that is acceptable):"
				printf '%s\n' "$lost" | sed 's/^/      /'
			fi
		else
			info "no TLS_BASELINE: set it to the output of 'shadow-check.sh tls' against the Node listener to list the suites lost"
		fi
	fi

	if ((FAILURES == 0)); then
		printf '\nshadow check: all checks passed\n'
	else
		printf '\nshadow check: %d check(s) failed\n' "$FAILURES" >&2
	fi
}

case "${1:-}" in
run)
	shift
	run_shadow "$@"
	[[ "$FAILURES" = 0 ]]
	;;
tls)
	shift
	[[ $# -ge 2 ]] || usage
	tls_suites "$@"
	;;
*) usage ;;
esac
