# Performance Budget (P2)

Questo documento definisce un budget **soft** per le principali funzioni di calcolo con dataset grandi. I valori sono indicativi (dipendono da hardware/OS/CPU throttle) e servono per evitare regressioni evidenti.

## Dataset sintetici (test)
- **Storico performance**: 50 strumenti, 200 giorni, ~10k punti prezzo, ~51 transazioni
- **Analisi serie prezzi**: 1 strumento, 20k punti prezzo
- **MWRR/TWRR**: 40 strumenti, 160 giorni, ~6.4k punti prezzo

## Budget target (soft)
- `calculateHistoricalPerformance` daily: **< 2500 ms** (10k punti prezzi)
- `calculateHistoricalPerformance` monthly: **< 2500 ms** (10k punti prezzi)
- `analyzePriceSeries`: **< 2500 ms** (20k punti prezzi)
- `computeTWRRFromNav + computeMwrrSeries`: **< 2500 ms** (serie daily 160 giorni)

> Nota: i test usano soglie **tolleranti** e sono progettati per evitare flaky. Se serve, si possono rialzare tramite env var.

## Come eseguire i test
- Tutti i test: `npm test`
- Solo perf: `npx vitest run services/perf.largeDataset.test.ts`

### Override soglie (opzionale)
- `PERF_HISTORY_BUDGET_MS` (default 2500)
- `PERF_SERIES_BUDGET_MS` (default 2500)
- `PERF_RETURNS_BUDGET_MS` (default 2500)

Esempio:
```
PERF_HISTORY_BUDGET_MS=4000 npm test
```

## Interpretazione risultati
- Se un test fallisce per tempo: probabile regressione (query/loop/calc troppo costoso).
- Se fallisce solo su una macchina molto lenta: rialzare la soglia localmente o usare un laptop pi? performante per benchmark.

## Manual perf smoke (suggeriti)
1) Dataset grande: import >50 tickers / 5-10 anni prezzi. Apri Dashboard su range MAX: UI deve rimanere fluida.
2) Data Inspector: tab "Checks/FX/Prezzi" con liste lunghe: scroll e switch tab fluidi.
