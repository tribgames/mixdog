#!/bin/bash
# Self-test for linux-glibc-floor.mjs: proves it fails closed. Needs gcc, objdump, node.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node_bin=$(command -v node)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() {
	echo "SELFTEST FAIL: $*"
	exit 1
}
expect() { # expect <0|nonzero> <label> <cmd...>
	local want=$1 label=$2
	shift 2
	"$@" >"$work/out.txt" 2>&1
	local rc=$?
	if [ "$want" = 0 ] && [ $rc -ne 0 ]; then
		cat "$work/out.txt"
		fail "$label: expected pass, got $rc"
	fi
	if [ "$want" != 0 ] && [ $rc -eq 0 ]; then
		cat "$work/out.txt"
		fail "$label: expected failure, passed"
	fi
	echo "ok: $label (exit $rc)"
}
arch=$(node -p "process.arch")
mkdir "$work/new" "$work/old" "$work/bad" "$work/empty"
# arc4random is GLIBC_2.36: newer than any floor this repo allows.
printf '#include <stdlib.h>\nint main(void){return (int)(arc4random()&1);}\n' >"$work/new.c"
gcc -o "$work/new/too-new" "$work/new.c" || fail "gcc"
printf 'int main(void){return 0;}\n' >"$work/old.c"
gcc -o "$work/old/plain" "$work/old.c" || fail "gcc"
# ELF magic + a header naming this arch's machine, then garbage: objdump must reject it.
hdr='\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\003\000\076\000'
[ "$arch" = arm64 ] && hdr='\177ELF\002\001\001\000\000\000\000\000\000\000\000\000\003\000\267\000'
{
	printf "$hdr"
	head -c 40 /dev/zero
} >"$work/bad/corrupt"
# Floors: the too-new binary exceeds 2.31 and passes under 2.99; the plain one passes 2.99.
expect nonzero "too-new binary fails floor 2.31" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/new" 2.31 --arch "$arch"
expect 0 "too-new binary passes floor 2.99" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/new" 2.99 --arch "$arch"
expect 0 "plain binary passes floor 2.99" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/old" 2.99 --arch "$arch"
expect nonzero "corrupt ELF fails closed" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/bad" 2.99 --arch "$arch"
expect nonzero "directory without ELF files fails" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/empty" 2.99 --arch "$arch"
expect nonzero "missing --require path fails" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/old" 2.99 --arch "$arch" --require nope
expect 0 "present --require path passes" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/old" 2.99 --arch "$arch" --require plain
expect nonzero "missing objdump fails closed" env PATH="$work/empty" "$node_bin" "$here/linux-glibc-floor.mjs" "$work/old" 2.99 --arch "$arch"
echo "glibc floor self-test passed"
