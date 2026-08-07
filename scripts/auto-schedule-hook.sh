#!/bin/bash
# MimiTerm auto-schedule hook (Claude Code の Stop hook 用)
#
# Claudeの応答から「別日にやる」意図を検出し、MimiTermのタブを自動で整理する。
#   - 明示的な日付/曜日が読み取れた場合: schedule_tab で予定日を設定し、その日付グループへ移動
#   - 曖昧な延期表現のみの場合:          タブに 🤔 バッジを付けるだけ（判断は人に残す）
# 追加のAI呼び出しは行わない（正規表現による検出のみ）。
#
# セットアップ: scripts/setup.sh autoschedule
set -uo pipefail

input=$(cat)
exit_ok() { exit 0; }   # Stop hookは常に非ブロッキングで終了する

[ -n "${TMUX:-}" ] || exit_ok
TMUX_BIN=$(command -v tmux || echo /opt/homebrew/bin/tmux)
sess=$("$TMUX_BIN" display-message -p '#S' 2>/dev/null) || exit_ok
case "$sess" in mimi-*) ;; *) exit_ok ;; esac

CFG="$HOME/.mimiterm/mcp.json"
[ -f "$CFG" ] || exit_ok

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
printf '%s' "$input" | python3 "$SCRIPT_DIR/auto_schedule.py" "$sess" "$CFG" || true
exit_ok
