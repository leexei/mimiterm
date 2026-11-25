// 入力待ち（attention）を司令塔タブへ1行で知らせる。
// 送り先: settings.attentionRelayTab（タブID / タブ名 / tmuxセッション名）→ 無ければ司令塔タブ（conductorTabId）。どちらも無ければ何もしない。
// 送るのは「待ちが立った時（猶予後）」と「10分たっても解消しない時」の2回だけ。送り先タブ自身の待ちは対象外。
// 送り先の画面にダイアログが出ている・入力欄に文字がある時は送らず、次の機会まで溜めておく（入力中の文字を壊さないため）。
const { ATTENTION_ICON, dialogVisible, unsentInputText } = require('./attention');

const RELAY_GRACE_MS = 20 * 1000; // すぐ答えられた待ちは送らない
const RELAY_REMIND_MS = 10 * 60 * 1000;
const MESSAGE_HEAD = 40;

function resolveRelayTarget(state) {
  const ref = state.settings?.attentionRelayTab;
  const tabs = state.tabs || [];
  if (ref) return tabs.find((t) => t.id === ref || t.name === ref || t.tmuxSession === ref) || null;
  return tabs.find((t) => t.id === state.conductorTabId) || null;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function formatLine(tab, attention, sinceMs, type, now) {
  const icon = ATTENTION_ICON[attention.kind] || '🙋';
  const elapsed = type === 'remind' ? `・${Math.floor((now - sinceMs) / 60000)}分未解消` : '';
  const msg = String(attention.message || '').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_HEAD);
  return `[待ち${icon} ${attention.kind}] ${tab.name} since ${hhmm(sinceMs)}${elapsed}${msg ? `「${msg}」` : ''} mimiterm://tab/${tab.id}`;
}

// tracked: Map tabId -> { key, firstSeen, sinceMs, notified, reminded }（呼び出し側が持ち回す）
// 戻り値: 送る行の配列と、ログ用のイベント配列
function planRelay(state, tracked, now) {
  const target = resolveRelayTarget(state);
  const lines = [];
  const events = [];
  if (!target) {
    tracked.clear();
    return { target: null, lines, events };
  }
  const seen = new Set();
  for (const tab of state.tabs || []) {
    const a = tab.attention;
    if (!a || tab.id === target.id) continue;
    seen.add(tab.id);
    const key = `${a.kind}|${a.since || ''}`;
    let t = tracked.get(tab.id);
    if (!t || t.key !== key) {
      const parsed = Date.parse(a.since || '');
      t = { key, firstSeen: now, sinceMs: Number.isNaN(parsed) ? now : parsed, notified: false, reminded: false };
      tracked.set(tab.id, t);
    }
    if (!t.notified && now - t.firstSeen >= RELAY_GRACE_MS) {
      t.notified = true;
      t.reminded = now - t.sinceMs >= RELAY_REMIND_MS; // 既に10分以上たっている待ち（起動直後など）は1回で済ませる
      lines.push(formatLine(tab, a, t.sinceMs, t.reminded ? 'remind' : 'new', now));
      events.push({ event: 'notify', tabId: tab.id, tab: tab.name, kind: a.kind, since: a.since });
    } else if (t.notified && !t.reminded && now - t.sinceMs >= RELAY_REMIND_MS) {
      t.reminded = true;
      lines.push(formatLine(tab, a, t.sinceMs, 'remind', now));
      events.push({ event: 'remind', tabId: tab.id, tab: tab.name, kind: a.kind, since: a.since });
    }
  }
  for (const [tabId, t] of tracked) {
    if (seen.has(tabId)) continue;
    tracked.delete(tabId);
    if (t.notified) events.push({ event: 'cleared', tabId, kind: t.key.split('|')[0], since: new Date(t.sinceMs).toISOString() });
  }
  return { target, lines, events };
}

// 送り先の画面が「今送っても大丈夫」か（ダイアログ表示中・入力欄に文字がある時は待つ）
function targetReady(paneText) {
  if (!paneText) return false;
  return !dialogVisible(paneText) && !unsentInputText(paneText);
}

module.exports = { resolveRelayTarget, formatLine, planRelay, targetReady, RELAY_GRACE_MS, RELAY_REMIND_MS };
