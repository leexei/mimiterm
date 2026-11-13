#!/bin/bash
# MimiTerm セットアップスクリプト
# 使い方: scripts/setup.sh <deps|build|app|statusline|mcp|all>
# 再実行しても既存設定を破壊しない（app は MimiTerm.app を終了してから実行すること）。
# AI(Claude Code)による実行を想定している。
# リポジトリを移動した場合: ~/.claude/settings.json の statusLine.command のパスを手で直すこと。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

step_deps() {
  echo "== deps: 依存ツールの確認 =="
  command -v brew >/dev/null || { echo "NG: Homebrew が必要です https://brew.sh"; exit 1; }
  command -v node >/dev/null || { echo "NG: Node.js が必要です (v20+)"; exit 1; }
  command -v claude >/dev/null || { echo "NG: Claude Code が必要です"; exit 1; }
  command -v tmux >/dev/null || { echo "tmux をインストールします"; brew install tmux; }
  echo "OK: brew / node / claude / tmux ($(tmux -V))"
}

step_build() {
  echo "== build: npm install + node-pty rebuild =="
  npm install
  # macOSのCommand Line Toolsが壊れている環境向けのフォールバック付きrebuild
  if ! npm run rebuild; then
    echo "rebuild失敗。CLTのlibc++ヘッダ破損の可能性があるためSDK直指定で再試行します"
    export SDKROOT="$(xcrun --show-sdk-path)"
    export CXXFLAGS="-nostdinc++ -isystem $SDKROOT/usr/include/c++/v1"
    npm run rebuild
  fi
  echo "OK: build完了"
}

step_app() {
  echo "== app: パッケージして /Applications へ配置 =="
  npm run deploy
  echo "OK: /Applications/MimiTerm.app を更新しました"
  echo "初回起動でGatekeeperに止められた場合: 右クリック→開く、または"
  echo "  xattr -dr com.apple.quarantine /Applications/MimiTerm.app"
}

step_statusline() {
  echo "== statusline: Claude Code の statusLine を MimiTerm tap に設定 =="
  python3 - "$REPO_DIR" <<'EOF'
import json, os, shutil, sys
repo = sys.argv[1]
p = os.path.expanduser('~/.claude/settings.json')
d = {}
if os.path.exists(p):
    d = json.load(open(p))
cur = d.get('statusLine', {}).get('command', '')
tap = f'bash {repo}/scripts/statusline-tap.sh'
if 'statusline-tap.sh' in cur:
    print('OK: 既にtapが設定済み（変更なし）')
else:
    # バックアップは初回のみ作成する（再実行でtap設定後の内容に上書きしない）
    backup = p + '.mimiterm-backup'
    if os.path.exists(p) and not os.path.exists(backup):
        shutil.copy(p, backup)
        print(f'バックアップ作成: {backup}')
    if cur:
        # 既存のstatuslineはチェーン先として退避し、表示を維持する
        chain = os.path.expanduser('~/.mimiterm/statusline-chain.sh')
        os.makedirs(os.path.dirname(chain), exist_ok=True)
        if not os.path.exists(chain):
            with open(chain, 'w') as f:
                f.write(f'#!/bin/bash\nexec {cur}\n')
            print(f'既存statusline({cur})をチェーン先として退避: {chain}')
    d['statusLine'] = {'type': 'command', 'command': tap, 'padding': d.get('statusLine', {}).get('padding', 2)}
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    print('OK: statusLineをtapに設定')
EOF
}

step_mcp() {
  echo "== mcp: MimiTerm MCPサーバーを user scope で登録 =="
  CFG="$HOME/.mimiterm/mcp.json"
  if [ ! -f "$CFG" ]; then
    echo "NG: $CFG がありません。先にMimiTerm.appを一度起動してください"
    exit 1
  fi
  TOKEN=$(python3 -c "import json;print(json.load(open('$CFG'))['token'])")
  PORT=$(python3 -c "import json;print(json.load(open('$CFG'))['port'])")
  claude mcp remove --scope user mimiterm >/dev/null 2>&1 || true
  claude mcp add --scope user --transport http mimiterm "http://127.0.0.1:${PORT}/mcp" \
    --header "Authorization: Bearer ${TOKEN}"
  echo "OK: MCP登録完了（新しいClaude Codeセッションから利用可能）"
}

