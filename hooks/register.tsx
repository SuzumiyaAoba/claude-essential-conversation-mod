/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { On, SessionMessage } from 'claude-code'

const PANE_ID = 'essential-conversation'
const PANE_TITLE = 'Conversation'
const COMMAND_NAME = 'conversation'
const MAX_PAIRS = 50
const STORE_KEY = 'pairs'
// Markdown's own hard cap (claude-code.d.ts); past it the element is refused outright.
const MAX_MARKDOWN_CHARS = 10000
// The same marker the transcript itself draws before an assistant block.
const ANSWER_MARKER = '⏺ '

type Pair = {
  turnId: string
  prompt: string
  answer: string | null
  isAborted: boolean
  /**
   * The transcript's own id for this pair's opening UserMessage row, learned
   * from that row's own `ui.render` (its `requestId`) rather than guessed
   * from `turnId` — the only id `$.ui.scroll` accepts. Null until that row
   * has been drawn at least once: a live `turn.start` gets one, but a
   * history-reconstructed pair (pairsFromMessages) never does — the engine
   * raises no `ui.render` for a row replayed by session.start/`/resume`, so
   * there is nothing here to learn it from.
   */
  realId: string | null
}

type PromptSegment =
  | { type: 'text'; value: string }
  | { type: 'pasted'; key: string; content: string }

// The closing tag repeats `id="..."` too (`</pasted_content id="aedf">`,
// not the bare `</pasted_content>` an XML reader would expect) — both
// alternatives share this one shape, told apart below by the leading `/`.
const PASTE_TOKEN = /<\/?pasted_content id="[^"]*">/g

/**
 * Splits a prompt on `<pasted_content id="...">...</pasted_content id="...">`
 * spans (what the composer wraps a paste in) so each one can fold on its
 * own, collapsed by default, instead of the whole prompt drawing as one
 * wall of text. Depth-counted, not a lazy regex match: the pasted text
 * itself can contain literal `<pasted_content>`-looking substrings (pasting
 * a reply that quoted one), and only a real span's own matching close
 * should end it. An unterminated span (an open with no matching close)
 * falls back to the untouched prompt as one 'text' segment — nothing here
 * is lost.
 */
function splitPastedContent(turnId: string, prompt: string): PromptSegment[] {
  const segments: PromptSegment[] = []
  let cursor = 0
  let depth = 0
  let blockStart = -1
  let pasteIndex = 0
  let match: RegExpExecArray | null

  // A run of plain text right against a paste's tags is mostly the
  // composer's own framing newlines; trimmed, an all-whitespace run (e.g.
  // between two adjacent pastes) drops out rather than drawing as a blank
  // line above or below the paste's own box.
  function pushText(value: string) {
    const trimmed = value.trim()

    if (trimmed !== '') {
      segments.push({ type: 'text', value: trimmed })
    }
  }

  PASTE_TOKEN.lastIndex = 0

  while ((match = PASTE_TOKEN.exec(prompt)) !== null) {
    if (!match[0].startsWith('</')) {
      if (depth === 0) {
        if (match.index > cursor) {
          pushText(prompt.slice(cursor, match.index))
        }

        blockStart = match.index
      }

      depth += 1
      continue
    }

    if (depth === 0) {
      continue
    }

    depth -= 1

    if (depth === 0) {
      const openTagEnd = prompt.indexOf('>', blockStart) + 1
      const blockEnd = match.index + match[0].length

      segments.push({
        type: 'pasted',
        key: `${turnId}:${pasteIndex}`,
        // The composer wraps a paste in its own leading/trailing newline
        // (`<pasted_content id="x">\ncontent\n</pasted_content ...>`), which
        // read as blank lines above and below the text once drawn.
        content: prompt.slice(openTagEnd, match.index).trim(),
      })
      pasteIndex += 1
      cursor = blockEnd
    }
  }

  if (depth !== 0) {
    return [{ type: 'text', value: prompt }]
  }

  if (cursor < prompt.length) {
    pushText(prompt.slice(cursor))
  }

  return segments
}

