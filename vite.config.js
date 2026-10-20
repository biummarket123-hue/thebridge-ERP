import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// 개발 서버에서 api/*.js 를 직접 서빙한다.
//
// 배포판에서는 Vercel 이 api 폴더의 파일을 서버리스 함수로 알아서 올려준다. 그런데
// vite dev 는 그걸 모른다 — 여기 설정은 /api 를 localhost:3501 로 프록시하고 있었는데
// 그 포트에서 도는 건 이 저장소에 없다(3501 은 이 파일에만 나온다). 그래서 개발 중에는
// /api/* 가 전부 500 이었다:
//   · /api/og-image  → 로하톡 링크 썸네일. 주문현황 열 때마다 수십 개가 빨갛게 쏟아진다
//   · /api/holidays  → 출고예정일 공휴일. shipDate 가 내장 표로 폴백해 동작은 했다
//   · /api/img-proxy → 썸네일 이미지 프록시
// 앱은 전부 폴백을 갖고 있어 망가지진 않았지만, 콘솔이 묻혀서 정작 봐야 할 로그를
// 못 읽었다. 개발 중에 콘솔을 못 믿으면 디버깅 자체가 안 된다.
//
// Vercel 핸들러는 (req, res) 를 Express 스타일로 쓴다(res.status().json() 등).
// Node 의 기본 ServerResponse 에는 그게 없으므로 최소한만 얹어준다.
function apiDevServer(env) {
  return {
    name: 'api-dev-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()

        const [pathname, search = ''] = req.url.split('?')
        // /api/auth/kakao → api/auth/kakao.js  (경로 탈출 차단)
        const rel = pathname.slice('/api/'.length)
        if (!rel || rel.includes('..')) return next()
        const file = path.join(server.config.root, 'api', `${rel}.js`)
        if (!file.startsWith(path.join(server.config.root, 'api')) || !fs.existsSync(file)) return next()

        // ── Vercel 호환 어댑터 ──
        req.query = Object.fromEntries(new URLSearchParams(search))
        if (req.method === 'POST' || req.method === 'PUT') {
          req.body = await new Promise((resolve) => {
            let raw = ''
            req.on('data', (c) => { raw += c })
            req.on('end', () => {
              try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
            })
          })
        }
        res.status = (code) => { res.statusCode = code; return res }
        res.json = (obj) => {
          if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(obj)); return res
        }
        res.send = (body) => {
          res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
          return res
        }
        res.redirect = (loc) => { res.statusCode = 302; res.setHeader('Location', loc); res.end(); return res }

        try {
          // ssrLoadModule 을 쓰면 핸들러도 HMR 을 탄다 — api/*.js 를 고치면 서버 재시작 없이 반영된다.
          const mod = await server.ssrLoadModule(file)
          await mod.default?.(req, res)
        } catch (e) {
          server.config.logger.error(`[api-dev] ${rel}: ${e?.stack || e}`)
          if (!res.writableEnded) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
        }
      })
    },
    config() {
      // 핸들러는 process.env 를 읽는다(ANTHROPIC_API_KEY, KAKAO_CLIENT_ID …).
      // vite 는 VITE_ 접두사만 클라이언트로 넘기고 process.env 는 건드리지 않으므로
      // 개발 서버 프로세스에만 채워 넣는다. 이미 있는 값은 덮지 않는다.
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) process.env[k] = v
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  // 접두사 '' → VITE_ 가 아닌 서버용 키까지 전부 읽는다 (개발 서버 프로세스 안에서만 쓴다)
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), apiDevServer(env)],
    server: {
      port: 3600,
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        input: {
          main: 'index.html',
          admin: 'admin/index.html',
          // 고객용 공개 주소(info.lowhigh-market.com)의 문서 — ERP 이름이 안 보이는 별도 진입점(src/public/main.jsx)
          info: 'info.html',
        },
      },
    },
  }
})
