#!/usr/bin/env bash

set -euo pipefail

mirror_file=/etc/apt/apt-mirrors.txt
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
Acquire::Retries "1";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
EOF

echo 'Effective APT network configuration:'
apt-config dump Acquire::Retries Acquire::http::Timeout Acquire::https::Timeout
