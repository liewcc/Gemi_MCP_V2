import React, { useState, useEffect, useCallback, useRef } from 'react';
import { render, Box, Text, useInput, useApp, useStdin, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { engine } from './engine_client.js';
import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR   = path.resolve(__dirname, '..', '..');
const ENGINE_DIR = path.resolve(__dirname, '..', '..', 'Gemi_Engine_V2');
const ENGINE_PY_CONSOLE  = path.join(ENGINE_DIR, '.venv', 'Scripts', 'python.exe');
const ENGINE_PY_HIDDEN   = path.join(ENGINE_DIR, '.venv', 'Scripts', 'pythonw.exe');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

if (!fs.existsSync(CONFIG_PATH)) {
  const defaultCfg = {
    headless: true,
    auto_launch: false,
    active_profile: null,
    active_user: '',
    active_service: 'gemini'
  };
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultCfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to create default config.json:', e.message);
  }
}

// ── Local Account Management Helpers (Thin Engine Architecture) ──────────────
const DATA_DIR = path.join(ENGINE_DIR, 'browser_user_data');
const LOCAL_STATE_PATH = path.join(DATA_DIR, 'Local State');

function readLocalState() {
  if (!fs.existsSync(LOCAL_STATE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(LOCAL_STATE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeLocalState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOCAL_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function clearChromeLocks() {
  try {
    const cmd = `powershell -NoProfile -Command "Get-Process -Name chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*ms-playwright*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`;
    execSync(cmd, { stdio: 'ignore' });
  } catch (e) {}
}

function tuiDeleteProfile(profileName) {
  const logFile = path.join(ROOT_DIR, 'tui_debug.log');
  try {
    fs.appendFileSync(logFile, `[tuiDeleteProfile] called with profileName: "${profileName}"\n`);
  } catch (e) {}

  clearChromeLocks();
  const profilePath = path.join(DATA_DIR, profileName);
  try {
    fs.appendFileSync(logFile, `[tuiDeleteProfile] DATA_DIR: "${DATA_DIR}", profilePath: "${profilePath}"\n`);
    fs.appendFileSync(logFile, `[tuiDeleteProfile] profilePath exists: ${fs.existsSync(profilePath)}\n`);
  } catch (e) {}

  if (fs.existsSync(profilePath)) {
    try {
      fs.rmSync(profilePath, { recursive: true, force: true });
      try { fs.appendFileSync(logFile, `[tuiDeleteProfile] fs.rmSync completed\n`); } catch (e) {}
    } catch (err) {
      try { fs.appendFileSync(logFile, `[tuiDeleteProfile] fs.rmSync ERROR: ${err.message}\n`); } catch (e) {}
      throw err;
    }
  }

  const localState = readLocalState();
  if (localState.profile) {
    const profile = localState.profile;
    if (profile.info_cache && profile.info_cache[profileName]) {
      delete profile.info_cache[profileName];
    }
    if (profile.profiles_order) {
      profile.profiles_order = profile.profiles_order.filter(p => p !== profileName);
    }
    if (profile.last_active_profiles) {
      profile.last_active_profiles = profile.last_active_profiles.filter(p => p !== profileName);
    }
    if (profile.last_used === profileName) {
      profile.last_used = (profile.profiles_order && profile.profiles_order.length > 0) ? profile.profiles_order[0] : '';
    }
  }
  if (localState.variations_google_groups && localState.variations_google_groups[profileName]) {
    delete localState.variations_google_groups[profileName];
  }
  try { fs.appendFileSync(logFile, `[tuiDeleteProfile] writing Local State...\n`); } catch (e) {}
  writeLocalState(localState);
  try { fs.appendFileSync(logFile, `[tuiDeleteProfile] Local State written successfully\n`); } catch (e) {}

  const cfg = readConfig();
  if (cfg.active_profile === profileName) {
    cfg.active_profile = null;
    cfg.active_user = '';
    try { fs.appendFileSync(logFile, `[tuiDeleteProfile] updating config.json...\n`); } catch (e) {}
    writeConfig(cfg);
    try { fs.appendFileSync(logFile, `[tuiDeleteProfile] config.json written\n`); } catch (e) {}
  }
}


function tuiEditProfileName(profileName, newName) {
  const localState = readLocalState();
  if (localState.profile && localState.profile.info_cache && localState.profile.info_cache[profileName]) {
    localState.profile.info_cache[profileName].name = newName;
    localState.profile.info_cache[profileName].gaia_name = newName;
    writeLocalState(localState);
  }
}

function tuiRepackProfileIDs() {
  clearChromeLocks();
  if (!fs.existsSync(DATA_DIR)) return;

  const profileFolders = [];
  fs.readdirSync(DATA_DIR).forEach(d => {
    if (d.match(/^Profile \d+$/)) {
      if (fs.statSync(path.join(DATA_DIR, d)).isDirectory()) {
        profileFolders.push(d);
      }
    }
  });

  profileFolders.sort((a, b) => {
    const na = parseInt(a.split(' ')[1], 10);
    const nb = parseInt(b.split(' ')[1], 10);
    return na - nb;
  });

  const renameMap = {};
  profileFolders.forEach((folder, idx) => {
    const expectedName = `Profile ${idx + 1}`;
    renameMap[folder] = expectedName;
  });

  // Phase A: Rename to temporary suffix first to avoid collisions
  profileFolders.forEach(folder => {
    const src = path.join(DATA_DIR, folder);
    const tempDst = path.join(DATA_DIR, folder + '_temp');
    if (folder !== renameMap[folder]) {
      try {
        fs.renameSync(src, tempDst);
      } catch (e) {}
    }
  });

  // Phase B: Rename from temporary suffix to final expected destination
  profileFolders.forEach(folder => {
    const expectedName = renameMap[folder];
    const tempSrc = path.join(DATA_DIR, folder + '_temp');
    const finalDst = path.join(DATA_DIR, expectedName);
    if (folder !== expectedName) {
      try {
        fs.renameSync(tempSrc, finalDst);
      } catch (e) {}
    }
  });

  const localState = readLocalState();
  if (localState.profile) {
    const profile = localState.profile;
    const infoCache = profile.info_cache || {};

    const newInfoCache = {};
    Object.entries(infoCache).forEach(([oldName, info]) => {
      if (oldName.match(/^Profile \d+$/)) {
        if (renameMap[oldName]) {
          newInfoCache[renameMap[oldName]] = info;
        }
      } else {
        newInfoCache[oldName] = info;
      }
    });

    const originalOrder = profile.profiles_order || [];
    const newProfilesOrder = [];
    originalOrder.forEach(p => {
      if (!p.match(/^Profile \d+$/)) {
        if (newInfoCache[p]) {
          newProfilesOrder.push(p);
        }
      }
    });

    Object.values(renameMap)
      .sort((a, b) => parseInt(a.split(' ')[1], 10) - parseInt(b.split(' ')[1], 10))
      .forEach(val => {
        newProfilesOrder.push(val);
      });

    profile.info_cache = newInfoCache;
    profile.profiles_order = newProfilesOrder;
    profile.profiles_created = Object.keys(renameMap).length;

    const lastUsed = profile.last_used || '';
    if (lastUsed.match(/^Profile \d+$/)) {
      if (renameMap[lastUsed]) {
        profile.last_used = renameMap[lastUsed];
      } else {
        profile.last_used = Object.keys(renameMap).length > 0 ? 'Profile 1' : '';
      }
    }

    if (profile.last_active_profiles) {
      profile.last_active_profiles = profile.last_active_profiles.map(p => {
        if (p.match(/^Profile \d+$/)) {
          return renameMap[p] || p;
        }
        return p;
      });
    }
  }

  if (localState.variations_google_groups) {
    const newVgg = {};
    Object.entries(localState.variations_google_groups).forEach(([oldName, val]) => {
      if (oldName.match(/^Profile \d+$/)) {
        if (renameMap[oldName]) {
          newVgg[renameMap[oldName]] = val;
        }
      } else {
        newVgg[oldName] = val;
      }
    });
    localState.variations_google_groups = newVgg;
  }

  writeLocalState(localState);

  const cfg = readConfig();
  if (cfg.active_profile) {
    const active = cfg.active_profile;
    if (active.match(/^Profile \d+$/)) {
      if (renameMap[active]) {
        cfg.active_profile = renameMap[active];
      } else {
        cfg.active_profile = null;
        cfg.active_user = '';
      }
      writeConfig(cfg);
    }
  }
}


// ── Dashboard groups (collapsible tree) ──────────────────────────────────────
const GROUPS = [
  {
    id: 'actions',
    label: 'Actions',
    items: [
      { id: 'engine',      label: 'Engine',              type: 'toggle' },
      { id: 'browser',     label: 'Browser',             type: 'toggle' },
      { id: 'headless',    label: 'Headless',            type: 'toggle' },
      { id: 'auto_launch', label: 'Auto-launch Browser', type: 'toggle' },
    ]
  },
  {
    id: 'browser_control',
    label: 'Browser Control',
    items: [
      { id: 'new_chat',  label: 'New Chat', type: 'action' },
      { id: 'submit',    label: 'Submit',   type: 'action' },
      { id: 'discover',  label: 'Discover', type: 'action' },
    ]
  }
];

// Build the flat visible list based on which groups are expanded
function buildVisibleList(expandedGroups) {
  const list = [];
  for (const group of GROUPS) {
    const expanded = expandedGroups.has(group.id);
    list.push({ kind: 'group', id: group.id, label: group.label, expanded, items: group.items });
    if (expanded) {
      for (const item of group.items) {
        list.push({ kind: 'item', ...item, groupId: group.id });
      }
    }
  }
  return list;
}

const ACCT_ACTIONS = [
  'Switch to Selected',
  'Edit Display Name',
  'Delete Profile',
  'Rebuild Profile',
  'Create New Profile',
  'Repack Profile IDs'
];

// LEFT_PANEL_WIDTH and LEFT_PANEL_PAD are calculated dynamically inside the App component to support flexible sizing.

// ── Helpers ────────────────────────────────────────────────────────────────────

// CJK and full-width characters take 2 terminal columns each
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100  && cp <= 0x115F)  || // Hangul Jamo
      (cp >= 0x2E80  && cp <= 0x303F)  || // CJK Radicals
      (cp >= 0x3040  && cp <= 0x33FF)  || // Japanese
      (cp >= 0x3400  && cp <= 0x4DBF)  || // CJK Extension A
      (cp >= 0x4E00  && cp <= 0x9FFF)  || // CJK Unified
      (cp >= 0xA000  && cp <= 0xA4CF)  || // Yi
      (cp >= 0xAC00  && cp <= 0xD7AF)  || // Hangul Syllables
      (cp >= 0xF900  && cp <= 0xFAFF)  || // CJK Compatibility
      (cp >= 0xFE10  && cp <= 0xFE1F)  || // Vertical
      (cp >= 0xFE30  && cp <= 0xFE4F)  || // CJK Compatibility Forms
      (cp >= 0xFF00  && cp <= 0xFF60)  || // Fullwidth
      (cp >= 0xFFE0  && cp <= 0xFFE6)  || // Fullwidth Signs
      (cp >= 0x1F300 && cp <= 0x1F64F) || // Misc Symbols
      (cp >= 0x20000 && cp <= 0x2A6DF)    // CJK Extension B
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Pad a string to a given display width (accounting for CJK double-width chars)
function padEndDisplay(str, targetWidth) {
  const dw = displayWidth(str);
  return dw >= targetWidth ? str : str + ' '.repeat(targetWidth - dw);
}

// Truncate a string to fit within a given display width
function truncateDisplay(str, maxWidth) {
  let w = 0;
  let result = '';
  for (const ch of str) {
    const cw = displayWidth(ch);
    if (w + cw > maxWidth) break;
    result += ch;
    w += cw;
  }
  return result;
}

function logColor(line) {
  if (line.includes('ERROR'))   return 'red';
  if (line.includes('WARNING')) return 'yellow';
  if (line.includes('DEBUG'))   return 'gray';
  return 'white';
}

function profileId(dir) {
  const m = dir.match(/(\d+)$/);
  return m ? parseInt(m[1]) : dir;
}

function scrollbar(total, visible, offset) {
  if (total <= visible) return Array(visible).fill(' ');
  const barH  = Math.max(1, Math.round((visible * visible) / total));
  const maxPos = visible - barH;
  const pos   = Math.round((offset / Math.max(1, total - visible)) * maxPos);
  return Array.from({ length: visible }, (_, i) =>
    i >= pos && i < pos + barH ? '█' : '░'
  );
}

// ── Sub-components (all memoized to prevent cross-panel re-renders) ─────────────

const Header = React.memo(function Header({ engineStatus, browserStatus, activeAccount, busy, queueDepth }) {
  const engColor = engineStatus === 'online'  ? 'green'
                 : engineStatus === 'offline' ? 'red'
                 : 'yellow';  // stopped
  const brsColor = browserStatus === 'online' ? 'green' : 'red';
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text>Engine: <Text color={engColor} bold>{engineStatus}</Text></Text>
      <Text>  │  Browser: <Text color={brsColor} bold>{browserStatus}</Text></Text>
      <Text>  │  Account: <Text color="cyan">{activeAccount || '—'}</Text></Text>
      {busy && <Text>  │  <Text color="yellow" bold>[BUSY q:{queueDepth}]</Text></Text>}
    </Box>
  );
});

const MenuBar = React.memo(function MenuBar({ activeTab, mode }) {
  const isMenu = mode === 'menu';
  return (
    <Box flexDirection="row" paddingX={1} marginTop={0}>
      <Text
        color={activeTab === 'dashboard' ? (isMenu ? 'black' : 'cyan') : 'gray'}
        backgroundColor={isMenu && activeTab === 'dashboard' ? 'cyan' : undefined}
        bold={!isMenu && activeTab === 'dashboard'}
      >
        {' DASHBOARD '}
      </Text>
      <Text>  </Text>
      <Text
        color={activeTab === 'account' ? (isMenu ? 'black' : 'cyan') : 'gray'}
        backgroundColor={isMenu && activeTab === 'account' ? 'cyan' : undefined}
        bold={!isMenu && activeTab === 'account'}
      >
        {' ACCOUNT '}
      </Text>
      <Text>  </Text>
      {isMenu && <Text dimColor>(← → switch)</Text>}
    </Box>
  );
});

const Controls = React.memo(function Controls({
  selected, mode, height,
  engineStatus, browserOn, headlessOn, autoLaunchOn,
  width, visibleList
}) {
  const actionsActive = mode === 'actions';
  const engineOn = engineStatus !== 'offline';
  // Exact row layout: width - 2(border) - 2(paddingX) = available content
  const ROW_W  = width - 4;
  const BADGE_W = 5;   // '[OFF]'=5, '[ON] '=5
  const LABEL_W = ROW_W - BADGE_W;

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single"
         borderColor={actionsActive ? 'cyan' : undefined} paddingX={1} flexShrink={0}>
      <Box flexDirection="column">
        {visibleList.map((entry, i) => {
          const isSelected = i === selected;

          if (entry.kind === 'group') {
            // ── Group header row: same structure as item rows to prevent wrapping ──
            const arrow     = entry.expanded ? 'v ' : '> ';
            const labelText = (arrow + entry.label).padEnd(LABEL_W);
            return (
              <Box key={entry.id} flexDirection="row" width={ROW_W}>
                <Box width={LABEL_W}>
                  <Text
                    color={isSelected ? (actionsActive ? 'black' : 'cyan') : 'white'}
                    backgroundColor={actionsActive && isSelected ? 'cyan' : undefined}
                    bold
                  >
                    {labelText}
                  </Text>
                </Box>
                <Box width={BADGE_W}>
                  <Text>{' '.repeat(BADGE_W)}</Text>
                </Box>
              </Box>
            );
          }

          // ── Item row (indented, with optional badge) ──
          const stateOn = entry.id === 'engine'      ? engineOn
                        : entry.id === 'browser'     ? browserOn
                        : entry.id === 'headless'    ? headlessOn
                        : entry.id === 'auto_launch' ? autoLaunchOn
                        : null;
          const labelText = ('  ' + entry.label).padEnd(LABEL_W);
          const badgeText = entry.type === 'toggle'
            ? (stateOn ? '[ON] ' : '[OFF]')
            : '';
          return (
            <Box key={entry.id} flexDirection="row" width={ROW_W}>
              <Box width={LABEL_W}>
                <Text
                  color={isSelected ? (actionsActive ? 'black' : 'cyan') : undefined}
                  backgroundColor={actionsActive && isSelected ? 'cyan' : undefined}
                >
                  {labelText}
                </Text>
              </Box>
              {entry.type === 'toggle' && (
                <Box width={BADGE_W}>
                  <Text color={stateOn ? 'green' : 'red'} bold>
                    {badgeText}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
});

const AccountActions = React.memo(function AccountActions({
  selectedAction,
  mode,
  height,
  confirmMsg,
  inputMsg,
  inputValue,
  onInputChange,
  onInputSubmit,
  width
}) {
  const active = mode === 'acct_actions';
  const confirmActive = mode === 'acct_confirm';
  const inputActive = mode === 'acct_input';

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single"
         borderColor={active || confirmActive || inputActive ? 'cyan' : undefined} paddingX={1} flexShrink={0}>
      <Text bold underline>Account Setting {active ? '◀' : ''}</Text>
      
      {confirmActive ? (
        <Box flexDirection="column">
          <Text>{confirmMsg}</Text>
          <Text>[y] Confirm  [n] Cancel</Text>
        </Box>
      ) : inputActive ? (
        <Box flexDirection="column">
          <Text>{inputMsg}</Text>
          <Box borderStyle="round" borderColor="cyan" paddingX={1}>
            <TextInput
              value={inputValue}
              onChange={onInputChange}
              onSubmit={onInputSubmit}
              focus={true}
            />
          </Box>
          <Text dimColor>Press Enter to save</Text>
          <Text dimColor>Press Esc to cancel</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {ACCT_ACTIONS.map((action, i) => (
            <Box key={action}>
              <Text
                color={i === selectedAction ? (active ? 'black' : 'cyan') : undefined}
                backgroundColor={active && i === selectedAction ? 'cyan' : undefined}
              >
                {` ${action} `}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
});

const AccountsPane = React.memo(function AccountsPane({ profiles, selected, mode, height, width }) {
  const active    = mode === 'account_list';
  const innerRows = Math.max(1, height - 6);
  const total     = profiles.length;
  const scrollOff = Math.max(0, Math.min(selected - Math.floor(innerRows / 2), total - innerRows));
  const visible   = profiles.slice(scrollOff, scrollOff + innerRows);
  const bar       = scrollbar(total, innerRows, scrollOff);

  const nameWidth = Math.min(30, profiles.length > 0
    ? Math.max(8, ...profiles.map(p => displayWidth(p.name || p.email || p.dir || '')))
    : 8);

  const textWidth = Math.max(20, width - 4 - (total > innerRows ? 1 : 0) - 1);
  const maxEmLen = Math.max(0, textWidth - 11 - nameWidth);
  const headerRow = padEndDisplay(` ID     ${'Display Name'.padEnd(nameWidth)}   Email`, textWidth);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single"
         borderColor={active ? 'cyan' : undefined} paddingX={1} flexShrink={0}>
      <Text bold underline>Account List {active ? '◀' : ''} <Text dimColor>({total})</Text></Text>
      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          <Text color="white" backgroundColor="blue">{headerRow}</Text>
          {total === 0
            ? <Text dimColor>No profiles found</Text>
            : visible.map((p, vi) => {
                const gi    = vi + scrollOff;
                const id    = profileId(p.dir);
                const rawNm = p.name || p.email || p.dir || '';
                const nm    = padEndDisplay(truncateDisplay(rawNm, nameWidth), nameWidth);
                const em    = p.email || '';
                const displayEm = truncateDisplay(em, maxEmLen);
                const isSelected = gi === selected;
                const isActiveSel = active && isSelected;
                const rowStr = padEndDisplay(` ${String(id).padStart(2)}     ${nm}   ${displayEm}`, textWidth);
                return (
                  <Text key={p.dir}
                    color={isSelected ? (active ? 'black' : 'cyan') : 'white'}
                    backgroundColor={isActiveSel ? 'cyan' : undefined}
                  >
                    {rowStr}
                  </Text>
                );
              })
          }
        </Box>
        {total > innerRows && (
          <Box flexDirection="column" width={1}>
            <Text dimColor> </Text>
            <Text dimColor> </Text>
            {bar.map((ch, i) => <Text key={i} dimColor>{ch}</Text>)}
          </Box>
        )}
      </Box>
    </Box>
  );
});

const LogPanel = React.memo(function LogPanel({ logs, scrollOffset, mode, height, width }) {
  const active    = mode === 'log';
  const innerRows = Math.max(1, height - 4);
  const visible   = logs.slice(scrollOffset, scrollOffset + innerRows);
  const bar       = scrollbar(logs.length, innerRows, scrollOffset);

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="single"
         borderColor={active ? 'cyan' : undefined} paddingX={1} flexShrink={0}>
      <Text bold underline>Engine Log {active ? '◀' : ''} <Text dimColor>({logs.length} lines)</Text></Text>
      <Box marginTop={1} flexDirection="row">
        <Box flexDirection="column" flexGrow={1}>
          {visible.map((line, i) => (
            <Text key={i} color={logColor(line)} wrap="truncate">
              {line.trimEnd()}
            </Text>
          ))}
        </Box>
        {logs.length > innerRows && (
          <Box flexDirection="column" width={1}>
            {bar.map((ch, i) => <Text key={i} dimColor>{ch}</Text>)}
          </Box>
        )}
      </Box>
    </Box>
  );
});

const StatusBar = React.memo(function StatusBar({ message }) {
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text dimColor>▶ </Text>
      <Text wrap="truncate">{message}</Text>
    </Box>
  );
});

// ── App ────────────────────────────────────────────────────────────────────────

function App() {
  const { exit }               = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout }             = useStdout();

  // Track terminal dimensions in state so any resize triggers a re-render.
  // Reading stdout.rows/columns directly (without state) is a snapshot at mount
  // time only — the log panel clips because React never re-renders on SIGWINCH.
  const [termSize, setTermSize] = useState({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermSize({ rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 });
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  const termRows        = termSize.rows;
  const termCols        = termSize.cols;
  const mainHeight      = Math.max(8, termRows - 7);
  const leftPanelWidth  = 30; // Compact fixed width
  const rightPanelWidth = Math.max(20, termCols - leftPanelWidth);

  const [engineStatus, setEngineStatus] = useState('offline');
  const [browserStatus, setBrowserStatus] = useState('offline');
  const [activeAccount, setActiveAccount] = useState('');
  const [busy, setBusy]                 = useState(false);
  const [queueDepth, setQueueDepth]     = useState(0);
  const [logs, setLogs]                 = useState([]);
  const [logScroll, setLogScroll]       = useState(0);
  const logAutoScroll                   = useRef(true);
  const [profiles, setProfiles]         = useState([]);
  const [pendingAction, setPendingAction] = useState(null);
  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await engine.getProfiles());
    } catch (e) {}
  }, []);
  const [selected, setSelected]         = useState(0);
  const [acctSelected, setAcctSelected] = useState(0);
  const [input, setInput]               = useState('');
  
  const [activeTab, setActiveTab]       = useState('dashboard');
  const [mode, setMode]                 = useState('menu');
  const [acctActionSelected, setAcctActionSelected] = useState(0);
  const [acctConfirmMsg, setAcctConfirmMsg] = useState('');
  const [acctInputMsg, setAcctInputMsg] = useState('');
  const [acctInputValue, setAcctInputValue] = useState('');

  const [statusBar, setStatusBar]       = useState('Ready.');
  const [servicePid, setServicePid]     = useState(null);
  const [browserPids, setBrowserPids]   = useState([]);
  const [headlessMode, setHeadlessMode] = useState(true);  // loaded from config
  const [autoLaunch, setAutoLaunch]     = useState(false);  // loaded from config
  const [expandedGroups, setExpandedGroups] = useState(new Set()); // collapsed by default
  const servicePidRef  = useRef(null);
  const browserPidsRef = useRef([]);
  const headlessModeRef = useRef(true);
  const autoLaunchRef   = useRef(false);
  const engineStatusRef = useRef('offline');
  const browserStatusRef = useRef('offline');
  const autoLaunchedRef = useRef(false);

  const logInnerRows = Math.max(1, mainHeight - 4);

  // Refs so handlers always have fresh values
  const mainHeightRef   = useRef(mainHeight);
  const logsRef         = useRef(logs);
  const profilesRef     = useRef(profiles);
  const acctSelectedRef = useRef(acctSelected);
  const inputSubmitRef   = useRef(null);
  const modeRef = useRef(mode);
  const pendingActionRef = useRef(pendingAction);
  const activeTabRef = useRef(activeTab);
  const expandedGroupsRef = useRef(expandedGroups);
  const selectedRef = useRef(selected);
  const acctActionSelectedRef = useRef(acctActionSelected);

  useEffect(() => { mainHeightRef.current = mainHeight; }, [mainHeight]);
  useEffect(() => { logsRef.current = logs; }, [logs]);
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);
  useEffect(() => { acctSelectedRef.current = acctSelected; }, [acctSelected]);
  useEffect(() => { engineStatusRef.current = engineStatus; }, [engineStatus]);
  useEffect(() => { browserStatusRef.current = browserStatus; }, [browserStatus]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { pendingActionRef.current = pendingAction; }, [pendingAction]);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { expandedGroupsRef.current = expandedGroups; }, [expandedGroups]);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { acctActionSelectedRef.current = acctActionSelected; }, [acctActionSelected]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const runAction = useCallback(async (actionId) => {
    setStatusBar(`Running: ${actionId}…`);
    try {
      let result;
      switch (actionId) {
        case 'new_chat': result = await engine.newChat(); break;
        case 'submit':   result = await engine.submit(); break;
        case 'discover': result = await engine.discover(); break;
      }
      setStatusBar(`${actionId} → ${JSON.stringify(result).slice(0, 120)}`);
    } catch (e) {
      setStatusBar(`ERROR: ${e.message}`);
    }
  }, []);

  const toggleDashItem = useCallback(async (id) => {
    try {
      if (id === 'engine') {
        const pid = servicePidRef.current;
        if (pid) {
          // ON→OFF: kill Python service directly (no API — kills browser too via /T)
          setStatusBar('Killing engine service…');
          setEngineStatus('offline');
          setServicePid(null); servicePidRef.current = null;
          try { execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'ignore' }); } catch {}
          setStatusBar('Engine stopped.');
        } else {
          // OFF→ON: spawn Python service only (no browser started)
          setStatusBar('Starting engine service…');
          const _cfg = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })();
          const _showConsole = !!_cfg.show_engine_console;
          const _enginePy = _showConsole ? ENGINE_PY_CONSOLE : ENGINE_PY_HIDDEN;
          const proc = spawn(_enginePy, ['engine_service.py'], {
            cwd: ENGINE_DIR, detached: true, stdio: 'ignore', windowsHide: !_showConsole,
          });
          proc.unref();
          let up = false;
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
              const h = await engine.health();
              setServicePid(h.service_pid); servicePidRef.current = h.service_pid;
              setEngineStatus(h.engine_running ? 'running' : 'stopped');
              up = true; break;
            } catch {}
          }
          if (up) {
            setStatusBar('Engine service started.');
            if (autoLaunchRef.current) {
              setStatusBar('Auto-launching browser…');
              try {
                const hl = headlessModeRef.current;
                await engine.start(hl);
                setStatusBar('Engine started & Browser auto-launched.');
              } catch (e) {
                setStatusBar(`Engine started, but Browser auto-launch failed: ${e.message}`);
              }
            }
          } else {
            setStatusBar('Engine did not respond in time.');
          }
        }
      } else if (id === 'browser') {
        const isOn = browserStatus === 'online';  // Playwright browser running
        if (isOn) {
          // ON→OFF: stop browser via API
          setStatusBar('Stopping browser…');
          setBrowserStatus('offline');
          await engine.stop();
          setStatusBar('Browser stopped.');
        } else {
          // OFF→ON: start browser with current headless setting
          const hl = headlessModeRef.current;
          setStatusBar(`Starting browser (${hl ? 'headless' : 'headed'})…`);
          await engine.start(hl);
          setStatusBar('Browser started.');
        }
      } else if (id === 'headless') {
        // Toggle headless mode and persist to config
        const next = !headlessModeRef.current;
        setHeadlessMode(next);
        headlessModeRef.current = next;
        setStatusBar(`Headless mode: ${next ? 'ON' : 'OFF'} (takes effect on next Browser start)`);
        try { await engine.saveConfig({ headless: next }); } catch {}
      } else if (id === 'auto_launch') {
        const next = !autoLaunchRef.current;
        setAutoLaunch(next);
        autoLaunchRef.current = next;
        setStatusBar(`Auto-launch Browser: ${next ? 'ON' : 'OFF'}`);
        try { await engine.saveConfig({ auto_launch: next }); } catch {}
      }
    } catch (e) {
      setStatusBar(`ERROR: ${e.message}`);
    }
  }, [engineStatus, browserStatus]);

  const sendPrompt = useCallback(async (text) => {
    if (!text.trim()) return;
    setStatusBar('Sending prompt…');
    try {
      await engine.setPrompt(text);
      await engine.submit();
      setInput('');
      setStatusBar('Submitted. Waiting for response…');
      const result = await engine.waitResponse(60);
      setStatusBar(`done=${result.has_image ?? false} │ ${(result.text ?? '').slice(0, 100)}`);
    } catch (e) {
      setStatusBar(`ERROR: ${e.message}`);
    }
  }, []);

  const doSwitchAccount = useCallback(async (idx) => {
    const profile = profilesRef.current[idx];
    if (!profile) return;
    const target = profile.email || profile.dir;
    setStatusBar(`Switching to ${target}…`);
    try {
      // 1. Stop current browser
      await engine.stop();

      // 2. Persist chosen profile & user to config.json
      await engine.saveConfig({
        active_profile: profile.dir,
        active_user: target
      });

      // 3. Clear lingering Playwright Chromium processes to release file locks
      clearChromeLocks();

      // 4. Force-remove existing Default junction folders in sandbox so mklink won't fail
      const rootSandboxDefault = path.join(ROOT_DIR, 'browser_session_sandbox', 'Default');
      const engineSandboxDefault = path.join(ENGINE_DIR, 'browser_session_sandbox', 'Default');
      [rootSandboxDefault, engineSandboxDefault].forEach(p => {
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { recursive: true, force: true });
          } catch (err) {}
        }
      });

      // 5. Short wait for FS and process handle cleanup
      await new Promise(r => setTimeout(r, 1000));

      // 6. Start browser with the target profile
      const hl = headlessModeRef.current;
      await engine.start(hl);

      setStatusBar(`Switched to ${target}`);
    } catch (e) {
      setStatusBar(`ERROR: ${e.message}`);
    }
  }, []);


  const handleAcctInputSubmit = useCallback((val) => {
    if (inputSubmitRef.current) inputSubmitRef.current(val);
    setMode('acct_actions');
  }, []);

  const handleAcctAction = useCallback((action) => {
    const browserRunning = browserStatusRef.current === 'online';

    if (action === 'Switch to Selected') {
      doSwitchAccount(acctSelected);
    } else if (action === 'Repack Profile IDs') {
      if (browserRunning) {
        setStatusBar('ERROR: Close the browser before repacking profiles.');
        return;
      }
      try {
        setStatusBar('Repacking profiles...');
        tuiRepackProfileIDs();
        refreshProfiles();
        setStatusBar('Profiles repacked.');
      } catch (e) {
        setStatusBar(`ERROR: ${e.message}`);
      }
    } else if (action === 'Delete Profile') {
      if (browserRunning) {
        setStatusBar('ERROR: Close the browser before deleting profiles.');
        return;
      }
      const p = profilesRef.current[acctSelected];
      if (!p) return;
      const nm = p.name || p.email || p.dir;
      try {
        setStatusBar(`Deleting profile ${nm}...`);
        tuiDeleteProfile(p.dir);
        refreshProfiles();
        setStatusBar(`Deleted ${nm}`);
      } catch (e) {
        setStatusBar(`ERROR: ${e.message}`);
      }
    } else if (action === 'Rebuild Profile') {
      // Rebuild = open unsandboxed headed browser on the selected profile for re-login.
      // Uses start_registration which writes directly to browser_user_data/ (no sandbox).
      if (browserRunning) {
        setStatusBar('ERROR: Close the browser before rebuilding profiles.');
        return;
      }
      const p = profilesRef.current[acctSelected];
      if (!p) return;
      (async () => {
        try {
          setStatusBar(`Opening browser for re-login on ${p.name || p.dir}...`);
          clearChromeLocks();
          await engine.saveConfig({ active_profile: p.dir, active_user: p.email || '' });
          await engine.startRegistration(p.dir);
          setStatusBar(`Browser open - please sign in for ${p.name || p.dir}. Close browser when done.`);
          refreshProfiles();
        } catch (e) {
          setStatusBar(`ERROR: ${e.message}`);
        }
      })();
    } else if (action === 'Edit Display Name') {
      if (browserRunning) {
        setStatusBar('ERROR: Close the browser before editing profiles.');
        return;
      }
      const p = profilesRef.current[acctSelected];
      if (!p) return;
      setAcctInputMsg('Edit Display Name:');
      setAcctInputValue(p.name || '');
      inputSubmitRef.current = (val) => {
        try {
          setStatusBar('Editing profile name...');
          tuiEditProfileName(p.dir, val);
          refreshProfiles();
          setStatusBar('Name updated');
        } catch (e) {
          setStatusBar(`ERROR: ${e.message}`);
        }
      };
      setMode('acct_input');
    } else if (action === 'Create New Profile') {
      // Create = open a separate unsandboxed headed browser on the next available Profile N.
      // The engine's start_registration() handles profile slot selection and launches
      // Chromium directly on browser_user_data/ (no sandbox), so:
      //   - Google login works (no --enable-automation flag)
      //   - All data (cookies, Local State) is written to the real Profile N directory
      if (browserRunning) {
        setStatusBar('ERROR: Close the browser before creating a new profile.');
        return;
      }
      (async () => {
        try {
          setStatusBar('Opening registration browser...');
          clearChromeLocks();
          const res = await engine.startRegistration();
          const profileName = res?.profile || 'new profile';
          setStatusBar(`Browser open on ${profileName} - please sign in to Google. Close browser when done.`);
          refreshProfiles();
        } catch (e) {
          setStatusBar(`ERROR: ${e.message}`);
        }
      })();
    }
  }, [acctSelected, doSwitchAccount, refreshProfiles]);


  // ── Register TUI PID ─────────────────────────────────────────────────────────

  useEffect(() => {
    engine.registerTui(process.pid).catch(() => {});
  }, []);

  // ── Poll health ───────────────────────────────────────────────────────────────

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const h = await engine.health();
        const bPids = h.browser_pids ?? [];
        // Engine = service process alive (PID present); Browser = browser PIDs exist
        setEngineStatus(h.service_pid ? 'online' : 'offline');
        setBrowserStatus(bPids.length > 0 ? 'online' : 'offline');
        setServicePid(h.service_pid ?? null); servicePidRef.current = h.service_pid ?? null;
        setBrowserPids(bPids); browserPidsRef.current = bPids;
        setBusy(h.busy ?? false);
        setQueueDepth(h.queue_depth ?? 0);
      } catch {
        setEngineStatus('offline');
        setBrowserStatus('offline');
        setServicePid(null); servicePidRef.current = null;
        setBrowserPids([]); browserPidsRef.current = [];
        setBusy(false);
      }
    }, 2000);
    return () => clearInterval(poll);
  }, []);

  // ── Poll logs + config ────────────────────────────────────────────────────────

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const lines = await engine.getLogs(200);
        setLogs(prev => {
          if (prev.length === lines.length && prev[prev.length - 1] === lines[lines.length - 1])
            return prev;
          if (logAutoScroll.current)
            setLogScroll(Math.max(0, lines.length - logInnerRows));
          return lines;
        });
        const cfg = await engine.getConfig();
        if (cfg?.active_user != null) setActiveAccount(cfg.active_user || '');
        if (cfg?.headless !== undefined && cfg.headless !== headlessModeRef.current) {
          setHeadlessMode(!!cfg.headless);
          headlessModeRef.current = !!cfg.headless;
        }
        if (cfg?.auto_launch !== undefined && cfg.auto_launch !== autoLaunchRef.current) {
          setAutoLaunch(!!cfg.auto_launch);
          autoLaunchRef.current = !!cfg.auto_launch;
        }
        // Auto-launch browser if enabled in config and not already triggered
        if (cfg?.auto_launch && !autoLaunchedRef.current) {
          autoLaunchedRef.current = true;
          if (engineStatusRef.current === 'online' && browserStatusRef.current === 'offline') {
            setStatusBar('Auto-launching browser…');
            engine.start(!!cfg.headless)
              .then(() => setStatusBar('Browser auto-launched.'))
              .catch(e => setStatusBar(`Auto-launch failed: ${e.message}`));
          }
        }
      } catch {}
    }, 3000);
    return () => clearInterval(poll);
  }, [logInnerRows]);

  // ── Poll profiles ─────────────────────────────────────────────────────────────

  useEffect(() => {
    refreshProfiles();
    const poll = setInterval(refreshProfiles, 5000);
    return () => clearInterval(poll);
  }, [refreshProfiles]);


  // ── Keyboard ──────────────────────────────────────────────────────────────────

  useInput((char, key) => {
    const mode = modeRef.current;
    const activeTab = activeTabRef.current;
    const expandedGroups = expandedGroupsRef.current;
    const selected = selectedRef.current;
    const acctActionSelected = acctActionSelectedRef.current;
    const acctSelected = acctSelectedRef.current;
    const profiles = profilesRef.current;
    const logs = logsRef.current;

    if (key.ctrl && char === 'c') {
      engine.stop().catch(() => {}).finally(() => exit());
      return;
    }

    // ── acct_input: TextInput owns all keys except Esc/Tab ──────────────────
    if (mode === 'acct_input') {
      if (key.escape || key.tab) {
        setAcctInputValue('');
        setMode('acct_actions');
        setStatusBar('Canceled');
      }
      return; // let TextInput handle all other keys
    }



    // ── Tab / Esc: context-aware back navigation ─────────────────────────────
    if (key.tab || key.escape) {
      if (mode === 'log') {
        // right panel → back to left panel
        setMode('actions');
      } else if (mode === 'account_list') {
        // right panel → back to left panel
        setMode('acct_actions');
      } else {
        // left panel or menu → back to menu
        setMode('menu');
        setStatusBar('Returned to menu');
      }
      return;
    }

    // ── Menu bar ─────────────────────────────────────────────────────────────
    if (mode === 'menu') {
      if (key.leftArrow || key.rightArrow) {
        setActiveTab(prev => prev === 'dashboard' ? 'account' : 'dashboard');
      }
      if (key.return || key.downArrow) {
        setMode(activeTab === 'dashboard' ? 'actions' : 'acct_actions');
      }
      return;
    }

    // ── Dashboard left panel (actions) ───────────────────────────────────────
    if (mode === 'actions') {
      const vl    = buildVisibleList(expandedGroups);
      const entry = vl[selected];

      if (key.upArrow)   setSelected(s => Math.max(0, s - 1));
      if (key.downArrow) setSelected(s => Math.min(vl.length - 1, s + 1));

      // Right arrow: expand group OR move to log panel (on item)
      if (key.rightArrow) {
        if (entry?.kind === 'group') {
          if (!expandedGroups.has(entry.id)) {
            setExpandedGroups(prev => { const n = new Set(prev); n.add(entry.id); return n; });
          }
        } else if (entry?.kind === 'item') {
          setMode('log');
        }
      }

      // Left arrow: collapse group; if on item, collapse parent and jump to its header
      if (key.leftArrow) {
        if (entry?.kind === 'group') {
          if (expandedGroups.has(entry.id)) {
            setExpandedGroups(prev => { const n = new Set(prev); n.delete(entry.id); return n; });
          }
        } else if (entry?.kind === 'item') {
          const gid    = entry.groupId;
          const newVl  = buildVisibleList(new Set([...expandedGroups].filter(id => id !== gid)));
          const gIdx   = newVl.findIndex(e => e.kind === 'group' && e.id === gid);
          setExpandedGroups(prev => { const n = new Set(prev); n.delete(gid); return n; });
          setSelected(gIdx >= 0 ? gIdx : 0);
        }
      }

      // Enter: toggle (for toggle items) or run (for action items) or expand/collapse (for group header)
      if (key.return) {
        if (entry?.kind === 'group') {
          setExpandedGroups(prev => {
            const n = new Set(prev);
            if (n.has(entry.id)) n.delete(entry.id); else n.add(entry.id);
            return n;
          });
        } else if (entry?.kind === 'item') {
          if (entry.type === 'toggle') toggleDashItem(entry.id);
          else if (entry.type === 'action') runAction(entry.id);
        }
      }
      return;
    }

    // ── Dashboard right panel (log) ──────────────────────────────────────────
    if (mode === 'log') {
      if (key.upArrow) {
        logAutoScroll.current = false;
        setLogScroll(s => Math.max(0, s - 1));
      }
      if (key.downArrow) {
        setLogScroll(s => {
          const next = Math.min(Math.max(0, logs.length - logInnerRows), s + 1);
          logAutoScroll.current = next >= logs.length - logInnerRows;
          return next;
        });
      }
      return;
    }

    // ── Account left panel (acct_actions) ────────────────────────────────────
    if (mode === 'acct_actions') {
      if (key.upArrow)   setAcctActionSelected(s => Math.max(0, s - 1));
      if (key.downArrow) setAcctActionSelected(s => Math.min(ACCT_ACTIONS.length - 1, s + 1));
      if (key.return)    handleAcctAction(ACCT_ACTIONS[acctActionSelected]);
      if (key.rightArrow) setMode('account_list'); // → moves focus to right panel
      return;
    }

    // ── Account right panel (account_list) ───────────────────────────────────
    if (mode === 'account_list') {
      if (key.upArrow)   setAcctSelected(s => Math.max(0, s - 1));
      if (key.downArrow) setAcctSelected(s => Math.min(profiles.length - 1, s + 1));
      if (key.return)    doSwitchAccount(acctSelected);
      
      // Hotkey: Delete to instantly delete profile
      if (key.delete) {
        if (browserStatusRef.current === 'online') {
          setStatusBar('ERROR: Close the browser before deleting profiles.');
          return;
        }
        const p = profilesRef.current[acctSelected];
        if (p) {
          const nm = p.name || p.email || p.dir;
          try {
            setStatusBar(`Deleting profile ${nm}...`);
            tuiDeleteProfile(p.dir);
            refreshProfiles();
            setStatusBar(`Deleted ${nm}`);
          } catch (e) {
            setStatusBar(`ERROR: ${e.message}`);
          }
        }
      }
      return;
    }

  }, { isActive: isRawModeSupported });

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" height={termRows}>
      <Header engineStatus={engineStatus} browserStatus={browserStatus} activeAccount={activeAccount} busy={busy} queueDepth={queueDepth} />
      <MenuBar activeTab={activeTab} mode={mode} />
      
      <Box flexGrow={1} height={mainHeight} flexDirection="row">
        {activeTab === 'dashboard' ? (
          <>
            <Controls
              selected={selected}
              mode={mode}
              height={mainHeight}
              engineStatus={engineStatus}
              browserOn={browserStatus === 'online'}
              headlessOn={headlessMode}
              autoLaunchOn={autoLaunch}
              width={leftPanelWidth}
              visibleList={buildVisibleList(expandedGroups)}
            />
            <LogPanel
              logs={logs}
              scrollOffset={logScroll}
              mode={mode}
              height={mainHeight}
              width={rightPanelWidth}
            />
          </>
        ) : (
          <>
            <AccountActions
              selectedAction={acctActionSelected}
              mode={mode}
              height={mainHeight}
              confirmMsg={acctConfirmMsg}
              inputMsg={acctInputMsg}
              inputValue={acctInputValue}
              onInputChange={setAcctInputValue}
              onInputSubmit={handleAcctInputSubmit}
              width={leftPanelWidth}
            />
            <AccountsPane
              profiles={profiles}
              selected={acctSelected}
              mode={mode}
              height={mainHeight}
              width={rightPanelWidth}
            />
          </>
        )}
      </Box>
      <StatusBar message={statusBar} />
    </Box>
  );
}

render(<App />);
