/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./App.tsx",
    "./index.tsx",
    "./components/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./services/**/*.{js,ts,jsx,tsx}",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        backgroundDark: "#020617",
        backgroundElevated: "#0b1120", // Card bg or slightly lighter dark
        backgroundSoft: "#111827",     // For inputs or lighter areas
        primary: "#0052a3",
        secondary: "#f97316",
        positive: "#16a34a",
        negative: "#dc2626",
        surface: "rgba(255,255,255,0.03)", // Ultra subtle white for glass effect on dark
        borderSoft: "rgba(148,163,184,0.1)", // Very subtle border for dark mode
        textPrimary: "#f9fafb",
        textMuted: "#9ca3af",
        brand: {
          50: '#f0f7ff',
          100: '#e0effe',
          200: '#badbff',
          500: '#0066cc',
          600: '#0052a3',
          700: '#003d7a',
          800: '#002952',
          900: '#001433',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
