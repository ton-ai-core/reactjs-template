import { defineConfig, type PluginOption } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import react from '@vitejs/plugin-react-swc';
import mkcert from 'vite-plugin-mkcert';
import { componentTagger } from "lovable-tagger";
import checker from 'vite-plugin-checker';
// import Run from 'vite-plugin-run'; // no longer needed; we run the command ourselves for overlay
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const plugins = [
    // Allows using React dev server along with building a React application with Vite.
    // https://npmjs.com/package/@vitejs/plugin-react-swc
    react(),
    // Allows using the compilerOptions.paths property in tsconfig.json.
    // https://www.npmjs.com/package/vite-tsconfig-paths
    tsconfigPaths(),
    // Creates a custom SSL certificate valid for the local machine.
    // Using this plugin requires admin rights on the first dev-mode launch.
    // https://www.npmjs.com/package/vite-plugin-mkcert
    process.env.HTTPS && mkcert(),
    // Add componentTagger only in development mode
    mode === 'development' && componentTagger(),
    // Show overlay for arbitrary shell command failures (runs on start and on file changes)
    mode === 'development' && ((): PluginOption => ({
      name: 'command-overlay',
      configureServer(server) {
        const pattern = 'src/**/*';
        const stripAnsi = (text: string): string =>
          text.replace(/[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        const runAndOverlay = () => {
          const cmd = ['npm', 'run', 'lint'];
          const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          child.stdout.on('data', (d) => { output += d.toString(); process.stdout.write(d); });
          child.stderr.on('data', (d) => { output += d.toString(); process.stderr.write(d); });
          child.on('close', (code) => {
            if (code && code !== 0) {
              const clean = stripAnsi(output);
              // Also print to terminal via Vite logger
              server.config.logger.error(clean);
              server.ws.send({
                type: 'error',
                err: {
                  plugin: 'command-overlay',
                  message: `Command failed: ${cmd.join(' ')} \nlog: ${clean}`,
                  id: 'command-overlay',
                  stack: '',
                }
              });
            } else {
              server.ws.send({ type: 'full-reload' });
            }
          });
        };
        // initial run
        runAndOverlay();
        // watch changes
        server.watcher.add(pattern);
        server.watcher.on('change', runAndOverlay);
        server.watcher.on('unlink', runAndOverlay);
      },
    }))(),
  ].filter(Boolean) as PluginOption[];

  return {
    base: '/reactjs-template/',
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern',
        },
      },
    },
    plugins,
    build: {
      target: 'esnext',
    },
    publicDir: './public',
    server: {
      // Exposes your dev server and makes it accessible for the devices in the same network.
      host: '::',
      port: 8080,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
  };
});

