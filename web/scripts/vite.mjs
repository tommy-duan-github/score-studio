import { build, createServer, preview } from 'vite';
import config from '../vite.config.mjs';

// Loading the config in Node avoids a native esbuild config-bundling step that
// cannot traverse parent directories in restricted Windows workspaces.
const [command = 'dev', ...args] = process.argv.slice(2);
const modeIndex = args.indexOf('--mode');
const mode = modeIndex >= 0 ? args[modeIndex + 1] : undefined;
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : command === 'preview' ? 4173 : 5173;
const options = { ...config, configFile: false, mode };

if (command === 'build') {
  await build(options);
} else if (command === 'preview') {
  const server = await preview({ ...options, preview: { host: '127.0.0.1', port } });
  server.printUrls();
} else {
  const server = await createServer({
    ...options,
    server: { ...config.server, host: '127.0.0.1', port, strictPort: args.includes('--strictPort') },
  });
  await server.listen();
  server.printUrls();
}
