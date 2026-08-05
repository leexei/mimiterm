#!/bin/bash
# MimiTerm statusline tap:
# Claude Code の statusline JSON を tmux セッション名キーで保存してから、
# 既存の statusline スクリプトへそのまま流す（表示は従来どおり）。
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

printf '%s' "$input" | bash "$HOME/.claude/statusline.sh"
