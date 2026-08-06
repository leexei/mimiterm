# MimiTerm 🐈‍⬛

Claude Code ネイティブなターミナル。タブを日付グループで整理し、各タブのClaudeの状態（考え中/応答待ち/コンテキスト%）を可視化し、内蔵MCPサーバー経由でClaude自身がターミナルを操作できる。セッションの実体はtmuxが保持するため、アプリを再起動しても消えない。

> **このREADMEはAI（Claude Code）に読ませてセットアップさせる前提で書かれています。**
> 手元のClaude Codeに「このリポジトリのREADMEに従ってMimiTermをセットアップして」と依頼してください。

## 主な機能

- **タブ×グループ管理**: 日付等のグループに折りたたみ・D&D移動/並び替え。状態は `~/.mimiterm/state.json` に永続化
- **tmuxバックエンド**: 1タブ=1 tmuxセッション。アプリ終了はdetachのみで、プロセスは生き続ける
- **Claude状態の可視化**: タブ毎に ✳考え中(4信号検出) / 📋plan停止 / ●応答待ち / ⚙他プロセス実行中、コンテキスト%バッジ、⏳再開予定日
- **アカウント状態**: サイドバー下部に5h/7日レート制限バー（リセットまでの残り時間つき）
- **今日パネル**: カレンダーコマンド設定時、今日の予定と空き時間、期日が来たタブを表示
- **クイックコマンドバー**: ワンクリックでコマンド注入。Claude実行中/シェルでセット自動切替
- **セッションインポート**: 過去のClaude Codeセッションを選んで `claude --resume` 付きタブを生成
- **埋め込みブラウザ**: SSOセッション永続のブラウザペイン。選択テキストをClaude入力欄へ引用注入
- **内蔵MCPサーバー（18ツール）**: タブ整理・スケジュール・外観・ブラウザの読取/クリック/入力/ブックマークをClaudeから操作可能

## 前提条件

- macOS (Apple Silicon)
- Homebrew / Node.js v20+ / Claude Code CLI
- tmux（なければセットアップスクリプトが導入）

## セットアップ手順（AI向け）

```sh
git clone <このリポジトリ> && cd mimiterm
scripts/setup.sh all        # 依存確認 → ビルド → /Applications へ配置 → statusline設定
open /Applications/MimiTerm.app
scripts/setup.sh mcp        # アプリ初回起動後にMCP登録（トークンが生成されてから）
```

各ステップの内容（個別実行可: `deps` / `build` / `app` / `statusline` / `mcp`）:

| ステップ | やること | ユーザーへの影響 |
|---------|---------|----------------|
| deps | brew/node/claude確認、tmux導入 | tmuxがなければインストール |
| build | npm install + node-ptyのElectron向けrebuild（CLT破損時はSDK直指定で自動リトライ） | なし |
| app | パッケージして `/Applications/MimiTerm.app` へ | 既存MimiTerm.appを上書き |
| statusline | `~/.claude/settings.json` のstatusLineをtapに変更。**既存statuslineは自動でチェーン先に退避され、表示は維持される**（バックアップも作成） | statusline経由でタブにコンテキスト%が出るようになる |
| mcp | `claude mcp add --scope user` でMimiTerm MCPを登録 | 全Claude Codeセッションからmimitermツールが使える |

セットアップ後、AIはユーザーに以下を伝えること:
- Gatekeeperに「開発元を確認できない」と言われたら: 右クリック→開く、または `xattr -dr com.apple.quarantine /Applications/MimiTerm.app`
- MCPは新しいセッション（または `/mcp` 再接続）から有効

## 設定（`~/.mimiterm/state.json` の `settings`）

すべて任意。**アプリを終了してから**編集すること（起動中に編集すると上書きされる）。

| キー | 型 | 既定 | 説明 |
|-----|-----|------|------|
| `claudeModel` | string | なし | 設定時、タブのシェルに `ANTHROPIC_MODEL=<値>` を注入。**組織のモデルポリシーがある場合は自組織のルールを確認の上、自己判断で設定すること** |
| `calendarCommand` | string | なし | 「今日の予定」をicalBuddy風テキストで出力するコマンド。設定時のみ今日パネルが表示される。例: `/bin/bash ~/scripts/calendar-helper.sh today` |
| `autoTrustImports` | bool | false | セッションインポート時にそのディレクトリのClaude trustダイアログを事前承認する |
| `quickCommandsByMode` | object | 組込み | クイックコマンド（UI上で編集可能なので直接編集は不要） |
| `browser.bookmarks` | array | [] | ブックマーク（UI/MCPで編集可能） |

### カレンダー出力の期待フォーマット

```
• 09:00 - 10:00
    予定タイトル
```
`icalBuddy -ic <カレンダー名> -df "%Y-%m-%d" -tf "%H:%M" eventsToday` 相当の出力なら何でもよい。
権限まわりの注意: MimiTermはカレンダーコマンドを**tmuxサーバー経由**で実行する（未署名アプリはビルドごとにmacOSのカレンダー権限がリセットされるため）。初回はターミナルからそのコマンドを直接一度実行し、カレンダーアクセスを許可しておくこと。

## MCPツール一覧（Claudeから使える操作）

- タブ系: `list_tabs`（dueToday/contextPct等付き） / `rename_tab` / `create_group` / `move_tab_to_group` / `collapse_group` / `set_tab_badge` / `schedule_tab` / `set_background`
- ブラウザ系: `browser_navigate` / `browser_get_page` / `browser_get_selection` / `browser_get_styles`（セルの計算済み背景色） / `browser_click` / `browser_type` / `browser_screenshot` / `bookmark_list` / `bookmark_add` / `bookmark_remove`

## セキュリティに関する注意

- MCPサーバーは `127.0.0.1` のみにバインドし、Bearerトークン（`~/.mimiterm/mcp.json`、パーミッション600）で認証する。トークンを共有・コミットしないこと
- MCPには任意コマンド実行ツールは**意図的に存在しない**。タブ整理・外観・ブラウザ操作のみ
- 埋め込みブラウザはSSOセッションを専用プロファイルに保持する。`browser_click` / `browser_type` を**SSO/MFA等の認証承認画面に使わないこと**（ツール説明にも明記済み）。認証の承認は必ず人間が行う
- `claudeModel` / `autoTrustImports` は既定OFF。有効化は各自の判断と責任で

## 開発

```sh
npm start            # 開発起動（アプリ名がElectronになるのは仕様）
npm run deploy       # パッケージ + /Applications へ反映
```

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| rebuildで `'functional' file not found` | CLTのlibc++破損。`setup.sh build` が自動でSDK直指定リトライする |
| タブのコンテキスト%が出ない | statuslineステップ実施済みか確認。タブ内でclaudeが1回以上応答してから表示される |
| 今日パネルが出ない | `calendarCommand` 未設定なら仕様。設定済みなら `~/.mimiterm/calendar-debug.log` を確認 |
| ブラウザでSSOが弾かれる | Chrome相当UAを名乗る対策済み。デバイス準拠ポリシー必須の環境では不可 |
| タブを閉じてもtmuxセッションが残った | `tmux kill-session -t <mimi-...>` で手動削除 |

## アンインストール

```sh
rm -rf /Applications/MimiTerm.app ~/.mimiterm
claude mcp remove --scope user mimiterm
# ~/.claude/settings.json の statusLine を settings.json.mimiterm-backup の内容に戻す
tmux kill-server   # mimi-* セッションを全て終了してよい場合のみ
```
