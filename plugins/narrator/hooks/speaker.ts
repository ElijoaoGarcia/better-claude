// The programs that speak a narration: one a system, each the best free voice that system has. Each
// reads NARRATOR_TEXT, what to say; NARRATOR_LANG, its language as an ISO 639-1 code (empty: the
// program tells, or uses its default); and NARRATOR_VOICE, a voice's name (empty: the best one for
// the language, English's when the language has none); and NARRATOR_SPEED, how fast (1: the voice's
// normal pace). Each writes `voice <name>` once it speaks, or a line starting `error`, then a `.`
// every tenth of a second while it speaks, so the one reading it is woken to end it.

/**
 * macOS: JavaScript for Automation, run by `osascript`, with AVSpeechSynthesizer, which reaches the
 * Siri voices (`say` does not). An empty NARRATOR_LANG is told from the text.
 */
export const MACOS = String.raw`
ObjC.import('AVFoundation')
ObjC.import('NaturalLanguage')

function run () {
  const env = $.NSProcessInfo.processInfo.environment
  const read = key => { const value = env.objectForKey(key); return value.isNil() ? '' : ObjC.unwrap(value) }
  const say = text => $.NSFileHandle.fileHandleWithStandardOutput.writeData($(text + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
  const text = read('NARRATOR_TEXT')
  const wanted = read('NARRATOR_VOICE').toLowerCase()
  const speed = Number(read('NARRATOR_SPEED')) || 1
  if (!text) return

  const found = $.NLLanguageRecognizer.dominantLanguageForString(text)
  const language = read('NARRATOR_LANG').toLowerCase().split('-')[0] || (found.isNil() ? 'en' : ObjC.unwrap(found))

  const all = $.AVSpeechSynthesisVoice.speechVoices
  const voices = []
  for (let i = 0; i < all.count; i++) {
    const voice = all.objectAtIndex(i)
    voices.push({ voice, id: ObjC.unwrap(voice.identifier), name: ObjC.unwrap(voice.name), lang: ObjC.unwrap(voice.language), quality: Number(voice.quality) })
  }

  // The regions to prefer for a language: the person's own (es-MX before es-ES), then the usual one.
  const regionsFor = language => {
    const regions = []
    const preferred = $.NSLocale.preferredLanguages
    for (let i = 0; i < preferred.count; i++) {
      const [lang, region] = ObjC.unwrap(preferred.objectAtIndex(i)).split('-')
      if (lang === language && region) regions.push(region)
    }
    const country = $.NSLocale.currentLocale.countryCode
    if (!country.isNil()) regions.push(ObjC.unwrap(country))
    regions.push({ de: 'DE', en: 'US', es: 'ES', fr: 'FR', it: 'IT', ja: 'JP', pt: 'BR', zh: 'CN' }[language] || '')
    return regions
  }
  // Siri's natural voices first, then premium over enhanced over compact, then the preferred region.
  // The novelty voices (Bahh, Grandpa...) come last.
  const best = language => {
    const regions = regionsFor(language)
    const near = v => { const at = regions.indexOf(v.lang.split('-')[1]); return at < 0 ? 0 : 50 - at * 10 }
    const score = v =>
      (v.id.includes('.siri.') ? 1000 : 0) + v.quality * 100 + near(v) - (v.id.includes('.super-compact.') ? 1 : 0) -
      (/\.(speech\.synthesis|eloquence)\./.test(v.id) ? 10000 : 0)
    return voices.filter(v => v.lang.split('-')[0] === language).sort((a, b) => score(b) - score(a))[0]
  }
  const named = wanted && voices.sort((a, b) => b.quality - a.quality).find(v => v.id.toLowerCase() === wanted || v.name.toLowerCase() === wanted)
  const picked = named || best(language) || best('en')

  const synth = $.AVSpeechSynthesizer.alloc.init
  const utterance = $.AVSpeechUtterance.speechUtteranceWithString(text)
  if (picked) utterance.voice = picked.voice
  // The voice's normal pace is a rate of 0.5; measured, each 0.1 above it speaks 0.6 times faster and
  // each 0.1 below 0.088 slower, the same for Siri's voices and the compact ones.
  utterance.rate = Math.min(Math.max(speed >= 1 ? 0.5 + (speed - 1) / 6 : 0.5 - (1 - speed) / 0.88, 0), 1)
  say('voice ' + (picked ? picked.id : 'default'))
  synth.speakUtterance(utterance)

  const loop = $.NSRunLoop.currentRunLoop
  let started = false
  for (let i = 0; i < 6000; i++) {
    loop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))
    say('.')
    if (synth.speaking) started = true
    else if (started || i > 30) break
  }
  if (!started) say('error: the synthesizer did not speak')
}
`

