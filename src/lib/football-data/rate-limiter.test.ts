import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRateLimiter } from './rate-limiter';

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('football-data rate limiter', () => {
  it('starts the first task immediately and returns its result', async () => {
    const limiter = createRateLimiter();
    const task = vi.fn(async () => 'result');

    const result = limiter.run(task);

    expect(task).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe('result');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts queued tasks in order with a six-second interval', async () => {
    const limiter = createRateLimiter();
    const starts: number[] = [];
    const task = (id: number) => async () => {
      starts.push(id);
      return id;
    };
    const results = Promise.all([
      limiter.run(task(1)),
      limiter.run(task(2)),
      limiter.run(task(3)),
    ]);

    expect(starts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(starts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(starts).toEqual([1, 2, 3]);
    await expect(results).resolves.toEqual([1, 2, 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('limits starts without waiting for a previous task to finish', async () => {
    const limiter = createRateLimiter();
    const pending = Promise.withResolvers<string>();
    const first = limiter.run(() => pending.promise);
    const task = vi.fn(async () => 'second');
    const second = limiter.run(task);

    await vi.advanceTimersByTimeAsync(6_000);

    expect(task).toHaveBeenCalledOnce();
    await expect(second).resolves.toBe('second');
    pending.resolve('first');
    await expect(first).resolves.toBe('first');
  });

  it('removes an aborted queued task without delaying the next task', async () => {
    const limiter = createRateLimiter();
    await limiter.run(async () => undefined);
    const controller = new AbortController();
    const skipped = vi.fn(async () => 'skipped');
    const canceled = limiter.run(skipped, controller.signal);
    const rejection = expect(canceled).rejects.toMatchObject({
      name: 'AbortError',
    });
    const next = vi.fn(async () => 'next');
    const result = limiter.run(next);

    controller.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(6_000);

    expect(skipped).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe('next');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an empty queue timer while preserving the remaining interval', async () => {
    const limiter = createRateLimiter();
    await limiter.run(async () => undefined);
    const controller = new AbortController();
    const canceled = limiter.run(async () => undefined, controller.signal);
    const rejection = expect(canceled).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);

    const task = vi.fn(async () => 'next');
    const result = limiter.run(task);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('next');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an already aborted task without exposing its reason or taking a slot', async () => {
    const limiter = createRateLimiter();
    const controller = new AbortController();
    controller.abort(new Error('Sensitive abort reason'));
    const task = vi.fn(async () => 'unused');

    const error: unknown = await limiter
      .run(task, controller.signal)
      .catch((error: unknown) => error);

    expect(error).toMatchObject({
      name: 'AbortError',
      message: 'football-data request aborted',
    });
    expect(error).not.toHaveProperty('cause');
    expect(task).not.toHaveBeenCalled();
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the interval when the system clock jumps forward', async () => {
    const limiter = createRateLimiter();
    await limiter.run(async () => undefined);
    const futureTime = Date.now() + 86_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(futureTime);
    const task = vi.fn(async () => 'next');

    const result = limiter.run(task);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toBe('next');
  });

  it('does not release a burst when a timer runs late', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const limiter = createRateLimiter();
    const starts: number[] = [];
    const task = async () => {
      starts.push(performance.now());
    };
    const results = Promise.all([
      limiter.run(task),
      limiter.run(task),
      limiter.run(task),
    ]);

    clock.mockReturnValue(60_000);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(starts).toEqual([0, 60_000]);
    clock.mockReturnValue(66_000);
    await vi.advanceTimersByTimeAsync(6_000);

    expect(starts).toEqual([0, 60_000, 66_000]);
    await results;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a task failure and keeps the interval for following tasks', async () => {
    const limiter = createRateLimiter();
    const failed = limiter.run(() => {
      throw new Error('Request failed');
    });
    await expect(failed).rejects.toThrow('Request failed');
    const task = vi.fn(async () => 'next');

    const result = limiter.run(task);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toBe('next');
  });

  it('postpones an armed timer and preserves the queue order and interval', async () => {
    const limiter = createRateLimiter();
    await limiter.run(async () => undefined);
    const starts: number[] = [];
    const task = (id: number) => async () => {
      starts.push(id);
      return id;
    };
    const results = Promise.all([limiter.run(task(1)), limiter.run(task(2))]);

    await vi.advanceTimersByTimeAsync(2_000);
    limiter.pause(12_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(starts).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);

    await expect(results).resolves.toEqual([1, 2]);
    expect(starts).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('remembers a pause in an empty queue and only extends its deadline', async () => {
    const limiter = createRateLimiter();
    limiter.pause(12_000);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    limiter.pause(20_000);
    await vi.advanceTimersByTimeAsync(2_000);
    limiter.pause(1_000);
    limiter.pause(0);
    const task = vi.fn(async () => 'next');

    const result = limiter.run(task);
    await vi.advanceTimersByTimeAsync(17_999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('next');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the pause after canceling the last queued task', async () => {
    const limiter = createRateLimiter();
    limiter.pause(12_000);
    const controller = new AbortController();
    const canceled = limiter.run(async () => undefined, controller.signal);
    const rejection = expect(canceled).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);

    const task = vi.fn(async () => 'next');
    const result = limiter.run(task);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe('next');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 2_147_483_648])('rejects an unsupported pause %s', (delayMs) => {
    expect(() => createRateLimiter().pause(delayMs)).toThrow(RangeError);
  });

  it.each([0, 2_147_483_648])('rejects an unsupported interval %s', (intervalMs) => {
    expect(() => createRateLimiter(intervalMs)).toThrow(RangeError);
  });
});
