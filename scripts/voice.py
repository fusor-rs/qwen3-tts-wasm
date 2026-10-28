"""The fixed voice of the checks: row `1272-141231-0030` of the LibriSpeech parquet (7.13 s of
speaker 1272), written as `voice.wav` (16 kHz, 16-bit PCM, the FLAC decoded losslessly) and
`voice-24k.wav` (soxr `HQ` from 16 kHz to 24 kHz, float32, cut to whole 1,920-sample frames).

    python -I voice.py <parquet> <media dir>
"""

import io
import sys
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import soundfile as sf
import soxr

ID = "1272-141231-0030"
FRAME_SAMPLES = 1920
TARGET_RATE = 24_000


def main():
    parquet, media = Path(sys.argv[1]), Path(sys.argv[2])
    rows = pq.read_table(parquet).to_pylist()
    row = next(row for row in rows if row["id"] == ID)
    samples, rate = sf.read(io.BytesIO(row["audio"]["bytes"]), dtype="int16")
    sf.write(media / "voice.wav", samples, rate, subtype="PCM_16")
    resampled = soxr.resample(samples.astype(np.float32) / 32768.0, rate, TARGET_RATE, quality="HQ")
    whole = len(resampled) // FRAME_SAMPLES * FRAME_SAMPLES
    sf.write(media / "voice-24k.wav", resampled[:whole].astype(np.float32), TARGET_RATE, subtype="FLOAT")


if __name__ == "__main__":
    main()
