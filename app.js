/* 走遍美国精听 · 26 集可选，当前默认第5集 The Right Magic */
/* 缓存自检：新 app.js 若发现自己是从旧 HTML(?v<21) 加载的，强制 reload 以拿到新外壳。
   注：旧页面加载的是旧 app.js，不会执行此段——真正的破局靠 sw.js 更新触发 install 强刷 SHELL。 */
(function checkStale(){
  try {
    if (sessionStorage.getItem("fam_stale_reloaded")) return;
    const s = document.querySelector('script[src*="app.js"]');
    const m = s && /(?:^|[?&])v=(\d+)/.exec(s.getAttribute("src"));
    if (m && +m[1] < 53) {
      sessionStorage.setItem("fam_stale_reloaded", "1");
      location.reload(true);
    }
  } catch (e) {}
})();
const $ = (id) => document.getElementById(id);
const CACHE_NAME = "fam-sharp-ep5-v1";
/* 数据 CDN：字幕/精修/清单走 jsDelivr，避免慢站点阻塞首屏。
   与视频 partBase 同理——未配时回退站点相对路径，随时可关。 */
/* 用 commit hash 固定版本：@main 分支对已更新文件会缓存 12h+ 不刷新，
   commit hash 是永久缓存且立即生效（每次数据更新后改这里 + 上传数据即可）。 */
const DATA_BASE = "https://cdn.jsdelivr.net/gh/a462316565/fam-sharp-parts@782dadbe6d7086ad683bb561669ae9de94d7bab7/data";
function dataURL(rel) {
  if (!DATA_BASE) return rel;
  const name = (rel || "").split("/").pop();   // 只取文件名，统一映射到 CDN 的 data/ 目录
  return name ? DATA_BASE + "/" + name : rel;
}
/* 数据本地缓存：先渲染缓存里的字幕/精修（瞬时可见），后台再从 CDN 更新，
   下次打开不用等任何网络请求——这是「极速显示」的关键。 */
function dataCacheKey(rel) { return "fam_data_" + ((rel || "").split("/").pop()); }
function readDataCache(rel) {
  try { const s = localStorage.getItem(dataCacheKey(rel)); return s ? JSON.parse(s) : null; }
  catch (e) { return null; }
}
function writeDataCache(rel, val) {
  try { localStorage.setItem(dataCacheKey(rel), JSON.stringify(val)); } catch (e) { /* 配额满则忽略 */ }
}
let EPS = [];
let ep = { ep: 5, title: "The Right Magic", video: "media/ep5v2.mp4", subs: "data/subtitles.json", ready: true };
function videoURL(e) { return new URL(e.video, location.href).href; }
/* 视频 src 必须等 SW 接管后再设：站点本身没有 mp4 实体，全靠 SW 从 CDN 分片直供。
   若在 SW 激活前赋 src，浏览器会直接请求站点 mp4 → GitHub Pages 返回 404 → Format error。 */
let _swReady = null;
function swReady() {
  if (_swReady) return _swReady;
  _swReady = new Promise(res => {
    if (!("serviceWorker" in navigator)) return res(false);
    if (navigator.serviceWorker.controller) return res(true);
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearInterval(poll); clearTimeout(t); res(v); };
    // 轮询兜底：controllerchange 可能在监听前就触发过，必须以实际 controller 为准
    const poll = setInterval(() => { if (navigator.serviceWorker.controller) finish(true); }, 200);
    const t = setTimeout(() => finish(!!navigator.serviceWorker.controller), 8000);
    navigator.serviceWorker.addEventListener("controllerchange", () => finish(true), { once: true });
  });
  return _swReady;
}
let _blobUrl = null;
/* 从手机本地缓存合成完整视频，用 blob: URL 直接播。
   这条路不依赖 Service Worker——微信/QQ 内置浏览器 SW 常失效，视频请求直达站点会 404。
   已下载的视频就用它，未下载才回退 SW 直供。 */
async function tryBlobFromCache(e) {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const blobs = [];
    // 优先：已合成的整片。按文件名匹配，兼容旧域名缓存（迁站后 key 的 origin 变了）
    const wantName = (e.video || "").split("/").pop();
    const whole = await cache.match(videoURL(e), { ignoreSearch: true });
    if (whole && whole.ok) {
      const b = await whole.blob();
      if (b.size > 1048576) blobs.push(b);
    }
    if (!blobs.length && wantName) {
      const keys = await cache.keys();
      for (const k of keys) {
        try {
          if (k.url.split("/").pop().split("?")[0] !== wantName) continue;
          const r = await cache.match(k);
          if (!r || !r.ok) continue;
          const b = await r.blob();
          if (b.size > 1048576) { blobs.push(b); break; }
        } catch (err) {}
      }
    }
    // 否则：拼分片（先按当前 partKey 精确取；取不到则扫描缓存里同集的所有分片）
    if (!blobs.length && e.parts) {
      for (let i = 0; i < e.parts; i++) {
        const r = await cache.match(partKey(e, i));
        if (r) blobs.push(await r.blob());
      }
      if (blobs.length !== e.parts) {
        // 兼容旧版本缓存：扫描所有 key，挑文件名以 epN 开头的 pXX
        const pd = e.partDir || ("ep" + e.ep);
        const keys = await cache.keys();
        const found = keys
          .filter(r => /\/p\d{2}$/.test(r.url) && r.url.includes(pd))
          .sort((a, b) => a.url.localeCompare(b.url));
        if (found.length >= e.parts) {
          blobs.length = 0;
          for (const k of found.slice(0, e.parts)) {
            const r = await cache.match(k);
            if (r) blobs.push(await r.blob());
          }
        }
      }
      if (blobs.length !== e.parts) return false;
    }
    if (!blobs.length) return false;
    const merged = blobs.length === 1 ? blobs[0] : new Blob(blobs, { type: "video/mp4" });
    if (_blobUrl) URL.revokeObjectURL(_blobUrl);
    _blobUrl = URL.createObjectURL(merged);
    video.src = _blobUrl;
    video.load();
    return true;
  } catch (err) { return false; }
}
async function setVideoSrc(e) {
  const src = typeof e === "string" ? e : (e && e.video) || "";
  if (!src) return;
  // 第一优先：本地已下载 → blob 直播（微信里也能用）
  const epObj = (typeof e === "object" && e) ? e : (typeof EPS !== "undefined" ? EPS.find(x => x.video === src) : null);
  if (epObj && await tryBlobFromCache(epObj)) return;
  // 回退：等 SW 接管后用站点相对路径（SW 从 CDN 分片直供）
  await swReady();
  if (_blobUrl) { URL.revokeObjectURL(_blobUrl); _blobUrl = null; }
  if (video.getAttribute("src") !== src) video.setAttribute("src", src);
  video.load();
}

const video = $("video");
let subs = [], cur = -1, notes = {}, session = null, pending = null;
let noteTimer = null, saveSeq = 0;
let oneShot = 0, needRewind = true, internalPause = false;
let lockRenderIdx = -1; // 放一句就停后：强制文字停在本句，不被 timeupdate/seeked 重算到下一句
let dictIdx = -1, revealed = false, ACTS = {};
let answerMode = "both";  // 看答案模式：both=带英文(中英对照) / en=仅英文(藏中文)
let seekPending = false; // seek 未完成期间冻结渲染，避免 timeupdate 拿旧位置把画面刷回原句
/* 精修意群排版 */
let richAll = null, richCur = [];          // rich.json[集号] -> [{i,units,marks}]
let richOkEp = -1;                         // 已通过「与字幕同版」校验的集号
/* 学习进度：打开自动回到上次学的那一集那一句 */
const LS_EP = "fam_last_ep", LS_POS = "fam_last_pos";
let savePosT = 0, lockProgress = true; // 启动恢复完成前禁止写入，避免 cur=0 覆盖旧进度
function saveProgress(force = false) {
  if (lockProgress && !force) return;
  try {
    localStorage.setItem(LS_EP, String(ep.ep));
    localStorage.setItem(LS_POS, JSON.stringify({ i: cur, t: video.currentTime || 0, ts: Date.now() }));
  } catch (e) { /* 存储不可用时忽略 */ }
}
function readProgress() {
  try {
    const n = +(localStorage.getItem(LS_EP) || 0);
    const p = JSON.parse(localStorage.getItem(LS_POS) || "null");
    return { ep: n, i: (p && Number.isFinite(p.i)) ? p.i : -1, t: (p && Number.isFinite(p.t)) ? p.t : 0 };
  } catch (e) { return { ep: 0, i: -1, t: 0 }; }
}
let fontTier = 1, hidePh = false;
const FONT = [[22,16,13],[26,18,14],[31,21,16]]; // [en,cn,ph]

function fmt(t) {
  if (!isFinite(t)) return "0:00";
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add("hidden"), 2400);
}
function nl(text) { return (text || "").split(" / ").join("<br>"); }

