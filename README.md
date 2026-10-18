# ◆ Nelo Code

ターミナルで動く AI コーディングエージェント。自然言語の指示からコードベースを調査し、ファイルを編集し、コマンドを実行して、実際に手を動かします。

```
❯ 認証まわりのテストが落ちているので直して

● grep(auth in src)
  └ 12 matches
● read_file(src/auth/session.ts)
  └ 84 lines
● edit_file(src/auth/session.ts)
  └ 1 replacement
● run_command(npm test -- auth)
  └ exit 0 · 4.2s
```

## 特徴

- **フルスクリーン TUI** — スクロール可能な会話履歴、固定入力欄、ステータスバー、権限ダイアログ。全角文字の幅を考慮した折り返しとリサイズ対応。
- **エージェントループ** — Claude がツールを選び、結果を読み、次の手を打つ。複数ターンにわたる作業を自律的に進めます。
- **ストリーミング表示** — 応答はトークン単位で描画。ツール呼び出しは `● ツール名(引数)` 形式でコンパクトに表示。
- **6つの組み込みツール** — 読み取り・検索・編集・書き込み・一覧・シェル実行。
- **権限モード** — `ask` / `auto` / `readonly`。破壊的なコマンドは自動承認モードでもブロック。
- **コンテキスト自動圧縮** — 会話が長くなると古い履歴を要約し、長時間の作業を継続。
- **セッション保存・再開** — プロジェクトごとに履歴を保存し、`-c` や `/resume` で続きから再開。
- **ワークスペース境界** — ファイルツールは作業ディレクトリの外に出られません（設定で解除可能）。
- **最小依存** — 実行時依存は `@anthropic-ai/sdk` のみ。TUI も ANSI と Node 標準 API だけで実装。

## 必要要件

- Node.js 18.17 以上
- Anthropic API キー

## インストール

```bash
npm install
npm run build
npm link        # 任意: nelo コマンドを PATH に追加
```

`npm link` を使わない場合は `node bin/nelo.js` で起動できます。

## クイックスタート

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
nelo                                  # 対話モード
nelo "このリポジトリの構成を説明して"   # ワンショット
nelo -p "テストを直して" -y            # 非対話 + ツール自動承認
```

PowerShell の場合:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
nelo
```

## 使い方

### 対話モード（TUI）

TTY 上ではフルスクリーン TUI が起動します。

```
◆ Nelo Code v0.2.0                               claude-sonnet-5-5 · ask · my-project
────────────────────────────────────────────────────────────────────────────────────
❯ 認証まわりのテストが落ちているので直して

このテストはセッションの有効期限を固定値で比較しているため、時間帯によって
失敗します。モッククロックを使うように修正します。

● read_file(src/auth/session.test.ts)
  └ 84 lines
● edit_file(src/auth/session.test.ts)
  └ 1 replacement
────────────────────────────────────────────────────────────────────────────────────
❯ Ask Nelo Code to do something…
Ready                                                          12.3k in / 678 out
```

| キー | 動作 |
| --- | --- |
| `Enter` | 送信（実行中なら次のメッセージとしてキュー） |
| `↑` / `↓` | 入力履歴 |
| `←` / `→` / `Home` / `End` | カーソル移動 |
| `Ctrl+A` / `Ctrl+E` | 行頭 / 行末へ |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | 行頭まで削除 / 行末まで削除 / 単語削除 |
| `Tab` | スラッシュコマンドの補完 |
| `PgUp` / `PgDn` | 会話履歴をページスクロール |
| `Shift+↑` / `Shift+↓` | 1行スクロール |
| `Ctrl+Home` / `Ctrl+End` | 履歴の先頭 / 末尾へ |
| `Ctrl+C` 1回 | 実行中のエージェントを中断（入力中なら入力をクリア） |
| `Ctrl+C` 2回 | 終了 |
| `Ctrl+D` | 入力が空のときに終了 |

