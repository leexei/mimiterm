# MimiTerm 🐈‍⬛

Claude Code ネイティブなターミナル。タブを日付グループで整理し、各タブのClaudeの状態（考え中/応答待ち/コンテキスト%）を可視化する。内蔵MCPサーバー経由で、Claude自身がタブ整理・スケジュール・外観・ブラウザペインの操作を行える（**ターミナルへコマンドを投入するMCPツールは持たない**。後述のセキュリティ節を参照）。セッションの実体はtmuxが保持するため、アプリを再起動しても消えない。

> **このREADMEはAI（Claude Code）に読ませてセットアップさせる前提で書かれています。**
> 手元のClaude Codeに「このリポジトリのREADMEに従ってMimiTermをセットアップして」と依頼してください。

## 主な機能

- **タブ×グループ管理**: 日付等のグループに折りたたみ・D&D移動/並び替え。状態は `~/.mimiterm/state.json` に永続化
- **tmuxバックエンド**: 1タブ=1 tmuxセッション。アプリ終了はdetachのみで、プロセスは生き続ける
- **Claude状態の可視化**: タブ毎に ✳考え中（4信号検出） / 📋plan停止 / ●応答待ち / ⚙他プロセス実行中、コンテキスト%バッジ、⏳再開予定日
- **アカウント状態**: サイドバー下部に5h/7日レート制限バー（リセットまでの残り時間つき）
- **今日パネル**: 今日の予定と空き時間、再開予定日が来たタブを表示。`calendarCommand` の実行結果を取得できた時、または再開予定日（`schedule_tab`）が来たタブがある時に表示される。空き時間は 09:00〜18:00 の窓（現在時刻以降）を基準に算出（現状は固定値）
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
git clone https://github.com/leexei/mimiterm.git && cd mimiterm
scripts/setup.sh all        # 依存確認 → ビルド → /Applications へ配置 → statusline設定
open /Applications/MimiTerm.app
scripts/setup.sh mcp        # アプリ初回起動後にMCP登録（トークンが生成されてから）
```

**クローンしたディレクトリはセットアップ後もそのまま残してください。** statusline設定がこのディレクトリ内のスクリプトを絶対パスで参照します（移動・削除するとstatuslineが壊れます）。移動した場合は `~/.claude/settings.json` の `statusLine.command` のパスを手で新しい場所に直してください。

各ステップの内容（個別実行可: `deps` / `build` / `app` / `statusline` / `mcp`）:

| ステップ | やること | 副作用・変更されるもの |
|---------|---------|----------------------|
| deps | brew/node/claude確認 | tmuxがなければインストール |
| build | npm install + node-ptyのElectron向けrebuild（CLT破損時はSDK直指定で自動リトライ） | なし |
| app | パッケージして `/Applications/MimiTerm.app` へ | 既存MimiTerm.appを上書き（**実行中の場合は先に終了すること**） |
| statusline | `~/.claude/settings.json` のstatusLineをtapに変更 | 変更内容: (1) 初回のみ `settings.json.mimiterm-backup` を作成 (2) 既存statuslineがあればチェーン先（`~/.mimiterm/statusline-chain.sh`）に退避して表示を維持 (3) statusLine.commandをtapに書き換え |
| mcp | `claude mcp add --scope user` でMimiTerm MCPを登録 | user scopeのMCP設定に `mimiterm` が追加される |

セットアップ後、AIはユーザーに以下を伝えること:
- Gatekeeperに「開発元を確認できない」と言われたら: 右クリック→開く、または `xattr -dr com.apple.quarantine /Applications/MimiTerm.app`
- MCPは新しいセッション（または `/mcp` 再接続）から有効
- statusline経由の情報のため、タブのコンテキスト%はそのタブ内でClaudeが1回以上応答してから表示される

## 設定（`~/.mimiterm/state.json` の `settings`）

すべて任意。**アプリを終了してから**編集すること（起動中に編集すると上書きされる）。

| キー | 型 | 既定 | 説明 |
|-----|-----|------|------|
| `claudeModel` | string | 未設定（注入なし） | 設定時、タブのシェルに `ANTHROPIC_MODEL=<値>` を注入。**組織のモデルポリシーがある場合は自組織のルールを確認の上、自己判断で設定すること** |
| `calendarCommand` | string | 未設定（カレンダー取得なし） | 「今日の予定」を後述フォーマットで出力するコマンド。例（実機検証済み）: `icalBuddy -ic "カレンダー名" -nc -nrd -iep "title,datetime" -po "datetime,title" -df "%Y-%m-%d" -tf "%H:%M" eventsToday` |
| `autoTrustImports` | bool | false | セッションインポート時にそのディレクトリのClaude trustダイアログを事前承認する。**有効時は `~/.claude.json` を書き換える** |
| `background` / `backgroundOpacity` | string / number | 未設定 / 0.25 | ターミナル背景画像とその見え具合。MCPの `set_background` で設定される |
| `quickCommandsByMode` | object | 未設定（組込みセットを使用） | クイックコマンド（UI上で編集可能なので直接編集は不要） |
| `browser.bookmarks` | array | 未設定（空として扱う） | ブックマーク（UI/MCPで編集可能） |

### カレンダー出力の必須フォーマット

`calendarCommand` の出力は以下の形式に従う必要があります（[icalBuddy](https://hasseg.org/icalBuddy/) に `-po "datetime,title"` を指定した時の出力形式。**icalBuddyの既定はタイトルが先に出るため、`-po` 指定が必須**）:

```
• 09:00 - 10:00
    予定タイトル
