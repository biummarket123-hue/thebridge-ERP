// 포장대·롤 라벨 전용 DB 접근 — src/lib/db.js 를 고치지 않고 여기서 직접 쿼리한다(2026-10-20 작업 규칙).
import { supabase } from "../../lib/supabase.js";
import { getUserId } from "../../lib/db.js";

/**
 * 브라우저에서 라벨을 바로 뽑은 뒤 표시를 남긴다 — label_printed_at 을 찍고 라벨 PC 용 요청(label_requested_at)은 비운다.
 * 라벨 PC 구조(db.requestRollLabelPrint / claimRollLabelPrint)는 쓰지 않는다. 실패해도 인쇄는 이미 나갔으므로 조용히 넘긴다(호출 쪽 catch).
 * @returns 표시한 롤 수
 */
export async function markRollLabelsPrinted(rollIds) {
  const userId = await getUserId();
  const ids = [...new Set((rollIds || []).filter(Boolean))];
  if (!userId || !ids.length) return 0;
  const { data, error } = await supabase
    .from("stock_rolls")
    .update({ label_printed_at: new Date().toISOString(), label_requested_at: null })
    .eq("user_id", userId)
    .in("id", ids)
    .select("id");
  if (error) throw error;
  return (data || []).length;
}
