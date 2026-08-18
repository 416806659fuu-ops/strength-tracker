const CACHE = 'strength-tracker-v7';
// 这里的 ?v=7 要和 index.html 里 <script>/<link> 上的版本号完全一致——离线时
// 浏览器请求的是带版本号的那个网址，预缓存的键对不上就等于没缓存。改版本号要两边一起改。
const ASSETS = [
  './',
  './index.html',
  './style.css?v=7',
  './app.js?v=7',
  './strength.js?v=7',
  './session.js?v=7',
  './settings.js?v=7',
  './manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 跨域请求（Google Apps Script 的数据接口）直接走网络，不进缓存逻辑——
  // Cache API 也不支持缓存 POST 请求。
  if (url.origin !== location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }
  // 静态文件改成网络优先：「缓存优先 + 后台更新」意味着每次改完代码，用户
  // 手机上要连开两次才会真的用上新版本（第一次还在吃旧缓存，只是顺便把新
  // 版本存起来）——这正是"明明推送了、手机上还是不行"的根源。改成有网就
  // 直接用最新的，缓存只在离线时才当兜底。
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      // 离线兜底时忽略网址后面的 ?v= 之类参数，不然「强制更新」按钮加的
      // 时间戳会让缓存永远对不上，离线就彻底打不开了。
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
