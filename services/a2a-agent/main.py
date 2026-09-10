import os
import uuid
from fastapi import FastAPI
from pydantic import BaseModel

agent_id = os.getenv("AGENT_ID", "agent")
received = 0
app = FastAPI(title=f"{agent_id} A2A agent")

@app.get("/.well-known/agent-card.json")
async def card():
    return {"name": agent_id, "version": "0.1.0", "protocolVersion": "0.3.0", "description": f"Airlock {agent_id}", "url": f"http://{agent_id}:8030/", "preferredTransport":"JSONRPC", "capabilities":{"streaming":True}, "skills":[{"id":"secure-workflow","name":"Secure workflow","description":"Airlock software engineering task"}]}

@app.post("/")
async def message(request: dict):
    global received
    received += 1
    request_id = request.get("id", str(uuid.uuid4()))
    return {"jsonrpc":"2.0", "id":request_id, "result":{"id":str(uuid.uuid4()), "status":{"state":"completed"}, "artifacts":[{"parts":[{"kind":"text", "text":f"{agent_id} accepted secure task"}]}]}}

@app.get("/counters")
async def counters():
    return {"agent": agent_id, "received": received}
