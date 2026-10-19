// Supabase Realtime 구독 훅 모음 — 다중 사용자 동시 작업 시 DB 변경을 실시간으로 화면에 반영
//
// 활성화 필요한 Supabase 설정:
// 1) 대시보드 > Database > Replication > supabase_realtime publication
// 2) 다음 테이블 publication에 추가: orders, payment_logs, inventory, customers, credits
// 3) RLS 정책으로 user_id 격리는 이미 적용되어 있으므로 추가 설정 없음
//
// 활성화 안 된 테이블은 콘솔 경고만 출력하고 정상 동작 (수동 새로고침으로 폴백)

import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "./supabase.js";
import { getUserId } from "./db.js";

// ── 현재 로그인 user_id 가져오기 (마운트 시 1회 fetch) ─────────────
export function useUserId() {
  const [uid, setUid] = useState(null);
  useEffect(() => {
    if (uid) return;
    let alive = true;
    // 한 번 실패하면 끝이던 자리다. 포장 패드가 네트워크가 붙기 전에 열리면 여기서
    // null 을 받고 그대로 굳어, 그 화면은 하루 종일 실시간 구독이 하나도 없는 채로 돈다
    // (다른 사람이 주문을 넣어도 반영되지 않는다). 붙을 때까지 다시 물어본다.
    let timer = 0;
    const tick = async () => {
      try {
        const id = await getUserId();
        if (!alive) return;
        if (id) { setUid(id); return; }
      } catch (e) {
        console.warn("[Realtime] getUserId 실패:", e);
      }
      if (alive) timer = setTimeout(tick, 10000);
    };
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [uid]);
  return uid;
}

// ── 디바운스 콜백 — 짧은 시간 안의 여러 이벤트를 1회 호출로 합침 ──
function useDebouncedCallback(fn, delay = 350) {
  const ref = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  return useCallback((...args) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(() => { ref.current = null; fnRef.current(...args); }, delay);
  }, [delay]);
}

// ── 호출부 콜백을 ref 로 흡수 ─────────────────────────────────────
// 호출부는 { onInsert: row => ... } 처럼 인라인 객체를 넘긴다. 렌더마다 새 함수가
// 만들어지므로 그걸 effect 의존성에 그대로 넣으면, 화면이 다시 그려질 때마다 채널을
// 끊고 다시 붙는다. 등록 한 번에도 상태가 여러 번 바뀌니 그 사이 채널이 몇 번씩
// 끊겼다 붙고, 끊긴 순간에 온 알림은 그대로 사라진다 — 실시간 구독이 목적인 자리에서
// 가장 나쁜 실패다. (payment_logs 만 콜백이 의존성에 없어서 유일하게 멀쩡했다.)
//
// 그래서 콜백은 ref 로 받아 두고 의존성에서 뺀다. 채널은 userId 당 한 번 만들고
// 화면이 사라질 때만 정리한다. 호출부는 고칠 게 없다.
// (useDebouncedCallback 이 fnRef 로 쓰는 것과 같은 방식이다.)
function useHandlers(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  return ref;
}