/* ---------- 精修意群排版（照原书：音标上/英文中/中文下，逐意群对齐） ---------- */
function richEsc(s){ return (s||"").replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
/* 词级可点：把一段英文按空格切成单词 span，每个词带 data（用于点读/长按加词）。
   保留调用方的样式 class（弱读/删除线等）包在外层，词 span 只负责交互。 */
/* 词级可点：按整句英文的单词边界生成 span（跨 mark 切片的词只输出一次完整）。
   s0/s1 是当前样式片段在整句中的字符范围；用 window.__wordDone 去重。 */
/* 词级可点：在当前样式片段内按字符位置输出可点片段。
   同一单词即使被音标 mark 切成多段，也共用同一份 data（词/中文/位置/句号），
   点任一段都等同点这个完整单词；视觉上仍保留原书的字母级音标高亮。 */
function wordHtml(txt, charStart, cn, idx){
  if(!txt) return '';
  const parts = txt.split(/(\s+)/);
  let out='', pos=charStart;
  for(const p of parts){
    if(!p){ continue; }
    if(/^\s+$/.test(p)){ out += p; pos += p.length; continue; }
    // 以该字符在整句中的位置，向前找到词首、向后找到词尾，得到完整单词（跨 mark 切片也一致）
    const en = window.__richEn || '';
    let ws=pos, we=pos;
    while(ws>0 && /[A-Za-z0-9']/.test(en[ws-1])) ws--;
    while(we<en.length && /[A-Za-z0-9']/.test(en[we])) we++;
    const whole = (we>ws) ? en.slice(ws,we) : p.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g,'');
    const clean = (whole||p).replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g,'');
    out += '<span class="w"'+(clean?' data-w="'+richEsc(clean)+'" data-cn="'+richEsc(cn||'')+'" data-s="'+ws+'" data-i="'+idx+'"':'')+'>'+richEsc(p)+'</span>';
    pos += p.length;
  }
  return out;
}
/* 渲染单个意群块：英文按 mark 切成带样式段，音标浮在对应字母上方；中文在下方 */
function richBlockHtml(u, en, marks, idx){
  const a=u.a, b=u.b;
  const bm=marks.filter(m=> m.b>a && m.a<b).sort((x,y)=>x.a-y.a);
  let cuts=[a,b];
  bm.forEach(m=>{
    const p=Math.max(a,m.a), q=Math.min(b,m.b);
    if(p>a && p<b) cuts.push(p);
    if(q>a && q<b) cuts.push(q);
  });
  cuts=[...new Set(cuts)].sort((x,y)=>x-y);
  let enHtml='';
  for(let k=0;k<cuts.length-1;k++){
    const s0=cuts[k], s1=cuts[k+1];
    const covering=bm.filter(m=>m.a<=s0 && m.b>=s1);
    const txt=en.slice(s0,s1);
    let cls='tx';
    if(covering.some(m=>m.style==='ul')) cls+=' ul';
    if(covering.some(m=>m.style==='del')) cls+=' del';
    if(covering.some(m=>m.style==='gray2')) cls+=' gray2';
    if(covering.some(m=>m.style==='ydel')) cls+=' ydel';
    if(covering.some(m=>m.style==='steel')) cls+=' steel';
    // 同一音标 mark 只渲染一次：整段音标被字母级 mark 切成多段时，避免重复显示
    const withPh=covering.filter(m=>m.ph && !window.__phShown?.has(m));
    if(withPh.length){
      withPh.forEach(m=>{ if(!window.__phShown) window.__phShown=new Set(); window.__phShown.add(m); });
      const ph=withPh.map(m=>richEsc(m.ph)).join(' ');
      enHtml+='<span class="anno"><span class="ph">'+ph+'</span><span class="'+cls+'">'+wordHtml(txt,s0,u.cn,idx)+'</span></span>';
    }else{
      enHtml+='<span class="'+cls+'">'+wordHtml(txt,s0,u.cn,idx)+'</span>';
    }
  }
  return '<span class="blk"><span class="blk-ph"></span>'
       + '<span class="blk-en">'+enHtml+'</span>'
       + '<span class="blk-cn">'+richEsc(u.cn||'')+'</span></span>';
}
function renderRich(i){
  const box=$("sentCn");
  const r=richCur.find(x=>x.i===i);
  if(!r || !r.units || !r.units.length){
    box.innerHTML = richEsc((subs[i]&&subs[i].cn)||'');
    return;
  }
  // rich.json 的 a/b 基于归一化单空格文本；此处须同法归一化，避免双空格导致坐标错位
  const en=((subs[i]&&subs[i].en)||'').replace(/\s+/g,' ').trim();
  window.__richEn=en; window.__wordDone={idx:i,set:new Set()};
  const marks=r.marks||[];
  window.__phShown=new Set();   // 音标去重：本次渲染内每个 ph mark 只显示一次
  box.innerHTML='<span class="rich masked" id="richBox">'+r.units.map(u=>richBlockHtml(u,en,marks,i)).join('')+'</span>';
}
function setRichRevealed(on){
  const box=$("richBox");
  if(box){
    box.classList.toggle('masked', !on);
    box.classList.toggle('en-only', !!(on && answerMode === "en"));
  }
}
function applyRichFont(){
  const f=FONT[fontTier];
  document.documentElement.style.setProperty('--fs-en', f[0]+'px');
  document.documentElement.style.setProperty('--fs-cn', f[1]+'px');
  document.documentElement.style.setProperty('--fs-ph', f[2]+'px');
  const b=$("fontBtn"); if(b) b.textContent='A 字号：'+['小','中','大'][fontTier];
}

/* ---------- 字幕与单句精听 ---------- */
function findIdx(t) {
  if (!subs.length) return -1;
  let lo = 0, hi = subs.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (subs[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
function renderSentence(i) {
  const r = subs[i];
  $("sentSp").textContent = r.sp || "";
  $("sentIdx").textContent = `第 ${i + 1} / ${subs.length} 句`;
  renderRich(i);               // 精修意群排版（默认只显示中文）
  setRichRevealed(revealed);   // 听写状态：未答出时藏英文/音标
  $("actBadge").textContent = `Act ${r.act}`;
  document.querySelectorAll(".act-btn").forEach(b =>
    b.classList.toggle("on", b.dataset.act === String(r.act)));
  $("noteIdx").textContent = i + 1;
  $("noteSent").innerHTML = `<b>${r.sp || ""}</b> ${r.cnHtml || nl(r.cn)}<br>${r.enHtml || nl(r.en)}`;
  renderFavBar();
  showNativeLine();
  if (!$("noteModal").classList.contains("hidden")) showNoteText();
  // 记住「学到哪一集哪一句」，下次打开自动回到这里（节流写）
  if (i >= 0 && Date.now() - savePosT > 1200) { savePosT = Date.now(); saveProgress(); }
}
function render(force = false) {
  if (lockRenderIdx >= 0 && lockRenderIdx < subs.length) {
    if (cur !== lockRenderIdx || force) { cur = lockRenderIdx; renderSentence(lockRenderIdx); }
    syncSeek();
    return;
  }
  const i = findIdx(video.currentTime);
  if (i < 0) return;
  if (i !== cur || force) {
    if (i !== cur) cur = i;
    if (i !== dictIdx) { dictIdx = i; resetDict(); }
    renderSentence(i);
  }
}
/* 听写模式状态：每个新句子清空输入与反馈，重放同句则保留 */
const DICT_HINT = "听当前句的音频，输入你听到的英文再点「确认」；标点、大小写、删除线的弱读字母都判对。";
function resetDict() {
  revealed = false;
  answerMode = "both";   // 切句重置为带英文，避免点词后标签/状态不一致
  setRichRevealed(false);
  if ($("answerModeBtn")) { $("answerModeBtn").textContent = "带英文"; $("answerModeBtn").classList.remove("active"); }
  $("dictInput").value = "";
  const f = $("dictFb");
  f.className = "dict-fb";
  f.textContent = "";
}
function cancelOneShot() {
  lockRenderIdx = -1;
  if (oneShot < 0) return;
  oneShot = -1;
  $("oneBtn").classList.remove("active");
}
function syncPlayBtns() {
  $("cardPlayBtn").textContent = video.paused ? "▶ 播放" : "⏸ 暂停";
}
function playCurrent() {
  lockRenderIdx = -1;           // 用户重新播放：解除文字锁定
  if (oneShot >= 0 && needRewind && subs[oneShot]) {
    const target = Math.max(0, subs[oneShot].start + 0.01);
    safeSeek(target);
    cur = -1; render(true);
    // 手机慢缓冲时，seek 后浏览器可能把位置弹到已缓冲区间 → 多放一句。
    // 播放起来后再校验一次：偏离目标超过1.5秒就拉回来（只纠正一次，避免死循环）。
    setTimeout(() => {
      if (oneShot >= 0 && !video.paused && Math.abs(video.currentTime - target) > 1.5) {
        safeSeek(target);
      }
    }, 350);
  }
  needRewind = false;
  video.play().catch(() => {});
}
function safeSeek(t) {
  try { video.currentTime = t; return true; } catch (err) { return false; }
}
function endOneShot() {
  if (oneShot < 0) return;
  const idx = oneShot;
  oneShot = -1;                 // 先清标记，避免 seek/timeupdate 重入再触发
  lockRenderIdx = idx;          // 锁定文字停在本句
  internalPause = true;
  video.pause();
  // 定位点往本句内退 0.15 秒：确保 seek 后的时间仍落在本句，不会被 findIdx 算到下一句
  const stopAt = Math.max(subs[idx].start, subs[idx].end - 0.15);
  if (Math.abs(video.currentTime - stopAt) > 0.06) safeSeek(stopAt);
  video.pause();
  setTimeout(() => {
    if (!video.paused) { internalPause = true; video.pause(); internalPause = false; }
    // seeked 可能晚到，再锁一次文字
    lockRenderIdx = idx; cur = idx; renderSentence(idx); syncSeek();
  }, 80);
  internalPause = false;
  oneShot = idx;                // 保留标记，点播放时重听本句
  needRewind = true;
  cur = idx; renderSentence(idx); syncSeek();
  // 播完自动暂停：不弹提示（用户要求安静）
}
/* 字幕未加载时先补载再跳，避免按钮“没反应” */
function ensureSubsThen(fn) {
  toast("字幕还没加载好，正在补载…");
  loadSubs().then(ok => { if (ok) fn(); });
}
function go(i, play = false) {
  lockRenderIdx = -1;           // 用户切句：解除文字锁定
  if (!subs.length) { ensureSubsThen(() => go(i, play)); return; }
  i = Math.max(0, Math.min(subs.length - 1, i));
  needRewind = true;
  if (oneShot >= 0) oneShot = i;
  // 切句一律先静音暂停——只有点「播放/重放」才出声（用户要求）
  if (!video.paused) { internalPause = true; video.pause(); internalPause = false; }
  // 直接按目标句渲染，不等 seek 完成——安卓上 seek 期间 currentTime 可能还是旧值
  const target = Math.max(0, subs[i].start + 0.01);
  if (Math.abs(video.currentTime - target) > 0.05) seekPending = true;
  if (!safeSeek(target)) seekPending = false;
  cur = i;
  if (i !== dictIdx) { dictIdx = i; resetDict(); }
  renderSentence(i);
  syncSeek();
  if (play) playCurrent();
}
function next(play = true) { go(cur + 1, play); }
function prev(play = true) { go(cur - 1, play); }

/* ---------- 视频内可拖动进度条 ---------- */
let seeking = false;
function fmtDur() {
  $("durTime").textContent = fmt(video.duration || 0);
}
function syncSeek() {
  if (seeking) return;
  const d = video.duration;
  $("seek").value = (d && isFinite(d)) ? Math.round(video.currentTime / d * 1000) : 0;
  $("curTime").textContent = fmt(video.currentTime);
}
function seekByRange() {
  lockRenderIdx = -1;           // 用户拖进度条：解除文字锁定
  const d = video.duration;
  if (!d || !isFinite(d)) return;
  let t = Number($("seek").value) / 1000 * d;
  t = Math.max(0, Math.min(t, d - 0.05));
  if (Math.abs(video.currentTime - t) > 0.05) seekPending = true;
  if (!safeSeek(t)) seekPending = false;
  if (oneShot >= 0) { oneShot = Math.max(0, findIdx(t)); needRewind = false; }
  cur = -1; render(true); syncSeek();
}
$("seek").addEventListener("pointerdown", () => { seeking = true; });
$("seek").addEventListener("keydown", () => { seeking = true; });
$("seek").addEventListener("input", seekByRange);
["pointerup", "pointercancel", "keyup", "change"].forEach(ev =>
  $("seek").addEventListener(ev, () => { seeking = false; syncSeek(); })
);
video.addEventListener("loadedmetadata", fmtDur);
video.addEventListener("durationchange", fmtDur);

let lastTick = 0;
/* 放一句就停的判定：到达本句 end，或播放位置已经进了下一句（seek 不准/end 标错时兜底） */
function oneShotShouldStop(t) {
  if (oneShot < 0 || !subs[oneShot]) return false;
  if (t >= subs[oneShot].end - 0.03) return true;
  // 已越过本句进入下一句：说明本句实际已放完（哪怕 end 时间标长了）
  if (oneShot + 1 < subs.length && t >= subs[oneShot + 1].start - 0.05) return true;
  return false;
}
video.addEventListener("timeupdate", () => {
  lastTick = Date.now();
  const t = video.currentTime;
  if (oneShotShouldStop(t)) { endOneShot(); return; }
  if (!seekPending) render();
  syncSeek();
});
/* 兼容不触发 timeupdate 的浏览器：播放中定时补跑同一套逻辑，放一句就停也能停 */
setInterval(() => {
  if (video.paused || !subs.length) return;
  if (Date.now() - lastTick < 1500) return;
  lastTick = Date.now();
  const t = video.currentTime;
  if (oneShotShouldStop(t)) { endOneShot(); return; }
  if (!seekPending) render();
  syncSeek();
}, 600);
$("centerPlay").addEventListener("click", () => { video.paused ? playCurrent() : video.pause(); });
$("cardPlayBtn").addEventListener("click", () => { video.paused ? playCurrent() : video.pause(); });
$("repeatBtn").addEventListener("click", () => go(cur, true));
video.addEventListener("play", syncPlayBtns);
video.addEventListener("pause", () => {
  if (!internalPause && oneShot >= 0) { oneShot = Math.max(0, cur); needRewind = false; }
  syncPlayBtns();
});
video.addEventListener("ended", () => { cancelOneShot(); syncPlayBtns(); });
// seek 完成后按实际位置校正显示（拖进度条/跳转都可能不触发 timeupdate）
video.addEventListener("seeked", () => { seekPending = false; cur = -1; render(true); syncSeek(); });
$("prevBtn").addEventListener("click", () => prev(false));
$("nextBtn").addEventListener("click", () => next(false));
$("oneBtn").addEventListener("click", () => {
  if (!subs.length) return;
  if (oneShot >= 0) { cancelOneShot(); toast("已关闭放一句就停，可连续播放"); return; }
  oneShot = Math.max(0, cur);
  needRewind = true;
  $("oneBtn").classList.add("active");
  toast("已开启放一句就停");
});

/* ---------- 地道翻译 / 直译 切换 ---------- */
let nativeMode = false;   // false=直译(默认) / true=地道翻译
function nativeKey(){ return "fam_native_" + ep.ep + "_" + cur; }
function showNativeLine(){
  const line=$("nativeLine"); if(!line) return;
  if(!nativeMode || cur<0){ line.classList.add("hidden"); line.textContent=""; return; }
  const r=subs[cur]; if(!r) return;
  const cached=(()=>{try{return localStorage.getItem(nativeKey())}catch(e){return null}})();
  line.classList.remove("hidden");
  line.innerHTML = cached
    ? '<b>地道：</b>'+esc(cached)
    : '<b>地道：</b><span class="msg">生成中…</span>';
}
async function genNative(){
  if(!session){ toast("地道翻译需要先登录（点底部登录）"); return; }
  const r=subs[cur]; if(!r) return;
  const cached=(()=>{try{return localStorage.getItem(nativeKey())}catch(e){return null}})();
  nativeMode=true; showNativeLine();
  if(cached) return;
  try{
    const model=await ensureAiModel();
    const res=await cloud.llm.chat.completions.create({
      model, stream:false,
      messages:[
        {role:"system",content:"你是英语翻译专家。把用户给的英文句子翻译成自然、地道、简洁的中文口语。只输出中文译文一行，不要解释、不要标注、不要复述英文。"},
        {role:"user",content:r.en}
      ]
    });
    let out = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
    if(!out && res && res.choices && res.choices[0] && res.choices[0].delta) out=res.choices[0].delta.content;
    out=(out||"").trim().split("\n")[0];
    if(!out) throw new Error("empty");
    try{ localStorage.setItem(nativeKey(), out); }catch(e){}
    if(nativeMode) showNativeLine();
  }catch(e){
    if(nativeMode){
      const line=$("nativeLine");
      if(line){
        line.innerHTML='<b>地道：</b><span class="ai-err">生成失败，请重试</span>';
        // 失败提示几秒后自动收起，不一直挂着
        setTimeout(()=>{ if(nativeMode && line.textContent.includes("生成失败")){ nativeMode=false; showNativeLine(); if($("nativeBtn")){ $("nativeBtn").textContent="地道翻译"; $("nativeBtn").classList.remove("active"); } } }, 3500);
      }
    }
  }
}
if($("nativeBtn")) $("nativeBtn").onclick = ()=>{
  if(!subs.length || cur<0) return;
  nativeMode = !nativeMode;
  $("nativeBtn").textContent = nativeMode ? "直译" : "地道翻译";
  $("nativeBtn").classList.toggle("active", nativeMode);
  showNativeLine();
  if(nativeMode) genNative();
};

/* ---------- 点单词从该词播放 / 长按加入错音·单词表 ---------- */
const LS_MISPRO = "fam_mispronunciation";   // 错音列表
const LS_WORDS  = "fam_wordlist";           // 单词列表
function loadList(key){ try{ return JSON.parse(localStorage.getItem(key)||"[]"); }catch(e){ return []; } }
function saveList(key,v){ try{ localStorage.setItem(key,JSON.stringify(v)); }catch(e){ toast("存储已满"); } }
function addToWordList(kind, w, cn){
  const key = kind==="mispro" ? LS_MISPRO : LS_WORDS;
  const list = loadList(key);
  // 同一集同一词不重复
  const epn = (typeof ep!=="undefined"&&ep)?ep.ep:0;
  if(list.some(x=>x.w.toLowerCase()===w.toLowerCase() && x.ep===epn)){
    toast(kind==="mispro"?"错音表里已有这个词":"单词表里已有这个词"); return;
  }
  list.push({w, cn, ep:epn, ts:Date.now()});
  saveList(key,list);
  toast((kind==="mispro"?"已加错音表：":"已加单词表：")+w);
}
let _wordPressTimer=null, _wordPressEl=null, _wordMoved=false, _wordStartX=0, _wordStartY=0;
document.addEventListener("pointerdown", (e)=>{
  const w = e.target.closest(".w");
  if(!w) return;
  _wordPressEl=w; _wordMoved=false; _wordStartX=e.clientX; _wordStartY=e.clientY;
  clearTimeout(_wordPressTimer);
  _wordPressTimer=setTimeout(()=>{ if(!_wordMoved && _wordPressEl===w) showWordMenu(w); }, 600);
}, true);
document.addEventListener("pointermove", (e)=>{
  if(_wordPressEl && (Math.abs(e.clientX-_wordStartX)>10 || Math.abs(e.clientY-_wordStartY)>10)) _wordMoved=true;
}, true);
document.addEventListener("pointerup", ()=>{ clearTimeout(_wordPressTimer); _wordPressEl=null; }, true);
document.addEventListener("pointercancel", ()=>{ clearTimeout(_wordPressTimer); _wordPressEl=null; }, true);
// 单击单词：从该词位置播放本句
document.addEventListener("click", (e)=>{
  const w = e.target.closest(".w");
  if(!w) return;
  if(_wordJustMenu){ _wordJustMenu=false; return; }  // 刚弹过长按菜单，抑制这次点击
  const i = +w.dataset.i, s = +w.dataset.s;
  if(!subs[i]) return;
  // 该词在本句的位置比例 → 时间
  const r = subs[i];
  const ratio = Math.max(0, Math.min(0.95, s / Math.max(1,(r.en||"").length)));
  const t = r.start + (r.end - r.start)*ratio;
  if(oneShot>=0){ oneShot=i; }
  lockRenderIdx = -1;
  go(i, false);          // go 内部会 pause 并 seek 到句首
  needRewind = false;    // 关键：不让 playCurrent 再拉回句首
  safeSeek(t);           // 定位到所点单词
  video.play().catch(()=>{});   // 从该词直接播放
}, true);
// 点菜单以外任何地方：关闭长按菜单
document.addEventListener("pointerdown", (e)=>{
  const m=$("wordMenu");
  if(m && !m.classList.contains("hidden") && !e.target.closest("#wordMenu") && !e.target.closest(".w")){
    closeWordMenu();
  }
}, true);
let _wordJustMenu=false;
function closeWordMenu(){
  $("wordMenu").classList.add("hidden");
  $("wordMenuMask").classList.add("hidden");
}
function showWordMenu(w){
  _wordJustMenu=true; setTimeout(()=>{_wordJustMenu=false;},400);
  $("wordMenuWord").textContent = w.dataset.w;
  $("wordMenu").dataset.w = w.dataset.w;
  $("wordMenu").dataset.cn = w.dataset.cn;
  $("wordMenuMask").classList.remove("hidden");   // 全屏遮罩：点任何空白处都能关
  $("wordMenu").classList.remove("hidden");
}
$("wordMenuMask").addEventListener("click", closeWordMenu);
$("wordMenuMask").addEventListener("pointerdown", closeWordMenu);
$("wordMenuAddMispro").onclick = ()=>{ const m=$("wordMenu"); addToWordList("mispro", m.dataset.w, m.dataset.cn); closeWordMenu(); };
$("wordMenuAddWord").onclick = ()=>{ const m=$("wordMenu"); addToWordList("word", m.dataset.w, m.dataset.cn); closeWordMenu(); };
$("wordMenuCancel").onclick = closeWordMenu;
// 两个列表页面：渲染 + 导出
function renderListPage(kind){
  const key = kind==="mispro" ? LS_MISPRO : LS_WORDS;
  const list = loadList(key);
  const box = kind==="mispro" ? $("misproList") : $("wordListBox");
  const cnt = kind==="mispro" ? $("misproCount") : $("wordCount");
  if(cnt) cnt.textContent = "("+list.length+")";
  if(!list.length){ box.innerHTML='<p class="muted">还没有收录单词。长按句子里的单词即可添加。</p>'; return; }
  box.innerHTML = list.map((x,i)=>'<div class="wl-row"><b>'+richEsc(x.w)+'</b> <span class="muted">'+richEsc(x.cn||'')+'</span>'
    +' <span class="msg">第'+x.ep+'集</span> <button class="mini" data-del="'+i+'">删</button></div>').join('');
  box.querySelectorAll("[data-del]").forEach(b=>{
    b.onclick=()=>{ const arr=loadList(key); arr.splice(+b.dataset.del,1); saveList(key,arr); renderListPage(kind); };
  });
}
function exportList(kind){
  const key = kind==="mispro" ? LS_MISPRO : LS_WORDS;
  const list = loadList(key);
  if(!list.length){ toast("列表是空的"); return; }
  const text = list.map(x=>x.w+" "+(x.cn||"")).join("\n");
  const blob = new Blob([text], {type:"text/plain;charset=utf-8"});
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download = (kind==="mispro"?"错音表":"单词表")+".txt";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast("已导出 "+list.length+" 个词");
}
$("misproBtn").onclick = ()=>{ renderListPage("mispro"); $("misproModal").classList.remove("hidden"); };
$("wordBtn").onclick = ()=>{ renderListPage("word"); $("wordModal").classList.remove("hidden"); };
$("closeMispro").onclick = ()=>$("misproModal").classList.add("hidden");
$("closeWord").onclick = ()=>$("wordModal").classList.add("hidden");
$("exportMispro").onclick = ()=>exportList("mispro");
$("exportWord").onclick = ()=>exportList("word");

/* 滑动切句 */
let tx = 0, ty = 0;
$("stage").addEventListener("touchstart", (e) => {
  tx = e.changedTouches[0].clientX; ty = e.changedTouches[0].clientY;
}, { passive: true });
$("stage").addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - tx;
  const dy = e.changedTouches[0].clientY - ty;
  if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
    dx < 0 ? prev(false) : next(false);
  }
}, { passive: true });
document.addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (e.key === "ArrowRight") { e.preventDefault(); next(false); }
  if (e.key === "ArrowLeft") { e.preventDefault(); prev(false); }
  if (e.key === " ") { e.preventDefault(); video.paused ? playCurrent() : video.pause(); }
});

/* 倍速 */
const SPEEDS = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6];
SPEEDS.forEach(s => {
  const b = document.createElement("button");
  b.textContent = s.toFixed(1) + "×";
  b.onclick = () => { video.playbackRate = s; $("speedBtn").textContent = s.toFixed(1) + "×"; $("speedPanel").classList.remove("open"); toast("倍速 " + s.toFixed(1) + "×"); };
  $("speedPanel").appendChild(b);
});
function togglePanel(id) {
  const p = $(id); const open = p.classList.contains("open");
  document.querySelectorAll(".panel").forEach(x => x.classList.remove("open"));
  if (!open) p.classList.add("open");
}
$("speedBtn").onclick = () => togglePanel("speedPanel");
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) document.querySelectorAll(".panel").forEach(x => x.classList.remove("open"));
});

