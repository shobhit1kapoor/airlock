# Airlock

**Control what autonomous software can access.**

Airlock is a zero-trust control plane for multi-agent software engineering workflows. It gives every agent a distinct identity, lets Kong enforce the agent’s permitted destinations and MCP tools, and retains trace-correlated evidence for an operator to inspect.

Airlock uses **Kong Konnect as the configuration control plane** and a **local Kong data plane as the enforcement point**. The web application, FastAPI API, agents, MCP server, PostgreSQL, OpenTelemetry Collector, and model adapters run locally on Docker network `airlock-net`. Ollama may remain on the Windows host and is reached through `host.docker.internal`.

> Airlock is an evidence-led prototype, not a dashboard that merely describes policies. Its four primary demonstrations make real requests through Kong.

## What it demonstrates

| Demonstration | Real request | Kong-enforced result | Proof shown in Airlock |
| --- | --- | --- | --- |
| Destructive MCP denial | Research calls MCP `tools/call(delete_repository)` | HTTP `403`; request is not forwarded upstream | Kong OTEL log, matching audit row, destructive tool counter stays `0` |
| A2A destination denial | Research sends JSON-RPC `message/send` to Coding | HTTP `403` before Coding receives it | Kong OTEL log, matching audit row, Coding received-counter unchanged |
| Human-approved branch creation | Coding requests `create_branch`; operator approves once | Backend-only approval identity makes one privileged MCP call | persisted grant, trace ID, successful tool call, consumed grant |
| Kong-owned model recovery | Primary Ollama adapter returns `503` | Kong retries the same client request on the fallback target | primary and fallback adapter counters plus a successful workflow response |

## Architecture

```text
                                      KONNECT CONTROL PLANE
                             AI Gateway entities, policy, visibility
                                               │
                                    manages local data plane
                                               │
┌────────────────────────────────── airlock-net ──────────────────────────────────┐
│ Browser → Next.js operator console → FastAPI control API                         │
│                                        │                                         │
│                                        │ trace-correlated request                │
│                                        ▼                                         │
│                              Local Kong data plane                               │
│                  authenticate → authorize → proxy → retry → emit OTEL            │
│                    ┌──────────────────┼───────────────────┐                     │
│                    ▼                  ▼                   ▼                     │
│               AI Model            MCP listener          A2A agents               │
│                    │                  │                   │                     │
│              Ollama adapters       Git MCP server   Planner / Research /         │
│                    │                             Security / Coding               │
│                    └───── host.docker.internal:11434 ──────► Ollama              │
│                                                                            │      │
│ Kong OTLP logs → OpenTelemetry Collector → FastAPI OTLP ingestion → PostgreSQL  │
│                                                                    │              │
│                                                                    └── SSE → UI   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Control plane and data plane responsibilities

| Component | Responsibility | Where it runs |
| --- | --- | --- |
| Konnect | Stores and manages AI Gateway entities and policy | Kong-hosted control plane |
| Kong data plane | Resolves consumer identity, evaluates ACLs, forwards traffic, retries models, emits telemetry | Local Kong quickstart data plane |
| FastAPI | Starts test requests, persists approvals and projections, consumes OTLP, streams SSE | Docker |
| Next.js | Operator console: Overview, Agent Graph, Attack Lab, Approvals, MCP Tools, Models, Traffic & Audit | Docker |
| PostgreSQL | Durable approval and event projection store | Docker |
| MCP / A2A services | Small upstreams designed to prove whether Kong actually forwarded a request | Docker |
| Ollama | Local models | Windows host |

## Kong configuration model

[`kong/airlock.yaml`](kong/airlock.yaml) is the checked-in source of truth for the current Kong AI Gateway entity model. It avoids application-owned authorization and legacy route-only approximations.

### Authentication and consumer identity

Airlock creates one key-auth AI Auth Strategy, `airlock-key-auth`, and attaches it to every protected entity:

- `airlock-code-model` (AI Model)
- Planner, Research, Security, and Coding (A2A AI Agents)
- Git MCP listener (AI MCP Server)

Every caller supplies an `apikey`. Kong resolves it to an AI Consumer **before** evaluating an ACL.

| AI Consumer | Purpose | Credential boundary |
| --- | --- | --- |
| `planner-agent` | Starts permitted work | local agent runtime |
| `research-agent` | Reads and searches repository context | local agent runtime |
| `security-agent` | Reviews risk and may contact Coding | local agent runtime |
| `coding-agent` | Performs normal bounded work | local agent runtime |
| `approval-coding-agent` | Executes an approved branch operation | **FastAPI only** |

The `approval-coding-agent` key is never returned by an API and never reaches the browser or a normal agent runtime.

### A2A policy

Each upstream agent serves an Agent Card at `/.well-known/agent-card.json` and accepts JSON-RPC `message/send`. Kong exposes them as A2A AI Agent entities.

Coding uses an explicit allow-list Consumer Group named `coding-callers`. That group contains only `planner-agent` and `security-agent`; it deliberately excludes `research-agent`.

```text
Planner  ─────────────── allow ──► Coding
Security ─────────────── allow ──► Coding
Research ───── Kong 403 / deny ──► Coding upstream never receives the message
```

This means the A2A denial is not an application convention. It is a gateway decision made before the Coding agent’s upstream handler executes.

### MCP listener and tool policy

Airlock uses an AI MCP Server listener, not a custom destructive REST route. The exact tool names are consistent across policy, tests, evidence, and the upstream MCP server:

- `read_repository`
- `search_code`
- `create_branch`
- `delete_repository`

[`kong/mcp-passthrough.json`](kong/mcp-passthrough.json) defines consumer-based default and per-tool listener rules:

| Tool | Access policy |
| --- | --- |
| `read_repository` | Normal authenticated consumers allowed |
| `search_code` | Normal authenticated consumers allowed |
| `create_branch` | `approval-coding-agent` only |
| `delete_repository` | `security-agent` only; Research is denied |

The listener preserves upstream tool names. A blocked `delete_repository` request therefore produces a Kong `403`, while the MCP server’s own `delete_repository` counter proves that the forbidden tool never executed.

### Kong-owned model routing and failover

`airlock-code-model` has two priority targets managed by Kong:

| Target | Adapter | Priority / weight | Model |
| --- | --- | --- | --- |
| Primary | `ollama-primary-adapter` | `100` | `qwen3:8b` |
| Fallback | `ollama-fallback-adapter` | `10` | `qwen2.5-coder:1.5b` |

The model configuration uses priority balancing, one retry, and explicit failure criteria including `http_503` and `non_idempotent`. The latter explicitly permits retrying an eligible failed POST chat-completion request on the fallback target.

FastAPI sends one request. It does **not** select the fallback. The adapter services expose a fault switch and counters solely to make this evidence visible:

```text
one client request
  → primary adapter attempts qwen3:8b
  → primary returns 503
  → Kong retries the same request
  → fallback adapter attempts qwen2.5-coder:1.5b
  → workflow succeeds
