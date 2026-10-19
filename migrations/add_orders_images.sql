-- orders 테이블에 images 컬럼 추가 (jsonb 배열, 기본값 빈 배열)
-- Supabase 대시보드 → SQL Editor 에서 한 번 실행하세요.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Storage 버킷(order-images)은 이미 Storage API로 생성됨(public read).
-- 인증된 사용자의 업로드 허용 정책(RLS on storage.objects)이 필요하면 Storage 대시보드에서
-- "authenticated users can upload to order-images" 정책을 추가하세요.
