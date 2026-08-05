const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');
const { startMcpServer } = require('./mcp-server');

const STATE_DIR = path.join(os.homedir(), '.mimiterm');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SESSIONS_DIR = path.join(STATE_DIR, 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// GUI起動時はbrewのPATHを継承しないため、tmuxは既知パスから解決する
const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
const TMUX = TMUX_CANDIDATES.find((p) => fs.existsSync(p)) || 'tmux';

// 同期出力(DECSET 2026)を外側ターミナル(=MimiTerm)へ通すようtmuxへ宣言する。
// レンダラー側で2026をパースしてバッファ描画するため、Claude Code等の再描画がちらつかない
const TMUX_CONF = path.join(STATE_DIR, 'tmux.conf');
function ensureTmuxConf() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(TMUX_CONF, "set -s terminal-features 'xterm*:sync'\n");
}
function applyTmuxSyncFeature() {
  // 既に起動中のtmuxサーバーにも反映（サーバー未起動ならエラーになるだけなので無視）
  execFile(TMUX, ['set', '-s', 'terminal-features', 'xterm*:sync'], () => {});
}

const ptys = new Map(); // tabId -> IPty

function defaultState() {
  // toISOStringはUTCで、JSTの0時〜9時に日付がズレるためローカル日付を使う
  const today = new Date().toLocaleDateString('sv-SE');
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
      webviewTag: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('state:load', () => loadState());
ipcMain.on('state:save', (_e, state) => saveState(state));

ipcMain.handle('pty:create', (_e, { tabId, tmuxSession, cols, rows, initialCommand }) => {
  if (ptys.has(tabId)) return 'exists';
  // MimiTermのタブで起動するClaude Codeは既定でこのモデルを使う
  // （管理設定のmodelピンより ANTHROPIC_MODEL が優先されることを2026-08-05に実測確認済み。
  //   state.jsonのsettings.claudeModelで上書き可、空文字で注入無効化）
  const claudeModel = loadState().settings?.claudeModel ?? 'claude-fable-5';
  const modelArgs = claudeModel ? ['-e', `ANTHROPIC_MODEL=${claudeModel}`] : [];
  ensureTmuxConf();
  const p = pty.spawn(TMUX, ['-f', TMUX_CONF, 'new-session', '-A', ...modelArgs, '-s', tmuxSession], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: {
      ...process.env,
      LANG: process.env.LANG || 'ja_JP.UTF-8',
      ...(claudeModel ? { ANTHROPIC_MODEL: claudeModel } : {}),
    },
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

// ホバープレビュー用: セッションの現在画面をテキストで取得（LLM不要・低コスト）
ipcMain.handle('tmux:capture', (_e, sessionName) => {
  return new Promise((resolve) => {
    execFile(TMUX, ['capture-pane', '-p', '-t', sessionName, '-S', '-5'], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(String(stdout).replace(/\s+$/, ''));
    });
  });
});

ipcMain.on('tmux:kill-session', (_e, name) => {
  execFile(TMUX, ['kill-session', '-t', name], () => {});
  fs.rm(path.join(SESSIONS_DIR, `${name}.json`), { force: true }, () => {});
});

// ---------- 埋め込みブラウザ（webview）の guest webContents を掌握し、MCPから読めるようにする ----------
const { webContents: electronWebContents } = require('electron');
let browserWCId = null;

ipcMain.on('browser:attached', (_e, id) => {
  browserWCId = id;
  // target=_blank / window.open は別ウィンドウにせず埋め込みペイン内で開く
  // （外に出るとMCPから操作できなくなるため）
  const wc = electronWebContents.fromId(id);
  if (wc) {
    wc.setWindowOpenHandler(({ url }) => {
      if (win && !win.isDestroyed()) win.webContents.send('browser:open', url);
      return { action: 'deny' };
    });
  }
});

function getBrowserWC() {
  if (browserWCId == null) return null;
  const wc = electronWebContents.fromId(browserWCId);
  return wc && !wc.isDestroyed() ? wc : null;
}

function requireBrowserWC() {
  const wc = getBrowserWC();
  if (!wc) {
    throw new Error('ブラウザペインが開いていません。browser_navigate で開くか、ユーザーに🌐ボタンで開いてもらってください');
  }
  return wc;
}

const browserOps = {
  navigate: async (url) => {
    if (win && !win.isDestroyed()) win.webContents.send('browser:open', url);
    for (let i = 0; i < 20; i++) {
      if (getBrowserWC()) return { ok: true, url };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('ブラウザペインを初期化できませんでした');
  },
  getPage: async () => {
    const wc = requireBrowserWC();
    const text = await wc.executeJavaScript('document.body ? document.body.innerText : ""');
    const limit = 80000;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      text: text.length > limit ? `${text.slice(0, limit)}\n…（${text.length}文字中${limit}文字で切り詰め）` : text,
    };
  },
  getSelection: async () => {
    const wc = requireBrowserWC();
    const text = await wc.executeJavaScript('window.getSelection().toString()');
    return { url: wc.getURL(), title: wc.getTitle(), selection: text };
  },
  getStyles: async () => {
    const wc = requireBrowserWC();
    const result = await wc.executeJavaScript(`(() => {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return { error: 'ページ上で範囲選択されていません' };
      const range = sel.getRangeAt(0);
      let container = range.commonAncestorContainer;
      if (container.nodeType !== 1) container = container.parentElement;
      const cells = Array.from(container.querySelectorAll('td,th')).filter((c) => range.intersectsNode(c)).slice(0, 120);
      const targets = cells.length ? cells : [container];
      return {
        items: targets.map((el) => ({
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').trim().slice(0, 200),
          backgroundColor: getComputedStyle(el).backgroundColor,
          color: getComputedStyle(el).color,
        })),
      };
    })()`);
    return { url: wc.getURL(), ...result };
  },
  click: async ({ selector, text }) => {
    const wc = requireBrowserWC();
    const result = await wc.executeJavaScript(`(() => {
      const sel = ${JSON.stringify(selector || '')};
      const text = ${JSON.stringify(text || '')};
      let el = null;
      if (sel) {
        el = document.querySelector(sel);
      } else if (text) {
        const clickable = Array.from(document.querySelectorAll(
          'a,button,[role="button"],[role="tab"],[role="menuitem"],[role="link"],input[type="submit"],[onclick],summary'
        ));
        el = clickable.find((n) => ((n.innerText || n.value || '').trim()).includes(text)) || null;
        if (!el) {
          const leaves = Array.from(document.querySelectorAll('div,span,td,th,li,p,h1,h2,h3'))
            .filter((n) => n.children.length === 0 && (n.innerText || '').trim().includes(text));
          el = leaves[0] || null;
        }
      }
      if (!el) return { error: 'クリック対象の要素が見つかりませんでした' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      };
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        const Ev = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(type, opts));
      }
      return { ok: true, clicked: ((el.innerText || el.value || el.tagName) + '').trim().slice(0, 80) };
    })()`);
    return { url: wc.getURL(), ...result };
  },
  type: async ({ text, selector, submit }) => {
    const wc = requireBrowserWC();
    if (selector) {
      const focused = await wc.executeJavaScript(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.focus();
        return true;
      })()`);
      if (!focused) throw new Error(`selector に一致する要素がありません: ${selector}`);
    }
    await wc.insertText(text);
    if (submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
    return { ok: true, typed: text.slice(0, 80), submitted: !!submit };
  },
  screenshot: async () => {
    const wc = requireBrowserWC();
    const image = await wc.capturePage();
    const dir = path.join(STATE_DIR, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `browser-${Date.now()}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { path: file, url: wc.getURL(), note: 'このPNGをReadツールで開くと見た目を確認できます' };
  },
};

// 指定ディレクトリの Claude trust ダイアログを事前承認する。
// インポート（過去セッションの resume）時のみ使用 — 過去に作業していたディレクトリに限る想定
ipcMain.handle('claude:trust-dir', (_e, dir) => {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  try {
    const config = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    config.projects = config.projects || {};
    config.projects[dir] = config.projects[dir] || {};
    if (config.projects[dir].hasTrustDialogAccepted === true) return 'already';
    config.projects[dir].hasTrustDialogAccepted = true;
    fs.writeFileSync(claudeJson, JSON.stringify(config, null, 2));
    return 'trusted';
  } catch (e) {
    return `error: ${e.message}`;
  }
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

// ---------- 今日パネル: calendar-helper.sh (icalBuddy) から今日の予定を取得 ----------
const CALENDAR_HELPER = path.join(os.homedir(), 'scripts', 'calendar-helper.sh');

function parseCalendarOutput(text) {
  const events = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const bullet = line.match(/^• (.*)$/);
    if (bullet) {
      if (current) events.push(current);
      const time = bullet[1].match(/^(\d{2}:\d{2}) - (\d{2}:\d{2})$/);
      current = time
        ? { start: time[1], end: time[2], title: null, allDay: false }
        : { start: null, end: null, title: bullet[1], allDay: true };
    } else if (current && /^\s+\S/.test(line)) {
      const body = line.trim();
      if (!current.title && !body.startsWith('location:')) current.title = body;
    }
  }
  if (current) events.push(current);
  return events.filter((e) => e.title);
}

let calendarCache = null;

function refreshCalendar() {
  if (!fs.existsSync(CALENDAR_HELPER)) return;
  // 直接execするとMimiTerm自身のTCC権限が必要になり、未署名アプリは再ビルドごとに権限が
  // リセットされて破綻する。既に権限を持つtmuxサーバーのコンテキストで実行して回避する
  execFile(
    TMUX,
    ['run-shell', `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH /bin/bash ${CALENDAR_HELPER} today`],
    { timeout: 30000 },
    (err, stdout, stderr) => {
      // 取得失敗の切り分け用ログ（TCC権限・PATH問題など）
      fs.writeFileSync(
        path.join(STATE_DIR, 'calendar-debug.log'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            err: err ? String(err) : null,
            stderr: String(stderr || '').slice(0, 2000),
            stdoutHead: String(stdout || '').slice(0, 500),
          },
          null,
          2
        )
      );
      if (err) return;
      calendarCache = { events: parseCalendarOutput(String(stdout)), fetchedAt: Date.now() };
      if (win && !win.isDestroyed()) win.webContents.send('calendar:update', calendarCache);
    }
  );
}

setInterval(refreshCalendar, 5 * 60 * 1000);

ipcMain.handle('calendar:get', () => calendarCache);

// statusline-tap.sh が書く Claude セッション情報を集約してレンダラーへ push する
// rate_limits はアカウント全体の値なので、最も新しいセッションの値を採用する
let latestRateLimits = null;

// transcript末尾から現在の権限モード（default/plan/acceptEdits等）を読む
function readPermissionMode(transcriptPath) {
  try {
    const st = fs.statSync(transcriptPath);
    const size = Math.min(st.size, 65536);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const matches = [...buf.toString('utf8').matchAll(/"permissionMode":"(\w+)"/g)];
    return matches.length ? matches[matches.length - 1][1] : null;
  } catch {
    return null;
  }
}

function collectClaudeSessions() {
  const result = {};
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return result;
  }
  let newestMtime = 0;
  for (const file of files) {
    try {
      const full = path.join(SESSIONS_DIR, file);
      const info = JSON.parse(fs.readFileSync(full, 'utf8'));
      const tmuxSession = file.replace(/\.json$/, '');
      const mtime = fs.statSync(full).mtimeMs;
      result[tmuxSession] = {
        pct: info.context_window?.used_percentage ?? null,
        model: info.model?.display_name ?? null,
        sessionId: info.session_id ?? null,
        permissionMode: info.transcript_path ? readPermissionMode(info.transcript_path) : null,
        transcriptPath: info.transcript_path ?? null,
        updatedAt: mtime,
      };
      if (info.rate_limits && mtime > newestMtime) {
        newestMtime = mtime;
        latestRateLimits = { ...info.rate_limits, updatedAt: mtime };
      }
    } catch {
      // 書き込み途中・壊れたファイルはスキップ
    }
  }
  return result;
}

const execFileP = (cmd, args, opts = {}) =>
  new Promise((resolve) => execFile(cmd, args, opts, (err, stdout) => resolve(err ? null : String(stdout))));

const SHELL_CMDS = ['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', '-zsh', '-bash'];
// Claude Codeがターンを実行中に画面へ出すマーカー（静かな長時間ツール・エージェント実行中も出続ける）
const WORKING_MARKERS = /esc to interrupt|ctrl\+b to run in background|Compacting|✳ /i;

setInterval(async () => {
  if (!win || win.isDestroyed()) return;
  const out = await execFileP(TMUX, [
    'list-panes',
    '-a',
    '-F',
    '#{session_name}\t#{window_activity}\t#{pane_current_command}',
  ]);
  const activity = {};
  const paneCommands = {};
  if (out) {
    for (const line of out.trim().split('\n')) {
      const [sess, at, cmd] = line.split('\t');
      if (sess && sess.startsWith('mimi-')) {
        activity[sess] = Number(at) * 1000;
        paneCommands[sess] = cmd || null;
      }
    }
  }
  const sessions = collectClaudeSessions();
  const now = Date.now();
  const working = {};
  await Promise.all(
    Object.keys(activity).map(async (sess) => {
      // 1) 出力が直近流れている
      if (now - activity[sess] < 4000) {
        working[sess] = true;
        return;
      }
      // 2) transcriptが直近書かれている（画面が静かでもツール実行等で進んでいる）
      const tp = sessions[sess]?.transcriptPath;
      if (tp) {
        try {
          if (now - fs.statSync(tp).mtimeMs < 15000) {
            working[sess] = true;
            return;
          }
        } catch {
          // transcript未作成などは無視
        }
      }
      // 3) 画面末尾に実行中マーカーが出ている（バックグラウンドエージェント待ち等）
      if (paneCommands[sess] && !SHELL_CMDS.includes(paneCommands[sess])) {
        const tail = await execFileP(TMUX, ['capture-pane', '-p', '-t', sess, '-S', '-8']);
        if (tail && WORKING_MARKERS.test(tail)) working[sess] = true;
      }
    })
  );
  if (win && !win.isDestroyed()) {
    win.webContents.send('claude:sessions', {
      sessions,
      activity,
      paneCommands,
      working,
      rateLimits: latestRateLimits,
    });
  }
}, 1500);

// 二重起動防止（開発版とパッケージ版の同時起動によるMCPポート競合も防ぐ）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    // 開発起動（npm start）でもDockに猫アイコンを出す
    const devIcon = path.join(__dirname, '..', 'assets', 'icon-1024.png');
    if (app.dock && fs.existsSync(devIcon)) {
      app.dock.setIcon(devIcon);
    }
    createWindow();
    applyTmuxSyncFeature();
    refreshCalendar();
    startMcpServer({
      getState: loadState,
      getClaudeSessions: collectClaudeSessions,
      browser: browserOps,
      // MCP経由の変更はディスクのstateを直接更新し、レンダラーへpushして即時反映する
      mutateState: (fn) => {
        const state = loadState();
        const result = fn(state);
        saveState(state);
        if (win && !win.isDestroyed()) win.webContents.send('state:reload', state);
        return result;
      },
    });
  });
}

app.on('window-all-closed', () => {
  // ptyをkillしてもtmuxセッション自体は生き残る（detach相当）
  for (const p of ptys.values()) p.kill();
  ptys.clear();
  app.quit();
});
