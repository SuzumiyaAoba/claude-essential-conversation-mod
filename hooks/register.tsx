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
    }
  })
}

function answerTextOf(pair: Pair): string {
  if (pair.answer === null) {
    return '… 応答を生成中'
  }

  const text = pair.answer === '' ? '(表示できる応答はありません)' : pair.answer

  return pair.isAborted ? `${text}\n⏸ 中断されました` : text
}

export function register(on: On) {
  const pairs: Pair[] = []
  let invalidate: (() => void) | null = null
  let isPaneOpen = false

  function pushPrompt(turnId: string, text: string) {
    pairs.push({ turnId, prompt: text, answer: null, isAborted: false })

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

    return next(e)
  })

  // A subagent's run also raises turn.complete (with agentId set) but no
  // turn.start of its own, so only the main loop's turns are tracked here.
  on('turn.start', ($, e, next) => {
    if (e.text !== '') {
      pushPrompt(e.turnId, e.text)
      invalidate?.()
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      setAnswer(e.turnId, e.answer, e.isAborted)
      invalidate?.()
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

    return result
  })

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    if (e.requestId !== PANE_ID) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // Newest first, so the latest exchange is visible without scrolling.
    const shown = [...pairs].reverse()

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text dimColor>{pairs.length} turn(s)</Text>
        {shown.length === 0 && <Text dimColor>No turns yet</Text>}
        {shown.map(pair => (
          <Box key={pair.turnId} flexDirection="column" marginTop={1} borderStyle="round" borderDimColor paddingX={1}>
            <Text bold color="cyan" wrap="wrap">
              ❯ {pair.prompt}
            </Text>
            <Text wrap="wrap">{answerTextOf(pair)}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
