// XSS-säker Markdown-renderare (inkl. GFM-tabeller) för Steg 3 (Avmaskera AI-svar).
// Bygger riktiga DOM-noder (ingen osaniterad innerHTML), semantisk HTML för Word/Outlook/Teams-urklipp
// samt ren, markdown-fri klartext.

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  let inner = trimmed;
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells = inner.split("|").map((c) => c.trim());
  return cells.length >= 2 ? cells : null;
}

function isTableSeparator(line) {
  const cells = parseTableRow(line);
  if (!cells) return false;
  return cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseTableAlignments(line) {
  const cells = parseTableRow(line) || [];
  return cells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}

function appendInlineNodes(parent, text) {
  if (!text) return;
  if (!text.includes("**") && !text.includes("`") && !text.includes("*")) {
    parent.appendChild(document.createTextNode(text));
    return;
  }
  const tokenRe = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*(?!\s)[^*\n]+(?<!\s)\*)/g;
  let lastIdx = 0;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    const tok = match[0];
    if (tok.startsWith("**") && tok.endsWith("**")) {
      const el = document.createElement("strong");
      el.textContent = tok.slice(2, -2);
      parent.appendChild(el);
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      const el = document.createElement("code");
      el.className = "md-inline-code";
      el.textContent = tok.slice(1, -1);
      parent.appendChild(el);
    } else if (tok.startsWith("*") && tok.endsWith("*")) {
      const el = document.createElement("em");
      el.textContent = tok.slice(1, -1);
      parent.appendChild(el);
    } else {
      parent.appendChild(document.createTextNode(tok));
    }
    lastIdx = tokenRe.lastIndex;
  }
  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function isBlockStart(lines, idx) {
  const line = lines[idx];
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#") || trimmed.startsWith("```") || trimmed.startsWith(">")) return true;
  if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
  if (idx + 1 < lines.length && parseTableRow(line) && isTableSeparator(lines[idx + 1])) return true;
  return false;
}

/**
 * Renderar Markdown som säkra DOM-noder i `container` (rubriker, tabeller, listor, citat, fetstil/kursiv).
 */
export function renderMarkdownToElement(container, text) {
  container.replaceChildren();
  if (!text || !text.trim()) {
    const ph = document.createElement("p");
    ph.className = "text-sm text-muted";
    ph.textContent =
      "Här visas svaret automatiskt formaterat med alla riktiga namn, roller och uppgifter återställda lokalt.";
    container.appendChild(ph);
    return;
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const frag = document.createDocumentFragment();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    // Kodblock ```
    if (trimmed.startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const pre = document.createElement("pre");
      pre.className = "md-code-block";
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    // GFM-tabell: | A | B | följt av |---|---|
    if (i + 1 < lines.length && parseTableRow(line) && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line);
      const aligns = parseTableAlignments(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const row = parseTableRow(lines[i]);
        if (!row) break;
        bodyRows.push(row);
        i++;
      }

      const wrap = document.createElement("div");
      wrap.className = "md-table-wrap";
      const table = document.createElement("table");
      table.className = "md-table";

      const thead = document.createElement("thead");
      const htr = document.createElement("tr");
      headers.forEach((cell, colIdx) => {
        const th = document.createElement("th");
        if (aligns[colIdx] && aligns[colIdx] !== "left") th.style.textAlign = aligns[colIdx];
        appendInlineNodes(th, cell);
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);

      if (bodyRows.length > 0) {
        const tbody = document.createElement("tbody");
        for (const r of bodyRows) {
          const tr = document.createElement("tr");
          for (let c = 0; c < headers.length; c++) {
            const td = document.createElement("td");
            if (aligns[c] && aligns[c] !== "left") td.style.textAlign = aligns[c];
            appendInlineNodes(td, r[c] || "");
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
      }

      wrap.appendChild(table);
      frag.appendChild(wrap);
      continue;
    }

    // Horisontell linje ---
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      const hr = document.createElement("hr");
      hr.className = "md-hr";
      frag.appendChild(hr);
      i++;
      continue;
    }

    // Rubriker # .. ####
    const hm = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      const tag = lvl === 1 ? "h2" : lvl === 2 ? "h3" : "h4";
      const el = document.createElement(tag);
      el.className = lvl === 1 ? "md-h1" : lvl === 2 ? "md-h2" : "md-h3";
      appendInlineNodes(el, hm[2].trim());
      frag.appendChild(el);
      i++;
      continue;
    }

    // Fristående fetstilt rubrikrad: **RUBRIK**
    if (
      trimmed.startsWith("**") &&
      trimmed.endsWith("**") &&
      trimmed.length > 4 &&
      !trimmed.slice(2, -2).includes("**")
    ) {
      const el = document.createElement("h3");
      el.className = "md-h2";
      el.textContent = trimmed.slice(2, -2);
      frag.appendChild(el);
      i++;
      continue;
    }

    // Punktlista (- / * / •)
    if (/^\s*[-*•]\s+/.test(line)) {
      const ul = document.createElement("ul");
      ul.className = "md-list";
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInlineNodes(li, lines[i].replace(/^\s*[-*•]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      frag.appendChild(ul);
      continue;
    }

    // Numrerad lista (1. / 1))
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const ol = document.createElement("ol");
      ol.className = "md-list md-ordered-list";
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInlineNodes(li, lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        ol.appendChild(li);
        i++;
      }
      frag.appendChild(ol);
      continue;
    }

    // Citatblock (> )
    if (trimmed.startsWith(">")) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        qLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      bq.className = "md-blockquote";
      appendInlineNodes(bq, qLines.join(" "));
      frag.appendChild(bq);
      continue;
    }

    // Vanligt stycke
    const p = document.createElement("p");
    p.className = "md-para";
    let first = true;
    while (i < lines.length && !isBlockStart(lines, i)) {
      if (!first) p.appendChild(document.createElement("br"));
      appendInlineNodes(p, lines[i]);
      first = false;
      i++;
    }
    frag.appendChild(p);
  }

  container.appendChild(frag);
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*(?!\s)([^*\n]+)(?<!\s)\*/g, "<em>$1</em>");
}

