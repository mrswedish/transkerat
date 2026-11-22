// Maskering & avmaskering för Transkerat (portat från Maskera: Lager 1 Regex/Roller + Lager 2 Svensk BERT NER)

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

// ── UI-kontroller för Steg 2 (Maskera) & Steg 3 (Avmaskera AI-svar) ──────────

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
}) {
  let preset = "ai_safe"; // "ai_safe" | "strict"
  let viewMode = "review"; // "review" | "masked"
  let sourceText = "";
  let allMatches = []; // [{ text, label, start, end, source }]
  let ignoredStarts = new Set(); // start offsets ignored by user
  let activeTable = new Map();
  let maskedText = "";
  let isAnalyzing = false;
  let savedOnDisk = false;

  // DOM refs
  const btnAiSafe = document.getElementById("btn-preset-ai-safe");
  const btnStrict = document.getElementById("btn-preset-strict");
  const btnRunMask = document.getElementById("btn-run-mask");
  const btnViewReview = document.getElementById("btn-mask-view-review");
  const btnViewMasked = document.getElementById("btn-mask-view-masked");
  const btnManualMask = document.getElementById("btn-manual-mask");
  const btnCopyMasked = document.getElementById("btn-copy-masked");
  const btnSaveMasked = document.getElementById("btn-save-masked");
  const btnGotoUnmask = document.getElementById("btn-goto-unmask");

  const summaryBar = document.getElementById("mask-summary-bar");
  const summaryText = document.getElementById("mask-summary-text");
  const categoryPills = document.getElementById("mask-category-pills");
  const emptyState = document.getElementById("mask-empty-state");
  const emptyMsg = document.getElementById("mask-empty-msg");
  const reviewEl = document.getElementById("mask-review");
  const maskOutputEl = document.getElementById("mask-output");
  const tableDetails = document.getElementById("mask-table-details");
  const tableCount = document.getElementById("mask-table-count");
  const tableBody = document.getElementById("mask-table-body");
  const storageStatusEl = document.getElementById("mask-storage-status");
  const btnClearMaskKey = document.getElementById("btn-clear-mask-key");

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

    // Masked text preview
    if (maskOutputEl) maskOutputEl.value = maskedText;

    // Interactive review view
    renderReview(active);

    // Translation table
    if (tableDetails && tableBody && tableCount) {
      tableDetails.classList.toggle("hidden", activeTable.size === 0);
      tableCount.textContent = String(activeTable.size);
      tableBody.replaceChildren();
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
        tr.append(tdMask, tdOrig, tdCat, tdCount);
        tableBody.appendChild(tr);
      }
    }

    applyViewMode();
    updateStorageIndicator();
    updateUnmaskView();

    if (opts && opts.persist) {
      void persistMaskingToSession();
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
        if (ignoredStarts.has(m.start)) ignoredStarts.delete(m.start);
        else ignoredStarts.add(m.start);
        recomputeAndRender();
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
      reviewEl?.classList.add("hidden");
      maskOutputEl?.classList.remove("hidden");
    }
    btnViewReview?.setAttribute("aria-pressed", String(viewMode === "review"));
    btnViewMasked?.setAttribute("aria-pressed", String(viewMode === "masked"));
  }

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
    if (unmaskOutput) unmaskOutput.value = res.text;
    if (btnCopyUnmasked) btnCopyUnmasked.disabled = !res.text.trim();
    if (btnSaveUnmasked) btnSaveUnmasked.disabled = !res.text.trim();
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
      const rawMatches = await invoke("analyze_text", {
        text: sourceText,
        entities,
        threshold: 0.6,
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
    if (!btnManualMask) return;
    const selected = getSelectedTextInReview();
    btnManualMask.classList.toggle("hidden", selected.length < 2 || viewMode !== "review");
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
      await copyText(maskedText);
      const prev = btnCopyMasked.innerHTML;
      btnCopyMasked.innerHTML = `<span class="material-symbols-outlined">check</span><span>Kopierad!</span>`;
      announce("Maskerad text är kopierad till urklipp.");
      setTimeout(() => {
        btnCopyMasked.innerHTML = prev;
      }, 2000);
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

  // Step 3 handlers
  unmaskInput?.addEventListener("input", updateUnmaskView);

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
    const txt = unmaskOutput ? unmaskOutput.value : "";
    if (!txt) return;
    try {
      await copyText(txt);
      const prev = btnCopyUnmasked.innerHTML;
      btnCopyUnmasked.innerHTML = `<span class="material-symbols-outlined">check</span><span>Kopierad!</span>`;
      announce("Avmaskerat svar är kopierat till urklipp.");
      setTimeout(() => {
        btnCopyUnmasked.innerHTML = prev;
      }, 2000);
    } catch (e) {
      await showMessage(`Kunde inte kopiera: ${e}`, { title: "Fel", kind: "error" });
    }
  });

  btnSaveUnmasked?.addEventListener("click", async () => {
    const txt = unmaskOutput ? unmaskOutput.value : "";
    if (!txt.trim()) return;
    try {
      await invoke("save_text_file", {
        content: txt,
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