/**
 * Windows (and WSL, through `powershell.exe`): the OneCore voices of Windows.Media.SpeechSynthesis,
 * the ones Narrator uses, played from memory; where WinRT cannot load, the desktop SAPI voices of
 * System.Speech. It also writes `pid <n>`, so WSL, whose end of the pipe cannot end it, can.
 */
export const WINDOWS = String.raw`
$ErrorActionPreference = 'Stop'
$text = $env:NARRATOR_TEXT
$language = "$env:NARRATOR_LANG".ToLower().Split('-')[0]
$wanted = "$env:NARRATOR_VOICE"
# Read with a dot whatever the region's decimal mark.
$speed = 0.0
$null = [double]::TryParse("$env:NARRATOR_SPEED", [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$speed)
if ($speed -le 0) { $speed = 1.0 }
if (-not $text) { exit 0 }
$region = (Get-Culture).Name
function Say($line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
Say "pid $PID"

# Among voices given as Name, Language and Item: the one named; else the language's, the person's
# region first; else English's, en-US first.
function Pick($voices) {
  if ($wanted) {
    $named = @($voices | Where-Object { $_.Name -eq $wanted -or $_.Name -like "*$wanted*" })
    if ($named.Count -gt 0) { return $named[0] }
  }
  foreach ($lang in @($language, 'en')) {
    if (-not $lang) { continue }
    $matching = @($voices | Where-Object { $_.Language.ToLower().Split('-')[0] -eq $lang })
    if ($matching.Count -eq 0) { continue }
    $preferred = if ($lang -eq $language) { $region } else { 'en-US' }
    $near = @($matching | Where-Object { $_.Language -eq $preferred })
    if ($near.Count -gt 0) { return $near[0] }
    return $matching[0]
  }
  return $null
}

$script:isSpeaking = $false

function Speak-OneCore {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
  $synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
  $voices = @([Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | ForEach-Object { [pscustomobject]@{ Name = $_.DisplayName; Language = $_.Language; Item = $_ } })
  $picked = Pick $voices
  if ($picked) { $synth.Voice = $picked.Item }
  # A multiple of the voice's pace, from 0.5 to 6 (Windows 10 1803 on).
  if ($synth.Options) { $synth.Options.SpeakingRate = [Math]::Min([Math]::Max($speed, 0.5), 6) }
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' } | Select-Object -First 1
  $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($synth.SynthesizeTextToStreamAsync($text)))
  $null = $task.Wait(-1)
  $wav = New-Object System.IO.MemoryStream
  [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result.GetInputStreamAt(0)).CopyTo($wav)
  $bytes = $wav.ToArray()
  # How long it plays: the data after the 44-byte header, at the header's bytes per second.
  $seconds = ($bytes.Length - 44) / [Math]::Max([BitConverter]::ToInt32($bytes, 28), 1)
  $wav.Position = 0
  $player = New-Object System.Media.SoundPlayer($wav)
  $player.Load()
  $name = if ($picked) { $picked.Name } else { $synth.Voice.DisplayName }
  $script:isSpeaking = $true
  Say "voice $name"
  $player.Play()
  $end = (Get-Date).AddSeconds($seconds + 0.3)
  while ((Get-Date) -lt $end) { Start-Sleep -Milliseconds 100; Say '.' }
}

function Speak-Sapi {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { [pscustomobject]@{ Name = $_.VoiceInfo.Name; Language = $_.VoiceInfo.Culture.Name; Item = $_ } })
  $picked = Pick $voices
  if ($picked) { $synth.SelectVoice($picked.Name) }
  # From -10 to 10, each end about three times slower or faster than the voice's pace.
  $synth.Rate = [int][Math]::Max(-10, [Math]::Min(10, [Math]::Round(10 * [Math]::Log($speed) / [Math]::Log(3))))
  $script:isSpeaking = $true
  Say "voice $($synth.Voice.Name)"
  $spoken = $synth.SpeakAsync($text)
  while (-not $spoken.IsCompleted) { Start-Sleep -Milliseconds 100; Say '.' }
}

try {
  Speak-OneCore
} catch {
  if ($script:isSpeaking) { exit 0 }
  try { Speak-Sapi } catch { if (-not $script:isSpeaking) { Say "error: $($_.Exception.Message)" } }
}
`

