// Mod tests, run against the engine itself: `claude plugin test .`
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { guessLanguage, parseNarration, plain } from './text'

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Spoken = { argv: string[]; env: Record<string, string>; isEnded: boolean }
type World = {
  system?: string
  env?: Record<string, string>
  reply?: string | null
  tools?: string
  voices?: string
  speaker?: 'speaks' | 'talks on' | 'fails'
  hasEngineVoice?: boolean
  store?: Record<string, unknown>
}

/**
 * Everything beneath the mod: the session, the store, the system and its synthesizers, the model
 * that writes the narration, and the engine's own `$.audio.speak`.
 */
function world (on: On, { system = 'Darwin', env = {}, reply = 'es\nHe añadido el narrador y los tests pasan.', tools = '', voices = '', speaker = 'speaks', hasEngineVoice = true, store = {} }: World = {}) {
  const clock = mock.clock(on, { now: 0 })
  const kept: Record<string, unknown> = { ...store }
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  mock.env(on, env)
  const spoken: Spoken[] = []
  const said: { text: string; voice?: string }[] = []
  const prompts: string[] = []
  const efforts: unknown[] = []
  const toasts: string[] = []
  let heard: () => void = () => undefined
  // Resolves when the next thing is said, by a program or by the engine.
  const nextSpeech = () => new Promise<void>(resolve => { heard = resolve })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: 'no plugin answered' }))
  // What the engine draws where the mod draws nothing
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    efforts.push(e.effort)
    return { value: reply === null ? { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } : { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  on('process.run', ($, e) => {
    const stdout = e.argv[0] === 'uname' ? `${system}\n` : e.argv[0] === 'sh' ? tools : e.argv.includes('-L') || e.argv.includes('--voices') ? voices : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // A speaker: it says which voice it speaks with, then `.` every tenth of a second while it talks.
  on('process.spawn', async function * ($, e) {
    const run: Spoken = { argv: [...e.argv], env: { ...e.env }, isEnded: false }
    spoken.push(run)
    try {
      if (speaker === 'fails') {
        yield { stream: 'stdout' as const, text: 'error: no voice\n' }
        return { value: { code: 1, signal: null } }
      }
      yield { stream: 'stdout' as const, text: 'pid 42\nvoice Luisa\n' }
      heard()
      while (speaker === 'talks on') {
        await clock.sleep(100)
        yield { stream: 'stdout' as const, text: '.\n' }
      }
      return { value: { code: 0, signal: null } }
    } finally {
      run.isEnded = true
    }
  })
  on('audio.speak', ($, e) => {
    heard()
    if (!hasEngineVoice) throw new Error('no synthesizer')
    said.push({ text: e.text, voice: e.voice })
    return { value: { via: 'system' as const } }
  })
  // Lets the work after a speech settle: a toast, a log.
  const settled = async () => {
    for (let i = 0; i < 20; i++) await clock.advance(0)
  }
  return { clock, store: kept, spoken, said, prompts, efforts, toasts, nextSpeech, settled }
}

/** An answer too long to be read as it is: the narrator has a model write what to say. */
const LONG = `Added the **narrator** in \`plugins/narrator\`. ${'It speaks after every turn, in your language, with the best voice the system has. '.repeat(3)}`
/** What follows the line every speaker waits in (sh -c <queue> narrator-line). */
const behindLine = (run: Spoken) => run.argv.slice(4)

const footer = ($: Engine, modes: string[] = []) =>
  $.ui.mount({ plugin: 'narrator', surface: 'terminal', component: 'SessionMode', props: { modes } })
const startSession = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const narrator = ($: Engine, args = '') => $.command.run({ command: 'narrator', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const turn = async ($: Engine, { prompt = 'add a narrator', answer = LONG, agentId, reason = 'answer' as const }: { prompt?: string; answer?: string; agentId?: string; reason?: 'answer' | 'aborted' } = {}) => {
  await $.turn.start({ text: prompt, turnId: 't1', agentId })
  await $.tool.call({ tool: 'Write', file_path: '/project/plugins/narrator/hooks/register.ts', content: 'x', agentId } as never)
  await $.tool.call({ tool: 'Bash', command: 'claude plugin test .', description: 'Run the mod tests', agentId } as never)
  await $.turn.complete({ answer, durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason, agentId })
}

test('off by default, the footer shows the switch off; a click turns it on and keeps it', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  expect(w.store.enabled).toBe(true)
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  expect(w.store.enabled).toBe(false)
})

test('/narrator switches it too, and the switch follows', async ($, on) => {
  const w = world(on)
  await startSession($)
  const ui = await footer($)
  expect((await narrator($)).text).toMatch(/^Narrator on/)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
  expect((await narrator($, 'off')).text).toBe('Narrator off.')
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏸︎ narrator off')
  expect((await narrator($, 'on')).text).toMatch(/^Narrator on/)
  expect(w.store.enabled).toBe(true)
})

test('a session starts with the narrator as the last one left it', async ($, on) => {
  world(on, { store: { enabled: true } })
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ key: 'narrator' }))?.text).toBe('⏵ narrator on')
})