step_autoschedule() {
  echo "== autoschedule: 応答から予定日を検出してタブを自動整理するhookを登録 =="
  python3 - "$REPO_DIR" <<'EOF'
import json, os, shutil, sys
repo = sys.argv[1]
p = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(p)) if os.path.exists(p) else {}
cmd = f'bash {repo}/scripts/auto-schedule-hook.sh'
hooks = d.setdefault('hooks', {})
stop = hooks.setdefault('Stop', [])
if any(cmd in h.get('command', '') for entry in stop for h in entry.get('hooks', [])):
    print('OK: 既に登録済み')
else:
    backup = p + '.mimiterm-backup'
    if os.path.exists(p) and not os.path.exists(backup):
        shutil.copy(p, backup)
    stop.append({'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]})
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    print('OK: Stop hookに登録しました（新しいセッションから有効）')
EOF
}

step_conductor() {
  echo "== conductor: 司令塔タブ用のhookと指示文を配置 =="
  python3 - "$REPO_DIR" <<'EOF'
import json, os, shlex, shutil, sys
repo = sys.argv[1]
if '.wt/' in repo + '/':
    sys.exit('NG: worktree から実行されています。hookに消えるパスが登録されるので、メインのリポジトリから実行してください')
cdir = os.path.expanduser('~/.mimiterm/conductor')
os.makedirs(cdir, exist_ok=True)
# 司令塔のClaudeが固定パスで参照できるよう、リポジトリのスクリプトへリンクを張る
for name, src in (('conductor.py', 'scripts/conductor.py'), ('prompt.md', 'scripts/conductor-prompt.md')):
    link = os.path.join(cdir, name)
    if os.path.lexists(link):
        os.remove(link)
    os.symlink(os.path.join(repo, src), link)
cfg = os.path.join(cdir, 'config.json')
if not os.path.exists(cfg):
    with open(cfg, 'w') as f:
        json.dump({'denyPatterns': []}, f, indent=2)
    print(f'設定ファイル作成: {cfg}（denyPatterns に、司令塔に読ませたくないパスの一部を書く）')

# シンボリックリンクで管理されている場合に、リンクを実ファイルで置き換えない
p = os.path.realpath(os.path.expanduser('~/.claude/settings.json'))
d = json.load(open(p)) if os.path.exists(p) else {}
# スクリプトが見つからない時に python3 が返す exit 2 は、Claude Code では「ブロック」扱いになり
# 全セッションのツール実行が止まる。hookの失敗は必ず握りつぶす
cmd = f'python3 {shlex.quote(repo + "/scripts/conductor.py")} hook || true'
hooks = d.setdefault('hooks', {})
wanted = {
    'Notification': None,
    'Stop': None,
    # 質問・プラン承認の検知と、司令塔タブの読み取りガード
    'PreToolUse': 'AskUserQuestion|ExitPlanMode|Read|Bash|Grep|Glob|Monitor',
}
changed = False
for event, matcher in wanted.items():
    entries = hooks.setdefault(event, [])
    ours = [h for e in entries for h in e.get('hooks', []) if 'conductor.py' in h.get('command', '') and ' hook' in h.get('command', '')]
    if ours:
        # 登録済み。リポジトリを移動した後の再実行でパスを直せるよう、コマンドは更新する
        for h in ours:
            if h.get('command') != cmd:
                h['command'] = cmd
                changed = True
        continue
    entry = {'hooks': [{'type': 'command', 'command': cmd, 'timeout': 10}]}
    if matcher:
        entry['matcher'] = matcher
    entries.append(entry)
    changed = True
if changed:
    backup = p + '.mimiterm-backup'
    if os.path.exists(p) and not os.path.exists(backup):
        shutil.copy(p, backup)
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    print('OK: Notification / Stop / PreToolUse hookを登録・更新しました（新しいセッションから有効）')
else:
    print('OK: hookは登録済み')
print('次: MimiTermのサイドバー「🎛 司令塔」を押すと司令塔タブが起動します')
EOF
}

case "${1:-all}" in
  deps) step_deps ;;
  autoschedule) step_autoschedule ;;
  conductor) step_conductor ;;
  build) step_build ;;
  app) step_app ;;
  statusline) step_statusline ;;
  mcp) step_mcp ;;
  all)
    step_deps
    step_build
    step_app
    step_statusline
    echo
    echo "次: MimiTerm.app を起動してから 'scripts/setup.sh mcp' を実行してください"
    ;;
  *) echo "Usage: setup.sh <deps|build|app|statusline|mcp|autoschedule|conductor|all>"; exit 1 ;;
esac
