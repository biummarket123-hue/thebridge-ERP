# ERP SaaS 구독형 — 구조·설치·운영 안내 (2026-10-19)

이 저장소는 **로하이마켓 ERP 와 무관한 독립 SaaS 상품**이다. 코드는 `thebridge-ERP-company` 에서 갈라져 나왔지만
git 원격·Supabase 프로젝트·Vercel 프로젝트를 전부 따로 쓴다. 로하이마켓 운영 DB 를 가리키는 환경변수는 이 저장소에 두지 않는다.

로그인 구조: **회사 아이디·비밀번호 → 담당자 선택 + 4자리 PIN** 2단계.

## 1. 구조 요약

| 층 | 무엇 | 어디 |
|---|---|---|
| 테넌트 | 회사 = Supabase auth 유저 1명. 모든 표의 `user_id = auth.uid()` RLS | `migrations/saas_init_schema.sql` |
| 회사 계정 | `company_accounts`(로그인 아이디·회사명·요금제·기간), `subscription_events`(이력) | `migrations/saas_company_accounts.sql` |
| 담당자 PIN | `manager_pins`(해시만, 정책 없음) + RPC `verify_manager_pin / set_manager_pin / manager_pin_status`, 5회 실패 10분 잠금 | 같은 파일 |
| 만료 읽기 전용 | `is_company_active()` 를 쓰는 restrictive 정책 — 쓰기만 막고 읽기는 둔다 | `migrations/saas_readonly_when_expired.sql` |
| 서버 함수 | `/api/saas-account` — `login`(아이디→세션), `signup`(초대 코드·체험 14일·관리자 담당자+PIN), `reset-admin-pin`(회사 비밀번호로 본인 확인) | `api/saas-account.js` |
| 화면 | 회사 로그인·가입(`src/saas/auth/SaasAuth.jsx`), PIN 게이트(`src/saas/auth/PinGate.jsx`), 회사 설정(`src/saas/pages/SettingsPage.jsx`) | `src/saas` |
| 규칙 | 아이디·비밀번호·PIN 형식, 구독 상태 판정(SQL 과 같은 답), PIN 재확인(30분·기기 고정) | `src/saas/lib/subscription.js` |
| 경로 | `/app` 새 UI(그 밖의 경로는 `/app` 으로). `/o`, `/r` 공개 페이지. 옛 화면(ErpApp)은 SaaS 에서 쓰지 않는다 | `src/main.jsx`, `src/AppEntry.jsx` |

`VITE_MODE=company` 는 로하이마켓 사내 배포 호환용으로 코드에만 남아 있다(사내 비밀번호 게이트). 이 저장소의 배포는 항상 `saas`.

## 2. 설치 순서

1. **새 Supabase 프로젝트**에 `docs/saas-db-setup.md` 순서대로 SQL 실행(46개 파일, PGlite 테스트가 같은 순서를 검증).
2. Authentication → Providers → Email 에서 "Confirm email" 끄기.
3. `.env.local`(로컬) / Vercel 환경변수(배포)에 `.env.example` 의 값 채우기. `SUPABASE_SERVICE_ROLE_KEY` 와 `SAAS_SIGNUP_CODE` 는 VITE_ 접두사 없이.
4. GitHub 새 저장소에 올리고 Vercel 새 프로젝트에 연결(이 저장소는 `git remote` 가 비어 있다 — 로하이마켓 저장소로 푸시되지 않게 일부러 뗐다).
5. `/app` → "새 회사 가입" 으로 첫 회사를 만든다.

## 3. 운영 흐름

- **가입**: 초대 코드·회사명·아이디·비밀번호·관리자 이름·PIN. 서버가 auth 유저(`{id}@thebridge.erp`), `company_accounts`(체험 14일), 담당자 2명(관리자·방문고객 공용), 관리자 PIN, `settings` 기본값을 만든다. 중간에 실패하면 계정을 되돌린다.
- **로그인**: 아이디 → 서버가 이메일을 찾아 세션 발급 → 브라우저 `setSession`. 30일 유지.
- **담당자**: 이름 선택 → PIN 4자리. 30분 조작 없으면 다시 묻고, 담당자를 바꾸면 즉시 묻는다. "이 기기에 담당자 고정" 을 켜면 다시 묻지 않는다(포장 패드). 공용 담당자는 PIN 없음.
- **PIN 분실**: PIN 화면의 "PIN 을 잊었어요" → 회사 아이디·비밀번호 → 새 PIN. 관리자는 설정 화면에서 다른 담당자 PIN 을 자기 PIN 으로 바꿔 준다.
- **구독 연장(결제 연동 전, 수동)**: SQL Editor 에서
  ```sql
  update company_accounts set plan='basic', status='active', current_period_end = now() + interval '30 days' where login_id='<아이디>';
  insert into subscription_events (owner_id, kind, amount, plan, period_end, memo)
    select owner_id, 'payment', 99000, 'basic', current_period_end, '10월 입금' from company_accounts where login_id='<아이디>';
  ```
  또는 터미널에서 `node ops-subscription.mjs list | extend <아이디> <일수> [요금제] | plan | cancel | resume` (service role, 이력 자동 기록).
  브라우저(auth.uid 있음)는 요금제·기간을 못 바꾼다 — 트리거가 막는다.
