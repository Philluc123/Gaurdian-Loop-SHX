// AudioWorklet that turns the microphone into the 20ms frames the server expects.
//
// Runs on the audio thread, so it must not allocate or block more than necessary —
// a slow processor here shows up as glitches in the captured audio. It only
// resamples, converts, and posts finished frames to the main thread, which owns the
// WebSocket (a worklet has no network access).
//
// AudioWorklet rather than ScriptProcessorNode: the latter is deprecated and runs on
// the main thread, where UI work causes dropped audio.

/** mu-law encoder, mirroring linearToMulaw in scripts/lib/audio.ts. */
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const EXP_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
  EXP_LUT[i] = i < 2 ? 0 : Math.floor(Math.log2(i));
}

function linearToMulaw(sample) {
  const sign = (sample >> 8) & 0x80;
  let magnitude = sign !== 0 ? -sample : sample;
  if (magnitude > MULAW_CLIP) magnitude = MULAW_CLIP;
  magnitude += MULAW_BIAS;
  const exponent = EXP_LUT[(magnitude >> 7) & 0xff];
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function floatToInt16(value) {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.targetRate = opts.targetRate || 16000;
    this.encoding = opts.encoding || "pcm16";
    this.frameSamples = Math.round((this.targetRate * (opts.frameMs || 20)) / 1000);

    // `sampleRate` is a global in the worklet scope: the context's real rate. We ask
    // for the target rate when creating the context, but browsers may ignore that,
    // so resample only if it actually differs.
    this.ratio = sampleRate / this.targetRate;
    this.needsResample = Math.abs(this.ratio - 1) > 0.001;

    // Fractional read position into the incoming block, carried across blocks so
    // resampling doesn't drift or click at block boundaries.
    this.readPos = 0;
    this.lastSample = 0;

    this.buffer = new Float32Array(this.frameSamples);
    this.filled = 0;
    this.stopped = false;

    this.port.onmessage = (event) => {
      if (event.data === "stop") this.stopped = true;
    };
  }

  /** Accumulate one target-rate sample, emitting a frame once we have enough. */
  pushSample(value) {
    this.buffer[this.filled] = value;
    this.filled += 1;
    if (this.filled < this.frameSamples) return;

    const bytes =
      this.encoding === "mulaw"
        ? new Uint8Array(this.frameSamples)
        : new Uint8Array(this.frameSamples * 2);

    if (this.encoding === "mulaw") {
      for (let i = 0; i < this.frameSamples; i += 1) {
        bytes[i] = linearToMulaw(floatToInt16(this.buffer[i]) | 0);
      }
    } else {
      // pcm16 little-endian, which is what Deepgram's linear16 expects.
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < this.frameSamples; i += 1) {
        view.setInt16(i * 2, floatToInt16(this.buffer[i]) | 0, true);
      }
    }

    // Transfer the buffer instead of copying it — this runs 50x a second.
    this.port.postMessage({ type: "frame", payload: bytes.buffer }, [bytes.buffer]);
    this.filled = 0;
  }

  process(inputs) {
    if (this.stopped) return false;

    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true; // mic not delivering yet; keep the node alive

    if (!this.needsResample) {
      for (let i = 0; i < channel.length; i += 1) this.pushSample(channel[i]);
      return true;
    }

    // Linear interpolation down to the target rate. Speech at 16kHz doesn't need
    // anything fancier, and the browser usually resamples for us anyway.
    let pos = this.readPos;
    while (pos < channel.length) {
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = index === 0 ? this.lastSample : channel[index - 1];
      const b = channel[index];
      this.pushSample(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.readPos = pos - channel.length;
    this.lastSample = channel[channel.length - 1];
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
