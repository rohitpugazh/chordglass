"""Writes tests/fixtures/cqt-librosa.bin: librosa 0.11.0's log-CQT of a synthetic
signal, so tests/cqt.test.ts can check src/audio/cqt.ts against the reference.

  python scripts/make_cqt_fixture.py      (needs librosa==0.11.0)

The signal must match synthSignal() in tests/cqt.test.ts.
"""
import os

import librosa
import numpy as np

SR = 22050
N = SR * 3


def synth():
    t = np.arange(N) / SR
    x = np.zeros(N)
    # A minor triad then C major, with harmonics, plus a slow glide in the bass.
    for i, (f0, start, end) in enumerate([(220.0, 0, 1.5), (261.63, 0, 1.5), (329.63, 0, 1.5),
                                          (261.63, 1.5, 3), (329.63, 1.5, 3), (392.0, 1.5, 3)]):
        env = ((t >= start) & (t < end)).astype(float)
        for h in (1, 2, 3):
            x += env * np.sin(2 * np.pi * f0 * h * t + i) / h * 0.1
    x += 0.1 * np.sin(2 * np.pi * (55 + 20 * t) * t)
    return x.astype(np.float32)


C = librosa.cqt(synth(), sr=SR, hop_length=2048, fmin=librosa.note_to_hz('C1'), n_bins=144, bins_per_octave=24,
                norm=1, sparsity=0.01, window='hann', scale=True, pad_mode='constant')
feat = np.log(np.abs(C) + 1e-6).T.astype('<f4')
out = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'cqt-librosa.bin')
os.makedirs(os.path.dirname(out), exist_ok=True)
header = np.array([feat.shape[0], feat.shape[1]], dtype='<u4')
with open(out, 'wb') as f:
    f.write(header.tobytes())
    f.write(feat.tobytes())
print('frames', feat.shape[0], 'bins', feat.shape[1], '->', out)
