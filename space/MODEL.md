---
license: apache-2.0
base_model:
  - Qwen/Qwen3-TTS-12Hz-0.6B-Base
pipeline_tag: text-to-speech
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
  - voice-cloning
---

# Qwen3-TTS-12Hz-0.6B-Base, compiled for the browser

Qwen's [Qwen3-TTS-12Hz-0.6B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base) compiled
into a [fusor-ai](https://github.com/fusor-rs/fusor-ai) bundle: the weights the browser runtime of
[qwen3-tts-wasm](https://github.com/fusor-rs/qwen3-tts-wasm) loads to clone a voice from a short
clip and speak ten languages on the device's CPU. Try it in the Space
[fusorlabs/qwen3-tts-wasm](https://huggingface.co/spaces/fusorlabs/qwen3-tts-wasm).

- **Source:** `Qwen/Qwen3-TTS-12Hz-0.6B-Base` at revision
  `5d83992436eae1d760afd27aff78a71d676296fc` (the talker, the code predictor, the speaker encoder
  and the 12 Hz speech tokenizer's encoder and decoder), compiled with the `q7` profile: every
  large matrix 7-bit (1068 MB). The text embedding is stored already through the text projection.
- **Format:** `manifest.json` lists every tensor and part; each part is named by its BLAKE3 hash,
  which the runtime checks as it loads.
- **Reproduce it:** `just model` in qwen3-tts-wasm downloads the checkpoint and compiles the same
  bundle.

This is not a PyTorch or safetensors checkpoint: it only loads in the qwen3-tts-wasm runtime.

The model is Apache-2.0 ([LICENSE](LICENSE)).
