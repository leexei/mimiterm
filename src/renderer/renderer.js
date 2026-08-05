/* global Terminal, FitAddon */

let state = { groups: [], tabs: [], activeTabId: null };
const terms = new Map(); // tabId -> { term, fit, container, attached }
let claudeSessions = {}; // tmuxSession -> { pct, model, sessionId, updatedAt }

const groupsEl = document.getElementById('groups');
const terminalsEl = document.getElementById('terminals');

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function save() {
  window.mimi.saveState(state);
}

// ---------- sidebar rendering ----------

function render() {
  groupsEl.innerHTML = '';
  for (const group of state.groups) {
    groupsEl.appendChild(renderGroup(group));
  }
  renderEmptyHint();
}

function renderGroup(group) {
  const groupEl = document.createElement('div');
  groupEl.className = 'group' + (group.collapsed ? ' collapsed' : '');

  const header = document.createElement('div');
  header.className = 'group-header';
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
    tabsEl.appendChild(renderTab(tab));
  }
  groupEl.appendChild(tabsEl);

  // drop target: タブをこのグループへ移動
  groupEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    groupEl.classList.add('drag-over');
  });
  groupEl.addEventListener('dragleave', () => groupEl.classList.remove('drag-over'));
  groupEl.addEventListener('drop', (e) => {
    e.preventDefault();
    groupEl.classList.remove('drag-over');
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

function renderTab(tab) {
  const entry = terms.get(tab.id);
  const tabEl = document.createElement('div');
  tabEl.className =
    'tab' +
    (tab.id === state.activeTabId ? ' active' : '') +
    (entry && !entry.attached ? ' detached' : '');
  tabEl.dataset.tabId = tab.id;
  tabEl.draggable = true;

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
    const chip = document.createElement('span');
    chip.className = 'schedule-chip';
    chip.textContent = `⏳${tab.scheduledFor.slice(5).replace('-', '/')}`;
    chip.title = `再開予定: ${tab.scheduledFor}`;
    tabEl.appendChild(chip);
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

  return tabEl;
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
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

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
    const badgeEl = el.querySelector('.tab-badge');
    if (tab && badgeEl) applyBadge(badgeEl, tab);
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
  const today = new Date().toISOString().slice(0, 10);
  state.groups.push({ id: uid('g'), name: `📅 ${today}`, collapsed: false });
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
  const entry = terms.get(tab.id);
  if (entry) {
    window.mimi.ptyKill(tab.id);
    entry.term.dispose();
    entry.container.remove();
    terms.delete(tab.id);
  }
  if (killSession) window.mimi.killTmuxSession(tab.tmuxSession);
  state.tabs = state.tabs.filter((t) => t.id !== tab.id);
  if (state.activeTabId === tab.id) state.activeTabId = null;
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
    if (ev.type === 'keydown' && ev.key === 'Enter' && (ev.shiftKey || ev.altKey)) {
      window.mimi.ptyInput(tab.id, '\x1b\r');
      return false;
    }
    return true;
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(container);
  term.onData((data) => window.mimi.ptyInput(tab.id, data));
  term.onResize(({ cols, rows }) => window.mimi.ptyResize(tab.id, cols, rows));

  entry = { term, fit, container, attached: false };
  terms.set(tab.id, entry);
  return entry;
}

async function activateTab(tabId, initialCommand) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  state.activeTabId = tabId;
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
}

window.mimi.onPtyData((tabId, data) => {
  const entry = terms.get(tabId);
  if (entry) entry.term.write(data);
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
  render();
});

window.mimi.onClaudeSessions((sessions) => {
  claudeSessions = sessions;
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
});

window.addEventListener('resize', () => {
  const entry = terms.get(state.activeTabId);
  if (entry) entry.fit.fit();
});

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
  modal.id = 'import-modal';
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
  // 過去に作業していたディレクトリなので trust ダイアログを事前承認しておく
  await window.mimi.trustDir(s.cwd);
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
  activateTab(tab.id, `cd '${s.cwd}' && claude --resume ${s.sessionId}`);
}

document.getElementById('import-session').addEventListener('click', openImportModal);

// ---------- init ----------

(async () => {
  state = await window.mimi.loadState();
  // 前回セッションのPTYは再起動で消えているため、attach状態はリセットして描画する
  applySettings();
  render();
  if (state.activeTabId && state.tabs.some((t) => t.id === state.activeTabId)) {
    activateTab(state.activeTabId);
  }
})();
