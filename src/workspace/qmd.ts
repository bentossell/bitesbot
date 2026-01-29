import { spawn } from 'node:child_process';
import { expandHome } from './path-utils.js';

export type QmdSearchResult = {
  docid?: string;
  score: number;
  file: string;
  title?: string;
  context?: string;
  snippet?: string;
  body?: string;
};

export type QmdQueryOptions = {
  query: string;
  bin?: string;
  index?: string;
  collection?: string;
  limit?: number;
  minScore?: number;
  full?: boolean;
  lineNumbers?: boolean;
  timeoutMs?: number;
};

const DEFAULT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 4000;

export const stripQmdPath = (value: string): string => value.replace(/^qmd:\/\//, '');

export const queryQmd = async (opts: QmdQueryOptions): Promise<QmdSearchResult[]> => {
  const bin = expandHome(opts.bin ?? 'qmd');
  const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit as number) : DEFAULT_LIMIT;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(100, opts.timeoutMs as number) : DEFAULT_TIMEOUT_MS;

  const args: string[] = [];
  if (opts.index) {
    args.push('--index', opts.index);
  }
  args.push('query', opts.query, '--json', '-n', String(limit));

  if (opts.collection) {
    args.push('-c', opts.collection);
  }
  if (typeof opts.minScore === 'number' && !Number.isNaN(opts.minScore)) {
    args.push('--min-score', String(opts.minScore));
  }
  if (opts.full) {
    args.push('--full');
  }
  if (opts.lineNumbers) {
    args.push('--line-numbers');
  }

  return await new Promise<QmdSearchResult[]>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const finish = (err?: Error, results?: QmdSearchResult[]) => {
      if (finished) return;
      finished = true;
      if (err) {
        if (stderr) {
          err.message = `${err.message}: ${stderr.trim()}`;
        }
        reject(err);
        return;
      }
      resolve(results ?? []);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('qmd query timed out'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(new Error(`qmd exited with code ${code ?? 'unknown'}`));
        return;
      }

      if (!stdout.trim()) {
        finish(undefined, []);
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as QmdSearchResult[];
        finish(undefined, Array.isArray(parsed) ? parsed : []);
      } catch (err) {
        finish(err instanceof Error ? err : new Error('Failed to parse qmd output'));
      }
    });
  });
};
