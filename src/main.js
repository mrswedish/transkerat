import { createMaskingController, flashButtonFeedback } from "./masking.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const message = window.__TAURI__.dialog ? window.__TAURI__.dialog.message : window.alert;

function logToFile(msg) {
  invoke("log_message", { msg: `[JS] ${msg}` }).catch(() => {});
}

window.addEventListener("error", (e) => {
  logToFile(`window.error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason && (e.reason.stack || e.reason.message || String(e.reason));
  logToFile(`unhandledrejection: ${reason}`);
});

// UI Elements
const badge = document.getElementById("status-badge");
const btnRecord = document.getElementById("btn-record");
const btnFile = document.getElementById("btn-file");
const btnCopy = document.getElementById("btn-copy");
const btnSave = document.getElementById("btn-save");
const outputText = document.getElementById("output-text");
const recordingIndicator = document.getElementById("recording-status");
const recordingStatusText = document.getElementById("recording-status-text");
const idleHint = document.getElementById("idle-hint");

// ─────────────────────────────────────────────────────────────────────────────
// Tillgänglighet (WCAG 2.1 AA)
// ─────────────────────────────────────────────────────────────────────────────
const srStatusEl = document.getElementById("sr-status");
let srStatusTimer = null;
function announce(text) {
  if (!srStatusEl) return;
  srStatusEl.textContent = "";
  clearTimeout(srStatusTimer);
  srStatusTimer = setTimeout(() => { srStatusEl.textContent = text; }, 60);
}

(function wireProgressAria() {
  const bar = document.getElementById("progress-bar");
  const box = document.getElementById("progress-container");
  if (!bar || !box) return;
  new MutationObserver(() => {
    const n = Math.max(0, Math.min(100, parseInt(bar.style.width, 10) || 0));
    box.setAttribute("aria-valuenow", String(n));
    box.setAttribute("aria-valuetext", `${n} procent`);
  }).observe(bar, { attributes: true, attributeFilter: ["style"] });
})();

(function wireDialogs() {
  const DIALOGS = {
    "settings-modal": "btn-close-settings",
    "confirm-modal": "confirm-cancel",
    "import-choice-modal": "import-choice-cancel",
    "stereo-mix-modal": "btn-close-stereo-mix",
    "reset-modal": "reset-cancel",
  };
  const stack = [];
  const openers = new Map();
  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  const visible = (el) => el.getClientRects().length > 0;
  const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter(visible);

  function syncInert() {
    const bg = document.querySelectorAll("body > header, body > section, body > main, body > footer, body > .skip-link");
    const top = stack[stack.length - 1] || null;
    bg.forEach(el => el.toggleAttribute("inert", !!top));
    for (const id of Object.keys(DIALOGS)) {
      const el = document.getElementById(id);
      if (el) el.toggleAttribute("inert", !!top && el !== top);
    }
  }
  function opened(el) {
    if (stack.includes(el)) return;
    openers.set(el, document.activeElement);
    stack.push(el);
    syncInert();
    requestAnimationFrame(() => {
      const target = el.querySelector("[data-autofocus]") || focusables(el)[0];
      if (target) target.focus();
    });
  }
  function closed(el) {
    const i = stack.indexOf(el);
    if (i === -1) return;
    stack.splice(i, 1);
    syncInert();
    const back = openers.get(el);
    openers.delete(el);
    requestAnimationFrame(() => {
      if (back && document.contains(back) && visible(back)) back.focus();
    });
  }
  for (const id of Object.keys(DIALOGS)) {
    const el = document.getElementById(id);
    if (!el) continue;
    const check = () => (el.classList.contains("hidden") ? closed(el) : opened(el));
    new MutationObserver(check).observe(el, { attributes: true, attributeFilter: ["class"] });
  }
  document.addEventListener("keydown", (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      const btn = document.getElementById(DIALOGS[top.id]);
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (e.key === "Tab") {
      const f = focusables(top);
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !top.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !top.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });
})();

// ─────────────────────────────────────────────────────────────────────────────
// Steg-flikar: 1. Transkribering → 2. Maskera → 3. Avmaskera AI-svar
// ─────────────────────────────────────────────────────────────────────────────
let activeStep = "transcribe"; // "transcribe" | "mask" | "unmask"
let maskingCtrl = null;

function syncRecordingBarVisibility() {
  const bar = document.getElementById("recording-bar");
  if (!bar) return;
  bar.classList.toggle("hidden", activeStep !== "transcribe" && !isRecording);
}

function switchStep(step) {
  activeStep = step;
  const steps = ["transcribe", "mask", "unmask"];
  for (const s of steps) {
    const tab = document.getElementById(`tab-${s}`);
    const panel = document.getElementById(`panel-${s}`);
    const isCurrent = s === step;
    if (tab) tab.setAttribute("aria-selected", String(isCurrent));
    if (panel) panel.classList.toggle("hidden", !isCurrent);
  }
  syncRecordingBarVisibility();
  if (step === "mask" && maskingCtrl) maskingCtrl.onEnterMaskStep();
  if (step === "unmask" && maskingCtrl) maskingCtrl.onEnterUnmaskStep();
}

document.getElementById("tab-transcribe")?.addEventListener("click", () => switchStep("transcribe"));
document.getElementById("tab-mask")?.addEventListener("click", () => switchStep("mask"));
document.getElementById("tab-unmask")?.addEventListener("click", () => switchStep("unmask"));
document.getElementById("btn-goto-mask")?.addEventListener("click", () => switchStep("mask"));

// Central UI-state-växling för inspelningskontrollerna
let lastRecUIState = "idle";
function setRecordingUI(state) {
  if (state !== lastRecUIState) {
    announce(state === "recording" ? "Inspelning pågår" : "Inspelningen är stoppad");
    lastRecUIState = state;
  }
  const recLabel = btnRecord && btnRecord.querySelector(".btn-record-label");
  if (state === "idle") {
    if (recLabel) recLabel.textContent = "Spela in";
    if (btnRecord) btnRecord.classList.remove("is-recording");
    if (idleHint) idleHint.classList.remove("hidden");
    if (recordingIndicator) recordingIndicator.classList.add("hidden");
    if (btnRecord) btnRecord.setAttribute("aria-label", "Spela in");
  } else {
    if (recLabel) recLabel.textContent = "Stoppa";
    if (btnRecord) btnRecord.classList.add("is-recording");
    if (idleHint) idleHint.classList.add("hidden");
    if (recordingIndicator) recordingIndicator.classList.remove("hidden");
    if (recordingStatusText) recordingStatusText.textContent = "Spelar in";
    if (btnRecord) btnRecord.setAttribute("aria-label", "Stoppa inspelning");
  }
  syncRecordingBarVisibility();
}

const loadingOverlay = document.getElementById("loading-overlay");
const loadingText = document.getElementById("loading-text");
const progressContainer = document.getElementById("progress-container");
const progressBar = document.getElementById("progress-bar");

const recordingTimer = document.getElementById("recording-timer");
const recordingSize = document.getElementById("recording-size");
const footerMic = document.getElementById("footer-mic");
const footerDisk = document.getElementById("footer-disk");
const modelList = document.getElementById("model-list");
const btnRedo = document.getElementById("btn-redo");

const btnSettings = document.getElementById("btn-settings");
const settingsModal = document.getElementById("settings-modal");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");
const selMic = document.getElementById("mic-select");
const eqBar = document.getElementById("eq-bar");

function animateEq(average) {
  if (!eqBar) return;
  const col = eqBar.querySelector(".eq-col");
  if (!col) return;
  const norm = Math.min(average / 70, 1);
  col.style.width = `${Math.round(norm * 100)}%`;
  col.style.backgroundColor = norm > 0.85 ? "rgb(var(--c-rec))" : "";
}
function resetEq() {
  if (!eqBar) return;
  const col = eqBar.querySelector(".eq-col");
  if (col) { col.style.width = "0"; col.style.backgroundColor = ""; }
}

const confirmModal = document.getElementById("confirm-modal");
const confirmOk = document.getElementById("confirm-ok");
const confirmCancel = document.getElementById("confirm-cancel");

const btnCancelTranscription = document.getElementById("btn-cancel-transcription");
btnCancelTranscription?.addEventListener("click", async () => {
  isCancelling = true;
  await invoke("cancel_transcription");
});

// State
let isRecording = false;
let vocabStore = { version: 1, lists: [] };
let vocabSelected = null;
let pendingVocabChanges = [];

let transcriptSegments = [];
let segmentRowsCache = [];
let currentActiveSegIdx = -1;
let segmentViewActive = false;
let currentPlaybackUrl = null;
let audioPlayer = null;
let selectedMicId = "default";
let wasapiEnabled = false;
let identifySpeakers = false;
let speakerNotice = null;
let speakerNames = {};
let isCancelling = false;
let pendingRecording = null;
let wasapiRecordingReady = false;
let recordingDir = "";
let audioContext = null;
let analyzer = null;
let micStream = null;
let animationFrameId = null;

let recordingStartTime = null;
let recordingTimerInterval = null;
let estimatedRecordingSize = 0;
let lastTranscribedPath = null;
let currentSessionDir = null;
let persistSessionData = true;
let useGpu = true;
let threadCount = 4;

let saveTranscriptTimer = null;
async function ensureActiveSession(audioPath = null, label = null) {
  if (!persistSessionData) return null;
  if (currentSessionDir && !audioPath) return currentSessionDir;
  try {
    currentSessionDir = await invoke("ensure_work_session", {
      recordingDir: recordingDir || null,
      audioPath: audioPath || null,
      label: label || null,
    });
    return currentSessionDir;
  } catch (e) {
    logToFile(`ensureActiveSession misslyckades: ${e}`);
    return null;
  }
}

async function saveCurrentTranscriptNow() {
  clearTimeout(saveTranscriptTimer);
  saveTranscriptTimer = null;
  if (!persistSessionData || !currentSessionDir) return;
  const plainText = getCurrentTranscriptText();
  if (!plainText || !plainText.trim()) return;
  try {
    const payload = JSON.stringify({
      version: 1,
      audioPath: lastTranscribedPath || null,
      segments: transcriptSegments,
      speakerNames,
      rawText: outputText.value,
    });
    await invoke("save_session_transcript", {
      sessionDir: currentSessionDir,
      dataJson: payload,
      plainText,
    });
  } catch (e) {
    logToFile(`saveCurrentTranscriptNow: ${e}`);
  }
}

function saveCurrentTranscriptSoon() {
  if (!persistSessionData || !currentSessionDir) return;
  clearTimeout(saveTranscriptTimer);
  saveTranscriptTimer = setTimeout(saveCurrentTranscriptNow, 800);
}

function syncWasapiVisual() {
  const wasapiToggle = document.getElementById("wasapi-toggle");
  const wasapiQuickEl = document.getElementById("wasapi-quick");
  const on = !!(wasapiToggle && wasapiToggle.checked);
  const hint = document.getElementById("wasapi-hint");
  if (hint) {
    const togglePresent = wasapiQuickEl && !wasapiQuickEl.classList.contains("hidden");
    hint.classList.toggle("hidden", on || !togglePresent);
  }
}

function loadSettings() {
  const micId = localStorage.getItem("selectedMicId");
  const wasapi = localStorage.getItem("wasapiEnabled");
  identifySpeakers = localStorage.getItem("identifySpeakers") === "true";
  const savedPersist = localStorage.getItem("persistSessionData");
  persistSessionData = savedPersist === null ? true : savedPersist === "true";
  const savedGpu = localStorage.getItem("useGpu");
  useGpu = savedGpu === null ? true : savedGpu === "true";
  const savedThreads = parseInt(localStorage.getItem("threadCount") || "4", 10);
  if (Number.isFinite(savedThreads) && savedThreads >= 1 && savedThreads <= 16) {
    threadCount = savedThreads;
  }

  if (micId) selectedMicId = micId;
  if (wasapi !== null) wasapiEnabled = wasapi === "true";

  const wasapiToggle = document.getElementById("wasapi-toggle");
  if (wasapiToggle) wasapiToggle.checked = wasapiEnabled;
  const speakersToggle = document.getElementById("speakers-toggle");
  if (speakersToggle) speakersToggle.checked = identifySpeakers;
  const persistToggle = document.getElementById("persist-session-toggle");
  if (persistToggle) persistToggle.checked = persistSessionData;
  const gpuToggle = document.getElementById("gpu-toggle");
  if (gpuToggle) gpuToggle.checked = useGpu;
  const threadSlider = document.getElementById("thread-count-slider");
  const threadValue = document.getElementById("thread-count-value");
  if (threadSlider) threadSlider.value = String(threadCount);
  if (threadValue) threadValue.textContent = String(threadCount);

  syncWasapiVisual();

  renderVocab();
  updateFooter();
}

function updateFooter() {
  if (footerMic && selMic) {
    const micLabel = Array.from(selMic.options).find(opt => opt.value === selectedMicId)?.text || "Standardmikrofon";
    footerMic.innerText = micLabel;
  }
  updateDiskInfo();
}

async function updateDiskInfo() {
  try {
    const info = await invoke("get_disk_info");
    if (footerDisk) {
      const freeGb = (info.available_space / (1024 * 1024 * 1024)).toFixed(1);
      footerDisk.innerText = `Ledigt: ${freeGb} GB`;
    }
  } catch (_) {}
}

let firstMicDeviceId = null;
async function loadMicrophones() {
  if (!selMic || !navigator.userAgent.includes("Windows")) return;
  try {
    const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    permStream.getTracks().forEach(t => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputDevices = devices.filter(device => device.kind === "audioinput");

    selMic.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "default";
    defaultOption.text = "Systemets standardmikrofon";
    selMic.appendChild(defaultOption);

    audioInputDevices.forEach(device => {
      if (device.deviceId === "default" || device.deviceId === "communications") return;
      const lbl = (device.label || "").toLowerCase();
      if (lbl.includes("stereo mix") || lbl.includes("what u hear") || lbl.includes("wat u hoort")) return;
      if (!firstMicDeviceId && device.deviceId) firstMicDeviceId = device.deviceId;

      const option = document.createElement("option");
      option.value = device.deviceId;
      option.text = device.label || `Mikrofon ${selMic.length}`;
      selMic.appendChild(option);
    });
    selMic.value = selectedMicId;
  } catch (err) {
    console.warn("Kunde inte ladda mikrofoner:", err);
  }
}

async function setupEventListeners() {
  await listen("download_progress", (event) => {
    const { progress, downloaded, total } = event.payload;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `${progress}%`;
    const dlMb = (downloaded / 1048576).toFixed(1);
    const totMb = (total / 1048576).toFixed(1);
    loadingText.innerText = `Laddar ner modell… ${dlMb} MB / ${totMb} MB`;
  });

  await listen("vocabulary_applied", (event) => {
    pendingVocabChanges = Array.isArray(event.payload) ? event.payload : [];
  });

  await listen("diarization_phase", (event) => {
    const { phase, message: msg, percent, etaSeconds } = event.payload;
    if (phase === "start") {
      announce("Identifierar talare. Det kan ta några minuter. Avbryt är möjligt.");
      if (btnCancelTranscription) {
        btnCancelTranscription.textContent = "Avbryt talaridentifiering";
        btnCancelTranscription.classList.remove("hidden");
      }
      if (progressContainer) progressContainer.classList.remove("hidden");
      if (progressBar) progressBar.style.width = "0%";
      loadingText.innerText = "Identifierar talare…";
    } else if (phase === "progress") {
      if (progressBar) progressBar.style.width = `${percent}%`;
      const left = etaSeconds >= 90 ? `ca ${Math.round(etaSeconds / 60)} min kvar`
                 : etaSeconds > 5 ? `ca ${etaSeconds} s kvar`
                 : "snart klart";
      loadingText.innerText = `Identifierar talare… ${percent}% (${left})`;
    } else if (phase === "cancelled") {
      speakerNotice = "Talaridentifieringen avbröts. Transkriptet är sparat, men utan talare.";
    } else if (phase === "failed") {
      logToFile(`diarization: ${msg}`);
      speakerNotice = `Talarna kunde inte identifieras: ${msg || "okänt fel"}`;
    }
  });

  await listen("transcription_progress", (event) => {
    const { progress } = event.payload;
    if (progressContainer) progressContainer.classList.remove("hidden");
    if (progressBar) progressBar.style.width = `${progress}%`;
    loadingText.innerText = `Transkriberar (Pianissimo)… ${progress}%`;
  });

  await listen("engine_backend", (event) => {
    const backend = event.payload;
    const footerModel = document.getElementById("footer-model");
    if (footerModel && backend) {
      footerModel.textContent = `Pianissimo (${backend})`;
    }
  });

  // Dra och släpp ljud-/videofiler (→ Steg 1) eller textfiler (→ Steg 2)
  const dropOverlay = document.getElementById("drop-overlay");
  const AUDIO_EXTS = new Set(["mp3", "m4a", "aac", "wav", "ogg", "flac", "mp4", "webm", "mkv", "mov"]);
  const TEXT_EXTS = new Set(["txt", "md", "csv", "json"]);

  await listen("tauri://drag-enter", () => {
    if (!isRecording) dropOverlay?.classList.remove("hidden");
  });
  await listen("tauri://drag-leave", () => {
    dropOverlay?.classList.add("hidden");
  });
  await listen("tauri://drag-drop", async (event) => {
    dropOverlay?.classList.add("hidden");
    if (isRecording) return;
    const paths = event.payload?.paths;
    if (!Array.isArray(paths) || paths.length === 0) return;
    const filePath = paths[0];
    const ext = (filePath.split(".").pop() || "").toLowerCase();
    if (AUDIO_EXTS.has(ext)) {
      switchStep("transcribe");
      disableControls();
      await processAudioFile(filePath);
    } else if (TEXT_EXTS.has(ext)) {
      try {
        const picked = await invoke("read_text_file", { path: filePath });
        if (picked && picked.content) {
          const baseLabel = (picked.fileName || "text").replace(/\.[^.]+$/, "");
          await loadRawTextForMasking(
            picked.content,
            baseLabel,
            `Öppnade "${picked.fileName}" — klar för maskering.`
          );
        }
      } catch (e) {
        await message(`Kunde inte öppna textfilen: ${e}`, { title: "Fel", kind: "error" });
      }
    } else {
      showNotice(`Filtypen ".${ext}" stöds inte. Släpp en ljud-/videofil eller textfil (.txt, .md, .csv, .json).`);
    }
  });

  const btnBrowseDir = document.getElementById("btn-browse-recording-dir");
  btnBrowseDir?.addEventListener("click", async () => {
    try {
      const selected = await window.__TAURI__.dialog.open({
        directory: true,
        multiple: false,
        defaultPath: recordingDir || undefined,
        title: "Välj mapp för inspelningar",
      });
      if (typeof selected === "string" && selected) {
        recordingDir = selected;
        localStorage.setItem("recordingDir", selected);
        updateNetworkDirHint();
        const dirInput = document.getElementById("recording-dir-path");
        if (dirInput) dirInput.value = selected;
      }
    } catch (_) {}
  });

  invoke("get_log_path").then(p => {
    const el = document.getElementById("log-path");
    if (el) el.textContent = p;
  }).catch(() => {});

  const logAction = (id, command) => {
    document.getElementById(id)?.addEventListener("click", async () => {
      try { await invoke(command); }
      catch (e) {
        const msg = typeof e === "string" ? e : e.message || String(e);
        await message(`${msg} Använd Kopiera loggen i stället.`, { title: "Loggfilen", kind: "error" });
      }
    });
  };
  logAction("btn-show-log", "open_log_file");
  logAction("btn-reveal-log", "reveal_log_file");
  document.getElementById("btn-copy-log")?.addEventListener("click", async () => {
    try {
      const text = await invoke("read_log");
      await copyText(text);
      announce("Loggen är kopierad.");
      showNotice("Loggen är kopierad.");
    } catch (e) {
      const msg = typeof e === "string" ? e : e.message || String(e);
      await message(`Kunde inte kopiera loggen: ${msg}`, { title: "Loggfilen", kind: "error" });
    }
  });
}

function sessionStartFromFolderName(folderName) {
  const newFmt = folderName.match(/^inspelning-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-.*)?$/);
  const oldFmt = folderName.match(/^recording-(\d+)$/);
  if (newFmt) {
    const [, y, m, d, hh, mm, ss] = newFmt;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
  } else if (oldFmt) {
    return new Date(parseInt(oldFmt[1], 10) * 1000);
  }
  return new Date();
}

async function importSessionFolder(dir, needsRepair = false) {
  pendingRecording = null;
  hidePostRecordingActions();
  switchStep("transcribe");
  try {
    loadingText.innerText = needsRepair ? "Återställer avbruten inspelning…" : "Förbereder inspelning…";
    loadingOverlay.classList.remove("hidden");
    const recordedPath = await invoke("recover_session", { sessionDir: dir });
    loadingOverlay.classList.add("hidden");
    settingsModal?.classList.add("hidden");
    const folderName = dir.split(/[/\\]/).pop() || "";
    wasapiRecordingReady = true;
    pendingRecording = { type: "wav-file", filePath: recordedPath };
    const started = sessionStartFromFolderName(folderName);
    const when = started.toLocaleString("sv-SE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
    showPostRecordingActions(dir, { title: `Inspelning från ${when}` });
  } catch (err) {
    loadingOverlay.classList.add("hidden");
    const msg = typeof err === "string" ? err : err.message || String(err);
    await message(`Kunde inte läsa inspelningsmappen: ${msg}`, { title: "Fel", kind: "error" });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tema
// ─────────────────────────────────────────────────────────────────────────────
let themePref = "light";
function applyTheme() {
  const isDark = themePref === "dark";
  document.documentElement.classList.toggle("dark", isDark);
  const icon = document.getElementById("theme-icon");
  if (icon) icon.textContent = isDark ? "light_mode" : "dark_mode";
  const btn = document.getElementById("btn-theme");
  if (btn) {
    btn.title = isDark ? "Byt till ljust tema" : "Byt till mörkt tema";
    btn.setAttribute("aria-label", btn.title);
  }
}
function setTheme(pref) {
  themePref = pref === "dark" ? "dark" : "light";
  localStorage.setItem("theme", themePref);
  applyTheme();
}
function initTheme() {
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") themePref = saved;
  else {
    themePref = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    localStorage.setItem("theme", themePref);
  }
  applyTheme();
}
initTheme();

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
function getCurrentTranscriptText() {
  return segmentViewActive && transcriptSegments.length > 0
    ? buildPlainText()
    : outputText.value;
}

async function initialize() {
  try {
    const version = await invoke("get_app_version");
    const versionLabel = document.getElementById("app-version");
    if (versionLabel) versionLabel.textContent = `v${version}`;
  } catch (_) {}

  try {
    const saved = localStorage.getItem("recordingDir");
    if (saved && saved.trim()) recordingDir = saved.trim();
    else recordingDir = await invoke("get_default_recording_dir");
    const dirInput = document.getElementById("recording-dir-path");
    if (dirInput) dirInput.value = recordingDir;
    updateNetworkDirHint();
  } catch (_) {}

  initPlayer();
  await loadVocab();
  loadSettings();
  await loadMicrophones();
  await setupEventListeners();
  setupSearchAndModals();

  maskingCtrl = createMaskingController({
    getTranscriptText: getCurrentTranscriptText,
    copyText,
    announce,
    showMessage: message,
    switchStep,
    refreshModels: refreshModelList,
    getPersistEnabled: () => persistSessionData,
    getSessionDir: () => currentSessionDir,
    ensureSessionDir: async (label) => {
      const dir = await ensureActiveSession(null, label);
      await saveCurrentTranscriptNow();
      return dir;
    },
    onOpenTextFile: () => openTextFileForMasking(),
    onPasteTextForMasking: (text) => loadRawTextForMasking(text, "inklistrad-text"),
  });

  updateFooter();
  refreshModelList();
  checkInterruptedRecordings();
  checkCrashMarker();

  if (navigator.userAgent.includes("Windows")) {
    const wasapiQuick = document.getElementById("wasapi-quick");
    if (wasapiQuick) { wasapiQuick.classList.remove("hidden"); wasapiQuick.classList.add("flex"); }
    const wasapiHint = document.getElementById("wasapi-hint");
    if (wasapiHint) wasapiHint.classList.toggle("hidden", wasapiEnabled);
    const stereoHelp = document.getElementById("btn-stereo-mix-help");
    if (stereoHelp) { stereoHelp.classList.remove("hidden"); stereoHelp.classList.add("flex"); }
  } else {
    btnRecord?.classList.add("hidden");
    document.getElementById("mic-select-wrap")?.classList.add("hidden");
    const macOpenBtn = document.getElementById("btn-mac-open-audio");
    macOpenBtn?.classList.remove("hidden");
    macOpenBtn?.addEventListener("click", async () => {
      try {
        const selected = await invoke("pick_audio_file");
        if (selected) {
          switchStep("transcribe");
          disableControls();
          await processAudioFile(selected);
        }
      } catch (e) {
        console.error("Kunde inte öppna ljudfil:", e);
      }
    });
  }

  document.getElementById("btn-new-session")?.addEventListener("click", async () => {
    if (isRecording) return;
    const hasContent =
      Boolean(outputText.value && outputText.value.trim()) ||
      transcriptSegments.length > 0 ||
      Boolean(document.getElementById("unmask-input")?.value?.trim());
    if (hasContent) {
      const ok = await showConfirm(
        "Rensa arbetsytan och börja på en ny transkribering eller maskering? Sparade inspelningar på disk påverkas inte.",
        "Ny arbetsyta",
        "Rensa"
      );
      if (!ok) return;
    }
    hidePostRecordingActions();
    hideNotice();
    pendingRecording = null;
    teardownPlayer();
    outputText.value = "";
    transcriptSegments = [];
    segmentRowsCache = [];
    speakerNames = {};
    lastTranscribedPath = null;
    wasapiRecordingReady = false;
    currentSessionDir = null;
    const editor = document.getElementById("segment-editor");
    if (editor) editor.replaceChildren();
    document.getElementById("btn-segment-toggle")?.classList.add("hidden");
    btnRedo.classList.add("hidden");
    btnSaveAudio?.classList.add("hidden");
    showRawView();
    maskingCtrl?.resetMaskState();
    switchStep("transcribe");
    outputText.focus();
    announce("Arbetsytan har rensats.");
  });

  await ensurePianissimoReady();
}

function setupSearchAndModals() {
  const searchBar = document.getElementById("search-bar");
  const searchInput = document.getElementById("search-input");
  const replaceInput = document.getElementById("replace-input");
  const btnSearch = document.getElementById("btn-search");
  const btnReplaceOne = document.getElementById("btn-replace-one");
  const btnReplaceAll = document.getElementById("btn-replace-all");
  const btnCloseSearch = document.getElementById("btn-close-search");

  function openSearch() {
    if (!searchBar) return;
    searchBar.classList.remove("hidden");
    searchBar.style.display = "flex";
    if (searchInput) { searchInput.focus(); searchInput.select(); }
  }
  function closeSearch() {
    if (!searchBar) return;
    searchBar.classList.add("hidden");
    if (searchInput) searchInput.value = "";
    if (replaceInput) replaceInput.value = "";
  }
  btnSearch?.addEventListener("click", openSearch);
  btnCloseSearch?.addEventListener("click", closeSearch);

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "f" && activeStep === "transcribe") {
      if ((!outputText || !outputText.value) && transcriptSegments.length === 0) return;
      e.preventDefault();
      openSearch();
    }
    if (e.key === "Escape" && searchBar && !searchBar.classList.contains("hidden")) {
      closeSearch();
    }
  });

  btnReplaceOne?.addEventListener("click", () => {
    const needle = searchInput ? searchInput.value : "";
    const repl = replaceInput ? replaceInput.value : "";
    if (!needle || !outputText) return;
    if (segmentViewActive && transcriptSegments.length > 0) {
      const seg = transcriptSegments.find((s) => s.text.includes(needle));
      if (!seg) {
        if (searchInput) { searchInput.style.color = "red"; setTimeout(() => searchInput.style.color = "", 800); }
        return;
      }
      const idx = seg.text.indexOf(needle);
      seg.text = seg.text.slice(0, idx) + repl + seg.text.slice(idx + needle.length);
      seg.tokens = [];
      outputText.value = buildPlainText();
      renderSegmentEditor();
      saveCurrentTranscriptSoon();
      return;
    }
    const text = outputText.value;
    const idx = text.indexOf(needle);
    if (idx === -1) {
      if (searchInput) { searchInput.style.color = "red"; setTimeout(() => searchInput.style.color = "", 800); }
      return;
    }
    outputText.value = text.slice(0, idx) + repl + text.slice(idx + needle.length);
    saveCurrentTranscriptSoon();
  });

  btnReplaceAll?.addEventListener("click", () => {
    const needle = searchInput ? searchInput.value : "";
    const repl = replaceInput ? replaceInput.value : "";
    if (!needle || !outputText) return;
    let count = 0;
    if (segmentViewActive && transcriptSegments.length > 0) {
      for (const seg of transcriptSegments) {
        const parts = seg.text.split(needle);
        if (parts.length > 1) {
          count += parts.length - 1;
          seg.text = parts.join(repl);
          seg.tokens = [];
        }
      }
      if (count > 0) {
        outputText.value = buildPlainText();
        renderSegmentEditor();
        saveCurrentTranscriptSoon();
      }
    } else if (outputText.value) {
      count = outputText.value.split(needle).length - 1;
      if (count > 0) {
        outputText.value = outputText.value.split(needle).join(repl);
        saveCurrentTranscriptSoon();
      }
    }
    if (searchInput) {
      searchInput.placeholder = `Ersatte ${count} förekomst${count === 1 ? "" : "er"}`;
      setTimeout(() => { searchInput.placeholder = "Sök"; }, 2000);
    }
  });

  const stereoMixModal = document.getElementById("stereo-mix-modal");
  const openStereoMix = () => {
    settingsModal?.classList.add("hidden");
    if (stereoMixModal) { stereoMixModal.classList.remove("hidden"); stereoMixModal.style.display = "flex"; }
  };
  const closeStereoMix = () => stereoMixModal?.classList.add("hidden");
  document.getElementById("btn-stereo-mix-help")?.addEventListener("click", openStereoMix);
  document.getElementById("btn-close-stereo-mix")?.addEventListener("click", closeStereoMix);
  document.getElementById("btn-close-stereo-mix-ok")?.addEventListener("click", closeStereoMix);
  stereoMixModal?.addEventListener("click", (e) => { if (e.target === stereoMixModal) closeStereoMix(); });
  document.getElementById("btn-open-win-sound")?.addEventListener("click", () => {
    window.__TAURI__.opener.openUrl("ms-settings:sound").catch(() => {});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Modeller (endast Pianissimo, Svensk BERT NER, Talaridentifiering)
// ─────────────────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function iconButton(icon, label, onClick, extra = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn btn-ghost btn-sm btn-icon-only ${extra}`.trim();
  b.setAttribute("aria-label", label);
  b.title = label;
  b.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

async function refreshModelList() {
  if (!modelList) return;
  let models;
  try { models = await invoke("get_installed_models"); }
  catch (err) { console.error("Kunde inte ladda modeller:", err); return; }

  modelList.innerHTML = "";
  const approxSizes = { pianissimo: "ca 740 MB", ner: "ca 127 MB", diarization: "ca 33 MB" };

  for (const m of models) {
    const li = document.createElement("li");
    li.className = `model-row${m.downloaded ? " is-active" : ""}`;

    const info = document.createElement("div");
    info.className = "min-w-0 flex-1";
    const t = document.createElement("span");
    t.className = "choice-title";
    t.textContent = m.name;
    const s = document.createElement("span");
    s.className = `model-status${m.downloaded ? " is-active" : ""}`;
    s.textContent = m.downloaded
      ? `Nedladdad · ${formatSize(m.size_bytes)}`
      : `Inte nedladdad · ${approxSizes[m.size] || ""}`;
    info.append(t, s);

    const actions = document.createElement("div");
    actions.className = "model-actions";
    if (m.downloaded) {
      actions.appendChild(iconButton("delete", `Ta bort ${m.name}`, async () => {
        const ok = await showConfirm(`${m.name} (${formatSize(m.size_bytes)}) tas bort från datorn.`, "Ta bort modell", "Ta bort");
        if (!ok) return;
        try {
          await invoke("delete_model", { size: m.size });
          refreshModelList();
          updateDiskInfo();
        } catch (e) {
          await message(`Kunde inte ta bort modellen: ${e}`, { title: "Fel", kind: "error" });
        }
      }, "btn-danger"));
    } else {
      actions.appendChild(iconButton("download", `Ladda ned ${m.name}`, async () => {
        settingsModal?.classList.add("hidden");
        if (m.size === "pianissimo") await downloadPianissimo();
        else if (m.size === "ner") { switchStep("mask"); await invoke("ensure_ner_model"); refreshModelList(); }
        else if (m.size === "diarization") {
          loadingOverlay.classList.remove("hidden");
          loadingText.innerText = "Hämtar talarmodeller…";
          try { await invoke("download_diarization_models"); }
          finally { loadingOverlay.classList.add("hidden"); }
          refreshModelList();
        }
      }));
    }

    li.append(info, actions);
    modelList.appendChild(li);
  }
}

async function downloadPianissimo() {
  disableControls();
  try {
    updateBadge("Laddar ner Pianissimo…", "");
    loadingText.innerText = "Laddar ner svensk talmodell (Pianissimo)…";
    loadingOverlay.classList.remove("hidden");
    progressContainer?.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";
    await invoke("download_pianissimo_model");
    loadingOverlay.classList.add("hidden");
    progressContainer?.classList.add("hidden");
    updateBadge("Redo (Pianissimo · svenska)", "ready");
    refreshModelList();
    updateDiskInfo();
    enableControls();
  } catch (error) {
    updateBadge("Modellfel", "error");
    loadingOverlay.classList.add("hidden");
    progressContainer?.classList.add("hidden");
    enableControls();
    await message(`Nedladdning av Pianissimo misslyckades: ${error}`, { title: "Fel", kind: "error" });
  }
}

async function ensurePianissimoReady() {
  disableControls();
  try {
    updateBadge("Kontrollerar Pianissimo…", "");
    const ready = await invoke("check_pianissimo_ready");
    if (!ready) {
      await downloadPianissimo();
      return;
    }
    updateBadge("Redo (Pianissimo · svenska)", "ready");
    enableControls();
    refreshModelList();
  } catch (error) {
    updateBadge("Modellfel", "error");
    loadingOverlay.classList.add("hidden");
    enableControls();
    await message(`Kunde inte initiera Pianissimo: ${error}`, { title: "Fel", kind: "error" });
  }
}

function updateBadge(text, className) {
  if (!badge) return;
  badge.textContent = text;
  badge.className = className === "error" ? "text-rec" : "";
}
function enableControls() {
  btnRecord.disabled = false;
  btnFile.disabled = false;
  btnSettings.disabled = false;
  const macOpenBtn = document.getElementById("btn-mac-open-audio");
  if (macOpenBtn) macOpenBtn.disabled = false;
}
function disableControls() {
  btnRecord.disabled = true;
  btnFile.disabled = true;
  btnSettings.disabled = true;
  const macOpenBtn = document.getElementById("btn-mac-open-audio");
  if (macOpenBtn) macOpenBtn.disabled = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
btnSettings.addEventListener("click", () => {
  loadSettings();
  maskingCtrl?.syncIgnoreListUI?.();
  settingsModal.classList.remove("hidden");
  refreshRecordingsUsage();
  refreshModelList();
});

async function refreshRecordingsUsage() {
  const el = document.getElementById("recordings-usage");
  if (!el) return;
  el.textContent = "";
  try {
    const sum = await invoke("count_recordings", { dir: recordingDir });
    if (sum.count > 0) {
      const mb = (sum.total_bytes / 1048576).toFixed(0);
      el.textContent = `${sum.count} inspelning${sum.count === 1 ? "" : "ar"} · ${mb} MB`;
    } else {
      el.textContent = "Inga sparade inspelningar.";
    }
  } catch (_) {}
}

document.getElementById("btn-delete-recordings")?.addEventListener("click", async () => {
  try {
    const sum = await invoke("count_recordings", { dir: recordingDir });
    if (!sum.count) {
      await message("Det finns inga inspelningar att radera.", { title: "Inget att radera" });
      return;
    }
    const mb = (sum.total_bytes / 1048576).toFixed(0);
    const ok = await showConfirm(`Radera ${sum.count} inspelning${sum.count === 1 ? "" : "ar"} (${mb} MB)? Detta kan inte ångras.`, "Radera inspelningar");
    if (!ok) return;
    teardownPlayer();
    const n = await invoke("delete_all_recordings", { dir: recordingDir });
    await message(`${n} inspelning${n === 1 ? "" : "ar"} raderades.`, { title: "Klart" });
    refreshRecordingsUsage();
  } catch (e) {
    const msg = typeof e === "string" ? e : e.message || String(e);
    await message(`Kunde inte radera: ${msg}`, { title: "Fel", kind: "error" });
  }
});

btnCloseSettings.addEventListener("click", () => settingsModal.classList.add("hidden"));

document.getElementById("thread-count-slider")?.addEventListener("input", (e) => {
  const val = parseInt(e.target.value, 10);
  if (Number.isFinite(val)) {
    threadCount = Math.max(1, Math.min(16, val));
    const lbl = document.getElementById("thread-count-value");
    if (lbl) lbl.textContent = String(threadCount);
  }
});

btnSaveSettings.addEventListener("click", async () => {
  const newMicId = selMic ? selMic.value : "default";
  const wasapiToggle = document.getElementById("wasapi-toggle");
  const newWasapi = wasapiToggle ? wasapiToggle.checked : false;
  const persistToggle = document.getElementById("persist-session-toggle");
  const newPersist = persistToggle ? persistToggle.checked : true;
  const gpuToggle = document.getElementById("gpu-toggle");
  const newGpu = gpuToggle ? gpuToggle.checked : true;

  localStorage.setItem("selectedMicId", newMicId);
  localStorage.setItem("wasapiEnabled", newWasapi.toString());
  localStorage.setItem("persistSessionData", newPersist.toString());
  localStorage.setItem("useGpu", newGpu.toString());
  localStorage.setItem("threadCount", String(threadCount));
  persistSessionData = newPersist;
  useGpu = newGpu;
  await saveVocabNow();

  selectedMicId = newMicId;
  wasapiEnabled = newWasapi;
  settingsModal.classList.add("hidden");
  updateFooter();
});

btnRedo.addEventListener("click", async () => {
  if (!lastTranscribedPath) return;
  const confirmed = await showConfirm("Vill du göra om transkriberingen?", "Gör om transkribering");
  if (!confirmed) return;
  btnRedo.classList.add("hidden");
  await processAudioFile(lastTranscribedPath);
  btnRedo.classList.remove("hidden");
  btnRedo.style.display = "inline-flex";
});

// ─────────────────────────────────────────────────────────────────────────────
// Inspelning
// ─────────────────────────────────────────────────────────────────────────────
function startRecordingMetrics() {
  recordingStartTime = Date.now();
  estimatedRecordingSize = 0;
  if (recordingTimer) recordingTimer.innerText = "00:00:00";
  if (recordingSize) recordingSize.innerText = "0.0 MB";
  recordingTimerInterval = setInterval(() => {
    const elapsedMs = Date.now() - recordingStartTime;
    const sec = Math.floor(elapsedMs / 1000);
    const hrs = Math.floor(sec / 3600).toString().padStart(2, "0");
    const mins = Math.floor((sec % 3600) / 60).toString().padStart(2, "0");
    const s = (sec % 60).toString().padStart(2, "0");
    if (recordingTimer) recordingTimer.innerText = `${hrs}:${mins}:${s}`;
    estimatedRecordingSize = (elapsedMs / 1000) * (16000 * 2);
    if (recordingSize) recordingSize.innerText = (estimatedRecordingSize / (1024 * 1024)).toFixed(1) + " MB";
  }, 1000);
}
function stopRecordingMetrics() {
  if (recordingTimerInterval) { clearInterval(recordingTimerInterval); recordingTimerInterval = null; }
}

const LOW_DISK_WARN_BYTES = 500 * 1024 * 1024;
async function checkDiskBeforeRecording() {
  try {
    const info = await invoke("get_disk_info");
    if (info && typeof info.available_space === "number" && info.available_space < LOW_DISK_WARN_BYTES) {
      const mb = (info.available_space / 1048576).toFixed(0);
      return await showConfirm(`Lågt diskutrymme: endast ${mb} MB ledigt. Vill du fortsätta ändå?`, "Lågt diskutrymme");
    }
  } catch (_) {}
  return true;
}

btnRecord.addEventListener("click", async () => {
  if (!isRecording) {
    if ((outputText.value && outputText.value.trim()) || transcriptSegments.length > 0) {
      const confirmed = await showConfirm();
      if (!confirmed) return;
    }
    if (!(await checkDiskBeforeRecording())) return;
    await startRecording();
  } else {
    await stopSession();
  }
});

const CONFIRM_DEFAULT_MSG = "Du har en transkribering som inte sparats. En ny inspelning kommer att ersätta den.";
const CONFIRM_DEFAULT_TITLE = "Ny inspelning";
function showConfirm(msg, title, okLabel) {
  return new Promise(resolve => {
    if (!confirmModal) { resolve(true); return; }
    if (confirmOk) confirmOk.textContent = okLabel || "Fortsätt";
    const p = confirmModal.querySelector("p");
    if (p) p.innerText = msg || CONFIRM_DEFAULT_MSG;
    const h = document.getElementById("confirm-title");
    if (h) h.innerText = title || CONFIRM_DEFAULT_TITLE;
    confirmModal.classList.remove("hidden");
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      confirmModal.classList.add("hidden");
      confirmOk.removeEventListener("click", onOk);
      confirmCancel.removeEventListener("click", onCancel);
    };
    confirmOk.addEventListener("click", onOk);
    confirmCancel.addEventListener("click", onCancel);
  });
}

async function startRecording() {
  const isWindows = navigator.userAgent.includes("Windows");
  if (!isWindows) {
    await message("Direktinspelning stöds just nu i Windows-versionen. På macOS kan du öppna en ljud- eller videofil (t.ex. från Röstmemon), eller klistra in text direkt.",
      { title: "Inspelning ej tillgänglig på macOS", kind: "info" });
    return;
  }
  switchStep("transcribe");
  if (pendingRecording) { pendingRecording = null; hidePostRecordingActions(); }
  teardownPlayer();
  outputText.value = "";
  transcriptSegments = [];
  segmentRowsCache = [];
  const prevEditor = document.getElementById("segment-editor");
  if (prevEditor) prevEditor.innerHTML = "";
  showRawView();
  maskingCtrl?.resetMaskState();
  btnRedo.classList.add("hidden");
  if (btnSaveAudio) btnSaveAudio.classList.add("hidden");
  document.getElementById("btn-segment-toggle")?.classList.add("hidden");
  wasapiRecordingReady = false;
  lastTranscribedPath = null;
  currentSessionDir = null;

  try {
    let resolvedMicId = selectedMicId;
    if (selectedMicId === "default" && firstMicDeviceId) resolvedMicId = firstMicDeviceId;
    const audioConstraints = resolvedMicId === "default"
      ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
      : { audio: { deviceId: { exact: resolvedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

    micStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyzer = audioContext.createAnalyser();
    const wasapiSource = audioContext.createMediaStreamSource(micStream);
    wasapiSource.connect(analyzer);
    analyzer.fftSize = 256;
    const wasapiBufLen = analyzer.frequencyBinCount;
    const wasapiDataArr = new Uint8Array(wasapiBufLen);

    function drawVisualizer() {
      if (!isRecording) return;
      animationFrameId = requestAnimationFrame(drawVisualizer);
      analyzer.getByteFrequencyData(wasapiDataArr);
      let sum = 0;
      for (let i = 0; i < wasapiBufLen; i++) sum += wasapiDataArr[i];
      animateEq(sum / wasapiBufLen);
    }

    const workletSrc = `
      class MicCapture extends AudioWorkletProcessor {
        constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) {
            for (let i = 0; i < ch.length; i++) {
              this.buf[this.n++] = ch[i];
              if (this.n === this.buf.length) {
                this.port.postMessage(this.buf.buffer, [this.buf.buffer]);
                this.buf = new Float32Array(4096);
                this.n = 0;
              }
            }
          }
          return true;
        }
      }
      registerProcessor("mic-capture", MicCapture);`;
    const workletUrl = URL.createObjectURL(new Blob([workletSrc], { type: "text/javascript" }));
    const wasapiSampleRate = audioContext.sampleRate;
    await audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);
    const wasapiProcessor = new AudioWorkletNode(audioContext, "mic-capture", {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1,
    });
    wasapiProcessor.port.onmessage = (e) => {
      if (!isRecording) return;
      invoke("append_mic_chunk", new Uint8Array(e.data), { headers: { "x-sample-rate": String(wasapiSampleRate) } })
        .catch(() => {});
    };
    wasapiSource.connect(wasapiProcessor);
    wasapiProcessor.connect(audioContext.destination);
    window.__wasapiProcessor = wasapiProcessor;
    window.__wasapiSource = wasapiSource;

    const result = await invoke("start_backend_recording", {
      loopbackOnly: true,
      withLoopback: wasapiEnabled,
      recordingDir: recordingDir || null,
    });

    isRecording = true;
    drawVisualizer();
    startRecordingMetrics();

    const recordingStatusMsg = wasapiEnabled
      ? (result.loopback_active ? "Spelar in (mikrofon + systemljud)" : "Spelar in (mikrofon — systemljud ej tillgängligt)")
      : "Spelar in (mikrofon)";
    const loopbackIndicator = document.getElementById("loopback-indicator");
    if (loopbackIndicator) loopbackIndicator.classList.toggle("hidden", !result.loopback_active);

    btnRecord.classList.add("recording");
    setRecordingUI("recording");
    if (recordingStatusText) recordingStatusText.textContent = recordingStatusMsg;
    disableControls();
    btnRecord.disabled = false;
  } catch (err) {
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioContext && audioContext.state !== "closed") audioContext.close();
    isRecording = false;
    enableControls();
    await message(`Inspelningen kunde inte starta: ${err.message || err}`, { title: "Fel", kind: "error" });
  }
}

function sessionDirFromRecordingPath(p) {
  return p ? p.replace(/[/\\][^/\\]+$/, "") : "";
}

function showPostRecordingActions(sessionDir, opts = {}) {
  const opened = !!opts.title;
  document.getElementById("post-recording-actions")?.classList.remove("hidden");
  const titleEl = document.getElementById("post-recording-title");
  if (titleEl) titleEl.textContent = opened ? opts.title : "Inspelningen är sparad";
  document.getElementById("btn-save-for-later")?.classList.toggle("hidden", opened);
  document.getElementById("btn-save-audio-only")?.classList.toggle("hidden", opened);
  document.getElementById("btn-close-opened")?.classList.toggle("hidden", !opened);
  const nameRow = document.getElementById("session-name-row");
  const nameInput = document.getElementById("session-name-input");
  if (nameInput) nameInput.value = "";
  if (nameRow) nameRow.classList.toggle("hidden", !sessionDir || opened);
  const btn = document.getElementById("post-recording-path");
  const txt = document.getElementById("post-recording-path-text");
  if (btn && txt) {
    if (sessionDir) {
      txt.textContent = sessionDir;
      btn.dataset.path = sessionDir;
      btn.classList.remove("hidden");
    } else {
      delete btn.dataset.path;
      btn.classList.add("hidden");
    }
  }
}
function hidePostRecordingActions() {
  document.getElementById("post-recording-actions")?.classList.add("hidden");
}

async function saveRecordedAudio() {
  try {
    if (!wasapiRecordingReady) {
      await message("Ingen inspelning att spara.", { title: "Fel", kind: "error" });
      return;
    }
    await invoke("save_audio_file");
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (!msg.includes("cancelled") && !msg.includes("canceled")) {
      await message(`Kunde inte spara ljudfilen: ${msg}`, { title: "Fel", kind: "error" });
    }
  }
}

async function startPendingTranscription() {
  if (!pendingRecording) return;
  hidePostRecordingActions();
  const rec = pendingRecording;
  pendingRecording = null;
  btnRedo.classList.remove("hidden"); btnRedo.style.display = "inline-flex";
  if (btnSaveAudio) { btnSaveAudio.classList.remove("hidden"); btnSaveAudio.style.display = "inline-flex"; }

  if (rec.type === "wav-file") {
    let path = rec.filePath;
    if (!path) {
      try { path = await invoke("get_recording_path"); }
      catch (e) { await message(`Ingen inspelning att transkribera: ${e}`, { title: "Fel", kind: "error" }); return; }
    }
    await processAudioFile(path);
  }
}

async function stopSession() {
  isRecording = false;
  stopRecordingMetrics();
  btnRecord.classList.remove("recording");
  setRecordingUI("idle");
  document.getElementById("loopback-indicator")?.classList.add("hidden");
  disableControls();

  if (window.__wasapiProcessor) { try { window.__wasapiProcessor.disconnect(); } catch (_) {} window.__wasapiProcessor = null; }
  if (window.__wasapiSource) { try { window.__wasapiSource.disconnect(); } catch (_) {} window.__wasapiSource = null; }
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioContext && audioContext.state !== "closed") { audioContext.close(); audioContext = null; }

  loadingText.innerText = "Avslutar inspelning…";
  loadingOverlay.classList.remove("hidden");
  try {
    await invoke("stop_backend_recording");
    wasapiRecordingReady = true;
    pendingRecording = { type: "wav-file", filePath: null };
    loadingOverlay.classList.add("hidden");
    let sessionDir = "";
    try { sessionDir = sessionDirFromRecordingPath(await invoke("get_recording_path")); } catch (_) {}
    showPostRecordingActions(sessionDir);
  } catch (err) {
    wasapiRecordingReady = false;
    const detalj = typeof err === "string" ? err : err.message || String(err);
    await message(`Inspelningen kunde inte förberedas: ${detalj}`, { title: "Inspelningen är sparad", kind: "warning" });
  } finally {
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Öppna fil / senaste inspelningar
// ─────────────────────────────────────────────────────────────────────────────
function formatRecordingTitle(rec) {
  const d = new Date(rec.started);
  const when = isNaN(d) ? rec.started
    : d.toLocaleString("sv-SE", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const label = rec.label ? rec.label.replace(/-/g, " ") : "";
  return label ? `${label} · ${when}` : when;
}

async function showImportChoice() {
  let recs = [];
  try { recs = await invoke("list_recordings", { recordingDir: recordingDir || null }); } catch (_) {}

  return new Promise(resolve => {
    const modal = document.getElementById("import-choice-modal");
    const fileBtn = document.getElementById("import-choice-file");
    const textBtn = document.getElementById("import-choice-text");
    const cancelBtn = document.getElementById("import-choice-cancel");
    const list = document.getElementById("recent-list");
    if (!modal || !fileBtn || !cancelBtn || !list) { resolve({ kind: "file" }); return; }

    list.replaceChildren();
    if (recs.length === 0) {
      const empty = document.createElement("li");
      empty.className = "hint";
      empty.textContent = "Inga tidigare inspelningar eller sessioner ännu.";
      list.appendChild(empty);
    }
    for (const rec of recs) {
      const li = document.createElement("li");
      li.className = "recent-row";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice";
      const t = document.createElement("span");
      t.className = "choice-title";
      t.textContent = formatRecordingTitle(rec);
      const d = document.createElement("span");
      d.className = "choice-desc";
      const tags = [formatSize(rec.sizeBytes)];
      if (rec.hasTranscript) tags.push("Transkriberad");
      if (rec.hasMasking) tags.push("Maskerad (nyckel sparad)");
      d.textContent = tags.join(" · ");
      if (rec.recoverable) {
        const w = document.createElement("span");
        w.className = "text-warn font-semibold";
        w.textContent = " · Avbruten – återställs när du öppnar den";
        d.appendChild(w);
      }
      b.append(t, d);
      b.addEventListener("click", () => { cleanup(); resolve({ kind: "session", rec }); });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "btn btn-ghost btn-sm btn-icon-only recent-del";
      del.setAttribute("aria-label", `Radera inspelningen ${formatRecordingTitle(rec)}`);
      del.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">delete</span>';
      del.addEventListener("click", async () => {
        const ok = await showConfirm(`Radera "${formatRecordingTitle(rec)}"?`, "Radera inspelning", "Radera");
        if (!ok) return;
        try {
          await invoke("delete_recording", { recordingDir: recordingDir || null, path: rec.path });
          li.remove();
        } catch (e) {
          await message(`Kunde inte radera: ${e}`, { title: "Fel", kind: "error" });
        }
      });
      li.append(b, del);
      list.appendChild(li);
    }

    modal.classList.remove("hidden");
    const cleanup = () => {
      modal.classList.add("hidden");
      fileBtn.removeEventListener("click", onFile);
      textBtn?.removeEventListener("click", onText);
      cancelBtn.removeEventListener("click", onCancel);
    };
    const onFile = () => { cleanup(); resolve({ kind: "file" }); };
    const onText = () => { cleanup(); resolve({ kind: "text" }); };
    const onCancel = () => { cleanup(); resolve(null); };
    fileBtn.addEventListener("click", onFile);
    textBtn?.addEventListener("click", onText);
    cancelBtn.addEventListener("click", onCancel);
  });
}

async function loadRawTextForMasking(rawText, label = "text", noticeMsg = null) {
  const cleaned = (rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!cleaned.trim()) return;
  hidePostRecordingActions();
  pendingRecording = null;
  teardownPlayer();
  transcriptSegments = [];
  segmentRowsCache = [];
  speakerNames = {};
  lastTranscribedPath = null;
  wasapiRecordingReady = false;
  currentSessionDir = null;
  const editor = document.getElementById("segment-editor");
  if (editor) editor.replaceChildren();
  document.getElementById("btn-segment-toggle")?.classList.add("hidden");
  btnRedo.classList.add("hidden");
  btnSaveAudio?.classList.add("hidden");
  showRawView();
  outputText.value = cleaned;
  maskingCtrl?.resetMaskState();

  await ensureActiveSession(null, label);
  await saveCurrentTranscriptNow();
  if (noticeMsg) showNotice(noticeMsg);
  switchStep("mask");
}

async function openTextFileForMasking() {
  try {
    const picked = await invoke("pick_text_file");
    if (!picked || !picked.content) return;
    const baseLabel = (picked.fileName || "text").replace(/\.[^.]+$/, "");
    await loadRawTextForMasking(
      picked.content,
      baseLabel,
      `Öppnade "${picked.fileName}" — klar för maskering.`
    );
  } catch (e) {
    await message(`Kunde inte öppna textfilen: ${e}`, { title: "Fel", kind: "error" });
  }
}

async function openSavedSession(rec) {
  try {
    const ws = await invoke("load_session_workspace", { sessionDir: rec.path });
    currentSessionDir = ws.sessionDir;
    hidePostRecordingActions();
    pendingRecording = null;
    teardownPlayer();
    outputText.value = "";
    transcriptSegments = [];
    speakerNames = {};
    showRawView();

    if (ws.transcriptJson) {
      const data = JSON.parse(ws.transcriptJson);
      speakerNames = data.speakerNames || {};
      transcriptSegments = Array.isArray(data.segments) ? data.segments : [];
      outputText.value = data.rawText || buildPlainText();
      if (transcriptSegments.length > 0) {
        renderSegmentEditor();
        showSegmentView();
        const btnSeg = document.getElementById("btn-segment-toggle");
        if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
      }
    }

    if (ws.audioPath) {
      lastTranscribedPath = ws.audioPath;
      wasapiRecordingReady = ws.audioPath.endsWith("recording.wav");
      btnRedo.classList.remove("hidden"); btnRedo.style.display = "inline-flex";
      if (btnSaveAudio && wasapiRecordingReady) {
        btnSaveAudio.classList.remove("hidden"); btnSaveAudio.style.display = "inline-flex";
      }
      await setupPlayerFromPath(ws.audioPath);
    }

    const hadMasking = maskingCtrl?.loadMaskingState(ws.maskingJson);
    switchStep("transcribe");
    if (hadMasking) {
      showNotice("Laddade sparad transkribering och maskeringsnyckel — redo för avmaskering i steg 3.", {
        label: "Öppna Avmaskera AI-svar",
        onClick: () => { hideNotice(); switchStep("unmask"); },
      });
    } else {
      showNotice("Laddade sparad transkribering från sessionsmappen.");
    }
  } catch (e) {
    await message(`Kunde inte öppna sparad session: ${e}`, { title: "Fel", kind: "error" });
  }
}

btnFile.addEventListener("click", async () => {
  const choice = await showImportChoice();
  if (!choice) return;
  try {
    if (choice.kind === "file") {
      const selected = await invoke("pick_audio_file");
      if (selected) {
        switchStep("transcribe");
        disableControls();
        await processAudioFile(selected);
      }
      return;
    }
    if (choice.kind === "text") {
      await openTextFileForMasking();
      return;
    }
    if (!choice.rec.recoverable && (choice.rec.hasTranscript || choice.rec.hasMasking)) {
      await openSavedSession(choice.rec);
      return;
    }
    await importSessionFolder(choice.rec.path, choice.rec.recoverable);
  } catch (e) {
    console.error("Import misslyckades:", e);
  }
});

async function checkInterruptedRecordings() {
  try {
    const recs = await invoke("list_recordings", { recordingDir: recordingDir || null });
    const rec = recs.find(r => r.recoverable);
    if (!rec || isRecording) return;
    showNotice(`Hittade en avbruten inspelning från ${formatRecordingTitle(rec)}.`, {
      label: "Återställ",
      onClick: async () => {
        hideNotice();
        disableControls();
        await importSessionFolder(rec.path, true);
      },
    });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Segmentvy & Ljudspelare
// ─────────────────────────────────────────────────────────────────────────────
function formatMs(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function speakerLabel(id) { return speakerNames[id] || `Talare ${id}`; }

function buildPlainText() {
  if (!transcriptSegments.some(s => s.speakerId)) {
    return transcriptSegments.map(s => s.text).join("\n");
  }
  const out = [];
  let prev = null;
  for (const s of transcriptSegments) {
    if (s.speakerId !== prev) {
      if (out.length) out.push("");
      if (s.speakerId) out.push(`${speakerLabel(s.speakerId)}:`);
      prev = s.speakerId;
    }
    out.push(s.text);
  }
  return out.join("\n");
}

function buildSpeakerHeader(id) {
  const h = document.createElement("div");
  h.className = "segment-spk";
  h.dataset.speaker = String(id);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `spk-tag spk-${((id - 1) % 6) + 1}`;
  btn.textContent = speakerLabel(id);
  btn.title = "Byt namn på talaren";
  btn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "field spk-input";
    input.maxLength = 30;
    input.value = speakerNames[id] || "";
    input.placeholder = `Talare ${id}`;
    let done = false;
    const finish = (save) => {
      if (done) return; done = true;
      if (save) {
        const v = input.value.trim();
        if (v) speakerNames[id] = v; else delete speakerNames[id];
        document.querySelectorAll(`.segment-spk[data-speaker="${id}"] .spk-tag`)
          .forEach(t => { t.textContent = speakerLabel(id); });
        outputText.value = buildPlainText();
        saveCurrentTranscriptSoon();
      }
      if (input.parentNode) input.replaceWith(btn);
      btn.textContent = speakerLabel(id);
      btn.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    btn.replaceWith(input);
    input.focus();
  });
  h.appendChild(btn);
  return h;
}

function buildConfidenceView(seg) {
  const div = document.createElement("div");
  div.className = "segment-view";
  div.textContent = seg.text;
  return div;
}

function makeViewEditable(view) {
  view.tabIndex = 0;
  view.setAttribute("role", "button");
  view.title = "Redigera texten (Enter)";
}
function viewKeydown(e) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.currentTarget.click(); }
}

function buildSegmentRow(seg, idx) {
  const row = document.createElement("div");
  row.className = "segment-row";
  row.dataset.idx = idx;

  const ts = document.createElement("button");
  ts.type = "button";
  ts.className = "segment-ts";
  ts.textContent = formatMs(seg.startMs);
  ts.title = "Spela från denna tidpunkt";
  ts.addEventListener("click", () => seekPlayer(seg.startMs));

  const confView = buildConfidenceView(seg);
  makeViewEditable(confView);

  const ta = document.createElement("textarea");
  ta.className = "segment-input hidden";
  ta.value = seg.text;
  ta.rows = 1;
  const autoGrow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", () => {
    transcriptSegments[idx].text = ta.value;
    autoGrow();
    saveCurrentTranscriptSoon();
  });
  let textAtFocus = "";
  ta.addEventListener("focus", () => { textAtFocus = transcriptSegments[idx].text; });
  const finishEdit = () => {
    if (ta.classList.contains("hidden")) return;
    outputText.value = buildPlainText();
    if (textAtFocus && ta.value !== textAtFocus) suggestVocabFromEdit(textAtFocus, ta.value);
    const newView = buildConfidenceView(transcriptSegments[idx]);
    makeViewEditable(newView);
    newView.addEventListener("click", () => { newView.classList.add("hidden"); ta.classList.remove("hidden"); requestAnimationFrame(autoGrow); ta.focus(); });
    newView.addEventListener("keydown", viewKeydown);
    ta.classList.add("hidden");
    const existing = row.querySelector(".segment-view");
    if (existing) row.replaceChild(newView, existing);
    else row.insertBefore(newView, ta);
    if (row._focusView) { row._focusView = false; newView.focus(); }
  };
  ta.addEventListener("blur", finishEdit);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); row._focusView = true; finishEdit(); }
  });

  confView.addEventListener("keydown", viewKeydown);
  confView.addEventListener("click", () => {
    confView.classList.add("hidden");
    ta.classList.remove("hidden");
    requestAnimationFrame(autoGrow);
    ta.focus();
  });

  row.append(ts, confView, ta);
  row._autoGrowFn = autoGrow;
  return row;
}

