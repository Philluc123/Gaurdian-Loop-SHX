// Speaker-attribution gate.
//
// Both participants sit in one room for the demo, so each microphone hears both
// people. Without treatment, every sentence lands in BOTH transcripts and speaker
// attribution is meaningless.
//
// This is the software layer of a three-layer fix (see ../README.md): close-talking
// earbud mics give ~16-20dB of separation, browser capture constraints keep levels
// stable, and this gate resolves what's left.
//
// The algorithm follows a professional-AV gating automixer: track each mic's recent
// level, and while one is clearly dominant, mute the others. Pure and synchronous —
// levels in, decisions out — so it's testable without audio or sockets.

import type { Speaker } from "@guardian-loop/shared-types";
import { SILENT_DBFS } from "./levels";

export interface GateOptions {
  enabled: boolean;
  /** How much louder (dB) the other track must be before this one is muted. */
  dominanceDb: number;
  /** Treat the other speaker as still active this long after they last spoke. */
  hangoverMs: number;
  /** Below this level nobody is really talking, so nothing is gated. */
  floorDbfs: number;
}

/**
 * Releasing at a lower margin than it engages stops the gate flapping on and off
 * mid-word when the two levels sit near the threshold.
 */
const RELEASE_MARGIN_DB = 3;

/** Smoothing on the level estimate: fast enough to track speech, slow enough to be stable. */
const LEVEL_ATTACK = 0.6;
const LEVEL_RELEASE = 0.2;

interface TrackState {
  /** Smoothed level in dBFS. */
  level: number;
  /** Capture-clock time this track was last above the floor. */
  lastActiveAt: number;
  suppressing: boolean;
}

function freshTrack(): TrackState {
  return { level: SILENT_DBFS, lastActiveAt: Number.NEGATIVE_INFINITY, suppressing: false };
}

export type GateDecision = "pass" | "suppress";

/** One gate per call, shared by both of its tracks. */
export class AttributionGate {
  private readonly tracks: Record<Speaker, TrackState> = {
    caller: freshTrack(),
    victim: freshTrack(),
  };

  constructor(private readonly opts: GateOptions) {}

  /**
   * Decide what to do with one frame.
   *
   * @param role     whose frame this is
   * @param dbfs     that frame's level
   * @param atMs     the sender's capture-clock time, which is what allows the two
   *                 tracks to be compared despite independent socket jitter
   */
  decide(role: Speaker, dbfs: number, atMs: number): GateDecision {
    const me = this.tracks[role];
    const other = this.tracks[role === "caller" ? "victim" : "caller"];

    // Rise quickly to a new level, fall back slowly, so a brief dip mid-sentence
    // doesn't hand dominance to the other mic.
    const alpha = dbfs > me.level ? LEVEL_ATTACK : LEVEL_RELEASE;
    me.level = me.level * (1 - alpha) + dbfs * alpha;
    if (dbfs > this.opts.floorDbfs) me.lastActiveAt = atMs;

    if (!this.opts.enabled) {
      me.suppressing = false;
      return "pass";
    }

    // Nobody to defer to: the other track hasn't spoken recently enough.
    const otherRecentlyActive = atMs - other.lastActiveAt <= this.opts.hangoverMs;
    if (!otherRecentlyActive) {
      me.suppressing = false;
      return "pass";
    }

    // Our own frame is at or below the noise floor. It carries no speech, so
    // gating it changes nothing — and passing it keeps the stream continuous,
    // which Deepgram's endpointing relies on.
    if (dbfs <= this.opts.floorDbfs) {
      me.suppressing = false;
      return "pass";
    }

    const margin = other.level - me.level;
    const threshold = me.suppressing
      ? this.opts.dominanceDb - RELEASE_MARGIN_DB
      : this.opts.dominanceDb;

    me.suppressing = margin >= threshold;
    return me.suppressing ? "suppress" : "pass";
  }

  /** Whether a role's audio is currently being gated, for the live tuning readout. */
  isSuppressing(role: Speaker): boolean {
    return this.tracks[role].suppressing;
  }

  /** Smoothed level per track, for diagnostics. */
  levelOf(role: Speaker): number {
    return this.tracks[role].level;
  }
}
