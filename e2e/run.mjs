// End-to-end run in headless Chrome, in a fresh profile, with a fake microphone playing the fixed
// voice (`fixtures/media/voice.wav`):
//
// 1. Open the page, drop the voice's WAV into it, type its transcript and an English text, and
//    press Speak while the model is still loading: the request is queued and runs the moment the
//    model is ready (measures page open → first audio). Checks: speech came out, nothing was
//    requested after the model was ready, the WAV the page offers is intelligible (faster-whisper
//    word error rate) and the speech sounds like the voice (the page's voice match).
// 2. Save the voice under a name, clear the transcript, pick Chinese and speak with the model
//    warm (measures click → first audio and the real-time factor): intelligible (character error
//    rate), alike, no requests.
// 3. Record four seconds from the microphone: the page takes the recording as the voice, and
//    speaks English in it.
// 4. Reload: the revisit must load every part from OPFS, and the saved voice must be there.
//
//   ASR_PYTHON=<python with faster-whisper> PORT=8787 node e2e/run.mjs [--threads 8] [--build web-threaded]
//   node e2e/run.mjs --url https://example.org    # a deployed page, no local server
//
// The intelligibility check needs ASR_PYTHON, a Python with faster-whisper (scripts/asr_check.py);
// without it the run fails, unless --skip-asr says to accept a run without that check.
// Results (JSON, WAVs, screenshots) go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOICE = join(ROOT, 'fixtures/media/voice.wav');
const CASES = JSON.parse(readFileSync(join(ROOT, 'fixtures/cases.json'), 'utf8'));
const TRANSCRIPT = CASES.icl_english.reference_text;
const ENGLISH = CASES.icl_english.text;
const CHINESE = CASES.icl_chinese.text;
const SAVED_NAME = 'LibriSpeech 1272';
const RECORDING_MS = 4000;
const MAX_WER = 0.15;
const MAX_CER = 0.2;
const MIN_SIMILARITY = 0.5;
const values = flags({ 'skip-asr': { type: 'boolean', default: false } });
const ASR_PYTHON = process.env.ASR_PYTHON;
const DEADLINE_MS = 10 * 60 * 1000;

// The page's state machine is `main[data-phase]`: loading, ready, generating, broken.
const settled = () => /^(ready|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const finished = () => /^(Done|stopped|error)/.test(document.getElementById('status')?.textContent ?? '');
const heard = () => /\d/.test(document.getElementById('heard')?.textContent ?? '');
const playedOut = () => document.querySelector('.live')?.dataset.playing === 'false';
const voiceReady = () => !document.getElementById('voice-ok')?.hidden;

/** The live metric tiles, as the page shows them, and the voice match its status reports. */
async function metrics(page) {
  const tiles = ['load', 'heard', 'rtf', 'requests'];
  const texts = await Promise.all(tiles.map((id) => page.textContent(`#${id}`)));
  const notes = await page.$$eval('.metrics dd.muted', (nodes) => nodes.map((node) => node.textContent));
  const status = await page.textContent('#status');
  const match = /voice match ([\d.]+)/.exec(status);
  return { ...Object.fromEntries(tiles.map((id, i) => [id, texts[i]])), notes, status, similarity: match ? Number(match[1]) : null };
}

/** Clicks Speak and waits for its synthesis to finish; returns the page's numbers. */
async function speak(page, requests) {
  const requestsBefore = requests.length;
  await page.click('#generate');
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  const spoken = await metrics(page);
  spoken.requestsDuringSynthesis = fetched(requests, requestsBefore);
  return spoken;
}

/** Saves the WAV the page offers to `path`. */
async function saveWav(page, path) {
  const base64 = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch(document.getElementById('download').href)).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  writeFileSync(path, Buffer.from(base64, 'base64'));
  return Buffer.from(base64, 'base64').length;
}

/** The error rate of the speech in `wav` against `text` (words, or characters for Chinese). */
function errorRate(wav, text, language) {
  const out = execFileSync(ASR_PYTHON, [join(ROOT, 'scripts/asr_check.py'), '--language', language, '--text', text, wav], { encoding: 'utf8' });
  const line = out.trim().split('\n').at(-1);
  return { line, rate: Number(/(?:WER|CER)=([\d.]+)/.exec(line)[1]) };
}

