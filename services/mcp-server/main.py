from fastapi import FastAPI, Response

app = FastAPI(title="Airlock Git MCP")
counters = {"read_repository": 0, "search_code": 0, "create_branch": 0, "delete_repository": 0}
TOOLS = [{"name": name, "description": name.replace("_", " ")} for name in counters]

async def handle_mcp(request: dict, response: Response):
    method, request_id = request.get("method"), request.get("id")
    if method == "initialize":
        response.headers["Mcp-Session-Id"] = "airlock-mcp-session"
        return {"jsonrpc":"2.0", "id":request_id, "result":{"protocolVersion":"2025-06-18", "capabilities":{"tools":{}}, "serverInfo":{"name":"airlock-git","version":"0.1.0"}}}
    if method == "notifications/initialized":
        return Response(status_code=202)
    if method == "tools/list":
        return {"jsonrpc":"2.0", "id":request_id, "result":{"tools":TOOLS}}
    if method == "tools/call":
        name = request.get("params", {}).get("name")
        if name not in counters:
            return {"jsonrpc":"2.0", "id":request_id, "error":{"code":-32602,"message":"Unknown tool"}}
        counters[name] += 1
        return {"jsonrpc":"2.0", "id":request_id, "result":{"content":[{"type":"text","text":f"{name} completed safely"}]}}
    return {"jsonrpc":"2.0", "id":request_id, "error":{"code":-32601,"message":"Unknown MCP method"}}

@app.post("/mcp")
async def mcp(request: dict, response: Response):
    return await handle_mcp(request, response)

@app.post("/")
async def mcp_root(request: dict, response: Response):
    return await handle_mcp(request, response)

@app.get("/counters")
async def get_counters():
    return counters
