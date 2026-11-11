#!/usr/bin/env bash
# Prepare Ubuntu APT for CI dependency installation and fail fast.
#
# The helper does four things:
#   1. Prefer the archive mirrors declared by the runner mirror list.
#   2. Write bounded APT network settings.
#   3. Probe every configured source before package work starts.
#   4. Move a dead Ubuntu pocket to a mirror that serves the same suite.
#
# Probes are read-only. Every path and the privilege command are configurable
# so tests can run against synthetic files and command shims without touching
# the host configuration.
#
# Optional environment variables:
#   MDSH_APT_MIRROR_FILE   mirror list (default /etc/apt/apt-mirrors.txt)
#   MDSH_APT_CONF          APT network configuration file
#   MDSH_APT_SOURCES_DIR   deb822 source directory (default /etc/apt/sources.list.d)
#   MDSH_APT_SOURCES_LIST  one-line source list (default /etc/apt/sources.list)
#   MDSH_APT_SUDO          privilege command; set empty to run directly
#   MDSH_PROBE_TIMEOUT     seconds for each DNS or HTTP probe (default 10)
#   MDSH_APT_VERIFY_INDEX  set to 1 to run a bounded index refresh

set -euo pipefail

mirror_file=${MDSH_APT_MIRROR_FILE:-/etc/apt/apt-mirrors.txt}
conf_file=${MDSH_APT_CONF:-/etc/apt/apt.conf.d/zzz-mdsh-ci-network}
sources_dir=${MDSH_APT_SOURCES_DIR:-/etc/apt/sources.list.d}
sources_list=${MDSH_APT_SOURCES_LIST:-/etc/apt/sources.list}
probe_timeout=${MDSH_PROBE_TIMEOUT:-10}
verify_index=${MDSH_APT_VERIFY_INDEX:-0}
if [[ ! $probe_timeout =~ ^[0-9]+$ ]] || (( probe_timeout < 1 )); then
  printf '::error::MDSH_PROBE_TIMEOUT must be a positive integer: %s\n' "$probe_timeout" >&2
  exit 1
fi

if [[ ${MDSH_APT_SUDO+set} == set ]]; then
  sudo_cmd=$MDSH_APT_SUDO
elif (( EUID == 0 )); then
  sudo_cmd=''
else
  sudo_cmd=sudo
fi

run_root() {
  if [[ -n $sudo_cmd ]]; then
    "$sudo_cmd" "$@"
  else
    "$@"
  fi
}

fail() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

warn() {
  printf '::warning::%s\n' "$*"
}

missing=()
for tool in getent curl grep sed awk find mkdir cat install mktemp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing+=("$tool")
  fi
