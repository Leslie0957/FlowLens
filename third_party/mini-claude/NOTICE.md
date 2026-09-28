Upstream: https://github.com/Windy3f3f3f3f/claude-code-from-scratch
Reviewed source commit: 0b452360866433fde0dc77cd37ada9d303546592
License: MIT; full notice in LICENSE.
FlowLens M0 probe is a newly written bounded adaptation of the agent-loop, streamed tool-call accumulation, and message/tool-result pairing ideas from src/agent.ts. The upstream source was not modified or vendored. This notice preserves provenance for any later source-level reuse; record exact copied files and changes if such reuse occurs.

FlowLens M2 (2026-09-26): apps/server/src/model-stream.ts copies and extends
FlowLens's own probes/m0/src/stream.ts with text-delta callbacks. model-gateway.ts
and diagnosis-agent.ts adapt the local M0 gateway/loop to SQLite-backed sessions,
bounded read-only tools and structured application events. No additional upstream
source files or dependencies were copied. The original MIT license remains here;
the external tutorial checkout and its learning changes were not modified.
