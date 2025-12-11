/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        backgroundDark: "#020617",
        backgroundElevated: "#0b1120",
        primary: "#0052a3",
        secondary: "#f97316",
        positive: "#16a34a",
        negative: "#dc2626",
        // Aggiornato panel a bianco quasi solido per visibilità massima
        panel: {
          DEFAULT: '#ffffff', // Bianco puro per le card
          muted: '#94a3b8',
          text: '#0f172a',
          border: '#e2e8f0',
        },
        shell: {
          DEFAULT: 'transparent',
          elevated: '#0b1120',
          text: '#f8fafc',
          muted: '#94a3b8',
          border: 'rgba(255,255,255,0.1)',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
      }
    },
  },
  plugins: [],
}