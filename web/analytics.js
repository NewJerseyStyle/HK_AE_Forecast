const measurementId = import.meta.env.VITE_GA_MEASUREMENT_ID || '';
const consentKey = 'aed-pred-analytics-consent-v1';

function readConsent() {
  try { return localStorage.getItem(consentKey); }
  catch { return null; }
}

function saveConsent(value) {
  try { localStorage.setItem(consentKey, value); }
  catch { /* Analytics remains disabled when storage is unavailable. */ }
}

function loadGoogleTag() {
  if (!/^G-[A-Z0-9]+$/i.test(measurementId) || window.gtag) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied',
    ad_user_data: 'denied', ad_personalization: 'denied',
  });
  window.gtag('consent', 'update', { analytics_storage: 'granted' });
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    allow_google_signals: false,
    send_page_view: true,
  });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.append(script);
}

export function trackEvent(name, parameters = {}) {
  if (readConsent() !== 'granted' || typeof window.gtag !== 'function') return;
  window.gtag('event', name, parameters);
}

function showConsentPanel() {
  document.querySelector('.analytics-consent')?.remove();
  const panel = document.createElement('aside');
  panel.className = 'analytics-consent';
  panel.setAttribute('aria-label', '\u7db2\u7ad9\u7528\u91cf\u5206\u6790\u8a2d\u5b9a');
  panel.innerHTML = `<p><strong>\u53ef\u9078\u7684\u7db2\u7ad9\u7528\u91cf\u5206\u6790</strong><span>\u540c\u610f\u5f8c\u624d\u6703\u8f09\u5165 Google Analytics\uff1b\u4e0d\u50b3\u9001\u91ab\u9662\u3001\u5206\u6d41\u3001\u7b49\u5019\u6642\u9593\u6216\u56de\u5831\u5167\u5bb9\u3002</span></p>
    <div><button type='button' data-analytics-consent='denied'>\u4e0d\u540c\u610f</button><button type='button' class='consent-accept' data-analytics-consent='granted'>\u540c\u610f\u533f\u540d\u7d71\u8a08</button></div>`;
  document.body.append(panel);
  panel.querySelectorAll('[data-analytics-consent]').forEach((button) => {
    button.addEventListener('click', () => {
      const value = button.dataset.analyticsConsent;
      saveConsent(value);
      panel.remove();
      if (value === 'granted') loadGoogleTag();
    });
  });
}

function bootAnalytics() {
  if (!/^G-[A-Z0-9]+$/i.test(measurementId)) return;
  const consent = readConsent();
  if (consent === 'granted') loadGoogleTag();
  else if (consent !== 'denied') showConsentPanel();
  const settings = document.createElement('button');
  settings.type = 'button';
  settings.className = 'analytics-settings';
  settings.textContent = '\u7528\u91cf\u5206\u6790\u8a2d\u5b9a';
  settings.addEventListener('click', showConsentPanel);
  document.querySelector('footer')?.append(settings);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAnalytics);
else bootAnalytics();