done
if (( ${#missing[@]} )); then
  fail "Required probe tools are missing: ${missing[*]}"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Step 1: put the archive mirrors first in the runner mirror list.
if [[ -f $mirror_file ]] \
  && grep -Eq '^https?://azure\.archive\.ubuntu\.com/ubuntu/[[:space:]]+priority:[0-9]+$' "$mirror_file" \
  && grep -Eq '^https?://archive\.ubuntu\.com/ubuntu/[[:space:]]+priority:[0-9]+$' "$mirror_file"; then
  run_root sed -E -i \
    -e 's|^(https?://azure\.archive\.ubuntu\.com/ubuntu/)[[:space:]]*priority:[0-9]+$|\1 priority:2|' \
    -e 's|^(https?://archive\.ubuntu\.com/ubuntu/)[[:space:]]*priority:[0-9]+$|\1 priority:1|' \
    "$mirror_file"
else
  warn "Expected Ubuntu mirror entries are unavailable in ${mirror_file}. Keeping the runner mirror configuration."
fi

# Step 2: bound every download attempt. APT retries a dead host for minutes by
# default; one retry and a short timeout keep the failure visible.
run_root mkdir -p "$(dirname "$conf_file")"
cat > "$work/apt-network.conf" <<'EOF'
Acquire::Retries "1";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::ftp::Timeout "15";
EOF
run_root install -m 0644 "$work/apt-network.conf" "$conf_file"

# Step 3: list source entries. Each line is: ENTRY, file, kind, token, suite.
entries=$work/entries
: > "$entries"
malformed=$work/malformed
: > "$malformed"

parse_deb822() {
  local file=$1
  awk -v file="$file" '
    BEGIN { RS = ""; FS = "\n" }
    {
      uris = ""; suites = ""; enabled = ""; types = ""; fields = 0
      for (i = 1; i <= NF; i++) {
        line = $i
        sub(/^[ \t]+/, "", line)
        if (line == "" || line ~ /^#/) continue
        if (line !~ /^[^:]+:/) continue
        fields++
        key = line; sub(/:.*/, "", key)
        value = line; sub(/^[^:]+:[ \t]*/, "", value); sub(/[ \t]+$/, "", value)
        if (key == "URIs") uris = value
        else if (key == "Suites") suites = value
        else if (key == "Enabled") enabled = value
        else if (key == "Types") types = value
      }
      # A paragraph without field lines is a comment header, not a stanza.
      if (fields == 0) next
      if (enabled == "no") next
      if (types != "" && types !~ /(^| )deb( |$)/) next
      if (uris == "" || suites == "") {
        printf "MALFORMED\t%s\n", file > "/dev/stderr"
        next
      }
      nu = split(uris, u, /[ \t]+/)
      ns = split(suites, s, /[ \t]+/)
      for (a = 1; a <= nu; a++) {
        if (u[a] !~ /^(https?:\/\/|mirror\+file:|file:|cdrom:)/) {
          printf "MALFORMED\t%s\n", file > "/dev/stderr"
          continue
        }
        for (b = 1; b <= ns; b++) printf "ENTRY\t%s\tdeb822\t%s\t%s\n", file, u[a], s[b]
      }
    }' "$file"
}

parse_one_line() {
  local file=$1
  awk -v file="$file" '
    {
      line = $0
      sub(/^[ \t]+/, "", line)
      sub(/[ \t]+#.*$/, "", line)
      if (line == "" || line ~ /^#/) next
      n = split(line, w, /[ \t]+/)
      if (w[1] != "deb" && w[1] != "deb-src") next
      i = 2
      if (i <= n && w[i] ~ /^\[/) {
        while (i <= n && w[i] !~ /\]$/) i++
        i++
      }
      if (i + 1 > n) { printf "MALFORMED\t%s\n", file > "/dev/stderr"; next }
      uri = w[i]; i++
      # The one-line format is: type [options] URI suite component...
      # Only the suite follows the URI. Components are package groups, not
      # suites, so they must not become probed dists/<component>/ entries.
      suite = w[i]
      printf "ENTRY\t%s\tline\t%s\t%s\n", file, uri, suite
    }' "$file"
}

mapfile -t source_files < <(
  {
    printf '%s\n' "$sources_list"
    if [[ -d $sources_dir ]]; then
      find "$sources_dir" -maxdepth 1 -type f \( -name '*.sources' -o -name '*.list' \) 2>/dev/null | sort
    fi
  } | awk '!seen[$0]++'
)

for file in "${source_files[@]}"; do
  [[ -f $file ]] || continue
  case $file in
    *.sources) parse_deb822 "$file" >> "$entries" 2>> "$malformed" ;;
    *.list) parse_one_line "$file" >> "$entries" 2>> "$malformed" ;;
    *)
      if [[ $file == "$sources_list" ]]; then
        parse_one_line "$file" >> "$entries" 2>> "$malformed"
      fi
      ;;
  esac
done

if [[ -s $malformed ]]; then
  fail "An APT source stanza is incomplete (missing URIs or Suites): $(sed 's/^MALFORMED\t//' "$malformed" | sort -u | tr '\n' ' ')"
fi
if [[ ! -s $entries ]]; then
  fail "No Ubuntu APT sources found in ${sources_list} or ${sources_dir}."
fi

# Candidate mirrors in priority order: the runner mirror list first, then the
# archive hosts used by the GitHub runner image.
list_candidates() {
  if [[ -f $mirror_file ]]; then
    awk '
      /^[ \t]*#/ { next }
      {
        url = $1
        if (url !~ /^https?:\/\//) next
        sub(/\/+$/, "", url)
        priority = 50
        for (i = 2; i <= NF; i++) {
          if ($i ~ /^priority:/) {
            priority = $i
            sub(/priority:/, "", priority)
            if (priority !~ /^[0-9]+$/) priority = 50
          }
        }
        print priority "\t" url
      }' "$mirror_file" | sort -n -k1,1
  fi
  printf '1\thttp://archive.ubuntu.com/ubuntu\n'
  printf '2\thttp://azure.archive.ubuntu.com/ubuntu\n'
}

# Step 4: bounded reachability probes with per-host DNS and per-URL caching.
declare -A dns_state=()
declare -A probe_state=()
declare -A pair_ok=()
declare -A pair_file=()
declare -A pair_token=()
declare -A pair_suite=()
pairs=()
PROBE_RESULT=''

host_of() {
  local rest=${1#*://}
  rest=${rest%%/*}
  printf '%s' "${rest%%:*}"
}

probe_base_suite() {
  local base=${1%/} suite=$2 host code key
  key="${base}|${suite}"
  if [[ -n ${probe_state[$key]+set} ]]; then
    PROBE_RESULT=${probe_state[$key]}
    return 0
  fi
  host=$(host_of "$base")
  if [[ -z ${dns_state[$host]+set} ]]; then
    if command -v timeout >/dev/null 2>&1; then
      if timeout "$probe_timeout" getent ahosts "$host" >/dev/null 2>&1; then
        dns_state[$host]=ok
      else
        dns_state[$host]=fail
      fi
    elif getent ahosts "$host" >/dev/null 2>&1; then
      dns_state[$host]=ok
    else
      dns_state[$host]=fail
    fi
  fi
  if [[ ${dns_state[$host]} != ok ]]; then
    probe_state[$key]=dns
    PROBE_RESULT=dns
    return 0
  fi
  code=$(curl --silent --show-error --location --max-time "$probe_timeout" \
    --output /dev/null --write-out '%{http_code}' \
    "${base}/dists/${suite}/InRelease" 2>/dev/null) || code=000
  if [[ $code =~ ^[23][0-9][0-9]$ ]]; then
    probe_state[$key]=ok
  else
    probe_state[$key]="http:${code:-000}"
  fi
  PROBE_RESULT=${probe_state[$key]}
}

while IFS=$'\t' read -r marker file kind token suite; do
  [[ $marker == ENTRY ]] || continue
  key="${file}|${token}|${suite}"
  if [[ -n ${pair_ok[$key]+set} ]]; then
    continue
  fi
  pair_file[$key]=$file
  pair_token[$key]=$token
  pair_suite[$key]=$suite
  if [[ $token == mirror+file:* ]]; then
    bases=''
    if [[ -f $mirror_file ]]; then
      bases=$(list_candidates | awk -F '\t' '!seen[$2]++ { printf "%s%s", sep, $2; sep=" " }')
    fi
    if [[ -z $bases ]]; then
      bases='http://archive.ubuntu.com/ubuntu http://azure.archive.ubuntu.com/ubuntu'
    fi
  else
    bases=$token
  fi
  ok=0
  for base in $bases; do
    probe_base_suite "$base" "$suite"
    if [[ $PROBE_RESULT == ok ]]; then
      ok=1
      break
    fi
  done
  pair_ok[$key]=$ok
  pairs+=("$key")
done < "$entries"

# Step 5: repair a dead single-host Ubuntu source when one mirror serves every
# suite declared with that source. Other unreachable hosts are warnings, not
# rewrites.
unresolved=$work/unresolved
: > "$unresolved"
declare -A group_suites=()
declare -A group_file=()
declare -A group_token=()
groups=()

for key in "${pairs[@]}"; do
  if [[ ${pair_ok[$key]} == 1 ]]; then
    continue
  fi
  group="${pair_file[$key]}|${pair_token[$key]}"
  if [[ -z ${group_suites[$group]-} ]]; then
    group_suites[$group]=${pair_suite[$key]}
    group_file[$group]=${pair_file[$key]}
    group_token[$group]=${pair_token[$key]}
    groups+=("$group")
  else
    group_suites[$group]+=" ${pair_suite[$key]}"
  fi
done

replace_token() {
  local file=$1 old=$2 new=$3 temp
  temp=$(mktemp)
  awk -v old="$old" -v new="$new" '
    {
      line = $0
      out = ""
      while ((position = index(line, old)) > 0) {
        out = out substr(line, 1, position - 1) new
        line = substr(line, position + length(old))
      }
      print out line
    }' "$file" > "$temp"
  run_root install -m 0644 "$temp" "$file"
  rm -f "$temp"
}

for group in "${groups[@]}"; do
  file=${group_file[$group]}
  token=${group_token[$group]}
  suites=${group_suites[$group]}
  resolved=0
  is_ubuntu=0
  if [[ $token == mirror+file:* ]]; then
    is_ubuntu=1
  elif [[ $token =~ ^https?:// ]] && [[ $(host_of "$token") == *.ubuntu.com ]]; then
    is_ubuntu=1
    seen=''
    while IFS=$'\t' read -r priority base; do
      [[ -n $base ]] || continue
      case " $seen " in
        *" $base "*) continue ;;
      esac
      seen="$seen $base"
      serves=1
      for suite in $suites; do
        probe_base_suite "$base" "$suite"
        if [[ $PROBE_RESULT != ok ]]; then
          serves=0
          break
        fi
      done
      if (( serves == 1 )); then
        replace_token "$file" "$token" "$base"
        echo "Moved unreachable Ubuntu source ${token} (${suites}) to ${base} in ${file}."
        resolved=1
        break
      fi
    done < <(list_candidates)
  fi
  if (( resolved == 1 )); then
    continue
  fi
  if (( is_ubuntu == 1 )); then
    printf '%s\t%s\t%s\n' "$file" "$token" "$suites" >> "$unresolved"
  else
    warn "Non-Ubuntu source ${token} (${suites}) in ${file} is unreachable. The helper does not rewrite it."
  fi
done

if [[ -s $unresolved ]]; then
  while IFS=$'\t' read -r file token suites; do
    printf '::error::Unusable Ubuntu APT source file=%s uri=%s suites=%s. No configured mirror serves these suites.\n' \
      "$file" "$token" "$suites" >&2
  done < "$unresolved"
  fail "No reachable Ubuntu APT source remains. Dependency installation would fail or wait for the step timeout."
fi

# Step 6: optional bounded index refresh. APT exits 0 when every index failed,
# so the output must be checked as well as the exit status.
if [[ $verify_index == 1 ]]; then
  refresh=$work/apt-update.log
  runner=()
  if command -v timeout >/dev/null 2>&1; then
    runner=(timeout 180)
  fi
  status=0
  set +e
  run_root "${runner[@]}" apt-get update \
    -o Acquire::Retries=1 \
    -o Acquire::http::Timeout=15 \
    -o Acquire::https::Timeout=15 > "$refresh" 2>&1
  status=$?
  set -e
  cat "$refresh"
  if (( status != 0 )) || grep -Eq 'Failed to fetch|Temporary failure resolving|Some index files failed to download' "$refresh"; then
    fail "APT index refresh failed with status ${status}. The package lists are incomplete."
  fi
fi

echo 'Effective APT network configuration:'
if command -v apt-config >/dev/null 2>&1; then
  apt-config dump Acquire::Retries Acquire::http::Timeout Acquire::https::Timeout 2>/dev/null || true
else
  cat "$conf_file"
fi
