#!/usr/bin/env bash
# Stop every run of one commit at the first failed job.
#
# The fail-fast job of deploy.yml runs this script. It watches every workflow
# run of the same head commit and event. When one job fails, it cancels every
# run that is not complete, its own run last. It runs no project dependency,
# so it is the only job that holds `actions: write`.
#
# Rules:
# - An aggregate job (e2e, check, desktop-validation, codeql (rust, none)) and
#   this job are not a cause: they fail only because a dependency failed or
#   the tier is deferred.
# - The pr-body workflow is metadata about the pull request text. Its result
#   neither triggers nor receives a cancellation.
# - A run is never cancelled once a publication job is queued, in progress or
#   succeeded (deploy, release, installers, CLI archives, public checks).
# - A run created more than RUN_WINDOW_SECONDS before this run belongs to an
#   earlier event on the same commit (for example a draft run). It is ignored.
# - On a re-run attempt, a failure that completed before this attempt started
#   is old. The maintainer asked for the re-run, so it is ignored.
# - Fail-fast is an optimisation, never a gate. On a repeated API error the
#   script prints a warning and exits 0. The required aggregates stay the gate.
#
# Environment: GH_TOKEN, REPOSITORY, HEAD_SHA, EVENT_NAME, SELF_RUN_ID.
# Tuning (tests): POLL_SECONDS (15), DEADLINE_SECONDS (4200),
# RUN_WINDOW_SECONDS (300), SELF_CANCEL_WAIT_SECONDS (60), API_RETRY_SECONDS (2).
set -euo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"
: "${EVENT_NAME:?EVENT_NAME is required}"
: "${SELF_RUN_ID:?SELF_RUN_ID is required}"
POLL_SECONDS="${POLL_SECONDS:-15}"
DEADLINE_SECONDS="${DEADLINE_SECONDS:-4200}"
RUN_WINDOW_SECONDS="${RUN_WINDOW_SECONDS:-300}"
SELF_CANCEL_WAIT_SECONDS="${SELF_CANCEL_WAIT_SECONDS:-60}"
API_RETRY_SECONDS="${API_RETRY_SECONDS:-2}"

AGGREGATES='^(e2e|check|desktop-validation|codeql \(rust, none\)|fail-fast)$'
PUBLICATION='^(deploy|deploy-cloudflare|verify-public / .*|release-please|plan-release|build-desktop( \(.*\))?|verify-packaging|publish-desktop-beta|cli-package / .*|cli-verify)$'
EXCLUDED_WORKFLOW='^\.github/workflows/pr-body\.yml(@.*)?$'

