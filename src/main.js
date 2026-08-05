const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

const STATE_DIR = path.join(os.homedir(), '.mimiterm');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// GUI起動時はbrewのPATHを継承しないため、tmuxは既知パスから解決する
const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
const TMUX = TMUX_CANDIDATES.find((p) => fs.existsSync(p)) || 'tmux';

const ptys = new Map(); // tabId -> IPty

function defaultState() {
  const today = new Date().toISOString().slice(0, 10);
  const groupId = 'g-' + Date.now().toString(36);
  return {
    groups: [{ id: groupId, name: `📅 ${today}`, collapsed: false }],
    tabs: [],
    activeTabId: null,
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return defaultState();
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'MimiTerm',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('state:load', () => loadState());
ipcMain.on('state:save', (_e, state) => saveState(state));

ipcMain.handle('pty:create', (_e, { tabId, tmuxSession, cols, rows }) => {
  if (ptys.has(tabId)) return 'exists';
  const p = pty.spawn(TMUX, ['new-session', '-A', '-s', tmuxSession], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: { ...process.env, LANG: process.env.LANG || 'ja_JP.UTF-8' },
  });
  ptys.set(tabId, p);
  p.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', tabId, data);
  });
  p.onExit(() => {
    ptys.delete(tabId);
    if (win && !win.isDestroyed()) win.webContents.send('pty:exit', tabId);
  });
  return 'created';
});

ipcMain.on('pty:input', (_e, { tabId, data }) => {
  const p = ptys.get(tabId);
  if (p) p.write(data);
});

ipcMain.on('pty:resize', (_e, { tabId, cols, rows }) => {
  const p = ptys.get(tabId);
  if (p && cols > 0 && rows > 0) p.resize(cols, rows);
});

ipcMain.on('pty:kill', (_e, { tabId }) => {
  const p = ptys.get(tabId);
  if (p) p.kill();
  ptys.delete(tabId);
});

ipcMain.on('tmux:kill-session', (_e, name) => {
  execFile(TMUX, ['kill-session', '-t', name], () => {});
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // ptyをkillしてもtmuxセッション自体は生き残る（detach相当）
  for (const p of ptys.values()) p.kill();
  ptys.clear();
  app.quit();
});
