const btn = document.getElementById("btn");
const btnlabel = document.getElementById("btn-label");
const welcome = document.getElementById("welcome");
const transcript = document.getElementById("transcript");
const card = document.getElementById("card");
let isRunning = false;

const _proto = window.location.protocol;                          
const _wsProto = _proto === "https:" ? "wss:" : "ws:";
const _host = window.location.host;                           
const API = `${_proto}//${_host}`;
const WS = `${_wsProto}//${_host}`;
let esrc = null;
let botmsg = null;
let uirsc = null;

const GEMINI_SAMPLE_RATE = 16000;
const GEMINI_OUT_RATE = 24000;
let audioContext = null;
let mediaStream = null;
let audioWorkletNode = null;
let audioWs = null;
let playbackCtx = null;
let nextPlayTime = 0;
let conversation = [];
let attempt = 0;
const maxAttempt = 3;
const RETRYABLE_WS_CLOSE_CODES = new Set([1006, 1008, 1011, 1012, 1013]);

function setActive() {
    btn.className = "active";
    btnlabel.innerHTML = `<span>⏹</span>`;
    window.vrmSetState?.('idle');
}
function setBotSpeaking() {
    btn.className = "active botpesu";
    btnlabel.innerHTML = `<div class="dot"><span></span><span></span><span></span></div>`;
    window.vrmSetState?.('bot');
}
function setUserSpeaking() {
    btn.className = "active userpesu";
    btnlabel.innerHTML = `<span>🎙️</span>`;
    window.vrmSetState?.('user');
}
function setIdle() {
    btn.className = ""; btnlabel.textContent = "Start";
    window.vrmSetState?.('idle');
}

function genUI() {
    uirsc = new EventSource(`${API}/gen-ui`);
    uirsc.onmessage = (event) => {

        const msg = JSON.parse(event.data);

        if (msg.type === "confirm") {
            const d = msg.data;
            conversation.push({ role: "patient", text: `Name: ${d.name}, Age: ${d.age}, Gender: ${d.gender}, Doctor: Dr. ${d.doctor}, Date: ${d.date}, Time: ${d.time}, Reason: ${d.reason}, Phone: ${d.phone}` });
        }
        else if (msg.type === "summary") {
            conversation.push({ role: 'bot', text: `Appointment booked with Dr. ${msg.data.doctor} on ${msg.data.date} at ${msg.data.time} for reason: ${msg.data.reason}` });
        }
        else if (msg.type === "update_summary") {
            conversation.push({ role: 'bot', text: `Appointment updated to Dr. ${msg.data.doctor} on ${msg.data.date} at ${msg.data.time} for reason: ${msg.data.reason}` });
        }
        else if (msg.type === "cancel_confirm") {
            conversation.push({ role: 'bot', text: `Asked cancellation confirmation for appointment ${msg.data.appointment_id}` });
        }
        else if (msg.type === "cancel_summary") {
            conversation.push({ role: 'bot', text: `Appointment cancelled with Dr. ${msg.data.doctor} on ${msg.data.date} at ${msg.data.time}` });
        }
        else if (msg.type === "upcoming") {
            conversation.push({ role: 'bot', text: `Showed upcoming appointments for update` });
        }
        if (conversation.length > 20)
            conversation.shift()

        console.log("genui:", msg);
        if (msg.type === "avaislots")
            renderSlots(msg.data)
        else if (msg.type === "summary")
            renderSummary(msg.data)
        // else if (msg.type === "alldoctor")
        //     renderAllDoctors(msg.data)
        else if (msg.type === "previous")
            renderPrevious(msg.data)
        else if (msg.type === "confirm")
            renderConfirm(msg.data)
        else if (msg.type === "upcoming")
            renderUpcoming(msg.data);
        else if (msg.type === "update_summary")
            renderUpdateSummary(msg.data);
        else if (msg.type === "cancel_confirm")
            renderCancelConfirm(msg.data);
        else if (msg.type === "cancel_summary")
            renderCancelSummary(msg.data);
    }
}

function stpgenUI() {
    if (uirsc) {
        uirsc.close();
        uirsc = null;
    }
}

