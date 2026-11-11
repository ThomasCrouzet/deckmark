#!/usr/bin/env bash
# Select the gitleaks history range.
# Push events scan before..head only when both commits resolve and before is an
# ancestor of head. A new branch, force push, or malformed value falls back to
# full history. Pull requests require a reachable base..head range and fail
# closed when it is unavailable. Scheduled and manual runs scan full history.
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
			|| ! is_ancestor "$base" "$head"; then
			echo 'gitleaks-range: pull request base and head are not a reachable range.' >&2
			exit 2
		fi
		printf '%s..%s\n' "$base" "$head"
		;;
	*)
		echo "gitleaks-range: unknown event: ${event:-<empty>}" >&2
		exit 2
		;;
esac
