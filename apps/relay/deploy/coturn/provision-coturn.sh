#!/usr/bin/env bash
# Provisions the STUN/TURN server (coturn) beside the relay. Run ON the VPS as
# root (Ubuntu 22.04+, nftables installed), from a copy of this directory:
#   bash provision-coturn.sh <relay-domain> <public-ipv4> \
#        --user-quota=<N> --issue-limit=<N>
# The two numbers are deploy-time decisions with no built-in value; deploy/README.md
# says what they mean and how to size them.
#
# Does: removes any running stock coturn and masks its unit, installs coturn,
# generates the shared secret on this host, renders the coturn config and the
# egress policy from their templates, installs the mixdog-coturn units, copies
# the relay's certificate for the TLS listener (+ a renewal hook), opens the
# firewall when ufw is active, reserves the relay port range from ephemeral
# allocation, and gives the relay unit a drop-in that reads the secret.
#
# Idempotent: a second run keeps the existing secret. To rotate it, run
# deprovision-coturn.sh first, then this, then restart mixdog-relay.
# It never restarts the relay: run it before a relay deploy (which restarts the
# relay once) or restart mixdog-relay yourself afterwards.
set -Eeuo pipefail

usage() {
	echo "usage: provision-coturn.sh <relay-domain> <public-ipv4> --user-quota=<N> --issue-limit=<N>" >&2
	exit 2
}
POSITIONAL=()
USER_QUOTA=""
ISSUE_LIMIT=""
for arg in "$@"; do
	case "$arg" in
	--user-quota=*) USER_QUOTA="${arg#*=}" ;;
	--issue-limit=*) ISSUE_LIMIT="${arg#*=}" ;;
	-*) usage ;;
	*) POSITIONAL+=("$arg") ;;
	esac
