// Test-only Node preload. Mocks may replace fetch; unmocked external requests
// fail immediately. PostgreSQL uses its normal local TCP connection.
// Do not preload this in a deployment that needs external providers.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
    return Promise.reject(new Error('External network disabled for backend tests'));
  }
  return originalFetch(input, init);
};
