// The engine's home: a module Worker that loads the model and runs synthesis, off the page's
// main thread.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Generate: one `step()` per macrotask, so a stop request is seen between steps. The voice's
// embedding, its frames (with a transcript) and the prompt come first, then one 80 ms frame a
// step: every frame's PCM goes straight to the page's audio worklet through `audioPort`, and a
// summary of it (peaks, timings) to the page. At the end the page gets the whole WAV.
//
// After the model is loaded nothing else is fetched: synthesis is entirely local.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

// Waveform bars per frame the page draws.
const PEAKS_PER_FRAME = 24;

let audioPort = null;
let stoppedJob = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'qwen3_tts_runtime',
      cacheName: 'qwen3-tts-parts',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads, sampleRate: started.glue.sample_rate() }),
      onReady: (progress) => post({ type: 'ready', limits: JSON.parse(engine.glue.limits()), ...progress }),
    }),
  audio: ({ port }) => (audioPort = port),
  generate,
  stop: ({ job }) => (stoppedJob = job),
});

async function generate({ job, request, reference }) {
  const { rt, glue } = engine;
  audioPort.postMessage({ type: 'start', job });
  const t0 = performance.now();
  const timing = { frames: 0, samples: 0, similarity: null };
  const chunks = [];
  try {
    rt.start(request, reference);
    await steps(job, t0, timing, chunks);
  } finally {
    audioPort.postMessage({ type: 'end', job });
  }
  const wav = glue.wav(concat(chunks, timing.samples));
  const stats = { job, wallMs: performance.now() - t0, ...timing, networkRequests: requestsSinceReady() };
  post({ type: 'done', stopped: stoppedJob === job, wav, ...stats }, [wav.buffer]);
}

/** Steps `job` to its end or its stop, sending each frame's PCM to the worklet. */
async function steps(job, t0, timing, chunks) {
  const { rt } = engine;
  for (;;) {
    if (stoppedJob === job) {
      rt.cancel();
      return;
    }
    const progress = JSON.parse(rt.step());
    const samples = rt.speech();
    timing.frames = progress.frames;
    timing.similarity = progress.similarity;
    let framePeaks = null;
    if (samples.length) {
      timing.samples += samples.length;
      framePeaks = peaks(samples);
      chunks.push(samples.slice());
      audioPort.postMessage({ type: 'pcm', job, samples }, [samples.buffer]);
    }
    post({ type: 'step', job, stage: progress.stage, peaks: framePeaks, wallMs: performance.now() - t0, ...timing });
    if (progress.done) return;
    await yieldTask();
  }
}

function peaks(samples) {
  const out = new Float32Array(PEAKS_PER_FRAME);
  const width = Math.ceil(samples.length / PEAKS_PER_FRAME);
  samples.forEach((s, i) => {
    const bin = Math.floor(i / width);
    out[bin] = Math.max(out[bin], Math.abs(s));
  });
  return out;
}

function concat(chunks, length) {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
