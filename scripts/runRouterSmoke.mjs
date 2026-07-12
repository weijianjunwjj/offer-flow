import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const host = '127.0.0.1';
const port = 4174;
const baseURL = `http://${host}:${port}`;
const playwrightCli = resolve('node_modules/@playwright/test/cli.js');

const server = await createServer({
  configFile: resolve('vite.config.ts'),
  logLevel: 'error',
  server: { host, port, strictPort: true },
});

let child;
let exitCode = 1;

try {
  await server.listen();
  child = spawn(
    process.execPath,
    [playwrightCli, 'test', 'tests/router-navigation.spec.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, OFFERFLOW_ROUTER_BASE_URL: baseURL },
      stdio: 'inherit',
      windowsHide: true,
    },
  );

  exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolveExit(code ?? (signal ? 1 : 0));
    });
  });
} finally {
  if (child && child.exitCode === null) child.kill();
  await server.close();
}

process.exitCode = exitCode;
