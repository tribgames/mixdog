// Preloaded into a recorded Node daemon (`node --import <this file>`): the model catalogs (models.dev, LiteLLM) are fetched from the network
// and change from day to day, so a recording made with them depends on the day. Every request to a host other than the loopback fails as a
// refused connection does, which is the state a core composed with a catalog that cannot connect starts from (`compose_test_support::offline_http`).
import http from 'node:http';
import https from 'node:https';

const loopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
const hostOf = (input) => {
  if (typeof input === 'string' || input instanceof URL) return new URL(input).hostname;
  return input?.url ? new URL(input.url).hostname : '';
};

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => (loopback(hostOf(input)) ? realFetch(input, init) : Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED (offline recording)') })));

for (const module of [http, https]) {
  for (const name of ['request', 'get']) {
    const real = module[name];
    module[name] = function (first, ...rest) {
      const host = typeof first === 'string' || first instanceof URL ? new URL(first).hostname : (first?.hostname ?? first?.host ?? '');
      if (loopback(String(host).replace(/:\d+$/, ''))) return real.call(this, first, ...rest);
      const request = real.call(this, { hostname: '127.0.0.1', port: 9, method: 'GET', path: '/' }, ...rest.filter((value) => typeof value === 'function'));
      return request;
    };
  }
}