async function injectTestMsg(text) {
    await fetch(`${API}/gen-ui-test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
    });
    card.classList.add("hidden");
    card.innerHTML = "";
    if (isRunning) window.vrmShow?.();
}
window.injectTestMsg = injectTestMsg;

// function startTrans() {
//     esrc = new EventSource(`${API}/transcript`);
//     esrc.onmessage = (event) => {
//         const data = JSON.parse(event.data);
//         if (data?.text) {
//             conversation.push({ role: data.role, text: data.text });
//             if (conversation.length > 40) conversation.shift();
//         }
//         if (data.role === "assistant") {
//             if (!botmsg) {
//                 botmsg = document.createElement("div");
//                 botmsg.className = "botmsg";
//                 // transcript.appendChild(botmsg);
//             }
//             botmsg.textContent = data.text;
//         } else {
//             botmsg = null;
//             const div = document.createElement("div");
//             div.className = "usermsg";
//             div.textContent = data.text;
//             // transcript.appendChild(div);
//         }
//         // transcript.scrollTop = transcript.scrollHeight;
//     };
// }

function stopTrans() {
    if (esrc) {

        esrc.close();
        esrc = null;
    }
}

async function startAudioCapture() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            sampleRate: GEMINI_SAMPLE_RATE,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        }
    });

    audioContext = new AudioContext({ sampleRate: GEMINI_SAMPLE_RATE });
    const actualRate = audioContext.sampleRate;
    console.log(`[audio] context: ${actualRate} Hz → target: ${GEMINI_SAMPLE_RATE} Hz`);

    const source = audioContext.createMediaStreamSource(mediaStream);

    await audioContext.audioWorklet.addModule('/static/processor.js?v=' + Date.now());
    audioWorkletNode = new AudioWorkletNode(audioContext, 'audio-in-processor', {
        processorOptions: {
            inputSampleRate: actualRate,
            outputSampleRate: GEMINI_SAMPLE_RATE,
        }
    });

    // Buffer chunks arriving before WS is open; flush on open.
    const pendingChunks = [];
    let wsReady = false;

    audioWs = new WebSocket(`${WS}/audio`);
    audioWs.binaryType = "arraybuffer";

    // FIX: return a Promise that resolves only when the WS is confirmed open.
    // btn.onclick awaits this before calling /greet, so the LLMRunFrame that
    // on_client_connected queued has time to initialise the Gemini session
    // before the greeting fires. Without this, /greet races the WS handshake
    // and the greeting prompt is dropped into a session that isn't ready yet.
    const wsOpenPromise = new Promise((resolve, reject) => {
        audioWs.onopen = () => {
            attempt = 0;
            wsReady = true;
            console.log("[audio] WS open — streaming Int16 PCM at", GEMINI_SAMPLE_RATE, "Hz");
            // Flush buffered audio chunks that arrived before the socket opened
            if (pendingChunks.length > 0) {
                console.log(`[audio] flushing ${pendingChunks.length} buffered chunks`);
                pendingChunks.forEach(chunk => audioWs.send(chunk));
                pendingChunks.length = 0;
            }
            resolve();
        };
        audioWs.onerror = (e) => {
            console.error("[audio] WS error:", e);
            reject(e);
        };
    });

    audioWs.onclose = async (e) => {
        wsReady = false;
        console.log("[audio] WS closed:", e);
        if (RETRYABLE_WS_CLOSE_CODES.has(e.code) && isRunning && attempt < maxAttempt) {
            attempt++;
            console.log(`[audio] (WS close ${e.code}) Attempting to reconnect... (${attempt}/${maxAttempt})`);
            await handleResume();
        }
    };

    playbackCtx = new AudioContext({ sampleRate: GEMINI_OUT_RATE });
    nextPlayTime = 0;
    audioWs.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength === 0) return;
        const int16 = new Int16Array(e.data);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 0x8000;
        }
        const buffer = playbackCtx.createBuffer(1, float32.length, GEMINI_OUT_RATE);
        buffer.getChannelData(0).set(float32);
        const src = playbackCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(playbackCtx.destination);
        const startAt = Math.max(playbackCtx.currentTime, nextPlayTime);
        src.start(startAt);
        nextPlayTime = startAt + buffer.duration;
        setBotSpeaking();
        src.onended = () => {
            if (nextPlayTime <= playbackCtx.currentTime) setActive();
        };
    };

    audioWorkletNode.port.onmessage = (e) => {
        if (!audioWs) return;
        if (wsReady && audioWs.readyState === WebSocket.OPEN) {
            audioWs.send(e.data);
        } else {
            // Buffer up to ~2s of audio (64 × 512-sample chunks at 16kHz)
            if (pendingChunks.length < 64) pendingChunks.push(e.data);
        }
    };

    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(audioWorkletNode);
    audioWorkletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    // Await WS open so btn.onclick only calls /greet after the pipeline
    // is guaranteed to be receiving frames.
    await wsOpenPromise;
}

async function handleResume() {
    const contextToResume = conversation
        .slice(-20)
        .map(msg => `${msg.role === 'assistant' || msg.role === 'bot' ? 'Priya' : 'Patient'}: ${msg.text}`)
        .join("\n");
    console.log("resume context built", { lines: contextToResume ? contextToResume.split("\n").length : 0 });
    if (audioWorkletNode) {
        audioWorkletNode.disconnect();
        audioWorkletNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (playbackCtx) {
        playbackCtx.close();
        playbackCtx = null;
    }
    audioWs = null;

    await new Promise(r => setTimeout(r, 1500));

    stpgenUI();
    genUI();
    // startAudioCapture now awaits WS open — safe to call /greet immediately after
    await startAudioCapture();
    await fetch(`${API}/greet`);
    if (contextToResume) {
        await fetch(`${API}/resume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: contextToResume })
        });
        console.log("context sent for resume");
    }
    setActive();
}




