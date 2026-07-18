# Gemi_MCP_V2

Drives provider web UIs (Gemini / DeepSeek / Copilot / z.ai) via Playwright to
provide an MCP-based automation layer, with an Ink TUI front end.

## Requirements

- **Windows 10/11 (x64)**
- **Python 3.10+** on `PATH` (`python --version`)
- **Visual C++ 2015–2022 Redistributable (x64)** — provides `msvcp140.dll`,
  which Playwright's `greenlet` dependency loads at runtime. Without it the
  engine fails to start with `ImportError: DLL load failed while importing
  _greenlet`. `setup.bat` installs it automatically via winget if missing; to
  install manually: `winget install --id Microsoft.VCRedist.2015+.x64 -e`
  (or download `vc_redist.x64.exe` from Microsoft).
- Node.js is **not** required system-wide — `setup` downloads a portable copy
  into `.node_venv/`.

## Setup

`Gemi_Engine_V2/` is a git submodule. Clone with:

```
git clone --recurse-submodules <this-repo-url>
```

If you already cloned without that flag, run `git submodule update --init --recursive`
before (or let) `setup.ps1` do it for you — it also does this automatically as its
first step.

Double-click `setup.bat` (or run `setup.ps1`) once at the repo root. It:

1. Initializes the `Gemi_Engine_V2` submodule if needed.
2. Checks system Python and the VC++ runtime.
3. Creates `Gemi_Engine_V2/.venv/` and installs the engine deps + Chromium.
4. Creates the outer `.venv/` and installs the MCP server deps.
5. Downloads portable Node.js into `.node_venv/`.
6. Runs `npm install` for the TUI and creates a desktop shortcut.

Re-running skips any step whose output already exists.

## Run

Double-click `run.bat` (or run `run.ps1`). It auto-starts the engine service and
launches the TUI.

## Further reading

- `AGENT_GUIDE.md` — delegating code work via the `gemi` MCP tools.
- `MCP_TOOLS_REFERENCE.md` / `API_REFERENCE.md` — tool and HTTP API reference.
- `ARCHITECTURE.md`, `HANDOFF.md` — design reference and session log (local-only).
