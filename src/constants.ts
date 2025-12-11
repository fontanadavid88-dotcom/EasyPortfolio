export const DEFAULT_BASE_CURRENCY = 'CHF';
export const DEFAULT_SHEET_ID = '1avnZqIVFzo4bbSqy9JHQ9LGE8UR0-1VT_bKSukCzIcM';
export const GOOGLE_VIZ_BASE = `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/gviz/tq?tqx=out:json`;

// --- PALETTE DEFINITIVA (Strict Mode) ---

// Colori Primari
export const PRIMARY_BLUE = '#0052a3';
export const ACCENT_ORANGE = '#f97316';

// Colori Semantici
export const POSITIVE_GREEN = '#16a34a';
export const NEGATIVE_RED = '#dc2626';

// Colori Tema
export const DARK_BG = '#020617';              // sfondo pagina
export const DARK_BG_ELEVATED = '#0b1120';     // sidebar/nav
export const CARD_BG = 'rgba(255,255,255,0.96)'; // card quasi bianche
export const BORDER_COLOR = 'rgba(148,163,184,0.4)';

// Colori Testo
export const NEUTRAL_TEXT = '#111827'; // Dark text for light cards
export const NEUTRAL_MUTED = '#6b7280'; // Muted text for light cards
export const DARK_TEXT = '#f9fafb';     // Text for dark backgrounds (Shell)
export const DARK_MUTED = '#9ca3af';    // Muted text for dark backgrounds

// --- CONFIGURAZIONE GRAFICI ---

// Mappatura specifica per i chart
export const CHART_COLORS = {
  line: PRIMARY_BLUE,
  grid: 'rgba(148,163,184,0.2)', // Light grid on white
  text: NEUTRAL_MUTED,
  positive: POSITIVE_GREEN,
  negative: NEGATIVE_RED,
};

// Palette ciclica per grafici a torta e barre categoriche
// Ordine: Blue, Orange, Green, poi scuri/neutri
export const PIE_COLORS = [
  PRIMARY_BLUE,    // 1. Blue Finanza
  ACCENT_ORANGE,   // 2. Accento Arancio
  POSITIVE_GREEN,  // 3. Verde
  '#1e3a8a',       // 4. Dark Blue
  '#b45309',       // 5. Dark Orange
  '#047857',       // 6. Dark Green
];

// Zone indicatore macro
export const MACRO_ZONES = {
  CRISIS: { max: 33, color: NEGATIVE_RED, label: 'Crisi' },
  NEUTRAL: { max: 66, color: '#eab308', label: 'Neutro' },
  EUPHORIA: { max: 100, color: POSITIVE_GREEN, label: 'Euforia' }
};