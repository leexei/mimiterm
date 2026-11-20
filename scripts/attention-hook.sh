#!/bin/bash
# MimiTerm attention hook（Claude Code の各種フック用・async で登録する）
#
# 人の入力待ち（許可ダイアログ・AskUserQuestion・上限停止）をタブに 🙋/⛔ の印として付け、
# 解消したら外す。詳細は attention_hook.py。
# MimiTerm のタブ（tmux セッション mimi-*）の外では何もしない。
set -uo pipefail

[ -n "${TMUX:-}" ] || exit 0
TMUX_BIN=$(command -v tmux || echo /opt/homebrew/bin/tmux)
sess=$("$TMUX_BIN" display-message -p '#S' 2>/dev/null) || exit 0
case "$sess" in mimi-*) ;; *) exit 0 ;; esac

CFG="$HOME/.mimiterm/mcp.json"
[ -f "$CFG" ] || exit 0

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
python3 "$SCRIPT_DIR/attention_hook.py" "$sess" "$CFG" || true
exit 0