if [[ ! "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || [[ ! "$SELF_RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "::warning::fail-fast: invalid HEAD_SHA or SELF_RUN_ID. Fail-fast is off for this run."
  exit 0
fi

# Read one API path. Retry three times, then fail the call.
api() {
  local attempt output
  for attempt in 1 2 3; do
    if output=$(gh api "$1" 2>/dev/null); then
      printf '%s' "$output"
      return 0
    fi
    [ "$attempt" = 3 ] || sleep "$API_RETRY_SECONDS"
  done
  return 1
}

give_up() {
  echo "::warning::fail-fast: the GitHub API did not answer ($1). Fail-fast stops; the required checks still apply."
  exit 0
}

epoch() { date -u -d "$1" +%s; }

own=$(api "repos/$REPOSITORY/actions/runs/$SELF_RUN_ID") || give_up 'own run'
own_created=$(epoch "$(jq -r '.created_at' <<<"$own")")
own_attempt=$(jq -r '.run_attempt // 1' <<<"$own")
own_started=$(epoch "$(jq -r '.run_started_at // .created_at' <<<"$own")")
start=$(date -u +%s)
idle_polls=0

echo "fail-fast: watching $EVENT_NAME runs of $HEAD_SHA (own run $SELF_RUN_ID, attempt $own_attempt)."

while :; do
  now=$(date -u +%s)
  if [ $((now - start)) -ge "$DEADLINE_SECONDS" ]; then
    echo "fail-fast: deadline reached without a failure."
    exit 0
  fi

  runs=$(api "repos/$REPOSITORY/actions/runs?head_sha=$HEAD_SHA&event=$EVENT_NAME&per_page=50") || give_up 'run list'
  # One TSV line per run of this event: id, status, path, name, created_at.
  mapfile -t run_lines < <(jq -r --argjson floor "$((own_created - RUN_WINDOW_SECONDS))" --arg excluded "$EXCLUDED_WORKFLOW" '
    .workflow_runs[]
    | select((.created_at | fromdateiso8601) >= $floor)
    | select((.path // "") | test($excluded) | not)
    | [.id, .status, (.path // ""), .name] | @tsv' <<<"$runs")

  failure=''
  others_done=1
  declare -A run_status=() run_name=() run_jobs=()
  for line in "${run_lines[@]}"; do
    IFS=$'\t' read -r id status _path name <<<"$line"
    jobs=$(api "repos/$REPOSITORY/actions/runs/$id/jobs?filter=latest&per_page=100") || give_up "jobs of run $id"
    run_status[$id]=$status
    run_name[$id]=$name
    run_jobs[$id]=$jobs
    if [ "$id" != "$SELF_RUN_ID" ] && [ "$status" != completed ]; then others_done=0; fi
    if [ -z "$failure" ]; then
      failure=$(jq -r --arg aggregates "$AGGREGATES" --argjson attempt "$own_attempt" --argjson started "$own_started" --arg workflow "$name" '
        [.jobs[]
          | select(.conclusion == "failure" or .conclusion == "timed_out")
          | select(.name | test($aggregates) | not)
          | select($attempt == 1 or ((.completed_at // "1970-01-01T00:00:00Z") | fromdateiso8601) >= $started)
        ][0]
        | if . == null then "" else "\($workflow) / \(.name) (\(.html_url))" end' <<<"$jobs")
    fi
  done

  if [ -n "$failure" ]; then
    echo "::error::fail-fast: $failure failed. Cancelling the other runs of this commit."
    cancel_self=0
    for id in "${!run_status[@]}"; do
      [ "${run_status[$id]}" != completed ] || continue
      protected=$(jq -r --arg publication "$PUBLICATION" '
        [.jobs[] | select(.name | test($publication))
          | select(.status != "completed" or .conclusion == "success")] | length' <<<"${run_jobs[$id]}")
      if [ "$protected" != 0 ]; then
        echo "fail-fast: run $id (${run_name[$id]}) is publishing. It is not cancelled."
        continue
      fi
      if [ "$id" = "$SELF_RUN_ID" ]; then
        cancel_self=1
        continue
      fi
      if gh api -X POST "repos/$REPOSITORY/actions/runs/$id/cancel" >/dev/null 2>&1; then
        echo "fail-fast: cancelled run $id (${run_name[$id]})."
      else
        echo "fail-fast: run $id (${run_name[$id]}) did not accept the cancel request (already complete or no permission)."
      fi
    done
    if [ "$cancel_self" = 1 ]; then
      if gh api -X POST "repos/$REPOSITORY/actions/runs/$SELF_RUN_ID/cancel" >/dev/null 2>&1; then
        echo "fail-fast: cancelled the own run $SELF_RUN_ID."
        # Let the cancellation reach this job, so a re-run of failed jobs
        # also starts this watcher again.
        sleep "$SELF_CANCEL_WAIT_SECONDS"
      else
        echo "fail-fast: the own run $SELF_RUN_ID did not accept the cancel request."
      fi
    fi
    exit 0
  fi

  # Stop when every other run is complete and no other job of the own run is
  # open, on two polls in a row (a dependent job can appear between polls).
  own_jobs=${run_jobs[$SELF_RUN_ID]:-}
  [ -n "$own_jobs" ] || own_jobs='{"jobs":[]}'
  own_open=$(jq -r '[.jobs[] | select(.name != "fail-fast") | select(.status != "completed")] | length' <<<"$own_jobs")
  if [ "$others_done" = 1 ] && [ "$own_open" = 0 ]; then
    idle_polls=$((idle_polls + 1))
    if [ "$idle_polls" -ge 2 ]; then
      echo "fail-fast: every run of this commit is complete. No job failed."
      exit 0
    fi
  else
    idle_polls=0
  fi
  unset run_status run_name run_jobs
  sleep "$POLL_SECONDS"
done
