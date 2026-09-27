// The call page.
//
// Two jobs at once, over one WebSocket:
//   1. Connect to the other browser with RTCPeerConnection so the two people can
//      hear each other. That audio is peer-to-peer and never reaches the server.
//   2. Fork a copy of THIS browser's own microphone to the server, which is what
//      Guardian Loop analyses. The remote track is never forwarded, so each
//      transcript track belongs to exactly one person.

const params = new URLSearchParams(location.search);
const room = params.get("room") || "";
const role = params.get("role") || "";
const secret = params.get("secret") || "";

const els = {
  join: document.getElementById("join"),
  live: document.getElementById("live"),
  form: document.getElementById("join-form"),
  room: document.getElementById("room-input"),
  secret: document.getElementById("secret-input"),
  role: document.getElementById("role-input"),
  roleBadge: document.getElementById("role-badge"),
  roomBadge: document.getElementById("room-badge"),
  status: document.getElementById("status"),
  peer: document.getElementById("peer-status"),
  gate: document.getElementById("gate-status"),
  meter: document.getElementById("meter-fill"),
  remote: document.getElementById("remote-audio"),
  hangup: document.getElementById("hangup"),
  mute: document.getElementById("mute"),
  error: document.getElementById("error"),
};

let ws;
let pc;
let micStream;
let audioCtx;
let workletNode;
let captureStartedAt = 0;
let seq = 0;
let muted = false;
let hungUp = false;
/** ICE candidates that arrive before the remote description is set. */
const pendingCandidates = [];

function setStatus(text) {
  els.status.textContent = text;
}

function showError(text) {
  els.error.textContent = text;
  els.error.hidden = false;
}

// ---------------------------------------------------------------------------
// Join screen
// ---------------------------------------------------------------------------

if (room && (role === "caller" || role === "victim")) {
  start().catch((err) => showError(err.message || String(err)));
} else {
  els.join.hidden = false;
  if (room) els.room.value = room;
  if (secret) els.secret.value = secret;
  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = new URLSearchParams({
      room: els.room.value.trim(),
      role: els.role.value,
      secret: els.secret.value.trim(),
    });
    location.search = `?${next.toString()}`;
  });
}

// ---------------------------------------------------------------------------
// Call setup
// ---------------------------------------------------------------------------

