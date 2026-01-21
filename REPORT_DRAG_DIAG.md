# Report Designer Drag/Drop Diagnosis

## Sintomi osservati
- Drag in designer con click sinistro mostra jitter/offset: il cursore non resta allineato al widget.
- In alcuni casi il widget "salta" o si resetta al rilascio dopo scroll/zoom o resize finestra.

## Mappa del sistema (file chiave)
- `pages/Report.tsx`: rendering pagine, widget, logica drag/resize con `react-rnd` (WidgetCard).
- `report/reportLayout.ts`: modello layout in mm, clamp/validate, canvas size.
- `report.css`: stile canvas, overlay griglia, widget, handle resize, regole pointer-events.

## Flusso attuale (alto livello)
- Layout in mm -> calcolo canvas (mm) -> widget renderizzati su `pdf-canvas`.
- In designer: ogni widget usa `react-rnd` (position/size in px) con snap + clamp su drag/resize stop.
- In viewer/print: widget resi in mm con wrapper assoluto.

## Diagnosi tecnica
### Criticita individuata
1) **Conversione mm -> px fissa (96 DPI)**
   - File: `pages/Report.tsx`.
   - Regola: conversione mm/px con costante fissa, senza misurare il canvas reale.
   - Impatto: se il canvas e' scalato (zoom browser, CSS transform, device scaling), la conversione non combacia con la dimensione reale del canvas e crea offset/jitter.

2) **Scale non passata a react-rnd quando il canvas e' scalato**
   - File: `pages/Report.tsx`.
   - Impatto: `react-rnd` calcola i delta in coordinate non scalate, mentre il DOM e' scalato => spostamento apparentemente errato.

3) **Selector cancel troppo stretto per elementi interattivi**
   - File: `pages/Report.tsx`.
   - Regola: `cancel=".no-drag, button, .widget-remove"`.
   - Impatto: input/textarea/link non erano esplicitamente esclusi dal drag; aggiungere questi selettori preserva l'interazione senza rompere il drag sul resto della card.

### Root cause piu probabile
- Mismatch tra dimensione reale del canvas (px) e conversione mm->px fissa, combinato con assenza di `scale` su `react-rnd`. Questo introduce offset/jitter in drag/resize quando il canvas e' scalato.

## Fix applicato (minimo e robusto)
- Misura live `pxPerMm` dal canvas attivo via `getBoundingClientRect`/`clientWidth` e usa conversioni basate su valore reale.
- Calcola `scale` effettivo del canvas e lo passa a `react-rnd`.
- Esteso `cancel` con `input, textarea, select, a` per non interferire con interazioni interne.

## Rischi / edge case + mitigazioni
- **Grafici/aree non interattive**: restano drag-abilitati grazie a `pointer-events: none` sui wrapper charts.
- **Input/textarea/link**: esclusi dal drag con `cancel` per preservare il click/focus.
- **Print**: invariato, regole `@media print` non modificate.

## Checklist QA manuale
1) Apri `/report`, attiva modalita designer, trascina 3 widget diversi con click sinistro: devono muoversi fluidamente.
2) Prova a cliccare/attivare input/textarea/link (se presenti): devono restare usabili e non trascinare.
3) Ridimensiona un widget da handle SE e verifica snap + persistenza dopo refresh.
4) Cambia zoom browser (100/110/90) e verifica drag coerente (senza offset).
5) Stampa/PDF: nessun overlay/handle visibile, layout invariato.
