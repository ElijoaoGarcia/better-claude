import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode, RenderViewport, SessionRateLimit } from 'claude-code'

import type { Limit } from '../types'

const limits = atom({ plugin: 'sub-meter', key: 'limits' } as const, [] as Limit[])
const view = atom({ plugin: 'sub-meter', key: 'view' } as const, 0)

const WINDOWS = ['five_hour', 'seven_day']
const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week' }
const ROTATE_SECONDS = 8
const CELLS = 10
const CYCLE_HINT = /\s*\([^()]+ to cycle\)/
const INTERRUPT_HINT = /\s*esc to interrupt/
// The terminal footer's row: two columns of padding at each end, the mode label at the left
// (`⏵⏵ accept edits on ·`, the longest but bypass's) and the hint after it, two columns at least
// between that and what is drawn here.
const FOOTER_PADDING = 4
const FOOTER_GAP = 2
const MODE_LABEL = 20
const SEPARATOR = ' · '
// Room left, when nothing of another plugin is beneath, for one that may wrap the meter and draw
// after it: Narrator's narrowest switch (`⏵`) and its separator.
const AROUND = 1 + SEPARATOR.length
// The least another plugin's drawing beneath counts for when the meter weighs its bar and reset time
// (Narrator's `⏵ narrator`): what that plugin gives up where the row is short is not taken back for
// them, so the meter only shrinks as the row does.
const BENEATH_FLOOR = 10

// The hint as last drawn on the terminal, in columns.
let hintWidth = 0

/** The subscription windows the meter shows, in order, from what the engine measured. */
const windowsOf = (rateLimits: readonly SessionRateLimit[]): Limit[] =>
  WINDOWS.flatMap(kind => {
    const found = rateLimits.find(limit => limit.kind === kind)
    return found ? [{ kind, percentUsed: found.percentUsed, resetsAt: found.resetsAt }] : []
  })

/** Whether a drawing beneath shows nothing: no text, no control (the engine's own node draws `modes`, counted apart). */
function isBlank (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node.trim() === ''
  if (node.type === 'engine') return true
  return (node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isBlank)
}

/** Columns a text takes: one per character, none for a variation selector. */
const widthOf = (text: string) => [...text.replace(/[\uFE0E\uFE0F]/g, '')].length

/** Columns a drawing beneath takes on one row; the engine's own node draws `modes`, joined by ` & `. */
function widthOfNode (node: RenderNode | undefined, modes: readonly string[]): number {
  if (node === undefined || node === null) return 0
  if (typeof node === 'string') return widthOf(node)
  if (node.type === 'engine') return widthOf(modes.join(' & '))
  return (node.children ?? []).reduce((sum, child) => sum + widthOfNode(child, modes), 0)
}

/** Whether a drawing beneath holds another plugin's: the engine stamps each hook's root with its plugin. */
function holdsPlugin (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null || typeof node === 'string' || node.type === 'engine') return false
  return 'part' in node || (node.children ?? []).some(holdsPlugin)
}

/** Columns the footer leaves at its right end on the terminal, beside the mode label and the hint; elsewhere, no limit. */
function roomOf (e: { surface: string; viewport?: RenderViewport }) {
  if (e.surface !== 'terminal' || e.viewport === undefined) return Infinity
  return e.viewport.columns - FOOTER_PADDING - FOOTER_GAP - MODE_LABEL - (hintWidth > 0 ? 1 + hintWidth : 0)
}

const colorFor = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'claude')

