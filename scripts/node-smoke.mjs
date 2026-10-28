// Runs a single-threaded wasm runtime build in Node against a bundle: pushes every part the way
// the browser loader does, clones the fixed voice (`fixtures/media/voice-24k.wav`) with its
// transcript to speak the first case of `fixtures/cases.json`, prints the load time, the
// real-time factor, the time to the first audio and the voice match, and optionally writes the
// WAV.
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--case icl_english] [--out out.wav]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'string', default: 'web-single' },
    case: { type: 'string', default: 'icl_english' },
    out: { type: 'string' },
  },
});
const bundle = positionals[0] ?? 'dist/model';
const dist = new URL(`../app/engine/dist/${values.build}/`, import.meta.url);
const glue = await import(new URL('qwen3_tts_runtime.js', dist));
glue.initSync({ module: readFileSync(new URL('qwen3_tts_runtime_bg.wasm', dist)) });

const CHUNK = 8 << 20;
const t0 = performance.now();
const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
const runtime = new glue.Runtime(manifest);
let ready = false;
JSON.parse(manifest).parts.forEach((part, index) => {
  const bytes = readFileSync(join(bundle, part.file));
  for (let o = 0; o < bytes.length; o += CHUNK) runtime.write_part(index, bytes.subarray(o, o + CHUNK));
  ready = runtime.end_part(index);
});
if (!ready) throw new Error('engine not ready after every part');
const loadMs = performance.now() - t0;

/** The samples of a 24 kHz float32 WAV (the fixed voice): its data chunk, read as a Float32Array. */
function floatSamples(path) {
  const bytes = readFileSync(path);
  let at = 12;
  while (bytes.toString('ascii', at, at + 4) !== 'data') at += 8 + bytes.readUInt32LE(at + 4);
  const data = bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at + 4));
  return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
}

const limits = JSON.parse(glue.limits());
if (limits.sample_rate !== glue.sample_rate() || !limits.languages.includes('english')) {
  throw new Error(`unexpected limits ${JSON.stringify(limits)}`);
}
const cases = JSON.parse(readFileSync(new URL('../fixtures/cases.json', import.meta.url), 'utf8'));
const voice = floatSamples(new URL('../fixtures/media/voice-24k.wav', import.meta.url));
const t1 = performance.now();
const plan = JSON.parse(runtime.start(JSON.stringify({ ...cases[values.case], seed: 0 }), voice));
const chunks = [];
let frames = 0;
let firstAudioMs = null;
let similarity = null;
for (;;) {
  const progress = JSON.parse(runtime.step());
  const audio = runtime.speech();
  if (audio.length) {
    chunks.push(audio);
    frames++;
    firstAudioMs ??= performance.now() - t1;
  }
  if (progress.done) {
    similarity = progress.similarity;
    break;
  }
}
const genMs = performance.now() - t1;
const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
let offset = 0;
for (const chunk of chunks) {
  samples.set(chunk, offset);
  offset += chunk.length;
}
const seconds = samples.length / glue.sample_rate();
const peak = samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
console.log(`${values.build}: load ${(loadMs / 1000).toFixed(2)}s, ${plan.mode} ${frames} frames, ${seconds.toFixed(2)}s audio (peak ${peak.toFixed(3)}) in ${(genMs / 1000).toFixed(2)}s: RTF ${(genMs / 1000 / seconds).toFixed(3)}, ${(genMs / frames).toFixed(1)} ms/frame, first audio ${firstAudioMs.toFixed(0)} ms, voice match ${similarity.toFixed(3)}`);

if (values.out) {
  writeFileSync(values.out, glue.wav(samples));
  console.log(`wrote ${values.out}`);
}