- 権限確認は会話領域の下部にダイアログとして表示されます。`y` = 許可、`n` / `Enter` / `Esc` = 拒否、`a` = このセッション中は常に許可。
- 実行中も入力欄は編集でき、送信した内容は次のターンで処理されます。
- TUI を使わない場合は `--no-tui` を指定すると従来のライン REPL で起動します（非 TTY では自動的にこちらになります）。

#### スラッシュコマンド

| コマンド | 説明 |
| --- | --- |
| `/help` | コマンド一覧 |
| `/clear` | 会話をリセットして新しいセッションを開始 |
| `/compact` | 古いメッセージを今すぐ要約 |
| `/model [name]` | モデルの表示・変更（エイリアス: `opus` `sonnet` `haiku` `fable`） |
| `/permissions [mode]` | 権限モードの表示・変更（`ask` / `auto` / `readonly`） |
| `/usage` | セッションのトークン使用量 |
| `/status` | セッション ID・モデル・コンテキスト推定値 |
| `/tools` | 利用可能なツール一覧 |
| `/sessions` | このプロジェクトの保存済みセッション一覧 |
| `/resume <id>` | 指定セッションを再開 |
| `/exit` | 終了 |
| `!<command>` | シェルコマンドを直接実行（例: `!git status`） |

### ワンショットモード

プロンプトを引数に渡すと、1回の実行で終了します。`-p` を付けると標準入力からプロンプトを読めます。

```bash
nelo "src/agent.ts の設計をレビューして"
git diff | nelo -p "この差分をレビューして"
```

標準出力にはモデルの応答だけが流れ、ツールの実行状況は標準エラー出力に出ます。パイプやスクリプトに組み込みやすい設計です。

> 非対話モードでは権限確認ができないため、書き込み系ツールは既定で拒否されます。許可する場合は `-y`、読み取り専用に限定する場合は `--readonly` を指定してください。

### セッション

セッションは `~/.nelo/projects/<project>-<hash>/sessions/` に JSON で保存されます。

```bash
nelo -c                 # このプロジェクトの最新セッションを再開
nelo -r 20261018142557-jse3 "続きをやって"
```

対話モードでは `/sessions` で一覧、`/resume <id>` で切り替えられます。

## CLI リファレンス

```
nelo [options] [prompt]
nelo config
```

| オプション | 説明 |
| --- | --- |
| `-m, --model <name>` | モデル ID またはエイリアス（`opus` / `sonnet` / `haiku` / `fable`） |
| `-y, --yes` | すべてのツール呼び出しを自動承認（`auto` モード） |
| `--readonly` | 読み取り専用モード |
| `--mode <mode>` | `ask` / `auto` / `readonly` |
| `--no-tui` | フルスクリーン TUI を使わず、ライン REPL で起動 |
| `--max-tokens <n>` | 1応答あたりの最大出力トークン数 |
| `-c, --continue` | 最新セッションを再開 |
| `-r, --resume <id>` | 指定セッションを再開 |
| `-p, --print` | 非対話モード（プロンプト必須） |
| `-h, --help` | ヘルプ |
| `-V, --version` | バージョン |
| `config` | 有効な設定の表示 |

## ツール

| ツール | 読み取り専用 | 説明 |
| --- | --- | --- |
| `read_file` | ✓ | 行番号付きでファイルを読む。`offset` / `limit` でページング |
| `list_files` | ✓ | ディレクトリ一覧。再帰・深さ・件数指定 |
| `grep` | ✓ | 正規表現検索。glob フィルタ、ファイル名のみの出力モード |
| `edit_file` |  | 一意な文字列置換。`replace_all` 対応、CRLF を保持 |
| `write_file` |  | ファイル全体を書き込み（親ディレクトリ自動作成） |
| `run_command` |  | シェルコマンド実行。タイムアウト・中断・出力切り詰め対応 |

ファイル系ツールはワークスペース外へのパスを拒否します。`run_command` の作業ディレクトリもワークスペースです（コマンド内で `cd` する操作は権限チェックの対象になります）。

## 権限モード

