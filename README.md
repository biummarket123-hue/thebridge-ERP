# 더브릿지 ERP v2.1

> 동대문 원단시장 전용 AI 업무관리 플랫폼 
> LOWHIGH MARKET · 손정현 대표

---

## 📁 프로젝트 구조

```
thebridge-project/
├── public/
│   └── favicon.svg
├── src/
│   ├── main.jsx              # 앱 진입점 
│   ├── App.jsx               # 루트 (랜딩 ↔ ERP 전환)
│   ├── index.css             # 전역 스타일
│   ├── constants.js          # 색상·상수·초기 데이터
│   ├── Landing.jsx           # 랜딩 페이지
│   ├── ErpApp.jsx            # ERP 메인 (7탭 레이아웃)
│   └── components/
│       ├── UI.jsx            # 공용 컴포넌트 (Card, Button 등)
│       ├── OrderInput.jsx    # 주문 입력 (AI 분석)
│       ├── DepositTab.jsx    # 계약금·잔금 관리
│       ├── BarcodeTab.jsx    # 바코드 스캐너
│       ├── InoutForm.jsx     # 입출고 관리
│       ├── CustomerTab.jsx   # 고객 관리
│       └── ExcelImport.jsx   # 엑셀 업로드 (데이터 가져오기)
├── vercel.json               # Vercel 배포 설정
├── vite.config.js
├── package.json
├── .env.example              # 환경변수 예시
└── .gitignore
```

---

## ⚡ 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. 환경변수 설정
cp .env.example .env
# .env 파일에 VITE_ANTHROPIC_API_KEY 입력

# 3. 개발 서버 시작
npm run dev
# → http://localhost:3000

# 4. 프로덕션 빌드
npm run build
```

---

## 🛠 기술 스택

| 항목 | 내용 |
|------|------|
| 프레임워크 | React 18 |
| 번들러 | Vite 4 |
| 스타일링 | Inline CSS (CSS-in-JS 방식) |
| 엑셀 처리 | xlsx 라이브러리 |
| AI 분석 | Anthropic Claude API |
| 데이터 저장 | localStorage (브라우저) |
| 배포 | Vercel |

---

## 📱 ERP 탭 구성

| # | 탭 | 설명 |
|---|----|----|
| 0 | 주문입력 | 카카오톡 주문 AI 자동 분석 |
| 1 | 주문현황 | 전체 주문 목록 / 송장출력 |
| 2 | 입출고 | 재고 입출고 / 바코드 |
| 3 | 고객관리 | 고객 DB / 카카오 알림 |
| 4 | 계약/잔금 | 계약금·잔금 등록 및 처리 |
| 5 | 대시보드 | 매출 통계 / 원단 TOP20 |
| 6 | 설정 | 테마·담당자·엑셀 업로드 |

---

## 🔑 환경변수

```env
VITE_ANTHROPIC_API_KEY=sk-ant-xxxxxx   # 필수 - AI 주문 분석
VITE_KAKAO_WEBHOOK_URL=                # 선택 - 카카오 알림
```

> API 키는 [Anthropic Console](https://console.anthropic.com)에서 발급

---

## 🚀 Vercel 배포

1. GitHub에 push
2. Vercel에서 프로젝트 import
3. Environment Variables에 `VITE_ANTHROPIC_API_KEY` 추가
4. Deploy

---

## 📌 향후 개발 TODO

- [ ] Supabase 연동 (localStorage → 클라우드 DB)
- [ ] 토스페이먼츠 구독 결제
- [ ] 카카오 OAuth 로그인
- [ ] 팀 공유 (다중 사용자)
- [ ] 모바일 PWA

---

## 📞 문의

LOWHIGH MARKET · 손정현  
biummarket.vercel.app
