const CACHE = "fam-sharp-ep5-v1";
/* build 2026-11-26 10:10: 清坏mp4缓存 + Range206 + getEps走CDN */
/* build 2026-11-24 10:35: 修复手机端旧缓存（styles.css?v=21 / app.js?v=21 强制新版本） */
/* install 时对带版本号的资源也强刷，确保 index.html 一更新，CSS/JS 立刻跟新 */
/* build 2026-11-23 23:35: 听写遮罩下音标保持显示 + 下载进度流式累计修复 */
/* build 2026-11-23 20:20: 登录持久化/进度恢复/下载重试/笔记即时显示/视频高度修复 */
/* shell refresh 2026-11-21: 视频内可拖动进度条 + iPad 主屏幕图标/平板布局 */
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "data/subtitles.json", "data/episodes.json", "data/rich.json"];
/* 所有剧集字幕也纳入强刷：旧版 rich.json 配新版 epN.json 会把英文单词从中间劈碎 */
for (let n = 1; n <= 26; n++) SHELL.push("data/ep" + n + ".json");

/* 保持 CACHE 名不变，避免清掉用户已下载的视频；仅强制刷新页面外壳。 */
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await Promise.all(SHELL.map(async (u) => {
      const url = new URL(u, self.location.href).href;
      try {
        const res = await fetch(new Request(url, { cache: "reload" }));
        if (res && res.ok) await c.put(url, res.clone());
      } catch (err) { /* 离线时沿用旧缓存 */ }
    }));
  }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k.startsWith("fam-sharp-ep5-") && k !== CACHE).map(k => caches.delete(k))
    );
    // 清「字幕/精修数据」旧缓存 + 清掉 mp4 的坏缓存（404/0字节/非206）
    // 好的整片视频一律保留，不用重新下载
    const c = await caches.open(CACHE);
    const reqs = await c.keys();
    await Promise.all(reqs
      .filter(r => /\/data\/[^/]+\.json($|\?)/.test(r.url))
      .map(r => c.delete(r)));
    await Promise.all(reqs
      .filter(r => r.url.endsWith(".mp4"))
      .map(async r => {
        try {
          const resp = await c.match(r);
          // 只删真正坏的：状态非200 或 体积过小（<1MB 的必是404页/残缺）
          if (!resp || resp.status !== 200) { await c.delete(r); return; }
          const blob = await resp.blob();
          if (blob.size < 1048576) await c.delete(r);
        } catch (err) { /* 读不出来先保留，交给 fetch 分支再校验 */ }
      }));
    await self.clients.claim();
  })());
});

