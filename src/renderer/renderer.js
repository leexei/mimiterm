/* global Terminal, FitAddon */

let state = { groups: [], tabs: [], activeTabId: null };
const terms = new Map(); // tabId -> { term, fit, container, attached }
let claudeSessions = {}; // tmuxSession -> { pct, model, sessionId, updatedAt }
let activityMap = {}; // tmuxSession -> 最終出力アクティビティ(ms epoch)
let workingMap = {}; // tmuxSession -> 作業中判定（main側で複数信号から算出）
let shellProcsMap = {}; // tmuxSession -> シェル配下でバックグラウンドジョブ実行中
const seenWaitingTabs = new Set(); // 応答待ちになってから一度開いた（既読の）タブID
let paneCommands = {}; // tmuxSession -> 前面プロセス名（zsh / claude / node 等）
const SPIN_FRAMES = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳'];
let spinFrame = 0;

const groupsEl = document.getElementById('groups');
const terminalsEl = document.getElementById('terminals');

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ローカル(JST)のYYYY-MM-DD。toISOStringはUTCで0〜9時にズレるので使わない
const localToday = () => new Date().toLocaleDateString('sv-SE');

function save() {
  window.mimi.saveState(state);
}

function updateWindowTitle() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  document.title = tab ? `${tab.name} — MimiTerm` : 'MimiTerm';
}

// ---------- sidebar rendering ----------

function render() {
  groupsEl.innerHTML = '';
  for (const group of state.groups) {
    groupsEl.appendChild(renderGroup(group));
  }
  renderEmptyHint();
  updateWindowTitle();
  renderTodayPanel();
}

function renderGroup(group) {
  const groupEl = document.createElement('div');
  groupEl.className = 'group' + (group.collapsed ? ' collapsed' : '');

  const header = document.createElement('div');
  header.className = 'group-header';
  header.draggable = true;
  header.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/group-id', group.id);
  });
  header.innerHTML = `<svg class="chevron" viewBox="0 0 16 16" width="12" height="12"><path fill="currentColor" d="M4 6l4 4 4-4z"/></svg>`;

  const name = document.createElement('span');
  name.className = 'group-name';
  name.textContent = group.name;
  header.appendChild(name);

  const addTabBtn = iconButton('＋', 'タブを追加', (e) => {
    e.stopPropagation();
    createTab(group.id);
  });
  const delBtn = iconButton('🗑', 'グループを削除', (e) => {
    e.stopPropagation();
    deleteGroup(group);
  });
  header.appendChild(addTabBtn);
  header.appendChild(delBtn);

  header.addEventListener('click', () => {
    group.collapsed = !group.collapsed;
    save();
    render();
  });
  // クリックが折りたたみ→再renderに化けるとdblclickが成立しないため、名前上のclickは止める
  name.addEventListener('click', (e) => e.stopPropagation());
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(name, group.name, (v) => {
      group.name = v;
      save();
      render();
    });
  });

  groupEl.appendChild(header);

  const tabsEl = document.createElement('div');
  tabsEl.className = 'tabs';
  for (const tab of state.tabs.filter((t) => t.groupId === group.id)) {
    tabsEl.appendChild(renderTab(tab, group));
  }
  groupEl.appendChild(tabsEl);

  // drop target: タブ移動（グループへ）/ グループ並び替え の両対応
  groupEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('text/group-id')) {
      const rect = groupEl.getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      groupEl.classList.toggle('drop-before', before);
      groupEl.classList.toggle('drop-after', !before);
      groupEl.classList.remove('drag-over');
    } else {
      groupEl.classList.add('drag-over');
    }
  });
  groupEl.addEventListener('dragleave', () =>
    groupEl.classList.remove('drag-over', 'drop-before', 'drop-after')
  );
  groupEl.addEventListener('drop', (e) => {
    e.preventDefault();
    const before = groupEl.classList.contains('drop-before');
    groupEl.classList.remove('drag-over', 'drop-before', 'drop-after');
    const draggedGroupId = e.dataTransfer.getData('text/group-id');
    if (draggedGroupId) {
      moveGroupRelative(draggedGroupId, group, before);
      return;
    }
    const tabId = e.dataTransfer.getData('text/tab-id');
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab && tab.groupId !== group.id) {
      tab.groupId = group.id;
      save();
      render();
    }
  });

  return groupEl;
}

function moveGroupRelative(draggedId, targetGroup, before) {
  const dragged = state.groups.find((g) => g.id === draggedId);
  if (!dragged || dragged.id === targetGroup.id) return;
  state.groups = state.groups.filter((g) => g.id !== draggedId);
  const idx = state.groups.findIndex((g) => g.id === targetGroup.id) + (before ? 0 : 1);
  state.groups.splice(idx, 0, dragged);
  save();
  render();
}

