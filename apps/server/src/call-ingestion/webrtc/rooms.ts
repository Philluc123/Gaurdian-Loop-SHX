// Room registry: pairs a caller and a victim into one call, relays signalling
// between them, and owns the call's lifecycle.
//
// Deliberately knows nothing about `ws` or Express. A participant is just
// something that can be sent a message and closed, so the unit tests drive this
// with plain objects.

import { randomUUID } from "node:crypto";
import type { CallId, Speaker } from "@guardian-loop/shared-types";
import { AttributionGate, type GateOptions } from "./gate";
import { otherRole, type WebRtcErrorCode, type WebRtcServerMessage } from "./protocol";

/** Whatever transport a participant is on, seen only through these two methods. */
export interface ParticipantLink {
  send(message: WebRtcServerMessage): void;
  close(): void;
}

export interface Participant {
  role: Speaker;
  link: ParticipantLink;
  /** Server-side monotonic counter, so AudioFrame.seq is always increasing. */
  seq: number;
  joinedAt: number;
}

export interface Room {
  roomId: string;
  callId: CallId;
  createdAt: number;
  participants: Map<Speaker, Participant>;
  gate: AttributionGate;
  /** True once call.started has been published, so it fires exactly once. */
  announced: boolean;
}

export interface RoomRegistryOptions {
  /** Required to join; empty disables the check (with a warning at boot). */
  roomSecret: string;
  gate: GateOptions;
  now?: () => number;
  /** Called when a call's first audio arrives, and when the call ends. */
  onCallStarted(room: Room): void;
  onCallEnded(room: Room, reason: "hangup" | "error" | "manual"): void;
}

export type JoinResult =
  | { ok: true; room: Room; participant: Participant; peerPresent: boolean }
  | { ok: false; code: WebRtcErrorCode; message: string };

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;

  constructor(private readonly opts: RoomRegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  get activeCallIds(): CallId[] {
    return [...this.rooms.values()].filter((r) => r.announced).map((r) => r.callId);
  }

  join(
    roomId: string,
    role: Speaker,
    secret: string | undefined,
    link: ParticipantLink
  ): JoinResult {
    if (this.opts.roomSecret && secret !== this.opts.roomSecret) {
      return { ok: false, code: "bad_secret", message: "wrong or missing room secret" };
    }
    if (!roomId) {
      return { ok: false, code: "bad_message", message: "room is required" };
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        roomId,
        // The contract's CallId is a UUID for browser calls.
        callId: randomUUID(),
        createdAt: this.now(),
        participants: new Map(),
        gate: new AttributionGate(this.opts.gate),
        announced: false,
      };
      this.rooms.set(roomId, room);
    }

    if (room.participants.has(role)) {
      return {
        ok: false,
        code: "room_full",
        message: `the ${role} seat in room "${roomId}" is already taken`,
      };
    }

    const participant: Participant = { role, link, seq: 0, joinedAt: this.now() };
    room.participants.set(role, participant);

    const peer = room.participants.get(otherRole(role));
    if (peer) peer.link.send({ type: "peer-joined", role });

    return { ok: true, room, participant, peerPresent: Boolean(peer) };
  }

  /** Relay a signalling message to the other participant, if they're present. */
  relay(room: Room, from: Speaker, message: WebRtcServerMessage): void {
    room.participants.get(otherRole(from))?.link.send(message);
  }

  /**
   * Called for each audio frame. Publishing call.started here rather than on join
   * means a call begins when audio actually starts flowing, not when someone merely
   * opens the page and sits there.
   */
  noteAudio(room: Room): void {
    if (room.announced) return;
    room.announced = true;
    this.opts.onCallStarted(room);
  }

  nextSeq(participant: Participant): number {
    participant.seq += 1;
    return participant.seq;
  }

  /**
   * A participant's connection closed.
   *
   * A two-party call ends when either side hangs up, so this tears the whole room
   * down rather than waiting for the other to leave. That also makes a page refresh
   * end the call, which is predictable and easy to explain during a demo.
   */
  leave(room: Room, role: Speaker, reason: "hangup" | "error" | "manual" = "hangup"): void {
    if (!this.rooms.has(room.roomId)) return; // already torn down
    this.rooms.delete(room.roomId);
    room.participants.delete(role);

    for (const remaining of room.participants.values()) {
      remaining.link.send({ type: "peer-left", role });
      remaining.link.close();
    }
    room.participants.clear();

    if (room.announced) this.opts.onCallEnded(room, reason);
  }

  /** Shutdown: end every live call so nothing is left half-open. */
  closeAll(): void {
    for (const room of [...this.rooms.values()]) {
      const anyRole = [...room.participants.keys()][0];
      this.leave(room, anyRole ?? "caller", "manual");
    }
  }
}
