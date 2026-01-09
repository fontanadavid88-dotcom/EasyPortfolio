export const DEFAULT_BASE_CURRENCY = 'CHF';
export const DEFAULT_SHEET_ID = '1avnZqIVFzo4bbSqy9JHQ9LGE8UR0-1VT_bKSukCzIcM';
export const GOOGLE_VIZ_BASE = `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/gviz/tq?tqx=out:json`;

// --- PALETTE DEFINITIVA ---

// Colori Primari
export const PRIMARY_BLUE = '#0052a3';
export const ACCENT_ORANGE = '#f97316';

// Colori Semantici (Stati)
export const POSITIVE_GREEN = '#16a34a';
export const NEGATIVE_RED = '#dc2626';

// Colori Neutri (Dark Mode)
export const NEUTRAL_TEXT = '#f9fafb';
export const NEUTRAL_MUTED = '#9ca3af';
export const CARD_BG = '#0b1120'; // backgroundElevated
export const PAGE_BG = '#020617'; // backgroundDark
export const BORDER_COLOR = 'rgba(148,163,184,0.1)';

// --- CONFIGURAZIONE GRAFICI ---

// Mappatura specifica per i chart
export const CHART_COLORS = {
  line: PRIMARY_BLUE,
  areaFill: 'rgba(0, 82, 163, 0.2)', // Primary con opacità
  positive: POSITIVE_GREEN,
  negative: NEGATIVE_RED,
  drawdown: NEGATIVE_RED,
  drawdownFill: 'rgba(220, 38, 38, 0.2)' // Red con opacità
};

// Generazione colori armoniosi (Sottotoni di Blu e Arancio + Accenti coordinati)
// Evitiamo l'effetto arcobaleno casuale.
export const COLORS = [
  '#0052a3', // Primary Blue (Base)
  '#f97316', // Accent Orange (Base)
  '#003d7a', // Darker Blue
  '#ea580c', // Darker Orange
  '#3b82f6', // Brighter Blue (es. Tailwind Blue-500)
  '#fdba74', // Lighter Orange (es. Tailwind Orange-300)
  '#1d4ed8', // Deep Blue
  '#9ca3af'  // Neutral Gray per code "altre"
];

// Zone indicatore macro
export const MACRO_ZONES = {
  CRISIS: { max: 33, color: NEGATIVE_RED, label: 'Crisi' },
  NEUTRAL: { max: 66, color: '#eab308', label: 'Neutro' }, // Yellow-500
  EUPHORIA: { max: 100, color: POSITIVE_GREEN, label: 'Euforia' }
};