function renderTab(tab, group) {
  const entry = terms.get(tab.id);
  const tabEl = document.createElement('div');
  tabEl.className =
    'tab' +
    (tab.id === state.activeTabId ? ' active' : '') +
    (entry && !entry.attached ? ' detached' : '');
  tabEl.dataset.tabId = tab.id;
  tabEl.draggable = true;

  const status = document.createElement('span');
  status.className = 'tab-status';
  tabEl.appendChild(status);
  applyStatus(status, tab);

  if (tab.badgeEmoji) {
    const emoji = document.createElement('span');
    emoji.className = 'emoji-badge';
    emoji.textContent = tab.badgeEmoji;
    tabEl.appendChild(emoji);
  }

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = tab.name;
  tabEl.appendChild(name);

  if (tab.scheduledFor) {
    const due = tab.scheduledFor <= localToday();
    // 日付グループに入っているタブは、グループ名が同じ日付を示すのでチップは重複。
    // 当日を迎えたものだけ ⏰ を残して気づけるようにする
    const shownByGroup = group?.name === `📅 ${tab.scheduledFor}`;
    if (!shownByGroup || due) {
      // 年内は月日だけ。年をまたぐ予定は年も出す（08/06 が実は来年、を防ぐ）
      const sameYear = tab.scheduledFor.slice(0, 4) === localToday().slice(0, 4);
      const label = sameYear
        ? tab.scheduledFor.slice(5).replace('-', '/')
        : tab.scheduledFor.replace(/-/g, '/');
      const chip = document.createElement('span');
      chip.className = 'schedule-chip' + (due ? ' due' : '');
      chip.textContent = shownByGroup ? '⏰' : `${due ? '⏰' : '⏳'}${label}`;
      chip.title = due ? `再開予定日が来ています: ${tab.scheduledFor}` : `再開予定: ${tab.scheduledFor}`;
      tabEl.appendChild(chip);
    }
  }

  const badge = document.createElement('span');
  badge.className = 'tab-badge';
  tabEl.appendChild(badge);
  applyBadge(badge, tab);

  const closeBtn = iconButton('✕', 'タブを閉じる', (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  tabEl.appendChild(closeBtn);

  tabEl.addEventListener('click', () => activateTab(tab.id));
  attachHoverPreview(tabEl, tab);
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(name, tab.name, (v) => {
      tab.name = v;
      save();
      render();
    });
  });
  tabEl.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/tab-id', tab.id);
  });

  // タブ上へのドロップ = 並び替え（マウス位置で前後どちらに挿すか決める）
  // グループのドラッグ中はここでは扱わず、親グループのハンドラに任せる
  tabEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/group-id')) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = tabEl.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    tabEl.classList.toggle('drop-before', before);
    tabEl.classList.toggle('drop-after', !before);
  });
  tabEl.addEventListener('dragleave', () => {
    tabEl.classList.remove('drop-before', 'drop-after');
  });
  tabEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const before = tabEl.classList.contains('drop-before');
    tabEl.classList.remove('drop-before', 'drop-after');
    const draggedId = e.dataTransfer.getData('text/tab-id');
    moveTabRelative(draggedId, tab, before);
  });

  return tabEl;
}

function moveTabRelative(draggedId, targetTab, before) {
  const dragged = state.tabs.find((t) => t.id === draggedId);
  if (!dragged || dragged.id === targetTab.id) return;
  state.tabs = state.tabs.filter((t) => t.id !== draggedId);
  dragged.groupId = targetTab.groupId;
  const idx = state.tabs.findIndex((t) => t.id === targetTab.id) + (before ? 0 : 1);
  state.tabs.splice(idx, 0, dragged);
  save();
  render();
}

function iconButton(label, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function startRename(spanEl, current, commit) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = current;
  spanEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (apply && v) commit(v);
    else render();
  };
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは決定しない
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- ホバープレビュー ----------
// タブに乗せると、そのtmuxセッションの現在画面をポップオーバー表示する（tmux capture-pane、LLM不要）

let previewEl = null;
let previewToken = 0;

function hidePreview() {
  previewToken++;
  if (previewEl) {
    previewEl.remove();
    previewEl = null;
  }
}

function attachHoverPreview(tabEl, tab) {
  let timer = null;
  tabEl.addEventListener('mouseenter', () => {
    timer = setTimeout(async () => {
      // アクティブタブは本物が見えているのでプレビュー不要
      if (tab.id === state.activeTabId) return;
      const token = ++previewToken;
      const text = await window.mimi.capturePane(tab.tmuxSession);
      if (token !== previewToken) return; // すでにマウスが離れた
      showPreview(tabEl, tab, text);
    }, 350);
  });
  tabEl.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    hidePreview();
  });
  tabEl.addEventListener('click', () => {
    clearTimeout(timer);
    hidePreview();
  });
}

function showPreview(tabEl, tab, text) {
  hidePreview();
  previewToken++; // hidePreviewのincrementと合わせトークンを進めておく
  const info = claudeSessions[tab.tmuxSession];
  const lines = (text ?? '').split('\n').filter((l, i, arr) => !(l === '' && arr[i + 1] === ''));
  const tail = lines.slice(-24).join('\n');

  previewEl = document.createElement('div');
  previewEl.id = 'tab-preview';
  const meta = [info?.model, info?.pct != null ? `ctx ${Math.round(info.pct)}%` : null]
    .filter(Boolean)
    .join(' ・ ');
  const header = document.createElement('div');
  header.className = 'preview-header';
  header.textContent = meta ? `${tab.name} — ${meta}` : tab.name;
  const body = document.createElement('pre');
  body.className = 'preview-body';
  body.textContent = text == null ? '（セッションが起動していないよ）' : tail || '（画面は空だよ）';
  previewEl.appendChild(header);
  previewEl.appendChild(body);
  document.body.appendChild(previewEl);

  const rect = tabEl.getBoundingClientRect();
  const top = Math.min(rect.top, window.innerHeight - previewEl.offsetHeight - 12);
  previewEl.style.left = `${rect.right + 8}px`;
  previewEl.style.top = `${Math.max(8, top)}px`;
}

// タブの稼働状態: 出力が流れている=考え中(スピナー) / Claudeセッションありで静止=応答待ち(●)
function applyStatus(statusEl, tab) {
  const info = claudeSessions[tab.tmuxSession];
  const cmd = paneCommands[tab.tmuxSession];
  const isShell = !cmd || SHELL_COMMANDS.includes(cmd);
  const isClaudeCmd = cmd === 'claude.exe' || cmd === 'claude' || cmd === 'node';
  if (!isShell && !isClaudeCmd) {
    // Claude以外のプロセスが前面で動いてる（モニター・tail・ビルド・エディタ等）
    statusEl.className = 'tab-status proc';
    statusEl.textContent = '⚙';
    statusEl.title = `実行中: ${cmd}`;
  } else if (isShell && shellProcsMap[tab.tmuxSession]) {
    // シェルのままバックグラウンドジョブが動いてる
    statusEl.className = 'tab-status proc';
    statusEl.textContent = '⚙';
    statusEl.title = 'バックグラウンドジョブ実行中';
  } else if (isClaudeCmd && workingMap[tab.tmuxSession]) {
    statusEl.className = 'tab-status busy';
    statusEl.textContent = SPIN_FRAMES[spinFrame % SPIN_FRAMES.length];
    statusEl.title = '考え中…';
  } else if (isClaudeCmd && info) {
    const stale = Date.now() - info.updatedAt > 10 * 60 * 1000;
    if (info.permissionMode === 'plan') {
      // planモードのまま止まっている = 計画の承認待ちの可能性が高い
      statusEl.className = 'tab-status plan' + (stale ? ' stale' : '');
      statusEl.textContent = '📋';
      statusEl.title = 'planモードで停止中（計画の承認待ちかも）';
    } else {
      statusEl.className = 'tab-status waiting' + (stale ? ' stale' : '');
      statusEl.textContent = '●';
      statusEl.title = stale ? '待機中（10分以上更新なし）' : '応答待ち';
    }
  } else {
    statusEl.className = 'tab-status';
    statusEl.textContent = '';
    statusEl.title = '';
  }
}

