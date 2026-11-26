"""Captures what this computer is playing (Windows WASAPI loopback) as the same
16 kHz mono PCM16 the G2 glasses microphone delivers, for developing and
testing ChordGlass's audio features without glasses.

  python -I scripts/loopback.py record 60 out.wav    # record N seconds to a WAV file
  python -I scripts/loopback.py serve [port]          # stream to http://127.0.0.1:8765/pcm

The stream is raw PCM16LE, 16 kHz, mono, sent as it is captured. Only
127.0.0.1 can connect. Needs pyaudiowpatch and numpy.
"""

import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pyaudiowpatch as pyaudio

OUT_RATE = 16000


def open_loopback(p):
    dev = p.get_default_wasapi_loopback()
    rate = int(dev["defaultSampleRate"])
    channels = int(dev["maxInputChannels"])
    return dev, rate, channels


class Resampler:
    """Downmixes to mono and resamples to 16 kHz (linear interpolation after a
    simple low-pass; good enough for chroma features, which stop near 2 kHz)."""

    def __init__(self, in_rate, channels):
        self.in_rate = in_rate
        self.channels = channels
        self.pos = 0.0
        self.tail = np.zeros(0, dtype=np.float32)
        taps = 31
        cutoff = 7000 / in_rate
        n = np.arange(taps) - (taps - 1) / 2
        h = np.sinc(2 * cutoff * n) * np.hamming(taps)
        self.fir = (h / h.sum()).astype(np.float32)

    def __call__(self, raw: bytes) -> bytes:
        x = np.frombuffer(raw, dtype=np.float32).reshape(-1, self.channels).mean(axis=1)
        x = np.concatenate([self.tail, x])
        y = np.convolve(x, self.fir, mode="same")
        step = self.in_rate / OUT_RATE
        idx = np.arange(self.pos, len(y) - 1, step)
        out = np.interp(idx, np.arange(len(y)), y)
        consumed = int(idx[-1]) + 1 if len(idx) else 0
        self.pos = (idx[-1] + step - consumed) if len(idx) else self.pos - len(y)
        self.tail = y[consumed:] if consumed < len(y) else np.zeros(0, dtype=np.float32)
        pcm = np.clip(out * 32767, -32768, 32767).astype("<i2")
        return pcm.tobytes()


def capture(on_chunk, stop: threading.Event):
    p = pyaudio.PyAudio()
    try:
        dev, rate, channels = open_loopback(p)
        resample = Resampler(rate, channels)
        stream = p.open(format=pyaudio.paFloat32, channels=channels, rate=rate, input=True,
                        input_device_index=dev["index"], frames_per_buffer=int(rate * 0.05))
        print(f"capturing '{dev['name']}' at {rate} Hz x{channels} -> 16 kHz mono", file=sys.stderr)
        while not stop.is_set():
            data = stream.read(int(rate * 0.05), exception_on_overflow=False)
            on_chunk(resample(data), time.time())
        stream.close()
    finally:
        p.terminate()


def record(seconds: float, path: str):
    chunks = []
    stop = threading.Event()
    t = threading.Thread(target=capture, args=(lambda c, _t: chunks.append(c), stop), daemon=True)
    started = time.time()
    t.start()
    time.sleep(seconds)
    stop.set()
    t.join(2)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(OUT_RATE)
        w.writeframes(b"".join(chunks))
    print(f"started {started:.3f} wrote {path}")


def serve(port: int):
    listeners: list = []
    lock = threading.Lock()

    def fan_out(chunk, _t):
        with lock:
            for q in listeners:
                q.append(chunk)

    stop = threading.Event()
    threading.Thread(target=capture, args=(fan_out, stop), daemon=True).start()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.client_address[0] != "127.0.0.1" or self.path.split("?")[0] != "/pcm":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q: list = []
            with lock:
                listeners.append(q)
            try:
                while True:
                    if q:
                        with lock:
                            data, q[:] = b"".join(q), []
                        self.wfile.write(data)
                        self.wfile.flush()
                    time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                with lock:
                    listeners.remove(q)

    print(f"streaming loopback audio at http://127.0.0.1:{port}/pcm", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "record":
        record(float(sys.argv[2]), sys.argv[3])
    elif len(sys.argv) >= 2 and sys.argv[1] == "serve":
        serve(int(sys.argv[2]) if len(sys.argv) > 2 else 8765)
    else:
        sys.exit(__doc__)
