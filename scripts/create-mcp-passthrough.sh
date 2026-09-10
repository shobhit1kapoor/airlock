#!/bin/sh
set -eu
curl --fail-with-body -sS -X POST \
  "https://us.api.konghq.com/v1/ai-gateways/${KONNECT_AI_GATEWAY_ID}/mcp-servers" \
  -H "Authorization: Bearer ${KONNECT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data-binary @/workspace/mcp-passthrough.json