/**
 * Linux: runs the synthesizer given as its arguments (spd-say, which speaks with whatever voice
 * speech-dispatcher is set up with, or espeak-ng), writing a `.` while it runs. Ended, or once
 * nobody reads, it ends the synthesizer and runs NARRATOR_STOP, which silences speech-dispatcher.
 */
export const LINUX = String.raw`
"$@" &
pid=$!
stop () {
  kill "$pid" 2>/dev/null
  if [ -n "$NARRATOR_STOP" ]; then $NARRATOR_STOP >/dev/null 2>&1; fi
  exit 0
}
trap stop TERM INT HUP PIPE
echo "voice $1"
while kill -0 "$pid" 2>/dev/null; do
  echo . 2>/dev/null || stop
  sleep 0.1
done
wait "$pid" || echo "error: $1 failed"
`

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * speech-dispatcher's rate for a speed, from -100 to 100, as its espeak-ng module reads it: 0 is 170
 * words a minute, -100 is 80 and 100 is 449.
 */
export const dispatcherRate = (speed: number) => Math.round(clamp(((speed - 1) * 170 * 100) / (speed >= 1 ? 279 : 90), -100, 100))

/** espeak's words a minute for a speed: 175 at its normal pace, within the 80 to 450 it takes. */
export const espeakWords = (speed: number) => Math.round(clamp(175 * speed, 80, 450))

/** A PowerShell script as `-EncodedCommand` takes it: UTF-16LE, base64. */
export function encodedCommand (script: string) {
  const bytes = new Uint8Array(script.length * 2)
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i)
    bytes[i * 2] = code & 0xff
    bytes[i * 2 + 1] = code >> 8
  }
  return bytes.toBase64()
}

/** How PowerShell runs one of these scripts: no profile, no prompts, no script policy in the way. */
export const powershell = (script: string, program = 'powershell') => [program, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(script)]

/**
 * The line every speaker waits in, on macOS and Linux, shared by every window. Each narration
 * takes a ticket (NARRATOR_TICKET, the time it was ready, then its own process id) in a folder
 * all the sessions see, and speaks once its is the oldest of the live ones: a ticket whose
 * process is gone, or that is older than a quarter of an hour (its process id may have been reused), is thrown away, so a window that was closed never holds the line. The folder is the user's own, so nobody else's tickets get in the way. The speaker
 * replaces this shell (`exec`), so the ticket lives exactly as long as the speech. A narration
 * that would wait behind three others, or for two minutes, is not said: it prints `skipped`.
 */
export const QUEUE = String.raw`
base=$TMPDIR
[ -n "$base" ] || base=/tmp
dir="$base/claude-narrator-queue-$(id -u)"
mkdir -p "$dir" 2>/dev/null || exec "$@"
mine="$dir/$NARRATOR_TICKET-$$"
: > "$mine" 2>/dev/null || exec "$@"
now=$(date +%s)
tries=0
while :; do
  ahead=0
  for f in "$dir"/*; do
    [ -e "$f" ] || continue
    owner=$(echo "$f" | sed 's/.*-//')
    born=$(echo "$f" | sed 's|.*/||; s/-.*//')
    # Gone: its process has ended, or it is older than any speech lasts (a reused process id).
    if ! kill -0 "$owner" 2>/dev/null || [ $((now - born / 1000)) -gt 900 ]; then rm -f "$f"; continue; fi
    [ "$f" = "$mine" ] && break
    ahead=$((ahead + 1))
  done
  [ "$ahead" -eq 0 ] && exec "$@"
  tries=$((tries + 1))
  now=$(date +%s)
  if [ "$ahead" -ge 3 ] || [ "$tries" -gt 400 ]; then
    rm -f "$mine"
    echo skipped
    exit 0
  fi
  sleep 0.3
done
`
