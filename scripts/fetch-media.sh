#!/usr/bin/env bash
# Downloads the fixed voice the checks read into $1: LibriSpeech dev-clean's utterance
# 1272-141231-0030 (CC-BY-4.0), as hf-internal-testing/librispeech_asr_dummy ships it (pinned by
# revision, checked by sha256), then writes `voice.wav` (16 kHz, 16-bit, the FLAC decoded
# losslessly: the browser's microphone stand-in) and `voice-24k.wav` (24 kHz float32 cut to whole
# 1,920-sample frames, what the model reads) with scripts/voice.py.
set -euo pipefail
DIR="$1"
SHA256="4e69a06fa5edc90921e5e7e39a7084881f8b3ed9c805c574f4f39c6fde27c603"
URL="https://huggingface.co/datasets/hf-internal-testing/librispeech_asr_dummy/resolve/5be91486e11a2d616f4ec5db8d3fd248585ac07a/clean/validation-00000-of-00001.parquet"
PARQUET="$DIR/librispeech-dummy.parquet"
mkdir -p "$DIR"
if [ ! -s "$PARQUET" ]; then
  curl -fsSL --retry 3 -o "$PARQUET.part" "$URL"
  mv "$PARQUET.part" "$PARQUET"
fi
echo "$SHA256  $PARQUET" | shasum -a 256 -c --quiet -
uv run --no-project --with pyarrow==21.0.0 --with soundfile==0.13.1 --with soxr==1.1.0 --with numpy==2.2.6 python -I "$(dirname "$0")/voice.py" "$PARQUET" "$DIR"
echo "d977095474b119378acfed8ad799ec411ba61e47ba1e144e914d265c7a20f532  $DIR/voice.wav" | shasum -a 256 -c --quiet -
