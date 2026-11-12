#!/bin/bash
# Dev update loop for the INSTALLED macOS desktop build — the macOS counterpart
# of dev-update-windows.ps1's default mode:
#
#   build -> stop app -> stop session daemon -> replace the installed bundle
#   -> relaunch -> wait for a fresh daemon.
#
# The daemon stop is the point: a dev rebuild keeps the same version, so a
# relaunched app would otherwise attach to the still-running old core.
#
# No Developer ID key leaves CI, so there is no -ViaUpdater equivalent: macOS
# auto-update only accepts a bundle signed by the same identity as the running
# one. The build is signed with the local identity from
# setup-dev-signing-mac.sh when present, so privacy grants and keychain access
# survive rebuilds; without it the build is ad-hoc and macOS asks again on
# every install. Replacing an installed Developer ID build asks again either way.
#
# Options:
#   --skip-build    install the existing dist/mac-*/Mixdog.app
#   --no-launch     install, but leave the app and daemon stopped
#   --keep-daemon   leave the running session daemon alone
#   --dry-run       print the plan and current state; change nothing
#   --install-dir   bundle to replace (default /Applications/Mixdog.app)
set -euo pipefail

desktop_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$desktop_dir/../.." && pwd)"
install_app="/Applications/Mixdog.app"
skip_build=false no_launch=false keep_daemon=false dry_run=false

while [ $# -gt 0 ]; do
	case "$1" in
	--skip-build) skip_build=true ;;
	--no-launch) no_launch=true ;;
	--keep-daemon) keep_daemon=true ;;
	--dry-run) dry_run=true ;;
	--install-dir)
		install_app="$2"
		shift
		;;
	--install-dir=*) install_app="${1#*=}" ;;
	*)
		echo "unknown option: $1" >&2
		exit 2
		;;
	esac
	shift
done

arch="$(uname -m)"
case "$arch" in arm64) dist_app="$desktop_dir/dist/mac-arm64/Mixdog.app" ;; *) dist_app="$desktop_dir/dist/mac/Mixdog.app" ;; esac
runtime_root="${MIXDOG_RUNTIME_ROOT:-$(node -e 'const os=require("os");console.log(require("path").join(os.tmpdir(), "mixdog-" + process.getuid()))')}"
[ -f "$runtime_root/daemon.json" ] || runtime_root="$(node -e 'console.log(require("path").join(require("os").tmpdir(), "mixdog"))')"
daemon_discovery="$runtime_root/daemon.json"

step() { printf '\033[36m==> %s\033[0m\n' "$*"; }
fail() {
	printf '\033[31m%s\033[0m\n' "$*" >&2
	exit 1
}
sleep_s() { perl -e "select(undef, undef, undef, $1)"; }

installed_version() {
	defaults read "$install_app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true
}

# Desktop MAIN processes only (any bundle path, including an App Translocation
# copy): helpers live under Contents/Frameworks, not Contents/MacOS/Mixdog.
app_pids() {
	ps -axo pid=,command= | awk '$2 ~ /Mixdog\.app\/Contents\/MacOS\/Mixdog$/ { print $1 }'
}

# The core of any installed bundle (`mixdogd` under Contents/Resources/core).
daemon_pids() {
	ps -axo pid=,command= | awk '$2 ~ /Mixdog\.app\/Contents\/Resources\/core\/mixdogd$/ { print $1 }'
}

# The pid the core published in its discovery file (<runtime root>/daemon.json).
daemon_field() {
	[ -f "$daemon_discovery" ] || return 0
	node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      console.log({ pid: d.pid }[process.argv[2]] ?? "");
    } catch { console.log(""); }
  ' "$daemon_discovery" "$1"
}

join_pids() { tr '\n' ' ' | sed 's/ *$//'; }

dev_sign_identity="${MIXDOG_DEV_SIGN_IDENTITY:-Mixdog Local Dev}"
dev_identity_ready() {
	security find-identity -v -p codesigning | grep -qF "\"$dev_sign_identity\""
}

stop_app() {
	local pids
	pids="$(app_pids | join_pids)"
	if [ -z "$pids" ]; then
		echo "    app is not running"
		return
	fi
	echo "    quitting Mixdog pid=$pids"
	osascript -e 'tell application id "io.mixdog.desktop" to quit' >/dev/null 2>&1 || true
	for _ in $(seq 1 75); do
		[ -z "$(app_pids)" ] && return
		sleep_s 0.2
	done
	for pid in $(app_pids); do
		echo "    forcing pid=$pid"
		kill -9 "$pid" 2>/dev/null || true
	done
	for _ in $(seq 1 50); do
		[ -z "$(app_pids)" ] && return
		sleep_s 0.2
	done
	fail "Mixdog is still running: $(app_pids | join_pids)"
}

