---
name: project_copilot_headless
description: Copilot provider fails in headless mode due to Cloudflare Turnstile — pending investigation
metadata:
  type: project
---

Copilot (copilot.microsoft.com) triggers a Cloudflare Turnstile captcha when the browser runs headless, blocking all interactions (new_chat, send_chat, etc.). In non-headless mode it passes automatically with no manual action needed.

**Why:** Cloudflare bot detection flags headless Playwright as a bot and serves the Turnstile challenge. The challenge modal (`.fixed.inset-0.z-40` containing `#cf-turnstile`) intercepts pointer events, preventing clicks from reaching the actual UI.

**How to apply:** Until resolved, always start the engine with `headless=False` when Copilot is needed. Investigate headless bypass options when time allows — see backlog note below.

**Backlog:** Research approaches to bypass or pre-solve Turnstile in headless mode:
- `playwright-stealth` / `undetected-playwright` to mask automation fingerprints
- Persistent authenticated session (cookies pre-seeded) to skip the challenge
- Cloudflare Turnstile token injection via JS before page load
- Running with a real Chrome binary (`channel="chrome"`) instead of Chromium
