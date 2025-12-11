/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // --- Dark Shell Theme (Sfondo App) ---
        shell: {
          DEFAULT: '#020617',    // DARK_BG
          elevated: '#0b1120',   // DARK_BG_ELEVATED
          text: '#f9fafb',       // TEXT_PRIMARY
          muted: '#9ca3af',      // TEXT_MUTED
          border: 'rgba(148,163,184,0.15)',
        },
        // --- Light Panel Theme (Card) ---
        panel: {
          DEFAULT: 'rgba(255,255,255,0.96)', // CARD_BG
          text: '#111827',       // NEUTRAL_TEXT
          muted: '#6b7280',      // NEUTRAL_MUTED
          border: 'rgba(148,163,184,0.4)', // BORDER_COLOR
        },
        // --- Brand & Semantics ---
        primary: {
          DEFAULT: '#0052a3',    // PRIMARY_BLUE
          light: '#0066cc',
          dark: '#003d7a',
          foreground: '#ffffff',
        },
        secondary: {
          DEFAULT: '#f97316',    // ACCENT_ORANGE
          hover: '#ea580c',
        },
        positive: '#16a34a',     // POSITIVE_GREEN
        negative: '#dc2626',     // NEGATIVE_RED
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
        'glow': '0 0 20px rgba(0, 82, 163, 0.15)',
      }
    },
  },
  plugins: [],
}