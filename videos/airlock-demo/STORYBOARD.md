---
title: Airlock — Kong-enforced agent access
duration: 85
mode: autonomous
---

## Storyboard

### 1. The access problem (0–9s)
**Visual:** A concise risk statement gives way to Airlock's technical promise.
**Voiceover:** Autonomous agents can move faster than a person can inspect every request. One shared credential can turn a helpful task into a production action.

### 2. Live control center (9–20s)
**Visual:** The real Airlock overview is shown in a browser-like frame. A visible cursor moves through the navigation and live evidence stream.
**Voiceover:** Airlock gives every agent its own identity, then lets Kong decide what that identity may reach. This is the live control center: the local Kong data plane, protected tools, approval grants, and evidence from real requests.

### 3. Agent paths (20–33s)
**Visual:** Planner and Security paths to Coding animate green. Research to Coding is a red dashed request that Kong rejects before Coding receives it.
**Voiceover:** In the agent graph, Coding accepts work from Planner and Security. Research is not on that list. When Research tries to send Coding a message, Kong returns a 403 before Coding receives it.

### 4. Destructive MCP call (33–46s)
**Visual:** A real MCP tool request for delete_repository is launched, then denied. Counter remains zero and an OTEL event appears.
**Voiceover:** Tools follow the same rule. Research may read and search code, but it cannot call delete_repository. This is a real MCP tools/call. Kong denies it, and the Git MCP server records zero destructive invocations.

### 5. One-use approval (46–59s)
**Visual:** Coding's normal key is blocked. An operator grants one use; the backend-only approval identity completes create_branch and the grant changes to consumed.
**Voiceover:** Some work needs a human. Coding asks to create a branch, but its normal credential is blocked. An operator approves one use. Only the Airlock backend uses the temporary approval identity, then the grant is consumed.

### 6. Kong-owned recovery (59–72s)
**Visual:** The primary Ollama adapter reports 503. Kong retries the same request at the fallback target; counters and workflow result turn green.
**Voiceover:** Finally, model recovery stays in the gateway. The primary Ollama adapter returns a 503. Kong retries the same client request on the fallback model, and the workflow continues.

### 7. Trace-correlated evidence (72–85s)
**Visual:** The Traffic & Audit view filters for a trace ID and reveals native Kong OTEL events for each proof point. The closing line rests on the interface.
**Voiceover:** Traffic and Audit ties every proof together with a trace ID and native Kong telemetry. Airlock controls what autonomous software can access.
