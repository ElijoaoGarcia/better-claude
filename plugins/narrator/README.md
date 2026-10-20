# Narrator

A Claude Code mod: click `⏸︎ narrator off` at the bottom right of the prompt, or type `/narrator`, and after each turn Claude tells you out loud what it did, in your language, with the best free voice your system has.

```text
❯ _
  ? for shortcuts                                   ⏵ narrator on
```

The switch reads like the footer's mode labels (`⏵⏵ auto mode on`), in quiet colors: `⏵ narrator on` in green, `⏸︎ narrator off` in gray. A click switches it (in fullscreen, where the terminal reports clicks); `/narrator` does it anywhere.

When a turn ends, Haiku (at low effort, so it is quick) reads your request, the tools Claude used and its final message, and writes a few spoken sentences in first person ("I added the narrator and the tests pass"), in the language you wrote in. Haiku also names that language, and the mod picks the best voice installed for it; where there is none, the English one. A short answer already says it, so it is read out as it is, with no Haiku call: a path by its file's name (`hooks/register.tsx`: "register") and no commit hashes, in the language its words or your request tell, else the one the last narration was in (on Windows and Linux, Haiku narrates it while neither tells; macOS tells the language from the text).

| System | Voice |
| --- | --- |
| macOS | AVSpeechSynthesizer: Siri's natural voices first, then premium, enhanced and compact ones, in your region (`say` cannot reach Siri's) |
| Windows | Windows.Media.SpeechSynthesis, the OneCore voices Narrator uses; the desktop SAPI voices where WinRT does not load |
| WSL | Windows' voices, through `powershell.exe`; Linux's where that does not run |
| Linux | `spd-say` (speech-dispatcher, with whatever module it is set up with: espeak-ng, RHVoice, Piper...), else `espeak-ng` or `espeak` |

A new prompt cuts the narration short. It stays on in your next sessions until you switch it off.

```text
/narrator         switch on or off
/narrator on|off
/narrator stop    quiet now, stay on
```

### Better voices

- **macOS**: System Settings → Accessibility → Spoken Content → System voice → Manage Voices, and download a Siri voice or a Premium one for your language.
- **Windows**: Settings → Time & language → Speech → Add voices.
- **Linux**: `sudo apt install speech-dispatcher espeak-ng`; for natural voices, set speech-dispatcher up with RHVoice or Piper.

## Install

```text
/plugin marketplace add midudev/better-claude
/plugin install narrator@better-claude
```

## Settings

In `/config`:

- **Voice**: a voice's name (`Mónica`, `Microsoft Helena`) to always speak with. Empty: the best one for the language.
- **Speed**: how fast it speaks, as a multiple of the voice's normal pace, from `0.5` to `2`: `1.2` by default, a little quicker; `1` is the voice's own. The engine's voice, the last resort, keeps its own pace.
- **Read short answers as they are**: an answer up to this many characters (200 by default) is read out as it is, with no Haiku call to retell it. `0`: Haiku narrates every answer.
- **Model that writes the narration**: `haiku` by default.

## Several windows

Every window shares one line, a folder in your temp directory: when two sessions finish together, their narrations are said one after the other, in the order they were ready. On Windows the line is Windows' own, and WSL's windows share it. One that would wait behind three others, or for two minutes, is dropped. A window that closes never holds the line. A new prompt, `/narrator stop` or switching it off cuts a narration short, also while it waits its turn.

## How it works

One hooks module ([`hooks/register.tsx`](hooks/register.tsx)): a `ui.render` hook on the footer's `SessionMode` draws the switch as a Button, `turn.start` and `tool.call` note the request and each tool call of the main loop, and `turn.complete` asks the model for the narration and hands it to a speaker ([`hooks/speaker.ts`](hooks/speaker.ts)): JavaScript for Automation on macOS, PowerShell on Windows, a shell wrapper on Linux. Each writes a `.` while it speaks, so the mod can end it the moment you send a new prompt. Where none works, the engine's own `$.audio.speak`.

## Development

```bash
claude plugin validate .   # from this folder
claude plugin test .       # runs hooks/register.test.tsx against the engine
```

MIT © Miguel Ángel Durán (midudev)
