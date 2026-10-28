use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

const SAMPLE_TEXT: &str =
    "The morning train was late again, so we walked along the river and talked about the summer.";
const DEFAULT_LANGUAGE: &str = "english";
const DEFAULT_SEED: u64 = 4242;

// The runtime build and the bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {} bundle · {source} in {}",
            self.build,
            megabytes(self.bundle_bytes),
            seconds(self.load_ms)
        )
    }
}

// What a request may ask for (`limits()` of the runtime).
#[derive(Clone, PartialEq, Deserialize)]
struct Limits {
    min_reference_seconds: f64,
    max_reference_seconds: f64,
}

// A voice saved on this device (`web/voices.js`).
#[derive(Clone, PartialEq, Deserialize)]
struct Saved {
    id: String,
    name: String,
}

// One synthesis as `web/app.js` measures it, live while it runs. `heard_ms` and `wall_ms` are
// timed on the page from the click (for a queued request, from the model being ready) to the
// first sample the audio worklet rendered and to the last frame's arrival.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    heard_ms: Option<f64>,
    wall_ms: f64,
    audio_seconds: f64,
    requests: u32,
}

impl Metrics {
    fn heard(&self) -> String {
        self.heard_ms.map_or("–".into(), milliseconds)
    }

    fn real_time_factor(&self) -> String {
        if self.audio_seconds == 0.0 {
            return "–".into();
        }
        format!("{:.3}", self.wall_ms / 1000.0 / self.audio_seconds)
    }

    fn speedup(&self) -> String {
        if self.wall_ms == 0.0 || self.audio_seconds == 0.0 {
            return "audio seconds per wall second".into();
        }
        format!(
            "{:.1}× faster than real time",
            self.audio_seconds * 1000.0 / self.wall_ms
        )
    }

    fn audio(&self) -> String {
        format!("{:.2} s of speech", self.audio_seconds)
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        limits: Limits,
        loaded: Loaded,
        saved: Vec<Saved>,
    },
    // The voice clip in use: its length, a note about it (trimmed, too short), and, for a saved
    // voice, its name and transcript.
    Voice {
        seconds: f64,
        note: String,
        name: Option<String>,
        transcript: Option<String>,
    },
    // The voices saved on this device, and the clip being recorded (or not).
    Saved {
        saved: Vec<Saved>,
    },
    Recording {
        on: bool,
    },
    Progress {
        status: String,
        metrics: Metrics,
    },
    // The audio is generated; `audio` is the WAV's blob URL.
    Done {
        status: String,
        audio: Option<String>,
        metrics: Metrics,
    },
    // New measurements after `Done` (the first sample can play after the last frame).
    Measured {
        metrics: Metrics,
    },
    // The last queued sample was played, or playback was stopped.
    Played,
    // A synthesis failed; the engine can run the next one.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

// The engine's request (`qwen3_tts::session::Request` in the runtime), as `web/app.js` posts it
// with the voice clip.
#[derive(Serialize)]
struct Request {
    text: String,
    language: String,
    reference_text: String,
    seed: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Generating,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Generating => "generating",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    text: Signal<String>,
    language: Signal<String>,
    transcript: Signal<String>,
    voice_name: Signal<String>,
    // `web/app.js` acts on every new count: `clicks` (Speak) resumes the audio output inside the
    // user's gesture, `starts` runs `request`, `stops` stops the synthesis and the playback.
    #[js]
    request: Signal<String>,
    #[js]
    clicks: Signal<u32>,
    #[js]
    starts: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    phase: Signal<Phase>,
    // Speak was clicked while the model loaded: it runs as soon as the model is ready.
    queued: Signal<bool>,
    playing: Signal<bool>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    limits: Signal<Option<Limits>>,
    // The voice clip in use, in seconds, and what to tell about it.
    voice_seconds: Signal<f64>,
    voice_note: Signal<String>,
    recording: Signal<bool>,
    saved: Signal<Vec<Saved>>,
    status: Signal<String>,
    audio: Signal<Option<String>>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            text: signal(SAMPLE_TEXT.into()),
            language: signal(DEFAULT_LANGUAGE.into()),
            transcript: signal(String::new()),
            voice_name: signal(String::new()),
            request: signal(String::new()),
            clicks: signal(0),
            starts: signal(0),
            stops: signal(0),
            phase: signal(Phase::Loading),
            queued: signal(false),
            playing: signal(false),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            limits: signal(None),
            voice_seconds: signal(0.0),
            voice_note: signal(String::new()),
            recording: signal(false),
            saved: signal(Vec::new()),
            status: signal(String::new()),
            audio: signal(None),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn generate(&self) {
        self.clicks.update(|count| *count += 1);
        let Some(request) = self.request() else {
            return;
        };
        if self.phase.get() == Phase::Loading {
            self.queued.set(true);
            self.status
                .set("Queued: it speaks the moment the model is ready.".into());
        } else {
            self.begin(request);
        }
    }

