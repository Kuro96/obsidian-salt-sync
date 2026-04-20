import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AdminRouter } from '../src/admin/adminRouter';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AdminRouter', () => {
  it('resolves the admin bundle from the package dist directory', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const writeHead = vi.fn();
    const end = vi.fn();
    const router = new AdminRouter();

    const handled = router.handle(
      { url: '/admin/app.js' } as any,
      { writeHead, end } as any,
    );

    expect(handled).toBe(true);
    expect(existsSpy).toHaveBeenCalledOnce();
    const [bundleUrl] = existsSpy.mock.calls[0];
    expect(bundleUrl).toBeInstanceOf(URL);
    const bundlePath = fileURLToPath(bundleUrl as URL).replaceAll('\\', '/');
    expect(bundlePath).toMatch(/packages\/server\/dist\/admin\.js$/);
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledWith('Admin bundle not found — run pnpm build first');
  });
});
