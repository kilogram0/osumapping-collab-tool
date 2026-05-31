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
      },
    },
  },
  plugins: [],
}
