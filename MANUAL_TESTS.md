# Manual Test Checklist

- Portfolio con prima transazione nel 2022: grafici partono dal 2022, nessun anno precedente a 0.0%.
- Versamenti multipli: MWRR diverge da TWRR (linea e tooltip coerenti).
- Custom range: YTD/1Y/3Y/5Y/MAX + Custom, clamp su firstTransactionDate e lastPriceDate, persistenza per portfolio.
- Distribuzione geografica: "Altri" appare solo se necessario e somma correttamente le micro-voci.
- Edit asset: cambio categoria/asset class aggiorna subito filtri e breakdown senza editare ogni transazione.
- KPI invarianti: stesso range con chart monthly vs daily non cambia vol/sharpe/drawdown/TWRR/MWRR.
- Performance rebased: su 1Y/5Y/MAX parte da 100 e il tooltip mostra indice e rendimento coerenti.
- Label granularita: "Chart: Monthly (KPI: Daily)" su MAX (se downsample), "Chart: Daily (KPI: Daily)" su range brevi.