```

## Human approval model

Kong enforces access; Airlock owns the human approval workflow. This separation matters.

1. `coding-agent` requests `create_branch` and Airlock stores a `PENDING` approval in PostgreSQL.
2. An operator chooses **Approve once** or a time-bound approval.
3. FastAPI, and only FastAPI, uses `approval-coding-agent` to make the approved MCP request through Kong.
4. A successful one-use request changes the persisted grant to `CONSUMED`. Time-bound grants retain an explicit expiry.

Kong is still in the path of the privileged request. Airlock never grants a browser-side bypass.

## Telemetry, audit, and provenance

Kong’s global OpenTelemetry policy exports native access logs to the local `otel-collector`. The collector forwards those records to FastAPI’s `/v1/logs` OTLP endpoint. FastAPI persists a trace-correlated projection in PostgreSQL and streams changes to the dashboard with server-sent events.

Correlation sequence:

1. Airlock starts a demonstration with `X-Airlock-Trace-Id`.
2. The request passes through Kong, which adds a request ID and exports OTLP evidence.
3. Airlock receives the OTLP record and joins it to the local audit projection using trace ID and, where present, Kong request ID.

The dashboard labels every event to make provenance clear:

| Label | Meaning |
| --- | --- |
| `LIVE` | Generated by a current request, telemetry record, or operator action |
| `HISTORICAL` | Restored from persisted PostgreSQL state after restart |
| `SIMULATION` | Reserved for non-live data and never presented as Kong-originated proof |

## Repository layout

```text
airlock/
├── api/                         FastAPI API, persistence, SSE, OTLP ingestion
├── kong/
│   ├── airlock.yaml             Konnect AI Gateway entities
│   ├── mcp-passthrough.json     listener-mode MCP per-tool rules
│   └── kong.local.yml           minimal local UI/API fallback only
├── services/
│   ├── a2a-agent/               Agent Card, JSON-RPC handler, counter
│   ├── mcp-server/              MCP upstream and exact-tool counters
│   └── ollama-adapter/          faultable Ollama adapters and counters
├── web/                         Next.js operator console
├── scripts/                     Konnect bootstrap and end-to-end smoke suite
├── otel-collector-config.yaml   OTLP log pipeline
├── docker-compose.yml           local runtime on airlock-net
└── videos/                      demo-video project source; generated renders ignored
```

## Prerequisites

- Docker Desktop with Linux containers and Docker Compose v2
- Windows host with [Ollama](https://ollama.com/) running
- Local models: `qwen3:8b` and `qwen2.5-coder:1.5b`
- Kong Konnect account and a local-only personal access token
- `kongctl`
- PowerShell for the smoke suite; WSL is recommended for the Kong quickstart wrapper

## Local setup

### 1. Create local configuration

```powershell
Copy-Item .env.example .env
```

Set `KONNECT_TOKEN`, `KONNECT_AI_GATEWAY_ID`, and five distinct consumer keys. Never reuse one key between agents. In WSL, a suitable local value can be generated with `openssl rand -hex 32`.

`.env`, `.konnect-bootstrap/`, and `kong/konnect-data-plane.env` are intentionally ignored by Git.

### 2. Provision the Konnect-controlled local data plane

From WSL, make the local PAT available and run:

```bash
export KONNECT_TOKEN='your-local-token'
./scripts/bootstrap-konnect.sh
```

This wraps Kong’s AI Gateway quickstart and creates the Konnect-connected local data plane. Generated mTLS material is local-only. The local proxy is exposed on host port `18000`.

> `kong/kong.local.yml` is for local UI/API development. The four live demonstrations require the Konnect-managed entities in `kong/airlock.yaml`.

### 3. Apply AI Gateway entities

```powershell
kongctl apply -f kong/airlock.yaml --pat $env:KONNECT_TOKEN --auto-approve
```

Apply the MCP passthrough-listener rules with the equivalent request in [`scripts/create-mcp-passthrough.sh`](scripts/create-mcp-passthrough.sh). Run it in an environment where `KONNECT_TOKEN`, `KONNECT_AI_GATEWAY_ID`, and `kong/mcp-passthrough.json` are available.

### 4. Prepare local models

```powershell
ollama pull qwen3:8b
ollama pull qwen2.5-coder:1.5b
```

Adapters call `host.docker.internal:11434` by default. Override `PRIMARY_OLLAMA_URL` or `FALLBACK_OLLAMA_URL` in `.env` only when necessary.

### 5. Start Airlock

```powershell
docker compose up --build
```

Open:

- Control Center: `http://localhost:3000`
- API health: `http://localhost:8001/health`
- Kong proxy: `http://localhost:18000`

