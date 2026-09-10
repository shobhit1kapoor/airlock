from app.main import app

def test_control_api_has_live_contract():
    paths = app.openapi()["paths"]
    assert "/api/attacks/run" in paths
    assert "/api/telemetry/kong" in paths
    assert "/api/events" in paths
    assert "/api/policy/preview" in paths
    assert "/api/policy/drift" in paths
    assert "/api/policy/sync" in paths

def test_approval_identity_is_not_a_client_route():
    paths = app.openapi()["paths"]
    assert all("credential" not in path.lower() for path in paths)
