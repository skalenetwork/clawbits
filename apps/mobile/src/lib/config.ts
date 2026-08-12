// app.clawbits.ai, NOT the apex — clawbits.ai serves the marketing site, so the
// old value would point every unconfigured build's API calls at a static page.
const fallbackApiBaseUrl = 'https://app.clawbits.ai';

export const apiBaseUrl = (
  process.env.EXPO_PUBLIC_CLAWBITS_API_URL || fallbackApiBaseUrl
).replace(/\/+$/u, '');
