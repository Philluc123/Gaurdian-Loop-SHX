// Browser WebRTC call ingestion (docs/module-contracts.md §3.1).
//
// Serves the call page, relays signalling so the two browsers can connect directly
// to each other, receives each participant's own microphone over the same socket,
// and publishes call.started / audio.frame / call.ended — nothing else.

import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import express, { type Router } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  AudioFrame,
  CallEnded,
  CallStarted,
  Guardian,
  Speaker,
} from "@guardian-loop/shared-types";
import { CALL_PAGE_PATH, type WebRtcConfig } from "../../config";
import { frameDbfs, silenceLike } from "./levels";
import { RoomRegistry, type Participant, type Room } from "./rooms";
import {
  FRAME_MS,
  decodeAudioFrame,
  isSpeaker,
  parseClientMessage,
  type CaptureFormat,
  type WebRtcServerMessage,
} from "./protocol";

export interface WebRtcIngestionDeps {
  webrtc: WebRtcConfig;
  guardian: Guardian;
  publish: (event: CallStarted | AudioFrame | CallEnded) => void;
}

export interface WebRtcIngestion {
  router: Router;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  readonly activeCallIds: string[];
  close(): void;
}

export function createWebRtcIngestion(deps: WebRtcIngestionDeps): WebRtcIngestion {
  const { webrtc, guardian, publish } = deps;

  const capture: CaptureFormat = {
    encoding: webrtc.encoding,
    sampleRate: webrtc.sampleRate,
    frameMs: FRAME_MS,
  };

  const rooms = new RoomRegistry({
    roomSecret: webrtc.roomSecret,
    gate: webrtc.gate,
    onCallStarted(room) {
      console.log(`[webrtc] call started ${room.callId} (room "${room.roomId}")`);
      publish({
        type: "call.started",
        callId: room.callId,
        source: "webrtc",
        from: `room:${room.roomId}`,
        to: `room:${room.roomId}`,
        guardian,
        ts: Date.now(),
      });
    },
    onCallEnded(room, reason) {
      console.log(`[webrtc] call ended ${room.callId} (${reason})`);
      publish({ type: "call.ended", callId: room.callId, reason, ts: Date.now() });
    },
  });

  const wss = new WebSocketServer({ noServer: true });
  const router = express.Router();

  // The call page: plain static files, no bundler. One page with no build step is
  // one less thing to break, and it lets a phone load it straight from the tunnel.
  router.use(CALL_PAGE_PATH, express.static(path.join(__dirname, "public")));

  wss.on("connection", (socket: WebSocket) => {
    // Per-connection state, set once this participant has joined a room.
    let room: Room | undefined;
    let participant: Participant | undefined;
    let role: Speaker | undefined;
    let lastGateReported: boolean | undefined;

    const send = (message: WebRtcServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    function handleControl(raw: string): void {
      const msg = parseClientMessage(raw);
      if (!msg) {
        send({ type: "error", code: "bad_message", message: "expected a JSON control message" });
        return;
      }

      if (msg.type === "join") {
        if (room) return; // already joined; ignore duplicates
        if (!isSpeaker(msg.role)) {
          send({ type: "error", code: "bad_role", message: "role must be caller or victim" });
          socket.close();
          return;
        }

        const result = rooms.join(msg.room, msg.role, msg.secret, {
          send,
          close: () => socket.close(),
        });
        if (!result.ok) {
          console.warn(`[webrtc] join rejected (${result.code}): ${result.message}`);
          send({ type: "error", code: result.code, message: result.message });
          socket.close();
          return;
        }

        room = result.room;
        participant = result.participant;
        role = msg.role;
        console.log(
          `[webrtc] ${role} joined room "${result.room.roomId}" as call ${result.room.callId}` +
            (result.peerPresent ? " (peer already present)" : "")
        );
        send({
          type: "joined",
          callId: result.room.callId,
          role: msg.role,
          peerPresent: result.peerPresent,
          iceServers: webrtc.stunUrls.map((urls) => ({ urls })),
          capture,
        });
        return;
      }

      if (!room || !role) {
        send({ type: "error", code: "not_joined", message: "join before signalling" });
        return;
      }

      switch (msg.type) {
        // SDP and ICE are relayed verbatim — this server never inspects them.
        case "offer":
          rooms.relay(room, role, { type: "offer", sdp: msg.sdp });
          return;
        case "answer":
          rooms.relay(room, role, { type: "answer", sdp: msg.sdp });
          return;
        case "ice":
          rooms.relay(room, role, { type: "ice", candidate: msg.candidate });
          return;
        case "bye":
          rooms.leave(room, role, "hangup");
          socket.close();
          return;
        default:
          return;
      }
    }

    function handleAudio(data: Buffer): void {
      if (!room || !role || !participant) return; // audio before join: drop it

      const frame = decodeAudioFrame(data);
      if (!frame) return;

      // First audio starts the call, so a page left sitting on the join screen
      // doesn't create an empty one.
      rooms.noteAudio(room);

      // Attribution gate: two open mics in one room each hear both people, so
      // silence the clearly-quieter track. The frame still flows (as silence)
      // rather than being dropped, because Deepgram's endpointing depends on a
      // continuous stream.
      const dbfs = frameDbfs(frame.payload, capture.encoding);
      const decision = room.gate.decide(role, dbfs, frame.elapsedMs);
      const payload =
        decision === "suppress" ? silenceLike(frame.payload, capture.encoding) : frame.payload;

      publish({
        type: "audio.frame",
        callId: room.callId,
        speaker: role,
        encoding: capture.encoding,
        sampleRate: capture.sampleRate,
        payload: payload.toString("base64"),
        seq: rooms.nextSeq(participant),
        ts: Date.now(),
      });

      // Report only on change, so tuning in the room is visible without flooding.
      const suppressed = decision === "suppress";
      if (suppressed !== lastGateReported) {
        lastGateReported = suppressed;
        send({ type: "gate", suppressed });
      }
    }

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) handleAudio(data);
      else handleControl(data.toString("utf8"));
    });

    socket.on("close", () => {
      if (room && role) rooms.leave(room, role, "hangup");
      room = undefined;
      participant = undefined;
    });

    socket.on("error", (err) => {
      console.error(`[webrtc] socket error (${role ?? "unjoined"}):`, err.message);
      if (room && role) rooms.leave(room, role, "error");
    });
  });

  return {
    router,
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    get activeCallIds() {
      return rooms.activeCallIds;
    },
    close() {
      rooms.closeAll();
      wss.close();
    },
  };
}

export { AttributionGate } from "./gate";
export { RoomRegistry } from "./rooms";
