# Transkerat

**100 % lokalt · 100 % svenska**

**Transkerat** är en skrivbordsapp för Windows och macOS som kombinerar lokal svensk transkribering (**Pianissimo**) med lokal integritetsmaskering och avmaskering (**Maskera Lager 1 & 2**).

All taligenkänning, namn- och rollmaskering samt återställning av AI-svar sker helt lokalt på din egen dator — inget ljud och inga personuppgifter skickas någonsin vidare.

> **Nedladdning:** Hämta färdigbyggd version för Windows (portabel `.exe` eller installerare) och macOS (Apple Silicon `.dmg`) under **[Releases](https://github.com/mrswedish/transkerat/releases/latest)**.

---

## Så fungerar det — tre steg från möte till färdig sammanfattning

### 1. Transkribering (Pianissimo · svenska)
Spela in möten direkt i appen (på Windows) eller öppna en ljud- eller videofil (MP3, M4A, WAV, MP4 m.fl.).

- **Endast svenska Pianissimo (`transcribe.cpp` / GGUF)** — GPU-accelererad via **Vulkan** på Windows (AMD, NVIDIA och Intel) och **Metal** på macOS (Apple Silicon), med automatisk kraschvakt och CPU-fallback.
- **Snabb lokal prestanda** — ett 90 minuter långt inspelat möte transkriberas på cirka **6 minuter** (~15× realtid) på en vanlig bärbar PC med 16 GB RAM.
- **Talaridentifiering (valfritt)** — skiljer automatiskt på olika röster som **Talare 1**, **Talare 2** osv. (du kan även klicka på en talaretikett för att själv döpa om den vid behov).
- **Personliga ordlistor** — rättar automatiskt facktermer och interna begrepp som ofta hörs fel (t.ex. `kund portalen => Kundportalen`).
- **Synkad ljudspelare** — klicka på valfri tidsstämpel för att lyssna och korrigera texten direkt.

![Steg 1: Transkribering i Transkerat](docs/screenshots/01-transkribering.png)

---

## Skillnad mellan Windows (PC) och macOS

| Funktion | Windows (PC) | macOS (Apple Silicon) |
|---|---|---|
| **Spela in digitala möten (systemljud + mikrofon)** — t.ex. Teams, Pexip, Zoom, Google Meet | ✅ Ja (WASAPI loopback) | ❌ Nej |
| **Spela in mikrofon direkt i appen** | ✅ Ja | ❌ Nej |
| **Öppna och transkribera ljud-/videofiler** (MP3, M4A, WAV, MP4 m.fl.) | ✅ Ja | ✅ Ja |
| **Talaridentifiering (`Talare 1`, `Talare 2` …) & personliga ordlistor** | ✅ Ja | ✅ Ja |
| **Maskera (AI-säker & Strikt inkl. Roll/Titel) & Avmaskera AI-svar** | ✅ Ja | ✅ Ja |
| **Lokal sessionslagring av transkript & maskeringsnyckel** | ✅ Ja | ✅ Ja |

> På **Windows (PC)** kryssar du bara i **Spela in systemljud** i verktygsraden för att få med både din egen mikrofon och övriga deltagare i digitala möten (Teams, Pexip, Zoom m.fl.). På **macOS** öppnar du i stället en inspelad ljud- eller videofil (eller klistrar in text direkt).

---

### 2. Maskera (Lager 1 + Lager 2)
Klicka på **Maskera text →** för att pseudonymisera transkriptet lokalt innan du klistrar in det i en extern AI-tjänst (t.ex. ChatGPT, Copilot eller Claude).

- **Två färdiga profiler:**
  - **AI-säker** — maskerar personnummer/samordningsnummer, e-post, telefonnummer, org.nummer, konto/giro, kortnummer, hemligheter/nycklar samt personer, organisationer, platser och övrigt.
  - **Strikt (inkl. Roll/Titel)** — maskerar allt i *AI-säker* plus svenska yrkesroller och befattningar (`[ROLL A]`, t.ex. *avdelningschefen*, *projektledaren*), IP-adresser, tider och händelser.
- **Full kontroll i granskningsvyn:**
  - Välj **känslighet** (*Hög 45 %*, *Normal 60 %*, *Låg 80 %*) för namn, organisationer och platser.
  - Klicka på valfri markering för att undanta eller återaktivera den — finns ordet på flera ställen får du direkt valet **Undanta alla**, eller klicka **Undanta alla** på valfri rad i översättningstabellen.
  - Markera valfri text för att lägga till en manuell maskering.
  - Du kan även klistra in text direkt i steg 2 med **Ctrl+V** (eller **Cmd+V** på Mac), eller öppna en befintlig textfil (`.txt`, `.md`, `.json`) via **Öppna → Öppna textfil till Maskera…** / **Öppna text…**.
  - Översättningstabellen visar exakt hur varje `[PLATSHÅLLARE]` mappas till originalet.
- **Inbyggda AI-promptmallar vid kopiering:** När du klickar **Kopiera maskerat** kan du skicka med en färdig instruktion till AI:n (**Mötesprotokoll** som standard, **Kort sammanfattning**, **Åtgärdslista**, **Endast platshållarregel**, **Egen prompt** eller **Ingen prompt**). Prompten instruerar uttryckligen AI:n att bevara alla `[PERSON A]`, `[ROLL A]`, `[ORGANISATION A]` m.fl. exakt som de står — så att avmaskeringen i steg 3 blir komplett och träffsäker.
- **Kopiera maskerat** med ett klick för att klistra in i din AI-tjänst.

![Steg 2: Maskera i Transkerat](docs/screenshots/02-maskera.png)

---

### 3. Avmaskera AI-svar (100 % lokalt)
När din AI-tjänst har sammanfattat mötet eller skrivit ett utkast klistrar du in svaret (som innehåller `[PERSON A]`, `[ROLL A]`, `[ORGANISATION A]` osv.) i steg 3.

- Alla platshållare återställs **omedelbart och lokalt** via sessionens översättningstabell.
- Kopiera det färdiga, avmaskerade svaret eller spara det som textfil.

![Steg 3: Avmaskera AI-svar i Transkerat](docs/screenshots/03-avmaskera.png)

---

## Integritet & sessionslagring

- **100 % lokal bearbetning:** Efter att de lokala modellerna hämtats en första gång fungerar appen helt offline:
  - **Pianissimo (`Q8_0` GGUF)** (~740 MB) — svensk taligenkänning via `transcribe.cpp` (Vulkan / Metal / CPU)
  - **KBLab Svensk BERT NER** (~127 MB) — svensk namngiven entitetsigenkänning (INT8 ONNX)
  - **Talaridentifiering** (~33 MB, valfri) — pyannote community-1 i ren Rust
- **Krasch- och omstartssäkert arbetsflöde:** Som standard sparas transkribering (`transkribering.json` / `.txt`), maskerad text (`maskerad.txt`) och maskeringsnyckel (`maskering.json`) lokalt i samma sessionsmapp som inspelningen.
  - Du kan stänga appen och avmaskera ett AI-svar senare via **Öppna → Senaste inspelningar**.
  - Importerade ljudfiler får en egen lokal sessionsmapp i `Transkerat-Inspelningar` — appen skriver aldrig nycklar bredvid externa filer i t.ex. *Hämtade filer* eller nätverksmappar.
  - **Allt raderas tillsammans:** När du raderar en inspelning försvinner ljudfil, transkript och nyckel samtidigt. Du kan även klicka **Rensa nyckel** direkt i översättningstabellen, eller slå av lokal sparning under *Inställningar → Inspelningar* för att hålla allt enbart i arbetsminnet.

---

## Utveckling & bygge

### Förutsättningar
- [Node.js](https://nodejs.org/) (v20+)
- [Rust](https://www.rust-lang.org/) (stable)

### Kör lokalt
```bash
npm install
npm run tauri dev
```

### Kör tester
```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

### Bygg produktionspaket
```bash
npx tauri build
```

---

## Byggt på
Transkerat förenar komponenter och modeller från:
- **[transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)** (`ggml`) — lokal taligenkänningsmotor med GPU-acceleration via **Vulkan** (Windows: AMD/NVIDIA/Intel), **Metal** (macOS Apple Silicon) och CPU-fallback
- **Transkribera** (inspelning med WASAPI loopback, talaridentifiering via `speakrs`, ordlistor, kraschvakt)
- **Maskera** (Lager 1 svensk regex- & befattningsmotor, Lager 2 KBLab Svensk BERT NER, översättningstabell & lokal avmaskering)
- **Klang AI / Pianissimo** ([`KlangAI/pianissimo-sv-gguf`](https://huggingface.co/KlangAI/pianissimo-sv-gguf), `Q8_0`) & **KBLab / Kungliga biblioteket** (`bert-base-swedish-cased-ner`)
