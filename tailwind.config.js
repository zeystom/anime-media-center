/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0f0f12',
        card: '#18181c',
        cardHover: '#23232a',
        border: '#2a2a32',
        accent: {
          DEFAULT: '#e50914', // Netflix Red / Anime punchy accent
          hover: '#f40612',
          glow: 'rgba(229, 9, 20, 0.4)'
        },
        indigoAccent: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      }
    },
  },
  plugins: [],
}