/** "42m", "3h 5m", "2d 4h": how long until the window resets. */
function until (ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Keeps the latest reading for the meter, and for the next session until a response reports again. */
async function remember ($: EngineInterface, found: Limit[]) {
  if (found.length === 0) return
  await update($, limits, () => found)
  await $.store.set('limits', found)
}

export const register: Register = (on, options) => {
  const hideCycleHint = options.hideCycleHint !== false
  const hideInterruptHint = options.hideInterruptHint !== false
  const rotateSeconds = Number(options.rotateSeconds)
  const rotateMs = (rotateSeconds > 0 ? rotateSeconds : ROTATE_SECONDS) * 1000
  const hidden = [...(hideCycleHint ? [CYCLE_HINT] : []), ...(hideInterruptHint ? [INTERRUPT_HINT] : [])]

  /** The hint line without the parts hidden, and without the empty parts they leave. */
  function tidy (hint: string) {
    if (!hidden.some(part => part.test(hint))) return hint
    return hidden
      .reduce((line, part) => line.replace(part, ' · '), hint)
      .split('·')
      .map(part => part.trim())
      .filter(Boolean)
      .join(' · ')
  }

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('limits')
    if (Array.isArray(saved)) await update($, limits, () => saved as Limit[])

    const usage = await $.session.usage()
    await remember($, windowsOf(usage.rateLimits))

    $.clock.every(rotateMs, () => { void update($, view, n => n + 1) })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await remember($, windowsOf(e.rateLimits))
    return next(e)
  })

  // Bottom right of the prompt footer: the meter, then what is beneath it (the engine's mode labels,
  // another plugin's switch), so a plugin that draws itself last stays last whichever wraps the other.
  // Where the row is short the meter gives up its bar, then the time until the reset, then itself.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const all = await read($, limits)
    if (all.length === 0) return next(e)

    const now = await $.clock.now()
    const shown = all[(await read($, view)) % all.length]
    const resetsIn = shown.resetsAt === undefined ? undefined : Date.parse(shown.resetsAt) - now
    const hasReset = resetsIn !== undefined && resetsIn <= 0
    const percent = hasReset ? 0 : shown.percentUsed
    const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * CELLS)
    const beneath = await next(e)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)

    const label = LABELS[shown.kind] ?? shown.kind
    const used = ` ${Math.round(percent)}%`
    const reset = resetsIn !== undefined && !hasReset ? ` ↻ ${until(resetsIn)}` : ''
    const below = widthOfNode(beneath, e.props.modes)
    const room = roomOf(e) - (hasBeneath ? below + SEPARATOR.length : 0) - (holdsPlugin(beneath) ? 0 : AROUND)
    const given = holdsPlugin(beneath) ? Math.max(0, BENEATH_FLOOR - below) : 0
    const short = widthOf(label + used)
    const fit = [
      { hasBar: true, hasReset: true, width: short + 1 + CELLS + widthOf(reset) },
      { hasBar: false, hasReset: true, width: short + widthOf(reset) },
      { hasBar: false, hasReset: false, width: short }
    ].find(({ hasReset, width }) => width <= (hasReset ? room - given : room))
    if (!fit) return beneath

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row">
        <Text dimColor>{label}</Text>
        {fit.hasBar ? <Text color={colorFor(percent)}>{' ' + '━'.repeat(filled)}</Text> : null}
        {fit.hasBar ? <Text dimColor>{'─'.repeat(CELLS - filled)}</Text> : null}
        <Text>{used}</Text>
        {fit.hasReset && reset ? <Text dimColor>{reset}</Text> : null}
        {hasBeneath ? <Text dimColor>{SEPARATOR}</Text> : null}
        {beneath}
      </Box>
    )
  })

  // The engine draws the mode label itself; the hint line after it starts with "(shift+tab to cycle)",
  // and while Claude works holds "esc to interrupt". Its width tells the meter how much room is left.
  on('ui.render', { component: 'PromptHint' }, ($, e, next) => {
    const hint = tidy(e.props.hint)
    if (e.surface === 'terminal' && widthOf(hint) !== hintWidth) {
      hintWidth = widthOf(hint)
      $.ui.invalidate('ui.render')
    }
    return hint === e.props.hint ? next(e) : next({ ...e, props: { ...e.props, hint } })
  })
}
