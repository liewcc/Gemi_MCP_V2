import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const engineConfigPath = path.resolve(__dirname, '../engine_config.json');

let port = 18900;
try {
  if (fs.existsSync(engineConfigPath)) {
    const config = JSON.parse(fs.readFileSync(engineConfigPath, 'utf8'));
    if (config.port !== undefined) {
      port = parseInt(config.port, 10);
    }
  }
} catch (e) {
  // fallback
}

const ENGINE_URL = `http://127.0.0.1:${port}`;

async function _get(path, params = {}) {
  const url = new URL(`${ENGINE_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function _post(path, body = {}) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

export const engine = {
  health:          ()              => _get('/health'),
  start:           (headless=true, activeUser=null, activeService=null) => _post('/engine/start', { headless, active_user: activeUser, active_service: activeService }),
  stop:            ()              => _post('/engine/stop'),
  getLogs:         (lines=80)      => _get('/engine/logs', { lines }).then(d => d.logs ?? []),
  getConfig:       ()              => _get('/engine/config'),
  getStatus:       ()              => _get('/browser/status'),
  navigate:        (url)           => _post('/browser/navigate', { url }),
  setPrompt:       (text)          => _post('/browser/prompt', { text }),
  submit:          ()              => _post('/browser/submit'),
  waitResponse:    (timeout=60)    => _post('/browser/wait_response', { timeout }),
  getLastResponse: ()              => _get('/browser/last_response'),
  newChat:         ()              => _post('/browser/new_chat'),
  discover:        ()              => _post('/browser/discover'),
  switchService:   (service)       => _post('/browser/switch_service', { service }),
  registerTui:        (pid)           => _post('/tui/register', { pid }),
  switchAccount:      (username)      => _post('/engine/switch_account', { username }),
  getProfiles:        ()              => _get('/engine/profiles').then(d => d.profiles ?? []),
  saveConfig:         (updates)       => _post('/engine/config', updates),
  startRegistration:  (profileName)  => _post('/engine/start_registration', profileName ? { profile_name: profileName } : {}),
  stopRegistration:   ()              => _post('/engine/stop_registration'),
  captureDom:      ()              => _post('/browser/capture_dom'),
  screenshot:      (relPath)       => _get('/browser/screenshot', { path: relPath }),
  click:           (x, y)          => _get('/browser/click', { x, y }),
};
