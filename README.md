# claude-essential-conversation

A Claude Code plugin written with [Mods](https://docs.claude.com/en/docs/claude-code/hooks) (function hooks).
It lists, in a side pane, the pair of each turn's typed prompt and Claude Code's last answer for that turn.

> **Note**: Claude Mods (function hooks) are an Early Access feature as of September 2026; the API may still change.

## How it works

- Pairs `e.text` from `turn.start` (that turn's prompt) with `e.answer` from `turn.complete` (that turn's final answer), joined by `turnId`.
- Skips subagent turns (a `turn.complete` with `e.agentId` set) and tracks only the main loop's exchanges.
- Reads the existing transcript from `$.session.messages()` at `session.start` so past pairs survive a fresh start and `/resume`.
- `/clear` resets the pair list; `/resume` rebuilds it from the resumed transcript.
- Cards render oldest first, top to bottom — the same order the transcript itself reads in. The pane auto-scrolls to the newest turn on `session.start`/`/resume` and whenever a turn starts or completes, so a fresh card (and later its answer) always comes into view.
- Each card whose opening prompt the plugin has matched to a real transcript row shows a "⤴ Jump to start" button. Pressing it scrolls the main transcript back to that turn's prompt via `$.ui.scroll`. The match is learned by observing `ui.render` for `UserMessage` (its own `requestId`), not guessed from `turnId`, so it works for history-replayed turns too — a card gets the button only once its row has actually been drawn.
- The pane is a `Pane` opened with `$.ui.open`: on a full-screen terminal wide enough, it docks to the right of the transcript; too narrow, it opens as a dialog over the prompt instead (the engine decides this placement automatically).

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
