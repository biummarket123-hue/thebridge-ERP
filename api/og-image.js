// 링크 미리보기 이미지 추출 — 주어진 URL 페이지를 서버에서 열어
// og:image / twitter:image / 대표 <img> 를 찾아 반환한다.
// 브라우저는 CORS로 타 사이트 HTML을 못 읽으므로 이 서버 함수가 대신 받는다.
//
// GET /api/og-image?url=<페이지 URL>  →  { image: "https://..." | null }
// Vercel CDN 캐싱(s-maxage)으로 같은 URL 반복 조회는 저렴.
//
// SSRF 방어 (2026-09-17 보안 진단 M5): api/img-proxy.js 와 같은 방식.
//  - 호스트명 문자열 검사만으로는 공개 도메인이 사설 IP 로 풀리는 경우(DNS 리바인딩)와
//    IPv6·10진 IP 표기를 못 막았다.
//  - DNS 를 먼저 풀어 사설/루프백/링크로컬 대역이면 막고, 검사한 그 주소로만 접속한다.
//    fetch 의 redirect:"follow" 는 목적지 검사를 건너뛰므로 리다이렉트도 직접 따라간다.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";

const TIMEOUT_MS = 7000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 512 * 1024;

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || a >= 224;                           // 멀티캐스트·예약
}

function isPrivateIP(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) return isPrivateIPv4(ip);
  if (fam !== 6) return true;
  const v = ip.toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (v === "::1" || v === "::") return true;
  if (/^f[cd]/.test(v)) return true;          // fc00::/7 (ULA)
  if (/^fe[89ab]/.test(v)) return true;       // fe80::/10 (link-local)
  return false;
}

function isBlockedHostname(hostname) {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return !h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal");
}

async function resolveSafe(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(h)) throw new Error("blocked host");
  if (net.isIP(h)) {
    if (isPrivateIP(h)) throw new Error("blocked host");
    return { address: h, family: net.isIP(h) };
  }
  let addrs;
  try { addrs = await dns.lookup(h, { all: true, verbatim: true }); }
  catch { throw new Error("dns failed"); }
  if (!addrs.length) throw new Error("dns failed");
  if (addrs.some(a => isPrivateIP(a.address))) throw new Error("blocked host");
  return addrs[0];
}

// GET 한 번. 응답 본문은 HTML 앞부분(MAX_HTML_BYTES)만 읽고 끊는다.
async function getPage(target, deadline, redirectsLeft = MAX_REDIRECTS) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("timeout"), { name: "AbortError" });
  const picked = await resolveSafe(target.hostname);
  const mod = target.protocol === "https:" ? https : http;

  const r = await new Promise((resolve, reject) => {
    const req = mod.request(
      target,
      {
        method: "GET",
        lookup: (_host, opts, cb) => {
          if (opts && opts.all) return cb(null, [{ address: picked.address, family: picked.family }]);
          return cb(null, picked.address, picked.family);
        },
        headers: {
          // 일부 사이트는 봇 UA를 막으므로 일반 브라우저 UA로 요청
          "User-Agent": "Mozilla/5.0 (compatible; TheBridgeERP/1.0; +https://vercel.com)",
          "Accept": "text/html,application/xhtml+xml",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) { res.resume(); return resolve({ redirect: location }); }
        const contentType = res.headers["content-type"] || "";
        if (contentType.startsWith("image/") || !contentType.includes("html")) {
          res.resume();
          return resolve({ status, contentType, html: "", finalUrl: target });
        }
        const chunks = []; let size = 0; let settled = false;
        const done = () => {
          if (settled) return; settled = true;
          resolve({ status, contentType, html: Buffer.concat(chunks).toString("utf8").slice(0, MAX_HTML_BYTES), finalUrl: target });
        };
        res.on("data", (c) => {
          if (size >= MAX_HTML_BYTES) return;
          chunks.push(c); size += c.length;
          if (size >= MAX_HTML_BYTES) { done(); res.destroy(); } // 충분히 읽었으면 연결을 끊는다
        });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done); // 우리가 끊은 것도 여기로 올 수 있다 — 읽은 만큼으로 진행
      }
    );
    req.setTimeout(remaining, () => { req.destroy(Object.assign(new Error("timeout"), { name: "AbortError" })); });
    req.on("error", reject);
    req.end();
  });

  if (r.redirect !== undefined) {
    if (redirectsLeft <= 0) throw new Error("too many redirects");
    let next;
    try { next = new URL(r.redirect, target); } catch { throw new Error("bad redirect"); }
    if (next.protocol !== "http:" && next.protocol !== "https:") throw new Error("bad redirect protocol");
    return getPage(next, deadline, redirectsLeft - 1);
  }
  return r;
}

function pickMeta(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return m[1];
  }
  return null;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export default async function handler(req, res) {
  const url = req.query?.url || (req.method === "POST" ? req.body?.url : null);
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "url 파라미터가 필요합니다" });
  }

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).json({ error: "잘못된 URL" });
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return res.status(400).json({ error: "http/https 만 허용" });
  }
  if (target.username || target.password) {
    return res.status(400).json({ error: "잘못된 URL" });
  }
  if (isBlockedHostname(target.hostname)) {
    return res.status(400).json({ error: "허용되지 않은 호스트" });
  }

  try {
    const r = await getPage(target, Date.now() + TIMEOUT_MS);

    // 링크가 이미지 자체를 가리키면 그대로 반환
    if (r.contentType.startsWith("image/")) {
      res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      return res.status(200).json({ image: r.finalUrl.toString() });
    }
    if (!r.contentType.includes("html")) {
      return res.status(200).json({ image: null });
    }

    const html = r.html;
    let image = pickMeta(html, [
      /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
      /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
      /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
    ]);

    // 메타가 없으면 본문 첫 <img> 폴백
    if (!image) {
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) image = m[1];
    }

    if (image) {
      image = decodeEntities(image.trim());
      // 상대경로 → 절대경로 보정 (리다이렉트로 옮겨간 최종 URL 기준)
      try { image = new URL(image, r.finalUrl).toString(); } catch { /* keep as-is */ }
      // http → https 승격: 우리 사이트는 https라 http 이미지는 브라우저가 mixed-content로 차단함.
      if (image.startsWith("http://")) image = "https://" + image.slice("http://".length);
    }

    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ image: image || null });
  } catch (e) {
    if (e.message === "blocked host") return res.status(400).json({ error: "허용되지 않은 호스트" });
    // 타임아웃/네트워크/로그인 필요 등 — 조용히 null 반환 (UI는 썸네일 생략)
    return res.status(200).json({ image: null, error: e.name === "AbortError" ? "timeout" : e.message });
  }
}
