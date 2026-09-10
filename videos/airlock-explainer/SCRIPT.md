# Airlock explainer narration

Autonomous agents move quickly. The risk is that one broad credential can turn a useful task into an unsafe action.

Airlock gives every agent its own identity. Kong resolves that identity before evaluating what the agent may reach.

That means agent-to-agent paths are explicit. Planner and Security can reach Coding. Research cannot. Kong returns a 403 before Coding receives the request.

The same boundary applies to MCP tools. Research can read and search code, but it cannot call delete_repository. The blocked tool never reaches the upstream server.

When Coding needs to create a branch, the workflow pauses for a human. A one-use, server-only approval identity passes through Kong, then the grant is consumed.

For model recovery, Kong retries a failed primary Ollama adapter on the fallback target. FastAPI observes the result; it never chooses a model.

Finally, native Kong telemetry and Airlock audit records share one trace. The operator has proof of every decision.
