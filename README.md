# ◆ Nelo Code

ターミナルで動く AI コーディングエージェント。**ローカル AI ファースト** — Ollama や LM Studio の手元のモデルで、クラウドと同じ体験ができます。自然言語の指示からコードベースを調査し、ファイルを編集し、コマンドを実行して、実際に手を動かします。

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

- **ローカル AI ファースト** — `ollama serve` を立てるだけで動く。API キーもネットワークも不要。モデル名とコンテキスト長はサーバーから自動検出。
- **ひとつの抽象で 9 プロバイダ** — Ollama / LM Studio / OmniRoute / llama.cpp / vLLM / Anthropic / OpenAI / OpenRouter / 任意の OpenAI 互換。`--provider` ひとつで切り替え、`/provider` で会話を保ったまま乗り換え。
- **PC リソースのリアルタイム表示** — CPU・メモリ・GPU（nvidia-smi）・Ollama の VRAM 使用量をステータスバーに常時表示。`/resources` で詳細。
- **テーマとアドオン** — 見た目はすべてテーマトークン経由。JSON を数行書くだけで配色・記号・レイアウトを差し替えられる。`/theme reload` で即反映。
- **フルスクリーン TUI** — スクロール可能な会話履歴、固定入力欄、権限ダイアログ。全角文字の幅を考慮した折り返しとリサイズ対応。
- **エージェントループ** — モデルがツールを選び、結果を読み、次の手を打つ。ターン上限・中断・反復制御つき。
- **弱いツール呼び出しを補う** — `tool_calls` をネイティブに返さないモデルでも、テキストで書かれた呼び出しを解釈して実行。壊れた JSON は修復。
- **6つの組み込みツール** — 読み取り・検索・編集・書き込み・一覧・シェル実行。
- **権限モード** — `ask` / `auto` / `readonly`。破壊的なコマンドは自動承認モードでもブロック。
- **コンテキスト自動圧縮・セッション保存・ワークスペース境界** — 長時間作業のための基本装備。
- **最小依存** — 実行時依存は `@anthropic-ai/sdk` のみ。ローカル接続は `fetch`、TUI は ANSI と Node 標準 API だけ。

## 必要要件

