import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import { LINUX, MACOS, QUEUE, WINDOWS, dispatcherRate, espeakWords, powershell } from './speaker'
import { cut, guessLanguage, parseNarration, plain } from './text'

type Platform = 'macos' | 'windows' | 'linux' | 'other'
/** A program that speaks, and what it is told through its environment. */
type Command = { argv: string[]; env: Record<string, string>; program: string }
/** One narration: the model call that writes it, then the program that speaks it, until silenced. */
type Narration = { isActive: boolean; abort: AbortController }
/** The synthesizer found on Linux and the languages it has voices for (empty: it did not say). */
type LinuxSpeech = { tool?: 'spd-say' | 'espeak-ng' | 'espeak'; languages: Set<string> }

// The switch at the right of the prompt footer, in the style of the mode labels (⏵⏵ auto mode on),
// each in a quiet color. U+FE0E keeps the pause sign a text glyph, never an emoji.
const SWITCH_ON = { label: '\u23F5 narrator on', color: 'success' } as const
const SWITCH_OFF = { label: '\u23F8\uFE0E narrator off', color: 'inactive' } as const
// A little quicker than the voice's normal pace, unless the settings say otherwise.
const SPEED = 1.2
const MAX_ACTIONS = 40
// The tool inputs that say best what a call did, in order of preference.
const DETAILS = ['description', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'command', 'prompt']
const LANGUAGE_CODE = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i
const NARRATOR = `You are the voice of Claude Code, a coding assistant. After each of its turns you tell the user, out loud, what Claude just did, speaking as Claude in the first person.

You get the user's request, the actions Claude took and Claude's final message. Say what a colleague would say to explain it: what was done, how it turned out, and anything the user has to do or decide now. If Claude only answered a question, give the gist of the answer.

Speak the language the user wrote the request in; if that is unclear, the language of Claude's final message.

Rules:
- A speech synthesizer reads it aloud: plain sentences only. No markdown, lists, emojis or code, and no file paths, URLs, hashes or version strings read out character by character: name files and commands the way a person says them ("the register file", "the tests").
- One sentence for a small answer, up to five for a large change; never more than 90 words.
- No preamble ("Sure", "In summary"), no questions back, nothing Claude did not say or do.

Reply in exactly this form: the first line holds only the ISO 639-1 code of the language you speak (es, en, pt, fr...), and the narration starts on the second line.`

const enabled = atom({ plugin: 'narrator', key: 'isEnabled' } as const, false)

/** An answer this short is read out as it is: no model call to write a narration of it. */
const SHORT_ANSWER = 200

let settings = { voice: '', model: 'haiku', speed: SPEED, shortAnswer: SHORT_ANSWER }
// The main loop's turn so far: the prompt that started it and each tool call it made.
let request = ''
let actions: string[] = []
let current: Narration | undefined
let platform: Promise<Platform> | undefined
let wsl: Promise<boolean> | undefined
let linuxSpeech: Promise<LinuxSpeech> | undefined
let hasWarned = false

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One tool call as a line the narrator reads: its tool, then the input that says most. */
function describe (e: object) {
  const input = e as Record<string, unknown>
  const detail = DETAILS.map(key => input[key]).find(value => typeof value === 'string' && value.trim() !== '')
  return detail === undefined ? String(input.tool) : `${String(input.tool)}: ${cut(String(detail).replace(/\s+/g, ' '), 200)}`
}

/** What the narrator is told about the turn. */
function brief (answer: string) {
  const did = actions.length > 0 ? actions.map(action => `- ${action}`).join('\n') : '(no tools: Claude only answered)'
  return [
    `The user's request:\n<request>\n${cut(request, 2000) || '(none: Claude went on by itself)'}\n</request>`,
    `What Claude did, in order:\n${did}`,
    `Claude's final message to the user:\n<message>\n${cut(answer, 6000)}\n</message>`
  ].join('\n\n')
}

/** The system the session runs on, asked once. */
function platformOf ($: EngineInterface) {
  platform ??= (async (): Promise<Platform> => {
    if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
    const name = (await $.process.run(['uname', '-s']).catch(() => undefined))?.stdout.trim()
    return name === 'Darwin' ? 'macos' : name === 'Linux' ? 'linux' : 'other'
  })()
  return platform
}

/** Whether the session runs under WSL: Linux, on a Windows desktop whose voices are better. */
function wslOf ($: EngineInterface) {
  wsl ??= (async () => (await platformOf($)) === 'linux' && (await $.env.get('WSL_DISTRO_NAME')) !== undefined)()
  return wsl
}

/** The language codes listed in a synthesizer's voice table, by their main part (`es` for es-419). */
function languagesIn (table: string) {
  const languages = new Set<string>()
  for (const line of table.split('\n').slice(1)) {
    const code = line.trim().split(/\s+/).slice(1).find(word => LANGUAGE_CODE.test(word))
    if (code) languages.add(code.split(/[-_]/)[0]!.toLowerCase())
  }
  return languages
}