setInterval(() => {
  spinFrame++;
  document.querySelectorAll('.tab-status.busy').forEach((el) => {
    el.textContent = SPIN_FRAMES[spinFrame % SPIN_FRAMES.length];
  });
}, 280);

// Claude Code コンテキスト使用率バッジ（statusline-tap.sh 経由の情報）
function applyBadge(badgeEl, tab) {
  const info = claudeSessions[tab.tmuxSession];
  if (!info || info.pct == null) {
    badgeEl.textContent = '';
    badgeEl.className = 'tab-badge';
    return;
  }
  const pct = Math.round(info.pct);
  const level = pct >= 70 ? 'high' : pct >= 50 ? 'mid' : 'low';
  const stale = Date.now() - info.updatedAt > 10 * 60 * 1000;
  badgeEl.textContent = `${pct}%`;
  badgeEl.className = `tab-badge ${level}${stale ? ' stale' : ''}`;
  badgeEl.title = `${info.model ?? ''}\nsession: ${info.sessionId ?? '?'}${stale ? '\n(10分以上更新なし)' : ''}`;
}

function updateBadges() {
  document.querySelectorAll('.tab').forEach((el) => {
    const tab = state.tabs.find((t) => t.id === el.dataset.tabId);
    if (!tab) return;
    const badgeEl = el.querySelector('.tab-badge');
    if (badgeEl) applyBadge(badgeEl, tab);
    const statusEl = el.querySelector('.tab-status');
    if (statusEl) applyStatus(statusEl, tab);
    // 応答待ちを一度見たタブは薄く（既読）。再び作業が始まると未読に戻る
    if (workingMap[tab.tmuxSession]) seenWaitingTabs.delete(tab.id);
    const waiting = !!claudeSessions[tab.tmuxSession] && !workingMap[tab.tmuxSession];
    el.classList.toggle(
      'seen',
      waiting && seenWaitingTabs.has(tab.id) && tab.id !== state.activeTabId
    );
  });
}

// active/detached の見た目更新。DOMを作り直すとdblclick等が途切れるため、クラス切替のみ行う
function updateSidebarActive() {
  document.querySelectorAll('.tab').forEach((el) => {
    const id = el.dataset.tabId;
    const entry = terms.get(id);
    el.classList.toggle('active', id === state.activeTabId);
    el.classList.toggle('detached', !!entry && !entry.attached);
  });
}

function renderEmptyHint() {
  const existing = document.getElementById('empty-hint');
  if (existing) existing.remove();
  if (state.tabs.length > 0) return;
  const hint = document.createElement('div');
  hint.id = 'empty-hint';
  hint.innerHTML = `
    <svg viewBox="0 0 100 100" width="80" height="80">
      <path fill="currentColor" d="M20 40 L14 14 L34 26 Q50 20 66 26 L86 14 L80 40 Q90 55 88 72 Q86 92 50 94 Q14 92 12 72 Q10 55 20 40 Z" />
    </svg>
    <div>グループの「＋」からタブを作ってね 🐾</div>`;
  terminalsEl.appendChild(hint);
}

// ---------- groups / tabs ----------

function createGroup() {
  state.groups.push({ id: uid('g'), name: `📅 ${localToday()}`, collapsed: false });
  save();
  render();
}

function deleteGroup(group) {
  const tabsInGroup = state.tabs.filter((t) => t.groupId === group.id);
  if (tabsInGroup.length > 0) {
    if (!confirm(`グループ「${group.name}」の ${tabsInGroup.length} 個のタブと tmux セッションをすべて終了します。よろしいですか？`)) return;
    for (const tab of tabsInGroup) removeTab(tab, true);
  }
  state.groups = state.groups.filter((g) => g.id !== group.id);
  save();
  render();
}

function createTab(groupId) {
  const tab = {
    id: uid('t'),
    name: '新しいタブ',
    groupId,
    tmuxSession: uid('mimi'),
  };
  state.tabs.push(tab);
  const group = state.groups.find((g) => g.id === groupId);
  if (group) group.collapsed = false;
  save();
  render();
  activateTab(tab.id);
}

function closeTab(tab) {
  if (!confirm(`タブ「${tab.name}」を閉じて tmux セッションも終了します。よろしいですか？`)) return;
  removeTab(tab, true);
  save();
  render();
}

function removeTab(tab, killSession) {
  // 先に状態から消す（ターミナル破棄が例外を投げてもタブがサイドバーに残らないように）
  state.tabs = state.tabs.filter((t) => t.id !== tab.id);
  if (state.activeTabId === tab.id) state.activeTabId = null;
  const entry = terms.get(tab.id);
  terms.delete(tab.id);
  if (killSession) window.mimi.killTmuxSession(tab.tmuxSession);
  if (entry) {
    window.mimi.ptyKill(tab.id);
    clearTimeout(entry.syncTimer);
    try {
      entry.webgl?.dispose();
      entry.webgl = null;
    } catch {
      // WebGLコンテキスト破棄失敗は無視してよい
    }
    try {
      entry.term.dispose();
    } catch {
      // dispose中の例外でクローズ処理を止めない
    }
    entry.container.remove();
  }
}

// ---------- terminals ----------

// 背景画像設定（MCPのset_backgroundから変更される）
function currentTheme() {
  const bg = state.settings?.background;
  const opacity = state.settings?.backgroundOpacity ?? 0.25;
  return {
    background: bg ? `rgba(30, 30, 46, ${Math.max(0.4, 1 - opacity)})` : '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5c2e7',
  };
}

// WebGLレンダラー: セル幅の丸め誤差蓄積による右端欠けを防ぐ。
// 背景画像使用時は透過描画のためDOMレンダラーに切り替える
function syncRenderer(entry) {
  const wantWebgl = !state.settings?.background;
  if (wantWebgl && !entry.webgl) {
    try {
      const addon = new WebglAddon.WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        entry.webgl = null;
      });
      entry.term.loadAddon(addon);
      entry.webgl = addon;
    } catch {
      entry.webgl = null; // WebGL不可の環境ではDOMレンダラーのまま
    }
  } else if (!wantWebgl && entry.webgl) {
    entry.webgl.dispose();
    entry.webgl = null;
  }
}

