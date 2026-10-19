-- ============================================================
-- order-images 스토리지 버킷 정책 — public → authenticated 로 제한
-- 2026-09-17 Supabase 대시보드(SQL Editor)에서 이미 적용됨. 이 파일은 기록용이다.
-- ⚠️ 다시 실행하지 말 것. 재구축이 필요할 때만 참고한다.
--
-- 무슨 문제를 푸는가 (보안 진단 H1):
--   버킷이 public 인 데다 storage.objects 의 SELECT/INSERT/DELETE 정책이 public(anon 포함)에
--   열려 있었다. 로그인 없이 anon 키만으로 주문 폴더(주문 ID) 목록을 나열하고, 업로드·삭제까지
--   가능했다. 주문 첨부 이미지(고객 대화 캡처·송장 등)가 훑어볼 수 있는 상태였다.
--
-- 무엇을 바꿨는가:
--   · 목록 조회(list)·업로드·삭제는 로그인 세션(authenticated)에만 허용
--   · 버킷의 public 플래그는 그대로 — 개별 객체를 public URL 로 여는 것은 유지된다.
--     orders.images 컬럼에 저장된 URL 로 주문 카드·포장 패드·로하톡 팝업이 사진을 보여주는
--     경로라서, 이걸 막으면 화면의 사진이 전부 깨진다.
--   · 앱에서 list 를 쓰는 곳은 src/lib/storage.js deleteOrderImages(출고완료·주문 삭제 때
--     폴더 정리) 하나뿐이고 로그인 세션으로 실행되므로 영향 없음.
--
-- 적용 후 실측 (2026-09-17):
--   anon list → 0건 · anon 이미지 URL GET → 200 · anon 업로드(image/webp) → 거부 ·
--   company 세션 list → 정상
--
-- 참고: 이 Supabase 프로젝트는 다른 앱(HR)과 공유된다. storage.objects 정책은 버킷 조건
--   (bucket_id = 'order-images') 으로 범위를 한정해야 다른 버킷에 영향이 없다.
--   대시보드에서 만든 정책 이름이 아래와 다를 수 있다 — 실제 이름은 1단계 조회로 확인.
-- ============================================================

-- ─── 0. 현재 정책 확인 ─────────────────────────────────────────
select policyname, cmd, roles, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and coalesce(qual, with_check, '') ilike '%order-images%'
 order by cmd, policyname;

-- ─── 1. 예전 public 정책 3개 제거 ───────────────────────────────
-- (storage.js 주석 "public read, authenticated write" 시절의 정책. 실제 이름은 0번 결과 기준)
drop policy if exists "order-images public select" on storage.objects;
drop policy if exists "order-images public insert" on storage.objects;
drop policy if exists "order-images public delete" on storage.objects;

-- ─── 2. authenticated 전용 정책 3개 생성 ────────────────────────
create policy "order-images authenticated select" on storage.objects
  for select to authenticated
  using (bucket_id = 'order-images');

create policy "order-images authenticated insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'order-images');

create policy "order-images authenticated delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'order-images');

-- ─── 3. 확인 ───────────────────────────────────────────────────
-- order-images 대상 정책은 authenticated 의 SELECT/INSERT/DELETE 세 개만 남아야 한다.
select policyname, cmd, roles
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and coalesce(qual, with_check, '') ilike '%order-images%'
 order by cmd;


-- ============================================================
-- 롤백 — authenticated 정책을 지우고 public 정책을 되살린다.
-- ⚠️ 되살리면 로그인 없이 주문 사진 폴더 나열·업로드·삭제가 다시 가능해진다.
-- ============================================================
-- drop policy if exists "order-images authenticated select" on storage.objects;
-- drop policy if exists "order-images authenticated insert" on storage.objects;
-- drop policy if exists "order-images authenticated delete" on storage.objects;
--
-- create policy "order-images public select" on storage.objects
--   for select to public using (bucket_id = 'order-images');
-- create policy "order-images public insert" on storage.objects
--   for insert to public with check (bucket_id = 'order-images');
-- create policy "order-images public delete" on storage.objects
--   for delete to public using (bucket_id = 'order-images');
