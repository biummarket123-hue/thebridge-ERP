# SaaS 전용 Supabase 프로젝트 — 빈 DB 에서 스키마 만들기

로하이마켓 운영 DB 와 **무관한 새 Supabase 프로젝트**에 처음 한 번 실행하는 순서다.
`tests/saas/test-fresh-db.mjs` 가 같은 순서(`FRESH_DB_ORDER`)를 PGlite(메모리 Postgres)에 돌려 매번 검증한다 —
에러 없이 돌고, 두 번 돌려도 안전하고, `src/lib/db.js` 가 읽는 칸이 전부 생기는지.

## 실행 순서 (Supabase 대시보드 → SQL Editor, 파일 내용을 그대로 붙여 넣어 Run)

| # | 파일 | 무엇 |
|---|---|---|
| 1 | `migrations/saas_init_schema.sql` | 기본 표(orders·customers·inventory·logs·managers·settings·deposits·credits·payment_logs·무료배송권) + 회사 격리 RLS + realtime + 이미지 버킷 |
| 2 | `migrations/add_stock_rolls.sql` | 품번·롤 재고 |
| 3 | `migrations/add_product_manager.sql` | 품번 담당자·이니셜 |
| 4 | `migrations/add_item_packing.sql` | 품목 포장 기록 |
| 5 | `migrations/add_roll_pieces.sql` | 롤 조각 |
| 6 | `migrations/add_manager_flags.sql` | 담당자 관리자·공용 플래그 |
| 7 | `migrations/add_packer_flag.sql` | 포장 담당 플래그 |
| 8–24 | `add_customer_address_detail` `add_customer_address2` `add_delivery_message` `add_delivery_message_presets` `add_fabric_missing` `add_held_at` `add_merge_group` `add_orders_images` `add_other_cost` `add_packed_at` `add_parked` `add_receipt_issued` `add_receipt_type` `add_ship_date` `add_ship_request` `add_shipped_at` `add_shipping_fee_held` | 주문·고객 칸 추가(이 순서대로) |
| 25–26 | `add_refund_request` `add_refund_history` | 환불 신청·이력 |
| 27–28 | `add_credits_order_id` `add_credits_manager_memo` | 적립금 칸 |
| 29–30 | `add_order_events` `add_order_events_retention` | 변경 기록 |
| 31–33 | `add_order_notes` `add_order_notes_customer` `add_note_reactions` | 메모 채팅 |
| 34 | `add_notices` | 미등록 알림판 |
| 35–37 | `add_order_returns` `alter_order_returns_exchange` `alter_order_returns_exchange_items` | 반품·교환 |
| 38–41 | `add_label_printed` `add_label_request` `add_label_station` `add_thanks_label` | 라벨 |
| 42–44 | `add_link_order_drafts` `add_link_drafts_offer` `add_link_drafts_credit` | 링크 주문 초안 |
| 45 | `migrations/saas_company_accounts.sql` | 회사 계정·구독·담당자 PIN |
| 46 | `migrations/saas_readonly_when_expired.sql` | 구독 만료 시 읽기 전용 |

정확한 파일 순서는 `tests/saas/test-fresh-db.mjs` 의 `FRESH_DB_ORDER` 배열이 단일 출처다.

## 쓰지 않는 파일(옛 설계 — 실행 금지)

- `supabase-schema.sql` — 2026년 초 첫 판(orders.id text, anon 전체 허용). `saas_init_schema.sql` 이 대신한다.
- `supabase-multitenant-migration.sql`, `supabase-free-shipping-migration.sql`, `supabase-storage-order-images-policy.sql` — 로하이마켓 운영 DB 를 "고쳐 가며" 만든 기록. 새 DB 에는 init 에 다 들어 있다.
- 로하이마켓 이름이 든 UPDATE(`add_manager_flags.sql` 의 옥정점, `add_product_manager.sql` 의 이니셜)는 빈 DB 에서 0행을 건드리므로 무해하다.

## 실행 뒤 확인

```sql
select count(*) from pg_tables where schemaname = 'public';        -- 27
select is_company_active();                                          -- true (행 없는 회사)
select proname from pg_proc where proname like '%manager_pin%';      -- 4개
```

## 그 다음

1. Vercel 환경변수: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`(새 프로젝트 것), `SAAS_SIGNUP_CODE`, `VITE_MODE=saas`, `ANTHROPIC_API_KEY`(AI 분석).
2. Supabase → Authentication → Providers → Email: "Confirm email" 을 끈다(가입 서버 함수가 `email_confirm: true` 로 만들지만, 비밀번호 로그인에 확인 메일이 끼어들지 않게).
3. `/app` 에서 "새 회사 가입" 으로 첫 회사를 만든다. 가입 초대 코드는 `SAAS_SIGNUP_CODE`.