test('the switch goes after the mode labels, and alone where there are none', async ($, on) => {
  world(on)
  await startSession($)
  const alone = await footer($)
  expect(await alone.find({ type: 'Text', text: ' · ' })).toBeUndefined()
  await alone.unmount()
  const labelled = await footer($, ['focus'])
  expect(await labelled.find({ key: 'engine' })).toBeDefined()
  expect(await labelled.find({ type: 'Text', text: ' · ' })).toBeDefined()
  expect(await labelled.find({ key: 'narrator' })).toBeDefined()
})

test('on reads in the success color, off in the inactive one', async ($, on) => {
  world(on)
  await startSession($)
  const ui = await footer($)
  expect((await ui.find({ type: 'Text', text: '⏸︎ narrator off' }))?.props.color).toBe('inactive')
  await ui.press({ key: 'narrator' })
  expect((await ui.find({ type: 'Text', text: '⏵ narrator on' }))?.props.color).toBe('success')
})

test('after a turn, Haiku writes what Claude did and macOS says it in the language Haiku names', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.prompts).toHaveLength(1)
  expect(w.efforts).toEqual(['low'])
  expect(w.prompts[0]).toContain('add a narrator')
  expect(w.prompts[0]).toContain('- Write: /project/plugins/narrator/hooks/register.ts')
  expect(w.prompts[0]).toContain('- Bash: Run the mod tests')
  expect(w.prompts[0]).toContain('Added the **narrator**')
  expect(w.spoken).toHaveLength(1)
  expect(behindLine(w.spoken[0]!).slice(0, 3)).toEqual(['osascript', '-l', 'JavaScript'])
  expect(w.spoken[0]!.env).toEqual({ NARRATOR_TEXT: 'He añadido el narrador y los tests pasan.', NARRATOR_LANG: 'es', NARRATOR_VOICE: '', NARRATOR_TICKET: '0000000000000' })
})

test('the voice setting reaches the speaker', { options: { voice: 'Mónica' } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.env.NARRATOR_VOICE).toBe('Mónica')
})

test("a subagent's turn and an interrupted turn are not narrated", async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  await turn($, { agentId: 'agent-1', answer: 'subagent report' })
  await turn($, { reason: 'aborted', answer: 'half done' })
  const speech = w.nextSpeech()
  await turn($, { answer: `all done. ${LONG}` })
  await speech
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts[0]).toContain('all done')
  expect(w.prompts[0]).not.toContain('subagent')
})

test('a new prompt silences the narration on its way', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.isEnded).toBe(false)
  await $.prompt.submit({ text: 'next task', wait: false, origin: { kind: 'composer' } })
  await w.clock.advance(100)
  expect(w.spoken[0]!.isEnded).toBe(true)
})

test('/narrator stop silences it and leaves it on', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'talks on' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect((await narrator($, 'stop')).text).toBe('Narrator: quiet.')
  await w.clock.advance(100)
  expect(w.spoken[0]!.isEnded).toBe(true)
  expect(w.store.enabled).toBe(true)
})

test('without a narration from the model, the answer itself is read, as plain text', async ($, on) => {
  const w = world(on, { store: { enabled: true }, reply: null })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { answer: 'He creado el **narrador** en `plugins/narrator` y los tests pasan para que lo pruebes.' })
  await speech
  expect(w.spoken[0]!.env.NARRATOR_TEXT).toBe('He creado el narrador en plugins/narrator y los tests pasan para que lo pruebes.')
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
})

