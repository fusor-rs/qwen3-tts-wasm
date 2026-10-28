import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';
import { Waveform } from './waveform.js';
import { allVoices, deleteVoice, getVoice, saveVoice } from './voices.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the engine
// worker and, in threaded builds, its compute workers (fusor-ai's ComputePool), the audio worklet
// (engine/playback.js) the engine worker feeds directly, and the voice clip: dropped, picked,
// recorded or saved on this device, decoded to the model's rate in this page and sent to the
// engine with each request. It measures each synthesis and reports back with `engine` events, at
// most once per animation frame.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundle served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
// A Hugging Face Space holds at most 1 GB, so the Space loads the bundle from the model repo
// fusorlabs/qwen3-tts-12hz-0.6b-base-web (`just deploy-model`) instead of from beside the page.
const HOSTED_MODEL = 'https://huggingface.co/fusorlabs/qwen3-tts-12hz-0.6b-base-web/resolve/main/';
const DEFAULT_MODEL = location.hostname.endsWith('.hf.space') ? HOSTED_MODEL : 'model/';
const MODEL_URL = new URL(params.get('model') ?? DEFAULT_MODEL, document.baseURI).href;
// Bars of the voice clip's waveform.
const VOICE_PEAKS = 240;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const STAGES = {
  embed: 'listening to the voice',
  encode: 'encoding the voice clip',
  prefill: 'reading the prompt',
  match: 'comparing the speech with the voice',
};

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  const engine = new Worker(new URL('engine/worker.js', document.baseURI), { type: 'module', name: 'qwen3-tts-engine' });
  const computePool = new ComputePool(crash);
  const waveform = new Waveform(root, '#wave');
  const voiceWaveform = new Waveform(root, '#voice-wave');
  let build = null;
  let notice = '';
  let sampleRate = null;
  let resolveSampleRate;
  const sampleRateKnown = new Promise((resolve) => (resolveSampleRate = resolve));
  let limits = null;
  let loaded = false;
  let broken = false;
  let audio = null;
  let jobs = 0;
  let job = null;
  let reportScheduled = false;
  let wavUrl = null;
  let requestsAtReady = 0;
  // The voice clip in use, whole (`clip`), with its saved name and transcript when it came from
  // this device's storage.
  let clip = null;
  let recorder = null;

  const handlers = {
    [SPAWN_COMPUTE]: (message) => computePool.spawn(message),
    runtime: (message) => {
      build = message;
      sampleRate = message.sampleRate;
      resolveSampleRate();
      // Built now, suspended until the first click resumes it: the first synthesis does not wait
      // for the context and the worklet module.
      audioOutput();
    },
    warning: ({ message }) => {
      console.warn(message);
      notice = ` (${message})`;
    },
    progress: ({ done, total, network, cache }) => {
      const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
      report({ type: 'loading', fraction: done / total, detail: `${mb(done)} / ${mb(total)} · ${source}` });
    },
    ready: async ({ ms, limits: runtimeLimits, cache, total }) => {
      limits = runtimeLimits;
      loaded = true;
      requestsAtReady = performance.getEntriesByType('resource').length;
      const loadedInfo = { build: `${build.build}${notice}`, threads: build.threads, bundle_bytes: total, load_ms: ms, from_device: cache === total };
      report({ type: 'ready', limits, loaded: loadedInfo, saved: await savedList() });
      if (clip) reportVoice();
    },
    step: (message) => {
      if (message.job !== job?.id) return;
      job.engine = message;
      job.wallMs = performance.now() - job.t0;
      if (message.peaks) waveform.push(message.peaks);
      scheduleProgress();
    },
    done: (message) => finish(message),
    error: ({ message }) => (loaded ? report({ type: 'error', message }) : fail(message)),
    fatal: ({ message }) => fail(message),
  };

  engine.onmessage = ({ data }) => {
    if (!broken) handlers[data.type]?.(data);
  };
  engine.onerror = (event) => crash(event.message || 'the engine worker failed');
  engine.postMessage({ type: 'load', modelUrl: MODEL_URL, threads: THREADS, build: params.get('build') });

  /** The audio output, built once: a context at the model's rate and the playback worklet. */
  function audioOutput() {
    audio ??= (async () => {
      await sampleRateKnown;
      const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      await context.audioWorklet.addModule(new URL('engine/playback.js', document.baseURI));
      const node = new AudioWorkletNode(context, 'qwen3-tts-playback', { outputChannelCount: [1] });
      node.connect(context.destination);
      node.port.onmessage = ({ data }) => playbackEvent(data);
      const channel = new MessageChannel();
      node.port.postMessage({ type: 'engine', port: channel.port1 }, [channel.port1]);
      engine.postMessage({ type: 'audio', port: channel.port2 }, [channel.port2]);
      return { context, node };
    })();
    return audio;
  }

  /** A click that may start audio: resume the output inside its user activation. */
  function resumeAudio() {
    audioOutput()
      .then(({ context }) => context.resume())
      .catch(() => {}); // a failed output is reported by the synthesis that needs it
  }

  /** The clip the engine takes: the whole clip, or its first `max_reference_seconds`. */
  function reference() {
    const most = limits ? Math.floor(limits.max_reference_seconds * sampleRate) : Infinity;
    return clip.samples.subarray(0, Math.min(clip.samples.length, most));
  }

  function reportVoice(extra = {}) {
    const samples = reference();
    const trimmed = samples.length < clip.samples.length;
    const note = trimmed ? `Trimmed to the first ${limits.max_reference_seconds} s.` : '';
    voiceWaveform.reset();
    voiceWaveform.push(peaksOf(samples, VOICE_PEAKS));
    voiceWaveform.play(1);
    report({ type: 'voice', seconds: samples.length / sampleRate, note, name: null, transcript: null, ...extra });
  }

  /** Uses the audio file or recording `blob` as the voice clip. */
  async function useBlob(blob) {
    await sampleRateKnown;
    try {
      const context = new OfflineAudioContext(1, 1, sampleRate);
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      clip = { samples: mono(decoded) };
      reportVoice();
    } catch (error) {
      report({ type: 'voice', seconds: clip ? reference().length / sampleRate : 0, note: `Could not read that audio (${error?.message ?? error}).`, name: null, transcript: null });
    }
  }

  async function savedList() {
    const voices = await allVoices();
    return voices.sort((a, b) => a.name.localeCompare(b.name)).map(({ id, name }) => ({ id, name }));
  }

  async function saveCurrent() {
    const name = root.querySelector('#voice-name').value.trim();
    if (!clip || !name) return;
    const transcript = root.querySelector('#transcript').value.trim();
    await saveVoice({ id: crypto.randomUUID(), name, transcript, samples: reference().slice() });
    report({ type: 'saved', saved: await savedList() });
  }

  async function useSaved(id) {
    const voice = await getVoice(id);
    if (!voice) return;
    clip = { samples: voice.samples };
    reportVoice({ name: voice.name, transcript: voice.transcript });
  }

  async function forget(id) {
    await deleteVoice(id);
    report({ type: 'saved', saved: await savedList() });
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = ({ data }) => chunks.push(data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        report({ type: 'recording', on: false });
        useBlob(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.start();
      report({ type: 'recording', on: true });
    } catch (error) {
      report({ type: 'voice', seconds: clip ? reference().length / sampleRate : 0, note: `The microphone is not available (${error?.message ?? error}).`, name: null, transcript: null });
    }
  }

  const clicks = {
    '#record': startRecording,
    '#stop-record': () => recorder?.stop(),
    '#save-voice': saveCurrent,
  };
  function onClick(event) {
    for (const [selector, action] of Object.entries(clicks)) {
      if (event.target.closest(selector)) return action();
    }
    const chip = event.target.closest('.voice[data-id]');
    if (!chip) return;
    if (event.target.closest('.delete')) forget(chip.dataset.id);
    else useSaved(chip.dataset.id);
  }
  const onChange = ({ target }) => {
    if (target.id !== 'voice-file' || !target.files[0]) return;
    useBlob(target.files[0]);
    target.value = '';
  };
  const onDrag = (event) => {
    event.preventDefault();
    root.querySelector('.dropzone')?.setAttribute('data-over', event.type === 'dragover');
  };
  const onDrop = (event) => {
    onDrag(event);
    root.querySelector('.dropzone')?.setAttribute('data-over', false);
    if (event.dataTransfer.files[0]) useBlob(event.dataTransfer.files[0]);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('dragover', onDrag);
  root.addEventListener('dragleave', onDrag);
  root.addEventListener('drop', onDrop);
  voiceWaveform.reset();
  savedList().then((saved) => saved.length && report({ type: 'saved', saved }));

  /** Runs the request the page holds, timed from now (the click, or the model being ready). */
  async function dispatch() {
    job = { id: ++jobs, t0: performance.now(), heardMs: null, wallMs: 0, engine: null, done: false, stopped: false };
    const current = job;
    waveform.reset();
    try {
      const { context } = await audioOutput();
      await context.resume();
    } catch (error) {
      audio = null;
      report({ type: 'error', message: `no audio output (${error?.message ?? error})` });
      return;
    }
    if (current.stopped) {
      report({ type: 'done', status: 'stopped', audio: null, metrics: metrics() });
      report({ type: 'played' });
      return;
    }
    engine.postMessage({ type: 'generate', job: current.id, request: inputs.request.get(), reference: reference().slice() });
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    engine.postMessage({ type: 'stop', job: job.id });
    const id = job.id;
    audio?.then(({ node }) => node.port.postMessage({ type: 'flush', job: id }));
  }

  function playbackEvent({ type, job: id, rendered }) {
    if (id !== job?.id) return;
    if (type === 'started') {
      job.heardMs = performance.now() - job.t0;
      scheduleProgress();
    } else if (type === 'position') {
      waveform.play(rendered / Math.max(1, job.engine?.samples ?? 1));
    } else if (type === 'drained') {
      waveform.play(1);
      report({ type: 'played' });
    }
  }

  function scheduleProgress() {
    if (reportScheduled) return;
    reportScheduled = true;
    requestAnimationFrame(() => {
      reportScheduled = false;
      if (!job) return;
      if (job.done) {
        report({ type: 'measured', metrics: metrics() });
        return;
      }
      const stage = STAGES[job.engine?.stage];
      const seconds = (job.engine?.samples ?? 0) / sampleRate;
      const status = stage ? `${stage}…` : `speaking · frame ${job.engine?.frames ?? 0} · ${seconds.toFixed(2)} s of audio`;
      report({ type: 'progress', status, metrics: metrics() });
    });
  }

  function metrics() {
    const engineStats = job.engine ?? { samples: 0 };
    const requests = performance.getEntriesByType('resource').length - requestsAtReady + (engineStats.networkRequests ?? 0);
    return {
      heard_ms: job.heardMs,
      wall_ms: job.wallMs,
      audio_seconds: engineStats.samples / sampleRate,
      requests,
    };
  }

  function finish(message) {
    if (message.job !== job?.id) return;
    job.engine = message;
    job.wallMs = performance.now() - job.t0;
    job.done = true;
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    wavUrl = message.samples ? URL.createObjectURL(new Blob([message.wav], { type: 'audio/wav' })) : null;
    const status = message.stopped ? 'stopped' : `Done · voice match ${message.similarity.toFixed(2)}`;
    report({ type: 'done', status, audio: wavUrl, metrics: metrics() });
    if (!message.samples) report({ type: 'played' });
  }

  /** The model could not load, or the engine or a compute thread died. */
  function fail(message) {
    broken = true;
    engine.terminate();
    computePool.terminate();
    if (job) audio?.then(({ node }) => node.port.postMessage({ type: 'flush', job: job.id }));
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  onCleanup(onClicks(inputs.clicks, resumeAudio));
  onCleanup(onClicks(inputs.starts, dispatch));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(() => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('dragover', onDrag);
    root.removeEventListener('dragleave', onDrag);
    root.removeEventListener('drop', onDrop);
    recorder?.state === 'recording' && recorder.stop();
    engine.terminate();
    computePool.terminate();
    audio?.then(({ context }) => context.close());
    if (wavUrl) URL.revokeObjectURL(wavUrl);
  });
}

/** The mono mix of a decoded clip. */
function mono(buffer) {
  const mix = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    buffer.getChannelData(channel).forEach((sample, i) => (mix[i] += sample / buffer.numberOfChannels));
  }
  return mix;
}

/** `count` peaks of `samples`, each the loudest sample of an equal share of them. */
function peaksOf(samples, count) {
  const peaks = new Float32Array(count);
  const width = Math.max(1, Math.ceil(samples.length / count));
  samples.forEach((sample, i) => {
    const bin = Math.min(count - 1, Math.floor(i / width));
    peaks[bin] = Math.max(peaks[bin], Math.abs(sample));
  });
  return peaks;
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
