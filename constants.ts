export const DEFAULT_BASE_CURRENCY = 'CHF';
export const DEFAULT_SHEET_ID = '1avnZqIVFzo4bbSqy9JHQ9LGE8UR0-1VT_bKSukCzIcM';
export const GOOGLE_VIZ_BASE = `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/gviz/tq?tqx=out:json`;

// Fallback colors for charts
export const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

export const MACRO_ZONES = {
  CRISIS: { max: 33, color: '#ef4444', label: 'Crisi' },
  NEUTRAL: { max: 66, color: '#eab308', label: 'Neutro' },
  EUPHORIA: { max: 100, color: '#22c55e', label: 'Euforia' }
};