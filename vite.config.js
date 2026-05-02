import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const allowedHosts = ['chat-frontend-cwm8.onrender.com'];

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts
  },
  preview: {
    allowedHosts
  }
});