    // The engine request with the form's settings, as JSON, or `None` after telling what is
    // wrong.
    fn request(&self) -> Option<String> {
        let text = self.text.get().trim().to_string();
        if text.is_empty() {
            self.status.set("Type some text first.".into());
            return None;
        }
        if !self.voice_ok() {
            self.status
                .set("Add a voice clip of at least 3 seconds first.".into());
            return None;
        }
        let request = Request {
            text,
            language: self.language.get(),
            reference_text: self.transcript.get().trim().to_string(),
            seed: DEFAULT_SEED,
        };
        Some(serde_json::to_string(&request).expect("plain data serializes"))
    }

    fn begin(&self, request: String) {
        self.request.set(request);
        self.phase.set(Phase::Generating);
        self.playing.set(true);
        self.measured.set(true);
        self.metrics.set(Metrics::default());
        self.status.set("Preparing…".into());
        self.starts.update(|count| *count += 1);
    }

    fn stop(&self) {
        if self.queued.get() {
            self.queued.set(false);
            self.status.set("Cancelled.".into());
            return;
        }
        self.stops.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready {
                limits,
                loaded,
                saved,
            } => self.ready(limits, loaded, saved),
            Report::Voice {
                seconds,
                note,
                name,
                transcript,
            } => {
                self.voice_seconds.set(seconds);
                self.voice_note.set(note);
                if let Some(name) = name {
                    self.voice_name.set(name);
                }
                if let Some(transcript) = transcript {
                    self.transcript.set(transcript);
                }
            }
            Report::Saved { saved } => self.saved.set(saved),
            Report::Recording { on } => self.recording.set(on),
            Report::Progress { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Done {
                status,
                audio,
                metrics,
            } => {
                self.status.set(status);
                self.audio.set(audio);
                self.metrics.set(metrics);
                self.phase.set(Phase::Ready);
            }
            Report::Measured { metrics } => self.metrics.set(metrics),
            Report::Played => self.playing.set(false),
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.playing.set(false);
                self.phase.set(Phase::Ready);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn ready(&self, limits: Limits, loaded: Loaded, saved: Vec<Saved>) {
        self.limits.set(Some(limits));
        self.saved.set(saved);
        self.loaded.set(Some(loaded));
        self.phase.set(Phase::Ready);
        let queued = self.queued.get();
        self.queued.set(false);
        if queued && let Some(request) = self.request() {
            self.begin(request);
        }
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn min_seconds(&self) -> f64 {
        self.limits
            .get()
            .map_or(3.0, |limits| limits.min_reference_seconds)
    }

    // The clip is long enough to clone from.
    fn voice_ok(&self) -> bool {
        self.voice_seconds.get() >= self.min_seconds()
    }

    fn voice_length(&self) -> String {
        format!("{:.1} s", self.voice_seconds.get())
    }

    fn voice_hint(&self) -> String {
        match self.limits.get() {
            Some(limits) => format!(
                "A clip of {:.0} to {:.0} seconds of one voice",
                limits.min_reference_seconds, limits.max_reference_seconds
            ),
            None => "A clip of a few seconds of one voice".into(),
        }
    }

    fn generate_label(&self) -> &'static str {
        match (self.phase.get(), self.queued.get()) {
            (Phase::Loading, true) => "Queued",
            (Phase::Loading, false) => "Speak when ready",
            _ => "Speak",
        }
    }

    fn can_stop(&self) -> bool {
        self.phase.get() == Phase::Generating || self.playing.get() || self.queued.get()
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn can_generate(&self) -> bool {
        match self.phase.get() {
            Phase::Loading => !self.queued.get(),
            Phase::Ready => true,
            Phase::Generating | Phase::Broken => false,
        }
    }

    fn can_save(&self) -> bool {
        self.voice_ok() && !self.voice_name.get().trim().is_empty()
    }

    fn load_time(&self) -> String {
        self.loaded
            .get()
            .map_or("–".into(), |loaded| seconds(loaded.load_ms))
    }

    fn load_source(&self) -> &'static str {
        match self.loaded.get() {
            Some(loaded) if loaded.from_device => "from this device's storage",
            Some(_) => "downloaded",
            None => "waiting for the model",
        }
    }
}

fn milliseconds(ms: f64) -> String {
    format!("{ms:.0} ms")
}

fn seconds(ms: f64) -> String {
    format!("{:.1} s", ms / 1000.0)
}

fn megabytes(bytes: f64) -> String {
    format!("{:.1} MB", bytes / 1e6)
}

fusor::template!("web/index.html");
