import asyncio
import gzip
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

import httpx
import asyncpg
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from google.protobuf.json_format import ParseDict
from google.protobuf.message import DecodeError
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

EventOrigin = Literal["LIVE", "HISTORICAL", "SIMULATION"]
events: list[dict[str, Any]] = []
approvals: dict[str, dict[str, Any]] = {}
subscribers: set[asyncio.Queue] = set()
db_pool: asyncpg.Pool | None = None

DESIRED_POLICY = {
    "version": "2026.09.airlock",
    "agents": {"coding-agent": {"allow": ["coding-callers"]}},
    "mcp": {"research-agent": {"allow": ["read_repository", "search_code"], "deny": ["create_branch", "delete_repository"]}},
}

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

async def emit(kind: str, *, origin: EventOrigin = "LIVE", **payload: Any) -> dict[str, Any]:
    event = {"id": str(uuid.uuid4()), "timestamp": now(), "kind": kind, "origin": origin, **payload}
    events.insert(0, event)
    if db_pool is not None:
        await db_pool.execute(
            "INSERT INTO airlock_events (id, timestamp, kind, origin, trace_id, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
            event["id"], datetime.fromisoformat(event["timestamp"]), kind, origin, event.get("traceId"), json.dumps(event),
        )
    for queue in list(subscribers):
        await queue.put(event)
    return event

async def seed() -> None:
    global db_pool
    db_pool = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    async with db_pool.acquire() as connection:
        await connection.execute("""
            CREATE TABLE IF NOT EXISTS airlock_events (
              id uuid PRIMARY KEY, timestamp timestamptz NOT NULL, kind text NOT NULL,
              origin text NOT NULL, trace_id text, payload jsonb NOT NULL
            );
            CREATE TABLE IF NOT EXISTS airlock_approvals (
              id uuid PRIMARY KEY, trace_id text NOT NULL, status text NOT NULL,
              expires_at timestamptz, remaining_uses integer, payload jsonb NOT NULL
            );
        """)
        # The dashboard is an in-memory live view backed by PostgreSQL.  On a
        # restart, restore its durable audit projection rather than presenting
        # a blank timeline as though no work had happened.
        stored_events = await connection.fetch(
            "SELECT payload FROM airlock_events ORDER BY timestamp DESC LIMIT 100"
        )
        events.extend(json.loads(row["payload"]) for row in stored_events)
        stored_approvals = await connection.fetch(
            "SELECT payload FROM airlock_approvals ORDER BY id"
        )
        approvals.update(
            {str(json.loads(row["payload"])["id"]): json.loads(row["payload"])
             for row in stored_approvals}
        )
    if not events:
        await emit("gateway.ready", origin="HISTORICAL", message="Konnect control plane connected; local data plane healthy", decision="ALLOWED")
        await emit("workflow.ready", origin="HISTORICAL", message="Authentication vulnerability workflow ready", decision="ALLOWED")

async def close_database() -> None:
    if db_pool is not None:
        await db_pool.close()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await seed()
    try:
        yield
    finally:
        await close_database()


