# Nelo Code — 開発ガイド

Nelo Code 自体を Nelo Code で開発するための指示ファイル。

## コマンド

- ビルド: `npm run build`
- テスト: `npm test`
- 型チェック: `npm run typecheck`
- E2E: `npm run test:e2e`

変更後は最低でも `npm run typecheck` と `npm test` を通すこと。

## 構成の約束

- `src/` は ESM + NodeNext。相対 import には `.js` 拡張子を付ける。
- 実行時依存は `@anthropic-ai/sdk` のみに保つ。新しい依存を足す前に標準ライブラリで代替できないか検討する。
- ツールは `src/tools/` に1ファイル1ツールで実装し、`src/tools/index.ts` に登録する。
- ツールは `ToolContext.workspaceRoot` の外へアクセスしない（`resolveWorkspacePath` を使う）。
- モデル呼び出しは `ModelClient` インターフェース越しに行い、テストでは `FakeClient` に差し替える。
- 非対話モードの標準出力は「モデルの応答」専用。ツール実行ログや警告は標準エラーへ出す（パイプ互換性のため）。TUI 動作中は TUI が標準出力を所有するため、`console.log` を直接呼ばない。
- 危険コマンドの判定は `src/command-safety.ts` に集約する。
- UI は `src/ui/ui.ts` の `UI` インターフェースを実装する。TUI とライン REPL で挙動を揃え、UI にメソッドを足すときは両方に実装する。
- TUI の描画ロジックは `src/ui/tui/` の純粋関数（幅計算・折り返し・Markdown・入力エディタ）に置き、端末 I/O と分離してテスト可能に保つ。全角文字は `charWidth` / `stringWidth` で幅を計算し、`String.length` で折り返さない。
- 代替画面バッファを使う場合、例外・Ctrl+C・終了時に必ず元の画面と raw mode を復元する（`TuiUI.stop()`）。
- TUI の依存は Node 標準 API のみ。Ink や React を持ち込まない。

## テスト方針

- ツールを追加・変更したら `tests/` に対応するテストを追加する。
- エージェントループの変更は `tests/agent.test.ts` のスクリプト応答で検証する。
- TUI の幅計算・折り返し・入力エディタ・画面出力は、疑似ストリームを使ったユニットテストで検証する（`tests/tui-*.test.ts`）。端末の実サイズや実 TTY に依存させない。
- E2E はモック API（`scripts/mock-server.mjs`）を使い、実 API キーに依存させない。
