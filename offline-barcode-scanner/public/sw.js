const CACHE = 'barcode-offline-v1';
const ASSETS = [
'/',
'/manifest.json',
];


self.addEventListener('install', (event) => {
event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});


self.addEventListener('activate', (event) => {
event.waitUntil(
caches.keys().then((keys) => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
);
});


self.addEventListener('fetch', (event) => {
const { request } = event;
if (request.method !== 'GET') return;


event.respondWith((async () => {
const cached = await caches.match(request);
if (cached) return cached;
try {
const fresh = await fetch(request);
const cache = await caches.open(CACHE);
cache.put(request, fresh.clone());
return fresh;
} catch (e) {
if (request.mode === 'navigate') return caches.match('/');
throw e;
}
})());
});