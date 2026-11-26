/* global publicFiles, version */
const cachePrefix = 'lexicona-shell-'
const cacheName = cachePrefix + version
const spaPaths = new Set(['/', '/training', '/statistics', '/sounds', '/account', '/settings'])
const publicPaths = new Set(publicFiles)

self.addEventListener('install', (event) => {
  // Install the complete release before the worker can control a page.
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) =>
        cache.addAll(
          publicFiles.map(
            (path) =>
              new Request(path, { cache: 'reload', credentials: 'omit', redirect: 'error' }),
          ),
        ),
      ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith(cachePrefix) && key !== cacheName)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || request.method !== 'GET') return
  // Only the build allowlist and known SPA navigations use Cache Storage.
  const path = url.pathname.replace(/\/$/, '') || '/'
  const file =
    request.mode === 'navigate' && spaPaths.has(path)
      ? '/index.html'
      : publicPaths.has(url.pathname)
        ? url.pathname
        : null
  if (file) {
    event.respondWith(
      caches.open(cacheName).then(async (cache) => (await cache.match(file)) ?? fetch(request)),
    )
  }
})