- **만료**: 체험 종료 또는 유료 기간 + 3일 유예 지남 → 읽기 전용. 화면은 배너와 저장 버튼 비활성, DB 는 insert/update/delete 를 거부한다. 데이터는 남는다.
- **담당자 자리**: `max_managers`(기본 3, 공용 제외). 설정 화면의 "담당자 추가" 가 자리를 센다.

## 3-1. 결제(토스페이먼츠 빌링 · 2026-10-20)

카드를 한 번 등록(빌링키)하면 화면에서 "지금 결제" 로 30일을 사고, 그 뒤는 크론이 매달 같은 카드로 자동 결제한다.
수동 연장(`ops-subscription.mjs extend` · SQL)은 그대로 쓸 수 있다 — 같은 `company_accounts.current_period_end` 를 늘릴 뿐이다.

| 무엇 | 어디 |
|---|---|
| 빌링키·customerKey 저장 | `saas_billing`(브라우저 정책 없음, service role 전용) — `migrations/saas_features.sql` |
| 서버 함수 | `api/billing.js` — `status · issue · charge · cancel-auto · remove-card` (세션 토큰으로 회사 확인) |
| 자동 결제 크론 | `api/billing-cron.js` — `vercel.json` crons `0 16 * * *`(UTC) = **매일 KST 01:00** |
| 순수 계산 | `api/_billing_logic.js` — 가격표·다음 기간 끝·orderId·카드 라벨·자동 결제 대상 판정. `tests/saas/test-billing-logic.mjs` |
| 화면 | `src/saas/pages/SettingsPage.jsx` 구독 패널 — 요금제 카드 2개·카드 등록/변경/삭제·지금 결제·자동 결제 해지·이력 |

### 환경변수

| 이름 | 어디서 읽나 | 뜻 |
|---|---|---|
| `TOSS_SECRET_KEY` | 서버 | 토스 API 비밀키(`test_sk_…` / `live_sk_…`). 빌링키 발급·결제 호출의 `Authorization: Basic base64(키 + ":")` |
| `VITE_TOSS_CLIENT_KEY` | 브라우저 | 토스 클라이언트키 — 카드 등록 창(`requestBillingAuth`)을 띄울 때 |
| `SAAS_PRICE_BASIC` / `SAAS_PRICE_PRO` | 서버 | 월 요금(원). 비우면 99,000 / 199,000 |
| `CRON_SECRET` | 서버 | 있으면 크론 요청의 `Authorization: Bearer` 가 맞아야 한다(Vercel 이 자동으로 붙인다). `demo-cleanup` 과 같은 값 |
| `VITE_SUPPORT_EMAIL` | 브라우저 | 회사 설정 › 데이터 이관의 "이관 요청" 메일 받을 주소(선택) |

**둘 다(`TOSS_SECRET_KEY` + `VITE_TOSS_CLIENT_KEY`) 있어야 켜진다.** 하나라도 없으면 `status` 가 `enabled:false` 를 주고 화면은 예전 문구("결제 연동 준비 중 — 운영자에게 연락")만 보인다. 다른 action 은 400. 크론은 아무것도 안 하고 200.
`saas_billing` 표가 아직 없는 DB(saas_features.sql 미적용)에서도 `status` 는 준비 중으로 떨어진다.

### 흐름

