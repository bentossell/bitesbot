import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { queryQmd, stripQmdPath } from '../src/workspace/qmd.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();
}

describe('qmd helpers', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('strips qmd:// prefix', () => {
    expect(stripQmdPath('qmd://memory/foo.md')).toBe('memory/foo.md');
    expect(stripQmdPath('memory/foo.md')).toBe('memory/foo.md');
  });

  it('parses json output from qmd', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawnMock>);

    const promise = queryQmd({ query: 'test', bin: 'qmd', limit: 2 });

    child.stdout.write(JSON.stringify([{ score: 0.9, file: 'qmd://notes.md', snippet: 'hello' }]));
    child.emit('exit', 0);

    await expect(promise).resolves.toEqual([
      { score: 0.9, file: 'qmd://notes.md', snippet: 'hello' },
    ]);
    expect(spawnMock).toHaveBeenCalled();
    const [bin, args] = spawnMock.mock.calls[0] ?? [];
    expect(bin).toBe('qmd');
    expect(args).toEqual(expect.arrayContaining(['query', 'test', '--json']));
  });

  it('rejects when qmd exits non-zero', async () => {
    const child = new FakeChildProcess();
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawnMock>);

    const promise = queryQmd({ query: 'test', bin: 'qmd' });
    child.stderr.write('boom');
    child.emit('exit', 1);

    await expect(promise).rejects.toThrow('qmd exited');
  });
});
