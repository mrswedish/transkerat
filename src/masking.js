// Maskering & avmaskering för Transkerat (portat från Maskera: Lager 1 Regex/Roller + Lager 2 Svensk BERT NER)

import {
  renderMarkdownToElement,
  markdownToCleanHtml,
  markdownToCleanPlainText,
} from "./markdown.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

export const PRESETS = {
  ai_safe: {
    name: "AI-säker",
    entities: [
      "Personnummer",
      "E-post",
      "Telefonnummer",
      "Org.nummer",
      "Konto/Giro",
      "Kortnummer",
      "Hemlighet/Nyckel",
      "Person",
      "Organisation",
      "Plats",
      "Övrigt",
    ],
  },
  strict: {
    name: "Strikt (inkl. Roll/Titel)",
    entities: [
      "Personnummer",
      "E-post",
      "Telefonnummer",
      "Org.nummer",
      "Konto/Giro",
      "IP-adress",
      "Kortnummer",
      "Hemlighet/Nyckel",
      "Person",
      "Roll/Titel",
      "Organisation",
      "Plats",
      "Övrigt",
      "Tid",
      "Händelse",
    ],
  },
};

// WCAG AA-kalibrerade kategorifärger (>= 5.0:1 kontrast mot vit text #ffffff)
export const COLORS = {
  Personnummer: "#b91c1c",
  "E-post": "#1d4ed8",
  Telefonnummer: "#b45309",
  "Org.nummer": "#7e22ce",
  "Konto/Giro": "#be185d",
  "IP-adress": "#0369a1",
  Kortnummer: "#991b1b",
  "Hemlighet/Nyckel": "#9f1239",
  Person: "#5b21b6",
  "Roll/Titel": "#3730a3",
  Organisation: "#047857",
  Plats: "#9d174d",
  Övrigt: "#475569",
  Tid: "#0e7490",
  Händelse: "#854d0e",
  Manuell: "#c2410c",
};

function buildByteToCharMap(text, needed) {
  const byteToChar = new Map();
  if (needed.size === 0) return byteToChar;

  let u16 = 0;
  let byteIdx = 0;
  const len = text.length;

  while (u16 < len) {
    if (needed.has(byteIdx)) {
      byteToChar.set(byteIdx, u16);
      if (byteToChar.size === needed.size) break;
    }
    const code = text.charCodeAt(u16);
    if (code < 0x80) {
      byteIdx += 1;
      u16 += 1;
    } else if (code < 0x800) {
      byteIdx += 2;
      u16 += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && u16 + 1 < len) {
      byteIdx += 4;
      u16 += 2;
    } else {
      byteIdx += 3;
      u16 += 1;
    }
  }
  if (needed.has(byteIdx)) {
    byteToChar.set(byteIdx, u16);
  }
  return byteToChar;
}

export function fixByteOffsets(text, rawMatches) {
  if (!rawMatches || rawMatches.length === 0) return [];
  const needed = new Set();
  for (const m of rawMatches) {
    needed.add(m.start);
    needed.add(m.end);
  }
  const byteToChar = buildByteToCharMap(text, needed);
  return rawMatches.map((m) => ({
    ...m,
    start: byteToChar.get(m.start) ?? m.start,
    end: byteToChar.get(m.end) ?? m.end,
  }));
}

function maskedLabel(label, source, counter) {
  const baseLabel = label === "Roll/Titel" ? "Roll" : label;
  if (source === "regex" || source === "manuell") {
    return `${baseLabel} ${counter}`;
  }
  if (counter <= 26) {
    return `${baseLabel} ${String.fromCharCode(64 + counter)}`;
  }
  const first = String.fromCharCode(64 + Math.floor((counter - 1) / 26));
  const second = String.fromCharCode(64 + ((counter - 1) % 26) + 1);
  return `${baseLabel} ${first}${second}`;
}

export function translationLookupKey(m) {
  return m.label === "Roll/Titel" ? `role:${m.text.toLowerCase()}` : m.text;
}

export function buildTranslationTable(matches) {
  const table = new Map();
  const counters = new Map();

  for (const m of matches) {
    const lookupKey = translationLookupKey(m);
    if (table.has(lookupKey)) {
      const entry = table.get(lookupKey);
      entry.positions.push({ start: m.start, end: m.end });
      entry.count += 1;
      if (!entry.variants.includes(m.text)) {
        entry.variants.push(m.text);
      }
      if (m.label === "Roll/Titel" && m.text === m.text.toLowerCase()) {
        entry.originalText = m.text;
      }
    } else {
      const counterKey = `${m.label}|${m.source}`;
      const next = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, next);
      table.set(lookupKey, {
        maskedLabel: maskedLabel(m.label, m.source, next),
        label: m.label,
        originalText: m.text,
        variants: [m.text],
        positions: [{ start: m.start, end: m.end }],
        count: 1,
      });
    }
  }
  return table;
}

