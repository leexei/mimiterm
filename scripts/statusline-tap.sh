#!/bin/bash
# MimiTerm statusline tap:
# Claude Code の statusline JSON を tmux セッション名キーで保存し、MimiTerm のタブに
# コンテキスト%等を表示できるようにする。その後、既存の statusline があればそこへ流す。
#
# チェーン先の優先順位:
#   1. ~/.mimiterm/statusline-chain.sh （明示指定用）
#   2. ~/.claude/statusline.sh          （一般的な配置場所）
#   3. 内蔵の最小表示（モデル名 + コンテキスト%）
input=$(cat)

if [ -n "$TMUX" ]; then
  TMUX_BIN=$(command -v tmux || echo /opt/homebrew/bin/tmux)
  sess=$("$TMUX_BIN" display-message -p '#S' 2>/dev/null)
  case "$sess" in
    mimi-*)
      dir="$HOME/.mimiterm/sessions"
      mkdir -p "$dir"
      printf '%s' "$input" > "$dir/$sess.json.tmp" && mv "$dir/$sess.json.tmp" "$dir/$sess.json"
      ;;
  esac
fi

if [ -f "$HOME/.mimiterm/statusline-chain.sh" ]; then
  printf '%s' "$input" | bash "$HOME/.mimiterm/statusline-chain.sh"
elif [ -f "$HOME/.claude/statusline.sh" ]; then
  printf '%s' "$input" | bash "$HOME/.claude/statusline.sh"
else
  pct=$(printf '%s' "$input" | sed -n 's/.*"used_percentage":\([0-9]*\).*/\1/p' | head -1)
  model=$(printf '%s' "$input" | sed -n 's/.*"display_name":"\([^"]*\)".*/\1/p' | head -1)
  printf '%s | ctx %s%%\n' "${model:-Claude}" "${pct:-0}"
fi
