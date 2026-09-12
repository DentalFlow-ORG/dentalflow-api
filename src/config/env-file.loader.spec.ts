import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFile, loadEnvFiles } from './env-file.loader';

/**
 * The `.env` reader that runs before anything else in `main.ts`.
 *
 * Its precedence rule is the load-bearing part: a value already present in the
 * real environment always wins, and among files the *first* to supply a key
 * wins. That is what lets a deployment platform's injected variables override
 * a checked-in `.env.example` instead of being silently replaced by it.
 */

describe('env-file.loader', () => {
  let dir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dentalflow-env-'));
    originalEnv = process.env;
    process.env = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  // ── Parsing ────────────────────────────────────────────────────────────────

  describe('loadEnvFile', () => {
    it('returns an empty object for a file that does not exist', () => {
      expect(loadEnvFile(join(dir, 'absent.env'))).toEqual({});
    });

    it('parses simple key=value pairs', () => {
      const path = write('.env', 'FOO=bar\nBAZ=qux\n');
      expect(loadEnvFile(path)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('strips surrounding double quotes', () => {
      const path = write('.env', 'SECRET="a value with spaces"\n');
      expect(loadEnvFile(path).SECRET).toBe('a value with spaces');
    });

    it('leaves an unpaired quote alone', () => {
      const path = write('.env', 'ODD="unclosed\n');
      expect(loadEnvFile(path).ODD).toBe('"unclosed');
    });

    it('keeps inner quotes', () => {
      const path = write('.env', 'JSONISH={"a":"b"}\n');
      expect(loadEnvFile(path).JSONISH).toBe('{"a":"b"}');
    });

    it('ignores comments and blank lines', () => {
      const path = write('.env', '# a comment\n\nFOO=bar\n\n   \n# another\n');
      expect(loadEnvFile(path)).toEqual({ FOO: 'bar' });
    });

    it('ignores a line with no separator', () => {
      const path = write('.env', 'NOT_A_PAIR\nFOO=bar\n');
      expect(loadEnvFile(path)).toEqual({ FOO: 'bar' });
    });

    it('keeps everything after the first "=" — values may contain "="', () => {
      // Base64 secrets and connection strings routinely contain "=".
      const path = write('.env', 'JWT_SECRET=abc==def=\n');
      expect(loadEnvFile(path).JWT_SECRET).toBe('abc==def=');
    });

    it('trims whitespace around the key and the value', () => {
      const path = write('.env', '  FOO  =   bar   \n');
      expect(loadEnvFile(path)).toEqual({ FOO: 'bar' });
    });

    it('reads an empty value as an empty string', () => {
      const path = write('.env', 'EMPTY=\n');
      expect(loadEnvFile(path)).toEqual({ EMPTY: '' });
    });

    it('handles CRLF line endings', () => {
      const path = write('.env', 'FOO=bar\r\nBAZ=qux\r\n');
      expect(loadEnvFile(path)).toEqual({ FOO: 'bar', BAZ: 'qux' });
    });

    it('lets a later duplicate key win within one file', () => {
      const path = write('.env', 'FOO=first\nFOO=second\n');
      expect(loadEnvFile(path).FOO).toBe('second');
    });

    it('returns an empty object for an empty file', () => {
      expect(loadEnvFile(write('.env', ''))).toEqual({});
    });
  });

  // ── Precedence ─────────────────────────────────────────────────────────────

  describe('loadEnvFiles', () => {
    it('applies values that are not already set', () => {
      delete process.env.DENTALFLOW_TEST_NEW;
      loadEnvFiles([write('.env', 'DENTALFLOW_TEST_NEW=from-file\n')]);
      expect(process.env.DENTALFLOW_TEST_NEW).toBe('from-file');
    });

    it('never overrides a variable already present in the environment', () => {
      // The deployment platform's injected value must survive.
      process.env.DENTALFLOW_TEST_EXISTING = 'from-platform';
      loadEnvFiles([write('.env', 'DENTALFLOW_TEST_EXISTING=from-file\n')]);
      expect(process.env.DENTALFLOW_TEST_EXISTING).toBe('from-platform');
    });

    it('gives the first file that supplies a key precedence over later ones', () => {
      delete process.env.DENTALFLOW_TEST_ORDER;
      loadEnvFiles([
        write('.env.local', 'DENTALFLOW_TEST_ORDER=local\n'),
        write('.env', 'DENTALFLOW_TEST_ORDER=shared\n'),
      ]);
      expect(process.env.DENTALFLOW_TEST_ORDER).toBe('local');
    });

    it('falls through to a later file for keys the earlier one omits', () => {
      delete process.env.DENTALFLOW_TEST_ONLY_SHARED;
      loadEnvFiles([
        write('.env.local', 'SOMETHING_ELSE=x\n'),
        write('.env', 'DENTALFLOW_TEST_ONLY_SHARED=shared\n'),
      ]);
      expect(process.env.DENTALFLOW_TEST_ONLY_SHARED).toBe('shared');
    });

    it('skips missing files without failing the boot', () => {
      delete process.env.DENTALFLOW_TEST_SKIP;
      expect(() =>
        loadEnvFiles([
          join(dir, 'does-not-exist'),
          write('.env', 'DENTALFLOW_TEST_SKIP=ok\n'),
        ]),
      ).not.toThrow();
      expect(process.env.DENTALFLOW_TEST_SKIP).toBe('ok');
    });

    it('does nothing when given no files', () => {
      expect(() => loadEnvFiles([])).not.toThrow();
    });

    it('treats an empty string in the environment as already set', () => {
      // An explicitly blank variable is a deliberate choice, not an absence;
      // validateEnv is what rejects it later.
      process.env.DENTALFLOW_TEST_BLANK = '';
      loadEnvFiles([write('.env', 'DENTALFLOW_TEST_BLANK=from-file\n')]);
      expect(process.env.DENTALFLOW_TEST_BLANK).toBe('');
    });
  });
});
