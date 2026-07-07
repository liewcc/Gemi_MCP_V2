# Gemi MCP — Agent Guide: Delegating Code Work to Web AI

**Audience: AI coding agents** (Claude Code, Cursor, Codex CLI, or any MCP-capable
agent). If you are an agent reading this, this document tells you how to use the
`gemi` MCP server to offload code analysis and code writing to a browser-driven
web AI (Gemini / DeepSeek / Copilot / z.ai), and how to bring the results back
safely.

**Human setup note:** to make your agent use this guide, add one line to your
project's `CLAUDE.md` / `AGENTS.md` / rules file, e.g.:
`When delegating code tasks to the gemi MCP, follow D:\path\to\Gemi_MCP_V2\AGENT_GUIDE.md.`

---

## 1. Division of labor

You (the local agent) are the **orchestrator**. The web AI is a **remote worker
with zero context** — it only knows what you put in the prompt.

| Phase | Who | What |
|-------|-----|------|
| Analyze & plan | You | Read the project locally, decide scope, split work |
| Package | You | Build file tree + code bundle |
| Upload & generate | Web AI (via gemi tools) | Heavy reading, analysis, code writing |
| Retrieve | You | Pull the response text / artifact code |
| Review | You | Diff-review every returned file against the originals |
| Write to disk | **You, never the web AI** | Apply reviewed code with your own file tools, then run tests |

The web AI never touches the user's disk. Everything it produces passes through
your review before a single byte lands in the project.

Why delegate at all: the web AI carries the multi-thousand-line reading burden,
so your own context window stays free for orchestration, review, and the rest of
the session.

## 2. Prerequisites

- The `gemi` MCP server is registered in the agent's MCP config
  (`mcp/server.py` in this repo; see `README`/`HANDOFF.md` for setup).
