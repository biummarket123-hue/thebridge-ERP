# ERP SaaS 구독형 전환 — 설치·운영 안내 (2026-10-19, 1차)

새 UI(`/app`)를 회사 단위 구독 상품으로 파는 기반. 로그인 구조는 **회사 아이디·비밀번호 → 담당자 선택 + 4자리 PIN** 2단계.

## 1. 구조 요약

| 층 | 무엇 | 어디 |
|---|---|---|
| 테넌트 | 회사 = Supabase auth 유저 1명. 모든 표의 `user_id = auth.uid()` RLS 는 그대로 | 기존 |
| 회사 계정 | `company_accounts`(로그인 아이디·회사명·요금제·기간), `subscription_events`(이력) | `migrations/saas_company_accounts.sql` |
| 담당자 PIN | `manager_pins`(해시만, 정책 없음) + RPC `verify_manager_pin / set_manager_pin / manager_pin_status`, 5회 실패 10분 잠금 | 같은 파일 |
| 만료 읽기 전용 | `is_company_active()` 를 쓰는 restrictive 정책 — 쓰기만 막고 읽기는 둔다 | `migrations/saas_readonly_when_expired.sql` |
| 서버 함수 | `/api/saas-account` — `login`(아이디→세션), `signup`(초대 코드·체험 14일·관리자 담당자+PIN), `reset-admin-pin`(회사 비밀번호로 본인 확인) | `api/saas-account.js` |
| 화면 | 회사 로그인·가입(`src/saas/auth/SaasAuth.jsx`), PIN 게이트(`src/saas/auth/PinGate.jsx`), 회사 설정(`src/saas/pages/SettingsPage.jsx`) | `src/saas` |
| 규칙 | 아이디·비밀번호·PIN 형식, 구독 상태 판정(SQL 과 같은 답), PIN 재확인(30분·기기 고정) | `src/saas/lib/subscription.js` |

저장소의 `supabase-saas-schema.sql`(company_id 기반) 과 `src/SaasRoot.jsx`(이메일·비움마켓 이중 로그인) 는 **적용되지 않은 옛 설계**다. 섞지 않는다.

## 2. 설치 순서 (운영 DB 에는 사람이 직접 실행)

1. Supabase SQL Editor 에서 `migrations/saas_company_accounts.sql` 실행 (pgcrypto 확장 포함, 재실행 안전).
2. 이어서 `migrations/saas_readonly_when_expired.sql` 실행.
   - 둘 다 실행 전에는 새 UI 가 "사내 계정(구독 정보 없음)" 으로 돌아가고 PIN 을 묻지 않는다. 깨지지 않는다.
3. Vercel 환경변수 추가 (VITE_ 접두사 없음):
   - `SUPABASE_SERVICE_ROLE_KEY` — 이미 있음(sms-verify 가 씀)
   - `SAAS_SIGNUP_CODE` — 가입 초대 코드. 비워 두면 가입 닫힘. `SAAS_SIGNUP_OPEN=1` 이면 누구나 가입.
   - `SAAS_TRIAL_DAYS` — 체험 일수(기본 14)
4. 1호 고객사(로하이마켓) 전환 — SQL Editor 에서:
   ```sql
   insert into company_accounts (owner_id, login_id, name, plan, status, current_period_end)
   values ('<회사 auth 유저 uuid>', 'rohi', '로하이마켓', 'pro', 'active', null);  -- 기간 null = 제한 없음
   ```
   그 뒤 `/app` 로그인 화면에서 아이디 `rohi` + 회사 계정 비밀번호(COMPANY_AUTH_PASSWORD 와 같은 Supabase 비밀번호)로 들어온다.
   기존 기기는 게이트 토큰 세션이 그대로 통과하므로 재로그인 없이 쓴다. "사내 비밀번호로 로그인" 링크는 VITE_MODE=company 빌드에서만 보인다.
5. 담당자마다 회사 설정 → "PIN 만들기". 처음 PIN 은 증명 없이 만들 수 있고, 그 뒤엔 본인 현재 PIN 또는 관리자 PIN 이 필요하다.

## 3. 운영 흐름

- **가입**: `/app` → "새 회사 가입" → 초대 코드·회사명·아이디·비밀번호·관리자 이름·PIN. 서버가 auth 유저(`{id}@thebridge.erp`), `company_accounts`(체험 14일), 담당자 2명(관리자·방문고객 공용), 관리자 PIN, `settings` 기본값을 만든다. 중간에 실패하면 계정을 되돌린다.
- **로그인**: 아이디 → 서버가 이메일을 찾아 세션 발급 → 브라우저 `setSession`. 30일 유지(supabase refresh).
- **담당자**: 이름 선택 → PIN 4자리. 30분 조작 없으면 다시 묻고, 담당자를 바꾸면 즉시 묻는다. "이 기기에 담당자 고정" 을 켜면 다시 묻지 않는다(포장 패드). 공용 담당자(방문고객 등)는 PIN 없음.
- **PIN 분실**: PIN 화면의 "PIN 을 잊었어요" → 회사 아이디·비밀번호 → 새 PIN(서버 `service_reset_manager_pin`). 관리자는 설정 화면에서 다른 담당자 PIN 을 자기 PIN 으로 바꿔 줄 수 있다.
- **구독 연장(결제 연동 전, 수동)**: SQL Editor 에서
  ```sql
  update company_accounts set plan='basic', status='active', current_period_end = now() + interval '30 days' where login_id='rohi';
  insert into subscription_events (owner_id, kind, amount, plan, period_end, memo)
    select owner_id, 'payment', 99000, 'basic', current_period_end, '10월 입금' from company_accounts where login_id='rohi';
  ```
  브라우저(auth.uid 있음)는 요금제·기간을 못 바꾼다 — 트리거가 막는다.
- **만료**: 체험 종료 또는 유료 기간 + 3일 유예 지남 → 읽기 전용. 화면은 배너와 저장 버튼 비활성, DB 는 insert/update/delete 를 거부한다. 데이터는 남는다.
- **담당자 자리**: `max_managers`(기본 3, 공용 제외). 설정 화면의 "담당자 추가" 가 자리를 센다.

## 4. 한계와 다음 단계

- 담당자 권한(관리자·포장·담당자 잠금)은 아직 **브라우저가 판정**한다. 회사 세션만 있으면 API 로 관리자 작업이 가능. 2차: PIN 통과 시 서버가 담당자 토큰 발급 → 요청 헤더 → RLS·RPC 가 확인.
- security definer RPC(롤 수량·포장)는 만료 읽기 전용 정책을 거치지 않는다. 2차: 함수 안에 `is_company_active()` 검사.
- 결제(토스페이먼츠 빌링) 미연동. 웹훅 서버 함수 하나로 `company_accounts.current_period_end` 를 늘리면 된다.
- 택배사 마감 시각·택배사 목록은 아직 `src/lib/courier.js` 코드 값. 택배비 기본값·재고 부족 기준·회사명은 설정 화면으로 옮겼다(`settings.data.saas`).
- `/`(옛 ERP) 는 손대지 않았다. 사내 비밀번호 게이트 그대로.

## 5. 테스트

- `npm test` — `tests/saas/test-subscription.mjs`(규칙 22건), `tests/saas/test-company-sql.mjs`(PGlite 에 두 마이그레이션 실행·RPC·RLS 40건). 운영 DB 를 쓰지 않는다.