# The installed core stops itself once it is idle (`ctl stop --when-idle`, as the Windows script does); nothing
# here kills it, so running work finishes first.
stop_daemon() {
	local pid core="$install_app/Contents/Resources/core/mixdogd"
	pid="$(daemon_field pid)"
	[ -n "$pid" ] || {
		echo "    no core running"
		return
	}
	[ -x "$core" ] || {
		echo "    the installed build has no mixdogd ($core); nothing to stop"
		return
	}
	"$core" ctl stop --when-idle --reason fastDeploy --json >/dev/null || fail "mixdogd ctl stop failed"
	echo "    asked core pid=$pid to stop when idle"
	while kill -0 "$pid" 2>/dev/null; do
		echo "    waiting for the core to become idle"
		sleep_s 10
	done
}

wait_for_fresh_daemon() {
	local previous="$1" pid
	for _ in $(seq 1 240); do
		pid="$(daemon_field pid)"
		if [ -n "$pid" ] && [ "$pid" != "$previous" ] && kill -0 "$pid" 2>/dev/null; then
			echo "$pid"
			return
		fi
		sleep_s 0.5
	done
}

build() {
	(
		cd "$desktop_dir"
		npm run build
		npm run prepare:runtime
		# The core cargo builds here; prepare:runtime recreated .runtime, so it is staged after it.
		cargo build --release --locked -p mixdog-cli --manifest-path "$repo_root/native/core/Cargo.toml"
		node scripts/stage-core.mjs "--binary=$repo_root/native/core/target/release/mixdogd"
		# Dev builds never see the Developer ID secrets.
		if dev_identity_ready; then
			# No secure timestamp: only notarization needs one, and fetching it from
			# Apple's server once per bundled file dominated the signing time.
			CSC_NAME="$dev_sign_identity" npx --no-install electron-builder --mac --dir "--$arch" --publish never \
				-c.mac.timestamp=none
		else
			echo "    no '$dev_sign_identity' signing identity: building ad-hoc (run scripts/setup-dev-signing-mac.sh to keep privacy grants across rebuilds)" >&2
			CSC_IDENTITY_AUTO_DISCOVERY=false npx --no-install electron-builder --mac --dir "--$arch" --publish never
		fi
	)
}

assert_artifact() {
	[ -d "$dist_app" ] || fail "Build artifact missing: $dist_app"
	[ -f "$dist_app/Contents/Resources/core/mixdogd" ] || fail "Desktop artifact is missing the core: $dist_app"
	[ -f "$dist_app/Contents/Resources/core/js-runtime.json" ] || fail "Desktop artifact is missing js-runtime.json: $dist_app"
	[ -f "$dist_app/Contents/Resources/runtime.asar" ] || fail "Desktop artifact is missing runtime.asar: $dist_app"
}

version_before="$(installed_version)"
daemon_before="$(daemon_field pid)"

if $dry_run; then
	echo "plan (dry run, nothing changes)"
	echo "  build          : $($skip_build && echo "skip (use $dist_app)" || echo "npm run build + prepare:runtime + electron-builder --mac --dir --$arch ($(dev_identity_ready && echo "signed: $dev_sign_identity" || echo ad-hoc))")"
	echo "  install        : $dist_app -> $install_app (previous bundle goes to the Trash)"
	echo "  stop app       : $(app_pids | join_pids || true)"
	echo "  stop daemon    : $($keep_daemon && echo 'no (--keep-daemon)' || echo "${daemon_before:-(none running)}")"
	echo "  relaunch       : $($no_launch && echo no || echo yes)"
	echo "  installed now  : ${version_before:-(not installed)}"
	echo "  daemon record  : $daemon_discovery"
	exit 0
fi

if ! $skip_build; then
	step "building the app from the dev tree"
	build
fi
assert_artifact

step "stopping the installed app"
stop_app
if ! $keep_daemon; then
	step "stopping the session daemon (a same-version rebuild never drains it on its own)"
	stop_daemon
fi

step "replacing $install_app"
if [ -e "$install_app" ]; then /usr/bin/trash "$install_app"; fi
ditto "$dist_app" "$install_app"
xattr -dr com.apple.quarantine "$install_app" 2>/dev/null || true

daemon_after=""
if $no_launch; then
	step "leaving the app stopped (--no-launch)"
else
	step "starting the installed app"
	open "$install_app"
	if $keep_daemon; then
		daemon_after="$daemon_before"
	else
		step "waiting for a fresh session daemon"
		daemon_after="$(wait_for_fresh_daemon "$daemon_before")"
	fi
fi

echo
printf '\033[32mresult\033[0m\n'
echo "  installed version : ${version_before:-(none)} -> $(installed_version)"
echo "  app pid(s)        : $(app_pids | join_pids)"
echo "  session daemon    : ${daemon_before:-(none)} -> ${daemon_after:-$($no_launch && echo '(stopped)' || echo '(did not appear)')}"
if ! $no_launch && [ -z "$daemon_after" ] && ! $keep_daemon; then
	fail "The session daemon did not come back up — check the daemon log."
fi