- A browser profile logged in to at least one supported service exists
  (created via this repo's TUI, `run.ps1`).
- You do **not** need to start anything manually: the engine and browser
  auto-start on the first tool call. Still, begin with `get_status()` to check
  `Busy` and the active provider.

## 3. Tool cheat sheet (Gemi MCP v2)

| Tool | Use for |
|------|---------|
| `get_status()` | Engine/browser state, active provider, busy flag. Call first. |
| `switch_service(service)` | Change provider: `gemini`, `deepseek`, `copilot`, `zai`. Verify identity after. |
| `switch_account(username)` | Different login / quota exhausted. |
| `discover_capabilities()` | List available models / tools / thinking levels. |
| `apply_settings(model=..., thinking_level=...)` | Pick model before generating (partial name match OK). |
| `new_chat()` | Fresh conversation. Do this before every new task. |
| `attach_files([paths])` | Upload local files. **Real on `gemini` and `zai` only** (see §6). |
| `clear_attachments()` | Remove all attached files. Cleanup after the task. |
| `set_prompt(text)` | Stage prompt text without submitting (it pastes, so one huge message is cheap). |
| `submit_response(prompt=None, wait=True, timeout=180)` | Submit and wait. Raise `timeout` to 300+ for big tasks. |
| `get_last_response()` | Poll the current reply; returns `done=True/False` + text. |
| `get_artifact_code()` | **z.ai only**: read a generated full-HTML artifact panel (not in chat text). |
| `send_chat(prompt, new_conversation=True)` | One-shot convenience. Hardcoded 180s timeout that **raises** — small/fast tasks only. |
| `redo_response()` | Regenerate after a refusal or bad result. |
| `download_images(save_dir)` | Save generated images (not needed for code tasks). |
| `get_health_metrics(provider=...)` | Success/refusal/timeout rates — diagnose rate-limiting. |
| `delete_history(range_name)` | Wipe conversation history on the service. |
| `audit_selectors(service=...)` | Selector health audit: broken / degraded / state-dependent. Run on element-not-found errors. |
| `engine_status()` / `get_browser_tabs()` | Low-level diagnostics. |

## 4. The workflow

### Step 0 — Health check
```
get_status()          # provider + busy flag; engine auto-starts if down
```
If `Busy: true` with a queue, wait or tell the user. Prefer `gemini` for large
payloads (real file attach + largest context); `zai` is strong for standalone
HTML/JS pages. Switch with `switch_service(...)` and verify with
`send_chat("What is your name?", new_conversation=False)` — browser automation
can land on the wrong tab, and a mismatched identity means every later answer
is from the wrong model.

### Step 1 — Analyze locally and scope the task
Do your own read of the project first. Decide:
- exactly which files the web AI needs (only task-relevant ones — never dump
  the whole repo);
- what the deliverable is (findings list vs. complete modified files);
- whether the job should be split (see §5 for large projects).

### Step 2 — Build the file tree and bundle
Generate a plain indented tree of the **relevant subtree only** (e.g. from
`git ls-files` filtered to the task scope). The tree is what lets the web AI
understand the project structure without seeing every file. Then build one
self-contained bundle document:

```markdown
# Task
<one paragraph: role + exactly what to do>

# Output format
<pick ONE, state it explicitly:>
- Analysis: "Numbered findings; for each give file, line, problem, fix."
- Modification: "Return each modified file COMPLETE in a fenced code block
  headed by its path. No diffs, no ellipsis, no omitted lines."

# Project context
<2-5 lines: what the project is, language/framework, constraints>

# File tree
<the indented tree>

# Files
## path/to/file1.py
```python
<full content>
```
## path/to/file2.js
```javascript
<full content>
```
```

Always pin the output format. Web AIs default to chatty prose with elided code
(`# ... rest unchanged`), which is useless for applying changes.

### Step 3 — Deliver (payload decision ladder)
Estimate total size (task + tree + code text) and pick a tier:

**Tier 1 — small (≤ ~3 files or ≤ ~30 KB): single text message.**
Works on all 4 services.
```
new_chat()
submit_response(prompt=<bundle>, wait=True, timeout=300)
```

**Tier 2 — medium/large on `gemini` or `zai`: attach a bundle file.**
Write the bundle to ONE local markdown file (a temp/scratch directory, not the
user's project), then:
```
new_chat()
attach_files(["<abs path to bundle.md>"])
set_prompt("<short task prompt referencing the attached file>")
submit_response(wait=True, timeout=300)
```
One bundle file avoids per-file upload flakiness; attach raw source files
directly only when format matters (e.g. images). If the reply says it cannot
see the file, fall back to Tier 1 or 3.

**Tier 3 — large payload but service is `deepseek` or `copilot`.**
Preferred: `switch_service("gemini")` and use Tier 2. Only if that service is
mandatory, split into the FEWEST possible chunks with a strict protocol: every
chunk except the last ends with *"This is part i/N of a code payload. Do NOT
analyze yet. Reply with exactly RECEIVED i/N."* Only the final chunk carries
the task. Verify each `RECEIVED i/N` before sending the next; abort and restart
the chat on any other reply.

**Anti-pattern:** do NOT default to chunked "reply OK and I'll send more"
uploading. Every chunk is a slow browser round-trip that can time out or get
refused mid-sequence; the acknowledgment turns burn quota; chunking does not
enlarge the model's context window; and models say "OK" without integrating
anything — final quality is measurably worse than one complete message.

### Step 4 — Generate and retrieve
- For anything non-trivial: `submit_response(wait=True, timeout=300)`.
- If it returns `[timeout]`, do **not** resubmit — the generation is still
  running. Poll `get_last_response()` until `done=True`.
- On `zai`: if the reply narrates a built webpage ("Here's your page..."),
  the actual HTML is NOT in the chat text — call `get_artifact_code()`.
- Multi-file outputs arrive as fenced blocks headed by paths (because you
  pinned the format in Step 2). Parse them out of the response text.

### Step 5 — Review (mandatory, never skip)
Treat the returned code as an untrusted pull request:
1. Save each returned file to a temp location — not onto the project yet.
2. Diff against the original. Check for: elided lines, hallucinated
   APIs/imports, deleted code the task didn't ask to remove, style drift.
3. If a file contains `...` or "rest unchanged", reply **in the same
   conversation** — `send_chat("Resend <path> complete, no omitted lines.",
   new_conversation=False)` — don't rebuild the payload.
4. Iterate in the same conversation for fixes; the web AI still has the
   context.

### Step 6 — Apply and verify locally
Only after review passes:
1. Write the files into the project with your own file tools.
2. Run the project's existing checks (tests, lint, or at minimum an
   import/run smoke test).
3. `clear_attachments()` if you attached anything.
4. Report to the user what was delegated, what came back, and what you
   changed or rejected during review.

## 5. Large projects: split by module

When the codebase exceeds what one conversation handles well:
1. **You** partition the work into independent subtasks (per module /
   directory / concern), each with its own minimal file set.
2. Run one `new_chat()` + bundle per subtask — never reuse a conversation
   across unrelated subtasks; stale context contaminates results.
3. Include the **full project tree** in every subtask bundle (trees are cheap)
   but only the subtask's files in `# Files`. The tree gives the web AI global
   structure; the files give it local depth.
4. Integrate: after all subtasks return, you reconcile cross-module
   interfaces yourself — the web AI never saw the whole picture at once, so
   interface mismatches between subtask outputs are yours to catch.

## 6. Service quirks (verified against this repo's engine source)

| Fact | Consequence |
|------|-------------|
| `attach_files` is REAL on `gemini` and `zai` only | File upload works there. |
| `attach_files` is a SILENT STUB on `deepseek` and `copilot` | Engine ignores it but the tool still reports success — the file is NOT uploaded. Never trust attach on these two; put code in the prompt text. |
| `set_prompt` pastes (Playwright `fill()`), not types | One long message is cheap; chunking "to help typing" is pointless. |
| `send_chat` hardcodes 180s and raises on timeout | Small/fast tasks only. Big jobs: `submit_response(timeout=300)` or `wait=False` + poll. |
| `get_artifact_code` exists only on `zai` | Full-HTML pages land in the artifact panel, not chat text. Other code (Python, snippets, JSX) is inline in chat as usual. |
| Every round-trip is a full browser automation cycle | Minimize turns. One well-packed message beats many small ones. |

## 7. Failure handling

| Symptom | Action |
|---------|--------|
| `[refused]` | `redo_response()` once. Refused again → rephrase the prompt (drop words that read as exploit/bypass phrasing) or `switch_service(...)`. |
| `[timeout]` from `submit_response` | Do NOT resubmit. Poll `get_last_response()` until `done=True`. |
| Repeated timeouts / suspected rate limit | `get_health_metrics(provider=...)` to confirm, then `switch_account(...)` or `switch_service(...)`. |
| Reply has elided code (`...`) | Same conversation: "Resend <path> complete, no omitted lines." |
| Reply claims it can't see the attachment | You're on a stub service or upload flaked — fall back to text-in-prompt (Tier 1/3). |
| Timeout / element-not-found | Run `audit_selectors()` first to distinguish DOM drift (broken selectors) from a transient failure. |
| Wrong model identity on verify | `switch_service(...)` again; do not proceed until identity is confirmed. |

### DOM drift repair playbook

1. Run `audit_selectors(service=...)` to identify broken/degraded selectors.
   If nearly all locators report broken (including `prompt_input`), the page
   likely hasn't finished rendering — re-run after a few seconds.
2. Capture evidence: `POST /browser/capture_dom` and `POST /browser/eval` (curl
   against `http://127.0.0.1:18900`) to inspect the live DOM.
3. Edit the provider's `dom.py` (`Gemi_Engine_V2/providers/{name}/dom.py`).
   Insert the new working selector at the **front** of the fallback chain (keep
   old selectors as fallbacks).
4. **Important:** `dom.py` is imported at engine process start; `POST /engine/stop`
   is NOT enough. Kill the `engine_service.py` process and let MCP's
   `_ensure_service()` respawn it on the next tool call.
5. Re-run `audit_selectors()` to confirm the fix.

## 8. Non-negotiable rules

1. **Never write web-AI output to the project unreviewed.** Review (Step 5) is
   part of the workflow, not optional polish.
2. **You select the files.** Send only what the task needs; the tree carries
   the rest of the structure.
3. **`new_chat()` before every new task.**
4. **Pin the output format in every bundle.**
5. **Don't send secrets.** Strip `.env` files, API keys, credentials, and
   customer data from any bundle — the payload goes to a third-party web
   service under the logged-in account.
6. **One packed message over many small ones.** Browser round-trips are the
   expensive resource here.
