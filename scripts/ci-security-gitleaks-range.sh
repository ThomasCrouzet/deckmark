#!/usr/bin/env bash
# Select the gitleaks history range.
# Push events scan before..head only when both commits resolve and before is an
# ancestor of head. A new branch, force push, or malformed value falls back to
# full history.
# A pull request scans base..head when both commits resolve and share history.
# The base commit is the base branch tip at event time, so it is often not an
# ancestor of the head commit. The range stays valid: it holds the commits that
# the pull request adds and leaves the base branch history out. A branch that
# already merged into the base adds no commit, so its range is empty. A
# malformed, missing, or unrelated commit pair fails closed. Scheduled and
# manual runs scan full history.
set -euo pipefail

event=''
before=''
base=''
head=''

usage() {
	echo 'usage: ci-security-gitleaks-range.sh --event EVENT [--before SHA] [--base SHA] [--head SHA]' >&2
}

while [ $# -gt 0 ]; do
	case "$1" in
		--event) event=${2:-}; shift 2 ;;
		--before) before=${2:-}; shift 2 ;;
		--base) base=${2:-}; shift 2 ;;
		--head) head=${2:-}; shift 2 ;;
		--help|-h) usage; exit 0 ;;
		*) echo "gitleaks-range: unknown argument: $1" >&2; exit 2 ;;
	esac
done

is_sha() {
	[[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

resolves() {
	git rev-parse --verify --quiet "$1^{commit}" >/dev/null 2>&1
}

is_ancestor() {
	git merge-base --is-ancestor "$1" "$2" >/dev/null 2>&1
}

shares_history() {
	git merge-base "$1" "$2" >/dev/null 2>&1
}

case "$event" in
	schedule|workflow_dispatch)
		exit 0
		;;
	push)
		if is_sha "$before" && is_sha "$head" && resolves "$before" && resolves "$head" \
			&& is_ancestor "$before" "$head"; then
			printf '%s..%s\n' "$before" "$head"
		fi
		exit 0
		;;
	pull_request)
		if ! is_sha "$base" || ! is_sha "$head" || ! resolves "$base" || ! resolves "$head" \
			|| ! shares_history "$base" "$head"; then
			echo 'gitleaks-range: pull request base and head are not a usable range.' >&2
			exit 2
		fi
		# git accepts a range whose ends are not ordered. This range holds the
		# pull request commits only, also when the base branch moved on.
		printf '%s..%s\n' "$base" "$head"
		;;
	*)
		echo "gitleaks-range: unknown event: ${event:-<empty>}" >&2
		exit 2
		;;
esac
