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
/** ?debug=1 shows the gate state and mic meter, for tuning in the demo room. */
const debug = params.get("debug") === "1";

/** The name at the top of the screen: this phone's own role. */
const CONTACT_NAME = { caller: "Caller", victim: "Victim" };

const els = {
  join: document.getElementById("join"),
  live: document.getElementById("live"),
  form: document.getElementById("join-form"),
  room: document.getElementById("room-input"),
  secret: document.getElementById("secret-input"),
  role: document.getElementById("role-input"),
  name: document.getElementById("contact-name"),
  status: document.getElementById("status"),
  debug: document.getElementById("debug"),
  peer: document.getElementById("peer-status"),
  gate: document.getElementById("gate-status"),
  meter: document.getElementById("meter-fill"),
  remote: document.getElementById("remote-audio"),
  hangup: document.getElementById("hangup"),
  hangupKeypad: document.getElementById("hangup-keypad"),
  mute: document.getElementById("mute"),
  speaker: document.getElementById("speaker"),
  controlsView: document.getElementById("controls-view"),
  keypadView: document.getElementById("keypad-view"),
  keypadOpen: document.getElementById("keypad-open"),
  keypadHide: document.getElementById("keypad-hide"),
  keypadDisplay: document.getElementById("keypad-display"),
  keys: document.getElementById("keys"),
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

/** Call timer: replaces the status line once the call connects, as on iOS. */
let timer;
let connectedAt = 0;

function setStatus(text) {
  if (timer) return; // the running timer owns the line
  els.status.textContent = text;
}

function startTimer() {
  if (timer) return;
  connectedAt = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - connectedAt) / 1000);
    els.status.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function stopTimer(finalText) {
  clearInterval(timer);
  timer = undefined;
  els.status.textContent = finalText;
}

function showError(text) {
  els.error.textContent = text;
  els.error.hidden = false;
}

// ---------------------------------------------------------------------------
// Call setup
// ---------------------------------------------------------------------------

async function start() {
  els.live.hidden = false;
  els.name.textContent = CONTACT_NAME[role];
  document.title = CONTACT_NAME[role];
  els.debug.hidden = !debug;
  buildKeypad();
  // Wire the controls first, so End works even while the mic prompt is open.
  els.hangup.addEventListener("click", hangUp);
  els.hangupKeypad.addEventListener("click", hangUp);
  els.mute.addEventListener("click", toggleMute);
  els.speaker.addEventListener("click", () => toggleButton(els.speaker));
  els.keypadOpen.addEventListener("click", () => showKeypad(true));
  els.keypadHide.addEventListener("click", () => showKeypad(false));
  window.addEventListener("pagehide", hangUp);

  setStatus("connecting…");
  micStream = await getMicrophone();
  if (debug) startLevelMeter(micStream);

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
    if (!hungUp) stopTimer("call ended");
    stopCapture();
  });

  ws.addEventListener("error", () => showError("Couldn't reach the call server — is it running?"));
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
      setStatus(role === "caller" ? "calling…" : "waiting for call…");
      els.peer.textContent = msg.peerPresent ? "present" : "not joined yet";
      await setUpPeerConnection(msg.iceServers);
      await startCapture(msg.capture);
      // The caller always makes the offer, so the two sides never collide.
      if (role === "caller" && msg.peerPresent) await sendOffer();
      return;

    case "peer-joined":
      els.peer.textContent = "present";
      if (role === "caller") await sendOffer();
      return;

    case "peer-left":
      els.peer.textContent = "left";
      stopTimer("call ended");
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
    // The timer starts when the two phones can actually hear each other, like
    // the iOS call timer starting on answer.
    if (pc.connectionState === "connected") startTimer();
    else if (pc.connectionState === "failed") {
      showError("Couldn't connect the two phones. On one network this is unusual — check STUN.");
    }
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

/** iOS-style toggle: a pressed control turns white. */
function toggleButton(button) {
  const on = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(on));
  return on;
}

function toggleMute() {
  muted = toggleButton(els.mute);
  // Before the mic is open there's nothing to mute yet; the flag still applies
  // once capture starts, because the worklet checks it for every frame.
  for (const track of micStream?.getAudioTracks() ?? []) track.enabled = !muted;
}

// ---------------------------------------------------------------------------
// Keypad
// ---------------------------------------------------------------------------

const KEYS = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
];

/** DTMF: every key is the sum of one row tone and one column tone. */
const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
  "*": [941, 1209], 0: [941, 1336], "#": [941, 1477],
};

function buildKeypad() {
  for (const [digit, letters] of KEYS) {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "key";
    key.setAttribute("aria-label", digit);
    key.innerHTML = `<span class="key-digit">${digit}</span><span class="key-letters">${letters}</span>`;
    key.addEventListener("pointerdown", () => pressKey(digit));
    els.keys.appendChild(key);
  }

  // A physical keyboard works too while the keypad is open.
  window.addEventListener("keydown", (event) => {
    if (els.keypadView.hidden || !(event.key in DTMF)) return;
    const key = [...els.keys.children][KEYS.findIndex(([d]) => d === event.key)];
    key?.classList.add("pressed");
    setTimeout(() => key?.classList.remove("pressed"), 120);
    pressKey(event.key);
  });
}

function showKeypad(open) {
  els.keypadView.hidden = !open;
  els.controlsView.hidden = open;
}

let toneCtx;

function pressKey(digit) {
  els.keypadDisplay.textContent += digit;

  // Send the tone to the other phone the way real phones do — in-band DTMF over
  // the call — so the other person actually hears it.
  const sender = pc?.getSenders().find((s) => s.track?.kind === "audio");
  if (sender?.dtmf?.canInsertDTMF) sender.dtmf.insertDTMF(digit, 120, 70);

  // And play it locally, quietly, as the phone's own keypress feedback.
  try {
    toneCtx ??= new AudioContext();
    const gain = toneCtx.createGain();
    gain.gain.value = 0.08;
    gain.connect(toneCtx.destination);
    const stopAt = toneCtx.currentTime + 0.14;
    for (const freq of DTMF[digit]) {
      const osc = toneCtx.createOscillator();
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start();
      osc.stop(stopAt);
    }
  } catch {
    /* no audio output available — the digit still shows */
  }
}

function hangUp() {
  if (hungUp) return;
  hungUp = true;
  stopTimer("call ended");
  showKeypad(false);
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

// ---------------------------------------------------------------------------
// Entry point — last, so every constant above (the keypad tables included) is
// initialised before anything runs.
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
