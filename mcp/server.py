import asyncio
import json
import os
import subprocess
import sys
import time
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _REPO_ROOT)
from shared.health_parser import record_event, get_metrics  # noqa: E402

def _get_engine_port() -> int:
    try:
        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cfg_path = os.path.join(repo_root, "engine_config.json")
        if os.path.exists(cfg_path):
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.loads(f.read())
                return int(cfg.get("port", 18900))
    except Exception:
        pass
    return 18900

ENGINE_PORT = _get_engine_port()
ENGINE_URL = os.environ.get("GEMI_ENGINE_URL", f"http://127.0.0.1:{ENGINE_PORT}")

mcp = FastMCP("gemi-mcp-v2")

SERVICES = "'gemini', 'deepseek', 'copilot', or 'zai'"

# Guards concurrent tool calls within this process from each independently
# seeing the engine down and Popen-ing a duplicate instance.
_service_start_lock = asyncio.Lock()


# ── HTTP helpers ───────────────────────────────────────────────────────────────

async def _post(path: str, payload=None, params: dict | None = None, timeout: float = 300.0) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.post(f"{ENGINE_URL}{path}", json=payload, params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.json()


async def _get(path: str, params: dict | None = None, timeout: float = 30.0) -> dict:
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{ENGINE_URL}{path}", params=params, timeout=timeout)
        resp.raise_for_status()
        return resp.json()


def _classify_wait_result(result: dict) -> str:
    """Translate raw engine wait_response dict into a human-readable status string."""
    status = result.get("status", "unknown")
    if status == "done":
        refused = result.get("refused", False)
        has_image = result.get("has_image", False)
        text = result.get("text", "")
        if refused:
            flat = " ".join(text.replace("\n", " ").split())
            return f"[refused] Gemini refused: {flat[:300]}"
        if has_image and text:
            return f"[success] Image generated.\n\n{text}"
        if has_image:
            return "[success] Image generated."
        return f"[done] {text}" if text else "[done]"
    message = result.get("message", "")
    return f"[{status}] {message}" if message else f"[{status}]"


def _record_health(service: Optional[str], classified: str, response_time: float) -> None:
    """Best-effort log of a completed generation for shared/health_parser.py metrics."""
    try:
        cfg_path = os.path.join(_REPO_ROOT, "config.json")
        with open(cfg_path, "r", encoding="utf-8") as f:
            file_cfg = json.loads(f.read())
    except Exception:
        file_cfg = {}

    provider = service or file_cfg.get("active_service") or "unknown"
    account = file_cfg.get("active_user") or "unknown"

    if classified.startswith("[refused]"):
        status, reason = "refused", classified
    elif classified.startswith("[timeout]"):
        status, reason = "timeout", None
    elif classified.startswith("[error]") or classified.startswith("[reset]"):
        status, reason = "error", classified
    else:
        status, reason = "success", None

    try:
        record_event(provider, account, status, response_time, refusal_reason=reason)
    except Exception:
        pass


async def _ensure_service():
    async with _service_start_lock:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(f"{ENGINE_URL}/health", timeout=2.0)
                if resp.status_code == 200:
                    return
        except Exception:
            pass

        repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        engine_dir = os.path.join(repo_root, "Gemi_Engine_V2")

        if os.name == 'nt':
            exe_name = "pythonw.exe"
            python_exe = os.path.join(engine_dir, ".venv", "Scripts", exe_name)
        else:
            python_exe = os.path.join(engine_dir, ".venv", "bin", "python")

        if not os.path.exists(python_exe):
            raise RuntimeError("Engine python executable not found")

        out_log = open(os.path.join(engine_dir, "engine.log"), "a")
        err_log = open(os.path.join(engine_dir, "engine_err.log"), "a")

        subprocess.Popen(
            [python_exe, "engine_service.py"],
            cwd=engine_dir,
            stdout=out_log,
            stderr=err_log,
        )

        start_time = time.time()
        while time.time() - start_time < 10:
            try:
                async with httpx.AsyncClient() as client:
                    resp = await client.get(f"{ENGINE_URL}/health", timeout=0.5)
                    if resp.status_code == 200:
                        return
            except Exception:
                pass
            await asyncio.sleep(0.5)

    raise RuntimeError("Engine service failed to start within 10 seconds")


async def _ensure_browser():
    await _ensure_service()
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{ENGINE_URL}/health", timeout=2.0)
            if resp.status_code == 200 and resp.json().get("engine_running"):
                return
    except Exception:
        pass
        
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cfg_path = os.path.join(repo_root, "config.json")
    active_user = None
    active_service = None
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            file_cfg = json.loads(f.read())
            active_user = file_cfg.get("active_user") or None
            active_service = file_cfg.get("active_service") or None
    except Exception:
        pass

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{ENGINE_URL}/engine/start",
                json={"headless": True, "active_user": active_user, "active_service": active_service},
                timeout=60.0
            )
            if resp.status_code == 200:
                data = resp.json()
                if data.get("status") in ("success", "already_running"):
                    return
    except Exception:
        pass

    raise RuntimeError("Failed to start browser engine")


