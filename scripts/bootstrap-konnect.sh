#!/usr/bin/env bash
set -euo pipefail

# Run Kong's official AI Gateway quickstart against Docker Desktop, rather than
# Ubuntu's separate Docker daemon. The project services and the data plane must
# share Docker Desktop's airlock-net.
docker() {
  "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" "$@"
}
export -f docker

: "${KONNECT_TOKEN:?KONNECT_TOKEN must be supplied through WSLENV}"
export OUTPUT_DIR="/mnt/c/Users/shobh/OneDrive/Documents/ChatGPT/kong/airlock/.konnect-bootstrap"

curl -Ls https://get.konghq.com/ai | bash -s -- \
  -k "$KONNECT_TOKEN" \
  -a airlock \
  -n airlock \
  -p 18000:8000 \
  -p 18443:8443 \
  -p 18001:8001 \
  -p 18002:8002 \
  -p 18003:8003 \
  -p 18004:8004
