#!/usr/bin/env bash
# Checks a provisioned coturn ON the VPS (as root):
#   bash /opt/mixdog-relay/deploy/coturn/verify-turn.sh <public-ipv4>
# Reads the secret only inside node; the credentials it hands the test client
# are short-lived ones minted for this run, not the secret.
set -Eeuo pipefail

PUBLIC_IP="${1:?usage: verify-turn.sh <public-ipv4>}"
DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONF=/etc/mixdog-coturn/turnserver.conf
ENV_FILE=/etc/mixdog-relay/turn.env
# turnutils_uclient has no deadline of its own for a peer that never answers.
# The bound is the one RFC 8489 §6.2.1 gives a UDP STUN transaction: failed
# 39500 ms after its first request.
UCLIENT_DEADLINE_S=39.5
fail() {
	echo "[verify-turn] FAIL: $1" >&2
	exit 1
}
ok() { echo "[verify-turn] ok: $1"; }
conf_value() { sed -n "s/^$1=//p" "$CONF"; }

systemctl is-active --quiet mixdog-coturn || fail "mixdog-coturn is not active"
systemctl is-active --quiet mixdog-coturn-egress || fail "mixdog-coturn-egress (the relay-range policy) is not active"
! systemctl is-active --quiet coturn.service || fail "the package's coturn.service is running (stock config, anonymous relaying)"
ok "mixdog-coturn and its egress policy active, package unit not running"

[[ "$(stat -c '%a %U:%G' "$ENV_FILE")" = "600 root:root" ]] || fail "$ENV_FILE must be 0600 root:root"
[[ "$(stat -c '%a %U:%G' "$CONF")" = "640 root:turnserver" ]] || fail "$CONF must be 0640 root:turnserver"
[[ "$(stat -c '%a' /etc/mixdog-coturn/tls/privkey.pem)" = "640" ]] || fail "TLS key must be 0640"
ok "secret-bearing files are root-owned and not world-readable"

for key in use-auth-secret no-tcp-relay no-cli no-multicast-peers fingerprint; do
	grep -qx "$key" "$CONF" || fail "$CONF lacks '$key'"
done
grep -q '^static-auth-secret=.\{20,\}' "$CONF" || fail "$CONF has no usable static-auth-secret"
grep -q "^external-ip=$PUBLIC_IP\$" "$CONF" || fail "external-ip is not $PUBLIC_IP"
# Every denied peer range of the template must be in the rendered config.
diff <(grep '^denied-peer-ip=' "$DEPLOY_DIR/coturn/turnserver.conf.template" | sort) \
	<(grep '^denied-peer-ip=' "$CONF" | sort) >/dev/null || fail "denied-peer-ip ranges differ from the template"
ok "config enforces secret auth, UDP-only relaying, denied private/loopback/link-local peers, public address"

MIN_PORT="$(conf_value min-port)"
MAX_PORT="$(conf_value max-port)"
TURN_PORT="$(conf_value listening-port)"
TLS_PORT="$(conf_value tls-listening-port)"
LISTEN="$(ss -H -lunt)"
grep -q "udp.*:$TURN_PORT " <<<"$LISTEN" || fail "nothing listens on udp/$TURN_PORT"
grep -q "tcp.*:$TURN_PORT " <<<"$LISTEN" || fail "nothing listens on tcp/$TURN_PORT"
grep -q "tcp.*:$TLS_PORT " <<<"$LISTEN" || fail "nothing listens on tcp/$TLS_PORT"
ok "listening on udp/$TURN_PORT, tcp/$TURN_PORT, tcp/$TLS_PORT"

# The egress policy: this host's own addresses are reachable by the coturn
# account only on the relay range, and nothing else listens inside that range.
RULES="$(nft list table inet mixdog_coturn)"
grep -q "meta skuid != $(id -u turnserver) accept" <<<"$RULES" || fail "the egress policy does not name the turnserver account"
grep -q "ip daddr $PUBLIC_IP udp dport $MIN_PORT-$MAX_PORT accept" <<<"$RULES" || fail "the egress policy lacks the relay-range allowance for the public address"
grep -q "ip daddr $PUBLIC_IP .*drop" <<<"$RULES" || fail "the egress policy lacks the public-address drop"
grep -q "fib daddr type local udp dport $MIN_PORT-$MAX_PORT accept" <<<"$RULES" || fail "the egress policy lacks the relay-range allowance"
grep -q 'fib daddr type local.* drop' <<<"$RULES" || fail "the egress policy lacks the local-destination drop"
# Containment: other services may reserve ports too; this range must be in the set.
node "$DEPLOY_DIR/coturn/reserved-ports.mjs" covers "$MIN_PORT" "$MAX_PORT" >/dev/null || fail "the relay range is not reserved from ephemeral ports"
# Is the public address a local one, or mapped to this host by the provider?
if [[ -n "$(ip -4 -o addr show to "$PUBLIC_IP")" ]]; then
	SINK_ADDRESS="$PUBLIC_IP"
	ok "public address $PUBLIC_IP is on a local interface"
else
	SINK_ADDRESS=0.0.0.0
	ok "public address $PUBLIC_IP is NAT-mapped (not local): peers are reached through the provider's NAT, which must hairpin"
fi
FOREIGN="$(ss -H -lunp | awk -v lo="$MIN_PORT" -v hi="$MAX_PORT" '{ n = split($4, part, ":"); port = part[n] + 0; if (port >= lo && port <= hi && $0 !~ /turnserver/) print }')"
[[ -z "$FOREIGN" ]] || fail "another UDP service listens inside the relay range: $FOREIGN"
ok "egress policy loaded; relay range reserved; no other UDP listener inside it"