/** Which synthesizer Linux has, speech-dispatcher first, and its languages, asked once. */
function linuxSpeechOf ($: EngineInterface) {
  linuxSpeech ??= (async (): Promise<LinuxSpeech> => {
    const found = (await $.process.run(['sh', '-c', 'command -v spd-say espeak-ng espeak']).catch(() => undefined))?.stdout ?? ''
    const paths = found.split('\n').map(path => path.trim())
    const tool = (['spd-say', 'espeak-ng', 'espeak'] as const).find(name => paths.some(path => path.endsWith(`/${name}`)))
    if (!tool) return { languages: new Set() }
    const listed = await $.process.run(tool === 'spd-say' ? ['spd-say', '-L'] : [tool, '--voices'], { timeoutMs: 5000 }).catch(() => undefined)
    return { tool, languages: languagesIn(listed?.stdout ?? '') }
  })()
  return linuxSpeech
}

/** The programs that can say `text` here, best first. */
async function speakersFor ($: EngineInterface, text: string, language: string): Promise<Command[]> {
  const env = { NARRATOR_TEXT: text, NARRATOR_LANG: language, NARRATOR_VOICE: settings.voice, NARRATOR_SPEED: String(settings.speed) }
  const system = await platformOf($)
  if (system === 'macos') return [{ argv: ['osascript', '-l', 'JavaScript', '-e', MACOS], env, program: 'osascript' }]
  if (system === 'windows') return [{ argv: powershell(WINDOWS), env, program: 'powershell' }]
  if (system !== 'linux') return []

  const speakers: Command[] = []
  if (await wslOf($)) {
    const inherited = await $.env.get('WSLENV')
    const crossing = [inherited, 'NARRATOR_TEXT/u', 'NARRATOR_LANG/u', 'NARRATOR_VOICE/u', 'NARRATOR_SPEED/u'].filter(Boolean).join(':')
    speakers.push({ argv: powershell(WINDOWS, 'powershell.exe'), env: { ...env, WSLENV: crossing }, program: 'powershell.exe' })
  }
  const { tool, languages } = await linuxSpeechOf($)
  // A language the synthesizer has no voice for is read by its English voice.
  const lang = language && (languages.size === 0 || languages.has(language) ? language : 'en')
  // At speed 1 no rate is given: the synthesizer keeps the one it is set up with.
  const isPaced = settings.speed !== 1
  if (tool === 'spd-say') {
    const options = [...(lang ? ['-l', lang] : []), ...(settings.voice ? ['-y', settings.voice] : []), ...(isPaced ? ['-r', String(dispatcherRate(settings.speed))] : [])]
    speakers.push({ argv: ['sh', '-c', LINUX, 'narrator', 'spd-say', '-w', ...options, '--', text], env: { ...env, NARRATOR_STOP: 'spd-say -S' }, program: 'spd-say' })
  } else if (tool) {
    const voice = settings.voice || lang
    const options = [...(voice ? ['-v', voice] : []), ...(isPaced ? ['-s', String(espeakWords(settings.speed))] : [])]
    speakers.push({ argv: ['sh', '-c', LINUX, 'narrator', tool, ...options, '--', text], env, program: tool })
  }
  return speakers
}

/** Runs one speaker till it ends or the narration is silenced; whether it spoke. */
async function play ($: EngineInterface, narration: Narration, command: Command) {
  let said = ''
  let failure = ''
  try {
    for await (const { text } of $.process.spawn(command)) {
      said = (said + text.replace(/^\.\r?$/gm, '')).slice(-4000)
      if (!narration.isActive) break
    }
  } catch (error) {
    failure = message(error)
  }
  const voice = /^voice (.+?)\r?$/m.exec(said)?.[1]
  // Behind others for too long: the line dropped it, and nothing else should say it now.
  if (/^skipped\r?$/m.test(said)) {
    $.ui.log('narrator: not said, the line of narrations from other sessions was too long', { to: 'debug' })
    return true
  }
  failure ||= /^error.*$/m.exec(said)?.[0] ?? (voice ? '' : `${command.program} said nothing`)
  // Under WSL the Windows side outlives its end of the pipe: end it by its id.
  const pid = /^pid (\d+)/m.exec(said)?.[1]
  if (!narration.isActive && pid && command.program === 'powershell.exe') {
    await $.process.run(['taskkill.exe', '/PID', pid, '/T', '/F']).catch(() => undefined)
  }
  if (!narration.isActive) return true
  $.ui.log(failure ? `narrator: ${command.program}: ${failure}` : `narrator: spoke with ${voice}`, { to: 'debug' })
  return failure === ''
}

/** Says `text` with the best speaker that works here, the engine's own synthesizer last. */
async function speak ($: EngineInterface, narration: Narration, text: string, language: string) {
  const line = (await platformOf($)) !== 'windows'
  const ticket = String(await $.clock.now()).padStart(13, '0')
  for (const speaker of await speakersFor($, text, language)) {
    // Every window shares one line, so two sessions that finish together are said one after the other.
    const command: Command = line
      ? { ...speaker, argv: ['sh', '-c', QUEUE, 'narrator-line', ...speaker.argv], env: { ...speaker.env, NARRATOR_TICKET: ticket } }
      : speaker
    if (await play($, narration, command)) return
    if (!narration.isActive) return
  }
  try {
    await $.audio.speak(text, settings.voice ? { voice: settings.voice } : undefined)
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
    if (hasWarned) return
    hasWarned = true
    const system = await platformOf($)
    $.ui.toast(system === 'linux'
      ? 'Narrator: no voice to speak with. Install speech-dispatcher (spd-say) or espeak-ng.'
      : `Narrator: no voice to speak with (${message(error)}).`)
  }
}

