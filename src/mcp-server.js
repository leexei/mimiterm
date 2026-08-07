// MimiTerm 内蔵 MCP サーバー（Streamable HTTP / stateless）
// 127.0.0.1 バインド + Bearer トークン認証。タブ・グループ操作と外観変更のみを公開し、
// 任意コマンド実行のような万能ツールは意図的に持たない。
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(os.homedir(), '.mimiterm', 'mcp.json');
const DEFAULT_PORT = 48237;
const SERVER_VERSION = '0.3.0';

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.port && cfg.token) return cfg;
  } catch {
    // 初回は生成する
  }
  const cfg = { port: DEFAULT_PORT, token: crypto.randomBytes(24).toString('hex') };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// tab の参照: id / tmuxセッション名 / タブ名（完全一致優先）の順で解決
function resolveTab(state, ref) {
  return (
    state.tabs.find((t) => t.id === ref) ||
    state.tabs.find((t) => t.tmuxSession === ref) ||
    state.tabs.find((t) => t.name === ref) ||
    state.tabs.find((t) => t.name.toLowerCase() === String(ref).toLowerCase())
  );
}

function resolveGroup(state, ref) {
  return (
    state.groups.find((g) => g.id === ref) ||
    state.groups.find((g) => g.name === ref) ||
    state.groups.find((g) => g.name.toLowerCase() === String(ref).toLowerCase())
  );
}

function tabSummary(state, tab, claudeSessions) {
  const info = claudeSessions[tab.tmuxSession];
  const group = state.groups.find((g) => g.id === tab.groupId);
  return {
    id: tab.id,
    name: tab.name,
    group: group ? group.name : null,
    groupId: tab.groupId,
    tmuxSession: tab.tmuxSession,
    active: state.activeTabId === tab.id,
    claudeSessionId: tab.claudeSessionId ?? info?.sessionId ?? null,
    contextPct: info?.pct ?? null,
    model: info?.model ?? null,
    badge: tab.badgeEmoji ?? null,
    scheduledFor: tab.scheduledFor ?? null,
    dueToday: !!(tab.scheduledFor && tab.scheduledFor <= new Date().toLocaleDateString('sv-SE')),
  };
}

const TAB_REF_DESC = 'タブの参照（タブID / tmuxセッション名 / タブ名のいずれか）';

