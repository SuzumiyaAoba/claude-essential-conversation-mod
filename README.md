# claude-essential-conversation

A Claude Code plugin written with [Mods](https://docs.claude.com/en/docs/claude-code/hooks) (function hooks).
It lists, in a side pane, the pair of each turn's typed prompt and Claude Code's last answer for that turn.

> **Note**: Claude Mods (function hooks) are an Early Access feature as of September 2026; the API may still change.

## File layout

```
.claude-plugin/plugin.json   # Plugin metadata
hooks/hooks.json             # Declares register.tsx to be loaded
hooks/register.tsx           # The mod itself (event registration, pane rendering)
tsconfig.json                 # Dev-time config for the types /plugin-types generates
```

## Usage

1. Enable function hooks (via `~/.claude/settings.json` or an env var at session start).

   ```json
   {
     "env": {
       "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
     }
   }
   ```

2. Start a session with this directory as the plugin dir.

   ```bash
   CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
   ```

3. Run `/conversation` in the session to toggle the pane.

## Development

To refresh the type definitions, run the following inside a session (writes `.claude/types/claude-code.d.ts`):

```
/plugin-types
```

Static validation of the plugin:

```bash
claude plugin validate .
```
