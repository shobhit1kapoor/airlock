# Airlock

**Control what autonomous software can access.**

Airlock is a Konnect-controlled, locally executed zero-trust control plane for autonomous software agents. Kong is the enforcement point for model, MCP, and A2A traffic; the app projects Kong evidence into a focused operator console.

## Architecture

```text
Next.js control center → FastAPI → local Kong data plane ← Konnect AI Gateway
                                      ├─ AI Model: qwen3:8b → qwen2.5-coder:1.5b
                                      ├─ Git MCP listener: per-tool consumer ACLs
                                      └─ A2A: Planner / Research / Security / Coding
                                                   ↓
                                           PostgreSQL + SSE
```

All containers except Ollama run on `airlock-net`. The adapters reach the Windows-host Ollama instance through `host.docker.internal`. The OpenTelemetry Collector receives native Kong OTLP logs and forwards them to Airlock's OTLP ingestion endpoint.

## Why Kong is essential

Airlock does not make authorization decisions at the browser or FastAPI layer:

- Kong resolves every protected caller through one key-auth AI Auth Strategy and AI Consumer identity.
- Kong AI MCP Server listener ACLs decide whether a `tools/call` may be forwarded upstream.
- Kong AI Agent entities proxy real Agent Cards and A2A `message/send` traffic.
- Kong AI Model priority targets own retry and failover.
- Kong payload/audit logging is enabled on the managed entities in Konnect. A global Kong OpenTelemetry Policy emits native OTLP access logs to the local OpenTelemetry Collector, which forwards them to Airlock. Native OTEL logs and Airlock audit projections share `kong_request_id` and the same trace ID, while `LIVE`, `HISTORICAL`, and `SIMULATION` remain distinct.

## Local setup

1. Copy `.env.example` to `.env`, then set `KONNECT_TOKEN`. Run `scripts/bootstrap-konnect.sh` from WSL to provision Konnect. The checked-in `kong/konnect-data-plane.env` runs the generated mTLS data plane as `airlock-gateway` on `airlock-net` (host proxy port `18000`).
2. Set `KONNECT_AI_GATEWAY_ID`, then apply the checked-in AI entities:

   ```powershell
   kongctl apply -f kong/airlock.yaml --pat $env:KONNECT_TOKEN --auto-approve
   ```

   The MCP listener's per-tool ACLs are represented in `kong/mcp-passthrough.json` and applied with `scripts/create-mcp-passthrough.sh`; this keeps the listener mode that Kong uses for authenticated tool-level enforcement.

3. Ensure host Ollama has both models:

   ```powershell
   ollama pull qwen3:8b
   ollama pull qwen2.5-coder:1.5b
   ```

4. Start local services:

   ```powershell
   docker compose up --build
   ```

Open `http://localhost:3000`.

`otel-collector` starts with Docker Compose. Kong's global `airlock-opentelemetry` AI Policy exports OTLP logs to it automatically; no separate local log-tail process is needed.

## Policy compiler and drift control

Airlock keeps a small, reviewable desired-policy document in the API: Coding accepts only the `coding-callers` Consumer Group, while Research may use only `read_repository` and `search_code`. The operator console calls these endpoints against the live Konnect AI Gateway:

- `GET /api/policy/preview` shows the desired policy and the Kong entities it compiles to.
- `GET /api/policy/drift` compares the desired Coding caller allow list with the live Konnect agent configuration.
- `POST /api/policy/sync` restores that allow list through Konnect and writes a `LIVE` traceable policy-audit projection.

This is deliberately narrow for the MVP: the compiler restores an explicit allow list rather than making opaque, broad changes. The approval panel presents the concrete just-in-time capability, target repository, duration, and one-time versus timed grant semantics; the privileged key remains server-side.

## Judge demo

1. Run **Block destructive MCP call**. Research makes a real MCP `tools/call` for `delete_repository`; Kong returns 403 and the Git MCP destructive counter remains zero.
2. Run **Enforce agent isolation**. Research sends an A2A `message/send` to Coding; Kong denies it before Coding receives it.
3. Run **Request human approval**, then select **Approve once**. The backend uses the server-only `approval-coding-agent` identity for the persisted grant and consumes the grant after success.
4. Run **Fail over model target**. The primary Ollama adapter returns 503; Kong retries the same client POST on the Qwen 2.5 fallback. Adapter counters prove the primary failure and fallback success in one request.

## Security model

- `.env` is ignored and contains Konnect/PAT values only locally.
- `approval-coding-agent` credentials are backend-only and never returned by the API.
- Normal Coding cannot call `create_branch`; Research cannot call `delete_repository`.
- A2A destination controls use explicit allow lists. The `coding-callers` AI Consumer Group contains only Planner and Security, so Coding permits only those two identities.
- The Git MCP server exposes only `read_repository`, `search_code`, `create_branch`, and `delete_repository`.

## Verification

```powershell
docker compose up -d --build
docker compose exec -T api pytest

cd web
npm install
npm run build

cd ..
.\scripts\smoke.ps1
```

The smoke suite performs the four Konnect-connected demonstrations, including the upstream counter assertions and the exact primary/fallback adapter evidence. It never prints local credentials.

## Evidence captured during bootstrap

- MCP `tools/list` as `research-agent` exposes only `read_repository` and `search_code`.
- MCP `tools/call(delete_repository)` as Research returns `403`; the Git MCP counter remains `0`.
- Research `message/send` to Coding returns `403`; Coding's A2A counter remains `0`.
- Approval once uses the backend-only `approval-coding-agent` key; its `create_branch` counter increments and the persisted grant becomes `CONSUMED`.
- With the primary adapter faulted, one client request produces one failed primary attempt and one successful fallback attempt.
