# Konnect-managed gateway configuration

`airlock.yaml` is the source of truth for the current Kong AI Gateway entity model. Apply it after running Kong's AI Gateway quickstart with a Konnect PAT:

```bash
kongctl apply -f kong/airlock.yaml --pat "$KONNECT_TOKEN" --auto-approve
```

The quickstart creates the Konnect control plane and local data plane. `kong.local.yml` is intentionally a minimal local fallback for UI/API development only; the four judge demonstrations require the Konnect-managed entities in `airlock.yaml`.
