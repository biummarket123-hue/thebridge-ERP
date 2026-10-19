// 이미지 프록시 — 외부(밴드/네이버 등) 미리보기 이미지를 우리 서버가 대신 받아
// 우리 https 인증서로 다시 스트리밍한다.
//
// 해결하는 문제:
//  - mixed-content: 원본이 http:// 라 https 페이지에서 브라우저가 차단
//  - 네이버 phinf CDN 등 브라우저가 직접 불러올 때만 생기는 인증서·핫링크 문제
// 둘 다 "브라우저가 직접 불러올 때"만 생기는 문제라, 서버가 대신 받아 넘기면 우회됨.
//
// SSRF 방어 (2026-09-17 보안 진단 M5):
//  - 예전엔 호스트명 문자열이 사설 IP 모양인지만 봤다. 공개 도메인이 사설 IP 로 풀리거나
//    (DNS 리바인딩), IPv6·10진 표기로 쓰면 그대로 통과했다.
//  - 이제 DNS 를 우리가 먼저 풀고, 풀린 주소가 사설/루프백/링크로컬 대역이면 막는다.
//    그리고 "검사한 그 주소"로 접속한다(request 의 lookup 옵션) — 검사 후 재해석되는
//    틈(TOCTOU)을 없애기 위해서다. 리다이렉트도 목적지마다 같은 검사를 거친다.
//  - 업스트림 TLS 검증을 끄던 옵션(rejectUnauthorized:false)은 제거했다.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns/promises";

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;

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

// 호스트를 풀어서 안전한 주소 하나를 고른다. IP 리터럴이면 그대로 검사한다.
// 풀린 주소 중 하나라도 사설 대역이면 전부 막는다 — 공개+사설을 섞어 두는 리바인딩 수법 때문.
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

// GET 한 번. 리다이렉트는 직접 따라간다 — 목적지가 바뀔 때마다 resolveSafe 를 다시 통과한다.
async function getImage(target, deadline, redirectsLeft = MAX_REDIRECTS) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("timeout"), { name: "AbortError" });
  const picked = await resolveSafe(target.hostname);
  const isHttps = target.protocol === "https:";
  const mod = isHttps ? https : http;

  const r = await new Promise((resolve, reject) => {
    const req = mod.request(
      target,
      {
        method: "GET",
        // 검사한 주소로만 접속한다. TLS 의 SNI/인증서 검증은 원래 호스트명(target.hostname)으로 이뤄진다.
        lookup: (_host, opts, cb) => {
          if (opts && opts.all) return cb(null, [{ address: picked.address, family: picked.family }]);
          return cb(null, picked.address, picked.family);
        },
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Referer": target.origin + "/", // 일부 CDN 핫링크 차단 회피
          "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,*/*",
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // 본문은 버리되 소켓은 풀어준다
          return resolve({ redirect: location });
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status, contentType: res.headers["content-type"] || "", body: Buffer.concat(chunks) }));
        res.on("error", reject);
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
    return getImage(next, deadline, redirectsLeft - 1);
  }
  return r;
}

export default async function handler(req, res) {
  const url = req.query?.url;
  if (!url || typeof url !== "string") return res.status(400).end("url required");

  let target;
  try { target = new URL(url); } catch { return res.status(400).end("bad url"); }
  if (target.protocol !== "http:" && target.protocol !== "https:") return res.status(400).end("bad protocol");
  if (target.username || target.password) return res.status(400).end("bad url");
  if (isBlockedHostname(target.hostname)) return res.status(400).end("blocked host");

  try {
    const r = await getImage(target, Date.now() + TIMEOUT_MS);

    if (r.status < 200 || r.status >= 300 || !r.contentType.startsWith("image/")) {
      return res.status(404).end("not an image");
    }

    res.setHeader("Content-Type", r.contentType);
    res.setHeader("Cache-Control", "public, s-maxage=604800, stale-while-revalidate=2592000");
    return res.status(200).send(r.body);
  } catch (e) {
    if (e.message === "blocked host") return res.status(400).end("blocked host");
    return res.status(502).end(e.name === "AbortError" ? "timeout" : "fetch failed");
  }
}
