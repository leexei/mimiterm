const fs = require('fs');
const { execFile } = require('child_process');

// GUI起動時はbrewのPATHを継承しないため、tmuxは既知パスから解決する
const TMUX_CANDIDATES = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'];
const TMUX = TMUX_CANDIDATES.find((p) => fs.existsSync(p)) || 'tmux';

// tmux は必ず -u（UTF-8を強制）を付けて呼ぶ。引数は必ずこの関数を通すこと。
// Finder / Dock から起動したアプリには LANG 等のロケール環境変数が無く、-u なしの tmux クライアントは
// 非UTF-8扱いになって、list-panes 等の出力中のタブ文字を '_' に置き換える。区切り（タブ文字）が壊れると
// 全タブの稼働状態（サイドバーの●/✳、conductor_status の state）が取れなくなる
const tmuxArgs = (args) => ['-u', ...args];

// 結果を使わない呼び出しは callback を省略できる（失敗は無視）
const tmuxExec = (args, callback = () => {}) => execFile(TMUX, tmuxArgs(args), callback);

// 標準出力を文字列で返す。失敗時（サーバー未起動など）は null
const tmuxExecP = (args) =>
  new Promise((resolve) => tmuxExec(args, (err, stdout) => resolve(err ? null : String(stdout))));

// TMUX と tmuxArgs は pty.spawn 用。それ以外は tmuxExec / tmuxExecP を使う
module.exports = { TMUX, tmuxArgs, tmuxExec, tmuxExecP };
