"""Intelligibility check: transcribe WAVs with faster-whisper (small, int8) and score the word
error rate against the text that was synthesized (the character error rate for Chinese, with
`--language zh`: punctuation and spaces removed).

Usage (a Python with faster-whisper 1.2.1, e.g. `uv venv .cache/asr && uv pip install
--python .cache/asr/bin/python faster-whisper==1.2.1`):
  python scripts/asr_check.py --text "The evening wind ..." out/a.wav [out/b.wav ...]
  python scripts/asr_check.py --language zh --text "今天天气很好" out/a.wav
  python scripts/asr_check.py --max-error 0.15 --text "..." out/a.wav     # exit 1 above the bound
"""
import argparse
import re
import sys

CHINESE = "zh"
# Whisper writes Mandarin in traditional characters unless the prompt is in simplified ones.
SIMPLIFIED_PROMPT = "以下是普通话的句子。"


def words(text):
    text = text.lower().replace("'", "").replace("-", " ")
    return re.sub(r"[^a-z0-9 ]+", " ", text).split()


def characters(text):
    return [character for character in text if re.match(r"\w", character)]


def error_rate(reference, hypothesis):
    row = list(range(len(hypothesis) + 1))
    for i in range(1, len(reference) + 1):
        diagonal, row[0] = row[0], i
        for j in range(1, len(hypothesis) + 1):
            above = row[j]
            row[j] = min(row[j] + 1, row[j - 1] + 1, diagonal + (reference[i - 1] != hypothesis[j - 1]))
            diagonal = above
    return row[len(hypothesis)] / max(1, len(reference))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--max-error", type=float)
    ap.add_argument("--language", default="en")
    ap.add_argument("wavs", nargs="+")
    args = ap.parse_args()
    units = characters if args.language == CHINESE else words
    label = "CER" if args.language == CHINESE else "WER"

    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    worst = 0.0
    for path in args.wavs:
        prompt = SIMPLIFIED_PROMPT if args.language == CHINESE else None
        segments, _ = model.transcribe(path, beam_size=5, language=args.language, initial_prompt=prompt)
        hypothesis = " ".join(s.text.strip() for s in segments)
        score = error_rate(units(args.text), units(hypothesis))
        worst = max(worst, score)
        print(f"{label}={score:.3f} {path} | {hypothesis}")
    if args.max_error is not None and worst > args.max_error:
        sys.exit(f"{label} {worst:.3f} > {args.max_error}")


if __name__ == "__main__":
    main()
