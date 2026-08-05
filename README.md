# MimiTerm 🐈‍⬛

Claude Code ネイティブな自作ターミナル。タブをグループ（日毎など）にまとめて管理でき、セッションは tmux が保持するためアプリを再起動しても消えない。

## アーキテクチャ

```
Electron GUI（グループ / タブ / 命名）
 └─ xterm.js で描画
      └─ node-pty 経由で tmux new-session -A -s <session> に attach
           └─ tmux セッションが実体（アプリ寿命と分離）
```

- 状態（グループ / タブ / tmuxセッション名の対応）は `~/.mimiterm/state.json` に永続化
- タブを閉じる = tmux セッションも終了（確認ダイアログあり）
- アプリ終了 = detach のみ。tmux セッションは生き残り、再起動で同じタブ構成から再attach

## 開発

```sh
npm install
npm run rebuild   # node-pty を Electron ABI 向けにビルド
npm start
```

### macOS で rebuild が `'functional' file not found` で失敗する場合

Command Line Tools の toolchain 側 libc++ ヘッダが壊れているケース。SDK 側ヘッダを明示して回避:

```sh
export SDKROOT=$(xcrun --show-sdk-path)
export CXXFLAGS="-nostdinc++ -isystem $SDKROOT/usr/include/c++/v1"
npm run rebuild
```

## 使い方

- サイドバー「＋ グループ」でグループ作成（デフォルト名は今日の日付）
- グループヘッダの「＋」でタブ作成 → tmux セッションが起動
- ダブルクリックでタブ / グループをリネーム
- タブをドラッグ&ドロップで別グループへ移動
- グループヘッダクリックで折りたたみ

## ロードマップ

- v2: Claude Code statusline 連携（コンテキスト% / セッションID表示）、背景画像、猫アイコン
- v3: 内蔵 MCP サーバー（Claude からタブ整理・schedule_tab・外観変更）
