import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, 'utf8');
  const entries = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const separatorIndex = line.indexOf('=');

      if (separatorIndex === -1) {
        return null;
      }

      const key = line.slice(0, separatorIndex).trim();
      const rawValue = line.slice(separatorIndex + 1).trim();
      const value = rawValue.replace(/^"(.*)"$/, '$1');

      return [key, value] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return Object.fromEntries(entries);
}

export function loadEnvFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    const env = loadEnvFile(filePath);

    for (const [key, value] of Object.entries(env)) {
      process.env[key] ??= value;
    }
  }
}
