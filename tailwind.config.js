/** @type {import('tailwindcss').Config} */

/*
 * Kaiko unified design system — "Obsidian & Crimson".
 *
 * Every legacy Tailwind hue family is remapped onto one of four role ramps so
 * existing class names render cohesively without a rewrite of every string:
 *   rose / red / pink / indigo / fuchsia  ->  crimson  (brand accent ramp)
 *   violet / purple / blue / sky / cyan   ->  plum     (secondary dark-violet)
 *   emerald / green / teal                ->  mint     (semantic status, muted)
 *   amber / yellow / orange               ->  gold     (semantic warning/score, muted)
 *
 * Brand accents:
 *   --accent-primary   #FF1E6D  (crimson-500)
 *   --accent-secondary #B81450  (crimson-700)
 *   --accent-plum      #4A154B  (plum-800)
 */

const crimson = {
  50: '#FFF1F6',
  100: '#FFE2ED',
  200: '#FFC6D9',
  300: '#FF9DBB',
  400: '#FF5E92',
  500: '#FF1E6D',
  600: '#EF115C',
  700: '#B81450',
  800: '#931241',
  900: '#6E0D33',
  950: '#3F0220',
};

const plum = {
  50: '#FBF3FC',
  100: '#F4E2F7',
  200: '#E8C5EC',
  300: '#D69DDC',
  400: '#BC6DC4',
  500: '#9C46A5',
  600: '#7C2B85',
  700: '#5C1D63',
  800: '#4A154B',
  900: '#351037',
  950: '#230A26',
};

const mint = {
  50: '#F0FBF5',
  100: '#D9F6E6',
  200: '#ADEFCE',
  300: '#7DDDB2',
  400: '#43CD93',
  500: '#23B878',
  600: '#15925E',
  700: '#12734B',
  800: '#115A3C',
  900: '#0E4530',
  950: '#082B1E',
};

const gold = {
  50: '#FDFAF0',
  100: '#FAF1D8',
  200: '#F3E2A9',
  300: '#E9C46A',
  400: '#DBA83F',
  500: '#C6902A',
  600: '#A3741F',
  700: '#825C1A',
  800: '#674818',
  900: '#4F3813',
  950: '#2F2109',
};

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        transparent: 'transparent',
        current: 'currentColor',

        // Named surfaces
        void: '#07060A',
        elevated: '#0F0B15',

        // Role ramps
        crimson,
        plum,
        mint,
        gold,

        // Legacy family remaps (see header comment)
        rose: crimson,
        red: crimson,
        pink: crimson,
        indigo: crimson,
        fuchsia: crimson,
        violet: plum,
        purple: plum,
        blue: plum,
        sky: plum,
        cyan: plum,
        teal: mint,
        emerald: mint,
        green: mint,
        amber: gold,
        yellow: gold,
        orange: gold,

        // Neutral ramp (slightly plum-cooled so the whole app sits in one atmosphere)
        zinc: {
          50: '#F4F3F6',
          100: '#E6E4EA',
          200: '#CFCBD8',
          300: '#B0ABC0',
          400: '#8E88A0',
          500: '#726C85',
          600: '#5B566D',
          700: '#453F55',
          800: '#302B3D',
          900: '#1D1928',
          950: '#100D17',
        },
      },
      fontFamily: {
        sans: ['Space Grotesk', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        'glow-crimson': '0 8px 28px -4px rgba(255, 30, 109, 0.45)',
        'glow-crimson-sm': '0 4px 16px -2px rgba(255, 30, 109, 0.35)',
        'glow-emerald-sm': '0 4px 16px -2px rgba(16, 185, 129, 0.32)',
      },
      transitionTimingFunction: {
        fluid: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
}
