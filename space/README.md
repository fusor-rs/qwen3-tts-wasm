---
title: qwen3-tts-wasm
short_description: Clone a voice from a short clip and speak 10 languages on your CPU
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
models:
  - fusorlabs/qwen3-tts-12hz-0.6b-base-web
  - Qwen/Qwen3-TTS-12Hz-0.6B-Base
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Voice cloning with Qwen's
[Qwen3-TTS-12Hz-0.6B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base), computed on your
own CPU in the browser: the model, compiled to WebAssembly with fusor-ai, downloads once and then
runs sealed from the network. Give it a few seconds of a voice (a file or your microphone), with
what the clip says for a closer clone, and a text in one of ten languages; it speaks the text in
that voice as it computes. Neither the clip nor the text leaves the page. The model is Apache-2.0;
its license ships beside the bundle as `model/LICENSE`. The page's code is MIT; its source is
[github.com/fusor-rs/qwen3-tts-wasm](https://github.com/fusor-rs/qwen3-tts-wasm).