/**
 * A transcript row that opens a turn: a typed user prompt, not a tool
 * result. Mirrors the built-in diff pane's own row test, since
 * `$.session.messages()` gives no `turnId` for history read this way.
 */
function isPromptRow(message: SessionMessage): boolean {
  return (
    message.role === 'user' &&
    (message.toolResults === undefined || message.toolResults.length === 0) &&
    message.text !== ''
  )
}

/** Reconstructs prompt/answer pairs already in the transcript (fresh session.start, /resume). */
function pairsFromMessages(messages: readonly SessionMessage[]): Pair[] {
  const starts = messages.flatMap((message, at) => (isPromptRow(message) ? [at] : []))

  return starts.map((start, ordinal) => {
    const rows = messages.slice(start, starts[ordinal + 1])
    const lastAnswer = [...rows].reverse().find(row => row.role === 'assistant' && row.text !== '')

    return {
      turnId: `history-${start}`,
      prompt: rows[0]?.text ?? '',
      answer: lastAnswer?.text ?? null,
      isAborted: false,
      realId: null,
    }
  })
}

type StoredPairs = {
  sessionId: string
  pairs: Pair[]
}

/**
 * Validates `$.store.get(STORE_KEY)`'s `unknown` shape before trusting it as
 * this session's own last-saved state, normalizing a `realId` an older
 * version of this plugin may have stored without one.
 */
function parseStoredPairs(value: unknown): StoredPairs | null {
  if (typeof value !== 'object' || value === null || !('sessionId' in value) || !('pairs' in value)) {
    return null
  }

  const { sessionId, pairs } = value as { sessionId: unknown; pairs: unknown }

  if (typeof sessionId !== 'string' || !Array.isArray(pairs)) {
    return null
  }

  return {
    sessionId,
    pairs: (pairs as Pair[]).map(pair => ({ ...pair, realId: pair.realId ?? null })),
  }
}

function answerTextOf(pair: Pair): string {
  if (pair.answer === null) {
    return `${ANSWER_MARKER}… generating a response`
  }

  const text = pair.answer === '' ? '(no response to show)' : pair.answer
  const withStatus = pair.isAborted ? `${text}\n⏸ interrupted` : text
  const budget = MAX_MARKDOWN_CHARS - ANSWER_MARKER.length
  const body = withStatus.length > budget ? `${withStatus.slice(0, budget - 1)}…` : withStatus

  return `${ANSWER_MARKER}${body}`
}