# ── 1. Discover Capabilities ───────────────────────────────────────────────────

@mcp.tool()
async def discover_capabilities(service: Optional[str] = None) -> str:
    """Scan the live UI to discover available models, tools, and thinking levels.

    Run this first to see valid option names before calling apply_settings.
    Also returns the currently active model and thinking level so you can
    verify that a previous apply_settings call succeeded.

    Args:
        service: Target service ({services}). Omit to use the currently active one.

    Returns:
        JSON with available models, tools, sub_tools, thinking levels,
        current_model, and current_thinking_level.
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _post("/browser/discover", params={"service": service} if service else None)
    if data.get("status") == "success":
        return json.dumps(data.get("data", {}), indent=2)
    raise RuntimeError(data.get("message", "discover_capabilities failed"))


# ── 2. Model / Tool Selection ──────────────────────────────────────────────────

@mcp.tool()
async def apply_settings(
    model: Optional[str] = None,
    tool: Optional[str] = None,
    sub_tool: Optional[str] = None,
    thinking_level: Optional[str] = None,
    service: Optional[str] = None,
) -> str:
    """Select model, tool, sub-tool, and/or thinking level before generating.

    Call discover_capabilities() first to get valid option names.
    All parameters are optional — only supplied fields are changed.
    Partial name matching is supported (e.g. "2.5" matches "Gemini 2.5 Pro").

    Args:
        model:          Model display name (partial match ok).
        tool:           Tool name, e.g. "Image generation", "Deep Research".
        sub_tool:       Sub-tool name, if the tool has a dropdown (partial match ok).
        thinking_level: e.g. "Low", "Medium", "High", "Extended" (partial match ok).
        service:        Target service ({services}).
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _post("/browser/apply_settings", {
        "model": model, "tool": tool,
        "sub_tool": sub_tool, "thinking_level": thinking_level,
        "service": service,
    })
    if data.get("status") == "success":
        parts = [f"{k}={v}" for k, v in dict(
            service=service, model=model, tool=tool,
            sub_tool=sub_tool, thinking_level=thinking_level,
        ).items() if v]
        return f"Settings applied: {', '.join(parts)}" if parts else "No changes requested."
    raise RuntimeError(data.get("message", "apply_settings failed"))


# ── 3. Attachments ────────────────────────────────────────────────────────────

@mcp.tool()
async def attach_files(file_paths: list[str]) -> str:
    """Attach one or more local files to the current prompt input.

    Syncs the attachment list: adds missing files, keeps existing ones,
    removes extras. Pass an empty list [] to clear all attachments.

    Args:
        file_paths: Absolute local paths to the files to attach.

    Returns:
        Summary: how many were added / removed.
    """
    await _ensure_browser()
    # Sync via add/remove loop — engine exposes atomic add and remove endpoints
    current_data = await _get("/browser/current_attachments")
    current = set(current_data.get("attachments", []))
    target = set(file_paths)

    added, removed = 0, 0
    for path in target - current:
        await _post("/browser/file/add", {"path": path})
        added += 1
    for path in current - target:
        await _post("/browser/file/remove", {"path": path})
        removed += 1

    return (
        f"Attachments synced: +{added} added, -{removed} removed, "
        f"{len(target)} total."
    )