function stopAudioCapture() {
    if (audioWorkletNode) {
        audioWorkletNode.disconnect();
        audioWorkletNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null;
    }
    if (audioWs) {
        audioWs.close();
        audioWs = null;
    }
    if (playbackCtx) {
        playbackCtx.close();
        playbackCtx = null;
    }
    nextPlayTime = 0;
    console.log("[audio] capture stopped");
}


function renderSlots(data) {
    const slots = data.slots || [];
    const html = slots.map(s => {
        const [h, m] = s.split(":");
        const hour = parseInt(h);
        const ampm = hour >= 12 ? "PM" : "AM";
        const h12 = hour % 12 || 12;
        return `
        <button class="btn btn-outline-secondary btn-sm" onclick="injectTestMsg('I want ${s} slot')">${h12}:${m} ${ampm}</button>
        `;
    }).join("");
    card.innerHTML = `
        <p class="text-muted small text-uppercase fw-semibold mb-2">Tap a slot — Dr.${data.doctor} · ${data.date}</p>
        <div class="d-flex flex-wrap gap-2">${html || "<span class='text-muted small'>No slots available</span>"}</div>
    `;
    card.classList.remove("hidden");
    // window.vrmHide?.();
}


// function renderAllDoctors(data) {
//     const html = (data.doctors || []).map(d => {
//         const parts = d.split(", Specialty: ");
//         return `
//             <div class="d-flex justify-content-between align-items-center py-2 border-bottom" 
//                  style="cursor:pointer" onclick="injectTestMsg('I want to see ${parts[0]}')">
//                 <div>
//                     <div class="fw-500 small">${parts[0]}</div>
//                     <div class="text-muted" style="font-size:12px">${parts[1] || ""}</div>
//                 </div>
//                 <i class="text-muted small">›</i>
//             </div>`;
//     }).join("");
//     card.innerHTML = `
//         <p class="text-muted small text-uppercase fw-semibold mb-2">Tap a doctor to select</p>
//         ${html}
//     `;
//     card.classList.remove("hidden");
//     window.vrmHide?.();
// }

function renderPrevious(data) {
    const html = (data.appointments || []).map(a =>
        `<div class="py-2 border-bottom small text-secondary">${a}</div>`
    ).join("");
    card.innerHTML = `
        <p class="text-muted small text-uppercase fw-semibold mb-2">Previous Appointments</p>
        ${html || "<p class='text-muted small'>No previous appointments</p>"}
    `;
    card.classList.remove("hidden");
    // window.vrmHide?.();
}

