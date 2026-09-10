#!/bin/sh
set -eu

: "${KONNECT_TOKEN:?KONNECT_TOKEN must be set}"
exec /kongctl apply -f /workspace/airlock.yaml --auto-approve --pat "$KONNECT_TOKEN"