@mcp.tool()
async def clear_attachments() -> str:
    """Remove all files currently attached to the prompt input.

    Returns:
        Confirmation.
    """
    await _ensure_browser()
    await _post("/browser/clear_attachments")
    return "All attachments cleared."


# ── 4. Prompt Input ────────────────────────────────────────────────────────────

@mcp.tool()
async def set_prompt(text: str) -> str:
    """Type a prompt into the input box without submitting.

    Use this to stage text before calling submit_response, or before
    attaching files when the service clears the input on file attach.

    Args:
        text: The prompt text to type into the input field.
    """
    await _ensure_browser()
    await _post("/browser/prompt", {"text": text})
    return f"Prompt staged ({len(text)} chars)."


# ── 5. Submit & Wait ───────────────────────────────────────────────────────────

@mcp.tool()
async def submit_response(
    prompt: Optional[str] = None,
    service: Optional[str] = None,
    wait: bool = True,
    timeout: int = 180,
) -> str:
    """Submit the current prompt and optionally wait for the response.

    The typical flow:
      1. set_prompt / attach_files  (or pass prompt here)
      2. submit_response(wait=True)  — blocks until generation finishes
      3. get_last_response / download_images

    When wait=True (default) the call polls internally and returns when done,
    so you never hit a timeout from the AI side. Set wait=False only if you
    want to fire-and-forget and poll manually with get_last_response.

    Args:
        prompt:   Optional text to type and submit in one shot.
                  If None, submits whatever is already staged in the input box.
        service:  Target service ({services}).
        wait:     If True (default), block until generation is complete.
                  If False, return immediately after clicking Submit.
        timeout:  Max seconds to wait when wait=True (default 180).

    Returns:
        Generation status and summary when wait=True; "submitted" when wait=False.
    """.format(services=SERVICES)
    await _ensure_browser()
    if prompt:
        await _post("/browser/prompt", {"text": prompt})

    await _post("/browser/submit")

    if not wait:
        return "Submitted. Call get_last_response() to poll for the result."

    started = time.monotonic()
    result = await _post("/browser/wait_response", {"timeout": timeout}, timeout=timeout + 30.0)
    classified = _classify_wait_result(result)
    _record_health(service, classified, time.monotonic() - started)
    return classified


