const fallbackApiBaseUrl = 'https://clawbits.ai';

export const apiBaseUrl = (
  process.env.EXPO_PUBLIC_CLAWBITS_API_URL || fallbackApiBaseUrl
).replace(/\/+$/u, '');
