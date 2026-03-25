import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | null = null;

export function getPackageVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(moduleDir, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
  cachedVersion = packageJson.version || '0.0.0';
  return cachedVersion;
}
