import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default async function globalSetup(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  await import(pathToFileURL(path.resolve(here, '../build.mjs')).href);
}