function applySettings() {
  const bg = state.settings?.background;
  if (bg) {
    terminalsEl.style.backgroundImage = `url('file://${bg}')`;
    terminalsEl.style.backgroundSize = 'cover';
    terminalsEl.style.backgroundPosition = 'center';
  } else {
    terminalsEl.style.backgroundImage = '';
  }
  const theme = currentTheme();
  for (const entry of terms.values()) {
    entry.term.options.theme = theme;
    syncRenderer(entry);
  }
}

function ensureTerm(tab) {
  let entry = terms.get(tab.id);
  if (entry) return entry;

  const container = document.createElement('div');
  container.className = 'term-container';
  terminalsEl.appendChild(container);

  const term = new Terminal({
    fontFamily: 'Menlo, "Hiragino Sans", monospace',
    fontSize: 13,
    scrollback: 10000,
    allowTransparency: true,
    theme: currentTheme(),
  });
  // Shift+Enter / Option+Enter は ESC CR を送る（Claude Code が改行として解釈する。
  // iTerm2 の /terminal-setup 相当を組み込みで持つ）
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.key === 'Enter' && (ev.shiftKey || ev.altKey)) {
      // keydown で ESC CR を1回だけ送り、keypress/keyup も含めて既定処理を止める
      // （keypress を素通しすると裸の \r が続けて飛び、送信扱いになってしまう）
      if (ev.type === 'keydown') window.mimi.ptyInput(tab.id, '\x1b\r');
      return false;
    }
    return true;
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  term.onData((data) => window.mimi.ptyInput(tab.id, data));
  term.onResize(({ cols, rows }) => window.mimi.ptyResize(tab.id, cols, rows));

  entry = {
    term,
    fit,
    container,
    attached: false,
    webgl: null,
    syncing: false,
    syncBuf: [],
    syncCarry: '',
    syncTimer: null,
  };
  terms.set(tab.id, entry);
  syncRenderer(entry);
  return entry;
}

async function activateTab(tabId, initialCommand) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  state.activeTabId = tabId;
  seenWaitingTabs.add(tabId); // 開いた=既読
  save();

  const entry = ensureTerm(tab);
  for (const [id, e] of terms) {
    e.container.classList.toggle('visible', id === tabId);
  }
  entry.fit.fit();
  if (!entry.attached) {
    entry.attached = true;
    await window.mimi.ptyCreate({
      tabId: tab.id,
      tmuxSession: tab.tmuxSession,
      cols: entry.term.cols,
      rows: entry.term.rows,
      initialCommand,
    });
  }
  entry.term.focus();
  updateSidebarActive();
  updateWindowTitle();
  renderQuickbar();
  renderStatusBar();
}

// ---- 同期出力(DECSET 2026)の自前実装 ----
// xterm.js 5.5は2026未対応のため、BSU(ESC[?2026h)〜ESU(ESC[?2026l)間の出力をバッファし
// ESUで一括writeすることで、Claude Code等の画面再描画を原子的に反映する（ガタつき防止）
const SYNC_PREFIX = '\x1b[?2026';
const SYNC_MARKER_LEN = SYNC_PREFIX.length + 1;

function emitData(entry, text) {
  if (!text) return;
  if (entry.syncing) entry.syncBuf.push(text);
  else entry.term.write(text);
}

function endSync(entry) {
  if (!entry.syncing) return;
  clearTimeout(entry.syncTimer);
  entry.syncing = false;
  const text = entry.syncBuf.join('');
  entry.syncBuf = [];
  if (text) entry.term.write(text);
}

function startSync(entry) {
  if (entry.syncing) return;
  entry.syncing = true;
  entry.syncBuf = [];
  // ESUが届かない場合の安全弁（描画が止まりっぱなしにならないように）
  entry.syncTimer = setTimeout(() => endSync(entry), 100);
}

function feedData(entry, data) {
  let s = entry.syncCarry + data;
  entry.syncCarry = '';
  // 末尾がマーカーの途中で切れている可能性があれば持ち越す
  for (let len = SYNC_PREFIX.length; len >= 1; len--) {
    if (s.length >= len && s.endsWith(SYNC_PREFIX.slice(0, len))) {
      entry.syncCarry = s.slice(s.length - len);
      s = s.slice(0, s.length - len);
      break;
    }
  }
  let pos = 0;
  while (pos < s.length) {
    const idx = s.indexOf(SYNC_PREFIX, pos);
    if (idx === -1) {
      emitData(entry, s.slice(pos));
      break;
    }
    emitData(entry, s.slice(pos, idx));
    const mode = s[idx + SYNC_PREFIX.length];
    if (mode === 'h') startSync(entry);
    else if (mode === 'l') endSync(entry);
    else emitData(entry, s.slice(idx, idx + SYNC_MARKER_LEN)); // 2026以外(例:20261)はそのまま流す
    pos = idx + SYNC_MARKER_LEN;
  }
}

window.mimi.onPtyData((tabId, data) => {
  const entry = terms.get(tabId);
  if (entry) feedData(entry, data);
});

window.mimi.onPtyExit((tabId) => {
  const entry = terms.get(tabId);
  if (entry) {
    entry.attached = false;
    entry.term.write('\r\n\x1b[90m[MimiTerm] セッションが終了しました。タブをクリックすると再接続します 🐾\x1b[0m\r\n');
  }
  updateSidebarActive();
});

// MCP経由でstateが変更されたら即時反映（ターミナル実体はtabId紐付けなので影響なし）
window.mimi.onStateReload((newState) => {
  state = newState;
  applySettings();
  renderQuickbar();
  renderBookmarks();
  render();
  consumePendingTabs();
});