// ── 단일 테이블 구독 헬퍼 ─────────────────────────────────────────
// onResubscribe: 끊겼다가 다시 붙었을 때(두 번째 SUBSCRIBED 부터). 끊긴 동안 온 알림은
// 사라지므로, 이걸 받는 쪽은 목록을 통째로 다시 읽어 따라잡는다.
function subscribeTable(tableName, userId, onChange, onResubscribe) {
  const channelName = `rt:${tableName}:${userId}`;
  let joins = 0;
  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: tableName,
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        try { onChange?.(payload); } catch (e) { console.error(`[Realtime] ${tableName} handler error:`, e); }
      }
    )
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        joins += 1;
        if (joins > 1) { try { onResubscribe?.(); } catch (e) { console.error(`[Realtime] ${tableName} resubscribe handler error:`, e); } }
      } else if (status === "CLOSED") {
        // 정상적인 채널 정리(removeChannel) — 컴포넌트 unmount, 의존성 변경 재구독,
        // StrictMode effect 이중 실행 등에서 자연히 발생하는 상태라 경고하지 않는다(오탐 방지).
        // console.debug(`[Realtime] '${tableName}' 채널 정리됨 (CLOSED)`);
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[Realtime] '${tableName}' 구독 상태: ${status}. Supabase 대시보드 > Database > Replication 에서 publication에 '${tableName}' 추가 필요.`, err || "");
      }
    });
  return channel;
}

// ── 주문(orders) + 결제로그(payment_logs) 실시간 구독 ────────────
//
// 두 테이블을 한 훅에서 본다. 예전에는 훅이 둘로 나뉘어 있었고, 각자 자기
// 디바운스 타이머를 들고 있었다. 그래서 주문 알림과 결제 알림이 같은 순간에 와도
// 합쳐지지 않고 전체 재조회가 두 번 돌았다.
//
// 주문 1건을 등록하면 알림이 이렇게 흩어져 도착한다:
//   0.0초  주문 INSERT
//   ~0.8초 결제로그 INSERT (적립금차감)
//   ~1.0초 주문 UPDATE (완납 처리)
//   ~1.5초 주문 UPDATE × N행 (합배송)
// 단계 사이가 옛 창(0.35초)보다 길어 각각 따로 터졌다 — 등록 한 번에 주문 전체 +
// 결제로그 전체를 2~4번 다시 읽었다.
//
// 타이머 하나로 모으고 창을 0.5초로 넓혀 한 번으로 접는다. onAny 는 '주문이든
// 결제든 뭔가 바뀌었다' 한 가지 뜻이므로 호출부도 reloadOrders 한 번만 부르면 된다.
//
// onInsert/onUpdate/onDelete 는 디바운스를 타지 않는다 — 편집 중인 주문이 남의 손에
// 바뀌었다고 알리는 자리라 늦으면 의미가 없다.
export function useRealtimeOrdersAndPayments(userId, handlers = {}) {
  const h = useHandlers(handlers);
  const debounced = useDebouncedCallback(() => h.current.onAny?.(), 500);
  useEffect(() => {
    if (!userId) return;
    const orderCh = subscribeTable("orders", userId, (payload) => {
      const { onInsert, onUpdate, onDelete } = h.current;
      if (payload.eventType === "INSERT") onInsert?.(payload.new, payload);
      else if (payload.eventType === "UPDATE") onUpdate?.(payload.new, payload.old, payload);
      else if (payload.eventType === "DELETE") onDelete?.(payload.old, payload);
      debounced();
    });
    // 결제로그 변경은 _computed(미수금)에 반영되므로 주문 목록도 같이 다시 읽어야 한다.
    const payCh = subscribeTable("payment_logs", userId, () => debounced());
    return () => {
      supabase.removeChannel(orderCh);
      supabase.removeChannel(payCh);
    };
  }, [userId, debounced, h]);
}

// ── 재고(inventory) 실시간 구독 ───────────────────────────────────
// 부분 업데이트 가능 — INSERT/UPDATE/DELETE 별로 콜백 분리
export function useRealtimeInventory(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("inventory", userId, (payload) => {
      const { onInsert, onUpdate, onDelete } = h.current;
      if (payload.eventType === "INSERT") onInsert?.(payload.new);
      else if (payload.eventType === "UPDATE") onUpdate?.(payload.new, payload.old);
      else if (payload.eventType === "DELETE") onDelete?.(payload.old);
    });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 고객(customers) 실시간 구독 ────────────────────────────────────
export function useRealtimeCustomers(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("customers", userId, (payload) => {
      const { onInsert, onUpdate, onDelete } = h.current;
      if (payload.eventType === "INSERT") onInsert?.(payload.new);
      else if (payload.eventType === "UPDATE") onUpdate?.(payload.new, payload.old);
      else if (payload.eventType === "DELETE") onDelete?.(payload.old);
    }, () => h.current.onResubscribe?.());
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 적립금(credits) 실시간 구독 ───────────────────────────────────
export function useRealtimeCredits(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("credits", userId, (payload) => {
      const { onInsert, onUpdate, onDelete } = h.current;
      if (payload.eventType === "INSERT") onInsert?.(payload.new);
      else if (payload.eventType === "UPDATE") onUpdate?.(payload.new, payload.old);
      else if (payload.eventType === "DELETE") onDelete?.(payload.old);
    });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 주문 메모(order_notes) 실시간 구독 ────────────────────────────
export function useRealtimeOrderNotes(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("order_notes", userId, (payload) => {
      const { onInsert, onUpdate, onDelete } = h.current;
      if (payload.eventType === "INSERT") onInsert?.(payload.new);
      else if (payload.eventType === "UPDATE") onUpdate?.(payload.new, payload.old);
      else if (payload.eventType === "DELETE") onDelete?.(payload.old);
    });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 미등록 알림판(notices) 실시간 구독 ──────────────────────────
// 관리자가 올리는 순간 전원 화면의 숫자가 올라야 한다. 이게 없으면 새로고침하거나
// 버튼을 눌러야 보여서, 밴드에 올려두고 아무도 안 보는 것과 다를 게 없다.
export function useRealtimeNotices(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("notices", userId, () => { h.current.onAny?.(); });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 라벨 출력 담당 기기(label_station) 실시간 구독 ──────────────
// 담당이 다른 PC 로 넘어가거나 관리자가 해제하는 순간, 이전 기기가 즉시 멈춰야 한다.
// 이게 없으면 "껐는데 그 PC 는 계속 뽑는" 상태가 새로고침 전까지 남는다 —
// 감열지는 되돌릴 수 없어서 그 사이에 나간 라벨은 그대로 버리는 종이다.
export function useRealtimeLabelStation(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("label_station", userId, () => { h.current.onAny?.(); });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 감사 라벨 요청(thanks_label_requests) 실시간 구독 ────────────
// 누가 어디서 "N 장" 을 걸든 라벨 PC 가 곧바로 알아야 한다 (migrations/add_thanks_label.sql).
export function useRealtimeThanksRequests(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("thanks_label_requests", userId, () => { h.current.onAny?.(); });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 품번(products) 실시간 구독 ──────────────────────────────────
// 다른 PC 에서 새 품번을 등록하면 이쪽 자동완성과 롤 라벨(원단명·색상)에 바로 잡혀야 한다.
// (migrations/add_stock_rolls.sql)
export function useRealtimeProducts(userId, handlers = {}) {
  const h = useHandlers(handlers);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("products", userId, () => { h.current.onAny?.(); });
    return () => { supabase.removeChannel(channel); };
  }, [userId, h]);
}

// ── 롤(stock_rolls) 실시간 구독 ─────────────────────────────────
// 다른 PC 에서 검단을 마치면 라벨 PC 가 곧바로 알아야 한다 — 이게 없으면 라벨은
// 라벨 PC 를 새로고침할 때까지 안 나온다.
//
// 한 번에 여러 줄이 바뀐다(롤 10개 입고 = 알림 10번). 짧게 모아 한 번만 다시 읽는다.
// 창을 0.3초로 잡은 건 라벨이 1초 안에 나와야 해서다 — 더 넓히면 그만큼 늦게 나온다.
export function useRealtimeStockRolls(userId, handlers = {}) {
  const h = useHandlers(handlers);
  const debounced = useDebouncedCallback(() => h.current.onAny?.(), 300);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("stock_rolls", userId, () => debounced());
    return () => { supabase.removeChannel(channel); };
  }, [userId, debounced, h]);
}

// ── 품목별 포장 기록(order_item_packing) 실시간 구독 ─────────────
// 포장 태블릿이 두 대 이상일 수 있고, 셀러 화면도 진행률(1/2)을 봐야 한다.
// 한 박스를 싸면 품목 수만큼 알림이 온다 — 짧게 모아 한 번만 다시 읽는다.
// (migrations/add_item_packing.sql)
export function useRealtimeItemPacking(userId, handlers = {}) {
  const h = useHandlers(handlers);
  const debounced = useDebouncedCallback(() => h.current.onAny?.(), 300);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("order_item_packing", userId, () => debounced());
    return () => { supabase.removeChannel(channel); };
  }, [userId, debounced, h]);
}

// ── 링크 주문 초안(link_order_drafts) — 공개 페이지가 넣으면 셀러 화면이 새로고침 없이 본다 ──
export function useRealtimeLinkDrafts(userId, handlers = {}) {
  const h = useHandlers(handlers);
  const debounced = useDebouncedCallback(() => h.current.onAny?.(), 300);
  useEffect(() => {
    if (!userId) return;
    const channel = subscribeTable("link_order_drafts", userId, () => debounced());
    return () => { supabase.removeChannel(channel); };
  }, [userId, debounced, h]);
}

// ── snake_case → camelCase 변환 (toCamel과 동일하지만 부분 업데이트 헬퍼용) ──
// orders 테이블 row를 ErpApp 상태와 동일한 형태로 변환
export function rowToOrderCamel(row) {
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    customer: row.customer,
    phone: row.phone,
    items: row.items || [],
    payment: row.payment,
    address: row.address,
    addressDetail: row.address_detail,
    links: row.links || [],
    note: row.note,
    status: row.status,
    manager: row.manager,
    isHolding: !!row.is_holding,
    totalAmount: row.total_amount || 0,
    depositAmount: row.deposit_amount || 0,
    balanceAmount: row.balance_amount || 0,
    shippingFee: row.shipping_fee || 0,
    feeHeld: Number(row.shipping_fee_held) || null,
    combinedPayment: !!row.combined_payment,
    combinedShipping: !!row.combined_shipping,
    refundAmount: row.refund_amount || 0,
    refundNote: row.refund_note || "",
    refundRequest: row.refund_request || null,
    refundHistory: Array.isArray(row.refund_history) ? row.refund_history : [],
    paymentStatus: row.payment_status || "unpaid",
    salesChannel: row.sales_channel || "",
    images: Array.isArray(row.images) ? row.images : [],
    mergeGroupId: row.merge_group_id || null,
    splitShipping: !!row.split_shipping,
    memo: row.memo || "",
  };
}

// db.js 의 toCustCamel 과 반드시 같은 칸을 내야 한다. 이 함수가 만든 객체가 화면의
// 고객 객체를 통째로 갈아끼우기 때문이다 — 여기서 빠진 칸은 그 순간 화면에서 사라지고,
// 다음 주문 등록이 그 빈 객체를 스프레드해 updateCustomer 로 보내면 DB 까지 "" 로 지워진다.
// (2026-09 양인숙 사례: address_detail·address2 가 이 목록에 없어 상세주소가 나타났다 사라졌다 함)
export function rowToCustomerCamel(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    address: row.address,
    addressDetail: row.address_detail || "",
    address2: row.address2 || "",
    address2Detail: row.address2_detail || "",
    address2Label: row.address2_label || "",
    totalOrders: row.total_orders,
    lastOrder: row.last_order,
    note: row.note,
    nickname: row.nickname || "",
  };
}

export function rowToOrderNoteCamel(row) {
  return {
    id: row.id,
    author: row.author || "",
    body: row.body || "",
    status: row.status || "미등록",
    orderId: row.order_id || null,
    customerId: row.customer_id ?? null,
    reactions: row.reactions || {},
    createdAt: row.created_at,
  };
}