test('Windows speaks through PowerShell', async ($, on) => {
  const w = world(on, { store: { enabled: true }, env: { OS: 'Windows_NT' } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(0, 2)).toEqual(['powershell', '-NoProfile'])
  expect(w.spoken[0]!.env.NARRATOR_LANG).toBe('es')
})

test("WSL speaks with Windows' voices, its variables crossing over", async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, tools: '/usr/bin/espeak-ng\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(behindLine(w.spoken[0]!)[0]).toBe('powershell.exe')
  expect(w.spoken[0]!.env.WSLENV).toBe('NARRATOR_TEXT/u:NARRATOR_LANG/u:NARRATOR_VOICE/u')
})

test('Linux speaks with speech-dispatcher in the language Haiku names', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', tools: '/usr/bin/spd-say\n/usr/bin/espeak-ng\n', voices: 'NAME LANGUAGE VARIANT\nSpanish es none\nEnglish en-us none\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(w.spoken[0]!.argv.slice(7)).toEqual(['narrator', 'spd-say', '-w', '-l', 'es', '--', 'He añadido el narrador y los tests pasan.'])
  expect(w.spoken[0]!.env.NARRATOR_STOP).toBe('spd-say -S')
})

test('a language the synthesizer has no voice for is read in English', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', tools: '/usr/bin/espeak-ng\n', voices: 'Pty Language Age/Gender VoiceName File\n 5  en-us --/M English_(America) gmw/en-US\n 5  fr-fr --/M French gmw/fr\n' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(7)).toEqual(['narrator', 'espeak-ng', '-v', 'en', '--', 'He añadido el narrador y los tests pasan.'])
})

test('where no speaker works, the engine speaks; where it cannot either, a toast says what to install', async ($, on) => {
  const w = world(on, { store: { enabled: true }, speaker: 'fails' })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.said).toEqual([{ text: 'He añadido el narrador y los tests pasan.', voice: undefined }])
  expect(w.toasts).toEqual([])
})

test('a Linux with no synthesizer says what to install, once', async ($, on) => {
  const w = world(on, { store: { enabled: true }, system: 'Linux', hasEngineVoice: false })
  await startSession($)
  for (const answer of ['first', 'second']) {
    const speech = w.nextSpeech()
    await turn($, { answer })
    await speech
    await w.settled()
  }
  expect(w.spoken).toEqual([])
  expect(w.toasts).toEqual(['Narrator: no voice to speak with. Install speech-dispatcher (spd-say) or espeak-ng.'])
})

test('the narration is read as plain text, in the language it names', () => {
  expect(parseNarration('es\nHe cambiado el **archivo** `register.ts`.')).toEqual({ language: 'es', text: 'He cambiado el archivo register.ts.' })
  expect(parseNarration('"en"\n\nI fixed the tests.')).toEqual({ language: 'en', text: 'I fixed the tests.' })
  expect(parseNarration('He arreglado los tests y ahora todo pasa en la rama principal.').language).toBe('es')
  expect(plain('## Done\n- one\n- two [link](https://x.dev)\n```ts\ncode\n```\nend')).toBe('Done one two link end')
  expect(guessLanguage('ok')).toBe('')
})

test('a short answer is read as it is, with no model call', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { answer: 'Hecho: los tests pasan y el **narrador** habla.' })
  await speech
  expect(w.prompts).toHaveLength(0)
  expect(w.spoken[0]!.env.NARRATOR_TEXT).toBe('Hecho: los tests pasan y el narrador habla.')
})

test('shortAnswer 0 narrates every answer', { options: { shortAnswer: 0 } }, async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($, { answer: 'all done' })
  await speech
  expect(w.prompts).toHaveLength(1)
})

test('every speaker waits in the line shared by all windows, except on Windows', async ($, on) => {
  const w = world(on, { store: { enabled: true } })
  await startSession($)
  const speech = w.nextSpeech()
  await turn($)
  await speech
  expect(w.spoken[0]!.argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(w.spoken[0]!.argv[3]).toBe('narrator-line')
  expect(w.spoken[0]!.env.NARRATOR_TICKET).toMatch(/^\d{13}$/)
})
