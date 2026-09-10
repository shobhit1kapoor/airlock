import os
import httpx
from fastapi import FastAPI, HTTPException

app = FastAPI(title="Airlock Ollama adapter")
model = os.getenv("MODEL", "qwen3:8b")
ollama_url = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434")
faulted = False
attempts = 0
failures = 0

@app.post("/fault")
async def fault(payload: dict):
    global faulted
    faulted = bool(payload.get("enabled"))
    return {"model": model, "faulted": faulted}

@app.get("/counters")
async def counters():
    return {"model":model, "attempts":attempts, "failures":failures, "faulted":faulted}

@app.post("/reset")
async def reset():
    """Reset demo evidence counters; Kong still owns target selection."""
    global attempts, failures, faulted
    attempts = 0
    failures = 0
    faulted = False
    return await counters()

async def complete(payload: dict):
    global attempts, failures
    attempts += 1
    if faulted:
        failures += 1
        raise HTTPException(503, "Airlock fault injection: primary target unavailable")
    translated = {"model": model, "messages": payload.get("messages", []), "stream": False}
    async with httpx.AsyncClient(timeout=90) as client:
        response = await client.post(f"{ollama_url}/api/chat", json=translated)
        response.raise_for_status()
        result = response.json()
    return {"id":"airlock-ollama", "object":"chat.completion", "model":model, "choices":[{"index":0,"message":{"role":"assistant","content":result.get("message",{}).get("content","")},"finish_reason":"stop"}]}

@app.post("/v1/chat/completions")
async def completions(payload: dict):
    return await complete(payload)

# Kong's Ollama provider translates OpenAI-shaped requests to the native
# Ollama endpoint before it reaches the configured upstream URL.
@app.post("/api/chat")
async def ollama_chat(payload: dict):
    return await complete(payload)