| モード | 読み取り | 書き込み・コマンド |
| --- | --- | --- |
| `ask`（既定） | 自動許可 | 毎回 `y / n / a` を確認 |
| `auto`（`-y`） | 自動許可 | 自動許可（危険コマンドを除く） |
| `readonly` | 自動許可 | 拒否 |

- `a`（always）を選ぶと、そのセッション中は同じスコープを再確認しません。`run_command` のスコープはコマンドの先頭トークン（例: `npm`）です。
- `permissions.allow` にツール名を列挙すると、`ask` モードでも無確認で許可されます。
- `permissions.denyCommands` に正規表現を列挙すると、一致するコマンドを拒否できます。
- 以下は **どのモードでも** ブロックされます: ルート/ホームへの `rm -rf`、`mkfs`、デバイスへの `dd`、`shutdown` / `reboot`、フォークボム、ドライブの `format`、システムディレクトリの削除。

> `auto` モードは便利ですが、モデルの判断でファイルが変更されます。信頼できるタスクとワークスペースでのみ使用してください。

## 設定

設定は次の順で上書きされます（後のものが優先）:

1. 組み込みの既定値
2. `~/.nelo/config.json`（グローバル）
3. `./.nelo/config.json`（プロジェクト）
4. 環境変数
5. CLI フラグ

`nelo config` で有効な設定と読み込み元を確認できます。

### 設定ファイルの例

```json
{
  "model": "claude-sonnet-5-5",
  "maxTokens": 8192,
  "maxTurns": 40,
  "permissions": {
    "mode": "ask",
    "allow": [],
    "denyCommands": ["\\bcurl\\b"]
  },
  "context": {
    "maxTokens": 200000,
    "compactAt": 0.8
  },
  "workspace": {
    "allowOutside": false
  }
}
```

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `model` | `claude-sonnet-5-5` | 使用モデル（エイリアス可） |
| `maxTokens` | `8192` | 1応答あたりの最大出力トークン数 |
| `maxTurns` | `40` | 1リクエスト内の最大ツールターン数 |
| `apiKey` | — | API キー（環境変数を推奨） |
| `baseURL` | — | API ベース URL |
| `permissions.mode` | `ask` | 権限モード |
| `permissions.allow` | `[]` | 無確認で許可するツール名 |
| `permissions.denyCommands` | `[]` | 拒否するコマンドの正規表現 |
| `context.maxTokens` | `200000` | コンテキストウィンドウの想定値 |
| `context.compactAt` | `0.8` | 自動圧縮を始める使用率 |
| `workspace.allowOutside` | `false` | ワークスペース外アクセスの許可 |

### 環境変数

| 変数 | 説明 |
| --- | --- |
| `ANTHROPIC_API_KEY` | API キー（必須） |
| `ANTHROPIC_BASE_URL` | API ベース URL（プロキシ・モック用） |
| `NELO_MODEL` | 既定モデル |
| `NELO_MAX_TOKENS` | 最大出力トークン数 |
| `NELO_MAX_TURNS` | 最大ツールターン数 |
| `NELO_PERMISSION_MODE` | `ask` / `auto` / `readonly` |
| `NELO_SHELL` | `run_command` が使うシェル（POSIX 互換） |
| `NO_COLOR` | 色出力を無効化 |

### プロジェクト指示ファイル

ワークスペース直下に `NELO.md`、`CLAUDE.md`、`AGENTS.md` のいずれかがあると、システムプロンプトに自動で取り込まれます。コーディング規約やテスト手順の記述に使えます。

## アーキテクチャ

```
┌──────────────────────────────────────────────────┐
│ index.ts             CLI エントリ / 引数処理       │
│  ├─ cli-args.ts                                   │
│  ├─ ui/tui/*         フルスクリーン TUI            │
│  └─ repl.ts          ライン REPL（--no-tui 用）    │
├──────────────────────────────────────────────────┤
│ commands.ts          スラッシュコマンド / ! 実行    │
├──────────────────────────────────────────────────┤
│ app.ts               依存の組み立て                 │
│  ├─ agent.ts         エージェントループ              │
│  │   ├─ client.ts    Anthropic ストリーミング        │
│  │   ├─ permissions.ts  権限判定                    │
│  │   ├─ compaction.ts   履歴の要約                  │
│  │   └─ tools/*       ツール実装                    │
│  ├─ session.ts       セッション永続化                │
│  ├─ prompt.ts        システムプロンプト              │
│  └─ ui/*             端末描画・入力                  │
└──────────────────────────────────────────────────┘
```

