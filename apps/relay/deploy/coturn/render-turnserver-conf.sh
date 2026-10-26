# Sourced by provision-coturn.sh (and its test): renders turnserver.conf.template.
# Substitution happens in bash, not in sed/awk arguments, so the secret never
# appears in a process listing.
#
# render_turnserver_conf <template>: stdout is the config with every @TURN_*@
# marker filled from these variables: TURN_PORT TURN_TLS_PORT TURN_MIN_PORT
# TURN_MAX_PORT TURN_PUBLIC_IP TURN_REALM TURN_USER_QUOTA TURN_AUTH_SECRET.
# Fails without output when a marker is left unfilled. Under `set -u` (as
# provision-coturn.sh runs) an unset variable fails too.
render_turnserver_conf() {
	local conf
	# errexit is off inside the command substitution provisioning calls this
	# from, so a failed read must return on its own.
	conf="$(<"$1")" || return $?
	conf="${conf//@TURN_PORT@/$TURN_PORT}"
	conf="${conf//@TURN_TLS_PORT@/$TURN_TLS_PORT}"
	conf="${conf//@TURN_MIN_PORT@/$TURN_MIN_PORT}"
	conf="${conf//@TURN_MAX_PORT@/$TURN_MAX_PORT}"
	conf="${conf//@TURN_PUBLIC_IP@/$TURN_PUBLIC_IP}"
	conf="${conf//@TURN_REALM@/$TURN_REALM}"
	conf="${conf//@TURN_USER_QUOTA@/$TURN_USER_QUOTA}"
	# Checked before the secret goes in, so nothing inside it can look like a
	# marker, and nothing of it reaches the error message.
	if [[ "${conf//@TURN_AUTH_SECRET@/}" =~ @TURN_[A-Z_]+@ ]]; then
		echo "[coturn] turnserver.conf.template has an unfilled marker: ${BASH_REMATCH[0]}" >&2
		return 1
	fi
	conf="${conf//@TURN_AUTH_SECRET@/$TURN_AUTH_SECRET}"
	printf '%s\n' "$conf"
}