@mcp.tool()
async def get_last_response(service: Optional[str] = None) -> str:
    """Read whatever the service has generated so far.

    Use this to poll after submit_response(wait=False), or if a previous call
    timed out mid-generation.

    Args:
        service: Target service ({services}).

    Returns:
        done=True/False and the current response text.
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _get("/browser/last_response",
                      params={"service": service} if service else None)
    done = data.get("done", False)
    text = data.get("text", "")
    return f"done={done}\n\n{text}"


@mcp.tool()
async def get_artifact_code(service: Optional[str] = None) -> str:
    """Read the full source code of an open z.ai code-artifact panel.

    ZAI-SPECIFIC TOOL. z.ai (and only z.ai — no other service) opens a
    right-side "artifact" preview panel when it generates a complete,
    directly browser-runnable HTML document (a full <!DOCTYPE html> page).
    The chat reply text in that case is just narration ("Here's the code...")
    plus a small trigger card — the actual generated HTML/CSS/JS is NOT in
    the chat text and get_last_response() will not return it. This tool
    reads it directly from the artifact panel's live iframe instead.

    For every other kind of code response (Python, plain JS functions,
    React/JSX components, or any language/snippet that isn't a complete
    standalone webpage), z.ai does NOT open this panel — the full code is
    already inline in the normal chat text, so just use get_last_response()
    as usual. Calling this tool in that case returns status="unsupported".

    Typical flow: submit_response(...) or send_chat(...) on service="zai" →
    if you suspect the reply generated a runnable HTML page (or just want to
    check), call get_artifact_code() → if status="success", `code` is the
    complete HTML document source ready to save to a .html file.

    Args:
        service: Target service. Must be "zai" — other services will return
                 status="unsupported" since they don't have this UI feature.

    Returns:
        status: "success" (code contains the full HTML source),
                "none" (zai is active but no artifact panel is currently open),
                or "unsupported" (active service isn't zai).
    """
    await _ensure_browser()
    data = await _get("/browser/artifact_code",
                      params={"service": service} if service else None)
    status = data.get("status", "none")
    code = data.get("code")
    if status == "success" and code:
        return f"status=success\n\n{code}"
    return f"status={status}\n\n(No artifact code available.)"


# ── 6. High-level Chat (combinator) ───────────────────────────────────────────

@mcp.tool()
async def send_chat(
    prompt: str,
    new_conversation: bool = True,
    service: Optional[str] = None,
) -> str:
    """Send a text prompt and return the full text reply (one round-trip).

    Convenience combinator: new_chat → set_prompt → submit → wait → get_last_response.
    Use submit_response + download_images instead when you need images.

    IMPORTANT: after calling this, verify the service is correct by checking
    the reply before running sensitive tasks.

    Args:
        prompt:           Text message to send.
        new_conversation: If True (default), start a fresh chat first.
        service:          Target service ({services}).
    """.format(services=SERVICES)
    await _ensure_browser()
    if new_conversation:
        await _post("/browser/new_chat", params={"service": service} if service else None)

    await _post("/browser/prompt", {"text": prompt})
    await _post("/browser/submit")

    started = time.monotonic()
    result = await _post("/browser/wait_response", {"timeout": 180}, timeout=210.0)
    classified = _classify_wait_result(result)
    _record_health(service, classified, time.monotonic() - started)
    if classified.startswith("[error]") or classified.startswith("[timeout]") or classified.startswith("[reset]"):
        raise RuntimeError(f"Chat failed: {classified}")

    data = await _get("/browser/last_response")
    return data.get("text", "")


# ── 7. Download Images ────────────────────────────────────────────────────────

@mcp.tool()
async def download_images(
    save_dir: str,
    prefix: str = "img",
    padding: int = 4,
    start: int = 1,
    service: Optional[str] = None,
) -> str:
    """Download generated images from the last response to disk.

    Call this after submit_response returns a success status.

    Args:
        save_dir: Absolute path to the folder where images will be saved.
        prefix:   Filename prefix, e.g. "img" → img0001.png, img0002.png.
        padding:  Zero-padding width for the counter (default 4).
        start:    Starting counter number (default 1).
        service:  Target service ({services}).
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _post("/browser/download", {
        "save_dir": save_dir,
        "prefix": prefix, "padding": padding, "start": start,
        "service": service,
    }, timeout=120.0)
    status = data.get("status")
    if status == "success":
        paths = data.get("saved_paths", [])
        return f"Downloaded {data.get('count', 0)} image(s): {paths}"
    if status == "ignored":
        return f"No images found: {data.get('message', '')}"
    raise RuntimeError(data.get("message", "download_images failed"))


# ── 8. Redo ───────────────────────────────────────────────────────────────────

@mcp.tool()
async def redo_response(service: Optional[str] = None) -> str:
    """Trigger the Redo / Regenerate button on the last response.

    Use after a refused, low-quality, or incomplete result.
    Follow with get_last_response or download_images once done.

    Args:
        service: Target service ({services}).
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _post("/browser/redo", params={"service": service} if service else None)
    if data.get("status") == "success":
        return "Redo triggered. Poll get_last_response() or call wait_response."
    raise RuntimeError(data.get("message", "redo_response failed"))


# ── 9. New Chat ───────────────────────────────────────────────────────────────

@mcp.tool()
async def new_chat(service: Optional[str] = None) -> str:
    """Clear conversation history and start a new chat session.

    Clicks the "New chat" button. Always follow with a self-identification
    prompt (e.g. send_chat("What is your name?")) to confirm active service.

    Args:
        service: Target service ({services}).
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _post("/browser/new_chat", params={"service": service} if service else None)
    if data.get("status") == "success":
        return "New chat started."
    raise RuntimeError(data.get("message", "new_chat failed"))


# ── 10. Service Switching ─────────────────────────────────────────────────────

@mcp.tool()
async def switch_service(service: str) -> str:
    """Switch the active AI provider and navigate to its web UI.

    After switching, all subsequent tool calls target the new provider.
    Always follow with a verify call (e.g. send_chat("What is your name?")).

    Args:
        service: One of {services}.
    """.format(services=SERVICES)
    await _ensure_browser()
    data = await _post("/browser/switch_service", {"service": service})
    if data.get("status") == "success":
        return f"Switched to: {service}. Verify by sending a test message."
    raise RuntimeError(data.get("message", "switch_service failed"))


# ── 11. Account Switching ─────────────────────────────────────────────────────

@mcp.tool()
async def switch_account(username: str) -> str:
    """Switch to a different browser profile / account.

    Stops the current browser session, maps the profile for `username`
    into the sandbox, and restarts the browser. The active service and
    page URL are restored automatically.

    Use this when you need to use a different login, or when the current
    account has hit its generation quota.

    Args:
        username: Email or display name of the target account
                  (must have a saved profile in browser_user_data/).

    Returns:
        Confirmation with the username used.
    """
    await _ensure_service()
    data = await _post("/engine/switch_account", {"username": username}, timeout=60.0)
    if data.get("status") == "success":
        return f"Account switched to: {data.get('username', username)}"
    raise RuntimeError(data.get("message", "switch_account failed"))


# ── 12. Delete History ────────────────────────────────────────────────────────

@mcp.tool()
async def delete_history(range_name: str = "Last hour") -> str:
    """Delete conversation history for a given time range.

    Clicks the delete activity button and selects the matching time-range menu item.

    Args:
        range_name: Time range label as shown in the UI, e.g.
                    "Last hour", "Last day", "All time".

    Returns:
        Confirmation.
    """
    await _ensure_browser()
    data = await _post("/browser/delete_history", {"range_name": range_name})
    if data.get("status") == "success":
        return f"History deleted: {range_name}"
    raise RuntimeError(data.get("message", "delete_history failed"))


# ── 13. Engine Health ─────────────────────────────────────────────────────────

@mcp.tool()
async def get_status() -> str:
    """Get the detailed status of the engine service and browser.
    Returns:
        A formatted text block for AI decision-making.
    """
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{ENGINE_URL}/health", timeout=2.0)
            if resp.status_code == 200:
                data = resp.json()
                service = "online"
                browser = "running" if data.get("engine_running") else "stopped"
                provider = data.get("active_service", "gemini")
                busy = "true" if data.get("busy") else "false"
                queue_depth = str(data.get("queue_depth", 0))
                return (
                    f"Service: {service}\n"
                    f"Browser: {browser}\n"
                    f"Provider: {provider}\n"
                    f"Busy: {busy}\n"
                    f"Queue depth: {queue_depth}"
                )
    except Exception:
        pass
    return (
        "Service: offline\n"
        "Browser: stopped\n"
        "Provider: gemini\n"
        "Busy: false\n"
        "Queue depth: 0"
    )


@mcp.tool()
async def engine_status() -> str:
    """Check if the browser engine is running and which service is active.

    Returns:
        JSON with engine_running, current URL, and browser process IDs.
    """
    data = await _get("/browser/status", timeout=10.0)
    return json.dumps(data, indent=2)


@mcp.tool()
async def get_health_metrics(provider: Optional[str] = None) -> str:
    """Get success/refusal/timeout rates and average latency from logged generations.

    Backed by shared/health_parser.py's session_health.jsonl log, written on every
    submit_response / send_chat completion. Use this to judge whether the current
    account/provider is getting rate-limited or refusing more than usual.

    Args:
        provider: Filter to one provider ({services}). Omit for stats across all.

    Returns:
        Formatted text block with total_attempts, success_rate, refusal_rate,
        timeout_rate, and average_response_time (seconds).
    """.format(services=SERVICES)
    m = get_metrics(provider)
    return (
        f"Provider: {provider or 'all'}\n"
        f"Total attempts: {m['total_attempts']}\n"
        f"Success rate: {m['success_rate']:.1%}\n"
        f"Refusal rate: {m['refusal_rate']:.1%}\n"
        f"Timeout rate: {m['timeout_rate']:.1%}\n"
        f"Avg response time: {m['average_response_time']:.1f}s"
    )


@mcp.tool()
async def get_browser_tabs() -> str:
    """Get a list of all currently open tabs in the browser, their titles, URLs,
    associated services, and which tab is currently active.

    Returns:
        JSON string containing the tabs list and the active service name.
    """
    await _ensure_service()
    data = await _get("/browser/tabs", timeout=10.0)
    return json.dumps(data, indent=2, ensure_ascii=False)


# ── Entry Point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mcp.run()