All Docker services join `airlock-net`; Ollama is the intentional host-side exception.

## Demo flow

Use **Attack lab** to run all four live proofs. Each run opens a detailed result sheet and writes evidence to **Traffic & audit**.

1. **Destructive MCP denial**: Research calls `delete_repository`; expect Kong `403` and upstream counter `0`.
2. **A2A destination denial**: Research sends `message/send` to Coding; expect Kong `403` and no Coding receipt.
3. **Approval-gated branch**: create a request, open **Approvals**, then use **Approve once**; expect the server-only approval identity and a consumed grant.
4. **Kong-owned model recovery**: force the primary adapter failure; expect a successful retry through the fallback target without FastAPI model selection.
5. **Traffic & audit**: inspect the matching trace record and its native Kong attributes.

## Verification

```powershell
# Start the full local runtime.
docker compose up -d --build

# Backend contract tests.
docker compose exec -T api pytest -q

# Frontend production build.
Push-Location web
npm install
npm run build
Pop-Location

# End-to-end Konnect-connected validation.
.\scripts\smoke.ps1
```

The smoke suite proves an allowed Planner → Coding message, a denied Research → Coding message, a blocked destructive MCP tool with counter `0`, approval consumption, and model primary/fallback evidence.

## Operational and security notes

- Do not commit Konnect PATs, generated data-plane credentials, `.env`, or real consumer keys.
- Do not represent historical or simulated records as native Kong telemetry.
- The local-first architecture is intentional: a production deployment would need managed secrets, encrypted storage, hardened network policies, a durable OTLP collector, and a production model runtime before it should be exposed publicly.
- Generated recordings, video renders, screenshots, caches, and `node_modules` are ignored by Git. The video source and recording script are retained.

## Project scope

Airlock deliberately freezes scope around four complete, provable flows rather than adding unverified prompt-injection, token-exhaustion, rate-limit, or extra-agent simulations. The value proposition is clear enforcement with evidence: identity, policy, decision, upstream proof, and trace correlation.