done
[[ ${#POSITIONAL[@]} -eq 2 ]] || usage
DOMAIN="${POSITIONAL[0]}"
PUBLIC_IP="${POSITIONAL[1]}"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]
[[ "$PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]
for octet in ${PUBLIC_IP//./ }; do ((10#$octet <= 255)); done
# 0 is coturn's own "no quota"; the issue limit has no such value.
[[ "$USER_QUOTA" =~ ^[0-9]+$ ]] || usage
[[ "$ISSUE_LIMIT" =~ ^[1-9][0-9]*$ ]] || usage
[[ "$(id -u)" = 0 ]]
command -v nft >/dev/null || {
	echo "[coturn] nft is not installed. Install the nftables package (check that nftables.service is not enabled with a config that flushes the ruleset) and rerun." >&2
	exit 1
}
command -v node >/dev/null || {
	echo "[coturn] node is not installed (the relay's runtime; the egress service runs reserved-ports.mjs with it)." >&2
	exit 1
}

# coturn's own defaults (turnserver.conf): listening-port, tls-listening-port,
# min-port, max-port. The firewall rules below use the same variables.
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_MIN_PORT=49152
TURN_MAX_PORT=65535

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF_DIR=/etc/mixdog-coturn
TLS_DIR="$CONF_DIR/tls"
ENV_DIR=/etc/mixdog-relay
ENV_FILE="$ENV_DIR/turn.env"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
test -f "$CERT_DIR/fullchain.pem"
test -f "$CERT_DIR/privkey.pem"
umask 077

# The package's stock config allows anonymous relaying. `mask --now` stops a
# stock coturn that is already running and keeps the unit from ever starting
# (including when the package is configured below); then the stock unit is
# confirmed inactive and the ports are confirmed free of any other listener, so
# nothing anonymous can be left answering on the TURN ports.
for unit in mixdog-coturn mixdog-coturn-egress; do
	# A rerun: our own service must not count as "something else" below.
	if [[ -f "/etc/systemd/system/$unit.service" ]]; then systemctl stop "$unit.service"; fi
done
systemctl mask --now coturn.service
if [[ "$(systemctl is-active coturn.service || true)" = active ]]; then
	echo "[coturn] the stock coturn.service is still active after mask --now; refusing to continue." >&2
	exit 1
fi
LISTENERS="$(ss -H -lunpt)"
if grep -q -e ":$TURN_PORT " -e ":$TURN_TLS_PORT " <<<"$LISTENERS"; then
	echo "[coturn] something else already listens on $TURN_PORT/$TURN_TLS_PORT; stop it first:" >&2
	grep -e ":$TURN_PORT " -e ":$TURN_TLS_PORT " <<<"$LISTENERS" >&2
	exit 1
fi
if ! command -v turnserver >/dev/null; then
	apt-get install -y coturn
fi
TURNSERVER_BIN="$(command -v turnserver)"
NFT_BIN="$(command -v nft)"
NODE_BIN="$(command -v node)" # the relay's own runtime; the egress service uses it for reserved-ports.mjs
id -u turnserver >/dev/null
TURN_UID="$(id -u turnserver)"

# Writes stdin to $1 (owner $2, mode $3) via a temp file in the same directory,
# so the secret is never readable by anyone the final file does not allow.
write_private() {
	local path="$1" owner="$2" mode="$3" tmp
	tmp="$(mktemp "$path.XXXXXX")"
	cat >"$tmp"
	chown "$owner" "$tmp"
	chmod "$mode" "$tmp"
	mv -f "$tmp" "$path"
}

install -d -m 0750 -o root -g root "$ENV_DIR"
install -d -m 0750 -o root -g turnserver "$CONF_DIR" "$TLS_DIR"

# The secret is generated here and lives only in two root-owned files. systemd
# reads the env file as root, so the relay account needs no file access to it.
SECRET=""
if [[ -f "$ENV_FILE" ]]; then
	SECRET="$(sed -n '/^TURN_AUTH_SECRET=/{s///p;q}' "$ENV_FILE")"
fi
if [[ ${#SECRET} -lt 20 ]]; then
	SECRET="$(openssl rand -hex 32)"
fi
printf 'TURN_AUTH_SECRET=%s\nTURN_HOST=%s\nTURN_PORT=%s\nTURN_TLS_PORT=%s\nTURN_ISSUE_LIMIT=%s\n' \
	"$SECRET" "$DOMAIN" "$TURN_PORT" "$TURN_TLS_PORT" "$ISSUE_LIMIT" | write_private "$ENV_FILE" root:root 0600

# Substitution happens in bash, not in sed/awk arguments, so the secret never
# appears in a process listing.
CONF="$(<"$SRC_DIR/turnserver.conf.template")"
CONF="${CONF//@TURN_PORT@/$TURN_PORT}"
CONF="${CONF//@TURN_TLS_PORT@/$TURN_TLS_PORT}"
CONF="${CONF//@TURN_MIN_PORT@/$TURN_MIN_PORT}"
CONF="${CONF//@TURN_MAX_PORT@/$TURN_MAX_PORT}"
CONF="${CONF//@TURN_PUBLIC_IP@/$PUBLIC_IP}"
CONF="${CONF//@TURN_REALM@/$DOMAIN}"
CONF="${CONF//@TURN_USER_QUOTA@/$USER_QUOTA}"
CONF="${CONF//@TURN_AUTH_SECRET@/$SECRET}"
printf '%s\n' "$CONF" | write_private "$CONF_DIR/turnserver.conf" root:turnserver 0640

EGRESS="$(<"$SRC_DIR/egress.nft.template")"
EGRESS="${EGRESS//@TURN_UID@/$TURN_UID}"
EGRESS="${EGRESS//@TURN_PUBLIC_IP@/$PUBLIC_IP}"
EGRESS="${EGRESS//@TURN_MIN_PORT@/$TURN_MIN_PORT}"
EGRESS="${EGRESS//@TURN_MAX_PORT@/$TURN_MAX_PORT}"
printf '%s\n' "$EGRESS" | write_private "$CONF_DIR/egress.nft" root:root 0644
# Refuse a policy nft cannot load before anything depends on it.
"$NFT_BIN" -c -f "$CONF_DIR/egress.nft"
if [[ -n "$(ip -4 -o addr show to "$PUBLIC_IP")" ]]; then
	echo "[coturn] $PUBLIC_IP is on a local interface; the egress policy covers it by address and as a local route."
else
	echo "[coturn] $PUBLIC_IP is NOT on a local interface (provider NAT): the egress policy restricts it by address. Relaying two endpoints through each other then needs the provider's NAT to hairpin."
fi

# The relay port range is never handed out as an ephemeral port, so no outgoing
# socket of another service sits inside the one range the egress policy lets a
# relayed packet reach on this host (ip-sysctl: ip_local_reserved_ports; an
# explicit bind, which is how coturn picks its relay ports, is unaffected). The
# egress service merges the range into whatever is already reserved when it
# starts and takes back only what it added when it stops (reserved-ports.mjs),
# so ports reserved by anyone else are never overwritten or cleared.
install -m 0644 -o root -g root "$SRC_DIR/reserved-ports.mjs" "$CONF_DIR/reserved-ports.mjs"

# The TLS listener gets its own copy of this domain's certificate, so the
# turnserver account never gains access to /etc/letsencrypt (deploy.sh keeps
# that scoped to the relay account). The renewal hook refreshes the copy.
install_tls() {
	install -m 0640 -o root -g turnserver "$CERT_DIR/fullchain.pem" "$TLS_DIR/fullchain.pem"
	install -m 0640 -o root -g turnserver "$CERT_DIR/privkey.pem" "$TLS_DIR/privkey.pem"
}
install_tls
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/mixdog-coturn <<HOOK
#!/bin/sh
set -e
install -m 0640 -o root -g turnserver "$CERT_DIR/fullchain.pem" "$TLS_DIR/fullchain.pem"
install -m 0640 -o root -g turnserver "$CERT_DIR/privkey.pem" "$TLS_DIR/privkey.pem"
# try-restart: only a service that is running is restarted, so a renewal never
# starts a coturn that was stopped or rolled back on purpose.
systemctl try-restart mixdog-coturn.service
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/mixdog-coturn

render_unit() { # <template>: stdout is the unit with its @NAME@ markers filled in
	local text
	text="$(<"$1")"
	text="${text//@TURNSERVER_BIN@/$TURNSERVER_BIN}"
	text="${text//@NFT_BIN@/$NFT_BIN}"
	text="${text//@NODE_BIN@/$NODE_BIN}"
	text="${text//@TURN_MIN_PORT@/$TURN_MIN_PORT}"
	text="${text//@TURN_MAX_PORT@/$TURN_MAX_PORT}"
	printf '%s\n' "$text"
}
render_unit "$SRC_DIR/mixdog-coturn.service" | write_private /etc/systemd/system/mixdog-coturn.service root:root 0644
render_unit "$SRC_DIR/mixdog-coturn-egress.service" | write_private /etc/systemd/system/mixdog-coturn-egress.service root:root 0644
# A drop-in, so the relay unit file itself stays what deploy.sh installed.
install -d -m 0755 /etc/systemd/system/mixdog-relay.service.d
printf '[Service]\nEnvironmentFile=%s\n' "$ENV_FILE" >/etc/systemd/system/mixdog-relay.service.d/turn.conf
chmod 0644 /etc/systemd/system/mixdog-relay.service.d/turn.conf

# ufw rules. A rule that already exists before this script ran is somebody
# else's and is left alone for good; the rules THIS script adds are recorded in
# $UFW_OWNED (one `ufw allow` argument per line) and deprovision-coturn.sh
# removes exactly those. Saved rules are written whether or not ufw is active,
# so enabling it later does not close the ports.
UFW_OWNED="$CONF_DIR/ufw-owned"
if command -v ufw >/dev/null; then
	touch "$UFW_OWNED"
	for rule in "$TURN_PORT/udp" "$TURN_PORT/tcp" "$TURN_TLS_PORT/tcp" "$TURN_MIN_PORT:$TURN_MAX_PORT/udp"; do
		if grep -qxF -- "$rule" "$UFW_OWNED"; then
			continue # added by an earlier run of this script
		elif ufw show added | grep -qxF -- "ufw allow $rule"; then
			echo "[coturn] ufw already has 'allow $rule' that this script did not add; leaving it as it is."
		else
			ufw allow "$rule"
			printf '%s\n' "$rule" >>"$UFW_OWNED"
		fi
	done
	ufw status | head -n 1
else
	echo "[coturn] ufw is not installed: open these on the provider firewall / security group:"
	echo "[coturn]   $TURN_PORT/udp  $TURN_PORT/tcp  $TURN_TLS_PORT/tcp  $TURN_MIN_PORT-$TURN_MAX_PORT/udp"
fi

systemctl daemon-reload
systemctl enable mixdog-coturn-egress mixdog-coturn
systemctl restart mixdog-coturn
# Ready means the three listening sockets exist, not that a delay has passed.
# The deadline is systemd's own default start timeout (DefaultTimeoutStartSec,
# 90 s); a service that died stops the wait at once. 0.2 s is only how often the
# sockets are looked at.
DEADLINE=$((SECONDS + 90))
until LISTENERS="$(ss -H -lunt)" &&
	grep -q -e "udp.*:$TURN_PORT " <<<"$LISTENERS" &&
	grep -q -e "tcp.*:$TURN_PORT " <<<"$LISTENERS" &&
	grep -q -e "tcp.*:$TURN_TLS_PORT " <<<"$LISTENERS"; do
	if ! systemctl is-active --quiet mixdog-coturn; then
		journalctl -u mixdog-coturn -n 20 --no-pager >&2
		echo "[coturn] mixdog-coturn stopped before it was listening." >&2
		exit 1
	fi
	if ((SECONDS >= DEADLINE)); then
		echo "[coturn] mixdog-coturn is not listening on $TURN_PORT/$TURN_TLS_PORT after 90 s." >&2
		exit 1
	fi
	sleep 0.2
done
systemctl is-active --quiet mixdog-coturn-egress
# Containment, not equality: other services may reserve more than this range.
"$NODE_BIN" "$CONF_DIR/reserved-ports.mjs" covers "$TURN_MIN_PORT" "$TURN_MAX_PORT"
echo "[coturn] listening on :$TURN_PORT (udp+tcp) and :$TURN_TLS_PORT (tls), relay ports $TURN_MIN_PORT-$TURN_MAX_PORT/udp, public $PUBLIC_IP"
echo "[coturn] the relay reads $ENV_FILE on its next start: deploy the relay, or run: systemctl restart mixdog-relay"