const TOOLS = [
  {
    name: 'list_tabs',
    description:
      'MimiTerm の全グループと全タブの一覧を返す。各タブの Claude コンテキスト使用率(contextPct)・セッションID・再開予定日(scheduledFor)・バッジも含む。タブ棚卸しはまずこれを呼ぶ。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (args, ctx) => {
      const state = ctx.getState();
      const sessions = ctx.getClaudeSessions();
      return {
        groups: state.groups.map((g) => ({ id: g.id, name: g.name, collapsed: !!g.collapsed })),
        tabs: state.tabs.map((t) => tabSummary(state, t, sessions)),
      };
    },
  },
  {
    name: 'rename_tab',
    description: 'タブの名前を変更する。',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: TAB_REF_DESC },
        name: { type: 'string', description: '新しいタブ名' },
      },
      required: ['tab', 'name'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const tab = resolveTab(state, args.tab);
        if (!tab) throw new Error(`タブが見つかりません: ${args.tab}`);
        tab.name = args.name;
        return { ok: true, tab: { id: tab.id, name: tab.name } };
      }),
  },
  {
    name: 'create_group',
    description: 'グループを新規作成する。既に同名グループがあればそれを返す。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'グループ名' } },
      required: ['name'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const existing = resolveGroup(state, args.name);
        if (existing) return { ok: true, group: { id: existing.id, name: existing.name }, created: false };
        const group = { id: uid('g'), name: args.name, collapsed: false };
        state.groups.push(group);
        return { ok: true, group: { id: group.id, name: group.name }, created: true };
      }),
  },
  {
    name: 'move_tab_to_group',
    description: 'タブを別のグループへ移動する。グループが存在しない場合は作成して移動する。',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: TAB_REF_DESC },
        group: { type: 'string', description: '移動先グループ（グループID or グループ名）' },
      },
      required: ['tab', 'group'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const tab = resolveTab(state, args.tab);
        if (!tab) throw new Error(`タブが見つかりません: ${args.tab}`);
        let group = resolveGroup(state, args.group);
        let created = false;
        if (!group) {
          group = { id: uid('g'), name: args.group, collapsed: false };
          state.groups.push(group);
          created = true;
        }
        tab.groupId = group.id;
        return { ok: true, tab: tab.name, group: group.name, groupCreated: created };
      }),
  },
  {
    name: 'collapse_group',
    description: 'グループを折りたたむ / 展開する。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'グループID or グループ名' },
        collapsed: { type: 'boolean', description: 'true=折りたたむ / false=展開する' },
      },
      required: ['group', 'collapsed'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const group = resolveGroup(state, args.group);
        if (!group) throw new Error(`グループが見つかりません: ${args.group}`);
        group.collapsed = args.collapsed;
        return { ok: true, group: group.name, collapsed: group.collapsed };
      }),
  },
  {
    name: 'set_tab_badge',
    description: 'タブに絵文字バッジを付ける（例: 🔥=作業中, ⏳=待ち, ✅=完了）。空文字で削除。',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: TAB_REF_DESC },
        badge: { type: 'string', description: '絵文字1〜2文字。空文字でバッジ削除' },
      },
      required: ['tab', 'badge'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const tab = resolveTab(state, args.tab);
        if (!tab) throw new Error(`タブが見つかりません: ${args.tab}`);
        tab.badgeEmoji = args.badge ? String(args.badge).slice(0, 4) : null;
        return { ok: true, tab: tab.name, badge: tab.badgeEmoji };
      }),
  },
  {
    name: 'schedule_tab',
    description:
      'タブに再開予定日を設定する（例: 3日後に再開するタスク）。設定するとタブに ⏳日付 が表示される。date に空文字で解除。',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: TAB_REF_DESC },
        date: { type: 'string', description: '再開予定日 YYYY-MM-DD。空文字で解除' },
      },
      required: ['tab', 'date'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const tab = resolveTab(state, args.tab);
        if (!tab) throw new Error(`タブが見つかりません: ${args.tab}`);
        if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
          throw new Error(`日付は YYYY-MM-DD 形式で指定してください: ${args.date}`);
        }
        tab.scheduledFor = args.date || null;
        // 「日付未定」を意味する 🤔 は、予定が確定したら不要になるので外す
        if (args.date && tab.badgeEmoji === '🤔') tab.badgeEmoji = null;
        return { ok: true, tab: tab.name, scheduledFor: tab.scheduledFor };
      }),
  },
  {
    name: 'set_background',
    description:
      'ターミナル背景に画像を設定する。image_path に空文字で背景を解除。opacity は画像の見え具合（0.05〜0.6, 省略時 0.25）。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '画像ファイルの絶対パス。空文字で解除' },
        opacity: { type: 'number', description: '画像の見え具合 0.05〜0.6（省略時 0.25）' },
      },
      required: ['image_path'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        if (args.image_path) {
          if (!fs.existsSync(args.image_path)) {
            throw new Error(`画像ファイルが見つかりません: ${args.image_path}`);
          }
          state.settings = state.settings || {};
          state.settings.background = args.image_path;
          state.settings.backgroundOpacity = Math.min(0.6, Math.max(0.05, args.opacity ?? 0.25));
        } else {
          if (state.settings) {
            delete state.settings.background;
            delete state.settings.backgroundOpacity;
          }
        }
        return { ok: true, background: state.settings?.background ?? null };
      }),
  },
  {
    name: 'browser_navigate',
    description:
      'MimiTerm の埋め込みブラウザペインでURLを開く（ペインが閉じていれば自動で開く）。ユーザーと同じ画面を見ながら会話するための入口。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '開くURL（https://...）' } },
      required: ['url'],
      additionalProperties: false,
    },
    handler: (args, ctx) => ctx.browser.navigate(args.url),
  },
  {
    name: 'browser_get_page',
    description:
      '埋め込みブラウザで表示中のページの本文テキストを取得する。ユーザーがログインして見ている実物のレンダリング結果なので、API権限不要でConfluence等も読める。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) => ctx.browser.getPage(),
  },
  {
    name: 'browser_get_selection',
    description: '埋め込みブラウザでユーザーが選択中のテキストを取得する。「ここどう思う？」の「ここ」を正確に知るために使う。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) => ctx.browser.getSelection(),
  },
  {
    name: 'browser_get_styles',
    description:
      '埋め込みブラウザでユーザーが選択中の範囲の計算済みスタイル（テーブルセルの背景色・文字色）を取得する。色・網掛けで分類されたConfluenceテーブルの判読に使う（MCPのMarkdown変換では色情報が消えるため、このツールが唯一の正確な色ソース）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) => ctx.browser.getStyles(),
  },
  {
    name: 'browser_click',
    description:
      '埋め込みブラウザ内の要素をクリックする（ダッシュボードのパネル展開・タブ切替・リンク遷移など）。selector（CSSセレクタ）か text（表示テキストの部分一致）のどちらかで対象を指定。SSO/MFA等の認証承認画面では使用しないこと。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSSセレクタ（例: .panel-title a）' },
        text: { type: 'string', description: '表示テキストの部分一致（selector未指定時に使用）' },
      },
      additionalProperties: false,
    },
    handler: (args, ctx) => {
      if (!args.selector && !args.text) throw new Error('selector か text のどちらかを指定してください');
      return ctx.browser.click(args);
    },
  },
  {
    name: 'browser_type',
    description:
      '埋め込みブラウザの入力欄に文字を入力する。selector指定でその要素にフォーカスしてから入力、未指定なら現在フォーカス中の要素へ。submit=trueで入力後にEnterを送る。パスワード等の認証情報の入力には使用しないこと。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '入力するテキスト' },
        selector: { type: 'string', description: 'フォーカスする要素のCSSセレクタ（省略時は現在のフォーカス先）' },
        submit: { type: 'boolean', description: 'trueなら入力後にEnterを送信' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    handler: (args, ctx) => ctx.browser.type(args),
  },
  {
    name: 'bookmark_list',
    description: 'ブラウザペインのブックマーク一覧を返す。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) => ({
      bookmarks: ctx.getState().settings?.browser?.bookmarks ?? [],
    }),
  },
  {
    name: 'bookmark_add',
    description: 'ブラウザペインにブックマークを追加する（同一URLは重複追加しない）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'ブックマークするURL' },
        label: { type: 'string', description: '表示名（省略時はURL）' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        state.settings = state.settings || {};
        state.settings.browser = state.settings.browser || {};
        const list = state.settings.browser.bookmarks || [];
        if (list.some((b) => b.url === args.url)) return { ok: true, added: false, reason: '既に存在' };
        list.push({ label: (args.label || args.url).slice(0, 28), url: args.url });
        state.settings.browser.bookmarks = list;
        return { ok: true, added: true };
      }),
  },
  {
    name: 'bookmark_remove',
    description: 'ブラウザペインのブックマークを削除する。ref にはURLか表示名を指定。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: '削除対象のURL or 表示名' } },
      required: ['ref'],
      additionalProperties: false,
    },
    handler: (args, ctx) =>
      ctx.mutateState((state) => {
        const list = state.settings?.browser?.bookmarks || [];
        const remain = list.filter((b) => b.url !== args.ref && b.label !== args.ref);
        if (remain.length === list.length) throw new Error(`ブックマークが見つかりません: ${args.ref}`);
        state.settings.browser.bookmarks = remain;
        return { ok: true, removed: list.length - remain.length };
      }),
  },
  {
    name: 'browser_screenshot',
    description: '埋め込みブラウザの表示内容をPNGに保存してファイルパスを返す。Readツールでそのパスを開くと見た目を画像で確認できる。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_args, ctx) => ctx.browser.screenshot(),
  },
];

