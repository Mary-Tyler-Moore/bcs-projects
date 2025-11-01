// Tailwind config
// Loaded before https://cdn.tailwindcss.com in index.html

// Ensure global object exists even if CDN hasn't loaded yet
window.tailwind = window.tailwind || {};

window.tailwind.config = {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        ink:    '#0b0d12',
        panel:  '#0f172a',
        edge:   '#1e293b',
        brand:  '#60a5fa',
        brand2: '#34d399'
      },
      boxShadow: { soft: '0 8px 30px rgba(0,0,0,0.35)' }
    }
  }
};

