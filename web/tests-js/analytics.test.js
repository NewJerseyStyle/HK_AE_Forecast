import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('privacy-gated analytics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-TEST123');
    localStorage.clear();
    document.head.innerHTML = '';
    document.body.innerHTML = '<footer></footer>';
    delete window.gtag;
    delete window.dataLayer;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not load Google until the visitor grants consent', async () => {
    await import('../analytics.js');
    expect(document.querySelector('.analytics-consent')).not.toBeNull();
    expect(document.querySelector('script[src*=googletagmanager]')).toBeNull();

    document.querySelector('[data-analytics-consent=granted]').click();

    expect(localStorage.getItem('aed-pred-analytics-consent-v1')).toBe('granted');
    expect(document.querySelector('script[src*=googletagmanager]')).not.toBeNull();
  });

  it('keeps analytics disabled after refusal', async () => {
    await import('../analytics.js');
    document.querySelector('[data-analytics-consent=denied]').click();

    expect(localStorage.getItem('aed-pred-analytics-consent-v1')).toBe('denied');
    expect(document.querySelector('script[src*=googletagmanager]')).toBeNull();
  });
});
