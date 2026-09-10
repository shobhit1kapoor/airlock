---
workflow: product-launch-video
flow: automation
storyboard: no
message: "Airlock lets teams control what autonomous software can access, with Kong enforcing identity, MCP tools, agent paths, human approval, and model recovery."
destination: hackathon-submission
aspect: 1920x1080
language: en
audience: Kong hackathon judges and platform engineers
length: 85s
angle: evidence-led working demo
narration: yes
voice: am_michael
---

## Intent

An 85-second, screen-led working demo for Kong Build Sprint judges. It opens
with the practical problem: agents can take action faster than people can
inspect every request. It then shows Airlock as a real control plane, not a
dashboard mockup. The pace is calm, direct, and easy to understand in English.

## Assets

- http://localhost:3000/ — the live Airlock dashboard and actual application state.
- http://localhost:8001/ — local API that drives the demonstrated Kong flows.

## Customizations

- Use dashboard captures as the primary visual evidence.
- Animate a visible, restrained cursor through each screen-led interaction.
- Use an offline English voiceover and concise on-screen labels.
- Show all four live proof points: MCP denial, A2A denial, approval-gated branch creation, and Kong-owned model failover.
- Close on Traffic & Audit evidence with trace correlation and native Kong telemetry.

## Notes

- Never describe application logic as Kong enforcement.
- Do not use speculative product claims or show secrets, environment files, or credentials.
- Keep the tone technical and practical rather than salesy.