/* 精修排版：发音标开关 + 字号三档 */
$("phToggle").addEventListener("click", () => {
  hidePh = !hidePh;
  document.body.classList.toggle("hide-ph", hidePh);
  $("phToggle").classList.toggle("active", !hidePh);
  localStorage.setItem("fam_hide_ph", hidePh ? "1" : "0");
  toast(hidePh ? "发音标已隐藏" : "发音标已显示");
});
$("fontBtn").addEventListener("click", () => {
  fontTier = (fontTier + 1) % 3;
  applyRichFont();
  localStorage.setItem("fam_font_tier", fontTier);
});

/* ---------- 登录 ---------- */
function setAuthUI() {
  $("authBtn").textContent = session ? (session.user?.name || "已登录") : "登录同步笔记";
}
/* 登录态本地兜底：SDK 的 session 在部分手机浏览器关闭后会丢，
   这里额外持久化一份，下次打开先用它恢复「已登录」，再让 SDK 后台校准。 */
const LS_SESSION = "fam_auth_session";
function saveSessionLocal(s) {
  try { localStorage.setItem(LS_SESSION, JSON.stringify(s)); } catch (e) {}
}
function readSessionLocal() {
  try { return JSON.parse(localStorage.getItem(LS_SESSION) || "null"); } catch (e) { return null; }
}
async function restoreAuth() {
  // 第一步：无条件先用本地缓存恢复「已登录」界面，绝不因 SDK/CDN 失败而退化成未登录
  if (!session) { const cached = readSessionLocal(); if (cached) session = cached; }
  setAuthUI();
  try {
    const url = new URL(location.href);
    if (url.searchParams.has("code") || url.searchParams.has("error")) {
      const provider = url.searchParams.get("provider");
      if (provider === "wechat" && typeof cloud.auth.handleWechatWebCallback === "function") {
        const { data, error } = await cloud.auth.handleWechatWebCallback();
        if (error) { toast("微信登录失败：" + (error.message || "请重试")); }
        else if (data) {
          session = data; saveSessionLocal(data);
          for (const k of ["code", "state", "provider"]) url.searchParams.delete(k);
          history.replaceState(null, "", url.pathname + url.search + url.hash);
        }
      } else if (url.searchParams.has("error")) {
        toast("登录未完成，请重试");
      }
    }
    const { data, error } = await cloud.auth.getSession();
    if (!error && data) {
      session = data; saveSessionLocal(data); await loadNotes();
    } else if (!session) {
      // SDK 没恢复出来，用本地兜底；保持已登录，笔记仍可本地用
      const cached = readSessionLocal();
      if (cached) { session = cached; await loadNotes().catch(() => {}); }
    }
  } catch (e) {
    if (!session) { const cached = readSessionLocal(); if (cached) session = cached; }
  }
  setAuthUI();
}
/* 微信登录在新域名（github.io）回调不在白名单，已移除；保留手机号验证码登录。 */
$("authBtn").onclick = async () => {
  if (session) {
    if (confirm("退出登录？本地笔记仍保留，云端笔记不会删除。")) {
      await cloud.auth.signOut(); session = null; notes = {};
      try { localStorage.removeItem(LS_SESSION); } catch (e) {}
      setAuthUI(); toast("已退出");
    }
    return;
  }
  $("authModal").classList.remove("hidden");
};
$("closeAuth").onclick = () => $("authModal").classList.add("hidden");
$("sendCode").onclick = async () => {
  const phone = $("phone").value.trim();
  if (!/^1\d{10}$/.test(phone)) { $("authMsg").textContent = "请输入正确的 11 位手机号"; return; }
  $("authMsg").textContent = "发送中…";
  const r = await cloud.auth.sendOtp({ phone });
  if (r.error) { $("authMsg").textContent = r.error.message || "发送失败"; return; }
  pending = { phone, ...r.data };
  $("authMsg").textContent = "验证码已发送，请填写后登录";
};
$("loginBtn").onclick = async () => {
  if (!pending || pending.phone !== $("phone").value.trim()) {
    $("authMsg").textContent = "请先获取当前手机号的验证码"; return;
  }
  $("authMsg").textContent = "登录中…";
  const r = await cloud.auth.verifyOtp({
    phone: pending.phone, verificationId: pending.verificationId,
    isExistingUser: pending.isExistingUser, token: $("code").value.trim()
  });
  if (r.error) { $("authMsg").textContent = r.error.message || "登录失败"; return; }
  session = r.data; pending = null; saveSessionLocal(r.data);
  $("authModal").classList.add("hidden"); setAuthUI();
  await loadNotes(); toast("登录成功，笔记已同步");
};

