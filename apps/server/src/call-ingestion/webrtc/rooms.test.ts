import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Speaker } from "@guardian-loop/shared-types";
import { RoomRegistry, type Room } from "./rooms";
import type { WebRtcServerMessage } from "./protocol";

const gate = { enabled: true, dominanceDb: 9, hangoverMs: 300, floorDbfs: -50 };

/** A participant connection, without a socket. */
function fakeLink() {
  const sent: WebRtcServerMessage[] = [];
  let closed = false;
  return {
    sent,
    get closed() {
      return closed;
    },
    link: {
      send: (m: WebRtcServerMessage) => sent.push(m),
      close: () => {
        closed = true;
      },
    },
  };
}

function makeRegistry(roomSecret = "s3cret") {
  const started: Room[] = [];
  const ended: Array<{ room: Room; reason: string }> = [];
  const registry = new RoomRegistry({
    roomSecret,
    gate,
    now: () => 1_700_000_000_000,
    onCallStarted: (room) => started.push(room),
    onCallEnded: (room, reason) => ended.push({ room, reason }),
  });
  return { registry, started, ended };
}

function join(registry: RoomRegistry, role: Speaker, secret = "s3cret", room = "demo") {
  const peer = fakeLink();
  const result = registry.join(room, role, secret, peer.link);
  return { peer, result };
}