/**
 * Konverterar Markdown (inkl. tabeller) till ren semantisk HTML för urklipp (Word, Outlook, Teams).
 */
export function markdownToCleanHtml(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }

    if (trimmed.startsWith("```")) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(escapeHtml(lines[i]));
        i++;
      }
      if (i < lines.length) i++;
      out.push(`<pre><code>${codeLines.join("\n")}</code></pre>`);
      continue;
    }

    if (i + 1 < lines.length && parseTableRow(line) && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line);
      const aligns = parseTableAlignments(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const r = parseTableRow(lines[i]);
        if (!r) break;
        rows.push(r);
        i++;
      }
      const ths = headers
        .map((h, idx) => `<th style="border:1px solid #cbd5e1;padding:6px 10px;text-align:${aligns[idx] || "left"};background:#f1f5f9;">${formatInlineHtml(h)}</th>`)
        .join("");
      const trs = rows
        .map((r) => {
          const tds = headers
            .map((_, idx) => `<td style="border:1px solid #cbd5e1;padding:6px 10px;text-align:${aligns[idx] || "left"};">${formatInlineHtml(r[idx] || "")}</td>`)
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      out.push(`<table style="border-collapse:collapse;margin:8px 0;"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("<hr>");
      i++;
      continue;
    }

    const hm = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hm) {
      const lvl = Math.min(4, hm[1].length + 1);
      out.push(`<h${lvl}>${formatInlineHtml(hm[2].trim())}</h${lvl}>`);
      i++;
      continue;
    }

    if (trimmed.startsWith("**") && trimmed.endsWith("**") && trimmed.length > 4 && !trimmed.slice(2, -2).includes("**")) {
      out.push(`<h3>${escapeHtml(trimmed.slice(2, -2))}</h3>`);
      i++;
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(`<li>${formatInlineHtml(lines[i].replace(/^\s*[-*•]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${formatInlineHtml(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (trimmed.startsWith(">")) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        qLines.push(formatInlineHtml(lines[i].trim().replace(/^>\s?/, "")));
        i++;
      }
      out.push(`<blockquote>${qLines.join(" ")}</blockquote>`);
      continue;
    }

    const pLines = [];
    while (i < lines.length && !isBlockStart(lines, i)) {
      pLines.push(formatInlineHtml(lines[i]));
      i++;
    }
    out.push(`<p>${pLines.join("<br>")}</p>`);
  }

  return out.join("\n");
}

function stripInlineMarkdown(s) {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*(?!\s)([^*\n]+)(?<!\s)\*/g, "$1");
}

/**
 * Konverterar Markdown till ren läsbar text utan `**`, `###` eller `|---|`.
 * Tabeller formateras tabb-separerade så de blir prydliga i klartext och Excel.
 */
export function markdownToCleanPlainText(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (i + 1 < lines.length && parseTableRow(line) && isTableSeparator(lines[i + 1])) {
      const headers = parseTableRow(line).map(stripInlineMarkdown);
      out.push(headers.join("\t"));
      i += 2;
      while (i < lines.length && lines[i].trim() !== "") {
        const r = parseTableRow(lines[i]);
        if (!r) break;
        out.push(r.map(stripInlineMarkdown).join("\t"));
        i++;
      }
      continue;
    }

    if (trimmed.startsWith("```")) {
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("");
      i++;
      continue;
    }

    let l = line;
    l = l.replace(/^\s*#{1,6}\s+/, "");
    l = l.replace(/^\s*[-*]\s+/, "• ");
    l = l.replace(/^\s*>\s?/, "");
    l = stripInlineMarkdown(l);
    out.push(l);
    i++;
  }

  return out.join("\n");
}
