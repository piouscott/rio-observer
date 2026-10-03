// Fonctionnement hors ligne : le réseau est souvent saturé en manifestation.
// Réseau d'abord pour récupérer les mises à jour, cache en secours.
const CACHE = 'rio-observer-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      try {
        const response = await fetch(request)
        if (response.ok) cache.put(request, response.clone())
        return response
      } catch {
        const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' })
        if (cached) return cached
        throw new Error('Hors ligne et ressource absente du cache')
      }
    })(),
  )
})