/** Stops what is being said, and the narration being written. */
function silence () {
  if (!current) return
  current.isActive = false
  current.abort.abort()
  current = undefined
}

/** Tells, out loud, what the turn that ended with `answer` did. */
async function narrate ($: EngineInterface, answer: string) {
  silence()
  const narration: Narration = { isActive: true, abort: new AbortController() }
  current = narration
  try {
    // A short answer already says it: read it out, with no model call to retell it.
    const direct = plain(answer)
    const isShort = settings.shortAnswer > 0 && direct !== '' && direct.length <= settings.shortAnswer
    const reply = isShort ? undefined : await $.model.complete(
      // A short summary: no deep thinking, so it is said right after the turn.
      { model: settings.model, system: NARRATOR, prompt: brief(answer), maxTokens: 400, effort: 'low', timeoutMs: 30_000 },
      { signal: narration.abort.signal }
    ).catch(() => undefined)
    if (!narration.isActive) return
    const told = reply?.isAnswered ? parseNarration(reply.text) : undefined
    if (isShort) return await speak($, narration, direct, guessLanguage(answer))
    // No narration written: the answer itself, as far as it reads aloud.
    const { text, language } = told?.text ? told : { text: cut(plain(answer), 600), language: guessLanguage(answer) }
    if (text) await speak($, narration, text, language)
  } catch (error) {
    $.ui.log(`narrator: ${message(error)}`, { to: 'debug' })
  } finally {
    if (current === narration) current = undefined
  }
}

/** Switches the narrator on or off (no `value`: the other way), and keeps it for the next sessions. */
async function setEnabled ($: EngineInterface, value?: boolean) {
  let isEnabled = false
  await update($, enabled, now => (isEnabled = value ?? !now))
  if (!isEnabled) silence()
  await $.store.set('enabled', isEnabled)
  return isEnabled
}

/** Whether a drawing beneath shows nothing: no text, no control (the engine's own node draws `modes`, counted apart). */
function isBlank (node: RenderNode | undefined): boolean {
  if (node === undefined || node === null) return true
  if (typeof node === 'string') return node.trim() === ''
  if (node.type === 'engine') return true
  return (node.type === 'Box' || node.type === 'Text') && (node.children ?? []).every(isBlank)
}

export const register: Register = (on, options) => {
  const speed = Number(options.speed)
  settings = {
    voice: String(options.voice ?? '').trim(),
    model: String(options.model || 'haiku'),
    speed: speed > 0 ? speed : SPEED,
    shortAnswer: Number.isFinite(Number(options.shortAnswer)) && options.shortAnswer !== '' && options.shortAnswer != null ? Math.max(0, Number(options.shortAnswer)) : SHORT_ANSWER
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'narrator',
      description: 'Claude tells you out loud what it did after each turn · no argument: switch on or off',
      argumentHint: '[on | off | stop]',
      immediate: true
    })
    const isEnabled = (await $.store.get('enabled')) === true
    await update($, enabled, () => isEnabled)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    silence()
    return next(e)
  })

  on('command.run', { command: 'narrator' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      silence()
      return { text: 'Narrator: quiet.' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: 'Usage: /narrator [on | off | stop]' }
    const isEnabled = await setEnabled($, arg === '' ? undefined : arg === 'on')
    return { text: isEnabled ? 'Narrator on: Claude will tell you out loud what it did after each turn.' : 'Narrator off.' }
  })

  // A new prompt means the person has moved on: stop talking.
  on('prompt.submit', ($, e, next) => {
    silence()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.text) request = e.text
      actions = []
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && actions.length < MAX_ACTIONS && (await read($, enabled))) {
      actions.push(describe(e) + (result.deny !== undefined ? ' (denied)' : result.isError ? ' (failed)' : ''))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer.trim() && (await read($, enabled))) void narrate($, e.answer)
    return result
  })

  // The switch, last in the footer's right end: a click turns the narrator on or off.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const isEnabled = await read($, enabled)
    // Beneath: the engine's mode labels, or another plugin's drawing there.
    const beneath = await next(e)
    const hasBeneath = e.props.modes.length > 0 || !isBlank(beneath)
    const { Box, Button, Text } = $.ui.resolve(e)
    const { label, color } = isEnabled ? SWITCH_ON : SWITCH_OFF

    return (
      <Box flexDirection="row">
        {hasBeneath ? beneath : null}
        {hasBeneath ? <Text dimColor> · </Text> : null}
        <Button key="narrator" plain onPress={() => void setEnabled($)}>
          <Text color={color}>{label}</Text>
        </Button>
      </Box>
    )
  })
}
