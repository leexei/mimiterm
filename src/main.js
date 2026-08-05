const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

const STATE_DIR = path.join(os.homedir(), '.mimiterm');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

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

app.setName('MimiTerm');

function buildMenu() {
  const template = [
    {
      label: 'MimiTerm',
      submenu: [
        { label: 'MimiTerm について', role: 'about' },
        { type: 'separator' },
        { label: 'MimiTerm を隠す', role: 'hide' },
        { label: 'ほかを隠す', role: 'hideOthers' },
        { label: 'すべてを表示', role: 'unhide' },
        { type: 'separator' },
        { label: 'MimiTerm を終了', role: 'quit' },
      ],
    },
    {
      label: 'ファイル',
      submenu: [{ label: 'ウィンドウを閉じる', role: 'close' }],
    },
    {
      label: '編集',
      submenu: [
        { label: '取り消す', role: 'undo' },
        { label: 'やり直す', role: 'redo' },
        { type: 'separator' },
        { label: 'カット', role: 'cut' },
        { label: 'コピー', role: 'copy' },
        { label: 'ペースト', role: 'paste' },
        { label: 'すべてを選択', role: 'selectAll' },
      ],
    },
    {
      label: '表示',
      submenu: [
        { label: '再読み込み', role: 'reload' },
        { label: '開発者ツール', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '実際のサイズ', role: 'resetZoom' },
        { label: '拡大', role: 'zoomIn' },
        { label: '縮小', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'フルスクリーンにする', role: 'togglefullscreen' },
      ],
    },
    {
      label: 'ウィンドウ',
      submenu: [
        { label: 'しまう', role: 'minimize' },
        { label: '拡大/縮小', role: 'zoom' },
        { type: 'separator' },
        { label: 'すべてを手前に移動', role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

ipcMain.handle('pty:create', (_e, { tabId, tmuxSession, cols, rows, initialCommand }) => {
  if (ptys.has(tabId)) return 'exists';
  const p = pty.spawn(TMUX, ['new-session', '-A', '-s', tmuxSession], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: { ...process.env, LANG: process.env.LANG || 'ja_JP.UTF-8' },
  });
  ptys.set(tabId, p);
  if (initialCommand) {
    // セッション生成直後はシェル起動前なので、少し待ってから send-keys で流し込む
    setTimeout(() => {
      execFile(TMUX, ['send-keys', '-t', tmuxSession, initialCommand, 'Enter'], () => {});
    }, 700);
  }
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
  fs.rm(path.join(SESSIONS_DIR, `${name}.json`), { force: true }, () => {});
});

// ~/.claude/projects/ を走査して直近の Claude Code セッション一覧を返す（インポート用）
ipcMain.handle('claude:list-sessions', () => {
  const found = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  } catch {
    return found;
  }
  for (const d of dirs) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, d);
    let files = [];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dirPath, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size < 2000) continue; // ほぼ空のセッションは除外
        found.push({ file: full, sessionId: f.replace(/\.jsonl$/, ''), mtime: st.mtimeMs });
      } catch {
        // skip
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const top = found.slice(0, 30);
  for (const s of top) {
    try {
      const fd = fs.openSync(s.file, 'r');
      const buf = Buffer.alloc(131072);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      let firstUser = null;
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!s.cwd) {
          const m = line.match(/"cwd":"([^"]+)"/);
          if (m) s.cwd = m[1];
        }
        if (!s.title || !firstUser) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'summary' && obj.summary) s.title = obj.summary;
            if (!firstUser && obj.type === 'user' && typeof obj.message?.content === 'string') {
              const text = obj.message.content.replace(/\s+/g, ' ').trim();
              if (text && !text.startsWith('<')) firstUser = text;
            }
          } catch {
            // 途中で切れた行などは無視
          }
        }
        if (s.cwd && s.title) break;
      }
      s.title = (s.title || firstUser || s.sessionId).slice(0, 60);
    } catch {
      s.title = s.sessionId;
    }
    delete s.file;
  }
  return top.filter((s) => s.cwd);
});

// statusline-tap.sh が書く Claude セッション情報を集約してレンダラーへ push する
function collectClaudeSessions() {
  const result = {};
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return result;
  }
  for (const file of files) {
    try {
      const full = path.join(SESSIONS_DIR, file);
      const info = JSON.parse(fs.readFileSync(full, 'utf8'));
      const tmuxSession = file.replace(/\.json$/, '');
      result[tmuxSession] = {
        pct: info.context_window?.used_percentage ?? null,
        model: info.model?.display_name ?? null,
        sessionId: info.session_id ?? null,
        updatedAt: fs.statSync(full).mtimeMs,
      };
    } catch {
      // 書き込み途中・壊れたファイルはスキップ
    }
  }
  return result;
}

setInterval(() => {
  if (win && !win.isDestroyed()) {
    win.webContents.send('claude:sessions', collectClaudeSessions());
  }
}, 2000);

app.whenReady().then(() => {
  buildMenu();
  // 開発起動（npm start）でもDockに猫アイコンを出す
  const devIcon = path.join(__dirname, '..', 'assets', 'icon-1024.png');
  if (app.dock && fs.existsSync(devIcon)) {
    app.dock.setIcon(devIcon);
  }
  createWindow();
});

app.on('window-all-closed', () => {
  // ptyをkillしてもtmuxセッション自体は生き残る（detach相当）
  for (const p of ptys.values()) p.kill();
  ptys.clear();
  app.quit();
});