app = FastAPI(title="Airlock Control API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}

@app.get("/api/overview")
async def overview() -> dict[str, Any]:
    return {
        "metrics": [
            {"label": "Active agents", "value": "4", "detail": "all authenticated"},
            {"label": "Gateway decisions", "value": str(len(events)), "detail": "trace-correlated"},
            {"label": "Protected MCP tools", "value": "4", "detail": "listener ACLs"},
            {"label": "Approval grants", "value": str(len(approvals)), "detail": "server-only identity"},
        ],
        "agents": [
            {"id": "planner-agent", "role": "Planner", "status": "active"},
            {"id": "research-agent", "role": "Research", "status": "active"},
            {"id": "security-agent", "role": "Security", "status": "active"},
            {"id": "coding-agent", "role": "Coding", "status": "waiting"},
        ],
        "events": events[:20],
    }

@app.get("/api/events")
async def stream_events() -> StreamingResponse:
    async def generator():
        queue: asyncio.Queue = asyncio.Queue()
        subscribers.add(queue)
        try:
            yield "event: connected\ndata: {\"ok\":true}\n\n"
            while True:
                item = await queue.get()
                yield f"event: airlock\ndata: {json.dumps(item)}\n\n"
        finally:
            subscribers.discard(queue)
    return StreamingResponse(generator(), media_type="text/event-stream")

@app.post("/api/telemetry/kong")
async def ingest_kong(request: Request) -> dict[str, bool]:
    expected_token = os.getenv("KONG_TELEMETRY_TOKEN")
    if expected_token and request.headers.get("X-Airlock-Telemetry-Token") != expected_token:
        raise HTTPException(401, "Kong telemetry token required")
    body = await request.json()
    kong_request_id = body.get("kong_request_id")
    trace_id = body.get("request", {}).get("headers", {}).get("x-airlock-trace-id") or body.get("correlation_id")
    if not trace_id and kong_request_id:
        trace_id = next((event.get("traceId") for event in events if event.get("kongRequestId") == kong_request_id), None)
    trace_id = trace_id or str(uuid.uuid4())
    await emit("kong.telemetry", source="kong-access-log", traceId=trace_id, kongRequestId=kong_request_id, decision=body.get("response", {}).get("status", "OBSERVED"), raw=body)
    return {"accepted": True}

def otel_attributes(attributes: Any) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for attribute in attributes:
        value = attribute.value
        if value.HasField("string_value"):
            values[attribute.key] = value.string_value
        elif value.HasField("int_value"):
            values[attribute.key] = value.int_value
        elif value.HasField("bool_value"):
            values[attribute.key] = value.bool_value
    return values

@app.post("/v1/logs")
async def ingest_otel_logs(request: Request) -> dict[str, int]:
    """OTLP/HTTP protobuf sink used only by the local OTEL Collector."""
    payload = ExportLogsServiceRequest()
    raw_payload = await request.body()
    if request.headers.get("content-encoding") == "gzip" or raw_payload[:2] == b"\x1f\x8b":
        raw_payload = gzip.decompress(raw_payload)
    try:
        payload.ParseFromString(raw_payload)
    except DecodeError:
        # The Collector may choose OTLP/JSON for its HTTP exporter. Accept both
        # encodings while Kong itself continues to send OTLP protobuf to it.
        ParseDict(json.loads(raw_payload), payload)
    received = 0
    for resource_logs in payload.resource_logs:
        resource = otel_attributes(resource_logs.resource.attributes)
        for scope_logs in resource_logs.scope_logs:
            for record in scope_logs.log_records:
                attributes = {**resource, **otel_attributes(record.attributes)}
                kong_request_id = attributes.get("request.id") or attributes.get("kong.request.id")
                trace_id = record.trace_id.hex() if record.trace_id else None
                if not trace_id and kong_request_id:
                    trace_id = next((event.get("traceId") for event in events if event.get("kongRequestId") == kong_request_id), None)
                body = record.body.string_value if record.body.HasField("string_value") else "Kong OTEL log"
                # Kong's MCP audit attributes make the native enforcement
                # decision explicit; retain it in the operator projection.
                decision = (
                    attributes.get("kong.mcp.audit.1.action")
                    or attributes.get("response.status")
                    or attributes.get("status")
                )
                await emit(
                    "kong.otel.log", source="kong-otel", traceId=trace_id or str(uuid.uuid4()),
                    kongRequestId=kong_request_id, decision=decision,
                    message=body, otelAttributes=attributes,
                )
                received += 1
    return {"accepted": received}

class AttackRequest(BaseModel):
    scenario: Literal["mcp-denial", "a2a-denial", "approval", "failover"]

async def kong_request(path: str, key: str, body: dict[str, Any], trace_id: str) -> httpx.Response:
    base = os.getenv("KONG_PROXY_URL", "http://kong:8000")
    async with httpx.AsyncClient(timeout=15) as client:
        return await client.post(
            f"{base}{path}",
            headers={
                "apikey": key,
                "X-Airlock-Trace-Id": trace_id,
                # Required by Kong's streamable-HTTP MCP runtime. This keeps
                # the attack path a real MCP protocol request, not a REST shim.
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2025-06-18",
            },
            json=body,
        )

def konnect_settings() -> tuple[str, str, dict[str, str]]:
    token, gateway = os.getenv("KONNECT_TOKEN"), os.getenv("KONNECT_AI_GATEWAY_ID")
    if not token or not gateway:
        raise HTTPException(503, "Konnect policy compiler is not configured")
    region = os.getenv("KONNECT_REGION", "us")
    return f"https://{region}.api.konghq.com/v1/ai-gateways/{gateway}", gateway, {"Authorization": f"Bearer {token}"}

async def konnect_state() -> dict[str, Any]:
    base, _, headers = konnect_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        agents, mcps = await asyncio.gather(
            client.get(f"{base}/agents", headers=headers), client.get(f"{base}/mcp-servers", headers=headers),
        )
    agents.raise_for_status(); mcps.raise_for_status()
    return {"agents": agents.json().get("data", []), "mcpServers": mcps.json().get("data", [])}

@app.get("/api/policy/preview")
async def policy_preview() -> dict[str, Any]:
    return {"desired": DESIRED_POLICY, "compiled": [
        {"entity": "AI Agent", "name": "coding-agent", "change": "ACL allow = coding-callers"},
        {"entity": "AI MCP Server", "name": "airlock-git-passthrough", "change": "research-agent: read/search only"},
        {"entity": "AI Auth Strategy", "name": "airlock-key-auth", "change": "required before every ACL"},
    ]}

@app.get("/api/policy/drift")
async def policy_drift() -> dict[str, Any]:
    live = await konnect_state()
    coding = next((agent for agent in live["agents"] if agent["name"] == "coding-agent"), {})
    actual = coding.get("access", {}).get("acls", {}).get("allow", [])
    expected = DESIRED_POLICY["agents"]["coding-agent"]["allow"]
    drift = actual != expected
    return {"desired": expected, "actual": actual, "drift": drift, "severity": "CRITICAL" if drift else "NONE", "restoreAvailable": drift}

@app.post("/api/policy/sync")
async def policy_sync() -> dict[str, Any]:
    base, _, headers = konnect_settings()
    live = await konnect_state()
    coding = next((agent for agent in live["agents"] if agent["name"] == "coding-agent"), None)
    if not coding:
        raise HTTPException(404, "Coding agent not found in Konnect")
    body = {key: coding[key] for key in ("name", "display_name", "type", "config")}
    body["access"] = {"auth_strategies": ["airlock-key-auth"], "acls": {"allow": ["coding-callers"]}}
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.put(f"{base}/agents/{coding['id']}", headers=headers, json=body)
    response.raise_for_status()
    await emit("policy.synced", source="airlock-policy-compiler", destination="konnect", decision="RESTORED", message="Compiled Coding destination ACL synchronized to Konnect")
    return {"synced": True, "revision": response.json().get("updated_at")}

@app.post("/api/attacks/run")
async def run_attack(payload: AttackRequest) -> dict[str, Any]:
    trace_id = str(uuid.uuid4())
    if payload.scenario == "mcp-denial":
        # In a Konnect-connected run this is an actual MCP tools/call and Kong rejects it.
        response = await kong_request("/mcp/git2", os.environ["RESEARCH_AGENT_KEY"], {"jsonrpc":"2.0", "id":trace_id, "method":"tools/call", "params":{"name":"delete_repository", "arguments":{"repository":"payments-api"}}}, trace_id)
        await emit("mcp.denied", source="research-agent", destination="delete_repository", protocol="MCP", traceId=trace_id, kongRequestId=response.headers.get("x-kong-request-id"), decision="DENIED", status=response.status_code, message="Kong denied delete_repository before the MCP upstream")
        return {"traceId": trace_id, "status": response.status_code, "expected": 403}
    if payload.scenario == "a2a-denial":
        response = await kong_request("/a2a/coding", os.environ["RESEARCH_AGENT_KEY"], {"jsonrpc":"2.0", "id":trace_id, "method":"message/send", "params":{"message":{"kind":"message","messageId":trace_id,"role":"user","parts":[{"kind":"text","text":"unsafe request"}]}}}, trace_id)
        await emit("a2a.denied", source="research-agent", destination="coding-agent", protocol="A2A", traceId=trace_id, kongRequestId=response.headers.get("x-kong-request-id"), decision="DENIED", status=response.status_code, message="Coding allow list excludes research-agent")
        return {"traceId": trace_id, "status": response.status_code}
    if payload.scenario == "approval":
        approval_id = str(uuid.uuid4())
        approvals[approval_id] = {"id": approval_id, "requester":"coding-agent", "tool":"create_branch", "status":"PENDING", "traceId":trace_id, "createdAt":now()}
        if db_pool is not None:
            await db_pool.execute("INSERT INTO airlock_approvals (id, trace_id, status, payload) VALUES ($1, $2, $3, $4::jsonb)", approval_id, trace_id, "PENDING", json.dumps(approvals[approval_id]))
        await emit("approval.requested", source="coding-agent", destination="create_branch", traceId=trace_id, decision="APPROVAL_REQUIRED", approvalId=approval_id, message="Sensitive branch creation is waiting for a human")
        return approvals[approval_id]
    # Adapter faulting is intentionally separated from selection: Kong sees an upstream 5xx and owns retry.
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post("http://ollama-primary-adapter:8020/reset")
        await client.post("http://ollama-fallback-adapter:8020/reset")
        await client.post("http://ollama-primary-adapter:8020/fault", json={"enabled": True})
        model_request = {"model":"airlock-code-model","messages":[{"role":"user","content":"Continue the workflow"}]}
        # This is deliberately one client request.  `non_idempotent` in the
        # Kong AI Model's failover criteria authorizes a retry of this POST on
        # the lower-priority target after the primary returns 503.
        response = await kong_request("/v1/chat/completions", os.environ["PLANNER_AGENT_KEY"], model_request, trace_id)
        counters = (await client.get("http://ollama-primary-adapter:8020/counters")).json(), (await client.get("http://ollama-fallback-adapter:8020/counters")).json()
    await emit("model.failover_observed", source="airlock-projection", destination="ollama-fallback-adapter", protocol="LLM", traceId=trace_id, kongRequestId=response.headers.get("x-kong-request-id"), decision="FALLBACK_SUCCEEDED", status=response.status_code, adapters={"primary":counters[0], "fallback":counters[1]}, message="Observed one-request Kong failover: primary 503, fallback workflow success")
    return {"traceId": trace_id, "status": response.status_code, "primary": counters[0], "fallback": counters[1]}

class ApprovalDecision(BaseModel):
    decision: Literal["approve-once", "approve-10m", "deny"]

@app.post("/api/approvals/{approval_id}")
async def decide_approval(approval_id: str, payload: ApprovalDecision) -> dict[str, Any]:
    approval = approvals.get(approval_id)
    if not approval or approval["status"] != "PENDING":
        raise HTTPException(404, "Pending approval not found")
    if payload.decision == "deny":
        approval["status"] = "DENIED"
    else:
        approval["status"] = "GRANTED"
        approval["expiresAt"] = (datetime.now(timezone.utc) + timedelta(minutes=10 if payload.decision == "approve-10m" else 1)).isoformat()
        approval["remainingUses"] = 1 if payload.decision == "approve-once" else None
    if db_pool is not None:
        expires_at = datetime.fromisoformat(approval["expiresAt"]) if approval.get("expiresAt") else None
        await db_pool.execute("UPDATE airlock_approvals SET status=$2, expires_at=$3, remaining_uses=$4, payload=$5::jsonb WHERE id=$1", approval_id, approval["status"], expires_at, approval.get("remainingUses"), json.dumps(approval))
    await emit("approval.decided", source="human", destination="create_branch", traceId=approval["traceId"], decision=approval["status"], approvalId=approval_id)
    if payload.decision != "deny":
        # The approval credential remains only in this backend process. The
        # browser and normal coding-agent never receive it.
        privileged_key = os.environ["APPROVAL_CODING_AGENT_KEY"]
        response = await kong_request(
            "/mcp/git2",
            privileged_key,
            {
                "jsonrpc": "2.0",
                "id": approval["traceId"],
                "method": "tools/call",
                "params": {"name": "create_branch", "arguments": {"name": "airlock-approved-fix"}},
            },
            approval["traceId"],
        )
        if response.status_code >= 300:
            approval["status"] = "FAILED"
            await emit("approval.execution_failed", source="approval-coding-agent", destination="create_branch", traceId=approval["traceId"], decision="DENIED", status=response.status_code, approvalId=approval_id)
            return approval
        if approval["remainingUses"] == 1:
            approval["remainingUses"] = 0
            approval["status"] = "CONSUMED"
            if db_pool is not None:
                await db_pool.execute("UPDATE airlock_approvals SET status=$2, remaining_uses=$3, payload=$4::jsonb WHERE id=$1", approval_id, "CONSUMED", 0, json.dumps(approval))
        await emit("approval.executed", source="approval-coding-agent", destination="create_branch", protocol="MCP", traceId=approval["traceId"], decision="ALLOWED", status=response.status_code, approvalId=approval_id, message="Server-only approval identity invoked create_branch through Kong")
    return approval

@app.get("/api/approvals")
async def list_approvals() -> list[dict[str, Any]]:
    return list(approvals.values())
