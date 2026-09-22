/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { On, SessionMessage } from 'claude-code'

const PANE_ID = 'essential-conversation'
const PANE_TITLE = 'Conversation'
const COMMAND_NAME = 'conversation'
const MAX_PAIRS = 50

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

function answerTextOf(pair: Pair): string {
  if (pair.answer === null) {
    return '… generating a response'
  }

  const text = pair.answer === '' ? '(no response to show)' : pair.answer

  return pair.isAborted ? `${text}\n⏸ interrupted` : text
}

export function register(on: On) {
  const pairs: Pair[] = []
  let invalidate: (() => void) | null = null
  let isPaneOpen = false

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
  function learnRealId(text: string, requestId: string) {
    const pair = pairs.find(p => p.realId === null && p.prompt === text)

    if (pair) {
      pair.realId = requestId
      invalidate?.()
    }
  }

  on('session.start', async ($, e, next) => {
    invalidate = () => $.ui.invalidate('ui.render')

    const messages = await $.session.messages().catch((): SessionMessage[] => [])
    pairs.push(...pairsFromMessages(messages))

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
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      setAnswer(e.turnId, e.answer, e.isAborted)
      invalidate?.()
      $.ui.scroll({ to: 'end', in: PANE_ID }).catch(() => undefined)
    }

    return next(e)
  })

  // Core's own row, not this plugin's — observing it here (rather than
  // trusting turn.start's turnId to double as the message id) is what makes
  // a live prompt's jump button work. It does nothing for history: the
  // engine never raises this for a row session.start/`/resume` replayed.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    learnRealId(e.props.text, e.requestId)

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

    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
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

          return (
            <Box key={pair.turnId} flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold color="cyan" wrap="wrap">
                  ❯ {pair.prompt}
                </Text>
                {realId !== null && (
                  <Button plain dimColor onPress={() => jumpToRealId(realId)}>
                    ⤴ Jump to start
                  </Button>
                )}
              </Box>
              <Text wrap="wrap">{answerTextOf(pair)}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
