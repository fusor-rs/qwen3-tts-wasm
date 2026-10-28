#!/usr/bin/env bash
# Downloads what `qwen3-tts compile` reads into $1, each file pinned by revision and checked by
# sha256 (files already present are only checked): Qwen/Qwen3-TTS-12Hz-0.6B-Base's config,
# tokenizer files and weights, its speech tokenizer's, the byte-level BPE tokenizer.json of
# Qwen/Qwen3-0.6B (the base repository ships vocab.json and merges.txt only), and the license of
# QwenLM/Qwen3-TTS.
set -euo pipefail
DIR="$1"
MODEL="https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/resolve/5d83992436eae1d760afd27aff78a71d676296fc"
TOKENIZER="https://huggingface.co/Qwen/Qwen3-0.6B/resolve/c1899de289a04d12100db370d81485cdf75e47ca"
LICENSE="https://raw.githubusercontent.com/QwenLM/Qwen3-TTS/022e286b98fbec7e1e916cb940cdf532cd9f488e"
FILES="
180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6  model.safetensors  $MODEL
836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258  speech_tokenizer/model.safetensors  $MODEL
2e714c787c8edb98b05432685cddb634add2de4d4e645f653d68251ef72ba011  config.json  $MODEL
f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa  generation_config.json  $MODEL
efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119  preprocessor_config.json  $MODEL
dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670  tokenizer_config.json  $MODEL
ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910  vocab.json  $MODEL
599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3  merges.txt  $MODEL
181187b6057906bd960bc7f938d0b7a16652509776a0d52c4885b4ae5ccda0ea  README.md  $MODEL
ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167  speech_tokenizer/config.json  $MODEL
6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd  speech_tokenizer/configuration.json  $MODEL
fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb  speech_tokenizer/preprocessor_config.json  $MODEL
aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4  tokenizer.json  $TOKENIZER
a44a6081c73ad75f0255bb2bb5cab74ef1829565a895a24e53a4f11290ab7655  LICENSE  $LICENSE
"
mkdir -p "$DIR/speech_tokenizer"
while read -r _ file base; do
  if [ -z "$file" ] || [ -s "$DIR/$file" ]; then continue; fi
  echo "downloading $file"
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$base/$file"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { print $1 "  " $2 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
