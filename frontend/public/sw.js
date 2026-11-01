const CACHE = "personal-memory-shell-v1";
const PRECACHE = ["/", "/manifest.webmanifest", "/icon.svg"];
const PRIVATE_PREFIXES = ["/backend/", "/api/", "/relay/"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("personal-memory-shell-") && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

function cacheable(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (PRIVATE_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return false;
  return request.mode === "navigate" || ["script", "style", "image", "font", "manifest", "worker"].includes(request.destination) || url.pathname.endsWith(".wasm");
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (!cacheable(request, url)) return;
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
        return response;
      } catch {
        return (await caches.match(request)) || (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  })());
});