export function register(on: On) {
  const pairs: Pair[] = []
  let invalidate: (() => void) | null = null
  let isPaneOpen = false
  // Set once at session.start; the key persisted state is saved under, so a
  // reload of this same running session can tell its own last save apart
  // from another session's (a stale run, or /resume onto a different one).
  let sessionId: string | null = null
  // A per-turnId fold state for the pane alone — purely a display
  // preference, so it starts empty (every card open) each time the plugin
  // (re)loads rather than being kept in $.store with the pairs themselves.
  const collapsedTurnIds = new Set<string>()
  // Same idea, one entry per pasted-content span (PromptSegment's key):
  // collapsed (absent) by default, expanded once its own toggle is pressed.
  const expandedPasteKeys = new Set<string>()

  function toggleCollapsed(turnId: string) {
    if (collapsedTurnIds.has(turnId)) {
      collapsedTurnIds.delete(turnId)
    } else {
      collapsedTurnIds.add(turnId)
    }

    invalidate?.()
  }

  function togglePaste(key: string) {
    if (expandedPasteKeys.has(key)) {
      expandedPasteKeys.delete(key)
    } else {
      expandedPasteKeys.add(key)
    }

    invalidate?.()
  }

  function pushPrompt(turnId: string, text: string) {
    pairs.push({ turnId, prompt: text, answer: null, isAborted: false, realId: null })

    if (pairs.length > MAX_PAIRS) {
      pairs.splice(0, pairs.length - MAX_PAIRS)
    }
  }

  function setAnswer(turnId: string, answer: string, isAborted: boolean) {
    const pair = pairs.find(p => p.turnId === turnId)

    if (pair) {
      pair.answer = answer
      pair.isAborted = isAborted
    }
  }

  /**
   * Matches a drawn UserMessage row back to the pair it opened, by its exact
   * text against the oldest pair still missing a `realId` — the live
   * transcript draws prompts in the same order `pairs` holds them, so the
   * earliest unmatched match is the right one even when two turns share
   * identical text. Only ever fires for a live turn's row; a history one is
   * never drawn, so it is never called for those (see Pair.realId).
   */
  function learnRealId(text: string, requestId: string): boolean {
    const pair = pairs.find(p => p.realId === null && p.prompt === text)

    if (!pair) {
      return false
    }

    pair.realId = requestId
    invalidate?.()

    return true
  }

  on('session.start', async ($, e, next) => {
    invalidate = () => $.ui.invalidate('ui.render')
    sessionId = await $.session.id().catch(() => null)

    // A hot reload of this plugin re-runs register() from scratch, wiping
    // pairs and, worse, losing the real turnId of any turn still in
    // flight — pairsFromMessages would then mint that same turn a fresh
    // history-N id, and the turn.complete already on its way (carrying the
    // original turnId) would never find it again. Restoring exactly what
    // was last saved under this same sessionId keeps that turn's identity
    // (and any realId already learned for other turns) intact across the
    // reload; only a genuinely new or /resume'd session falls back to
    // reconstructing from the transcript.
    const stored = parseStoredPairs(await $.store.get(STORE_KEY).catch(() => undefined))

    if (stored !== null && sessionId !== null && stored.sessionId === sessionId) {
      pairs.push(...stored.pairs)
    } else {
      const messages = await $.session.messages().catch((): SessionMessage[] => [])
      pairs.push(...pairsFromMessages(messages))
    }

    if (sessionId !== null) {
      $.store.set(STORE_KEY, { sessionId, pairs }).catch(() => undefined)
    }

    await $.command
      .register({
        name: COMMAND_NAME,
        description: 'Toggle the prompt / last-answer pane for this session',
      })
      .catch(() => undefined)

    // Shown at once when there is room; too narrow, the engine holds it
    // undrawn until /conversation (a person's own open is placed at any
    // width) — see $.ui.open's PaneOpenArgs docs.
    await $.ui
      .open({ id: PANE_ID, title: PANE_TITLE, holdToasts: true })
      .then(() => {
        isPaneOpen = true
        // Oldest-first puts prior history above the fold; start scrolled to
        // the newest turn instead of wherever the pane happens to mount.
        return $.ui.scroll({ to: 'end', in: PANE_ID })
      })
      .catch(() => undefined)

    $.ui.log(`essential-conversation loaded — /${COMMAND_NAME} toggles the pane`)

    return next(e)
  })

  // A subagent's run also raises turn.complete (with agentId set) but no
  // turn.start of its own, so only the main loop's turns are tracked here.
  on('turn.start', ($, e, next) => {
    if (e.text !== '') {
      pushPrompt(e.turnId, e.text)
      invalidate?.()
      // Oldest-first now puts a fresh card at the bottom; without this the
      // pane can sit scrolled to wherever it last was and the new card (and
      // later its answer) never comes into view on its own.
      $.ui.scroll({ to: 'end', in: PANE_ID }).catch(() => undefined)

      if (sessionId !== null) {
        $.store.set(STORE_KEY, { sessionId, pairs }).catch(() => undefined)
      }
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      setAnswer(e.turnId, e.answer, e.isAborted)
      invalidate?.()
      $.ui.scroll({ to: 'end', in: PANE_ID }).catch(() => undefined)

      if (sessionId !== null) {
        $.store.set(STORE_KEY, { sessionId, pairs }).catch(() => undefined)
      }
    }

    return next(e)
  })

  // Core's own row, not this plugin's — observing it here (rather than
  // trusting turn.start's turnId to double as the message id) is what makes
  // a live prompt's jump button work. It does nothing for history: the
  // engine never raises this for a row session.start/`/resume` replayed.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    if (learnRealId(e.props.text, e.requestId) && sessionId !== null) {
      $.store.set(STORE_KEY, { sessionId, pairs }).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: COMMAND_NAME }, async ($, e, next) => {
    if (isPaneOpen) {
      await $.ui.close({ id: PANE_ID })
      isPaneOpen = false

      return { text: `${PANE_TITLE} pane closed` }
    }

    await $.ui.open({ id: PANE_ID, title: PANE_TITLE, holdToasts: true, focus: true })
    isPaneOpen = true

    return { text: `${PANE_TITLE} pane opened` }
  })

  // Catches a close the person made directly (Esc, ctrl+x x), which never
  // runs through this plugin's own $.ui.close call above.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)

    if (result.deny === undefined) {
      isPaneOpen = false
    }

    return result
  })

  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    const result = await next(e)

    pairs.length = 0

    if (e.command === 'resume') {
      const messages = await $.session.messages().catch((): SessionMessage[] => [])
      pairs.push(...pairsFromMessages(messages))
    }

    invalidate?.()
    $.ui.scroll({ to: 'end', in: PANE_ID }).catch(() => undefined)

    if (sessionId !== null) {
      $.store.set(STORE_KEY, { sessionId, pairs }).catch(() => undefined)
    }

    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) {
      return next(e)
    }

    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    // Oldest first, top to bottom — the same order the transcript itself reads in.
    const shown = pairs

    // Scrolls the main transcript to this pair's opening prompt. Only a
    // person's own click/Enter reaches here — ui.scroll refuses a plugin-
    // initiated jump on a transcript row — and only once learnRealId has
    // matched this pair to its UserMessage row's own requestId; until then
    // the button is left out rather than offering a jump that always fails.
    function jumpToRealId(requestId: string) {
      $.ui
        .scroll({ to: { requestId }, block: 'start' })
        .then(result => {
          if (result.deny !== undefined) {
            $.ui.log(`Jump failed: ${result.deny}`)
          }
        })
        .catch(() => undefined)
    }

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text dimColor>{pairs.length} turn(s)</Text>
        {shown.length === 0 && <Text dimColor>No turns yet</Text>}
        {shown.map(pair => {
          const { realId } = pair
          const isCollapsed = collapsedTurnIds.has(pair.turnId)
          const promptSegments = splitPastedContent(pair.turnId, pair.prompt)

          return (
            <Box key={pair.turnId} flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Button plain dimColor onPress={() => toggleCollapsed(pair.turnId)}>
                  {isCollapsed ? '[+]' : '[-]'}
                </Button>
                {realId !== null && (
                  <Button plain dimColor onPress={() => jumpToRealId(realId)}>
                    ⤴ Jump to start
                  </Button>
                )}
              </Box>
              <Box flexDirection="column">
                {promptSegments.map((segment, index) => {
                  const prefix = index === 0 ? '❯ ' : ''

                  if (segment.type === 'text') {
                    return (
                      <Text key={`${pair.turnId}:text:${index}`} bold color="cyan" wrap="wrap">
                        {prefix}
                        {segment.value}
                      </Text>
                    )
                  }

                  const isPasteOpen = expandedPasteKeys.has(segment.key)

                  const pasteLabel = `${prefix}${isPasteOpen ? '[-]' : '[+]'} pasted content (${segment.content.length} chars)${isPasteOpen ? '' : ' — click to expand'}`

                  return (
                    <Box key={segment.key} flexDirection="column">
                      <Button plain dimColor onPress={() => togglePaste(segment.key)}>
                        {pasteLabel}
                      </Button>
                      {isPasteOpen && (
                        <Box borderStyle="round" borderDimColor paddingX={1}>
                          <Text bold color="cyan" wrap="wrap">
                            {segment.content}
                          </Text>
                        </Box>
                      )}
                    </Box>
                  )
                })}
              </Box>
              {!isCollapsed && (
                <Box marginTop={1}>
                  <Markdown text={answerTextOf(pair)} />
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