let autoGrowObserver = null;
let segmentRenderJobId = 0;

function renderSegmentEditor() {
  const editor = document.getElementById("segment-editor");
  if (!editor) return;
  const jobId = ++segmentRenderJobId;
  editor.replaceChildren();
  segmentRowsCache = [];
  currentActiveSegIdx = -1;

  if (autoGrowObserver) autoGrowObserver.disconnect();
  autoGrowObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const row = e.target;
      if (row.dataset.grown) return;
      if (typeof row._autoGrowFn === "function") row._autoGrowFn();
      row.dataset.grown = "1";
    });
  }, { rootMargin: "200px" });

  // Batchad rendering via requestIdleCallback så 1 300+ segment aldrig fryser UI:t
  const CHUNK = 50;
  let i = 0;
  let lastSpeakerRendered = null;
  const total = transcriptSegments.length;

  function renderBatch(deadline) {
    if (jobId !== segmentRenderJobId) return;
    const frag = document.createDocumentFragment();
    let added = 0;
    const hasDeadline = deadline && typeof deadline.timeRemaining === "function";
    while (i < total && added < CHUNK && (!hasDeadline || deadline.timeRemaining() > 4 || deadline.didTimeout)) {
      const seg = transcriptSegments[i];
      if (seg.speakerId && seg.speakerId !== lastSpeakerRendered) {
        frag.appendChild(buildSpeakerHeader(seg.speakerId));
      }
      lastSpeakerRendered = seg.speakerId || null;
      const row = buildSegmentRow(seg, i);
      frag.appendChild(row);
      segmentRowsCache.push(row);
      i++;
      added++;
    }
    editor.appendChild(frag);
    for (let j = segmentRowsCache.length - added; j < segmentRowsCache.length; j++) {
      autoGrowObserver.observe(segmentRowsCache[j]);
    }
    if (i < total) {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(renderBatch, { timeout: 100 });
      } else {
        setTimeout(() => renderBatch({ timeRemaining: () => 16, didTimeout: false }), 0);
      }
    }
  }

  renderBatch({ timeRemaining: () => 16, didTimeout: false });
}

