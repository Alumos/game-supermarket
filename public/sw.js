// Only the public student application shell is cached. Classroom/API responses,
// teacher pages, exports, credentials and event streams always use the network.
const CACHE_PREFIX = 'supermarket-shell-';
const CACHE_NAME = `${CACHE_PREFIX}1.3.2`;
const SHELL = ['/', '/index.html', '/app.js', '/app.css', '/world.js', '/db.js', '/drag-drop.mjs', '/shared/engine.mjs'];
const STATIC_PATHS = new Set(SHELL);
const STUDENT_PAGES = new Set(['/', '/index.html']);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll is atomic: an unavailable dependency must not install a partial app.
    await cache.addAll(SHELL.map(path => new Request(path, {cache:'reload'})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || request.headers.get('Accept')?.includes('text/event-stream')) return;

  if (request.mode === 'navigate') {
    // Never replace teacher/unknown navigation with the student interface.
    if (!STUDENT_PAGES.has(url.pathname)) return;
    event.respondWith((async () => {
      try {
        // Navigation queries can contain a classroom code; retain only the
        // canonical public index already precached, never the query response.
        const response = await fetch(request);
        if (response.ok) return response;
        const cached = await (await caches.open(CACHE_NAME)).match('/index.html');
        return cached || response;
      } catch (error) {
        const cached = await (await caches.open(CACHE_NAME)).match('/index.html');
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  if (!STATIC_PATHS.has(url.pathname) || STUDENT_PAGES.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request);
      if (response.ok && response.type !== 'opaque' && response.type !== 'opaqueredirect') {
        // Ignore query strings when storing a public shell dependency.
        try {await cache.put(url.pathname, response.clone());} catch {}
      }
      return response;
    } catch (error) {
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      throw error;
    }
  })());
});
