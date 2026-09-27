import { describe, expect, it } from "vitest";
import { AttributionGate, type GateOptions } from "./gate";
import { frameDbfs, silenceLike, SILENT_DBFS } from "./levels";

const opts: GateOptions = {
  enabled: true,
  dominanceDb: 9,
  hangoverMs: 300,
  floorDbfs: -50,
};

/** Feed one level repeatedly so the smoothed estimate settles near it. */
function settle(gate: AttributionGate, role: "caller" | "victim", dbfs: number, atMs: number) {
  for (let i = 0; i < 12; i += 1) gate.decide(role, dbfs, atMs);
}

describe("AttributionGate", () => {
  it("passes everything when only one person is talking", () => {
    const gate = new AttributionGate(opts);
    for (let t = 0; t < 400; t += 20) {
      expect(gate.decide("caller", -20, t)).toBe("pass");
    }
  });

  it("silences the quiet track while the other is clearly dominant", () => {
    const gate = new AttributionGate(opts);
    // The caller talks at -20dBFS; the victim's mic picks up the bleed at -38.
    for (let t = 0; t < 400; t += 20) {
      gate.decide("caller", -20, t);
      gate.decide("victim", -38, t);
    }
    expect(gate.decide("victim", -38, 400)).toBe("suppress");
    expect(gate.decide("caller", -20, 400)).toBe("pass");
  });

  it("lets both through when the levels are close — that's real double-talk", () => {
    const gate = new AttributionGate(opts);
    for (let t = 0; t < 400; t += 20) {
      gate.decide("caller", -22, t);
      gate.decide("victim", -25, t);
    }
    expect(gate.decide("caller", -22, 400)).toBe("pass");
    expect(gate.decide("victim", -25, 400)).toBe("pass");
  });

  it("stops gating once the dominant speaker goes quiet past the hangover", () => {
    const gate = new AttributionGate(opts);
    for (let t = 0; t < 400; t += 20) {
      gate.decide("caller", -20, t);
      gate.decide("victim", -38, t);
    }
    expect(gate.decide("victim", -38, 400)).toBe("suppress");

    // Caller stops. Beyond the hangover the victim is free to speak again.
    expect(gate.decide("victim", -38, 400 + opts.hangoverMs + 20)).toBe("pass");
  });

  it("keeps gating through a brief pause inside the hangover window", () => {
    const gate = new AttributionGate(opts);
    for (let t = 0; t < 400; t += 20) {
      gate.decide("caller", -20, t);
      gate.decide("victim", -38, t);
    }
    // A gap between words is shorter than the hangover, so attribution holds.
    expect(gate.decide("victim", -38, 400 + 100)).toBe("suppress");
  });

  it("never gates a frame that is itself at or below the noise floor", () => {
    const gate = new AttributionGate(opts);
    settle(gate, "caller", -10, 0);
    // Digital silence still flows, because Deepgram's endpointing needs a
    // continuous stream rather than gaps.
    expect(gate.decide("victim", -80, 20)).toBe("pass");
  });

  it("holds its decision near the threshold instead of flapping mid-word", () => {
    const gate = new AttributionGate(opts);
    for (let t = 0; t < 400; t += 20) {
      gate.decide("caller", -20, t);
      gate.decide("victim", -38, t);
    }
    expect(gate.decide("victim", -38, 400)).toBe("suppress");
    // Margin dips just under the engage threshold; release needs a bigger drop.
    expect(gate.decide("victim", -27, 420)).toBe("suppress");
  });

  it("passes everything when disabled", () => {
    const gate = new AttributionGate({ ...opts, enabled: false });
    for (let t = 0; t < 400; t += 20) {
      gate.decide("caller", -10, t);
      expect(gate.decide("victim", -45, t)).toBe("pass");
    }
    expect(gate.isSuppressing("victim")).toBe(false);
  });

  it("tracks each speaker independently", () => {
    const gate = new AttributionGate(opts);
    settle(gate, "caller", -15, 0);
    settle(gate, "victim", -45, 0);
    expect(gate.levelOf("caller")).toBeGreaterThan(gate.levelOf("victim"));
  });
});

describe("frameDbfs", () => {
  /** pcm16 frame at a constant amplitude, as a fraction of full scale. */
  function pcm16(amplitude: number, samples = 320): Buffer {
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      buf.writeInt16LE(Math.round(amplitude * 32767), i * 2);
    }
    return buf;
  }

  it("reports full scale as roughly 0 dBFS", () => {
    expect(frameDbfs(pcm16(1), "pcm16")).toBeCloseTo(0, 1);
  });

  it("reports half amplitude as roughly -6 dBFS", () => {
    expect(frameDbfs(pcm16(0.5), "pcm16")).toBeCloseTo(-6, 0);
  });

  it("reports digital silence at the floor", () => {
    expect(frameDbfs(pcm16(0), "pcm16")).toBe(SILENT_DBFS);
  });

  it("reads mu-law too, so the telephony format is gated the same way", () => {
    // 0xFF is mu-law silence; a loud frame must come out clearly louder.
    const quiet = Buffer.alloc(160, 0xff);
    const loud = Buffer.alloc(160, 0x00);
    expect(frameDbfs(loud, "mulaw")).toBeGreaterThan(frameDbfs(quiet, "mulaw") + 20);
  });

  it("survives an odd trailing byte rather than throwing", () => {
    expect(() => frameDbfs(Buffer.alloc(41), "pcm16")).not.toThrow();
  });

  it("returns the floor for an empty frame", () => {
    expect(frameDbfs(Buffer.alloc(0), "pcm16")).toBe(SILENT_DBFS);
  });
});

describe("silenceLike", () => {
  it("matches length, and uses each format's own representation of silence", () => {
    const pcm = silenceLike(Buffer.alloc(320, 7), "pcm16");
    expect(pcm).toHaveLength(320);
    expect(frameDbfs(pcm, "pcm16")).toBe(SILENT_DBFS);

    const mulaw = silenceLike(Buffer.alloc(160, 7), "mulaw");
    expect(mulaw).toHaveLength(160);
    expect(mulaw.every((b) => b === 0xff)).toBe(true);
  });
});
