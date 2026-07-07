# Gemi_MCP_V2

This project drives provider web UIs (Gemini/DeepSeek/Copilot/z.ai) via Playwright to provide an MCP-based automation layer.

## Pointers for AI Agents

- **[ARCHITECTURE.md](ARCHITECTURE.md):** Project design reference and layer separation (local-only, gitignored).
- **[AGENT_GUIDE.md](AGENT_GUIDE.md):** Guide on how to delegate code work via the `gemi` MCP tools.
- **[HANDOFF.md](HANDOFF.md):** Open issues and chronological session log / changelog (local-only, gitignored).
- **[DOM_SELF_HEALING.md](DOM_SELF_HEALING.md):** Selector audit and self-healing reference (local-only, gitignored; skip silently if absent).

> **Instruction:** When a browser operation fails with an element-not-found or timeout error, immediately read `DOM_SELF_HEALING.md` and follow the DOM drift repair playbook contained within it.
