import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("airlock_agent", Path(__file__).with_name("main.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
client = TestClient(module.app)

def test_agent_card_and_jsonrpc_message_contract():
    card = client.get("/.well-known/agent-card.json").json()
    assert card["preferredTransport"] == "JSONRPC"
    message = client.post("/", json={"jsonrpc":"2.0","id":"task-1","method":"message/send","params":{"message":{"parts":[]}}})
    assert message.status_code == 200
    assert message.json()["id"] == "task-1"
