# EasyPortfolio v1.4.0 - Dark Fintech Update

## 🎨 Nuovo Design System "Dark Fintech"
L'intera applicazione è stata ridisegnata con un tema scuro moderno e professionale.
- **Palette Colori**: Sfondo `#020617` (Deep Navy), Accenti `#0052a3` (Primary Blue) e `#f97316` (Orange).
- **Componenti UI**: Nuove card con effetti "glow", gradienti sottili e ombreggiature deep.
- **Grafici**: I grafici (Recharts) sono stati ottimizzati per il tema scuro con griglie sottili e colori ad alto contrasto.

## 🚀 Nuove Funzionalità

### 1. Gestione Transazioni Avanzata (`Transactions`)
- **Modifica**: Ora puoi modificare qualsiasi transazione passata (prezzo, quantità, data, commissioni) cliccando sull'icona `edit`.
- **Eliminazione**: Possibilità di rimuovere transazioni errate con conferma di sicurezza.
- **Raggruppamento**: La vista è raggruppata per asset, con espansione a fisarmonica per vedere i dettagli storici.

### 2. Ribilanciamento con Heatmap (`Rebalance`)
- **Asset Allocation Visiva**: Nuova visualizzazione a "Barra di Deviazione" (Heatmap) che mostra a colpo d'occhio:
  - 🟥 **Sovrapesato**: Barra rossa a destra.
  - 🟦 **Sottopesato**: Barra blu a sinistra.
  - 🟨 **Neutro**: Pallino centrale.
- **Macro Categorie**: Gli asset sono ora raggruppati per Macro Categoria (Azioni, Obbligazioni, etc.) per una lettura più chiara.
- **Strategie**: Supporto per strategia "Accumulo" (con iniezione liquidità) o "Mantenimento" (sell-to-buy).

### 3. Dashboard Interattiva (`Dashboard`)
- **KPI Cards**: Nuovi indicatori per CAGR, TWRR, Volatilità e Drawdown.
- **Filtri Temporali**: Selettori rapidi (3M, 1Y, YTD, MAX) per analizzare la performance in periodi specifici.
- **Esposizione**: Grafici a barre per esposizione per Asset Class e Valuta.

### 4. Macro Indicator (`Macro`)
- **Gauge Visivo**: Un tachimetro visivo per impostare e leggere il "Sentiment di Mercato" (Crisi vs Euforia), utile per decisioni discrezionali.

## 🛠 Istruzioni per il Test
1. Assicurati di essere nella cartella del progetto.
2. Esegui `npm run dev` nel terminale.
3. Apri il browser all'indirizzo indicato (es. `http://localhost:5173`).