/* ---------- 云笔记 ---------- */
async function loadNotes() {
  if (!session) return;
  try {
    const { data, error } = await cloud.database.from("listening_notes")
      .select("sentence_index,content").eq("episode", ep.ep);
    if (error) throw error;
    notes = {};
    (data || []).forEach(n => { notes[n.sentence_index] = n.content || ""; });
    loadLocalNotes();
    renderNoteList(); renderFavBar(); showNoteText();
  } catch (e) {
    // 云端暂时读不到：静默用本机收藏兜底，不打扰用户
    loadLocalNotes();
    renderNoteList(); renderFavBar(); showNoteText();
  }
}
/* 本地收藏（未登录时也能用，存在手机里） */
function localKey() { return "fam_local_notes_ep" + ep.ep; }
function loadLocalNotes() {
  try {
    const o = JSON.parse(localStorage.getItem(localKey()) || "{}");
    for (const k in o) if (!(k in notes)) notes[k] = o[k];
    renderFavBar();
  } catch (e) { /* 忽略 */ }
}
function saveLocalNote(k, text) {
  try {
    const o = JSON.parse(localStorage.getItem(localKey()) || "{}");
    o[k] = text;
    localStorage.setItem(localKey(), JSON.stringify(o));
  } catch (e) { /* 忽略 */ }
}
function removeLocalNote(k) {
  try {
    const o = JSON.parse(localStorage.getItem(localKey()) || "{}");
    delete o[k];
    localStorage.setItem(localKey(), JSON.stringify(o));
  } catch (e) { /* 忽略 */ }
}
/* 把文本追加进第 cur 句笔记（云同步或本地）
   关键：先更新内存与界面，让收藏/笔记「第一时间显示在下方」，云端同步放后台。 */
async function appendNote(text) {
  if (cur < 0) return;
  const merged = (notes[cur] ? notes[cur] + "\n\n" : "") + text;
  notes[cur] = merged;
  $("noteText").value = merged;
  // 立刻渲染，不等网络
  renderFavBar(); renderNoteList(); showNoteText();
  // 让收藏内容立刻可见：把底部操作区滚到收藏条（小屏上它可能在折叠下方）
  try {
    const bar = $("favBar");
    if (bar && !bar.classList.contains("hidden")) {
      bar.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  } catch (e) {}
  if (session) {
    saveNote().catch(() => {}); // 后台同步，不阻塞界面
  } else {
    saveLocalNote(cur, merged);
    toast("已收藏到本地笔记（登录后可云端同步）");
  }
}
/* 收藏区（页面最下方）：只显示当前句子的收藏详情内容 */
function renderFavBar() {
  const bar = $("favBar"), list = $("favChips");
  const has = cur >= 0 && notes[cur];
  if (!has) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  list.innerHTML = '<div class="fav-item"><p>' + esc(notes[cur] || "").replace(/\n/g, "<br>") + '</p></div>';
}
$("favBtn").onclick = async () => {
  if (cur < 0 || !subs.length) { ensureSubsThen(() => {}); return; }
  const r = subs[cur];
  const input = $("dictInput").value.trim();
  const fb = $("dictFb").innerText.trim();
  const lines = [`【第${cur + 1}句】${r.sp || ""} ${r.en}`, `中文：${r.cn}`];
  if (input) lines.push(`我的听写：${input}`);
  if (fb && !fb.startsWith(DICT_HINT)) lines.push(fb);
  await appendNote(lines.join("\n"));
  if (session) toast("已收藏到笔记（云端同步）");
};
function showNoteText() {
  if (cur < 0) return;
  $("noteText").value = notes[cur] || "";
  $("noteStatus").textContent = notes[cur] ? "已同步" : "未写笔记";
}
async function saveNote() {
  if (!session || cur < 0) return;
  const text = $("noteText").value;
  const seq = ++saveSeq;
  $("noteStatus").textContent = "同步中…";
  if (!text.trim()) {
    const { error } = await cloud.database.from("listening_notes")
      .delete().eq("episode", ep.ep).eq("sentence_index", cur);
    if (!error) { delete notes[cur]; renderNoteList(); renderFavBar(); }
  } else {
    const { data: existing, error: qerr } = await cloud.database.from("listening_notes")
      .select("id").eq("episode", ep.ep).eq("sentence_index", cur).maybeSingle();
    if (qerr) { $("noteStatus").textContent = "查询失败"; return; }
    const payload = { content: text, updated_at: new Date().toISOString() };
    let error;
    if (existing) {
      ({ error } = await cloud.database.from("listening_notes").update(payload).eq("id", existing.id));
    } else {
      ({ error } = await cloud.database.from("listening_notes")
        .insert({ episode: ep.ep, sentence_index: cur, ...payload }));
    }
    if (!error) notes[cur] = text;
  }
  if (seq !== saveSeq) return;
  $("noteStatus").textContent = "已同步到云端";
  renderNoteList();
}
function renderNoteList() {
  const box = $("noteList"); box.innerHTML = "";
  const keys = Object.keys(notes).map(Number).sort((a, b) => a - b);
  if (!keys.length) { box.textContent = "还没有笔记。"; return; }
  keys.forEach(k => {
    const d = document.createElement("div"); d.className = "note-item";
    const t = document.createElement("b"); t.textContent = `第 ${k + 1} 句`;
    t.onclick = () => { $("noteModal").classList.add("hidden"); go(k, false); };
    const p = document.createElement("p"); p.textContent = notes[k];
    d.append(t, p); box.appendChild(d);
  });
}
/* ---------- 笔记导出 / 导入（换账号、换设备时保住收藏） ---------- */
function collectLocalNotes() {
  const all = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = /^fam_local_notes_ep(\d+)$/.exec(k || "");
      if (!m) continue;
      const o = JSON.parse(localStorage.getItem(k) || "{}");
      all[m[1]] = Object.assign(all[m[1]] || {}, o);
    }
  } catch (e) {}
  return all;
}
async function collectCloudNotes() {
  const all = {};
  if (!session) return all;
  for (const e of (EPS.length ? EPS : [{ ep: ep.ep }])) {
    try {
      const { data, error } = await cloud.database.from("listening_notes")
        .select("sentence_index,content").eq("episode", e.ep);
      if (!error && data && data.length) {
        all[String(e.ep)] = all[String(e.ep)] || {};
        data.forEach(n => { all[String(e.ep)][n.sentence_index] = n.content || ""; });
      }
    } catch (err) {}
  }
  return all;
}
$("exportNotes").onclick = async () => {
  $("exportNotes").disabled = true;
  const btn = $("exportNotes"); const old = btn.textContent;
  btn.textContent = "导出中…";
  try {
    const local = collectLocalNotes();
    toast(session ? "正在收集云端笔记，请稍候…" : "正在收集本地笔记…");
    const cloudData = await collectCloudNotes();
    // 合并：云端为底，本地覆盖（本地通常是最新的收藏）
    const all = {};
    const keys = new Set([...Object.keys(cloudData), ...Object.keys(local)]);
    keys.forEach(k => { all[k] = Object.assign({}, cloudData[k] || {}, local[k] || {}); });
    const payload = {
      _format: "zoubianmeiguo-notes", _version: 1,
      exportedAt: new Date().toISOString(),
      noteCount: Object.values(all).reduce((n, o) => n + Object.keys(o).length, 0),
      notes: all
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0") + "_" + String(d.getHours()).padStart(2,"0") + String(d.getMinutes()).padStart(2,"0");
    a.href = url; a.download = "走遍美国笔记_" + stamp + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("已导出 " + payload.noteCount + " 条笔记，请保存好这个文件");
  } catch (e) {
    toast("导出失败：" + (e && e.message || e));
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
};
$("importNotes").onclick = () => { $("importFile").value = ""; $("importFile").click(); };
$("importFile").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const data = JSON.parse(text);
    if (!data || data._format !== "zoubianmeiguo-notes" || !data.notes) {
      toast("这不是本应用导出的笔记文件"); return;
    }
    const btn = $("importNotes"); btn.disabled = true;
    toast("正在导入笔记…");
    let imported = 0;
    for (const epNum of Object.keys(data.notes)) {
      const o = data.notes[epNum] || {};
      // 写本地
      try {
        const key = "fam_local_notes_ep" + epNum;
        const cur = JSON.parse(localStorage.getItem(key) || "{}");
        Object.assign(cur, o);
        localStorage.setItem(key, JSON.stringify(cur));
      } catch (e) {}
      imported += Object.keys(o).length;
      // 登录时也写云端
      if (session) {
        for (const idx of Object.keys(o)) {
          try {
            const { data: existing } = await cloud.database.from("listening_notes")
              .select("id").eq("episode", +epNum).eq("sentence_index", +idx).maybeSingle();
            const payload = { content: o[idx], updated_at: new Date().toISOString() };
            if (existing) await cloud.database.from("listening_notes").update(payload).eq("id", existing.id);
            else await cloud.database.from("listening_notes").insert({ episode: +epNum, sentence_index: +idx, ...payload });
          } catch (e) {}
        }
      }
    }
    btn.disabled = false;
    toast("已导入 " + imported + " 条笔记");
    // 刷新当前页显示
    notes = {}; loadLocalNotes();
    if (session) await loadNotes().catch(() => {});
    renderNoteList(); renderFavBar(); showNoteText();
  } catch (e) {
    toast("导入失败：" + (e && e.message || e));
  }
});

