# claude-essential-conversation

Claude Code の [Mods](https://docs.claude.com/en/docs/claude-code/hooks) (function hooks) で書かれたプラグインです。
各ターンでユーザーが入力したプロンプトと、そのターンにおける Claude Code の最後の回答のペアを、右側のサイドパネルに一覧表示します。

> **Note**: Claude Mods (function hooks) は 2026年9月時点で Early Access の機能で、API は今後変更される可能性があります。

## 仕組み

- `turn.start` イベントの `e.text`（そのターンのユーザープロンプト）と `turn.complete` イベントの `e.answer`（そのターンでの Claude の最終回答）を `turnId` で紐付けて記録します。
- サブエージェントのターン（`e.agentId` を持つ `turn.complete`）は対象外にし、メインループのやり取りだけを表示します。
- `session.start` 時に `$.session.messages()` から既存のトランスクリプトを読み、セッション再開時も過去のペアを復元します。
- `/clear` でペアの一覧をリセットし、`/resume` では再開後のトランスクリプトから再構築します。
- パネルは `$.ui.open` で開いた `Pane` で、フルスクリーンかつ十分な幅があるターミナルではトランスクリプトの右側にドッキングされ、狭い場合はプロンプト上のダイアログとして開きます（このプレースメントはエンジン側が自動で決定します）。

## ファイル構成

```
.claude-plugin/plugin.json   # プラグインのメタ情報
hooks/hooks.json             # register.tsx をロードするための宣言
hooks/register.tsx           # Mod 本体（イベント登録・パネル描画）
tsconfig.json                 # /plugin-types が生成する型に対する開発用設定
```

## 使い方

1. Function hooks を有効化します（`~/.claude/settings.json` またはセッション起動時の環境変数）。

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
     }
   }
   ```

2. このディレクトリを plugin-dir として指定してセッションを起動します。

   ```bash
   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
   ```

3. セッション内で `/conversation` を実行するとパネルの開閉をトグルできます。

## 開発

型定義を最新化する場合はセッション内で以下を実行してください（`.claude/types/claude-code.d.ts` が生成されます）。

```
/plugin-types
```

プラグインの静的検証:

```bash
claude plugin validate .
```
