// 入力待ち（attention）の共通定義と、入力欄の未送信テキスト検出
const ATTENTION_ICON = { permission: '🙋', question: '🙋', limit: '⛔', unsent: '✍️' };

// 入力欄（❯ の行）に文字が残っているかを tmux capture-pane の画面テキストから判定する。
// 罫線（─）の直後にある最後の ❯ 行を入力欄とみなす。ダイアログ表示中は対象外。
function unsentInputText(paneText) {
  if (/Enter to select|Esc to cancel|Do you want to proceed/.test(paneText)) return null;
  const lines = paneText.split('\n');
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!/^─{10,}/.test(lines[i - 1])) continue;
    const m = lines[i].match(/^❯ ?(.*)$/);
    if (m) return m[1].trim() || null;
  }
  return null;
}

module.exports = { ATTENTION_ICON, unsentInputText };
