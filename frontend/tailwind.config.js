/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Sits between gray-800 (#1f2937) and gray-900 (#111827) so post cards
        // and the create form stand out from the gray-800 panel without
        // matching the gray-900 page background.
        gray: {
          850: '#18212f',
        },
        // Semantic surface tokens. Components should prefer these over raw
        // gray-* values so future theme changes (e.g. a light mode) only need
        // to remap the token layer.
        surface: {
          DEFAULT: '#111827', // page background (gray-900)
          raised: '#18212f',  // cards / elevated panels (gray-850)
          panel: '#1f2937',   // secondary panels (gray-800)
          border: '#374151',  // borders (gray-700)
        },
        // Semantic intent tokens. Use these instead of hardcoding blue-*/
        // red-*/green-* in components so the palette stays consistent.
        brand: {
          DEFAULT: '#2563eb', // blue-600
          hover: '#1d4ed8',   // blue-700
          muted: '#60a5fa',   // blue-400
        },
        danger: {
          DEFAULT: '#ef4444', // red-500
          hover: '#dc2626',   // red-600
          muted: '#f87171',   // red-400
        },
        success: {
          DEFAULT: '#22c55e', // green-500
          muted: '#4ade80',   // green-400
        },
        muted: {
          DEFAULT: '#6b7280', // gray-500
          light: '#9ca3af',   // gray-400
        },
      },
    },
  },
  plugins: [],
}