- Node.js 18.17 以上
- ローカルで使う場合: [Ollama](https://ollama.com) / LM Studio / llama.cpp / vLLM のいずれか
- クラウドで使う場合: 各プロバイダの API キー

## インストール

```bash
npm install
npm run build
npm link        # 任意: nelo コマンドを PATH に追加
```

## クイックスタート（ローカル）

```bash
ollama serve                 # 別ターミナルで
ollama pull qwen2.5-coder:7b

nelo                         # プロバイダを自動検出して起動
nelo "このリポジトリの構成を説明して"
nelo -p "テストを直して" -y   # 非対話 + ツール自動承認
```

`nelo` は起動時に localhost のモデルサーバーを探します（Ollama → LM Studio → OmniRoute → llama.cpp → vLLM の順）。見つからなければ、API キーが設定されているクラウドプロバイダにフォールバックします。

プロバイダが見つからなくても起動は成功します。`not connected` のまま TUI が開き、メッセージを送ろうとした時点で接続方法を案内します。後から `ollama serve` を起動した場合は `/provider ollama`（再検出は `/provider auto`）で、会話を保ったまま接続できます。

```bash
nelo providers               # 利用できるテンプレート一覧
nelo --provider lmstudio     # 明示指定
nelo --provider ollama -m llama3.2:3b
```

## プロバイダ

| ID | 種類 | 既定エンドポイント | キー | 備考 |
| --- | --- | --- | --- | --- |
| `ollama` | ローカル | `http://127.0.0.1:11434/v1` | 不要 | `/api/ps` で VRAM、`/api/show` でコンテキスト長を取得 |
| `lmstudio` | ローカル | `http://127.0.0.1:1234/v1` | 不要 | ロード済みモデルを自動検出 |
| `omniroute` | ローカル | `http://127.0.0.1:20128/v1` | 任意 | セルフホストの AI ゲートウェイ。`model: "auto"` でキー不要 |
| `llamacpp` | ローカル | `http://127.0.0.1:8080/v1` | 不要 | `/props` から `n_ctx` を取得 |
| `vllm` | ローカル | `http://127.0.0.1:8000/v1` | 不要 | モデル名は `-m` で指定 |
| `anthropic` | クラウド | SDK 既定 | `ANTHROPIC_API_KEY` | Claude |
| `openai` | クラウド | `https://api.openai.com/v1` | `OPENAI_API_KEY` | ChatGPT |
| `openrouter` | クラウド | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | 集約。`anthropic/claude-sonnet-4.5` 形式 |
| `custom` | 任意 | `--base-url` 必須 | 任意 | OpenAI 互換ならなんでも |

- `--provider auto`（既定）はローカルを優先します。
- モデルとコンテキスト長は、ユーザーが明示していない場合だけプロバイダの値で埋まります（設定ファイルの値は尊重されます）。
- 会話中に `/provider ollama` で乗り換えても履歴は保持されます。

### OmniRoute テンプレート

`npm i -g omniroute` で起動するゲートウェイをそのまま使えます。

```bash
omniroute                    # http://localhost:20128
nelo --provider omniroute    # model: "auto" でキー不要
nelo --provider omniroute -m anthropic/claude-sonnet-4.5
```

認証を有効にしている場合は `OMNIROUTE_API_KEY` を設定してください。

## 使い方

### 対話モード（TUI）

TTY 上ではフルスクリーン TUI が起動します。

```
◆ Nelo Code v0.2.0                        qwen2.5-coder:7b · ask · my-project
────────────────────────────────────────────────────────────────────────────
❯ 認証まわりのテストが落ちているので直して

このテストはセッションの有効期限を固定値で比較しているため、時間帯によって
失敗します。モッククロックを使うように修正します。

▸ read_file  src/auth/session.test.ts
  ╰ 84 lines
▸ edit_file  src/auth/session.test.ts
  ╰ 1 replacement
────────────────────────────────────────────────────────────────────────────
╭──────────────────────────────────────────────────────────────────────────╮
│ ❯ Ask Nelo Code to do something…                                         │
╰──────────────────────────────────────────────────────────────────────────╯
 ● Ready             CPU 18% · RAM 12.4G/31.9G · GPU 64% 7.1G/8.0G   12.3k in / 678 out
```

| キー | 動作 |
| --- | --- |
| `Enter` | 送信（実行中なら次のメッセージとしてキュー） |
| `↑` / `↓` | 入力履歴（コマンド候補の表示中は候補選択） |
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
- `/` を入力するとコマンド候補が開きます。`↑` / `↓` で選択、`Tab` で補完、`Enter` で実行、`Esc` で閉じます。
- `/` コマンドは入力履歴に残りません（通常のプロンプトのみ `↑` / `↓` で呼び出せます）。
- 実行中も入力欄は編集でき、送信した内容は次のターンで処理されます。
- `--no-tui` で従来のライン REPL（非 TTY では自動的にこちら）。

#### スラッシュコマンド

| コマンド | 説明 |
| --- | --- |
| `/help` | コマンド一覧 |
| `/clear` | 会話をリセットして新しいセッションを開始 |
| `/compact` | 古いメッセージを今すぐ要約 |
| `/model [name]` | モデルの表示・変更（エイリアス: `opus` `sonnet` `haiku` `fable`） |
| `/provider [id]` | プロバイダの表示・切り替え（`auto` で再検出） |
| `/providers` | プロバイダテンプレート一覧 |
| `/permissions [mode]` | 権限モードの表示・変更（`ask` / `auto` / `readonly`） |
| `/theme [name\|reload]` | テーマの表示・切り替え・再読み込み |
| `/themes` | 組み込みテーマとアドオンの一覧 |
| `/addons` | アドオンの探索パスと読み込み結果 |
| `/resources` | CPU / メモリ / GPU / VRAM の詳細 |
| `/usage` | セッションのトークン使用量 |
| `/status` | セッション ID・プロバイダ・モデル・コンテキスト推定値 |
| `/tools` | 利用可能なツール一覧 |
| `/sessions` | このプロジェクトの保存済みセッション一覧 |
| `/resume <id>` | 指定セッションを再開 |
| `/exit` | 終了 |
| `!<command>` | シェルコマンドを直接実行（例: `!git status`） |

### ワンショットモード

```bash
nelo "src/agent.ts の設計をレビューして"
git diff | nelo -p "この差分をレビューして"
```

標準出力にはモデルの応答だけが流れ、ツールの実行状況は標準エラー出力に出ます。

> 非対話モードでは権限確認ができないため、書き込み系ツールは既定で拒否されます。`-y` か `--readonly` を指定してください。

### セッション

`~/.nelo/projects/<project>-<hash>/sessions/` に JSON で保存されます。

```bash
nelo -c                 # このプロジェクトの最新セッションを再開
nelo -r 20261018142557-jse3 "続きをやって"
```

## リソースモニタ

ステータスバーに常時表示され、`/resources` で詳細が出ます。

- **CPU** — `os.cpus()` の差分から使用率を算出
- **メモリ** — 使用量 / 総量
- **GPU** — `nvidia-smi` から使用率と VRAM（NVIDIA のみ。未搭載なら非表示）
- **Ollama** — `/api/ps` からロード済みモデルと VRAM 割り当て

`nvidia-smi` は 1 秒ごとのポーリングでも負荷にならないよう、失敗時は 30 秒間再試行しません。無効化する場合:

```json
{ "ui": { "resources": false } }
```

## テーマとアドオン

見た目は「テーマトークン」で表現されます。アドオンは **JSON のみ**（機能追加はまだ対象外）。

```bash
nelo addon new my-theme     # ~/.nelo/addons/my-theme/addon.json を作成
nelo themes                 # 一覧
nelo                        # 起動して /theme my-theme
```

```json
{
  "name": "my-theme",
  "type": "theme",
  "apiVersion": 1,
  "extends": "nelo",
  "colors": { "accent": "#7aa2f7", "brand": "brightMagenta" },
  "glyphs": { "prompt": "λ", "tool": "▸" },
  "spinner": ["|", "/", "-", "\\"],
  "layout": { "statusBar": "plain", "separators": true, "hints": false },
  "markdown": { "heading": "accent", "code": "info" }
}
```

- `extends` で組み込みテーマ（`nelo` / `midnight` / `nord` / `mono` / `sakura`）を土台にできます。
- 既定の `nelo` はネオン紫×シアンのパレット、角丸の入力ボックス、ウェルカム画面を使います。
- 色は ANSI 名（`red` `brightCyan` `gray` …）または `#rrggbb`。
- 探索パスは `~/.nelo/addons/*` と `./.nelo/addons/*`（プロジェクト側が優先）。
- 編集中は `/theme reload` で即反映。壊れた JSON や未知のトークンは警告として表示され、UI は止まりません。
- `layout.hints` は最初のメッセージを送る前のウェルカム画面の表示切り替えです。

### カラートークン

`brand` `accent` `accentAlt` `text` `muted` `dim` `success` `warning` `danger` `info` `user` `assistant` `tool` `toolError` `code` `heading` `border` `vitals`

### グリフトークン

`brand` `prompt` `user` `tool` `toolBranch` `separator` `warn` `error` `question` `cursor` `bullet` `scroll` `state` `boxTopLeft` `boxTopRight` `boxBottomLeft` `boxBottomRight` `boxHorizontal` `boxVertical`

### Markdown トークン

| トークン | 対象 |
| --- | --- |
| `heading` | 見出し（太字と併用） |
| `code` | フェンス内のコードとインライン `` `code` `` |
| `fence` | ` ``` ` の行 |
| `bullet` | 箇条書き・番号付きリストのマーカー |
| `strong` | `**強調**` / `__強調__` |
| `emphasis` | `*斜体*` / `_斜体_` |
| `link` | `[label](url)` の URL 部分 |

本文はインライン記法（強調・インラインコード・リンク）を解釈して描画します。折り返しでマーカーが行をまたいだ場合は、行端の余分なマーカーだけを落として地の文として表示します。

## CLI リファレンス

```
nelo [options] [prompt]
nelo config | providers | themes | addon new <name>
```

| オプション | 説明 |
| --- | --- |
| `--provider <id>` | `auto` / `ollama` / `lmstudio` / `omniroute` / `llamacpp` / `vllm` / `anthropic` / `openai` / `openrouter` / `custom` |
| `--base-url <url>` | エンドポイントを上書き |
| `-m, --model <name>` | モデル ID またはエイリアス |
| `-y, --yes` | すべてのツール呼び出しを自動承認（`auto` モード） |
| `--readonly` | 読み取り専用モード |
| `--mode <mode>` | `ask` / `auto` / `readonly` |
| `--no-tui` | ライン REPL で起動 |
| `--max-tokens <n>` | 1応答あたりの最大出力トークン数 |
| `-c, --continue` | 最新セッションを再開 |
| `-r, --resume <id>` | 指定セッションを再開 |
| `-p, --print` | 非対話モード（プロンプト必須） |
| `-h, --help` | ヘルプ |
| `-V, --version` | バージョン |
| `config` | 有効な設定の表示 |
| `providers` | プロバイダテンプレート一覧 |
| `themes` | テーマ一覧 |
| `addon new <name>` | テーマアドオンの雛形を作成 |

## ツール

| ツール | 読み取り専用 | 説明 |
| --- | --- | --- |
| `read_file` | ✓ | 行番号付きでファイルを読む。`offset` / `limit` でページング |
| `list_files` | ✓ | ディレクトリ一覧。再帰・深さ・件数指定 |
| `grep` | ✓ | 正規表現検索。glob フィルタ、ファイル名のみの出力モード |
| `edit_file` |  | 一意な文字列置換。`replace_all` 対応、CRLF を保持 |
| `write_file` |  | ファイル全体を書き込み（親ディレクトリ自動作成） |
| `run_command` |  | シェルコマンド実行。タイムアウト・中断・出力切り詰め対応 |

ファイル系ツールはワークスペース外へのパスを拒否します。

## 権限モード

| モード | 読み取り | 書き込み・コマンド |
| --- | --- | --- |
| `ask`（既定） | 自動許可 | 毎回 `y / n / a` を確認 |
| `auto`（`-y`） | 自動許可 | 自動許可（危険コマンドを除く） |
| `readonly` | 自動許可 | 拒否 |

- `a`（always）を選ぶと、そのセッション中は同じスコープを再確認しません（`run_command` のスコープは先頭トークン）。
- 以下は **どのモードでも** ブロックされます: ルート/ホームへの `rm -rf`、`mkfs`、デバイスへの `dd`、`shutdown` / `reboot`、フォークボム、ドライブの `format`、システムディレクトリの削除。

## 設定

設定は次の順で上書きされます（後のものが優先）:

1. 組み込みの既定値
2. `~/.nelo/config.json`（グローバル）
3. `./.nelo/config.json`（プロジェクト）
4. 環境変数
5. CLI フラグ

```json
{
  "provider": "ollama",
  "model": "qwen2.5-coder:7b",
  "maxTokens": 4096,
  "maxTurns": 40,
  "permissions": {
    "mode": "ask",
    "allow": [],
    "denyCommands": ["\\bcurl\\b"]
  },
  "context": {
    "maxTokens": 32768,
    "compactAt": 0.7
  },
  "workspace": {
    "allowOutside": false
  },
  "sampling": {
    "temperature": 0.2,
    "topP": 0.9
  },
  "request": {
    "timeoutMs": 300000
  },
  "ui": {
    "theme": "nelo",
    "resources": true,
    "resourceIntervalMs": 1000
  }
}
```

| キー | 既定値 | 説明 |
| --- | --- | --- |
| `provider` | `auto` | プロバイダ ID |
| `model` | プロバイダ依存 | 使用モデル（エイリアス可） |
| `maxTokens` | プロバイダ依存 | 1応答あたりの最大出力トークン数 |
| `maxTurns` | `40` | 1リクエスト内の最大ツールターン数 |
| `apiKey` | — | API キー（環境変数を推奨） |
| `baseURL` | — | エンドポイントの上書き |
| `permissions.mode` | `ask` | 権限モード |
| `permissions.allow` | `[]` | 無確認で許可するツール名 |
| `permissions.denyCommands` | `[]` | 拒否するコマンドの正規表現 |
| `context.maxTokens` | プロバイダ依存 | コンテキストウィンドウの想定値 |
| `context.compactAt` | `0.8` | 自動圧縮を始める使用率 |
| `workspace.allowOutside` | `false` | ワークスペース外アクセスの許可 |
| `sampling.temperature` | `0.2` | ローカルモデル向けの低めの既定値 |
| `sampling.topP` | `0.9` | top-p |
| `request.timeoutMs` | `300000` | 1リクエストのタイムアウト（ローカルのプリフィルは遅い） |
| `ui.theme` | `nelo` | テーマ名 |
| `ui.resources` | `true` | リソースモニタの有効化 |
| `ui.resourceIntervalMs` | `1000` | サンプリング間隔 |

### 環境変数

| 変数 | 説明 |
| --- | --- |
| `NELO_PROVIDER` | `auto` / `ollama` / `lmstudio` / … |
| `NELO_BASE_URL` | エンドポイントの上書き |
| `NELO_MODEL` | 既定モデル |
| `NELO_MAX_TOKENS` | 最大出力トークン数 |
| `NELO_MAX_TURNS` | 最大ツールターン数 |
| `NELO_PERMISSION_MODE` | `ask` / `auto` / `readonly` |
| `NELO_THEME` | テーマ名 |
| `NELO_SHELL` | `run_command` が使うシェル（POSIX 互換） |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `OMNIROUTE_API_KEY` | OmniRoute（認証を有効にした場合） |
| `NO_COLOR` | 色出力を無効化 |

### プロジェクト指示ファイル

ワークスペース直下に `NELO.md`、`CLAUDE.md`、`AGENTS.md` のいずれかがあると、システムプロンプトに自動で取り込まれます。

## ローカルモデルで使うための工夫

- **ツール呼び出しのフォールバック** — ネイティブの `tool_calls` を優先しつつ、`<tool_call>{...}</tool_call>` や ```` ```json ```` ブロックで書かれた呼び出しも解釈します。表示前に検出するので、生のタグが画面に出ることはありません。
- **壊れた JSON の修復** — 末尾カンマ、シングルクォート、前後の説明文を補正してから諦めます。
- **ストリーミングの引数組み立て** — `tool_calls` の `arguments` が分割されて届いても正しく連結します。
- **モデル・コンテキストの自動検出** — `/v1/models`、Ollama の `/api/show`、llama.cpp の `/props` から取得し、ユーザー指定がなければ採用します。
- **低い temperature** — 既定 0.2 / top_p 0.9。

## アーキテクチャ

```
┌──────────────────────────────────────────────────────────┐
│ index.ts              CLI エントリ / 引数処理 / サブコマンド │
│  ├─ cli-args.ts                                            │
│  ├─ ui/tui/*          フルスクリーン TUI                    │
│  └─ repl.ts           ライン REPL（--no-tui 用）             │
├──────────────────────────────────────────────────────────┤
│ commands.ts           スラッシュコマンド / ! 実行            │
├──────────────────────────────────────────────────────────┤
│ app.ts                依存の組み立て / プロバイダ解決         │
│  ├─ providers.ts      プロバイダテンプレートと自動検出        │
│  ├─ agent.ts          エージェントループ                     │
│  │   ├─ client.ts         ModelClient 抽象 + Anthropic       │
│  │   ├─ client-openai.ts  OpenAI 互換（SSE / tool_calls）    │
│  │   ├─ ollama.ts         Ollama ネイティブ API              │
│  │   ├─ permissions.ts    権限判定                           │
│  │   ├─ compaction.ts     履歴の要約                         │
│  │   └─ tools/*           ツール実装                         │
│  ├─ system/resources.ts  CPU / RAM / GPU / VRAM             │
│  ├─ session.ts         セッション永続化                       │
│  ├─ prompt.ts          システムプロンプト                     │
│  └─ ui/theme.ts        テーマ + アドオン                      │
└──────────────────────────────────────────────────────────┘
```

| ファイル | 役割 |
| --- | --- |
| `src/providers.ts` | 9 プロバイダのプリセット、`auto` 判定、既定値の適用 |
| `src/client-openai.ts` | OpenAI 互換のストリーミング、引数組み立て、テキスト形式ツール呼び出しの抽出 |
| `src/ollama.ts` | `/api/tags`・`/api/ps`・`/api/show`、llama.cpp の `/props` |
| `src/system/resources.ts` | CPU 差分・メモリ・nvidia-smi・Ollama VRAM のサンプリングと整形 |
| `src/ui/theme.ts` | カラートークン・グリフ・レイアウト、組み込みテーマ、アドオン読み込み |
| `src/agent.ts` | モデル呼び出し → ツール実行 → 結果返却のループ |
| `src/permissions.ts` | モード・許可リスト・拒否パターン・セッション内記憶 |
| `src/compaction.ts` | 安全な切断点で履歴を要約し、直近ターンを保持 |
| `src/ui/tui/*` | 代替画面バッファ、トランスクリプト、入力エディタ、全角対応の幅計算 |

## 開発

```bash
npm install
npm run build        # tsc -> dist/
npm run dev          # tsx で src/index.ts を直接実行
npm test             # vitest（ユニットテスト）
npm run typecheck    # 型チェックのみ
npm run test:e2e     # ビルド + モック API に対する E2E
npm run mock         # Anthropic 互換モック
npm run mock:openai  # OpenAI 互換モック（Ollama 相当の /api/* も提供）
```

### モック API

API キーなしでエージェントループを試せます。

```bash
npm run mock:openai
# 別ターミナルで:
node bin/nelo.js --provider ollama --base-url http://127.0.0.1:8799/v1 "hello"
```

`-m mock-text-tools` を指定すると、ツール呼び出しをテキストで返すモデルを再現できます。

### ディレクトリ構成

```
bin/nelo.js              実行ランチャー
src/                     本体（TypeScript, ESM）
tests/                   vitest テスト
scripts/mock-server.mjs  Anthropic Messages API モック
scripts/mock-openai.mjs  OpenAI 互換モック（Ollama /api/* つき）
scripts/e2e.mjs          E2E スモークテスト
```

## 既知の制限

- アドオンは**見た目のみ**。ツールやフックの追加は未実装です。
- GPU 情報は NVIDIA（`nvidia-smi`）のみ。AMD / Intel / Apple Silicon は CPU・メモリのみ表示されます。
- 入力は1行ずつです（複数行エディタは未実装）。
- マウスホイールによるスクロールには未対応です（`PgUp` / `PgDn` / `Shift+↑↓`）。
- 画像・PDF の入力、MCP サーバには未対応です。
- ローカルモデルはツール呼び出しの精度がモデル依存です。テキスト形式のフォールバックで救えますが、7B 級では複雑な多段タスクで失敗することがあります。
- コンパクションは要約による不可逆な圧縮です。
- コストはトークン数でのみ表示し、金額換算はしません。
- Windows では Git Bash が見つかればそれを使い、なければ `cmd.exe` にフォールバックします。

## ロードマップ

- 差分プレビュー付きの編集承認
- 複数行入力とブラケットペースト対応
- マウスホイールによる履歴スクロール
- 機能アドオン（ツール・フック）の仕組み
- MCP クライアントとカスタムツール定義
- 文法（GBNF）によるツール呼び出しの強制
- ローカルモデルのベンチマーク（成功率・tok/s・総トークン）
- サブエージェントによる並列調査

## ライセンス

MIT
