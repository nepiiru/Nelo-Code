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
- 標準出力は「モデルの応答」専用。ツール実行ログや警告は標準エラーへ出す（非対話モードのパイプ互換性のため）。
- 危険コマンドの判定は `src/command-safety.ts` に集約する。

## テスト方針

- ツールを追加・変更したら `tests/` に対応するテストを追加する。
- エージェントループの変更は `tests/agent.test.ts` のスクリプト応答で検証する。
- E2E はモック API（`scripts/mock-server.mjs`）を使い、実 API キーに依存させない。
