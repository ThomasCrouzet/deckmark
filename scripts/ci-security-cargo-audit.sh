#!/usr/bin/env bash
# Keep one pinned cargo-audit installation for the Security workflow.
# A cache hit is reused only when the binary reports the exact pinned version.
set -euo pipefail

version=${CARGO_AUDIT_VERSION:-0.22.2}
root=${CARGO_AUDIT_ROOT:-"$HOME/.cache/cargo-audit"}
binary="$root/bin/cargo-audit"

usage() {
	echo 'usage: ci-security-cargo-audit.sh ensure|audit <lockfile>' >&2
}

installed_version() {
	"$binary" --version 2>/dev/null | head -n 1 || true
}

ensure() {
	if [ -x "$binary" ] && [ "$(installed_version)" = "cargo-audit $version" ]; then
		echo "cargo-audit cache hit: cargo-audit $version"
		return 0
	fi
	cargo install cargo-audit --locked --version "$version" --root "$root"
	test -x "$binary"
	actual=$(installed_version)
	if [ "$actual" != "cargo-audit $version" ]; then
		echo "cargo-audit: installed version is '${actual}', expected cargo-audit $version" >&2
		exit 1
	fi
	echo "cargo-audit installed: $actual"
}

run_audit() {
	local lockfile=${1:-}
	if [ -z "$lockfile" ]; then usage; exit 2; fi
	if [ ! -x "$binary" ]; then
		echo 'cargo-audit: the pinned binary is missing; run ensure first' >&2
		exit 2
	fi
	"$binary" audit --file "$lockfile" --deny unsound
}

case "${1:-}" in
	ensure)
		ensure
		;;
	audit)
		run_audit "${2:-}"
		;;
	*)
		usage
		exit 2
		;;
esac
