
export interface MacroDataPoint {
    id: string; // "1", "2" matching the ID in the config
    value: number;
    min?: number;
    max?: number;
}

// --- TYPES ---
export type MacroIndicatorDirection = "high_is_crisis" | "low_is_crisis";

export interface MacroIndicatorConfig {
    id: string;
    name: string;
    unit?: string;

    currentValue: number;
    minValue: number;
    maxValue: number;

    weight: number;          // 0-100 logic in UI, converted to 0-1 for calculation
    direction: MacroIndicatorDirection;

    sourceType?: "manual" | "api";
    sourceKey?: string;
}

export interface MacroIndicatorComputed extends MacroIndicatorConfig {
    normalized: number; // 0-1 (0 = expansion/euforia, 1 = crisis)
    weighted: number;   // normalized * weight (0-1)
}

// --- DEFAULTS ---
export const DEFAULT_INDICATORS: MacroIndicatorConfig[] = [
    { id: '1', name: 'Tasso Fed Funds', unit: '%', currentValue: 5.33, minValue: 0, maxValue: 10, weight: 15, direction: "high_is_crisis" },
    { id: '2', name: 'Lavoratori Temporanei', unit: 'k', currentValue: 2950, minValue: 2000, maxValue: 3500, weight: 10, direction: "low_is_crisis" },
    { id: '3', name: 'Tasso Disoccupazione', unit: '%', currentValue: 3.7, minValue: 3.4, maxValue: 10, weight: 20, direction: "high_is_crisis" },
    { id: '4', name: 'Sentiment Consumatori (UMich)', unit: 'pts', currentValue: 69, minValue: 50, maxValue: 100, weight: 10, direction: "low_is_crisis" },
    { id: '5', name: 'S&P 500 Earnings Yield', unit: '%', currentValue: 4.5, minValue: 3, maxValue: 7, weight: 15, direction: "low_is_crisis" },
    { id: '6', name: 'VIX (Indice Paura)', unit: 'pts', currentValue: 13, minValue: 10, maxValue: 60, weight: 10, direction: "high_is_crisis" },
    { id: '7', name: 'Spread 10Y-2Y Treasury', unit: 'bps', currentValue: -0.40, minValue: -1.0, maxValue: 2.0, weight: 20, direction: "low_is_crisis" }
];

// --- HELPERS ---

export function clamp01(x: number): number {
    return Math.max(0, Math.min(1, x));
}

export function normalizeIndicator(
    current: number,
    min: number,
    max: number,
    direction: MacroIndicatorDirection
): number {
    const range = max - min;
    if (range === 0) return 0.5;

    let normalized = (current - min) / range;

    if (direction === "low_is_crisis") {
        normalized = 1 - normalized;
    }

    return clamp01(normalized);
}

export function computeMacroIndex(
    indicators: MacroIndicatorConfig[]
): { index01: number; rows: MacroIndicatorComputed[] } {
    let totalWeight = 0;
    const rows: MacroIndicatorComputed[] = indicators.map(ind => {
        const norm = normalizeIndicator(ind.currentValue, ind.minValue, ind.maxValue, ind.direction);
        totalWeight += ind.weight;
        return {
            ...ind,
            normalized: norm,
            weighted: 0
        };
    });

    let weightedSum = 0;
    if (totalWeight === 0) {
        return { index01: 0.5, rows };
    }

    rows.forEach(r => {
        const relWeight = r.weight / totalWeight;
        r.weighted = r.normalized * relWeight;
        weightedSum += r.weighted;
    });

    return { index01: clamp01(weightedSum), rows };
}

export type MacroPhase = "CRISI" | "NEUTRO" | "EUFORIA";

export function mapIndexToPhase(index01: number): MacroPhase {
    if (index01 > 0.60) return "CRISI";
    if (index01 < 0.40) return "EUFORIA";
    return "NEUTRO";
}

// --- FETCHING ---

/**
 * Fetches macro data from a Google Sheet using the Visualization API.
 * Expects a sheet named "Macro" (or the first sheet if not specified in GID) 
 * with columns: ID (A), Value (B), [Min (C)], [Max (D)]
 */
export const fetchMacroData = async (sheetUrl: string): Promise<MacroDataPoint[]> => {
    if (!sheetUrl) throw new Error("URL Google Sheet non configurato");

    // Extract Sheet ID from URL
    const match = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error("ID Google Sheet non valido");
    const docId = match[1];

    // Construct Visualization API URL for the "Macro" sheet
    const query = encodeURIComponent("select A, B, C, D");
    const url = `https://docs.google.com/spreadsheets/d/${docId}/gviz/tq?tq=${query}&sheet=Macro`;

    const response = await fetch(url);
    const text = await response.text();

    const jsonMatch = text.match(/google\.visualization\.Query\.setResponse\(([\s\S\w]+)\);/);
    if (!jsonMatch) {
        if (text.includes("<!DOCTYPE html>")) throw new Error("Impossibile accedere al foglio. Verifica i permessi (Pubblico su web) e che esista la tab 'Macro'.");
        throw new Error("Formato risposta Google Sheet non valido");
    }

    const json = JSON.parse(jsonMatch[1]);

    if (json.status === 'error') {
        throw new Error(`Errore Sheet: ${json.errors?.[0]?.message || 'Sconosciuto'}`);
    }

    const rows = json.table.rows;
    if (!rows || rows.length === 0) return [];

    const dataPoints: MacroDataPoint[] = [];

    rows.forEach((row: any) => {
        const idCell = row.c[0];
        const valCell = row.c[1];
        const minCell = row.c[2];
        const maxCell = row.c[3];

        if (idCell && valCell && valCell.v !== null) {
            const id = String(idCell.v).trim();
            const value = Number(valCell.v);

            const dp: MacroDataPoint = { id, value };

            if (minCell && minCell.v !== null) dp.min = Number(minCell.v);
            if (maxCell && maxCell.v !== null) dp.max = Number(maxCell.v);

            if (!isNaN(value)) {
                dataPoints.push(dp);
            }
        }
    });

    return dataPoints;
};