// MCPのcreate_tabで作られたタブは、レンダラー側でtmuxセッションを起動して初期コマンドを流す
async function consumePendingTabs() {
  for (const tab of state.tabs) {
    if (tab.pendingCommand === undefined || terms.has(tab.id)) continue;
    const cmd = tab.pendingCommand;
    const cwd = tab.pendingCwd;
    const focus = tab.pendingActivate !== false;
    delete tab.pendingCommand;
    delete tab.pendingCwd;
    delete tab.pendingActivate;
    save();
    const safeCwd = cwd ? cwd.replace(/'/g, `'\\''`) : '';
    const initial = cmd && safeCwd ? `cd '${safeCwd}' && ${cmd}` : cmd || (safeCwd ? `cd '${safeCwd}'` : '');
    if (focus) {
      await activateTab(tab.id, initial);
    } else {
      const entry = ensureTerm(tab);
      entry.attached = true;
      await window.mimi.ptyCreate({
        tabId: tab.id,
        tmuxSession: tab.tmuxSession,
        cols: entry.term.cols,
        rows: entry.term.rows,
        initialCommand: initial,
      });
    }
    render();
  }
}

// Claude 全体の利用制限（5時間 / 7日ウィンドウ）をサイドバー下部に表示
function renderRateLimits(rl) {
  const el = document.getElementById('rate-limits');
  if (!rl) {
    el.innerHTML = '';
    return;
  }
  const fmtRemain = (resetsAt) => {
    if (!resetsAt) return '';
    let s = Math.max(0, resetsAt * 1000 - Date.now()) / 1000;
    const d = Math.floor(s / 86400);
    s %= 86400;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `あと${d}d${h}h`;
    if (h > 0) return `あと${h}h${m}m`;
    return `あと${m}m`;
  };
  const row = (label, win) => {
    if (!win || win.used_percentage == null) return '';
    const pct = Math.round(win.used_percentage);
    const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
    const resets = win.resets_at
      ? new Date(win.resets_at * 1000).toLocaleString('ja-JP', {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';
    return `
      <div class="rl-row" title="リセット: ${resets}">
        <span class="rl-label">${label}</span>
        <span class="rl-bar">
          <span class="rl-fill ${level}" style="width:${Math.min(100, pct)}%"></span>
          <span class="rl-reset">${fmtRemain(win.resets_at)}</span>
        </span>
        <span class="rl-pct ${level}">${pct}%</span>
      </div>`;
  };
  el.innerHTML = row('5h', rl.five_hour) + row('週', rl.seven_day);
}

window.mimi.onClaudeSessions(({ sessions, activity, paneCommands: cmds, working, shellProcs, rateLimits }) => {
  claudeSessions = sessions;
  activityMap = activity;
  workingMap = working ?? {};
  shellProcsMap = shellProcs ?? {};
  paneCommands = cmds ?? {};
  renderRateLimits(rateLimits);
  renderQuickbar();
  // 将来の claude --resume 用にセッションIDをタブへ永続化する
  let changed = false;
  for (const tab of state.tabs) {
    const sid = sessions[tab.tmuxSession]?.sessionId;
    if (sid && tab.claudeSessionId !== sid) {
      tab.claudeSessionId = sid;
      changed = true;
    }
  }
  if (changed) save();
  updateBadges();
  renderStatusBar();
});

function fitActive() {
  const entry = terms.get(state.activeTabId);
  if (entry && entry.container.classList.contains('visible')) entry.fit.fit();
}

window.addEventListener('resize', fitActive);
// ウィンドウリサイズ以外の要因（スクロールバー出現等）でも追従させる
new ResizeObserver(fitActive).observe(terminalsEl);
// フォント読み込み完了前に文字幅を計測すると列数がズレて右端が欠けるため、読み込み後に再フィット
document.fonts.ready.then(fitActive);

document.getElementById('add-group').addEventListener('click', createGroup);

// ---------- Claude セッションインポート ----------

function relativeTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.floor(hour / 24)}日前`;
}

function currentGroupId() {
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  if (activeTab) return activeTab.groupId;
  if (state.groups.length === 0) createGroup();
  return state.groups[0].id;
}

async function openImportModal() {
  const sessions = await window.mimi.listClaudeSessions();
  const known = new Set(state.tabs.map((t) => t.claudeSessionId).filter(Boolean));
  const candidates = sessions.filter((s) => !known.has(s.sessionId));

  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'mimi-modal';
  modal.innerHTML = '<div class="modal-title">Claude セッションを取り込む 🐾</div>';

  const listEl = document.createElement('div');
  listEl.className = 'modal-list';
  if (candidates.length === 0) {
    listEl.innerHTML = '<div class="modal-empty">取り込めるセッションが見つからないよ</div>';
  }
  for (const s of candidates) {
    const item = document.createElement('div');
    item.className = 'modal-item';
    const cwdShort = s.cwd.replace(/^\/Users\/[^/]+/, '~');
    item.innerHTML = `
      <div class="modal-item-title"></div>
      <div class="modal-item-meta"></div>`;
    item.querySelector('.modal-item-title').textContent = s.title;
    item.querySelector('.modal-item-meta').textContent = `${cwdShort} ・ ${relativeTime(s.mtime)} ・ ${s.sessionId.slice(0, 8)}`;
    item.addEventListener('click', () => {
      overlay.remove();
      importSession(s);
    });
    listEl.appendChild(item);
  }
  modal.appendChild(listEl);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.appendChild(overlay);
}

async function importSession(s) {
  // settings.autoTrustImports が有効な場合のみ、trust ダイアログを事前承認する
  // （過去に自分が作業していたディレクトリに限られるため安全だが、明示opt-in制）
  if (state.settings?.autoTrustImports === true) {
    await window.mimi.trustDir(s.cwd);
  }
  const tab = {
    id: uid('t'),
    name: s.title.slice(0, 24),
    groupId: currentGroupId(),
    tmuxSession: uid('mimi'),
    claudeSessionId: s.sessionId,
  };
  state.tabs.push(tab);
  save();
  render();
  const safeCwd = s.cwd.replace(/'/g, `'\\''`); // シングルクォート入りパスでも壊れないように
  activateTab(tab.id, `cd '${safeCwd}' && claude --resume ${s.sessionId}`);
}

document.getElementById('import-session').addEventListener('click', openImportModal);

// ---------- クイックコマンドバー ----------
// ボタンひとつでアクティブタブのターミナルへコマンド+Enterを流し込む

// モード別ボタンセット: アクティブタブの前面プロセス（tmux pane_current_command）で自動切替
const DEFAULT_QUICK_COMMANDS_BY_MODE = {
  claude: [
    { label: '📉 compact', command: '/compact' },
    { label: '🧹 clear', command: '/clear' },
    { label: '🧠 context', command: '/context' },
    { label: '🔌 mcp', command: '/mcp' },
  ],
  shell: [
    { label: '🐱 claude', command: 'claude' },
    { label: '⏪ claude -c', command: 'claude -c' },
    { label: '🌿 git status', command: 'git status' },
  ],
};

const SHELL_COMMANDS = ['zsh', 'bash', 'fish', 'sh', 'dash', 'tcsh', '-zsh', '-bash'];

function currentMode() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return 'shell';
  const cmd = paneCommands[tab.tmuxSession];
  if (!cmd || SHELL_COMMANDS.includes(cmd)) return 'shell';
  return 'claude';
}

function quickCommandsByMode() {
  const s = (state.settings = state.settings || {});
  if (!s.quickCommandsByMode) {
    // 旧形式（フラット配列）からの移行: スラッシュコマンドはclaude用、それ以外はシェル用へ
    if (Array.isArray(s.quickCommands)) {
      const claude = s.quickCommands.filter((c) => c.command.startsWith('/'));
      const shell = s.quickCommands.filter((c) => !c.command.startsWith('/'));
      s.quickCommandsByMode = {
        claude: claude.length ? claude : [...DEFAULT_QUICK_COMMANDS_BY_MODE.claude],
        shell: shell.length ? shell : [...DEFAULT_QUICK_COMMANDS_BY_MODE.shell],
      };
      delete s.quickCommands;
      save();
    } else {
      return DEFAULT_QUICK_COMMANDS_BY_MODE;
    }
  }
  return s.quickCommandsByMode;
}

function quickCommands(mode = currentMode()) {
  return quickCommandsByMode()[mode] ?? DEFAULT_QUICK_COMMANDS_BY_MODE[mode];
}

function saveQuickCommands(list, mode = currentMode()) {
  const s = (state.settings = state.settings || {});
  const byMode = quickCommandsByMode();
  s.quickCommandsByMode = {
    claude: [...(byMode.claude ?? DEFAULT_QUICK_COMMANDS_BY_MODE.claude)],
    shell: [...(byMode.shell ?? DEFAULT_QUICK_COMMANDS_BY_MODE.shell)],
  };
  s.quickCommandsByMode[mode] = list;
  save();
  renderQuickbar(true);
}

function sendQuick(command) {
  const entry = terms.get(state.activeTabId);
  if (!entry || !entry.attached) return;
  window.mimi.ptyInput(state.activeTabId, command + '\r');
  entry.term.focus();
}

let lastQuickbarKey = null;

function renderQuickbar(force = false) {
  const mode = currentMode();
  const list = quickCommands(mode);
  // 1.5秒ポーリングごとのDOM再構築はドラッグ/ホバーを壊すため、変化があった時だけ描画する
  const key = mode + JSON.stringify(list);
  if (!force && key === lastQuickbarKey) return;
  lastQuickbarKey = key;

  const bar = document.getElementById('quickbar');
  bar.innerHTML = '';
  const modeChip = document.createElement('span');
  modeChip.className = 'qc-mode';
  modeChip.textContent = mode === 'claude' ? '🤖 claude' : '💻 shell';
  modeChip.title = 'アクティブタブの状態に応じてボタンセットが切り替わるよ';
  bar.appendChild(modeChip);
  list.forEach((qc, i) => {
    const btn = document.createElement('button');
    btn.className = 'qc-btn';
    btn.textContent = qc.label;
    btn.title = `「${qc.command}」を入力して実行（右クリックで削除）`;
    btn.addEventListener('click', () => sendQuick(qc.command));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!confirm(`ボタン「${qc.label}」を削除しますか？`)) return;
      const list = [...quickCommands()];
      list.splice(i, 1);
      saveQuickCommands(list);
    });
    // ドラッグで並び替え（左右どちらに挿すかはマウス位置で判定）
    btn.draggable = true;
    btn.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/qc-index', String(i));
    });
    btn.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/qc-index')) return;
      e.preventDefault();
      const rect = btn.getBoundingClientRect();
      const before = e.clientX - rect.left < rect.width / 2;
      btn.classList.toggle('drop-left', before);
      btn.classList.toggle('drop-right', !before);
    });
    btn.addEventListener('dragleave', () => btn.classList.remove('drop-left', 'drop-right'));
    btn.addEventListener('drop', (e) => {
      e.preventDefault();
      const before = btn.classList.contains('drop-left');
      btn.classList.remove('drop-left', 'drop-right');
      const from = Number(e.dataTransfer.getData('text/qc-index'));
      if (!Number.isInteger(from) || from === i) return;
      const list = [...quickCommands()];
      const [moved] = list.splice(from, 1);
      let to = i + (before ? 0 : 1);
      if (from < to) to--;
      list.splice(to, 0, moved);
      saveQuickCommands(list);
    });
    bar.appendChild(btn);
  });
  const add = document.createElement('button');
  add.className = 'qc-btn qc-add';
  add.textContent = '＋';
  add.title = 'クイックコマンドを追加';
  add.addEventListener('click', openQuickAddModal);
  bar.appendChild(add);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  bar.appendChild(spacer);
  const browserBtn = document.createElement('button');
  browserBtn.className = 'qc-btn';
  browserBtn.textContent = '🌐';
  browserBtn.title = 'ブラウザペインを開く/閉じる';
  browserBtn.addEventListener('click', toggleBrowserPane);
  bar.appendChild(browserBtn);
}

function openQuickAddModal() {
  const overlay = document.createElement('div');
  overlay.id = 'modal-overlay';
  const mode = currentMode();
  const modal = document.createElement('div');
  modal.className = 'mimi-modal';
  modal.innerHTML = `<div class="modal-title">クイックコマンドを追加 ⚡（${
    mode === 'claude' ? '🤖 Claude実行中' : '💻 シェル'
  }用セット）</div>`;

  const form = document.createElement('div');
  form.className = 'modal-form';
  const cmdInput = document.createElement('input');
  cmdInput.placeholder = '入力するコマンド（例: /compact、claude --resume）';
  const labelInput = document.createElement('input');
  labelInput.placeholder = 'ボタン名（省略時はコマンドがそのまま表示）';
  const okBtn = document.createElement('button');
  okBtn.textContent = '追加する';

  const submit = () => {
    const command = cmdInput.value.trim();
    if (!command) return;
    const label = labelInput.value.trim() || command;
    saveQuickCommands([...quickCommands(mode), { label, command }], mode);
    overlay.remove();
  };
  okBtn.addEventListener('click', submit);
  [cmdInput, labelInput].forEach((input) =>
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME変換確定のEnterでは送信しない
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') overlay.remove();
    })
  );

  form.appendChild(cmdInput);
  form.appendChild(labelInput);
  form.appendChild(okBtn);
  modal.appendChild(form);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  cmdInput.focus();
}

// ---------- ステータスバー（アクティブタブのコンテキスト量 + ハンドオフ） ----------

const HANDOFF_PROMPT =
  'コンテキストが逼迫してきたのでハンドオフしよう。' +
  'まず ~/Knowledge/sessions/ にスナップショット（今のタスク・進捗・残作業・合意事項・参照中のファイルやブランチ）を書き込んで、' +
  '書き込みが完了したら mimiterm の create_tab で新しいタブを作って、' +
  'そのスナップショットを読むところから再開できる状態にして。このタブは最後に閉じる案内だけしてね。';

function renderStatusBar() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  const info = tab ? claudeSessions[tab.tmuxSession] : null;
  const pct = info?.pct != null ? Math.round(info.pct) : null;
  document.getElementById('sb-tab').textContent = tab ? tab.name : '';
  const ctxEl = document.getElementById('sb-ctx');
  const btn = document.getElementById('sb-handoff');
  if (pct == null) {
    ctxEl.textContent = '';
    ctxEl.className = '';
    btn.classList.remove('urgent');
    return;
  }
  const level = pct >= 70 ? 'high' : pct >= 50 ? 'mid' : 'low';
  ctxEl.textContent = `ctx ${pct}%`;
  ctxEl.className = level;
  // 70%以上＝引き継ぎ推奨。ボタンを目立たせる
  btn.classList.toggle('urgent', pct >= 70);
}

document.getElementById('sb-handoff').addEventListener('click', () => {
  const entry = terms.get(state.activeTabId);
  if (!entry || !entry.attached) return;
  // 貼り付け扱いで入れてから改行を送る（プロンプト内の改行で誤送信しないように）
  window.mimi.ptyInput(state.activeTabId, `\x1b[200~${HANDOFF_PROMPT}\x1b[201~`);
  setTimeout(() => window.mimi.ptyInput(state.activeTabId, '\r'), 120);
  entry.term.focus();
});

// ---------- 今日パネル（カレンダー × 期日タブ） ----------

let calendar = null; // { events: [{start,end,title,allDay}], fetchedAt }

function nowHHMM() {
  return new Date().toTimeString().slice(0, 5);
}

// 09:00-18:00 の勤務窓から、時刻付き予定を除いた残り空き時間(h)を出す
function calcFreeHours(events) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const winStart = Math.max(toMin('09:00'), toMin(nowHHMM()));
  const winEnd = toMin('18:00');
  if (winStart >= winEnd) return 0;
  const busy = events
    .filter((e) => !e.allDay)
    .map((e) => [Math.max(toMin(e.start), winStart), Math.min(toMin(e.end), winEnd)])
    .filter(([s, e]) => s < e)
    .sort((a, b) => a[0] - b[0]);
  let free = 0;
  let cursor = winStart;
  for (const [s, e] of busy) {
    if (s > cursor) free += s - cursor;
    cursor = Math.max(cursor, e);
  }
  free += Math.max(0, winEnd - cursor);
  return Math.round((free / 60) * 10) / 10;
}

function renderTodayPanel() {
  const panel = document.getElementById('today-panel');
  const dueTabs = state.tabs.filter((t) => t.scheduledFor && t.scheduledFor <= localToday());
  if (!calendar && dueTabs.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const d = new Date();
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`;
  let html = '';
  if (calendar) {
    const events = calendar.events;
    const now = nowHHMM();
    const remaining = events.filter((e) => !e.allDay && e.end > now);
    const ongoing = remaining.find((e) => e.start <= now);
    const next = remaining.find((e) => e.start > now);
    html += `<div class="tp-head">📅 ${dateLabel} ・ MTG残り${remaining.length}件 ・ 空き${calcFreeHours(events)}h</div>`;
    if (ongoing) html += `<div class="tp-next ongoing">▶ ${ongoing.start}-${ongoing.end} ${escapeHtml(ongoing.title)}</div>`;
    if (next) html += `<div class="tp-next">🕐 ${next.start} ${escapeHtml(next.title)}</div>`;
    if (!ongoing && !next) html += `<div class="tp-next done">✨ 今日のMTGは終了</div>`;
  } else {
    html += `<div class="tp-head">📅 ${dateLabel}</div>`;
  }
  if (dueTabs.length > 0) {
    html += `<div class="tp-due">⏰ 今日が再開日のタブ ${dueTabs.length}件</div>`;
  }
  panel.innerHTML = html;
}

// 今日パネルのホバーで全予定リストをポップオーバー表示する
let calPreviewEl = null;

function hideCalendarPreview() {
  if (calPreviewEl) {
    calPreviewEl.remove();
    calPreviewEl = null;
  }
}

function showCalendarPreview() {
  hideCalendarPreview();
  if (!calendar || calendar.events.length === 0) return;
  const now = nowHHMM();
  calPreviewEl = document.createElement('div');
  calPreviewEl.id = 'calendar-preview';
  const header = document.createElement('div');
  header.className = 'preview-header';
  header.textContent = `📅 今日の予定 全${calendar.events.length}件`;
  const body = document.createElement('div');
  body.className = 'preview-body cal-list';
  for (const e of calendar.events) {
    const row = document.createElement('div');
    if (e.allDay) {
      row.className = 'cal-row allday';
      row.textContent = `◇ 終日 ${e.title}`;
    } else {
      const past = e.end <= now;
      const ongoing = !past && e.start <= now;
      row.className = 'cal-row' + (past ? ' past' : ongoing ? ' ongoing' : '');
      row.textContent = `${ongoing ? '▶ ' : ''}${e.start}-${e.end} ${e.title}`;
    }
    body.appendChild(row);
  }
  calPreviewEl.appendChild(header);
  calPreviewEl.appendChild(body);
  document.body.appendChild(calPreviewEl);
  const rect = document.getElementById('today-panel').getBoundingClientRect();
  const top = Math.min(rect.top, window.innerHeight - calPreviewEl.offsetHeight - 12);
  calPreviewEl.style.left = `${rect.right + 8}px`;
  calPreviewEl.style.top = `${Math.max(8, top)}px`;
}

{
  const panel = document.getElementById('today-panel');
  let timer = null;
  panel.addEventListener('mouseenter', () => {
    timer = setTimeout(showCalendarPreview, 350);
  });
  panel.addEventListener('mouseleave', () => {
    clearTimeout(timer);
    hideCalendarPreview();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.mimi.onCalendarUpdate((data) => {
  calendar = data;
  renderTodayPanel();
});

// 通知クリックからのタブジャンプ
window.mimi.onTabActivate((tabId) => activateTab(tabId));

setInterval(renderTodayPanel, 60 * 1000);

// ---------- 埋め込みブラウザペイン ----------

const browserPane = document.getElementById('browser-pane');
const browserDivider = document.getElementById('browser-divider');
const webviewEl = document.getElementById('bw-view');
const urlInput = document.getElementById('bw-url');

function browserSettings() {
  state.settings = state.settings || {};
  return state.settings.browser || {};
}

function saveBrowserSettings(patch) {
  state.settings.browser = { ...browserSettings(), ...patch };
  save();
}

function openBrowserPane(url) {
  browserPane.classList.remove('hidden');
  browserDivider.classList.remove('hidden');
  const width = browserSettings().width;
  if (width) browserPane.style.width = `${width}px`;
  const target = url || browserSettings().url || 'https://www.google.com';
  if (url || !webviewEl.getAttribute('src')) webviewEl.setAttribute('src', target);
  saveBrowserSettings({ visible: true });
}

function closeBrowserPane() {
  browserPane.classList.add('hidden');
  browserDivider.classList.add('hidden');
  saveBrowserSettings({ visible: false });
}

function toggleBrowserPane() {
  if (browserPane.classList.contains('hidden')) openBrowserPane();
  else closeBrowserPane();
}

webviewEl.addEventListener('dom-ready', () => {
  window.mimi.browserAttached(webviewEl.getWebContentsId());
});
webviewEl.addEventListener('did-navigate', (e) => {
  urlInput.value = e.url;
  saveBrowserSettings({ url: e.url });
});
webviewEl.addEventListener('did-navigate-in-page', (e) => {
  urlInput.value = e.url;
  saveBrowserSettings({ url: e.url });
});

document.getElementById('bw-back').addEventListener('click', () => webviewEl.goBack());
document.getElementById('bw-fwd').addEventListener('click', () => webviewEl.goForward());
document.getElementById('bw-reload').addEventListener('click', () => webviewEl.reload());
document.getElementById('bw-close').addEventListener('click', closeBrowserPane);
urlInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Enter') return;
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  webviewEl.setAttribute('src', url);
});

// 選択テキストをアクティブタブのClaude入力欄へ引用として注入する（送信はしない）
document.getElementById('bw-ask').addEventListener('click', async () => {
  const text = ((await webviewEl.executeJavaScript('window.getSelection().toString()')) || '').trim();
  const entry = terms.get(state.activeTabId);
  if (!entry || !entry.attached) return;
  const title = webviewEl.getTitle();
  const url = webviewEl.getURL();
  const body = text
    ? `${text.split('\n').map((l) => `> ${l}`).join('\n')}\n（引用元: ${title} — ${url}）\n`
    : `（閲覧中: ${title} — ${url}）\n`;
  // 改行で送信扱いにならないよう bracketed paste で「貼り付け」として渡す
  window.mimi.ptyInput(state.activeTabId, `\x1b[200~${body}\x1b[201~`);
  entry.term.focus();
});

// 幅のドラッグ調整
browserDivider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  // ドラッグ中はwebview（別プロセス）にマウスイベントを奪われないよう遮断する
  document.body.classList.add('resizing');
  const onMove = (ev) => {
    const width = Math.min(window.innerWidth * 0.7, Math.max(320, window.innerWidth - ev.clientX));
    browserPane.style.width = `${width}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
    saveBrowserSettings({ width: browserPane.offsetWidth });
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

// ---- ブックマーク（ClaudeもMCPのbookmark_*ツールで管理できる） ----

const bookmarksBar = document.getElementById('bw-bookmarks');

function bookmarks() {
  return browserSettings().bookmarks ?? [];
}

function saveBookmarks(list) {
  saveBrowserSettings({ bookmarks: list });
  renderBookmarks();
}

function renderBookmarks() {
  bookmarksBar.innerHTML = '';
  for (const bm of bookmarks()) {
    const pill = document.createElement('button');
    pill.className = 'bm-pill';
    pill.textContent = bm.label;
    pill.title = `${bm.url}\n（右クリックで削除）`;
    pill.addEventListener('click', () => openBrowserPane(bm.url));
    pill.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm(`ブックマーク「${bm.label}」を削除しますか？`)) {
        saveBookmarks(bookmarks().filter((b) => b.url !== bm.url));
      }
    });
    bookmarksBar.appendChild(pill);
  }
  bookmarksBar.classList.toggle('hidden', bookmarks().length === 0);
}

document.getElementById('bw-star').addEventListener('click', () => {
  const url = webviewEl.getURL();
  if (!url) return;
  if (bookmarks().some((b) => b.url === url)) return;
  const label = (webviewEl.getTitle() || url).slice(0, 28);
  saveBookmarks([...bookmarks(), { label, url }]);
});

// Claude（MCPのbrowser_navigate）からの要求でペインを開く
window.mimi.onBrowserOpen((url) => openBrowserPane(url));

// ---------- init ----------

(async () => {
  state = await window.mimi.loadState();
  // 前回セッションのPTYは再起動で消えているため、attach状態はリセットして描画する
  applySettings();
  renderQuickbar();
  render();
  renderBookmarks();
  calendar = await window.mimi.getCalendar();
  renderTodayPanel();
  if (browserSettings().visible) openBrowserPane();
  if (state.activeTabId && state.tabs.some((t) => t.id === state.activeTabId)) {
    activateTab(state.activeTabId);
  }
})();
