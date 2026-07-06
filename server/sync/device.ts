import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSyncPaths } from './paths';

export function getOrCreateDeviceId(deviceIdPath = getSyncPaths().deviceIdPath): string {
  if (fs.existsSync(deviceIdPath)) {
    const saved = fs.readFileSync(deviceIdPath, 'utf8').trim();
    if (saved !== '') {
      return saved;
    }
  }
  fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });
  const next = crypto.randomUUID();
  fs.writeFileSync(deviceIdPath, `${next}\n`, { encoding: 'utf8', mode: 0o600 });
  return next;
}