主要モジュール:

| ファイル | 役割 |
| --- | --- |
| `src/agent.ts` | モデル呼び出し → ツール実行 → 結果返却のループ、使用量集計、自動圧縮 |
| `src/client.ts` | `ModelClient` 抽象と Anthropic SDK 実装（テストでは差し替え可能） |
| `src/commands.ts` | `/help` などのスラッシュコマンドと `!command` 実行。TUI / REPL で共有 |
| `src/permissions.ts` | モード・許可リスト・拒否パターン・セッション内記憶 |
| `src/compaction.ts` | 安全な切断点で履歴を要約し、直近ターンを保持 |
| `src/session.ts` | `~/.nelo/projects/...` へのアトミック保存と読み込み |
| `src/tools/*` | 各ツールのスキーマと実装。パス境界・出力上限を適用 |
| `src/ui/ui.ts` | `UI` インターフェースとライン REPL 用 `TerminalUI` |
| `src/ui/tui/*` | 代替画面バッファ、トランスクリプト、入力エディタ、全角対応の幅計算・折り返し、権限モーダル |

### コンテキスト管理

- 送信前にメッセージ・システムプロンプト・ツール定義からトークン量を推定します。
- `context.maxTokens × compactAt` を超えると、古いメッセージをモデルで要約し、直近6件だけを残します。
- 要約はツール呼び出しとツール結果の対応を壊さない位置で切ります。
- 要約は不可逆です。細部が必要な場合は `/clear` で新規セッションを始める方が確実です。

## 開発

```bash
npm install
npm run build        # tsc -> dist/
npm run dev          # tsx で src/index.ts を直接実行
npm test             # vitest（ユニットテスト）
npm run typecheck    # 型チェックのみ
npm run test:e2e     # ビルド + モック API に対する E2E
```

### モック API

API キーなしでエージェントループを試せます。モックは最初のリクエストで `read_file`（プロンプトに `write-demo` を含めると `write_file`）を呼び、ツール結果を受け取ると最終応答を返します。

```bash
npm run mock
# 別ターミナルで:
ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:8787 node bin/nelo.js "hello"
```

### ディレクトリ構成

```
bin/nelo.js          実行ランチャー
src/                 本体（TypeScript, ESM）
tests/               vitest テスト
scripts/mock-server.mjs  Anthropic Messages API モック
scripts/e2e.mjs      E2E スモークテスト
```

## 既知の制限

- 入力は1行ずつです（複数行エディタは未実装）。複数行の貼り付けは改行ごとに送信されるため、1行に整形してから貼り付けてください。
- TUI は TTY が必要です。パイプやリダイレクトでは自動的にライン REPL / 非対話モードになります。
- マウスホイールによるスクロールには未対応です（`PgUp` / `PgDn` / `Shift+↑↓` を使用）。
- 画像・PDF の入力には対応していません。
- MCP サーバやカスタムツールの追加機構はまだありません。
- コンパクションは要約による不可逆な圧縮です。
- コストはトークン数でのみ表示し、金額換算はしません。
- Windows では Git Bash が見つかればそれを使い、なければ `cmd.exe` にフォールバックします（シェル構文の互換性に注意）。

## ロードマップ

- 差分プレビュー付きの編集承認
- 複数行入力とブラケットペースト対応
- マウスホイールによる履歴スクロール
- MCP クライアントとカスタムツール定義
- フック（ツール実行前後のユーザー定義コマンド）
- プランモード / 読み取り専用の調査モード
- トークン単価に基づくコスト表示
- サブエージェントによる並列調査

## ライセンス

MIT