$("noteBtn").onclick = () => {
  $("noteModal").classList.remove("hidden");
  notes = {};
  loadLocalNotes();
  if (session) { loadNotes().catch(() => {}); }
  else { renderNoteList(); showNoteText(); toast("未登录：收藏存在本机，可用「导出笔记」备份"); }
};
$("closeNote").onclick = () => { clearTimeout(noteTimer); saveNote(); $("noteModal").classList.add("hidden"); };
$("noteText").addEventListener("input", () => {
  clearTimeout(noteTimer);
  $("noteStatus").textContent = "等待输入…";
  noteTimer = setTimeout(async () => {
    const text = $("noteText").value;
    if (cur >= 0) notes[cur] = text;
    if (!session) {
      // 未登录：立刻存本地并明确提示，不让状态卡在"等待输入…"
      if (text.trim()) { saveLocalNote(cur, text); $("noteStatus").textContent = "已存本机（登录后可云端同步）"; }
      else { removeLocalNote(cur); $("noteStatus").textContent = "未写笔记"; }
      renderNoteList(); renderFavBar();
      return;
    }
    await saveNote();
  }, 800);
});
$("delNote").onclick = async () => {
  if (cur < 0) return;
  $("noteText").value = "";
  notes[cur] = "";
  if (session) await saveNote().catch(() => {});
  removeLocalNote(cur); renderFavBar(); renderNoteList();
  $("noteStatus").textContent = "已删除本句笔记";
  toast("已删除本句笔记");
};
// 「删除本句」收藏条按钮：删除当前句的收藏/笔记（原"清空全部"无绑定，点了没反应）
function deleteCurFav() {
  if (cur < 0) { toast("请先选一句"); return; }
  if (!confirm("删除本句的收藏笔记？")) return;
  notes[cur] = "";
  if (!$("noteModal").classList.contains("hidden")) $("noteText").value = "";
  if (session) saveNote().catch(() => {});
  removeLocalNote(cur);
  renderFavBar(); renderNoteList();
  toast("已删除本句收藏");
}
if ($("favDel")) $("favDel").onclick = deleteCurFav;

/* ---------- 离线缓存（按课管理） ---------- */
function metaKey(e) { return "fam_offline_meta_ep" + e.ep; }
async function isCached(e) {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    // 情况一：整片已缓存且完整
    const hit = await cache.match(videoURL(e), { ignoreSearch: true });
    if (hit) {
      if (e.size) {
        let n = Number(hit.headers.get("content-length") || 0);
        if (!n) { try { n = (await hit.blob()).size; } catch (err) {} }
        if (n && n < e.size * 0.9) return false;
      }
      return true;
    }
    // 情况二：全部分片齐全（SW 能直接从分片供给播放，无需合成整片）
    if (e.parts && e.parts > 0) {
      let n = 0;
      for (let i = 0; i < e.parts; i++) if (await cache.match(partKey(e, i))) n++;
      if (n === e.parts) return true;
    }
    return false;
  } catch (err) { return false; }
}
function offlineLabel(e) {
  try {
    const m = JSON.parse(localStorage.getItem(metaKey(e)) || "null");
    if (!m) return "已下载 ✓";
    const d = new Date(m.ts);
    return `已下载 ✓ ${(m.size / 1048576).toFixed(0)}MB · ${d.getMonth() + 1}/${d.getDate()}`;
  } catch (err) { return "已下载 ✓"; }
}
async function checkOffline() {
  if (!("caches" in window)) { $("offlineBadge").textContent = "不支持离线"; return false; }
  const hit = await isCached(ep);
  $("offlineBadge").textContent = hit ? "已离线" : "在线";
  $("downloadBtn").textContent = hit ? offlineLabel(ep) : "一键离线下载";
  $("redownloadBtn").classList.toggle("hidden", !hit);
  return !!hit;
}
$("offlineBtn").onclick = async () => {
  const hit = await isCached(ep);
  if (hit) {
    toast(`第${ep.ep}集已接上手机本地缓存，直接播放不用流量`);
    await checkOffline();
  } else {
    toast("尚未下载，建议 Wi-Fi 下点「一键离线下载」，或打开「选课」下载");
  }
};
/* 分片并行下载：服务器不支持 Range，把视频切成多个独立分片文件、6 线程并发，
   每片下完立即存入 Cache（断点续传），全部到齐后合成完整视频并清理分片。 */
