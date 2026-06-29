"""HTTP client for Gemi Engine V2.

Wraps every engine endpoint as a typed Python call.
All methods raise EngineError on non-2xx or on status != 'success'.
"""
import httpx

ENGINE_URL = "http://127.0.0.1:18800"
_TIMEOUT = httpx.Timeout(30.0, read=300.0)  # long read for submit/wait


class EngineError(RuntimeError):
    """Raised when the engine returns an error status or non-2xx HTTP."""


def _check(data: dict) -> dict:
    """Raise EngineError if response carries a non-success status."""
    status = data.get("status")
    if status and status not in ("success", "ok", "already_running"):
        raise EngineError(f"[{status}] {data.get('message', data.get('detail', ''))}")
    return data


class EngineClient:
    """Synchronous wrapper around the engine REST API.

    Usage::
        client = EngineClient()
        client.start()
        client.set_prompt("hello")
        client.submit()
        result = client.wait_for_response()
    """

    def __init__(self, base_url: str = ENGINE_URL):
        self._base = base_url.rstrip("/")
        self._http = httpx.Client(base_url=self._base, timeout=_TIMEOUT)

    def close(self):
        self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    # ── helpers ────────────────────────────────────────────────────────────────

    def _get(self, path: str, **params) -> dict:
        r = self._http.get(path, params={k: v for k, v in params.items() if v is not None})
        r.raise_for_status()
        return r.json()

    def _post(self, path: str, body=None, **params) -> dict:
        r = self._http.post(
            path,
            json=body,
            params={k: v for k, v in params.items() if v is not None},
        )
        r.raise_for_status()
        return r.json()

    # ── Engine lifecycle ───────────────────────────────────────────────────────

    def health(self) -> dict:
        """GET /health — engine running, browser PIDs, service PID."""
        return self._get("/health")

    def browser_status(self) -> dict:
        """GET /browser/status — running flag, current URL, PIDs."""
        return self._get("/browser/status")

    def start(self, headless: bool = True, profile_name: str | None = None) -> dict:
        return _check(self._post("/engine/start", {"headless": headless, "profile_name": profile_name}))

    def stop(self) -> dict:
        return _check(self._post("/engine/stop"))

    def start_registration(self) -> dict:
        """Start a headed browser for manual account sign-up."""
        return _check(self._post("/engine/start_registration"))

    def stop_registration(self) -> dict:
        return _check(self._post("/engine/stop_registration"))

    def logs(self, lines: int = 200) -> list[str]:
        """GET /engine/logs — last N lines from engine.log."""
        return self._get("/engine/logs", lines=lines).get("logs", [])

    # ── Account / Profile ──────────────────────────────────────────────────────

    def switch_account(self, username: str) -> dict:
        return _check(self._post("/engine/switch_account", {"username": username}))

    def re_login(self) -> dict:
        return _check(self._post("/engine/re_login"))

    def profiles(self) -> list[str]:
        return self._get("/engine/profiles").get("profiles", [])

    def profiles_status(self) -> dict:
        return self._get("/engine/profiles/status")

    # ── Config ─────────────────────────────────────────────────────────────────

    def get_config(self) -> dict:
        return self._get("/engine/config")

    def update_config(self, updates: dict) -> dict:
        return self._post("/engine/config", updates)

    # ── Browser navigation ─────────────────────────────────────────────────────

    def navigate(self, url: str) -> dict:
        return _check(self._post("/browser/navigate", {"url": url}))

    def capture_dom(self) -> str:
        return self._post("/browser/capture_dom").get("dom", "")

    def get_account(self) -> dict:
        return self._get("/browser/account")

    def switch_service(self, service: str) -> dict:
        return _check(self._post("/browser/switch_service", {"service": service}))

    def discover(self, service: str | None = None) -> dict:
        return self._post("/browser/discover", params={"service": service} if service else None)

    def apply_settings(
        self,
        model: str | None = None,
        tool: str | None = None,
        sub_tool: str | None = None,
        thinking_level: str | None = None,
    ) -> dict:
        return _check(self._post("/browser/apply_settings", {
            "model": model, "tool": tool,
            "sub_tool": sub_tool, "thinking_level": thinking_level,
        }))

    # ── Prompt & attachments ───────────────────────────────────────────────────

    def set_prompt(self, text: str) -> dict:
        return _check(self._post("/browser/prompt", {"text": text}))

    def add_file(self, path: str) -> dict:
        return _check(self._post("/browser/file/add", {"path": path}))

    def remove_file(self, path: str) -> dict:
        return _check(self._post("/browser/file/remove", {"path": path}))

    def current_attachments(self) -> list[str]:
        return self._get("/browser/current_attachments").get("attachments", [])

    def clear_attachments(self) -> dict:
        return _check(self._post("/browser/clear_attachments"))

    # ── Submit & response ──────────────────────────────────────────────────────

    def submit(self) -> dict:
        """Click the Send button. Does NOT wait for generation."""
        return _check(self._post("/browser/submit"))

    def wait_for_response(self, timeout: int = 180) -> dict:
        """Block until generation is complete. Returns status dict."""
        r = self._http.post(
            "/browser/wait_response",
            json={"timeout": timeout},
            timeout=httpx.Timeout(timeout + 30.0),
        )
        r.raise_for_status()
        return r.json()

    def get_last_response(self) -> dict:
        """Read current generation output without waiting."""
        return self._get("/browser/last_response")

    def stop_response(self) -> dict:
        return _check(self._post("/browser/stop"))

    def redo_response(self) -> dict:
        return _check(self._post("/browser/redo"))

    def new_chat(self, service: str | None = None) -> dict:
        return _check(self._post("/browser/new_chat", params={"service": service} if service else None))

    def download_images(
        self,
        save_dir: str,
        prefix: str = "img",
        padding: int = 4,
        start: int = 1,
    ) -> dict:
        return self._post("/browser/download", {
            "save_dir": save_dir, "prefix": prefix,
            "padding": padding, "start": start,
        })

    def delete_history(self, range_name: str = "Last hour") -> dict:
        return _check(self._post("/browser/delete_history", {"range_name": range_name}))

    # ── Convenience combinator ─────────────────────────────────────────────────

    def send_and_wait(self, prompt: str, timeout: int = 180) -> dict:
        """Type prompt, submit, and wait — returns the wait_for_response dict."""
        self.set_prompt(prompt)
        self.submit()
        return self.wait_for_response(timeout=timeout)
