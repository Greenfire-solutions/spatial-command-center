/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        workspace: {
          dark: '#0f1115',
          panel: 'rgba(20, 24, 30, 0.7)',
          accent: '#3b82f6'
        }
      }
    }
  },
  plugins: []
};