async function dispatch(msg, ctx) {
  const isNotification = !('id' in msg) || msg.id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const replyError = (code, message) =>
    isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } };

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'mimiterm', version: SERVER_VERSION },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return replyError(-32602, `Unknown tool: ${msg.params?.name}`);
      try {
        const result = await tool.handler(msg.params?.arguments ?? {}, ctx);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (msg.method?.startsWith('notifications/')) return null;
      return replyError(-32601, `Method not found: ${msg.method}`);
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('payload too large'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req, cfg) {
  const provided = Buffer.from(String(req.headers['authorization'] || ''));
  const expected = Buffer.from(`Bearer ${cfg.token}`);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

async function handleRequest(req, res, cfg, ctx) {
  if (req.url.split('?')[0] !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  // DNSリバインディング対策: ブラウザ由来（Originあり）のクロスオリジン要求は拒否する
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.writeHead(403).end();
    return;
  }
  if (!authorized(req, cfg)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const responses = [];
  for (const m of messages) {
    const r = await dispatch(m, ctx);
    if (r) responses.push(r);
  }
  if (responses.length === 0) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
}

function startMcpServer(ctx) {
  const cfg = loadConfig();
  const server = http.createServer((req, res) => {
    handleRequest(req, res, cfg, ctx).catch(() => {
      try {
        res.writeHead(500).end();
      } catch {
        // レスポンス送信済みなら無視
      }
    });
  });
  server.on('error', (e) => {
    console.error(`[mimiterm-mcp] 起動失敗（別インスタンスが使用中?）: ${e.message}`);
  });
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`[mimiterm-mcp] listening on http://127.0.0.1:${cfg.port}/mcp`);
  });
  return cfg;
}

module.exports = { startMcpServer };