export function buildMaskedText(sourceText, activeMatches, table) {
  if (!sourceText || activeMatches.length === 0) return sourceText;
  const posToLabel = new Map();
  for (const entry of table.values()) {
    for (const pos of entry.positions) {
      posToLabel.set(pos.start, entry.maskedLabel);
    }
  }
  const sortedDesc = [...activeMatches].sort((a, b) => b.start - a.start);
  const segments = [];
  let cursor = sourceText.length;

  for (const m of sortedDesc) {
    segments.push(sourceText.slice(m.end, cursor));
    segments.push(`[${(posToLabel.get(m.start) ?? m.label).toUpperCase()}]`);
    cursor = m.start;
  }
  segments.push(sourceText.slice(0, cursor));
  return segments.reverse().join("");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function unmaskText(aiText, table) {
  if (!aiText || !table || table.size === 0) {
    return { text: aiText || "", replacements: 0 };
  }
  const entries = [...table.values()].sort(
    (a, b) => b.maskedLabel.length - a.maskedLabel.length
  );

  let output = aiText;
  let replacements = 0;

  for (const entry of entries) {
    const escaped = escapeRegExp(entry.maskedLabel);
    const escapedUpper = escapeRegExp(entry.maskedLabel.toUpperCase());

    const bracketRe = new RegExp(`\\[\\s*${escaped}\\s*\\]`, "giu");
    output = output.replace(bracketRe, () => {
      replacements += 1;
      return entry.originalText;
    });

    const bareRe = new RegExp(
      `(?<![\\p{L}\\p{N}])(?:${escapedUpper}|${escaped})(?![\\p{L}\\p{N}])`,
      "gu"
    );
    output = output.replace(bareRe, () => {
      replacements += 1;
      return entry.originalText;
    });
  }
  return { text: output, replacements };
}

// ── AI-promptmallar vid "Kopiera maskerat" ────────────────────────────────────

export const PLACEHOLDER_RULE =
  "VIKTIGT: Texten nedan är pseudonymiserad med platshållare inom hakparenteser (t.ex. {EXAMPLES}). " +
  "Behåll ALLTID alla platshållare exakt som de står — inklusive hakparenteser och versaler. " +
  "Ersätt dem aldrig med generella ord som \"en deltagare\", \"chefen\" eller \"organisationen\", " +
  "och ändra inte stavning eller böjning inuti hakparenteserna. Texten kommer att avmaskeras lokalt efteråt.";

export const PROMPT_TEMPLATES = {
  protocol: {
    name: "Mötesprotokoll",
    body:
      "Skapa ett tydligt och strukturerat mötesprotokoll på svenska utifrån transkriberingen nedan.\n\n" +
      "Använd följande rubriker:\n" +
      "1. Sammanhang & syfte\n" +
      "2. Huvudpunkter som diskuterades (ange vilka [PLATSHÅLLARE] som sa eller ansvarade för vad)\n" +
      "3. Beslut\n" +
      "4. Åtgärder / nästa steg (lista uppgift, ansvarig [PLATSHÅLLARE] och ev. tidpunkt)\n\n" +
      PLACEHOLDER_RULE,
  },
  summary: {
    name: "Kort sammanfattning",
    body:
      "Skriv en koncis sammanfattning på svenska i 5–7 korta punkter utifrån transkriberingen nedan. " +
      "Lyft fram de viktigaste slutsatserna, ställningstagandena och nästa steg, och behåll berörda [PLATSHÅLLARE].\n\n" +
      PLACEHOLDER_RULE,
  },
  actions: {
    name: "Åtgärdslista (Att göra)",
    body:
      "Extrahera alla konkreta åtgärdspunkter, beslut och uppföljningar ur transkriberingen nedan. " +
      "Presentera resultatet på svenska som en tydlig lista eller tabell med kolumnerna: Uppgift, Ansvarig ([PLATSHÅLLARE]) och Tidsram/kommentar.\n\n" +
      PLACEHOLDER_RULE,
  },
  placeholders_only: {
    name: "Endast platshållarregel",
    body: PLACEHOLDER_RULE,
  },
  custom: {
    name: "Egen prompt",
    body:
      "Sammanfatta transkriberingen nedan på svenska.\n\n" +
      PLACEHOLDER_RULE,
  },
  none: {
    name: "Ingen prompt (bara maskerad text)",
    body: "",
  },
};

export function samplePlaceholders(table) {
  if (!table || table.size === 0) {
    return "[PERSON A], [ROLL A], [ORGANISATION A]";
  }
  const seenLabels = new Set();
  const examples = [];
  for (const entry of table.values()) {
    if (!seenLabels.has(entry.label)) {
      seenLabels.add(entry.label);
      examples.push(`[${entry.maskedLabel.toUpperCase()}]`);
      if (examples.length >= 3) break;
    }
  }
  return examples.length > 0 ? examples.join(", ") : "[PERSON A], [ROLL A], [ORGANISATION A]";
}

export function resolvePromptText(templateId, table, customOrEditedText) {
  if (templateId === "none") return "";
  const raw =
    typeof customOrEditedText === "string" && customOrEditedText.trim()
      ? customOrEditedText.trim()
      : (PROMPT_TEMPLATES[templateId]?.body || PROMPT_TEMPLATES.protocol.body);
  return raw.replace(/\{EXAMPLES\}/g, samplePlaceholders(table));
}

export function buildClipboardPayload(maskedText, table, templateId, customOrEditedText) {
  const prompt = resolvePromptText(templateId, table, customOrEditedText);
  if (!prompt) return maskedText;
  return `${prompt}\n\n---\nTRANSKRIPTION:\n${maskedText}`;
}

// ── UI-kontroller för Steg 2 (Maskera) & Steg 3 (Avmaskera AI-svar) ──────────

export const SENSITIVITY_LEVELS = {
  high: { name: "Hög", threshold: 0.45 },
  normal: { name: "Normal", threshold: 0.6 },
  low: { name: "Låg", threshold: 0.8 },
};

export function createMaskingController({
  getTranscriptText,
  copyText,
  announce,
  showMessage,
  switchStep,
  refreshModels,
  getPersistEnabled,
  ensureSessionDir,
  getSessionDir,
  onOpenTextFile,
  onPasteTextForMasking,
}) {
  let preset = "ai_safe"; // "ai_safe" | "strict"
  let sensitivity = localStorage.getItem("maskSensitivity") || "normal";
  if (!SENSITIVITY_LEVELS[sensitivity]) sensitivity = "normal";
  let viewMode = "review"; // "review" | "masked"
  let sourceText = "";
  let allMatches = []; // [{ text, label, start, end, source }]
  let ignoredStarts = new Set(); // start offsets ignored by user
  let activeTable = new Map();
  let maskedText = "";
  let isAnalyzing = false;
  let savedOnDisk = false;
  let persistTimer = null;
  let unmaskDebounceTimer = null;
  let pendingBulkAction = null;

  // DOM refs
  const panelMask = document.getElementById("panel-mask");
  const btnAiSafe = document.getElementById("btn-preset-ai-safe");
  const btnStrict = document.getElementById("btn-preset-strict");
  const btnSensHigh = document.getElementById("btn-sens-high");
  const btnSensNormal = document.getElementById("btn-sens-normal");
  const btnSensLow = document.getElementById("btn-sens-low");
  const btnRunMask = document.getElementById("btn-run-mask");
  const btnMaskOpenText = document.getElementById("btn-mask-open-text");
  const btnMaskEmptyOpenText = document.getElementById("btn-mask-empty-open-text");
  const btnViewReview = document.getElementById("btn-mask-view-review");
  const btnViewMasked = document.getElementById("btn-mask-view-masked");
  const btnManualMask = document.getElementById("btn-manual-mask");
  const btnCopyMasked = document.getElementById("btn-copy-masked");
  const btnSaveMasked = document.getElementById("btn-save-masked");
  const btnGotoUnmask = document.getElementById("btn-goto-unmask");

  const summaryBar = document.getElementById("mask-summary-bar");
  const summaryText = document.getElementById("mask-summary-text");
  const categoryPills = document.getElementById("mask-category-pills");
  const btnRestoreIgnored = document.getElementById("btn-restore-ignored");
  const bulkBar = document.getElementById("mask-bulk-bar");
  const bulkText = document.getElementById("mask-bulk-text");
  const btnBulkApply = document.getElementById("btn-mask-bulk-apply");
  const btnBulkClose = document.getElementById("btn-mask-bulk-close");
  const emptyState = document.getElementById("mask-empty-state");
  const emptyMsg = document.getElementById("mask-empty-msg");
  const reviewEl = document.getElementById("mask-review");
  const maskOutputEl = document.getElementById("mask-output");
  const tableDetails = document.getElementById("mask-table-details");
  const tableCount = document.getElementById("mask-table-count");
  const tableBody = document.getElementById("mask-table-body");
  const storageStatusEl = document.getElementById("mask-storage-status");
  const btnClearMaskKey = document.getElementById("btn-clear-mask-key");

  // AI-prompt refs & state
  const promptSelect = document.getElementById("mask-prompt-select");
  const btnTogglePromptEditor = document.getElementById("btn-toggle-prompt-editor");
  const promptEditorWrap = document.getElementById("mask-prompt-editor-wrap");
  const promptEditor = document.getElementById("mask-prompt-editor");
  const btnResetPrompt = document.getElementById("btn-reset-prompt");
  const promptHint = document.getElementById("mask-prompt-hint");

  let selectedPromptId = localStorage.getItem("maskPromptId") || "protocol";
  if (!PROMPT_TEMPLATES[selectedPromptId]) selectedPromptId = "protocol";
  let savedCustomPrompt = localStorage.getItem("maskCustomPrompt") || PROMPT_TEMPLATES.custom.body;
  let tempEditedPrompt = null; // tillfällig redigering av inbyggd mall i denna session

  function syncPromptUI() {
    if (promptSelect) promptSelect.value = selectedPromptId;
    const isNone = selectedPromptId === "none";
    if (promptHint) {
      promptHint.textContent = isNone
        ? "Kopierar enbart den maskerade texten utan AI-instruktion."
        : "Bevarar [PERSON A], [ROLL A] m.fl. så steg 3 kan avmaskera svaret.";
    }
    if (btnTogglePromptEditor) {
      btnTogglePromptEditor.classList.toggle("hidden", isNone);
    }
    if (isNone) {
      promptEditorWrap?.classList.add("hidden");
    } else if (promptEditor) {
      const text =
        selectedPromptId === "custom"
          ? savedCustomPrompt
          : (tempEditedPrompt ?? resolvePromptText(selectedPromptId, activeTable, null));
      promptEditor.value = text;
    }
  }

  promptSelect?.addEventListener("change", () => {
    selectedPromptId = promptSelect.value;
    localStorage.setItem("maskPromptId", selectedPromptId);
    tempEditedPrompt = null;
    if (selectedPromptId === "custom") {
      promptEditorWrap?.classList.remove("hidden");
    }
    syncPromptUI();
  });

  btnTogglePromptEditor?.addEventListener("click", () => {
    if (!promptEditorWrap) return;
    const opening = promptEditorWrap.classList.contains("hidden");
    promptEditorWrap.classList.toggle("hidden", !opening);
    if (opening) {
      syncPromptUI();
      promptEditor?.focus();
    }
  });

  promptEditor?.addEventListener("input", () => {
    if (selectedPromptId === "custom") {
      savedCustomPrompt = promptEditor.value;
      localStorage.setItem("maskCustomPrompt", savedCustomPrompt);
    } else {
      tempEditedPrompt = promptEditor.value;
    }
  });

  btnResetPrompt?.addEventListener("click", () => {
    if (selectedPromptId === "custom") {
      savedCustomPrompt = PROMPT_TEMPLATES.custom.body;
      localStorage.setItem("maskCustomPrompt", savedCustomPrompt);
    } else {
      tempEditedPrompt = null;
    }
    syncPromptUI();
  });

  syncPromptUI();

  const maskOverlay = document.getElementById("mask-loading-overlay");
  const maskLoadingText = document.getElementById("mask-loading-text");
  const maskProgressBar = document.getElementById("mask-progress-bar");

  const tabMaskBadge = document.getElementById("tab-mask-badge");
  const tabUnmaskBadge = document.getElementById("tab-unmask-badge");
  const footerNer = document.getElementById("footer-ner");

  // Step 3 refs
  const unmaskTableStatus = document.getElementById("unmask-table-status");
  const unmaskCountBadge = document.getElementById("unmask-count-badge");
  const unmaskInput = document.getElementById("unmask-input");
  const unmaskOutput = document.getElementById("unmask-output");
  const btnUnmaskPaste = document.getElementById("btn-unmask-paste");
  const btnUnmaskClear = document.getElementById("btn-unmask-clear");
  const btnCopyUnmasked = document.getElementById("btn-copy-unmasked");
  const btnSaveUnmasked = document.getElementById("btn-save-unmasked");

  // Event listeners from Rust
  listen("ner_download_progress", (event) => {
    const { label, progress } = event.payload;
    if (maskLoadingText) maskLoadingText.textContent = label || "Hämtar maskeringsmodell…";
    if (maskProgressBar) maskProgressBar.style.width = `${Math.round(progress || 0)}%`;
  });

  listen("ner_progress", (event) => {
    const { chunk, total } = event.payload;
    const pct = total > 0 ? Math.round((chunk / total) * 100) : 0;
    if (maskLoadingText) maskLoadingText.textContent = `Analyserar text (${chunk}/${total})…`;
    if (maskProgressBar) maskProgressBar.style.width = `${pct}%`;
  });

  function getActiveMatches() {
    return allMatches
      .filter((m) => !ignoredStarts.has(m.start))
      .sort((a, b) => a.start - b.start);
  }

  function updateStorageIndicator() {
    if (storageStatusEl) {
      storageStatusEl.textContent = savedOnDisk
        ? "Sparad i sessionsmappen"
        : "Endast i arbetsminnet";
    }
    btnClearMaskKey?.classList.toggle("hidden", !savedOnDisk);
  }

  function hideBulkBar() {
    bulkBar?.classList.add("hidden");
    pendingBulkAction = null;
  }

  function showBulkBar(messageText, buttonLabel, onApply) {
    if (!bulkBar || !bulkText || !btnBulkApply) return;
    bulkText.textContent = messageText;
    btnBulkApply.textContent = buttonLabel;
    pendingBulkAction = onApply;
    bulkBar.classList.remove("hidden");
  }

  btnBulkApply?.addEventListener("click", () => {
    const fn = pendingBulkAction;
    hideBulkBar();
    if (fn) fn();
  });
  btnBulkClose?.addEventListener("click", hideBulkBar);

  btnRestoreIgnored?.addEventListener("click", () => {
    if (ignoredStarts.size === 0) return;
    ignoredStarts.clear();
    hideBulkBar();
    recomputeAndRender();
    announce("Alla undantagna markeringar återställdes.");
  });

  function syncSensitivityButtons() {
    btnSensHigh?.setAttribute("aria-pressed", String(sensitivity === "high"));
    btnSensNormal?.setAttribute("aria-pressed", String(sensitivity === "normal"));
    btnSensLow?.setAttribute("aria-pressed", String(sensitivity === "low"));
  }
  syncSensitivityButtons();

  function selectSensitivity(next) {
    if (sensitivity === next || !SENSITIVITY_LEVELS[next]) return;
    sensitivity = next;
    localStorage.setItem("maskSensitivity", sensitivity);
    syncSensitivityButtons();
    if (sourceText.trim()) {
      analyzeCurrentTranscript();
    }
  }
  btnSensHigh?.addEventListener("click", () => selectSensitivity("high"));
  btnSensNormal?.addEventListener("click", () => selectSensitivity("normal"));
  btnSensLow?.addEventListener("click", () => selectSensitivity("low"));

  btnMaskOpenText?.addEventListener("click", () => { if (onOpenTextFile) onOpenTextFile(); });
  btnMaskEmptyOpenText?.addEventListener("click", () => { if (onOpenTextFile) onOpenTextFile(); });

  document.getElementById("btn-mask-empty-paste")?.addEventListener("click", async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip && clip.trim() && onPasteTextForMasking) {
        await onPasteTextForMasking(clip);
      }
    } catch (e) {
      await showMessage("Tryck Ctrl+V (eller Cmd+V på Mac) för att klistra in text från urklipp.", { title: "Klistra in" });
    }
  });

  // Stöd för Ctrl+V / Cmd+V direkt i Steg 2 (Maskera) när fokus inte ligger i ett skrivfält
  document.addEventListener("paste", (e) => {
    if (!panelMask || panelMask.classList.contains("hidden")) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
    const pasted = e.clipboardData?.getData("text/plain");
    if (pasted && pasted.trim() && onPasteTextForMasking) {
      e.preventDefault();
      void onPasteTextForMasking(pasted);
    }
  });

  function schedulePersistMasking() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistMaskingToSession();
    }, 400);
  }

  async function persistMaskingToSession() {
    if (!getPersistEnabled || !getPersistEnabled() || !sourceText.trim()) {
      savedOnDisk = false;
      updateStorageIndicator();
      return;
    }
    try {
      const dir = (getSessionDir && getSessionDir()) || (ensureSessionDir && await ensureSessionDir("text"));
      if (!dir) return;
      const payload = JSON.stringify({
        version: 1,
        preset,
        sensitivity,
        sourceText,
        matches: allMatches,
        ignoredStarts: [...ignoredStarts],
      });
      await invoke("save_session_masking", {
        sessionDir: dir,
        maskingJson: payload,
        maskedText,
      });
      savedOnDisk = true;
      updateStorageIndicator();
    } catch (e) {
      console.warn("Kunde inte spara maskeringsnyckel i sessionsmappen:", e);
    }
  }

  btnClearMaskKey?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const dir = getSessionDir && getSessionDir();
    if (!dir) return;
    try {
      await invoke("clear_session_masking", { sessionDir: dir });
      savedOnDisk = false;
      updateStorageIndicator();
      announce("Sparad maskeringsnyckel borttagen från sessionsmappen.");
    } catch (err) {
      await showMessage(`Kunde inte rensa nyckeln: ${err}`, { title: "Fel", kind: "error" });
    }
  });

  function recomputeAndRender(opts = { persist: true }) {
    const active = getActiveMatches();
    activeTable = buildTranslationTable(active);
    maskedText = buildMaskedText(sourceText, active, activeTable);

    // Update badges
    if (tabMaskBadge) {
      tabMaskBadge.textContent = String(active.length);
      tabMaskBadge.classList.toggle("hidden", !sourceText || allMatches.length === 0);
    }
    if (tabUnmaskBadge) {
      tabUnmaskBadge.textContent = String(activeTable.size);
      tabUnmaskBadge.classList.toggle("hidden", activeTable.size === 0);
    }

    const hasText = Boolean(sourceText && sourceText.trim());
    if (btnCopyMasked) btnCopyMasked.disabled = !hasText;
    if (btnSaveMasked) btnSaveMasked.disabled = !hasText;
    if (btnGotoUnmask) btnGotoUnmask.disabled = !hasText;

    if (!hasText) {
      emptyState?.classList.remove("hidden");
      reviewEl?.classList.add("hidden");
      maskOutputEl?.classList.add("hidden");
      summaryBar?.classList.add("hidden");
      tableDetails?.classList.add("hidden");
      savedOnDisk = false;
      updateStorageIndicator();
      updateUnmaskView();
      return;
    }

    emptyState?.classList.add("hidden");
    summaryBar?.classList.remove("hidden");

    // Category summary pills
    if (summaryText) {
      summaryText.textContent =
        active.length === 0
          ? "Inga känsliga uppgifter maskerade"
          : `${active.length} uppgift${active.length === 1 ? "" : "er"} maskerade (${activeTable.size} unika)`;
    }
    if (categoryPills) {
      const counts = new Map();
      for (const m of active) counts.set(m.label, (counts.get(m.label) || 0) + 1);
      categoryPills.replaceChildren();
      for (const [label, count] of counts.entries()) {
        const pill = document.createElement("span");
        pill.className = "cat-pill";
        pill.style.backgroundColor = COLORS[label] || "#475569";
        pill.textContent = `${label}: ${count}`;
        categoryPills.appendChild(pill);
      }
    }

    if (btnRestoreIgnored) {
      const ignCount = ignoredStarts.size;
      btnRestoreIgnored.textContent = `Återställ undantagna (${ignCount})`;
      btnRestoreIgnored.classList.toggle("hidden", ignCount === 0);
    }

    // Masked text preview (uppdateras bara när vyn faktiskt är synlig — sparar DOM-arbete)
    if (maskOutputEl && viewMode === "masked") {
      maskOutputEl.value = maskedText;
    }

    // Interactive review view
    renderReview(active);

    // Translation table
    if (tableDetails && tableBody && tableCount) {
      tableDetails.classList.toggle("hidden", activeTable.size === 0);
      tableCount.textContent = String(activeTable.size);
      tableBody.replaceChildren();
      const frag = document.createDocumentFragment();
      for (const entry of activeTable.values()) {
        const tr = document.createElement("tr");
        const tdMask = document.createElement("td");
        tdMask.className = "font-mono font-semibold";
        tdMask.textContent = `[${entry.maskedLabel.toUpperCase()}]`;
        const tdOrig = document.createElement("td");
        tdOrig.textContent = entry.originalText;
        const tdCat = document.createElement("td");
        const catSpan = document.createElement("span");
        catSpan.className = "cat-pill";
        catSpan.style.backgroundColor = COLORS[entry.label] || "#475569";
        catSpan.textContent = entry.label;
        tdCat.appendChild(catSpan);
        const tdCount = document.createElement("td");
        tdCount.className = "font-mono";
        tdCount.textContent = String(entry.count);

        const tdAction = document.createElement("td");
        tdAction.className = "text-right";
        const btnExcl = document.createElement("button");
        btnExcl.type = "button";
        btnExcl.className = "btn btn-ghost btn-sm text-xs btn-danger";
        btnExcl.textContent = entry.count > 1 ? `Undanta alla (${entry.count})` : "Undanta";
        btnExcl.title = `Undanta alla förekomster av "${entry.originalText}" från maskeringen`;
        btnExcl.addEventListener("click", () => {
          const targetLower = entry.originalText.toLowerCase();
          let changed = 0;
          for (const m of allMatches) {
            if (m.text.toLowerCase() === targetLower && !ignoredStarts.has(m.start)) {
              ignoredStarts.add(m.start);
              changed += 1;
            }
          }
          hideBulkBar();
          if (changed > 0) {
            recomputeAndRender();
            announce(`Undantog alla ${changed} förekomster av "${entry.originalText}".`);
          }
        });
        tdAction.appendChild(btnExcl);

        tr.append(tdMask, tdOrig, tdCat, tdCount, tdAction);
        frag.appendChild(tr);
      }
      tableBody.appendChild(frag);
    }

    applyViewMode();
    updateStorageIndicator();
    updateUnmaskView();
    if (selectedPromptId !== "custom" && tempEditedPrompt === null) {
      syncPromptUI();
    }

    if (opts && opts.persist) {
      schedulePersistMasking();
    }
  }

  function renderReview(activeMatches) {
    if (!reviewEl) return;
    reviewEl.replaceChildren();

    const posToLabel = new Map();
    for (const entry of activeTable.values()) {
      for (const pos of entry.positions) {
        posToLabel.set(pos.start, entry.maskedLabel);
      }
    }

    const sorted = [...allMatches].sort((a, b) => a.start - b.start);
    const frag = document.createDocumentFragment();
    let cursor = 0;

    for (const m of sorted) {
      if (m.start < cursor) continue; // skip overlap
      if (m.start > cursor) {
        frag.appendChild(document.createTextNode(sourceText.slice(cursor, m.start)));
      }
      const ignored = ignoredStarts.has(m.start);
      const chip = document.createElement("span");
      chip.className = ignored ? "mask-chip mask-chip-ignored" : "mask-chip";
      chip.tabIndex = 0;
      chip.setAttribute("role", "button");
      chip.dataset.start = String(m.start);
      if (!ignored) {
        chip.style.backgroundColor = COLORS[m.label] || "#475569";
      }
      const placeholder = posToLabel.get(m.start);
      chip.title = ignored
        ? `${m.label} (undantagen) — klicka för att maskera igen`
        : `${m.label} → [${(placeholder || m.label).toUpperCase()}] — klicka för att undanta`;

      chip.appendChild(document.createTextNode(sourceText.slice(m.start, m.end)));
      if (!ignored && placeholder) {
        const tag = document.createElement("span");
        tag.className = "mask-chip-tag";
        tag.textContent = `[${placeholder.toUpperCase()}]`;
        chip.appendChild(tag);
      }

      const toggle = () => {
        const wasIgnored = ignoredStarts.has(m.start);
        if (wasIgnored) ignoredStarts.delete(m.start);
        else ignoredStarts.add(m.start);

        const targetLower = m.text.toLowerCase();
        const siblings = allMatches.filter(
          (other) =>
            other.start !== m.start &&
            other.text.toLowerCase() === targetLower &&
            ignoredStarts.has(other.start) === wasIgnored
        );

        recomputeAndRender();

        if (siblings.length > 0) {
          const total = siblings.length + 1;
          if (!wasIgnored) {
            showBulkBar(
              `"${m.text}" undantogs. Det finns ${siblings.length} förekomst${siblings.length === 1 ? "" : "er"} till i texten.`,
              `Undanta alla (${total})`,
              () => {
                for (const s of siblings) ignoredStarts.add(s.start);
                recomputeAndRender();
                announce(`Undantog alla ${total} förekomster av "${m.text}".`);
              }
            );
          } else {
            showBulkBar(
              `"${m.text}" maskeras igen. Det finns ${siblings.length} undantagna förekomst${siblings.length === 1 ? "" : "er"} till.`,
              `Maskera alla (${total})`,
              () => {
                for (const s of siblings) ignoredStarts.delete(s.start);
                recomputeAndRender();
                announce(`Maskerar alla ${total} förekomster av "${m.text}".`);
              }
            );
          }
        } else {
          hideBulkBar();
        }
      };
      chip.addEventListener("click", toggle);
      chip.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });

      frag.appendChild(chip);
      cursor = m.end;
    }

    if (cursor < sourceText.length) {
      frag.appendChild(document.createTextNode(sourceText.slice(cursor)));
    }
    reviewEl.appendChild(frag);
  }

  function applyViewMode() {
    if (!sourceText || !sourceText.trim()) return;
    if (viewMode === "review") {
      reviewEl?.classList.remove("hidden");
      maskOutputEl?.classList.add("hidden");
    } else {
      if (maskOutputEl && maskOutputEl.value !== maskedText) {
        maskOutputEl.value = maskedText;
      }
      reviewEl?.classList.add("hidden");
      maskOutputEl?.classList.remove("hidden");
    }
    btnViewReview?.setAttribute("aria-pressed", String(viewMode === "review"));
    btnViewMasked?.setAttribute("aria-pressed", String(viewMode === "masked"));
  }

  let lastUnmaskedRaw = "";

  function updateUnmaskView() {
    if (unmaskTableStatus) {
      if (activeTable.size === 0) {
        unmaskTableStatus.textContent =
          "Ingen aktiv översättningstabell än — analysera och maskera text i steg 2 först.";
      } else {
        unmaskTableStatus.textContent = `Aktiv översättningstabell: ${activeTable.size} unika platshållare redo för lokal avmaskering.`;
      }
    }

    const inputVal = unmaskInput ? unmaskInput.value : "";
    const res = unmaskText(inputVal, activeTable);
    lastUnmaskedRaw = res.text;
    if (unmaskOutput) {
      renderMarkdownToElement(unmaskOutput, res.text);
    }
    const hasOut = Boolean(res.text.trim());
    if (btnCopyUnmasked) btnCopyUnmasked.disabled = !hasOut;
    if (btnSaveUnmasked) btnSaveUnmasked.disabled = !hasOut;
    if (unmaskCountBadge) {
      unmaskCountBadge.textContent = `${res.replacements} återställd${res.replacements === 1 ? "" : "a"}`;
      unmaskCountBadge.classList.toggle("hidden", !inputVal.trim());
    }
  }

  // Run Layer 1 + Layer 2 masking analysis
  async function analyzeCurrentTranscript() {
    if (isAnalyzing) return;
    const raw = (getTranscriptText() || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!raw.trim()) {
      sourceText = "";
      allMatches = [];
      ignoredStarts.clear();
      if (emptyMsg) {
        emptyMsg.innerHTML =
          "Det finns ingen text att maskera än. Spela in eller skriv text i <strong>steg 1</strong> först.";
      }
      recomputeAndRender();
      return;
    }

    isAnalyzing = true;
    sourceText = raw;
    ignoredStarts.clear();
    maskOverlay?.classList.remove("hidden");
    if (maskProgressBar) maskProgressBar.style.width = "10%";
    if (maskLoadingText) maskLoadingText.textContent = "Förbereder svensk maskeringsmodell…";

    try {
      const status = await invoke("ensure_ner_model");
      if (footerNer && status?.loaded) footerNer.textContent = "Svensk BERT NER (redo)";
      if (refreshModels) refreshModels();

      if (maskLoadingText) maskLoadingText.textContent = "Analyserar text (Lager 1 + Lager 2)…";
      if (maskProgressBar) maskProgressBar.style.width = "35%";

      const entities = PRESETS[preset].entities;
      const threshold = SENSITIVITY_LEVELS[sensitivity]?.threshold ?? 0.6;
      const rawMatches = await invoke("analyze_text", {
        text: sourceText,
        entities,
        threshold,
      });

      allMatches = fixByteOffsets(sourceText, rawMatches);
      if (maskProgressBar) maskProgressBar.style.width = "100%";
      recomputeAndRender();
      announce(
        `Maskering klar. ${allMatches.length} uppgifter hittades med profilen ${PRESETS[preset].name}.`
      );
    } catch (err) {
      const msg = typeof err === "string" ? err : err?.message || String(err);
      await showMessage(`Maskeringen misslyckades: ${msg}`, { title: "Fel", kind: "error" });
    } finally {
      isAnalyzing = false;
      maskOverlay?.classList.add("hidden");
    }
  }

  // Manual masking of selected text in reviewEl
  function getSelectedTextInReview() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !reviewEl || !reviewEl.contains(sel.anchorNode)) return "";
    return sel.toString().trim();
  }

  document.addEventListener("selectionchange", () => {
    if (!btnManualMask || !panelMask || panelMask.classList.contains("hidden") || viewMode !== "review") return;
    const selected = getSelectedTextInReview();
    btnManualMask.classList.toggle("hidden", selected.length < 2);
  });

  btnManualMask?.addEventListener("click", () => {
    const selected = getSelectedTextInReview();
    if (!selected || selected.length < 2) return;
    // Mask all exact occurrences of the selected phrase in sourceText
    let idx = 0;
    let added = 0;
    while ((idx = sourceText.indexOf(selected, idx)) !== -1) {
      const end = idx + selected.length;
      const overlaps = allMatches.some((m) => m.start < end && m.end > idx);
      if (!overlaps) {
        allMatches.push({
          text: selected,
          label: "Manuell",
          start: idx,
          end,
          source: "manuell",
        });
        added += 1;
      }
      idx = end;
    }
    window.getSelection()?.removeAllRanges();
    btnManualMask.classList.add("hidden");
    if (added > 0) {
      recomputeAndRender();
      announce(`Maskerade "${selected}" (${added} förekomst${added === 1 ? "" : "er"}).`);
    }
  });

  // Preset toggle buttons
  function selectPreset(next) {
    if (preset === next) return;
    preset = next;
    btnAiSafe?.setAttribute("aria-pressed", String(preset === "ai_safe"));
    btnStrict?.setAttribute("aria-pressed", String(preset === "strict"));
    if (sourceText.trim()) {
      analyzeCurrentTranscript();
    }
  }

  btnAiSafe?.addEventListener("click", () => selectPreset("ai_safe"));
  btnStrict?.addEventListener("click", () => selectPreset("strict"));
  btnRunMask?.addEventListener("click", () => analyzeCurrentTranscript());

  btnViewReview?.addEventListener("click", () => {
    viewMode = "review";
    applyViewMode();
  });
  btnViewMasked?.addEventListener("click", () => {
    viewMode = "masked";
    applyViewMode();
  });

  btnCopyMasked?.addEventListener("click", async () => {
    if (!maskedText) return;
    try {
      const override =
        selectedPromptId === "custom"
          ? savedCustomPrompt
          : tempEditedPrompt;
      const payload = buildClipboardPayload(maskedText, activeTable, selectedPromptId, override);
      await copyText(payload);
      const prev = btnCopyMasked.innerHTML;
      const label = selectedPromptId === "none" ? "Kopierad!" : "Kopierad med prompt!";
      btnCopyMasked.innerHTML = `<span class="material-symbols-outlined">check</span><span>${label}</span>`;
      announce(
        selectedPromptId === "none"
          ? "Maskerad text är kopierad till urklipp."
          : `Maskerad text med AI-prompt (${PROMPT_TEMPLATES[selectedPromptId]?.name || ""}) är kopierad till urklipp.`
      );
      setTimeout(() => {
        btnCopyMasked.innerHTML = prev;
      }, 2200);
    } catch (e) {
      await showMessage(`Kunde inte kopiera: ${e}`, { title: "Fel", kind: "error" });
    }
  });

  btnSaveMasked?.addEventListener("click", async () => {
    if (!maskedText.trim()) return;
    try {
      await invoke("save_text_file", {
        content: maskedText,
        defaultName: "transkribering_maskerad.txt",
      });
    } catch (err) {
      const msg = typeof err === "string" ? err : err?.message || String(err);
      if (!msg.includes("cancelled") && !msg.includes("canceled")) {
        await showMessage(`Kunde inte spara: ${msg}`, { title: "Fel", kind: "error" });
      }
    }
  });

  btnGotoUnmask?.addEventListener("click", () => {
    switchStep("unmask");
    unmaskInput?.focus();
  });

  // Step 3 handlers (debouncad input så långa AI-svar aldrig mikrolaggar vid skrivning)
  unmaskInput?.addEventListener("input", () => {
    clearTimeout(unmaskDebounceTimer);
    unmaskDebounceTimer = setTimeout(updateUnmaskView, 100);
  });

  btnUnmaskPaste?.addEventListener("click", async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip && unmaskInput) {
        unmaskInput.value = clip;
        updateUnmaskView();
      }
    } catch (_) {
      unmaskInput?.focus();
    }
  });

  btnUnmaskClear?.addEventListener("click", () => {
    if (unmaskInput) unmaskInput.value = "";
    updateUnmaskView();
  });

  btnCopyUnmasked?.addEventListener("click", async () => {
    if (!lastUnmaskedRaw || !lastUnmaskedRaw.trim()) return;
    const html = markdownToCleanHtml(lastUnmaskedRaw);
    const plain = markdownToCleanPlainText(lastUnmaskedRaw);
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          }),
        ]);
      } else {
        await copyText(plain);
      }
      const prev = btnCopyUnmasked.innerHTML;
      btnCopyUnmasked.innerHTML = `<span class="material-symbols-outlined">check</span><span>Kopierad!</span>`;
      announce("Formaterat avmaskerat svar är kopierat till urklipp.");
      setTimeout(() => {
        btnCopyUnmasked.innerHTML = prev;
      }, 2000);
    } catch (_) {
      try {
        await copyText(plain);
        const prev = btnCopyUnmasked.innerHTML;
        btnCopyUnmasked.innerHTML = `<span class="material-symbols-outlined">check</span><span>Kopierad!</span>`;
        setTimeout(() => { btnCopyUnmasked.innerHTML = prev; }, 2000);
      } catch (e) {
        await showMessage(`Kunde inte kopiera: ${e}`, { title: "Fel", kind: "error" });
      }
    }
  });

  btnSaveUnmasked?.addEventListener("click", async () => {
    if (!lastUnmaskedRaw || !lastUnmaskedRaw.trim()) return;
    const cleanPlain = markdownToCleanPlainText(lastUnmaskedRaw);
    try {
      await invoke("save_text_file", {
        content: cleanPlain,
        defaultName: "ai_svar_avmaskerat.txt",
      });
    } catch (err) {
      const msg = typeof err === "string" ? err : err?.message || String(err);
      if (!msg.includes("cancelled") && !msg.includes("canceled")) {
        await showMessage(`Kunde inte spara: ${msg}`, { title: "Fel", kind: "error" });
      }
    }
  });

  // Check initial NER model status for footer
  invoke("check_ner_model_status")
    .then((st) => {
      if (footerNer) {
        footerNer.textContent = st?.installed
          ? "Svensk BERT NER (nedladdad)"
          : "Svensk BERT NER (hämtas vid användning)";
      }
    })
    .catch(() => {});

  return {
    onEnterMaskStep() {
      const current = (getTranscriptText() || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (current.trim() && current !== sourceText) {
        analyzeCurrentTranscript();
      } else if (!current.trim()) {
        sourceText = "";
        allMatches = [];
        ignoredStarts.clear();
        recomputeAndRender({ persist: false });
      }
    },
    onEnterUnmaskStep() {
      updateUnmaskView();
    },
    loadMaskingState(maskingJson) {
      if (!maskingJson) {
        sourceText = "";
        allMatches = [];
        ignoredStarts.clear();
        savedOnDisk = false;
        recomputeAndRender({ persist: false });
        return false;
      }
      try {
        const parsed = JSON.parse(maskingJson);
        preset = parsed.preset === "strict" ? "strict" : "ai_safe";
        btnAiSafe?.setAttribute("aria-pressed", String(preset === "ai_safe"));
        btnStrict?.setAttribute("aria-pressed", String(preset === "strict"));
        sourceText = typeof parsed.sourceText === "string" ? parsed.sourceText : "";
        allMatches = Array.isArray(parsed.matches) ? parsed.matches : [];
        ignoredStarts = new Set(Array.isArray(parsed.ignoredStarts) ? parsed.ignoredStarts : []);
        savedOnDisk = true;
        recomputeAndRender({ persist: false });
        return true;
      } catch (e) {
        console.warn("Kunde inte läsa sparad maskering:", e);
        return false;
      }
    },
    resetMaskState() {
      sourceText = "";
      allMatches = [];
      ignoredStarts.clear();
      savedOnDisk = false;
      if (unmaskInput) unmaskInput.value = "";
      recomputeAndRender({ persist: false });
    },
  };
}