function showSegmentView() {
  segmentViewActive = true;
  outputText.classList.add("hidden");
  document.getElementById("segment-editor")?.classList.remove("hidden");
  const label = document.getElementById("segment-toggle-label");
  if (label) label.textContent = "Råtext";
}
function showRawView() {
  segmentViewActive = false;
  outputText.classList.remove("hidden");
  document.getElementById("segment-editor")?.classList.add("hidden");
  const label = document.getElementById("segment-toggle-label");
  if (label) label.textContent = "Segmentvy";
}

async function setupPlayerFromPath(filePath) {
  if (!filePath || !audioPlayer) return;
  teardownPlayer();
  try { await invoke("allow_asset_path", { path: filePath }); } catch (_) { return; }
  audioPlayer.src = window.__TAURI__.core.convertFileSrc(filePath);
  audioPlayer.load();
  document.getElementById("player-bar")?.classList.remove("hidden");
}

function teardownPlayer() {
  if (audioPlayer) {
    try { audioPlayer.pause(); } catch (_) {}
    audioPlayer.removeAttribute("src");
    audioPlayer.load();
  }
  if (currentPlaybackUrl) { URL.revokeObjectURL(currentPlaybackUrl); currentPlaybackUrl = null; }
  document.getElementById("player-bar")?.classList.add("hidden");
}
function seekPlayer(ms) { if (audioPlayer) audioPlayer.currentTime = ms / 1000; }

