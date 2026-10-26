#!/usr/bin/env bash
# Undoes provision-coturn.sh ON the VPS (as root):
#   bash deprovision-coturn.sh
# Stops and removes the mixdog-coturn services and their egress policy, the
# certbot hook that would restart coturn, the relay drop-in and its secret, the
# generated coturn config and TLS copy, the part of the relay-port reservation it
# added, and the ufw rules it added. The coturn package stays installed and its
# stock unit stays masked. It does not restart the relay: until mixdog-relay
# restarts it still holds the old settings in memory and keeps advertising TURN
# to desktops.
set -Eeuo pipefail
[[ "$(id -u)" = 0 ]]

CONF_DIR=/etc/mixdog-coturn
ENV_FILE=/etc/mixdog-relay/turn.env
UFW_OWNED="$CONF_DIR/ufw-owned"

# The ufw rules provision-coturn.sh added (one `ufw allow` argument per line),
# read before the config directory goes away. A rule that was already in ufw
# before provisioning is not listed and is left alone.
OWNED_RULES=()
if [[ -f "$UFW_OWNED" ]]; then
	mapfile -t OWNED_RULES <"$UFW_OWNED"
fi

# Stopping the egress service takes back exactly the ports it added to
# ip_local_reserved_ports (reserved-ports.mjs release), and its table.
for unit in mixdog-coturn mixdog-coturn-egress; do
	if [[ -f "/etc/systemd/system/$unit.service" ]]; then
		systemctl disable --now "$unit.service"
		rm -f "/etc/systemd/system/$unit.service"
	fi
done
# The egress unit's stop removes its table; this covers a table left behind.
if nft list table inet mixdog_coturn >/dev/null 2>&1; then nft delete table inet mixdog_coturn; fi

# A renewal must not bring coturn back.
rm -f /etc/letsencrypt/renewal-hooks/deploy/mixdog-coturn
rm -f /etc/systemd/system/mixdog-relay.service.d/turn.conf
rm -rf "$CONF_DIR"
rm -f "$ENV_FILE"
for dir in /etc/systemd/system/mixdog-relay.service.d "$(dirname "$ENV_FILE")"; do
	if [[ -d "$dir" ]]; then rmdir --ignore-fail-on-non-empty "$dir"; fi
done

# The saved rules go whether or not ufw is active; they were saved either way.
if [[ ${#OWNED_RULES[@]} -gt 0 ]]; then
	if command -v ufw >/dev/null; then
		for rule in "${OWNED_RULES[@]}"; do
			ufw --force delete allow "$rule"
		done
	else
		echo "[coturn] ufw is no longer installed; the rules it held are gone with it: ${OWNED_RULES[*]}"
	fi
fi
echo "[coturn] if you opened ports on the provider firewall / security group (3478/udp, 3478/tcp, 5349/tcp, 49152-65535/udp), close them there."

systemctl daemon-reload
echo "[coturn] removed. Restart the relay so it stops advertising TURN: systemctl restart mixdog-relay"
