import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import App from '../admin-src/App';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

describe('Admin App shell', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeStorage());
    vi.stubGlobal('sessionStorage', makeStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the admin shell with primary navigation', () => {
    const html = renderToString(React.createElement(App));

    expect(html).toContain('Salt Sync');
    expect(html).toContain('Overview');
    expect(html).toContain('Rooms');
    expect(html).toContain('Snapshots');
    expect(html).toContain('Tokens');
    expect(html).toContain('Blob GC');
    expect(html).toContain('Config');
    expect(html).toContain('type="password"'); // admin token input must be a password field
  });
});
