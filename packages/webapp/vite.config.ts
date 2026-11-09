import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';
import path from 'node:path';
import { defineConfig, loadEnv, type PluginOption } from 'vite';
import fixReactVirtualized from 'esbuild-plugin-react-virtualized';

const allowedEnvPrefixes = ['VITE_', 'REACT_APP_', 'PUBLIC_URL'];

const pickClientEnv = (env: Record<string, string>) =>
  Object.keys(env).reduce<Record<string, string>>((acc, key) => {
    if (allowedEnvPrefixes.some((prefix) => key.startsWith(prefix))) {
      acc[key] = env[key];
    }

    return acc;
  }, {});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const rootDir = __dirname;
  const envDir = path.resolve(rootDir, '../..');
  const env = loadEnv(mode, envDir, '');
  const clientEnv = pickClientEnv(env);
  // The webapp's own port. Not PORT: the server listens on SERVER_PORT, or
  // PORT when that isn't set, so reading PORT here made both want it.
  const port = Number(env.WEBAPP_PORT) || 4000;
  // API calls go to the server's port, read the same way the server reads
  // it (SERVER_PORT, then PORT). VITE_API_PROXY_TARGET still overrides it.
  const apiProxyTarget =
    env.VITE_API_PROXY_TARGET ||
    `http://localhost:${env.SERVER_PORT || env.PORT || 3000}`;
  const plugins: PluginOption[] = [
    react(),
    legacy({
      targets: ['defaults', 'not IE 11'],
      additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
    }),
  ];

  return {
    plugins,
    root: rootDir,
    envDir,
    resolve: {
      alias: {
        '@': path.resolve(rootDir, 'src'),
        '@public': path.resolve(rootDir, 'public'),
        path: 'path-browserify',
      },
    },
    define: {
      'process.env': {
        NODE_ENV: mode,
        PUBLIC_URL: clientEnv.PUBLIC_URL ?? '/',
        ...clientEnv,
      },
    },
    server: {
      host: true,
      port,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
        },
        '/socket': {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
    },
    optimizeDeps: {
      esbuildOptions: {
        plugins: [fixReactVirtualized as any],
      },
    },
  };
});