const DL_CONCURRENCY = 3; // 手机网络 3 并发更稳，6 并发在弱网下容易全部超时
function partKey(e, i) {
  const pd = e.partDir || ("ep" + e.ep);
  const name = "p" + String(i).padStart(2, "0");
  // 配了 partBase（jsDelivr CDN）就从 CDN 拉分片；未配则维持原来的站点相对路径
  if (e.partBase) return e.partBase.replace(/\/$/, "") + "/" + pd + "/" + name;
  return videoURL(e).replace(/[^/]*$/, "") + `parts/${pd}/` + name;
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    else if (!on && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  } catch (err) { /* 不支持则忽略 */ }
}
document.addEventListener("visibilitychange", () => {
  // 回到前台时若还在下载，重新申请屏幕常亮
  if (document.visibilityState === "visible" && Object.values(dlBusy).some(Boolean)) keepAwake(true);
});
async function downloadEp(e, onProgress) {
  if (!("caches" in window)) throw new Error("当前浏览器不支持离线缓存");
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await keepAwake(true);
  const cache = await caches.open(CACHE_NAME);
  // 确保剧集清单已缓存：SW 从分片供给播放时必须用它找到分片目录
  try {
    const epsUrl = new URL("data/episodes.json", location.href).href;
    if (!(await cache.match(epsUrl))) {
      const er = await fetch(dataURL("data/episodes.json"));
      if (er.ok) await cache.put(epsUrl, er.clone());
    }
  } catch (err) {}
  // 已完成的分片直接计入（断点续传）——按实际 blob 大小算，不依赖 content-length 头
  let done = 0;
  const missing = [];
  for (let i = 0; i < e.parts; i++) {
    const r = await cache.match(partKey(e, i));
    if (r) { try { done += (await r.blob()).size; } catch (err) {} }
    else missing.push(i);
  }
  const report = () => onProgress && onProgress(
    e.size ? Math.min(99, Math.round(done / e.size * 100)) : -1, done, e.size || done);
  report(); // 起步就上报一次（已有断点分片会立即显示进度），而非空等第一片
  if (missing.length) onProgress && onProgress(-1, done, e.size || done);
  // 分片并发下载：每个分片独立缓存（断点续传）；服务器不支持 Range，只能整片拉取
  let idx = 0, failed = 0;
  const fetchPart = async (i) => {
    for (let k = 0; k < 5; k++) {
      let received = 0, lastRep = 0;
      try {
        const res = await fetch(partKey(e, i) + "?dl=1", { cache: "no-store" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        // 服务器单连接很慢，8MB 分片要下很久；边收边累计字节，进度签才不会一直卡在 0MB
        const chunks = [];
        if (res.body && res.body.getReader) {
          const reader = res.body.getReader();
          for (;;) {
            const { done: fin, value } = await reader.read();
            if (fin) break;
            if (!value || !value.byteLength) continue;
            chunks.push(value);
            received += value.byteLength;
            done += value.byteLength;
            if (received - lastRep >= 262144) { lastRep = received; report(); }
          }
        } else {
          const buf = await res.arrayBuffer();
          chunks.push(new Uint8Array(buf));
          received = buf.byteLength;
          done += received;
        }
        if (!received) throw new Error("空分片");
        report();
        await cache.put(partKey(e, i), new Response(new Blob(chunks, { type: "application/octet-stream" }), {
          headers: { "Content-Type": "application/octet-stream", "Content-Length": String(received) }
        }));
        return;
      } catch (err) {
        if (received) { done -= received; report(); } // 失败回滚，避免进度虚高
        if (k === 4) failed++;
        else await new Promise(r => setTimeout(r, 600 * (k + 1)));
      }
    }
  };
  const worker = async () => {
    while (idx < missing.length) {
      const i = missing[idx++];
      await fetchPart(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DL_CONCURRENCY, missing.length) }, worker));
  if (failed) throw new Error(`${failed}个分片失败，请再点一次续传`);
  // 全部分片到齐即算下载成功！SW 已支持从分片直接供给播放（含拖动），无需合成整片。
  // 合成整片只是"后台优化"，手机内存/配额不足时会失败——绝不能因此判定下载失败。
  localStorage.setItem(metaKey(e), JSON.stringify({ size: e.size, ts: Date.now(), parts: e.parts }));
  report && onProgress && onProgress(100, e.size, e.size);
  await keepAwake(false);
  // 后台尝试合成整片（失败静默，分片仍可正常离线播放）
  (async () => {
    try {
      const blobs = [];
      for (let i = 0; i < e.parts; i++) {
        const r = await cache.match(partKey(e, i));
        if (!r) return;
        blobs.push(await r.blob());
      }
      const blob = new Blob(blobs, { type: "video/mp4" });
      await cache.put(videoURL(e), new Response(blob, {
        headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" }
      }));
      for (let i = 0; i < e.parts; i++) await cache.delete(partKey(e, i));
    } catch (err) { /* 合成失败不影响：分片已足够离线播放 */ }
  })();
}
async function deleteEp(e) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(videoURL(e), { ignoreSearch: true });
  if (hit) await cache.delete(videoURL(e), { ignoreSearch: true });
  for (let i = 0; i < (e.parts || 0); i++) await cache.delete(partKey(e, i));
  localStorage.removeItem(metaKey(e));
}
/* ===== 多任务下载管理：逐个点下载，全部排队下完，每行独立显示进度 ===== */
const dlTasks = {};          // ep -> {state:'queued'|'running'|'done'|'error', pct, got, total, text}
const DL_MAX_PARALLEL = 2;   // 同时最多 2 个下载，避免抢带宽导致全部超时
function dlRender() {
  const panel = $("dlPanel");
  if (!panel) return;
  const rows = Object.values(dlTasks).filter(t => t && t.state !== "done");
  if (!rows.length) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
  panel.classList.remove("hidden");
  panel.innerHTML = rows.map(t =>
    `<span class="dl-row${t.state === "done" ? " done" : ""}">${t.text || "第" + t.ep + "集 排队中"}</span>`
  ).join("");
}
function dlSet(ep, patch) {
  dlTasks[ep] = Object.assign({ ep, state: "queued", text: "第" + ep + "集 排队中" }, dlTasks[ep] || {}, patch);
  dlRender();
}
async function dlPump() {
  const running = Object.values(dlTasks).filter(t => t && t.state === "running").length;
  if (running >= DL_MAX_PARALLEL) return;
  const next = Object.values(dlTasks).find(t => t && t.state === "queued");
  if (!next) return;
  dlSet(next.ep, { state: "running", text: "第" + next.ep + "集 连接中…" });
  dlRun(next).finally(() => {
    setTimeout(() => { delete dlTasks[next.ep]; dlRender(); }, 2500); // 完成后保留 2.5 秒再消失
    dlPump();                                                        // 空出位置，接着下一个
  });
}
async function dlRun(task) {
  const e = EPS.find(x => x.ep === task.ep) || task.e;
  if (e.ep === ep.ep) $("downloadBtn").disabled = true;
  try {
    await downloadEp(e, (pct, got, total) => {
      dlSet(task.ep, {
        pct,
        text: `第${task.ep}集 ${pct >= 0 ? pct + "%" : ""} ${(got / 1048576).toFixed(0)}MB${total ? "/" + (total / 1048576).toFixed(0) + "MB" : ""}`
      });
    });
    dlSet(task.ep, { state: "done", text: `第${task.ep}集 完成 ✓` });
    toast(`第${task.ep}集已存到手机本地，以后看永远不卡、不用流量`);
  } catch (err) {
    dlSet(task.ep, { state: "error", text: `第${task.ep}集 中断·再点续传` });
    toast(`第${task.ep}集下载中断(${err && err.message || err})；已完成的分片已保存，再点一次会接着下`);
  }
  dlBusy[task.ep] = false;
  renderEpList();
  if (e.ep === ep.ep) { $("downloadBtn").disabled = false; checkOffline().catch(() => {}); }
}
async function startDownload(e) {
  if (dlBusy[e.ep] || (dlTasks[e.ep] && ["queued", "running"].includes(dlTasks[e.ep].state))) {
    toast(`第${e.ep}集已在下载队列，看底部进度`); return;
  }
  if (await isCached(e)) {
    toast(`第${e.ep}集已经下载过，直接看`);
    if (e.ep === ep.ep) await checkOffline();
    return;
  }
  dlBusy[e.ep] = true;
  dlSet(e.ep, { state: "queued", e, text: `第${e.ep}集 排队中` });
  toast(`第${e.ep}集已加入下载队列`);
  dlPump();   // 有空位就开始
}
/* 页面重开时：发现下了一半的分片就自动接着下 */
async function autoResume() {
  const cache = await caches.open(CACHE_NAME);
  const pending = [];
  for (const e of EPS.filter(x => x.ready)) {
    if (await isCached(e)) continue;
    let n = 0;
    for (let i = 0; i < e.parts; i++) if (await cache.match(partKey(e, i))) n++;
    if (n > 0 && n < e.parts) pending.push(e);
  }
  // 全部加入队列逐个续传（原实现遇到第一个就 return，导致只续传一集）
  for (const e of pending) startDownload(e);
}
async function downloadVideo() { await startDownload(ep); }
$("downloadBtn").onclick = async () => {
  if (await isCached(ep)) {
    await checkOffline();
    toast("已接上本地缓存，无需重新下载；要覆盖请点「重新下载」");
    return;
  }
  await downloadVideo();
};
$("redownloadBtn").onclick = downloadVideo;

/* ---------- 选课列表（26 集）+ 下载管理 ---------- */
const dlBusy = {};
async function refreshStorageInfo() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      $("storageInfo").textContent =
        `已用 ${(est.usage / 1048576).toFixed(0)}MB · 当前配额 ${(est.quota / 1073741824).toFixed(1)}GB（安装成 App 后自动申请持久存储，普通浏览器的配额限制基本碰不到）`;
    }
  } catch (err) { /* 忽略 */ }
}
async function switchEpisode(e) {
  lockRenderIdx = -1;
  if (!e.ready || e.ep === ep.ep) { $("epModal").classList.add("hidden"); return; }
  $("epModal").classList.add("hidden");   // 立刻收起，点「看这课」马上有反应
  toast(`正在切换到第${e.ep}集…`);
  try {
    ep = e;
    // 立刻清掉上一集的精修，防止「新字幕+旧精修」串台（中文配错英文）
    richCur = []; richOkEp = -1; subs = [];
    $("epLabel").textContent = `第${e.ep}集 · ${e.title}`;
    setVideoSrc(e);
    notes = {}; aiForIdx = -1; aiHist = [];
    cur = -1; dictIdx = -1; needRewind = true;
    if (oneShot >= 0) oneShot = 0;
    // loadSubs 内部：先用缓存立刻渲染（零等待），后台再拉最新字幕+精修
    loadSubs().then(() => {
      buildActs();
      if (cur >= 0) renderSentence(cur);
    });
    saveProgress();
    renderEpList();
    toast(`已切换到第${e.ep}集 ${e.title}`);
    // 离线检查、云端笔记放后台，不卡住切课
    checkOffline().catch(() => {});
    if (session) loadNotes().catch(() => {});
    else { notes = {}; loadLocalNotes(); renderNoteList(); showNoteText(); }
  } catch (err) {
    toast("切换失败：" + (err.message || "请重试"));
  }
}
function epRow(e) {
  const row = document.createElement("div");
  row.className = "ep-row" + (e.ep === ep.ep ? " current" : "") + (e.ready ? "" : " locked");
  const name = document.createElement("div");
  name.className = "ep-name";
  name.innerHTML = `<b>第${e.ep}集</b> ${esc(e.title)}`;
  const st = document.createElement("span");
  st.className = "ep-status";
  if (!e.ready) st.textContent = "未上传";
  else st.textContent = e.ep === ep.ep ? "当前" : "在线";
  row.append(name, st);
  if (!e.ready) return row;
  // 「看这课」同步建好，点击立刻生效；缓存状态/下载按钮异步补，不再拖慢或吞掉点击
  const play = document.createElement("button");
  play.className = "primary"; play.textContent = "看这课";
  play.onclick = () => switchEpisode(e);
  row.appendChild(play);
  (async () => {
    const cached = await isCached(e);
    if (cached) { st.textContent = offlineLabel(e); st.classList.add("ok"); }
    if (cached) {
      const del = document.createElement("button");
      del.className = "del"; del.textContent = "删除";
      del.onclick = async () => {
        if (!confirm(`删除第${e.ep}集的本地视频？以后可重新下载。`)) return;
        await deleteEp(e);
        renderEpList(); await checkOffline(); refreshStorageInfo();
        toast(`已删除第${e.ep}集本地视频`);
      };
      row.insertBefore(del, play);
    } else {
      const dl = document.createElement("button");
      dl.textContent = "下载";
      dl.onclick = () => startDownload(e);
      row.insertBefore(dl, play);
    }
  })();
  return row;
}
function renderEpList() {
  const box = $("epList"); box.innerHTML = "";
  EPS.forEach(e => box.appendChild(epRow(e)));
  refreshStorageInfo();
}
$("epBtn").onclick = () => { renderEpList(); $("epModal").classList.remove("hidden"); };
$("epClose").onclick = () => $("epModal").classList.add("hidden");

/* ---------- 三幕精准跳转 ---------- */
function buildActs() {
  ACTS = {};
  subs.forEach((s, i) => { if (!(s.act in ACTS)) ACTS[s.act] = i; });
}
document.querySelectorAll(".act-btn").forEach(b => {
  b.addEventListener("click", () => {
    const a = b.dataset.act;
    const jump = () => {
      if (!(a in ACTS)) { toast("本集没有第" + a + "幕"); return; }
      go(ACTS[a], false);
      toast("已精准跳到第" + a + "幕开头");
    };
    if (!subs.length) { ensureSubsThen(jump); return; }
    jump();
  });
});

/* ---------- 听写模式：逐词比对并解释错误原因 ---------- */
function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
/* 从 enRaw 解析每个词：full=含弱读字母的完整形式，req=去掉《r》删除线字母后的必需形式。
   删除线（弱读）字母可以不写——只要用户写到 req 就判对。 */