echo "[verify-turn] STUN binding via the public address: $(node "$DEPLOY_DIR/coturn/stun-probe.mjs" "$PUBLIC_IP" "$TURN_PORT")"

mint() { # <offset ms from now> <user id>: prints "username credential"; a past offset yields an expired one
	(
		set -a
		. "$ENV_FILE"
		set +a
		OFFSET_MS="$1" USER_ID="$2" node --input-type=module -e '
import { issueTurnCredential } from "'"$DEPLOY_DIR"'/../lib/turn-credentials.mjs";
const c = issueTurnCredential({ secret: process.env.TURN_AUTH_SECRET, userId: process.env.USER_ID, nowMs: Date.now() + Number(process.env.OFFSET_MS) });
console.log(c.username, c.credential);'
	)
}
if ! command -v turnutils_uclient >/dev/null; then
	echo "[verify-turn] turnutils_uclient not installed (apt-get install coturn ships it): skipping the allocation checks" >&2
	exit 0
fi

WORK="$(mktemp -d)"
SINK_PID=""
trap 'rm -rf "$WORK"; if [[ -n "$SINK_PID" ]]; then kill "$SINK_PID" 2>/dev/null || true; fi' EXIT
# A fresh user id per run, so no run is refused by another's allocation quota.
run_uclient() { # <user id> <offset ms> <turnutils_uclient args...>; returns its status
	local credential user pass
	credential="$(mint "$2" "$1")"
	read -r user pass <<<"$credential"
	shift 2
	timeout --foreground "$UCLIENT_DEADLINE_S" turnutils_uclient -u "$user" -w "$pass" -c -n 5 -p "$TURN_PORT" "$@" "$PUBLIC_IP"
}
sink_start() { # <name> <address> <port>
	node "$DEPLOY_DIR/coturn/udp-sink.mjs" "$2" "$3" >"$WORK/$1" &
	SINK_PID=$!
	until grep -q '^ready' "$WORK/$1"; do
		kill -0 "$SINK_PID" || fail "the UDP sink on $2:$3 did not start"
		sleep 0.1
	done
}
sink_stop() { # <name>: stops the sink; RECEIVED is how many datagrams it got
	kill -TERM "$SINK_PID"
	wait "$SINK_PID"
	SINK_PID=""
	RECEIVED="$(sed -n 's/^received=//p' "$WORK/$1")"
}
dropped_packets() { # packets the egress policy's drop rules have counted so far
	nft list table inet mixdog_coturn | awk '$NF == "drop" { for (i = 1; i < NF; i++) if ($i == "packets") total += $(i + 1) } END { print total + 0 }'
}

# -y relays each client's media to the other client's relay address: the same
# path a TURN-relayed phone and PC take, through this host's own public address.
run_uclient verify-good 0 -y >"$WORK/good" 2>&1 || fail "an allocation with a fresh credential failed: $(tail -n 5 "$WORK/good")"
ok "fresh credential: relayed client-to-client exchange succeeded"
# 25 hours back puts the expiry one hour in the past for a 24-hour credential.
status=0
run_uclient verify-expired -90000000 -y >"$WORK/old" 2>&1 || status=$?
if [[ "$status" -eq 0 || "$status" -eq 124 ]]; then
	fail "an expired credential was not refused (status $status): $(tail -n 5 "$WORK/old")"
fi
ok "expired credential refused"

# Where a relayed packet may land on this host. The first sink is the control:
# the relay range must deliver, or the two refusals below prove nothing. The
# clients' own exit status is not used here (it says nothing about delivery);
# what the sink received is the evidence.
# The peer is always addressed by the public address (what a relayed endpoint is
# told); the sink listens on it when it is local, on every address when the
# provider maps it.
sink_start in-range "$SINK_ADDRESS" "$MIN_PORT"
run_uclient verify-range 0 -e "$PUBLIC_IP" -r "$MIN_PORT" >"$WORK/range" 2>&1 || true
sink_stop in-range
[[ "$RECEIVED" -ge 1 ]] || fail "a peer on the relay range of this host's public address was not reached; the refusals below would prove nothing: $(tail -n 5 "$WORK/range")"
ok "peer on this host's public address, inside the relay range: delivered"
DROPPED_BEFORE="$(dropped_packets)"
sink_start out-of-range "$SINK_ADDRESS" "$((MIN_PORT - 1))"
run_uclient verify-local 0 -e "$PUBLIC_IP" -r "$((MIN_PORT - 1))" >"$WORK/local" 2>&1 || true
sink_stop out-of-range
[[ "$RECEIVED" -eq 0 ]] || fail "a relayed packet reached a UDP port outside the relay range on this host's public address"
# Not delivered is not enough on its own (a NAT that does not hairpin delivers
# nothing either): the policy's own drop counter has to have moved.
[[ "$(dropped_packets)" -gt "$DROPPED_BEFORE" ]] || fail "nothing was delivered, but the egress policy did not count a drop either: something other than the policy stopped it"
ok "peer on this host's public address outside the relay range: not delivered, and the egress policy dropped it"
sink_start loopback 127.0.0.1 "$MIN_PORT"
run_uclient verify-loopback 0 -e 127.0.0.1 -r "$MIN_PORT" >"$WORK/loopback" 2>&1 || true
sink_stop loopback
[[ "$RECEIVED" -eq 0 ]] || fail "a relayed packet reached the loopback interface"
ok "loopback peer: not delivered"