```

- 行頭は `• `（黒丸+半角スペース）
- 時刻は `HH:MM - HH:MM`（2桁ゼロ埋め。`9:00` は時刻として解釈されず終日予定扱いになる）
- タイトルは**次行にインデントして**記載
- 終日予定（時刻行のないもの）はパネルの件数・空き時間計算に含まれない
- `state.json` はJSONのため、コマンド内の `"` は `\"` にエスケープして記載すること

権限まわりの注意: MimiTermはカレンダーコマンドを**tmuxサーバー経由**で実行する（未署名アプリはビルドごとにmacOSのカレンダー権限がリセットされるため）。初回はターミナルからそのコマンドを直接一度実行し、カレンダーアクセスを許可しておくこと。

## MCPツール一覧（Claudeから使える操作）

- タブ系: `list_tabs`（dueToday/contextPct等付き） / `rename_tab` / `create_group` / `move_tab_to_group` / `collapse_group` / `set_tab_badge` / `schedule_tab` / `set_background`
- ブラウザ系: `browser_navigate` / `browser_get_page` / `browser_get_selection` / `browser_get_styles`（セルの計算済み背景色） / `browser_click` / `browser_type` / `browser_screenshot` / `bookmark_list` / `bookmark_add` / `bookmark_remove`

## セキュリティに関する注意

- MCPサーバーは `127.0.0.1` のみにバインドし、Bearerトークン（`~/.mimiterm/mcp.json`、パーミッション600、定数時間比較）で認証する。ブラウザ由来のクロスオリジン要求（DNSリバインディング）は拒否する。トークンを共有・コミットしないこと
- MCPには**任意コマンド実行ツールもターミナルへの入力ツールも意図的に存在しない**。Claudeが操作できるのはタブ整理・スケジュール・外観・ブラウザペインのみ
- 埋め込みブラウザはSSOセッションを専用プロファイルに保持する。`browser_click` / `browser_type` を**SSO/MFA等の認証承認画面に使わないこと**（各ツールの説明文にも明記済み）。認証の承認は必ず人間が行う
- `claudeModel` / `autoTrustImports` は既定OFF。有効化は各自の判断と責任で

## 開発

```sh
npm start            # 開発起動（アプリ名がElectronになるのは仕様）
npm run deploy       # パッケージ + /Applications へ反映（MimiTerm.app実行中は先に終了）
```

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| rebuildで `'functional' file not found` | CLTのlibc++破損。`setup.sh build` が自動でSDK直指定リトライする |
| タブのコンテキスト%が出ない | statuslineステップ実施済みか確認。タブ内でclaudeが1回以上応答してから表示される |
| 今日パネルが出ない | `calendarCommand` 未設定かつ再開予定日タブ無しなら仕様。`calendarCommand` 設定済みなら `~/.mimiterm/calendar-debug.log` を確認 |
| ブラウザでSSOが弾かれる | Chrome相当UAを名乗る対策済み。デバイス準拠ポリシー必須の環境では不可 |
| タブを閉じてもtmuxセッションが残った | `tmux kill-session -t <mimi-...>` で手動削除 |

## アンインストール

以下の順で実施してください（リポジトリ削除より先にstatusLineを戻すこと）:

```sh
# 1. statusLine設定を元に戻す（バックアップから statusLine の項を復元するか、項ごと削除）
#    バックアップ: ~/.claude/settings.json.mimiterm-backup
# 2. MCP登録を解除
claude mcp remove --scope user mimiterm
# 3. アプリと設定を削除
rm -rf /Applications/MimiTerm.app ~/.mimiterm
# 4. MimiTermのtmuxセッションを終了（mimi-* のみを対象にする。
#    tmux kill-server はMimiTerm以外のtmuxセッションも全て終了させるため使わないこと）
tmux ls -F '#{session_name}' | grep '^mimi-' | while read -r s; do tmux kill-session -t "$s"; done
# 5. クローンしたリポジトリを削除
```