/** Speaks, then checks the speech: out, alike, nothing fetched, and (with ASR) intelligible. */
async function checkSpeech({ page, requests, runDir, results, check }, { name, text, language, maxRate }) {
  const spoken = await speak(page, requests);
  results[name] = spoken;
  check(spoken.status.startsWith('Done'), `${name}: first audio ${spoken.heard} (${spoken.notes[1]}), RTF ${spoken.rtf}, ${spoken.status}`);
  check(spoken.similarity >= MIN_SIMILARITY, `${name}: voice match ${spoken.similarity} (at least ${MIN_SIMILARITY})`);
  check(spoken.requestsDuringSynthesis.length === 0 && spoken.requests === '0', `${name}: requests during synthesis: ${spoken.requestsDuringSynthesis.length} seen, page counts ${spoken.requests}`);
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  await page.screenshot({ path: join(runDir, `${STAMP}-${name}.png`), fullPage: true });
  const wav = join(runDir, `${STAMP}-${name}.wav`);
  const bytes = await saveWav(page, wav);
  check(bytes > 44 + 48000, `${name}: WAV ${(bytes / 1e6).toFixed(2)} MB -> ${wav}`);
  if (!ASR_PYTHON) {
    results[`${name}Asr`] = 'not checked';
    return check(values['skip-asr'], 'ASR not checked: set ASR_PYTHON to a Python with faster-whisper, or pass --skip-asr');
  }
  const { line, rate } = errorRate(wav, text, language);
  results[`${name}Asr`] = line;
  check(rate <= maxRate, `${name}: ASR ${line}`);
}

const launch = {
  root: ROOT,
  name: 'qwen3-tts',
  values,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${VOICE}`],
};
await run(launch, async (context) => {
  const { page, base, query, results, check, revisit } = context;
  const t0 = Date.now();
  await page.goto(`${base}/${query}`);
  await page.waitForSelector('main[data-phase]');
  await page.setInputFiles('#voice-file', VOICE);
  await page.waitForFunction(voiceReady, null, { timeout: DEADLINE_MS });
  await page.fill('#transcript', TRANSCRIPT);
  await page.fill('#text', ENGLISH);
  results.queuedAt = await page.getAttribute('main', 'data-phase');
  await page.click('#generate');
  await page.waitForFunction(heard, null, { timeout: DEADLINE_MS, polling: 'raf' });
  results.openToFirstAudioMs = Date.now() - t0;
  await page.waitForFunction(finished, null, { timeout: DEADLINE_MS, polling: 'raf' });
  results.runtime = await page.textContent('#runtime');
  results.cold = await metrics(page);
  check(results.cold.status.startsWith('Done'), `queued run (clicked while ${results.queuedAt}): page open to first audio ${results.openToFirstAudioMs} ms, load ${results.cold.load}; ${results.runtime}`);
  check(results.cold.similarity >= MIN_SIMILARITY, `queued run: voice match ${results.cold.similarity} (at least ${MIN_SIMILARITY})`);
  check(results.cold.requests === '0', `requests after the model was ready: page counts ${results.cold.requests}`);
  await page.waitForFunction(playedOut, null, { timeout: DEADLINE_MS });
  const cold = join(context.runDir, `${STAMP}-cold.wav`);
  check((await saveWav(page, cold)) > 44 + 48000, `cold run: WAV -> ${cold}`);
  if (ASR_PYTHON) {
    const { line, rate } = errorRate(cold, ENGLISH, 'en');
    results.coldAsr = line;
    check(rate <= MAX_WER, `cold run: ASR ${line}`);
  } else {
    results.coldAsr = 'not checked';
    check(values['skip-asr'], 'ASR not checked: set ASR_PYTHON to a Python with faster-whisper, or pass --skip-asr');
  }

  await page.fill('#voice-name', SAVED_NAME);
  await page.click('#save-voice');
  await page.waitForSelector(`.voice[data-name="${SAVED_NAME}"]`);
  await page.fill('#transcript', '');
  await page.selectOption('#language', 'chinese');
  await page.fill('#text', CHINESE);
  await checkSpeech(context, { name: 'warm', text: CHINESE, language: 'zh', maxRate: MAX_CER });

  await page.click('#record');
  await page.waitForTimeout(RECORDING_MS);
  await page.click('#stop-record');
  await page.waitForFunction(voiceReady, null, { timeout: DEADLINE_MS });
  await page.selectOption('#language', 'english');
  await page.fill('#text', ENGLISH);
  await checkSpeech(context, { name: 'record', text: ENGLISH, language: 'en', maxRate: MAX_WER });

  await revisit(settled, DEADLINE_MS);
  check((await page.locator(`.voice[data-name="${SAVED_NAME}"]`).count()) === 1, `the saved voice ${SAVED_NAME} is still there`);
  return ASR_PYTHON ? '' : ' WITHOUT the error rate checks';
});
