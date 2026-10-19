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
| 경로 | `/` → `/app`(새 UI). `/legacy` → 옛 화면(ErpApp)을 같은 세션으로. `/o`, `/r` 공개 페이지 | `src/main.jsx`, `src/AppEntry.jsx` |

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
  브라우저(auth.uid 있음)는 요금제·기간을 못 바꾼다 — 트리거가 막는다.
- **만료**: 체험 종료 또는 유료 기간 + 3일 유예 지남 → 읽기 전용. 화면은 배너와 저장 버튼 비활성, DB 는 insert/update/delete 를 거부한다. 데이터는 남는다.
- **담당자 자리**: `max_managers`(기본 3, 공용 제외). 설정 화면의 "담당자 추가" 가 자리를 센다.

## 4. 한계와 다음 단계

- **담당자 토큰(2026-10-19 2차)**: PIN 통과 시 `verify_manager_pin` 이 토큰을 주고 브라우저가 `x-manager-token` 헤더로 보낸다. DB 가 `current_manager_is_admin()` 으로 관리자 전용(주문 삭제·담당자 추가/수정/삭제·회사 정보·출고완료 전환)을 막는다. 포장·담당자 잠금 같은 세부 규칙은 아직 브라우저 판정.
- 롤·포장 표에는 구독 만료 트리거가 있어 security definer RPC 도 막힌다.
- 결제(토스페이먼츠 빌링) 미연동. 웹훅 서버 함수 하나로 `company_accounts.current_period_end` 를 늘리면 된다.
- 옛 화면(`/legacy`)은 로하이마켓 운영에 맞춘 문구·기본 담당자(방문고객·마켓24 자동 생성)·품번 접두어(LH)가 남아 있다. 새 UI 로 기능이 옮겨 가면 걷어낸다.
- `api/company-session.js`, `api/link/*`(LINK_COMPANY_USER_ID) 는 사내 모드 전용이라 SaaS 배포에서는 쓰이지 않는다.

## 5. 테스트

`npm test` — `tests/saas/test-subscription.mjs`(규칙 22건), `tests/saas/test-company-sql.mjs`(PGlite 에 구독 마이그레이션·RPC·RLS 40건), `tests/saas/test-fresh-db.mjs`(빈 DB 에 46개 파일 순서 실행·재실행·db.js 칸 커버리지 9건). 운영 DB 를 쓰지 않는다.