/* ---------- 分片直供播放：整片不在缓存时，用分片切片/流式响应 ---------- */
/* 每次读缓存里的最新剧集清单，避免换视频版本后 SW 一直沿用旧配置、分片名对不上 */
const EPS_CDN = "https://cdn.jsdelivr.net/gh/a462316565/fam-sharp-parts@f00a2d3c0db9062f89baad310abae0c7cd52f134/data/episodes.json";
async function getEps() {
  // 数据走公共 CDN：先读缓存（app.js 以 CDN URL 为键写入），再兜底主动拉取
  const keys = [EPS_CDN, new URL("data/episodes.json", self.location.href).href];
  for (const k of keys) {
    try { const r = await caches.match(k); if (r) return await r.json(); } catch (err) {}
  }
  try {
    const r = await fetch(EPS_CDN, { cache: "reload" });
    if (r && r.ok) {
      const data = await r.json();
      const c = await caches.open(CACHE); c.put(EPS_CDN, new Response(JSON.stringify(data)));
      return data;
    }
  } catch (err) {}
  return null;
}
async function serveFromParts(req, pathname, cache) {
  const eps = await getEps();
  if (!eps) return null;
  const name = pathname.split("/").pop();
  const e = eps.find(x => x.ready && x.parts && x.video && x.video.split("/").pop() === name);
  if (!e) return null;
  const dir = e.video.replace(/[^/]*$/, "");
  const pd = e.partDir || ("ep" + e.ep);
  // 与 app.js partKey 同源：配了 partBase 就用 CDN 绝对地址，否则站点相对路径
  const pk = i => e.partBase
    ? (e.partBase.replace(/\/$/, "") + "/" + pd + "/p" + String(i).padStart(2, "0"))
    : new URL(dir + "parts/" + pd + "/p" + String(i).padStart(2, "0"), self.location.origin).href;
  const pl = e.partLen || 8388608;
  const size = e.size || pl * e.parts;
  let cachedN = 0;
  for (let i = 0; i < e.parts; i++) if (await cache.match(pk(i))) cachedN++;
  const range = req.headers.get("range");
  const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null;

  // 全部分片都在本地：精确 206 切片， seeking 秒完成
  if (cachedN === e.parts && m) {
    let start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const chunks = []; let p = start;
    while (p <= end) {
      const idx = Math.min(Math.floor(p / pl), e.parts - 1);
      const pr = await cache.match(pk(idx));
      if (!pr) break;
      const blob = await pr.blob();
      const off = p - idx * pl;
      const take = Math.min(blob.size - off, end - p + 1);
      if (take <= 0) break;
      chunks.push(blob.slice(off, off + take));
      p += take;
    }
    return new Response(new Blob(chunks, { type: "video/mp4" }), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes"
      }
    });
  }

  // 未下齐：边播边从网络拉分片（顺便写进缓存，之后天然断点续传）
  // 关键：浏览器带 Range 请求时必须回 206 + Content-Range，否则安卓/Edge 判 Format error
  const startByte = m ? Number(m[1]) : 0;
  const startIdx = Math.min(Math.floor(startByte / pl), e.parts - 1);
  const skipInPart = startByte - startIdx * pl;
  let idx = startIdx;
  let sent = 0;
  const stream = new ReadableStream({
    async pull(ctrl) {
      if (idx >= e.parts) { ctrl.close(); return; }
      const k = pk(idx);
      let pr = await cache.match(k);
      if (!pr) {
        try {
          const net = await fetch(k + "?dl=1");
          if (!net || !net.ok) { ctrl.close(); return; }
          cache.put(k, net.clone()).catch(() => {});
          pr = net;
        } catch (err) { ctrl.close(); return; }
      }
      const reader = pr.body.getReader();
      let partPos = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        if (idx === startIdx && skipInPart > 0 && partPos + value.byteLength <= skipInPart) {
          partPos += value.byteLength; continue;
        }
        if (idx === startIdx && skipInPart > partPos && skipInPart < partPos + value.byteLength) {
          chunk = value.slice(skipInPart - partPos);
        }
        if (m && m[2] && sent + chunk.byteLength > Number(m[2]) - startByte + 1) {
          chunk = chunk.slice(0, Number(m[2]) - startByte + 1 - sent);
        }
        if (chunk.byteLength) { ctrl.enqueue(chunk); sent += chunk.byteLength; }
        partPos += value.byteLength;
      }
      idx++;
    }
  });
  if (m) {
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return new Response(stream, {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${startByte}-${end}/${size}`,
        "Accept-Ranges": "bytes"
      }
    });
  }
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" }
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 下载器直连通道（?dl=1）：不拦截，页面自己拿流显示进度并存缓存
  if (url.search.includes("dl=1")) return;

  if (url.pathname.endsWith(".mp4")) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = url.origin + url.pathname;
      let res = await cache.match(key, { ignoreSearch: true });
      if (res && res.status !== 200) { await cache.delete(key); res = null; }
      if (res) {
        const range = req.headers.get("range");
        if (!range) return res;
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (!m) return res;
        const blob = await res.blob();
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), blob.size - 1) : blob.size - 1;
        if (start >= blob.size) {
          return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${blob.size}` } });
        }
        return new Response(blob.slice(start, end + 1), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${blob.size}`,
            "Accept-Ranges": "bytes"
          }
        });
      }
      // 整片未缓存：尝试用分片直接供给播放（已上架的分片课没有服务器整片）
      const served = await serveFromParts(req, url.pathname, cache);
      if (served) return served;
      // 未缓存：直通请求；服务器不支持 Range 会回 200 全量，顺便缓存起来
      res = await fetch(req);
      if (res && res.status === 200) {
        try { cache.put(key, res.clone()); } catch (err) { /* 空间不足时忽略 */ }
      }
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      // 页面外壳强制绕过 HTTP 缓存，保证更新后的代码一定能拿到
      const needsReload = req.mode === "navigate" ||
        /\.(js|css|json|webmanifest|html)$/.test(url.pathname);
      const res = await fetch(req, needsReload ? { cache: "reload" } : undefined);
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === "navigate") return (await caches.match("./")) || Response.error();
      return Response.error();
    }
  })());
});
