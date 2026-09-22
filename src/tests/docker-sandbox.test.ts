import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

let lastSpawnArgs: string[] = [];

vi.mock('child_process', () => {
  return {
    execSync: vi.fn(() => { throw new Error('no docker'); }),
    spawn: vi.fn((_cmd: string, args: string[]) => {
      lastSpawnArgs = args;
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn(), end: vi.fn() };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    }),
  };
});

describe('docker sandbox defaults', () => {
  beforeEach(() => {
    vi.resetModules();
    lastSpawnArgs = [];
    process.env.USE_DOCKER_SANDBOX = 'true';
  });

  it('disables network by default when runInDocker is called', async () => {
    const mod = await import('../core/docker-sandbox.js');
    await mod.runInDocker({ command: ['echo', 'ok'] });
    const networkIndex = lastSpawnArgs.indexOf('--network');
    expect(networkIndex).toBeGreaterThan(-1);
    expect(lastSpawnArgs[networkIndex + 1]).toBe('none');
  });
});
