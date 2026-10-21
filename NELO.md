# Nelo Code — 開発ガイド

Nelo Code 自体を Nelo Code で開発するための指示ファイル。

## コマンド

- ビルド: `npm run build`
- テスト: `npm test`
- 型チェック: `npm run typecheck`
- E2E: `npm run test:e2e`
- ローカル用モック: `npm run mock:openai`

変更後は最低でも `npm run typecheck` と `npm test` を通すこと。

## 構成の約束

- `src/` は ESM + NodeNext。相対 import には `.js` 拡張子を付ける。
- 実行時依存は `@anthropic-ai/sdk` のみに保つ。**ローカル接続は `fetch` で実装し、SDK を足さない。**
- ツールは `src/tools/` に1ファイル1ツールで実装し、`src/tools/index.ts` に登録する。
- ツールは `ToolContext.workspaceRoot` の外へアクセスしない（`resolveWorkspacePath` を使う）。
- モデル呼び出しは `ModelClient` インターフェース越しに行い、テストでは `FakeClient` に差し替える。

### プロバイダ

- プロバイダは `src/providers.ts` の `PROVIDER_PRESETS` に追加する。1プロバイダ = 1エントリで、`kind` が `anthropic` か `openai`（OpenAI 互換）かを必ず指定する。
- 新しい OpenAI 互換サーバーは、原則として既存の `OpenAICompatible` 経路で動くはず。差分がプロトコルレベルでない限り `client-openai.ts` は触らない。
- `auto` の探索順は `AUTO_LOCAL_ORDER` → `AUTO_CLOUD_ORDER`。**ローカル優先**を崩さない。
- モデル名・コンテキスト長は「ユーザーが明示していない場合のみ」プロバイダ既定で埋める。判定は `config.ts` の `DEFAULT_MODEL` / `DEFAULT_CONTEXT_TOKENS` / `DEFAULT_MAX_TOKENS` との比較で行う。
- ローカルサーバーは API キーを要求しない。`requiresKey: false` のプリセットでは `Authorization` ヘッダを送らない。
- ツール呼び出しはネイティブ `tool_calls` を優先し、**テキスト形式のフォールバックを壊さない**（`extractTextToolCalls` / `parseToolArguments`）。テキストを画面に流す前に検出するため、`readStream` の hold-back を外さないこと。

### UI とテーマ

- UI は `src/ui/ui.ts` の `UI` インターフェースを実装する。TUI とライン REPL で挙動を揃え、UI にメソッドを足すときは両方に実装する。
- **色と記号を直書きしない。** `src/ui/theme.ts` の `paintToken()` / `glyph()` / `bold()` / `dim()` を通す。新しい見た目の要素を足すときは、まずカラートークンかグリフトークンを追加する。
- トークンを追加したら `BUILTIN_THEMES` の全テーマに値を入れ、`tests/theme.test.ts` の全トークン検証を通す。
- アドオンは **JSON のみ**（`addon.json` / `theme.json`）。任意コードを読み込む仕組みはまだ入れない。`apiVersion` は 1。
- アドオンの読み込みは失敗しても UI を止めない。エラーは `errors` に積んで `ui.warn` で見せる。
- TUI の描画ロジックは `src/ui/tui/` の純粋関数（幅計算・折り返し・Markdown・入力エディタ）に置き、端末 I/O と分離してテスト可能に保つ。全角文字は `charWidth` / `stringWidth` で幅を計算し、`String.length` で折り返さない。
- インライン記法（`**強調**` / `` `code` `` / リンク）の解釈は `src/ui/inline.ts` に集約し、TUI（`formatMarkdown`）とライン REPL（`StreamRenderer`）の両方から呼ぶ。片方だけ変えない。折り返し後に付与するので、行端に残った対にならないマーカーは `balanceEdgeMarkers()` で落とす。
- `getVersion()` は `package.json` を読むため、**BOM 付きで書き出さない**（PowerShell の `Set-Content -Encoding UTF8` は BOM を付ける）。読み込み側は BOM を除去している。
- 代替画面バッファを使う場合、例外・Ctrl+C・終了時に必ず元の画面と raw mode を復元する（`TuiUI.stop()`）。
- TUI の依存は Node 標準 API のみ。Ink や React を持ち込まない。

### リソースモニタ

- `src/system/resources.ts` は UI から独立させる。表示文字列の整形は `vitalsSegments()` / `formatResourceReport()` に閉じ込め、TUI は受け取った文字列を並べるだけにする。
- サンプリングは重複実行しない（`inFlight`）。失敗しても例外を投げない。
- GPU は `nvidia-smi` がある場合のみ。**失敗したら 30 秒は再試行しない**（毎秒プロセスを起動しない）。
- Ollama の `/api/ps` は `provider === 'ollama'` のときだけ叩く。クラウドのエンドポイントに投げない。

## テスト方針

- ツールを追加・変更したら `tests/` に対応するテストを追加する。
- エージェントループの変更は `tests/agent.test.ts` のスクリプト応答で検証する。
- プロバイダ解決は `resolveProvider({ probe })` の `probe` を差し替えて検証する。実ポートの空き状況に依存させない。
- HTTP を伴うテストは `node:http` でポート 0 にバインドし、`address().port` を使う。固定ポートを使わない。
- テーマは一時ディレクトリにアドオンを書き出して検証する。`~/.nelo` を汚さない。
- TUI の幅計算・折り返し・入力エディタ・画面出力は、疑似ストリームを使ったユニットテストで検証する（`tests/tui-*.test.ts`）。端末の実サイズや実 TTY に依存させない。
- E2E はモック API（`scripts/mock-server.mjs` / `scripts/mock-openai.mjs`）を使い、実 API キーに依存させない。
