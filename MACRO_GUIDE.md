# Guida al Super Indice Macroeconomico

Questo documento spiega la logica matematica e funzionale dietro il tab "Macro" di EasyPortfolio.

## 1. Obiettivo
L'obiettivo è sintetizzare diversi indicatori economici eterogenei (tassi in %, disoccupazione in %, sentiment in punti, ecc.) in un unico **punteggio di "Salute Economica" (0-100)**.

## 2. Logica di Calcolo

Il calcolo avviene in tre fasi: **Normalizzazione**, **Inversione** (se necessaria) e **Ponderazione**.

### A. Normalizzazione (Posizionamento nel Range)
Ogni indicatore ha un valore attuale, un minimo storico e un massimo storico configurabili.
Per prima cosa calcoliamo dove si posiziona il valore attuale rispetto al suo storico (scala 0-1).

$$ Posizione = \frac{Valore Attuale - Minimo}{Massimo - Minimo} $$

- **0.0**: Il valore è sul minimo storico.
- **1.0**: Il valore è sul massimo storico.

### B. Inversione (Score di Crisi)
Non sempre un valore "Alto" è negativo. Dobbiamo convertire la "Posizione" in uno **"Score di Crisi"**, dove **1.0 significa sempre CRISI**.

Ci sono due configurazioni possibili per ogni indicatore:

1.  **Alto = Crisi** (es. Disoccupazione, VIX, Tassi)
    *   Se il valore sale, la crisi aumenta.
    *   $$ Score = Posizione $$
2.  **Basso = Crisi** (es. Sentiment Consumatori, Spread, GDP)
    *   Se il valore scende, la crisi aumenta.
    *   $$ Score = 1 - Posizione $$

#### Esempio: Sentiment Consumatori
*   **Min**: 50
*   **Max**: 114
*   **Attuale**: 53.6
*   **Config**: "Basso = Crisi"

$$ Posizione = \frac{53.6 - 50}{114 - 50} \approx 0.06 \, (6\%) $$

Poiché "Basso è Crisi" e siamo molto bassi (6%), il rischio è alto:
$$ Score = 1 - 0.06 = 0.94 \, (Alta \, Crisi) $$

### C. Ponderazione (Super Indice)
Lo Score di ogni indicatore viene moltiplicato per il suo **Peso %**. La somma di tutti gli indicatori pesati dà il **Super Indice di Crisi (0-1)**.

## 3. Il Gauge (Grafico)
Il grafico a semicerchio ha una scala opposta allo "Score di Crisi":
- **0 - 40**: CRISI (Rosso)
- **40 - 60**: NEUTRO (Giallo)
- **60 - 100**: EUFORIA/ESPANSIONE (Verde)

Per convertire il nostro Super Indice (dove 1 è male) nel formato del Gauge (dove 100 è bene):

$$ Gauge = (1 - SuperIndice) \times 100 $$

*Esempio: Se il Super Indice è 0.80 (Crisi Profonda), il Gauge segnerà 20 (Zona Rossa).*

## 4. Automazione Dati (Google Sheet)
È possibile aggiornare automaticamente i valori attuali collegando un Google Sheet.

1.  Creare un Google Sheet con una tab chiamata **"Macro"**.
2.  Usare colonne: `ID | Value | Min | Max`.
3.  Incollare l'URL del foglio nelle Impostazioni dell'app.
4.  Premere **"Aggiorna da Sheet"** nella pagina Macro.
