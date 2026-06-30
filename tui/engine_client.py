import httpx

class EngineClient:
    def __init__(self, base_url: str = "http://127.0.0.1:18800"):
        self.client = httpx.Client(base_url=base_url)

    def close(self):
        self.client.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

    def _get(self, path: str, params: dict | None = None) -> dict:
        try:
            response = self.client.get(path, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise httpx.HTTPStatusError(f"HTTP error: {e}", request=e.request, response=e.response) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

    def _post(self, path: str, data: dict | None = None) -> dict:
        try:
            response = self.client.post(path, json=data)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise httpx.HTTPStatusError(f"HTTP error: {e}", request=e.request, response=e.response) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

    def health(self) -> dict:
        return self._get("/health")

    def start(self, headless: bool = True) -> dict:
        return self._post("/engine/start", {"headless": headless})

    def stop(self) -> dict:
        return self._post("/engine/stop")

    def get_logs(self, lines: int = 80) -> list:
        data = self._get("/engine/logs", {"lines": lines})
        return data.get("logs", [])

    def get_config(self) -> dict:
        return self._get("/engine/config")

    def get_status(self) -> dict:
        return self._get("/browser/status")

    def navigate(self, url: str) -> dict:
        return self._post("/browser/navigate", {"url": url})

    def set_prompt(self, text: str) -> dict:
        return self._post("/browser/prompt", {"text": text})

    def submit(self) -> dict:
        return self._post("/browser/submit")

    def wait_for_response(self, timeout: int = 60) -> dict:
        return self._post("/browser/wait_response", {"timeout": timeout})

    def get_last_response(self) -> dict:
        return self._get("/browser/last_response")

    def new_chat(self) -> dict:
        return self._post("/browser/new_chat")

    def discover(self) -> dict:
        return self._post("/browser/discover")

    def switch_service(self, service: str) -> dict:
        return self._post("/browser/switch_service", {"service": service})

    def register_tui(self, pid: int) -> dict:
        return self._post("/tui/register", {"pid": pid})

    def switch_account(self, username: str) -> dict:
        return self._post("/engine/switch_account", {"username": username})

    def get_profiles(self) -> list:
        data = self._get("/engine/profiles")
        return data.get("profiles", [])

    def repack_profiles(self) -> dict:
        return self._post("/engine/profiles/repack")

    def delete_profile(self, profile_name: str) -> dict:
        return self._post("/engine/profile/delete", {"profile_name": profile_name})

    def create_profile(self, email: str, name: str) -> dict:
        return self._post("/engine/profile/create", {"email": email, "name": name})

    def edit_profile_name(self, profile_name: str, new_name: str) -> dict:
        return self._post("/engine/profile/edit_name", {"profile_name": profile_name, "new_name": new_name})
