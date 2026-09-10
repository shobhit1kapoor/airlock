import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("airlock_mcp", Path(__file__).with_name("main.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
client = TestClient(module.app)

def test_real_mcp_tools_call_reaches_only_requested_tool():
    before = client.get("/counters").json()
    result = client.post("/mcp", json={"jsonrpc":"2.0", "id":"1", "method":"tools/call", "params":{"name":"read_repository","arguments":{}}})
    assert result.status_code == 200
    after = client.get("/counters").json()
    assert after["read_repository"] == before["read_repository"] + 1
    assert after["delete_repository"] == before["delete_repository"]
