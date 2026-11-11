#!/usr/bin/env bash

set -euo pipefail

mirror_file=/etc/apt/apt-mirrors.txt
if [[ -f "$mirror_file" ]]; then
  # The security.ubuntu.com entry can fail DNS on a hosted runner while the
  # archive and azure mirrors still serve the noble-security suite. Remove it
  # so apt does not stop on the unreachable host.
  sudo sed -i '/security\.ubuntu\.com/d' "$mirror_file"
fi
if [[ -f "$mirror_file" ]] \
  && grep -Eq '^https?://azure\.archive\.ubuntu\.com/ubuntu/[[:space:]]+priority:[0-9]+$' "$mirror_file" \
  && grep -Eq '^https?://archive\.ubuntu\.com/ubuntu/[[:space:]]+priority:[0-9]+$' "$mirror_file"; then
  sudo sed -E -i \
    -e 's|^(https?://azure\.archive\.ubuntu\.com/ubuntu/)[[:space:]]*priority:[0-9]+$|\1 priority:2|' \
    -e 's|^(https?://archive\.ubuntu\.com/ubuntu/)[[:space:]]*priority:[0-9]+$|\1 priority:1|' \
    "$mirror_file"
else
  echo '::warning::Expected Ubuntu mirror entries are unavailable. Keeping the runner mirror configuration.'
fi

sudo tee /etc/apt/apt.conf.d/zzz-mdsh-ci-network >/dev/null <<'EOF'
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
EOF

echo 'Effective APT network configuration:'
apt-config dump Acquire::Retries Acquire::http::Timeout Acquire::https::Timeout