function renderConfirm(data) {
    card.innerHTML = `
        <p class="text-muted small text-uppercase fw-semibold mb-2">Confirm Appointment</p>
        <table class="table table-sm table-borderless mb-3">
            <tbody>
                <tr><td class="text-muted small">Name</td><td class="small fw-500">${data.name}</td></tr>
                <tr><td class="text-muted small">Age</td><td class="small fw-500">${data.age}</td></tr>
                <tr><td class="text-muted small">Gender</td><td class="small fw-500">${data.gender}</td></tr>
                <tr><td class="text-muted small">Doctor</td><td class="small fw-500">Dr. ${data.doctor}</td></tr>
                <tr><td class="text-muted small">Date</td><td class="small fw-500">${data.date}</td></tr>
                <tr><td class="text-muted small">Time</td><td class="small fw-500">${data.time}</td></tr>
                <tr><td class="text-muted small">Reason</td><td class="small fw-500">${data.reason}</td></tr>
                <tr><td class="text-muted small">Phone</td><td class="small fw-500">${data.phone}</td></tr>
            </tbody>
        </table>
        <div class="d-flex gap-2">
            <button class="btn btn-success btn-sm flex-fill" onclick="injectTestMsg('Yes confirm the booking')">Confirm</button>
            <button class="btn btn-outline-secondary btn-sm flex-fill" onclick="injectTestMsg('No I want to change details')">✏️ Edit</button>
        </div>
    `;
    card.classList.remove("hidden");
    // window.vrmHide?.();
}

function renderSummary(data) {
    card.innerHTML = `

        <p class="text-success small text-uppercase fw-semibold mb-2">Appointment Booked</p>
        <table class="table table-sm table-borderless mb-0">
            <tbody>
                <tr><td class="text-muted small">Name</td><td class="small fw-500">${data.name}</td></tr>
                <tr><td class="text-muted small">Doctor</td><td class="small fw-500">Dr. ${data.doctor}</td></tr>
                <tr><td class="text-muted small">Date</td><td class="small fw-500">${data.date}</td></tr>
                <tr><td class="text-muted small">Time</td><td class="small fw-500">${data.time}</td></tr>
                <tr><td class="text-muted small">Reason</td><td class="small fw-500">${data.reason}</td></tr>
                <tr><td class="text-muted small">Phone</td><td class="small fw-500">${data.phone}</td></tr>
            </tbody>
        </table>
    `;
    card.classList.remove("hidden");
    // window.vrmHide?.();
}

function renderUpcoming(data) {
    const apts = data.appointments || [];
    if (apts.length === 0) {
        card.innerHTML = `<p class="text-muted small">No upcoming appointments to update or cancel</p>`;
        card.classList.remove("hidden");
        return;
    }
    const html = apts.map(a => {
        const [h, m] = a.time.split(":");
        const hour = parseInt(h);
        const ampm = hour >= 12 ? "PM" : "AM";
        const h12 = hour % 12 || 12;
        return `
            <div class="py-2 border-bottom">
                <div>
                    <div class="small fw-semibold">Dr. ${a.doctor}</div>
                    <div class="text-muted" style="font-size:12px">${a.date} · ${h12}:${m} ${ampm}</div>
                    <div class="text-muted" style="font-size:12px">${a.reason}</div>
                </div>
                <div class="d-flex gap-2 mt-2">
                    <button class="btn btn-warning btn-sm"
                        onclick="injectTestMsg('I want to update appointment id ${a.id} with Dr.${a.doctor} on ${a.date} at ${h12}:${m} ${ampm}')">
                        Update
                    </button>
                    <button class="btn btn-danger btn-sm"
                        onclick="injectTestMsg('I want to cancel appointment id ${a.id} with Dr.${a.doctor} on ${a.date} at ${h12}:${m} ${ampm}')">
                        Cancel
                    </button>
                </div>
            </div>`;
    }).join("");
    card.innerHTML = `
        <p class="text-muted small text-uppercase fw-semibold mb-2">Select appointment to update or cancel</p>
        ${html}
    `;
    card.classList.remove("hidden");
}

