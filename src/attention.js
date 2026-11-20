// 入力待ち（attention）の共通定義と、入力欄の未送信テキスト検出
const ATTENTION_ICON = { permission: '🙋', question: '🙋', limit: '⛔', unsent: '✍️' };

// 許可ダイアログ・AskUserQuestion の選択肢が画面に出ているか
// 会話本文に同じ文字列が出ても誤検知しないよう、画面最下部の数行で「行頭が操作案内」の時だけダイアログとみなす
const DIALOG_FOOTER_RE = /^\s*(Enter to select|Esc to cancel)/;
function dialogVisible(paneText) {
  const lines = paneText.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-4).some((l) => DIALOG_FOOTER_RE.test(l));
}

// 入力欄（❯ の行）に文字が残っているかを tmux capture-pane の画面テキストから判定する。
// 罫線（─）の直後にある最後の ❯ 行を入力欄とみなす。ダイアログ表示中は対象外。
function unsentInputText(paneText) {
  if (dialogVisible(paneText)) return null;
  const lines = paneText.split('\n');
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!/^─{10,}/.test(lines[i - 1])) continue;
    const m = lines[i].match(/^❯ ?(.*)$/);
    if (m) return m[1].trim() || null;
  }
  return null;
}

module.exports = { ATTENTION_ICON, unsentInputText, dialogVisible };