async function start() {
  els.live.hidden = false;
  els.roleBadge.textContent = role;
  els.roleBadge.dataset.role = role;
  els.roomBadge.textContent = room;
  setStatus("requesting microphone…");

  micStream = await getMicrophone();
  setStatus("connecting…");
  startLevelMeter(micStream);

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/webrtc/ws`);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join", room, role, secret }));
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(msg).catch((err) => showError(err.message || String(err)));
  });

  ws.addEventListener("close", () => {
    if (!hungUp) setStatus("disconnected");
    stopCapture();
  });

  ws.addEventListener("error", () => showError("WebSocket error — is the server running?"));

  els.hangup.addEventListener("click", hangUp);
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("pagehide", hangUp);
}

/**
 * Capture constraints matter more than they look.
 *
 * echoCancellation and noiseSuppression: on — standard for voice, and they help in
 * a shared room. autoGainControl: OFF deliberately. AGC raises the mic gain during
 * your silence, which amplifies the other person and the room, and destabilises the
 * levels the server's attribution gate compares.
 */
async function getMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "This browser can't capture audio here. getUserMedia needs a secure context — " +
        "load this page over https (or from localhost), not a plain http LAN address."
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    if (err && err.name === "NotAllowedError") {
      throw new Error("Microphone permission was denied. Allow it and reload the page.");
    }
    throw new Error(`Could not open the microphone: ${err?.message || err}`);
  }
}

async function handleServerMessage(msg) {
  switch (msg.type) {
    case "joined":
      setStatus("waiting for the other person…");
      els.peer.textContent = msg.peerPresent ? "peer present" : "alone in the room";
      await setUpPeerConnection(msg.iceServers);
      await startCapture(msg.capture);
      // The caller always makes the offer, so the two sides never collide.
      if (role === "caller" && msg.peerPresent) await sendOffer();
      return;

    case "peer-joined":
      els.peer.textContent = "peer present";
      if (role === "caller") await sendOffer();
      return;

    case "peer-left":
      els.peer.textContent = "peer left";
      setStatus("the other person hung up");
      return;

    case "offer":
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      await drainCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: "answer", sdp: answer.sdp }));
      return;

    case "answer":
      await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      await drainCandidates();
      return;

    case "ice":
      if (!msg.candidate) return;
      // Candidates can arrive before the remote description exists; hold them.
      if (!pc || !pc.remoteDescription) pendingCandidates.push(msg.candidate);
      else await pc.addIceCandidate(msg.candidate).catch(() => {});
      return;

    case "gate":
      els.gate.textContent = msg.suppressed ? "gated (other speaker louder)" : "live";
      els.gate.dataset.suppressed = String(msg.suppressed);
      return;

    case "error":
      showError(`${msg.message} (${msg.code})`);
      return;
  }
}

async function setUpPeerConnection(iceServers) {
  pc = new RTCPeerConnection({ iceServers });

  for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);

  pc.addEventListener("track", (event) => {
    // The other person's audio. Playing it through earbuds is what keeps it out of
    // our own microphone.
    els.remote.srcObject = event.streams[0];
    els.remote.play().catch(() => {
      setStatus("tap anywhere to allow audio playback");
      document.body.addEventListener("click", () => els.remote.play().catch(() => {}), {
        once: true,
      });
    });
  });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) ws.send(JSON.stringify({ type: "ice", candidate: event.candidate }));
  });

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") setStatus("connected");
    else if (pc.connectionState === "failed") {
      showError("Peer connection failed. On the same network this is unusual — check STUN.");
    } else setStatus(pc.connectionState);
  });
}

async function sendOffer() {
  if (!pc || pc.signalingState !== "stable") return;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
}

async function drainCandidates() {
  while (pendingCandidates.length > 0) {
    await pc.addIceCandidate(pendingCandidates.shift()).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Microphone fork to the server
// ---------------------------------------------------------------------------

async function startCapture(capture) {
  // Ask for the target rate directly so the browser does the resampling, which is
  // better than anything we'd write. The worklet falls back to interpolating if the
  // browser ignores the request.
  audioCtx = new AudioContext({ sampleRate: capture.sampleRate });
  await audioCtx.audioWorklet.addModule("capture-worklet.js");

  const source = audioCtx.createMediaStreamSource(micStream);
  workletNode = new AudioWorkletNode(audioCtx, "capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: {
      targetRate: capture.sampleRate,
      encoding: capture.encoding,
      frameMs: capture.frameMs,
    },
  });

  captureStartedAt = performance.now();
  workletNode.port.onmessage = (event) => {
    if (event.data?.type !== "frame") return;
    if (muted || !ws || ws.readyState !== WebSocket.OPEN) return;

    const payload = new Uint8Array(event.data.payload);
    // 6-byte header: elapsed capture time and a sequence number. The elapsed time is
    // what lets the server line this track up against the other one.
    const frame = new Uint8Array(6 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint32(0, Math.round(performance.now() - captureStartedAt));
    view.setUint16(4, seq & 0xffff);
    seq += 1;
    frame.set(payload, 6);
    ws.send(frame);
  };

  source.connect(workletNode);
}

function stopCapture() {
  try {
    workletNode?.port.postMessage("stop");
    workletNode?.disconnect();
    audioCtx?.close();
  } catch {
    /* already torn down */
  }
  workletNode = undefined;
  audioCtx = undefined;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * Local level meter. Separate from the capture path on purpose — it's only for the
 * person to confirm their mic works, and it must never affect what's sent.
 */
function startLevelMeter(stream) {
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  function tick() {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    // Map roughly -60..0 dBFS onto the bar.
    const db = rms > 0 ? 20 * Math.log10(rms) : -60;
    els.meter.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    requestAnimationFrame(tick);
  }
  tick();
}

function toggleMute() {
  muted = !muted;
  for (const track of micStream.getAudioTracks()) track.enabled = !muted;
  els.mute.textContent = muted ? "Unmute" : "Mute";
  els.mute.dataset.muted = String(muted);
}

function hangUp() {
  if (hungUp) return;
  hungUp = true;
  setStatus("call ended");
  try {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "bye" }));
  } catch {
    /* socket already gone */
  }
  stopCapture();
  pc?.close();
  micStream?.getTracks().forEach((track) => track.stop());
  ws?.close();
}
