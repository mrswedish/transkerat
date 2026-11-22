# Transkerat

**100 % lokalt · 100 % svenska**

Transkerat kombinerar lokal svensk transkribering (**Pianissimo**) med lokal integritetsmaskering och avmaskering (**Maskera Lager 1 & 2**) i ett sammanhängande trestegsflöde:

1. **Transkribering** — Spela in möten (mikrofon och systemljud på Windows) eller öppna ljud-/videofiler. Transkriberas lokalt på processorn med svenska **Pianissimo**, med valfri talaridentifiering och personliga ordlistor.
2. **Maskera** — Analyserar transkriptet lokalt med **Lager 1** (svenska regex-regler + befattnings-/rollmotor) och **Lager 2** (`KBLab/bert-base-swedish-cased-ner` i INT8 ONNX). Välj mellan profilerna:
   - **AI-säker**: Personnummer, E-post, Telefonnummer, Org.nummer, Konto/Giro, Kortnummer, Hemlighet/Nyckel, Person, Organisation, Plats, Övrigt.
   - **Strikt (inkl. Roll/Titel)**: Allt i AI-säker samt yrkesroller/titlar (`[ROLL A]`), IP-adresser, tider och händelser.
   - Klicka på enskilda markeringar för att undanta dem, markera text för manuell maskering och kopiera maskerad text med ett klick.
3. **Avmaskera AI-svar** — Klistra in svaret från valfri AI-tjänst (med `[PERSON A]`, `[ROLL A]`, `[PERSONNUMMER 1]` osv.) och återställ originalnamn och uppgifter **100 % lokalt** via sessionens översättningstabell i arbetsminnet.

## Utveckling

```bash
npm install
npm run tauri dev
```

## Tester

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