1. **카드 등록** — 설정 › 구독 › "카드 등록" → 브라우저가 토스 SDK(`https://js.tosspayments.com/v1/payment`)를 끼우고 `TossPayments(clientKey).requestBillingAuth("카드", { customerKey, successUrl: /app/settings?billing=ok, failUrl: /app/settings?billing=fail })`.
   customerKey 는 서버가 `status` 때 만들어 `saas_billing` 에 넣는다(`co_<owner_id 앞 12자>_<랜덤>`).
   돌아오면 쿼리의 `authKey·customerKey` 로 `issue` → 서버가 `POST /v1/billing/authorizations/issue` → `billing_key`·`card_label`("신한 ****1234") 저장, 이력 note "카드 등록". 쿼리는 `history.replaceState` 로 지운다.
2. **지금 결제** — 요금제 카드(베이직/프로)를 고르고 "지금 결제하고 시작(연장)" → confirm → `charge { plan }` → 서버가 `POST /v1/billing/{billingKey}` (`orderId sub_<owner 앞8>_<yyyymmddHHMM KST>`, `orderName "루프 ERP 베이직 1개월"`).
   성공: `company_accounts.plan·status=active·max_managers`, `current_period_end = (남은 기간이 있으면 그 끝 — 체험이면 trial_end, 아니면 지금) + 30일`, `saas_billing.plan = plan`(자동 갱신 대상)·`last_paid_at`, 이력 kind `billing`(amount·plan·period_start/end).
   실패: `saas_billing.last_error` 에 남기고 400 — 화면에 "마지막 결제 오류" 로 보인다.
3. **자동 결제(크론)** — 매일 KST 01:00. `saas_billing.plan` 이 있고 빌링키가 있는 회사 중 `current_period_end` 가 **하루 안이거나, 지났지만 유예 3일 안**인 회사를 돌며 2 와 같은 처리. 실패하면 `last_error` 만 남기고 다음 회사로(다음 날 다시 시도 — 유예 3일 동안). 체험 회사(current_period_end 없음)는 대상이 아니다 — 첫 결제는 화면에서.
4. **자동 결제 해지** — `cancel-auto` → `saas_billing.plan = null`. 기간은 그대로, 끝나면 읽기 전용. 다시 결제하면 켜진다.
5. **카드 삭제** — `remove-card` → `billing_key = null`(자동 결제도 꺼짐).

로컬 `vite dev` 는 `api/` 를 돌리지 않으므로 `status` 가 실패 → 화면은 준비 중 문구로 떨어진다. 실제 확인은 Vercel 배포(또는 `vercel dev`)에서.

## 4. 한계와 다음 단계

- **담당자 토큰(2026-10-19 2차)**: PIN 통과 시 `verify_manager_pin` 이 토큰을 주고 브라우저가 `x-manager-token` 헤더로 보낸다. DB 가 `current_manager_is_admin()` 으로 관리자 전용(주문 삭제·담당자 추가/수정/삭제·회사 정보·출고완료 전환)을 막는다. 담당자 잠금(남의 주문 수정 금지, 합배송 묶음 예외)·포장 담당 제한(상태·메모·포장 표시만)은 `saas_order_lock.sql` 트리거가 같은 규칙으로 판정한다. 개인 담당자는 PIN 필수(토큰이 신원).
- 롤·포장 표에는 구독 만료 트리거가 있어 security definer RPC 도 막힌다.
- 결제(토스페이먼츠 빌링)는 3-1 절. 토스 키가 발급되기 전까지는 화면이 "준비 중" 으로 떨어지고 수동 연장만 쓴다. 결제 실패 알림(운영자 메일·문자)은 아직 없다 — `saas_billing.last_error` 와 이력을 `ops-subscription.mjs list` 로 본다.
- 옛 화면(ErpApp)은 SaaS 에서 열 수 없다(2026-10-19 결정). 그 화면에만 있던 기능(포장 스캔·라벨 출력·공지·메모 채팅·교환 기록·합배송 묶기/분리·운임비 조정·택배사 변경·이미지 첨부)은 필요해지면 새 UI 에 만든다.
- `api/company-session.js`, `api/link/*`(LINK_COMPANY_USER_ID) 는 사내 모드 전용이라 SaaS 배포에서는 쓰이지 않는다.

## 5. 테스트

`npm test` — `tests/saas/test-subscription.mjs`(규칙 22건), `tests/saas/test-billing-logic.mjs`(결제 계산 31건 · `npm test -- billing`), `tests/saas/test-company-sql.mjs`(PGlite 에 구독 마이그레이션·RPC·RLS 40건), `tests/saas/test-fresh-db.mjs`(빈 DB 에 46개 파일 순서 실행·재실행·db.js 칸 커버리지 9건). 운영 DB 를 쓰지 않는다.