function parseEnWords(raw) {
  let s = (raw || "").replace(/《b》[\s\S]*?《\/b》/g, " ");
  s = s.replace(/《r》/g, "\u0001").replace(/《\/r》/g, "\u0002")
    .replace(/《[^》]*》/g, "");
  const words = [];
  let buf = "", req = "", inR = false;
  const flush = () => {
    if (/[A-Za-z0-9]/.test(buf)) {
      words.push({
        disp: buf,
        full: buf.toLowerCase().replace(/[^a-z0-9']/g, ""),
        req: req.toLowerCase().replace(/[^a-z0-9']/g, "")
      });
    }
    buf = ""; req = "";
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\u0001") { inR = true; continue; }
    if (ch === "\u0002") { inR = false; continue; }
    if (/[\s,.;:!?\-—–]/.test(ch)) { flush(); continue; }
    buf += ch;
    if (!inR) req += ch;
  }
  flush();
  return words;
}
function getEnWords(r) {
  if (!r._enWords) r._enWords = parseEnWords(r.enRaw || r.en);
  return r._enWords;
}
function normTok(w) {
  return w.toLowerCase().replace(/[\u2019\u2018]/g, "'")
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}
function edist(a, b) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > 3) return 99;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0).map((_, j) => j));
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
      dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[n][m];
}
function diffTokens(A, B, matchFn) {
  const n = A.length, m = B.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = matchFn(A[i], B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (matchFn(A[i], B[j])) { ops.push({ t: "ok", ai: i, bi: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "ins", ai: i }); i++; }
    else { ops.push({ t: "del", bi: j }); j++; }
  }
  while (i < n) { ops.push({ t: "ins", ai: i }); i++; }
  while (j < m) { ops.push({ t: "del", bi: j }); j++; }
  return ops;
}
function analyzeDict(ops, Uorig, Twords) {
  const issues = [];
  let bd = [], bi = [];
  const flush = () => {
    const k = Math.min(bd.length, bi.length);
    for (let x = 0; x < k; x++) {
      const t = Twords[bd[x].bi], u = Uorig[bi[x].ai];
      const tn = t.req || t.full;
      const kind = edist(u, tn) <= (tn.length >= 4 ? 2 : 1) ? "spell" : "wrong";
      bd[x].kind = kind; bi[x].kind = kind;
      issues.push({ kind, u, t: t.disp });
    }
    bd.slice(k).forEach(o => {
      const t = Twords[o.bi];
      // 整词弱读（req 为空）的词漏写不算错
      o.kind = t.req ? "miss" : "opt";
      if (o.kind === "miss") issues.push({ kind: "miss", t: t.disp });
    });
    bi.slice(k).forEach(o => { o.kind = "extra"; issues.push({ kind: "extra", u: Uorig[o.ai] }); });
    bd = []; bi = [];
  };
  for (const o of ops) {
    if (o.t === "ok") flush();
    else if (o.t === "del") bd.push(o);
    else bi.push(o);
  }
  flush();
  return issues;
}
function renderDictFb(issues, ops, Twords, optSkipped) {
  const f = $("dictFb");
  const r = subs[cur];
  const enH = r ? (r.enHtml || nl(r.en)) : "";
  const hasErr = issues.length > 0;
  let html = "";
  if (!hasErr) {
    f.className = "dict-fb ok";
    f.innerHTML = "\u2705 完全正确！点「下一句」继续，或「重放」再听一遍。" +
      (optSkipped ? `<div class="fb-line">省略了 ${optSkipped} 个删除线弱读字母，判对 ✓</div>` : "") +
      `<div class="dict-diff">${enH}</div>`;
    return;
  }
  f.className = "dict-fb bad";
  const lead = issues.every(x => x.kind === "spell")
    ? "意思写对了，但有拼写错误："
    : "还没全对，原因如下：";
  html += `<div class="fb-line">${lead}</div>`;
  issues.forEach(it => {
    if (it.kind === "spell")
      html += `<div class="fb-line"><span class="spell">拼写</span>：你写了「${esc(it.u)}」，正确是「<b>${esc(it.t)}</b>」</div>`;
    else if (it.kind === "wrong")
      html += `<div class="fb-line"><span class="wrong">用错词</span>：你写了「${esc(it.u)}」，这里应该是「<b>${esc(it.t)}</b>」</div>`;
    else if (it.kind === "miss")
      html += `<div class="fb-line"><span class="miss">漏了</span>：「<b>${esc(it.t)}</b>」</div>`;
    else
      html += `<div class="fb-line"><span class="extra">多了</span>：「${esc(it.u)}」（这句里没有）</div>`;
  });
  let diff = "";
  for (const o of ops) {
    if (o.t === "ins") continue;
    const w = Twords[o.bi];
    diff += o.t === "ok" ? esc(w.disp) + " " : `<span class="t-${o.kind}">${esc(w.disp)}</span> `;
  }
  html += `<div class="dict-diff">${diff.trim()}</div>`;
  f.innerHTML = html;
}
function matchWord(u, w) {
  // 写出完整形式或只写必需部分（省略删除线弱读字母）都算对
  return u === w.full || (w.req && u === w.req);
}
function checkDictation() {
  const r = subs[cur];
  if (!r) { if (!subs.length) ensureSubsThen(checkDictation); else toast("先播放到某一句再听写"); return; }
  const input = $("dictInput").value.trim();
  if (!input) { toast("先输入你听到的英文，再点确认"); return; }
  const Utoks = (input.match(/[A-Za-z0-9']+/g) || []).map(normTok);
  const Twords = getEnWords(r);
  const ops = diffTokens(Utoks, Twords, matchWord);
  const issues = analyzeDict(ops, Utoks, Twords);
  if (!issues.length) {
    revealed = true;
    setRichRevealed(true);
    if ($("answerModeBtn")) $("answerModeBtn").textContent = answerMode==="en" ? "仅英文" : "带英文";
    const optSkipped = ops.filter(o => o.t === "del" && o.kind === "opt").length;
    renderDictFb([], ops, Twords, optSkipped);
  } else {
    renderDictFb(issues, ops, Twords);
  }
}
$("dictCheck").addEventListener("click", checkDictation);
function revealAnswer(mode){
  const r = subs[cur]; if (!r) return;
  answerMode = mode;
  revealed = true;
  setRichRevealed(true);
  if ($("answerModeBtn")) { $("answerModeBtn").textContent = mode==="en" ? "仅英文" : "带英文"; $("answerModeBtn").classList.toggle("active", mode==="en"); }
  const input = $("dictInput").value.trim();
  const f = $("dictFb");
  const hasRich = !!(richCur.find(x=>x.i===cur) || {}).units;
  const modeWord = mode==="en" ? "（仅英文）" : "（带英文）";
  if (input) {
    const Utoks = (input.match(/[A-Za-z0-9']+/g) || []).map(normTok);
    const Twords = getEnWords(r);
    const ops = diffTokens(Utoks, Twords, matchWord);
    renderDictFb(analyzeDict(ops, Utoks, Twords), ops, Twords);
    f.innerHTML += `<div class="fb-line">${modeWord}答案已在上方亮出，对照一下，再点「重放」听两遍加深印象。</div>`;
  } else {
    f.className = "dict-fb bad";
    f.innerHTML = modeWord+`答案已在上方亮出。点「重放」听两遍，再自己输入试试。`
      + (hasRich ? '' : `<div class="dict-diff">${r.enHtml || nl(r.en)}</div>`);
  }
}
$("answerModeBtn").addEventListener("click", ()=>{
  // 单次点击在两种模式间切换
  revealAnswer(answerMode==="both" ? "en" : "both");
});
$("dictInput").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (revealed) { next(false); $("dictInput").blur(); }
  else checkDictation();
});

/* ---------- 免费问 AI（云服务免密钥大模型） ---------- */
const AI_SYS = "你是一位教中国英语初学者的英语老师，学生正在精听《走遍美国》系列课程。请用简体中文回答，讲解简洁清楚、适合初学者；需要举例时给简短例句；拆分意群时用『 / 』分隔；不要输出与问题无关的内容。";
const AI_CHIPS = [
  ["意群拆分", "请把这句英文按意群拆开（意群之间用 / 分隔），逐个意群解释中文意思，并指出哪里可以连读、弱读。"],
  ["为什么用这个词", "请挑出这句里最关键的一两个词或短语，讲解为什么这里这么用、能不能换成别的说法、区别在哪。"],
  ["语法讲解", "请用适合英语初学者的简单话讲清这句话的语法结构（主语、谓语、时态等）。"],
  ["逐词直译", "请逐词直译这句话：严格按英文词序，虚词（冠词、介词、助动词等）也要译出来，不要意译。"],
];
let aiModelId = null, aiHist = [], aiConvId = "", aiForIdx = -1, aiBusy = false, aiAbort = null;
async function ensureAiModel() {
  if (aiModelId) return aiModelId;
  const res = await cloud.llm.models.list();
  const list = Array.isArray(res) ? res : (res && res.data) || [];
  const m = list.find(x => x.disabled !== true);
  if (!m) throw new Error("当前没有可用的 AI 模型");
  aiModelId = m.id;
  return aiModelId;
}
function cleanAiOut(t){
  if(!t) return t;
  // 去掉 AI 常带的问题复述行 / markdown 标题行，只留简洁答案
  return t.split("\n").filter(line=>{
    const x=line.trim();
    if(!x) return false;
    if(/^\*\*.*\*\*$/.test(x)) return false;          // **标题**
    if(/^#{1,4}\s/.test(x)) return false;                 // # 标题
    if(/^(请把|请|帮我).{0,80}(拆开|讲解|翻译|直译)/.test(x)) return false; // 复述用户问题
    if(/^(意群拆分与讲解|语法讲解|为什么用这个词|逐词直译|地道翻译)/.test(x)) return false;
    return true;
  }).join("\n");
}
function aiRender(out, q) {
  // 只显示简洁答案，不显示用户问题前缀
  $("aiBox").textContent = out ? cleanAiOut(out) : "…";
  $("aiBox").scrollTop = 1e6;
}
let lastAiQ = "", lastAiOut = "";
async function aiAsk(q) {
  if (aiBusy || cur < 0) return;
  q = (q || "").trim();
  if (!q) return;
  if (!session) {
    $("aiBox").innerHTML = '<span class="ai-err">问 AI 需要先登录：点底部「登录同步笔记」，用手机号验证码登录一次即可。</span>';
    $("authModal").classList.remove("hidden");
    return;
  }
  const r = subs[cur];
  const ctx = `当前句子（第${cur + 1}句，说话人：${r.sp || "未知"}）：\n英文：${r.en}\n中文：${r.cn}`;
  aiBusy = true;
  $("aiSend").disabled = true;
  $("aiStop").classList.remove("hidden");
  aiRender("思考中…", q);
  aiAbort = new AbortController();
  let out = "";
  try {
    const model = await ensureAiModel();
    const msg = ctx + "\n\n我的问题：" + q;
    const msgs = [{ role: "system", content: AI_SYS }, ...aiHist, { role: "user", content: msg }];
    for await (const chunk of cloud.llm.chat.completions.create({
      model, stream: true, messages: msgs,
      conversationId: aiConvId, signal: aiAbort.signal
    })) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) { out += d.content; aiRender(out, q); }
    }
    aiHist.push({ role: "user", content: msg });
    if (out.trim()) { aiHist.push({ role: "assistant", content: out }); lastAiQ = q; lastAiOut = out; }
    if (aiHist.length > 8) aiHist = aiHist.slice(-8);
    if (!out.trim()) $("aiBox").innerHTML += "\n（AI 没有返回内容，请重试）";
  } catch (e) {
    if (e && (e.name === "AbortError")) {
      aiRender(out, q);
      if (out) $("aiBox").innerHTML += "\n（已停止）";
    } else {
      const code = (e && e.error && e.error.code) || "";
      let m = (e && e.error && e.error.message) || e.message || "未知错误";
      if (code.startsWith("quota_")) m = "AI 用量已达限额，请稍后再试";
      else if (code.startsWith("auth_")) m = "登录已过期，请重新用手机号登录";
      else if (code.startsWith("gateway_") || code.startsWith("model_")) m = "AI 服务暂时不可用，请稍后重试";
      $("aiBox").innerHTML += `<span class="ai-err">\n出错：${esc(m)}</span>`;
      $("aiBox").scrollTop = 1e6;
    }
  } finally {
    aiBusy = false; aiAbort = null;
    $("aiSend").disabled = false;
    $("aiStop").classList.add("hidden");
  }
}
AI_CHIPS.forEach(([label, prompt]) => {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => aiAsk(prompt);
  $("aiChips").appendChild(b);
});
$("aiBtn").onclick = () => {
  if (cur < 0) return;
  $("aiModal").classList.remove("hidden");
  const r = subs[cur];
  $("aiIdx").textContent = cur + 1;
  $("aiSent").innerHTML = `<b>${r.sp || ""}</b> ${r.cnHtml || nl(r.cn)}<br>${r.enHtml || nl(r.en)}`;
  if (aiForIdx !== cur) {
    aiForIdx = cur;
    aiHist = [];
    lastAiOut = "";
    aiConvId = "ep" + ep.ep + "-s" + cur + "-" + Date.now();
    $("aiBox").textContent = "点上面的快捷问题，或在下面输入你的问题。";
  }
};
$("aiClose").onclick = () => { if (aiAbort) aiAbort.abort(); $("aiModal").classList.add("hidden"); };
$("aiFav").onclick = async () => {
  if (!lastAiOut) { toast("先让 AI 回答一次，再收藏"); return; }
  const r = subs[cur];
  await appendNote(`【AI讲解·第${cur + 1}句】${r.sp || ""} ${r.en}\n答：${lastAiOut}`);
  // 关掉弹窗并滚到收藏条，立刻看到收藏结果
  $("aiModal").classList.add("hidden");
  try { $("favBar").scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch(e) {}
  toast("AI 讲解已收藏到下方");
};
$("aiSend").onclick = () => { aiAsk($("aiInput").value); $("aiInput").value = ""; };
$("aiStop").onclick = () => { if (aiAbort) aiAbort.abort(); };
$("aiInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    aiAsk($("aiInput").value); $("aiInput").value = "";
  }
});

/* ---------- 安装到手机（PWA 一键安装，一次下载一劳永逸） ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvt = e;
  $("installBtn").classList.remove("hidden");
});
window.addEventListener("appinstalled", () => {
  installEvt = null;
  $("installBtn").classList.add("hidden");
  toast("安装完成！以后从桌面图标打开，缓存和进度永久保留");
});
$("installBtn").onclick = async () => {
  if (!installEvt) {
    toast("当前浏览器不支持一键安装：用 Chrome 菜单里的「添加到主屏幕」也可以");
    return;
  }
  installEvt.prompt();
  const res = await installEvt.userChoice.catch(() => null);
  if (res && res.outcome === "accepted") toast("正在安装，装好后从桌面图标打开");
  installEvt = null;
  $("installBtn").classList.add("hidden");
};

/* 页面改为正常文档流（视频在上、内容往下排），不再需要给 fixed dock 预留空间。
   底部留白交给 CSS 的 body padding-bottom + safe-area 处理。 */

/* ---------- 启动 ---------- */
/* rich.json 必须与字幕同版：每句 units 拼回的英文须等于字幕英文。
   手机 SW 若拿到旧版 rich 缓存（120句）配新版字幕（242句），旧坐标会把英文单词
   从中间劈碎、中文串台。这里做逐句校验，不匹配就退化为普通中文，绝不显示碎句。 */
function richMatches(arr) {
  if (!Array.isArray(arr) || arr.length !== subs.length) return false;
  const nm = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  for (let k = 0; k < subs.length; k++) {
    const u = arr[k] && arr[k].units;
    if (!u || !u.length) return false;
    if (nm(u.map(x => x.en || "").join(" ")) !== nm(subs[k].en)) return false;
  }
  return true;
}
async function loadRich(force) {
  if (!force && richOkEp === ep.ep) return;
  let got = null;
  for (let a = 0; a < 3; a++) {
    try {
      // 第 2 次起强制绕 HTTP/SW 缓存，排除旧版 rich 残留
      // jsDelivr 对带查询串的请求会 403，故 CDN 分支用固定 URL + cache:reload 绕过缓存
      const url = dataURL("data/rich.json") + (a && !DATA_BASE ? "?rv=" + Date.now() + "_" + a : "");
      const r = await fetch(url, (a || DATA_BASE) ? { cache: "reload" } : undefined);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (!data || typeof data !== "object") throw new Error("bad rich");
      got = data;
      const arr = data[String(ep.ep)] || [];
      if (richMatches(arr)) {
        richAll = data; richCur = arr; richOkEp = ep.ep;
        writeDataCache("data/rich.json", data);   // 缓存下来，下次打开瞬时显示
        return;
      }
    } catch (e) { /* 换下一种取法重试 */ }
    await new Promise(res => setTimeout(res, 700));
  }
  if (got) richAll = got;
  richCur = []; richOkEp = -1;
  toast("精修数据与字幕版本不一致，已暂用普通中文；下拉刷新或点「检查离线」可重试");
}
async function loadSubs() {
  // ① 先用本地缓存立刻填好字幕+精修，让首屏零等待
  const cSub = readDataCache(ep.subs);
  const cRichAll = readDataCache("data/rich.json");
  if (Array.isArray(cSub) && cSub.length) {
    subs = cSub;
    if (cRichAll && typeof cRichAll === "object") {
      const arr = cRichAll[String(ep.ep)] || [];
      if (richMatches(arr)) { richAll = cRichAll; richCur = arr; richOkEp = ep.ep; }
    }
    buildActs(); render(true);   // 缓存内容立即可见
  }
  // ② 后台从 CDN/站点拉最新数据，拿到后静默刷新（不影响已显示内容）
  let fresh = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(dataURL(ep.subs));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (Array.isArray(data) && data.length) { fresh = data; break; }
      throw new Error("字幕文件为空");
    } catch (e) { await new Promise(res => setTimeout(res, 600)); }
  }
  if (fresh) {
    subs = fresh; writeDataCache(ep.subs, fresh);
    const changed = !subs.length || !cSub || JSON.stringify(cSub) !== JSON.stringify(fresh);
    richOkEp = -1;
    await loadRich(true);
    if (changed) { buildActs(); render(true); }   // 数据变了才重绘
    return true;
  }
  if (!subs.length) toast("字幕加载失败：请检查网络后刷新页面重试");
  return false;
}
(async function init() {
  // 顶级兜底：无论中途出什么错，6 秒后一定解锁进度写入，绝不锁死
  setTimeout(() => { lockProgress = false; }, 6000);
  // ===== 极速恢复：不依赖任何网络请求，立即从 localStorage 恢复登录态与上次集数/界面 =====
  // 服务器限速时 episodes.json 可能要 20 秒才回来，恢复动作必须排在它前面
  try {
    const cached = readSessionLocal();
    if (cached && !session) { session = cached; setAuthUI(); }
  } catch (e) {}
  const __prog = readProgress();
  if (__prog.ep > 0) {
    const known = { 1:"media/ep1.mp4:46 Linden Street", 2:"media/ep2.mp4:The Blind Date", 3:"media/ep3.mp4:Grandpa's Trunk",
      4:"media/ep4.mp4:A Piece of Cake", 5:"media/ep5v2.mp4:The Right Magic", 6:"media/ep6v2.mp4:Man's Best Friend",
      7:"media/ep7v2.mp4:Man's Best Friend" };
    const k = known[__prog.ep];
    if (k) {
      const [v, t] = k.split(":");
      const kp = { 1:[8,62843183], 2:[6,49384193], 3:[6,47333922], 4:[7,54786514], 5:[7,56797130], 6:[7,57662901], 7:[7,56069572] };
      const pd = { 1:"ep1", 2:"ep2", 3:"ep3", 4:"ep4", 5:"ep5v2", 6:"ep6v2", 7:"ep7v2" };
      const pi = kp[__prog.ep] || [0, 0];
      ep = { ep: __prog.ep, title: t, video: v, subs: __prog.ep===5?"data/subtitles.json":"data/ep"+__prog.ep+".json", ready: true,
             parts: pi[0], partDir: pd[__prog.ep] || ("ep"+__prog.ep),
             size: pi[1], partLen: 8388608 };
      setVideoSrc(ep);
      $("epLabel").textContent = `第${ep.ep}集 · ${ep.title}`;
    }
  }
  fontTier = +(localStorage.getItem("fam_font_tier") ?? 1);
  if (!(fontTier >= 0 && fontTier <= 2)) fontTier = 1;
  hidePh = localStorage.getItem("fam_hide_ph") === "1";
  document.body.classList.toggle("hide-ph", hidePh);
  $("phToggle").classList.toggle("active", !hidePh);
  applyRichFont();
  if ("serviceWorker" in navigator) {
    // 不 await：SW 注册/就绪放后台，绝不阻塞首屏渲染
    navigator.serviceWorker.register("sw.js").then(() => {
      navigator.serviceWorker.addEventListener("controllerchange", () => { checkOffline(); }, { once: true });
    }).catch(() => {});
  }
  // checkOffline 要遍历每集分片（慢），推到首屏渲染之后执行
  const prog = readProgress();
  // 立即锁定，防止加载期间的渲染把旧进度覆盖
  lockProgress = true;
  try {
    const er = await fetch(dataURL("data/episodes.json"), { cache: "reload" });
    EPS = await er.json();
    // 清单里的配置更权威；但只在它确实能确认目标集时才替换，避免限速失败时回退
    const last = EPS.find(x => x.ep === prog.ep && x.ready);
    if (last) {
      const srcChanged = last.video !== ep.video;
      ep = last;
      if (srcChanged) { setVideoSrc(ep); }
      else setVideoSrc(ep);
      $("epLabel").textContent = `第${ep.ep}集 · ${ep.title}`;
    } else if (!EPS.find(x => x.ep === ep.ep)) {
      // 清单里没有当前集，保留上面推断出来的配置
    }
  } catch (e) { /* 清单加载失败：沿用开头从 localStorage 立即推断的配置 */ }
  $("epLabel").textContent = `第${ep.ep}集 · ${ep.title}`;
  // 兜底：无论上面哪个分支，都要确保 SW 就绪后把当前集的视频挂上并 load
  // （新用户无进度记录时 last 找不到，必须在这里补上，否则 video 永远是空 src）
  setVideoSrc(ep);
  await loadSubs();
  buildActs();
  render(true);
  // 恢复到上次学到的那一句（等视频 metadata 好再 seek，离线也有兜底）
  let restored = false;
  const restore = () => {
    if (restored) return; restored = true;
    if (prog.ep === ep.ep && prog.i >= 0 && prog.i < subs.length) {
      go(prog.i, false);
      toast(`已回到上次学的 第${ep.ep}集 · 第${prog.i + 1}句`);
    }
    // 恢复完成才允许进度写入，之后的操作正常记录
    lockProgress = false;
    // 恢复后立刻用「记录的进度」写回一次，避免 seek 未到位时把旧进度抹成第1句
    try {
      localStorage.setItem(LS_EP, String(ep.ep));
      localStorage.setItem(LS_POS, JSON.stringify({ i: cur >= 0 ? cur : prog.i, t: video.currentTime || prog.t || 0, ts: Date.now() }));
    } catch (e) {}
  };
  if (video.readyState >= 1) setTimeout(restore, 80);
  else {
    video.addEventListener("loadedmetadata", () => setTimeout(restore, 80), { once: true });
    setTimeout(restore, 2500);
  }
  // 以下全部后台化：首屏已渲染，登录态/笔记/离线检查/续传都不再阻塞显示
  restoreAuth().catch(() => {});
  loadLocalNotes();
  checkOffline().catch(() => {});   // 遍历分片慢，放最后
  autoResume(); // 已下载一半的分片自动接着传
})();