function renderCancelConfirm(data) {
    card.innerHTML = `
        <p class="text-danger small text-uppercase fw-semibold mb-2">Cancel Appointment Confirmation</p>
        <table class="table table-sm table-borderless mb-3">
            <tbody>
                <tr><td class="text-muted small">Appointment ID</td><td class="small fw-500">${data.appointment_id}</td></tr>
                <tr><td class="text-muted small">Name</td><td class="small fw-500">${data.name}</td></tr>
                <tr><td class="text-muted small">Doctor</td><td class="small fw-500">Dr. ${data.doctor}</td></tr>
                <tr><td class="text-muted small">Date</td><td class="small fw-500">${data.date}</td></tr>
                <tr><td class="text-muted small">Time</td><td class="small fw-500">${data.time}</td></tr>
                <tr><td class="text-muted small">Reason</td><td class="small fw-500">${data.reason}</td></tr>
            </tbody>
        </table>
        <p class="small mb-2">இந்த appointment cancel pannalama?</p>
        <div class="d-flex gap-2">
            <button class="btn btn-danger btn-sm flex-fill" onclick="injectTestMsg('Yes, confirm cancel appointment id ${data.appointment_id}')">Yes, Cancel</button>
            <button class="btn btn-outline-secondary btn-sm flex-fill" onclick="injectTestMsg('No, do not cancel this appointment')">No, Keep</button>
        </div>
    `;
    card.classList.remove("hidden");
}

function renderCancelSummary(data) {
    card.innerHTML = `
        <p class="text-success small text-uppercase fw-semibold mb-2">Appointment Cancelled</p>
        <table class="table table-sm table-borderless mb-0">
            <tbody>
                <tr><td class="text-muted small">Appointment ID</td><td class="small">${data.appointment_id}</td></tr>
                <tr><td class="text-muted small">Name</td><td class="small">${data.name}</td></tr>
                <tr><td class="text-muted small">Doctor</td><td class="small">Dr. ${data.doctor}</td></tr>
                <tr><td class="text-muted small">Date</td><td class="small">${data.date}</td></tr>
                <tr><td class="text-muted small">Time</td><td class="small">${data.time}</td></tr>
            </tbody>
        </table>
    `;
    card.classList.remove("hidden");
}

function renderUpdateSummary(data) {
    card.innerHTML = `
        <p class="text-success small text-uppercase fw-semibold mb-2">Appointment Updated</p>
        <table class="table table-sm table-borderless mb-0">
            <tbody>
                <tr><td class="text-muted small">Name</td><td class="small">${data.name}</td></tr>
                <tr><td class="text-muted small">Doctor</td><td class="small">Dr. ${data.doctor}</td></tr>
                <tr><td class="text-muted small">Date</td><td class="small">${data.date}</td></tr>
                <tr><td class="text-muted small">Time</td><td class="small">${data.time}</td></tr>
                <tr><td class="text-muted small">Reason</td><td class="small">${data.reason}</td></tr>
            </tbody>
        </table>
    `;
    card.classList.remove("hidden");
}

btn.onclick = async () => {
    if (isRunning) {
        btn.disabled = true;
        btnlabel.textContent = "Stopping";
        // stopTrans();
        stpgenUI();
        stopAudioCapture();
        await fetch(`${API}/restart`);
        // transcript.classList.remove("visible");
        // transcript.innerHTML = "";
        card.classList.add("hidden");
        card.innerHTML = "";
        botmsg = null;
        window.vrmHide?.();
        welcome.classList.remove("hidden");
        setIdle();
        isRunning = false;
        btn.disabled = false;
        conversation = [];
        attempt = 0;
        return;
    }

    welcome.classList.add("hidden");
    window.vrmShow?.();
    // transcript.classList.add("visible");
    btn.className = "active";
    btnlabel.innerHTML = `<div class="dot"><span></span><span></span><span></span></div>`;


    // startAudioCapture() now awaits WS open before resolving, so by the
    // time we reach /greet the Pipecat pipeline has already received the
    // LLMRunFrame from on_client_connected and is ready for audio frames.
    await startAudioCapture();
    // startTrans();
    genUI();
    isRunning = true;

    try {
        const greetText = await fetch(`${API}/greet`).then(r => r.text());
        console.log("greeted:", greetText);
    } catch (e) {
        console.error("Error during greeting:", e);
    }

    setActive();
};