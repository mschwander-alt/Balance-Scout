# pdf.js-Ressourcen (aus `pdfjs-dist@6.4.299`)

Gleiche Version wie das in `unpdf` gebündelte pdf.js. Ohne diese Dateien hängt die Darstellung von PDFs
vom Betriebssystem ab:

- `standard_fonts/` – Ersatzschriften für nicht eingebettete Schriften (z. B. Arial, Courier New in
  Navision-/Abacus-Listen und Bankauszügen). Fehlen sie, zeigt die Vorschau unter Windows leere Kästchen.
- `cmaps/` – Zeichenzuordnungen für CID-Schriften (u. a. asiatische Schriften)
- `wasm/` – Decoder für JBIG2- und JPEG2000-Bilder (häufig in eingescannten Bankauszügen)

Lizenzen: pdf.js Apache-2.0 (`LICENSE_PDFJS`), Schriften Foxit/Liberation (`standard_fonts/LICENSE_*`),
Decoder siehe `wasm/LICENSE_*`. Bei einem Update von `unpdf` die Version von pdf.js prüfen
(`apiVersion` in `node_modules/unpdf/dist/pdfjs.mjs`) und diese Dateien aus derselben Version übernehmen.

Geladen werden die Dateien über `src/ingest/pdfjsAssets.ts` (eigener Lader mit `fs`, auch im Electron-Hilfsprozess).
