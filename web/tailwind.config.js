/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'] },
      colors: {
        navy: { 50: '#f2f5fb', 100: '#e3e9f5', 200: '#c4d0e8', 300: '#94a9d1', 400: '#5d7ab3', 500: '#3a5894', 600: '#2a4276', 700: '#1f3260', 800: '#16264d', 900: '#0b1f44', 950: '#06122b' },
        brand: { 50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd', 400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a' },
      },
      boxShadow: { card: '0 1px 2px rgba(11,31,68,0.04), 0 1px 3px rgba(11,31,68,0.06)', pop: '0 10px 30px -10px rgba(11,31,68,0.25)' },
      keyframes: { 'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } }, 'slide-up': { from: { opacity: 0, transform: 'translateY(6px)' }, to: { opacity: 1, transform: 'translateY(0)' } } },
      animation: { 'fade-in': 'fade-in 150ms ease-out', 'slide-up': 'slide-up 180ms ease-out' },
    },
  },
  plugins: [],
};
