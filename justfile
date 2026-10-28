# Qwen3-TTS in the browser. `just ui` builds everything, the model included, and serves the page;
# `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "qwen3-tts"
# The bundle is 1.1 GB (the 12 Hz speech tokenizer's encoder and decoder, the talker, the code
# predictor and the speaker encoder), the talker's KV cache and the activations on top of it.
export MAX_MEMORY := "4294967296"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
model_f32 := "dist/model-f32"
media := "fixtures/media"
cases := "fixtures/cases.json"
goldens := "fixtures/goldens"
# The reference the goldens come from (vendor/fusor-ai/models/qwen3-tts/reference): qwen-tts's own
# modeling code under transformers, pinned.
reference := "uv run --no-project --python 3.12 --with qwen-tts==0.1.1 --with transformers==4.57.3 --with accelerate==1.12.0 --with torch==2.9.1 --with torchaudio==2.9.1 --with librosa==0.11.0 --with soundfile==0.13.1 --with soxr==1.1.0 --with safetensors==0.6.2 --with numpy==2.2.6 python -I"

host:
    bash -n scripts/fetch-checkpoint.sh
    bash -n scripts/fetch-media.sh
    node --check app/web/app.js
    node --check app/web/voices.js
    node --check app/web/waveform.js
    node --check app/engine/worker.js
    node --check app/engine/playback.js
    node --check scripts/node-smoke.mjs
    node --check scripts/demo.mjs
    node --check scripts/render-images.mjs
    node --check scripts/site-bundle.mjs
    node --check e2e/run.mjs
    python3 -m py_compile scripts/asr_check.py scripts/voice.py

# Downloads the pinned checkpoint (2.5 GB, sha256-checked) unless it is already there, then
# compiles the bundle into dist/model, its license beside it.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/qwen3-tts compile {{checkpoint}} {{model}}
    cp {{checkpoint}}/LICENSE {{model}}/

# Try it on localhost. The bundle and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# Every stage against the reference's goldens (vendor/fusor-ai/models/qwen3-tts/reference), with
# the f32 bundle.
parity: native
    test -f {{goldens}}/golden_f32_icl_english.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/qwen3-tts compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/qwen3-tts parity {{model_f32}} {{goldens}}/golden_f32_icl_english.safetensors {{goldens}}/golden_f32_icl_chinese.safetensors {{goldens}}/golden_f32_xvector_english.safetensors {{goldens}}/golden_f32_xvector_chinese.safetensors

# Golden tensors of every case, from the reference in f32 on the CPU, greedy.
goldens: fixtures
    scripts/fetch-checkpoint.sh {{checkpoint}}
    {{reference}} {{fusor_ai}}/models/qwen3-tts/reference/dump.py {{checkpoint}} {{cases}} {{media}} {{goldens}}

# Speaks with the native CLI in the fixed voice: `just speak --text "Hello." --language english`.
speak *arguments: model fixtures
    target/release/qwen3-tts speak {{model}} {{media}}/voice-24k.wav {{arguments}}

bench: model fixtures
    target/release/qwen3-tts bench {{model}} {{media}}/voice-24k.wav

# The Python the intelligibility checks run Whisper in.
asr:
    test -x .cache/asr/bin/python || (uv venv .cache/asr --python 3.12 && uv pip install --python .cache/asr/bin/python faster-whisper==1.2.1 av==15.1.0)

# The README's demo, assets/demo/demo.gif: the real page, served with dist/model, recorded in
# headless Chrome while it clones the fixed voice. ffmpeg comes from imageio-ffmpeg.
demo: model runtimes page fixtures
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    FFMPEG=$(uv run --no-project --with imageio-ffmpeg==0.6.0 python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())') node scripts/demo.mjs

# The README's banner and benchmark summary, light and dark.
images:
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node scripts/render-images.mjs

# Its tensor parts are named by their BLAKE3, so /model/parts/ can be cached as immutable.
# The page, its four runtimes and the bundle beside it, as a static site in target/site.
site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    node scripts/site-bundle.mjs {{model}} target/site/model
    cp {{model}}/LICENSE target/site/model/

# The Space holds at most 1 GB, so it gets the page, the runtimes and the model's license, and the
# page loads the bundle from the model repo fusorlabs/qwen3-tts-12hz-0.6b-base-web (`just
# deploy-model`). The Space must already exist as a static Space: creating it with the upload
# makes a Gradio Space, which Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/qwen3-tts-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --include NOTICE --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    HfApi().upload_folder(
        repo_id="fusorlabs/qwen3-tts-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy qwen3-tts-wasm {{version}}",
    )
    PY

# Deploy it before the Space whenever the bundle changes: the runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's bundle, with space/MODEL.md as its card, to the model repo
# fusorlabs/qwen3-tts-12hz-0.6b-base-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/qwen3-tts-12hz-0.6b-base-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/qwen3-tts-12hz-0.6b-base-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the qwen3-tts-wasm {{version}} bundle",
    )
    PY

# The fixed inputs the checks read: the voice (LibriSpeech, CC-BY-4.0), whole 24 kHz frames.
fixtures:
    scripts/fetch-media.sh {{media}}
