import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = env.SUPABASE_URL;
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_PUBLIC_KEY ?? env.PUBLIC_KEY;

  return {
    plugins: [react()],
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    define: {
      global: 'globalThis',
      'import.meta.env.SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.SUPABASE_PUBLISHABLE_KEY': JSON.stringify(supabasePublishableKey),
      'import.meta.env.SUPABASE_PUBLIC_KEY': JSON.stringify(supabasePublishableKey),
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        output: {
          // Vite 8 / Rolldown expects a function, not the Rollup 3 object map
          manualChunks(id) {
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react-router') ||
              id.includes('node_modules/react-router-dom/')
            ) {
              return 'vendor';
            }
          },
        },
      },
    },
  };
});