function initPlayer() {
  audioPlayer = document.getElementById("audio-player");
  if (!audioPlayer) return;
  audioPlayer.addEventListener("timeupdate", () => {
    const ms = audioPlayer.currentTime * 1000;
    const dur = (isFinite(audioPlayer.duration) ? audioPlayer.duration : 0) * 1000 || 1;
    const pct = Math.min(100, (ms / dur) * 100);
    const fill = document.getElementById("player-fill");
    if (fill) fill.style.width = `${pct}%`;
    const playerTime = document.getElementById("player-time");
    if (playerTime) playerTime.textContent = formatMs(ms);
    if (segmentViewActive && segmentRowsCache.length > 0) {
      let lo = 0, hi = transcriptSegments.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const seg = transcriptSegments[mid];
        if (ms < seg.startMs) hi = mid - 1;
        else if (ms >= seg.endMs) lo = mid + 1;
        else { found = mid; break; }
      }
      if (found !== currentActiveSegIdx) {
        if (currentActiveSegIdx >= 0) segmentRowsCache[currentActiveSegIdx]?.classList.remove("segment-active");
        if (found >= 0) {
          const row = segmentRowsCache[found];
          if (row) { row.classList.add("segment-active"); row.scrollIntoView({ block: "nearest" }); }
        }
        currentActiveSegIdx = found;
      }
    }
  });
  audioPlayer.addEventListener("loadedmetadata", () => {
    const dur = document.getElementById("player-duration");
    if (dur && isFinite(audioPlayer.duration)) dur.textContent = formatMs(audioPlayer.duration * 1000);
  });
  audioPlayer.addEventListener("ended", () => {
    const icon = document.getElementById("play-icon");
    if (icon) icon.textContent = "play_arrow";
  });
  const track = document.getElementById("player-track");
  track?.addEventListener("click", (e) => {
    if (!audioPlayer || !isFinite(audioPlayer.duration)) return;
    const rect = track.getBoundingClientRect();
    audioPlayer.currentTime = ((e.clientX - rect.left) / rect.width) * audioPlayer.duration;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Transkribering (endast Pianissimo svenska)
// ─────────────────────────────────────────────────────────────────────────────
async function processAudioFile(filePath) {
  lastTranscribedPath = filePath;
  try {
    hidePostRecordingActions();
    pendingRecording = null;
    const fileName = filePath.split(/[/\\]/).pop();
    loadingText.innerText = `Avkodar ${fileName}…`;
    announce("Transkriberingen har startat");
    loadingOverlay.classList.remove("hidden");
    progressContainer?.classList.remove("hidden");
    if (progressBar) progressBar.style.width = "0%";

    outputText.value = "";
    transcriptSegments = [];
    speakerNames = {};
    speakerNotice = null;
    pendingVocabChanges = [];
    hideNotice();
    teardownPlayer();
    showRawView();
    maskingCtrl?.resetMaskState();

    isCancelling = false;
    if (btnCancelTranscription) { btnCancelTranscription.textContent = "Avbryt"; btnCancelTranscription.classList.remove("hidden"); }
    const startTime = performance.now();

    const segs = await invoke("transcribe_file", {
      filePath,
      identifySpeakers,
      useGpu,
      threadCount,
    });

    if (segs && segs.length > 0) {
      transcriptSegments = segs.map(s => ({ ...s, tokens: s.tokens || [] }));
      outputText.value = buildPlainText();
    }

    if (progressBar) progressBar.style.width = "100%";
    const elapsed = Math.round((performance.now() - startTime) / 1000);
    loadingText.innerText = `Klar! (${elapsed} s)`;
    announce(`Transkriberingen är klar. ${transcriptSegments.length} segment.`);

    const notices = [];
    if (pendingVocabChanges.length > 0) {
      notices.push(`Ordlistan rättade ${pendingVocabChanges.length} ord: ${summarizeChanges(pendingVocabChanges)}.`);
    }
    if (speakerNotice) { notices.push(speakerNotice); speakerNotice = null; }
    if (notices.length > 0) showNotice(notices.join(" "));

    if (transcriptSegments.length > 0) {
      renderSegmentEditor();
      showSegmentView();
      const btnSeg = document.getElementById("btn-segment-toggle");
      if (btnSeg) { btnSeg.classList.remove("hidden"); btnSeg.style.display = "inline-flex"; }
      btnRedo.classList.remove("hidden"); btnRedo.style.display = "inline-flex";
      await setupPlayerFromPath(filePath);

      // Spara transkriberingen i sessionsmappen (eller skapa en ny lokal session för importerad ljudfil)
      const baseLabel = fileName.replace(/\.[^.]+$/, "");
      currentSessionDir = null;
      await ensureActiveSession(filePath, baseLabel);
      await saveCurrentTranscriptNow();
    }
  } catch (err) {
    const errMsg = typeof err === "string" ? err : err.message || String(err);
    if (isCancelling || errMsg.toLowerCase().includes("cancel")) {
      outputText.value += "\n\n[Transkribering avbruten]";
    } else {
      await message(`Transkribering misslyckades: ${errMsg}`, { title: "Fel", kind: "error" });
    }
  } finally {
    isCancelling = false;
    btnCancelTranscription?.classList.add("hidden");
    loadingOverlay.classList.add("hidden");
    enableControls();
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch (_) {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("Urklipp är inte tillgängligt");
}

btnCopy.addEventListener("click", () => {
  const text = getCurrentTranscriptText();
  if (!text) return;
  copyText(text).then(() => {
    flashButtonFeedback(btnCopy, "Kopierad", 2000);
  });
});

btnSave.addEventListener("click", async () => {
  const content = getCurrentTranscriptText();
  if (!content || !content.trim()) return;
  try {
    await invoke("save_text_file", { content, defaultName: "transkribering.txt" });
  } catch (err) {
    const msg = typeof err === "string" ? err : err.message || String(err);
    if (!msg.includes("cancelled") && !msg.includes("canceled")) {
      await message(`Kunde inte spara filen: ${msg}`, { title: "Fel", kind: "error" });
    }
  }
});

const btnSaveAudio = document.getElementById("btn-save-audio");
btnSaveAudio?.addEventListener("click", () => saveRecordedAudio());

document.getElementById("btn-segment-toggle")?.addEventListener("click", () => {
  if (segmentViewActive) showRawView();
  else showSegmentView();
});

const btnPlayPause = document.getElementById("btn-play-pause");
const playIcon = document.getElementById("play-icon");
btnPlayPause?.addEventListener("click", () => {
  if (!audioPlayer || !audioPlayer.src) return;
  if (audioPlayer.paused) {
    audioPlayer.play().then(() => { if (playIcon) playIcon.textContent = "pause"; }).catch(() => {});
  } else {
    audioPlayer.pause();
    if (playIcon) playIcon.textContent = "play_arrow";
  }
});

async function applySessionName() {
  const input = document.getElementById("session-name-input");
  const name = input ? input.value.trim() : "";
  if (!name) return;
  try {
    const newPath = await invoke("rename_session", { name });
    if (pendingRecording && pendingRecording.type === "wav-file") pendingRecording.filePath = newPath;
  } catch (_) {}
  finally { if (input) input.value = ""; }
}

document.getElementById("btn-start-transcription")?.addEventListener("click", async () => {
  await applySessionName();
  startPendingTranscription();
});
document.getElementById("btn-save-for-later")?.addEventListener("click", async () => {
  await applySessionName();
  hidePostRecordingActions();
  pendingRecording = null;
  updateBadge("Inspelning sparad", "");
});
document.getElementById("btn-close-opened")?.addEventListener("click", () => {
  hidePostRecordingActions();
  pendingRecording = null;
});
document.getElementById("session-name-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); document.getElementById("btn-save-for-later")?.click(); }
});
document.getElementById("post-recording-path")?.addEventListener("click", async () => {
  const p = document.getElementById("post-recording-path")?.dataset.path;
  if (p) invoke("open_session_folder", { path: p }).catch(() => {});
});
document.getElementById("btn-save-audio-only")?.addEventListener("click", async () => {
  await applySessionName();
  hidePostRecordingActions();
  pendingRecording = null;
  await saveRecordedAudio();
});

document.getElementById("wasapi-toggle")?.addEventListener("change", (e) => {
  wasapiEnabled = e.target.checked;
  localStorage.setItem("wasapiEnabled", wasapiEnabled.toString());
  syncWasapiVisual();
});

const speakersToggleEl = document.getElementById("speakers-toggle");
speakersToggleEl?.addEventListener("change", async () => {
  if (!speakersToggleEl.checked) {
    identifySpeakers = false;
    localStorage.setItem("identifySpeakers", "false");
    return;
  }
  try {
    const ready = await invoke("check_diarization_models");
    if (!ready) {
      const ok = await showConfirm(
        "För att skilja talare åt hämtas två små modeller (ca 33 MB) en gång från huggingface.co.",
        "Hämta talarmodeller"
      );
      if (!ok) { speakersToggleEl.checked = false; return; }
      loadingOverlay.classList.remove("hidden");
      loadingText.innerText = "Hämtar talarmodeller…";
      progressContainer?.classList.remove("hidden");
      if (progressBar) progressBar.style.width = "0%";
      try { await invoke("download_diarization_models"); }
      finally {
        loadingOverlay.classList.add("hidden");
        progressContainer?.classList.add("hidden");
      }
      refreshModelList();
    }
    identifySpeakers = true;
    localStorage.setItem("identifySpeakers", "true");
  } catch (err) {
    speakersToggleEl.checked = false;
    identifySpeakers = false;
    await message(`Kunde inte hämta talarmodellerna: ${err}`, { title: "Fel", kind: "error" });
  }
});

document.getElementById("btn-theme")?.addEventListener("click", () => {
  setTheme(themePref === "dark" ? "light" : "dark");
  if (!isRecording) resetEq();
});

// ─────────────────────────────────────────────────────────────────────────────
// Nollställ applikationen
// ─────────────────────────────────────────────────────────────────────────────
const resetModal = document.getElementById("reset-modal");
const resetConfirm = document.getElementById("reset-confirm");
const resetOptModels = document.getElementById("reset-opt-models");
const resetOptSettings = document.getElementById("reset-opt-settings");
const resetOptVocab = document.getElementById("reset-opt-vocab");
const resetOptRecordings = document.getElementById("reset-opt-recordings");

function syncResetConfirmBtn() {
  if (!resetConfirm) return;
  resetConfirm.disabled = !(resetOptModels?.checked || resetOptSettings?.checked || resetOptVocab?.checked || resetOptRecordings?.checked);
}
[resetOptModels, resetOptSettings, resetOptVocab, resetOptRecordings].forEach(cb => cb?.addEventListener("change", syncResetConfirmBtn));

document.getElementById("btn-reset-app")?.addEventListener("click", () => {
  if (!resetModal) return;
  if (resetOptModels) resetOptModels.checked = true;
  if (resetOptSettings) resetOptSettings.checked = true;
  if (resetOptVocab) resetOptVocab.checked = false;
  if (resetOptRecordings) resetOptRecordings.checked = false;
  syncResetConfirmBtn();
  resetModal.classList.remove("hidden");
});
document.getElementById("reset-cancel")?.addEventListener("click", () => resetModal?.classList.add("hidden"));
resetConfirm?.addEventListener("click", async () => {
  const deleteModels = Boolean(resetOptModels?.checked);
  const deleteSettings = Boolean(resetOptSettings?.checked);
  const deleteVocab = Boolean(resetOptVocab?.checked);
  const deleteRecordings = Boolean(resetOptRecordings?.checked);
  resetConfirm.disabled = true;
  try {
    teardownPlayer();
    await invoke("reset_application", {
      deleteModels,
      deleteVocab,
      deleteRecordings,
      deleteLogs: deleteSettings,
      recordingDir: recordingDir || null,
    });
    if (deleteSettings) localStorage.clear();
    resetModal?.classList.add("hidden");
    if (deleteSettings || deleteModels) { window.location.reload(); return; }
    if (deleteVocab) { vocabStore = { version: 1, lists: [] }; vocabSelected = null; renderVocab(); }
    if (deleteRecordings) refreshRecordingsUsage();
    await message("Valda delar har nollställts.", { title: "Klart" });
  } catch (err) {
    await message(`Kunde inte nollställa: ${err}`, { title: "Fel", kind: "error" });
  } finally {
    syncResetConfirmBtn();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordlistor
// ─────────────────────────────────────────────────────────────────────────────
function newVocabId() { return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function vocabEntryCount(text) { return text.split("\n").filter(l => l.split("#")[0].trim()).length; }

async function loadVocab() {
  try { vocabStore = await invoke("vocab_load"); }
  catch (_) { vocabStore = { version: 1, lists: [] }; }
  if (!vocabStore.lists.some(l => l.id === vocabSelected)) vocabSelected = vocabStore.lists[0]?.id ?? null;
}

let vocabSaveTimer = null;
function saveVocabSoon() { clearTimeout(vocabSaveTimer); vocabSaveTimer = setTimeout(saveVocabNow, 600); }
async function saveVocabNow() {
  clearTimeout(vocabSaveTimer); vocabSaveTimer = null;
  try { await invoke("vocab_save", { store: vocabStore }); } catch (_) {}
}
function selectedVocabList() { return vocabStore.lists.find(l => l.id === vocabSelected) || null; }

function renderVocab() {
  const ul = document.getElementById("vocab-lists");
  if (!ul) return;
  ul.replaceChildren();
  if (vocabStore.lists.length === 0) {
    const p = document.createElement("li");
    p.className = "hint";
    p.textContent = "Du har inga ordlistor än. Skapa en med Ny ordlista.";
    ul.appendChild(p);
  }
  for (const list of vocabStore.lists) {
    const li = document.createElement("li");
    li.className = `model-row ${list.id === vocabSelected ? "is-active" : ""}`;
    const label = document.createElement("label");
    label.className = "flex items-center gap-3 min-w-0 flex-1 cursor-pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "w-5 h-5 accent-primary shrink-0";
    cb.checked = list.enabled;
    cb.addEventListener("change", () => { list.enabled = cb.checked; saveVocabSoon(); });
    const name = document.createElement("span");
    name.className = "text-sm font-semibold truncate";
    name.textContent = list.name;
    const count = document.createElement("span");
    count.className = "text-xs text-muted shrink-0";
    count.textContent = `${vocabEntryCount(list.text)} ord`;
    label.append(cb, name, count);

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "btn btn-sm shrink-0";
    pick.textContent = list.id === vocabSelected ? "Vald" : "Redigera";
    pick.disabled = list.id === vocabSelected;
    pick.addEventListener("click", () => { vocabSelected = list.id; renderVocab(); });
    li.append(label, pick);
    ul.appendChild(li);
  }
  const editor = document.getElementById("vocab-editor");
  const list = selectedVocabList();
  editor?.classList.toggle("hidden", !list);
  const del = document.getElementById("vocab-delete");
  if (del) del.disabled = !list;
  if (list) {
    const nameEl = document.getElementById("vocab-list-name");
    const textEl = document.getElementById("vocabulary-input");
    if (nameEl && nameEl.value !== list.name) nameEl.value = list.name;
    if (textEl && textEl.value !== list.text) textEl.value = list.text;
  }
}

document.getElementById("vocab-list-name")?.addEventListener("input", (e) => {
  const list = selectedVocabList();
  if (!list) return;
  list.name = e.target.value.trim() || "Ordlista";
  saveVocabSoon();
});
document.getElementById("vocabulary-input")?.addEventListener("input", (e) => {
  const list = selectedVocabList();
  if (!list) return;
  list.text = e.target.value;
  saveVocabSoon();
});
document.getElementById("vocab-new")?.addEventListener("click", () => {
  const list = { id: newVocabId(), name: `Ordlista ${vocabStore.lists.length + 1}`, enabled: true, text: "" };
  vocabStore.lists.push(list);
  vocabSelected = list.id;
  renderVocab();
  saveVocabSoon();
});
document.getElementById("vocab-delete")?.addEventListener("click", async () => {
  const list = selectedVocabList();
  if (!list) return;
  const ok = await showConfirm(`Ta bort ordlistan "${list.name}"?`, "Ta bort ordlista");
  if (!ok) return;
  vocabStore.lists = vocabStore.lists.filter(l => l.id !== list.id);
  vocabSelected = vocabStore.lists[0]?.id ?? null;
  renderVocab();
  await saveVocabNow();
});
document.getElementById("vocab-open-dir")?.addEventListener("click", () => invoke("open_vocab_dir").catch(() => {}));
invoke("vocab_dir").then(d => { const el = document.getElementById("vocab-dir"); if (el) el.textContent = d; }).catch(() => {});

document.getElementById("vocabulary-import")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let text = await file.text();
  let list = selectedVocabList();
  if (!list) {
    list = { id: newVocabId(), name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Importerad", enabled: true, text: "" };
    vocabStore.lists.push(list);
    vocabSelected = list.id;
  }
  list.text = text.replace(/\r\n/g, "\n").trim() + "\n";
  renderVocab();
  saveVocabSoon();
  e.target.value = "";
});
document.getElementById("vocabulary-export")?.addEventListener("click", async () => {
  const list = selectedVocabList();
  if (!list) return;
  try { await invoke("save_text_file", { content: list.text, defaultName: `${list.name}.txt` }); } catch (_) {}
});

// Meddelanderad
const noticeBar = document.getElementById("notice-bar");
const noticeText = document.getElementById("notice-text");
const noticeAction = document.getElementById("notice-action");
let noticeActionHandler = null;
function showNotice(text, action) {
  if (!noticeBar) return;
  noticeText.textContent = text;
  noticeActionHandler = action ? action.onClick : null;
  if (action) { noticeAction.textContent = action.label; noticeAction.classList.remove("hidden"); }
  else noticeAction.classList.add("hidden");
  noticeBar.classList.remove("hidden");
}
function hideNotice() { noticeBar?.classList.add("hidden"); noticeActionHandler = null; }
noticeAction?.addEventListener("click", () => { if (noticeActionHandler) noticeActionHandler(); });
document.getElementById("notice-close")?.addEventListener("click", hideNotice);

async function updateNetworkDirHint() {
  const hint = document.getElementById("recording-dir-network");
  if (!hint) return;
  let network = false;
  try { network = !!recordingDir && await invoke("is_network_folder", { path: recordingDir }); } catch (_) {}
  hint.classList.toggle("hidden", !network);
}

async function checkCrashMarker() {
  try {
    const marker = await invoke("take_crash_marker");
    if (marker) {
      if (marker.gpu && useGpu) {
        useGpu = false;
        localStorage.setItem("useGpu", "false");
        const gpuToggle = document.getElementById("gpu-toggle");
        if (gpuToggle) gpuToggle.checked = false;
        showNotice("Förra transkriberingen avbröts oväntat. GPU-acceleration har stängts av automatiskt så att Pianissimo kör på processorn i stället. Du kan slå på den igen under Inställningar → Avancerat.");
      } else {
        showNotice("Förra transkriberingen avbröts oväntat. Skicka gärna loggen under Inställningar → Felsökning om det händer igen.");
      }
    }
  } catch (_) {}
}

function summarizeChanges(changes) {
  const counts = new Map();
  for (const c of changes) {
    const k = `${c.from} → ${c.to}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].slice(0, 4).map(([k, n]) => (n > 1 ? `${k} (${n})` : k));
  const more = counts.size > 4 ? ` och ${counts.size - 4} till` : "";
  return `${top.join(", ")}${more}`;
}

async function applyVocabularyToTranscript(quiet) {
  await saveVocabNow();
  const useSegments = transcriptSegments.length > 0;
  const texts = useSegments ? transcriptSegments.map(s => s.text) : [outputText.value];
  if (!texts.some(t => t.trim())) {
    if (!quiet) showNotice("Det finns ingen text att rätta än.");
    return 0;
  }
  let res;
  try { res = await invoke("apply_vocabulary", { texts }); }
  catch (err) { showNotice(`Ordlistan kunde inte tillämpas: ${err}`); return 0; }
  if (res.changes.length === 0) {
    if (!quiet) showNotice("Ordlistan hittade inget att rätta i texten.");
    return 0;
  }
  if (useSegments) {
    res.texts.forEach((t, i) => {
      if (t !== transcriptSegments[i].text) { transcriptSegments[i].text = t; transcriptSegments[i].tokens = []; }
    });
    renderSegmentEditor();
    outputText.value = buildPlainText();
  } else {
    outputText.value = res.texts[0];
  }
  showNotice(`Ordlistan rättade ${res.changes.length} ord: ${summarizeChanges(res.changes)}.`);
  saveCurrentTranscriptSoon();
  return res.changes.length;
}
document.getElementById("btn-apply-vocab")?.addEventListener("click", () => applyVocabularyToTranscript(false));

function wordEdit(oldText, newText) {
  const tok = (t) => t.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || [];
  const a = tok(oldText), b = tok(newText);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const from = a.slice(s, ea), to = b.slice(s, eb);
  if (!from.length || !to.length || from.length > 3 || to.length > 3) return null;
  const f = from.join(" "), t = to.join(" ");
  if (f.toLowerCase() === t.toLowerCase()) return null;
  return { from: f, to: t };
}
function suggestVocabFromEdit(oldText, newText) {
  const edit = wordEdit(oldText, newText);
  if (!edit) return;
  showNotice(`Lägga till "${edit.to}" i ordlistan? "${edit.from}" rättas då automatiskt framöver.`, {
    label: "Lägg till",
    onClick: async () => {
      try {
        vocabStore = await invoke("vocab_add_entry", { listId: null, term: edit.to, alias: edit.from });
        if (!vocabStore.lists.some(l => l.id === vocabSelected)) vocabSelected = vocabStore.lists[0]?.id ?? null;
        renderVocab();
        const n = await applyVocabularyToTranscript(true);
        showNotice(`Lade till "${edit.from} => ${edit.to}" i ordlistan.${n ? ` ${n} ord rättades.` : ""}`);
      } catch (err) {
        showNotice(`Kunde inte lägga till i ordlistan: ${err}`);
      }
    },
  });
}

window.addEventListener("DOMContentLoaded", initialize);
