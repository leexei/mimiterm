/* global Terminal, FitAddon */

let state = { groups: [], tabs: [], activeTabId: null };
const terms = new Map(); // tabId -> { term, fit, container, attached }

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
  tabEl.draggable = true;

  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = tab.name;
  tabEl.appendChild(name);

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
    theme: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5c2e7',
    },
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

async function activateTab(tabId) {
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
    });
  }
  entry.term.focus();
  render();
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
  render();
});

window.addEventListener('resize', () => {
  const entry = terms.get(state.activeTabId);
  if (entry) entry.fit.fit();
});

document.getElementById('add-group').addEventListener('click', createGroup);

// ---------- init ----------

(async () => {
  state = await window.mimi.loadState();
  // 前回セッションのPTYは再起動で消えているため、attach状態はリセットして描画する
  render();
  if (state.activeTabId && state.tabs.some((t) => t.id === state.activeTabId)) {
    activateTab(state.activeTabId);
  }
})();