describe("RoomRegistry joining", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("assigns one callId per room and shares it between both participants", () => {
    const { registry } = makeRegistry();
    const a = join(registry, "caller");
    const b = join(registry, "victim");

    expect(a.result.ok && b.result.ok).toBe(true);
    if (!a.result.ok || !b.result.ok) return;
    expect(a.result.room.callId).toBe(b.result.room.callId);
    // The contract calls for a UUID on browser calls.
    expect(a.result.room.callId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("tells the first participant whether a peer is already present", () => {
    const { registry } = makeRegistry();
    const first = join(registry, "caller");
    const second = join(registry, "victim");

    expect(first.result.ok && first.result.peerPresent).toBe(false);
    expect(second.result.ok && second.result.peerPresent).toBe(true);
  });

  it("notifies the waiting participant when the other joins", () => {
    const { registry } = makeRegistry();
    const first = join(registry, "caller");
    join(registry, "victim");

    expect(first.peer.sent).toEqual([{ type: "peer-joined", role: "victim" }]);
  });

  it("rejects a wrong or missing secret", () => {
    const { registry } = makeRegistry();
    expect(join(registry, "caller", "wrong").result).toMatchObject({
      ok: false,
      code: "bad_secret",
    });
    expect(registry.join("demo", "caller", undefined, fakeLink().link)).toMatchObject({
      ok: false,
      code: "bad_secret",
    });
  });

  it("allows any secret when none is configured", () => {
    const { registry } = makeRegistry("");
    expect(join(registry, "caller", "anything").result.ok).toBe(true);
  });

  it("refuses a role that is already taken, rather than evicting the person in it", () => {
    const { registry } = makeRegistry();
    join(registry, "caller");
    expect(join(registry, "caller").result).toMatchObject({ ok: false, code: "room_full" });
  });

  it("keeps separate rooms separate", () => {
    const { registry } = makeRegistry();
    const a = registry.join("room-a", "caller", "s3cret", fakeLink().link);
    const b = registry.join("room-b", "caller", "s3cret", fakeLink().link);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.room.callId).not.toBe(b.room.callId);
  });

  it("requires a room name", () => {
    const { registry } = makeRegistry();
    expect(registry.join("", "caller", "s3cret", fakeLink().link)).toMatchObject({
      ok: false,
      code: "bad_message",
    });
  });
});

describe("RoomRegistry call lifecycle", () => {
  it("starts the call on first audio, not merely on joining", () => {
    const { registry, started } = makeRegistry();
    const a = join(registry, "caller");
    join(registry, "victim");
    expect(started).toHaveLength(0); // both present, nobody has spoken

    if (!a.result.ok) return;
    registry.noteAudio(a.result.room);
    expect(started).toHaveLength(1);
  });

  it("starts the call exactly once no matter how much audio arrives", () => {
    const { registry, started } = makeRegistry();
    const a = join(registry, "caller");
    if (!a.result.ok) return;
    for (let i = 0; i < 50; i += 1) registry.noteAudio(a.result.room);
    expect(started).toHaveLength(1);
  });

  it("ends the call when either side leaves, like a two-party phone call", () => {
    const { registry, ended } = makeRegistry();
    const a = join(registry, "caller");
    const b = join(registry, "victim");
    if (!a.result.ok) return;
    registry.noteAudio(a.result.room);

    registry.leave(a.result.room, "caller");
    expect(ended).toHaveLength(1);
    expect(ended[0].reason).toBe("hangup");
    // The one still connected is told why, then disconnected.
    expect(b.peer.sent).toContainEqual({ type: "peer-left", role: "caller" });
    expect(b.peer.closed).toBe(true);
  });

  it("does not end a call that never started", () => {
    const { registry, ended } = makeRegistry();
    const a = join(registry, "caller");
    if (!a.result.ok) return;
    registry.leave(a.result.room, "caller");
    expect(ended).toHaveLength(0);
  });

  it("ends a call only once, even if both sockets close", () => {
    const { registry, ended } = makeRegistry();
    const a = join(registry, "caller");
    join(registry, "victim");
    if (!a.result.ok) return;
    registry.noteAudio(a.result.room);

    registry.leave(a.result.room, "caller");
    registry.leave(a.result.room, "victim");
    expect(ended).toHaveLength(1);
  });

  it("frees the room so the same name can be reused for a fresh call", () => {
    const { registry } = makeRegistry();
    const first = join(registry, "caller");
    if (!first.result.ok) return;
    const firstCallId = first.result.room.callId;
    registry.leave(first.result.room, "caller");

    const second = join(registry, "caller");
    expect(second.result.ok).toBe(true);
    if (!second.result.ok) return;
    expect(second.result.room.callId).not.toBe(firstCallId);
  });

  it("numbers seq monotonically per participant", () => {
    const { registry } = makeRegistry();
    const a = join(registry, "caller");
    if (!a.result.ok) return;
    // Bind after narrowing: TS can't keep it through the callback below.
    const { participant } = a.result;
    const seqs = [1, 2, 3].map(() => registry.nextSeq(participant));
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("only reports calls that have actually started as active", () => {
    const { registry } = makeRegistry();
    const a = join(registry, "caller");
    expect(registry.activeCallIds).toEqual([]);
    if (!a.result.ok) return;
    registry.noteAudio(a.result.room);
    expect(registry.activeCallIds).toEqual([a.result.room.callId]);
  });

  it("ends every live call on shutdown", () => {
    const { registry, ended } = makeRegistry();
    const a = registry.join("room-a", "caller", "s3cret", fakeLink().link);
    const b = registry.join("room-b", "victim", "s3cret", fakeLink().link);
    if (!a.ok || !b.ok) return;
    registry.noteAudio(a.room);
    registry.noteAudio(b.room);

    registry.closeAll();
    expect(ended.map((e) => e.reason)).toEqual(["manual", "manual"]);
    expect(registry.activeCallIds).toEqual([]);
  });
});

describe("RoomRegistry signalling relay", () => {
  it("forwards a message to the other participant only", () => {
    const { registry } = makeRegistry();
    const a = join(registry, "caller");
    const b = join(registry, "victim");
    if (!a.result.ok) return;

    registry.relay(a.result.room, "caller", { type: "offer", sdp: "v=0" });
    expect(b.peer.sent).toContainEqual({ type: "offer", sdp: "v=0" });
    expect(a.peer.sent).not.toContainEqual({ type: "offer", sdp: "v=0" });
  });

  it("drops a relay when nobody else is there, instead of throwing", () => {
    const { registry } = makeRegistry();
    const a = join(registry, "caller");
    if (!a.result.ok) return;
    const { room } = a.result;
    expect(() => registry.relay(room, "caller", { type: "ice", candidate: {} })).not.toThrow();
  });
});
