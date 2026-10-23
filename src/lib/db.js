import { supabase } from "./supabase.js";
import { uploadProductImage, deleteProductImages } from "./storage.js";
import { CLOSED_STATUSES, nextRollCodes, isRollUnit } from "./rollStock.js";
import { recomputeGroupFreight } from "./freight.js";
import { groupShipTarget } from "./autoMerge.js";

// ── company 모드: 서버가 발급한 세션으로 로그인 ─────────────────
// 계정 이메일·비밀번호는 더 이상 여기(번들)에 없다. 서버 함수 /api/company-session 이
// 환경변수의 자격증명으로 대신 로그인해 세션만 돌려주고, 우리는 그걸 setSession 으로 심는다.
// 그 함수의 게이트 토큰(로그인 화면에서 비밀번호를 맞추면 받는 30일짜리)은 localStorage 에 있다.
// (2026-09-17 보안 진단 C3 — 번들에 박힌 자격증명 제거)
const isCompanyMode = import.meta.env.VITE_MODE === "company";
export const GATE_TOKEN_KEY = "company_gate_token";
export const GATE_UNTIL_KEY = "company_authenticated_until";

let _companyUserId = null;
let _companyAuthInflight = null;

// 게이트 토큰이 거부되면(만료·서명 키 교체) 로그인 화면으로 돌아가야 한다.
// main.jsx 가 이 이벤트를 듣고 authenticated 를 내린다.
function gateLost() {
  try { localStorage.removeItem(GATE_TOKEN_KEY); localStorage.removeItem(GATE_UNTIL_KEY); } catch { /* 저장소 불가 */ }
  try { window.dispatchEvent(new Event("company-gate-lost")); } catch { /* 창 없음 */ }
}

// 서버에서 세션을 받아 심는다. 실패하면 null.
async function fetchAndSetSession() {
  let gate = null;
  try { gate = localStorage.getItem(GATE_TOKEN_KEY); } catch { /* 저장소 불가 */ }
  if (!gate) { gateLost(); return null; }
  const res = await fetch("/api/company-session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Company-Gate": gate },
    body: JSON.stringify({ action: "session" }),
  });
  if (res.status === 401) { gateLost(); return null; }
  if (!res.ok) { console.error("[company-auth] 세션 발급 실패:", res.status); return null; }
  const { session } = await res.json();
  if (!session?.access_token || !session?.refresh_token) return null;
  const { data, error } = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (error || !data?.session) { console.error("[company-auth] setSession 실패:", error?.message); return null; }
  return data.session;
}

// 세션이 만료된 상태를 '데이터가 없음'과 구별하기 위한 표식.
// 이게 없으면 로그인이 끊긴 화면과 정말 주문이 0건인 화면이 똑같이 보인다.
function authLost(msg) {
  const e = new Error(msg || "서버와 연결이 끊겼습니다 — 잠시 후 다시 시도하세요");
  e.code = "AUTH_LOST";
  return e;
}

// company 모드 인증 — 매번 세션이 살아 있는지 확인한다.
//
// ⚠️ 예전에는 user_id 를 한 번 받아 모듈 변수에 캐시하고 끝냈다. 그게 포장 패드에서
//    "탭 숫자가 0,0,0,0 이 되고 아무 동작도 안 하는" 증상의 뿌리였다:
//      1) 패드는 하루 종일 켜둔 채 자다 깨다 한다. 자는 동안 액세스 토큰이 만료되고,
//         깨어나는 순간 네트워크가 아직 안 붙어 있으면 갱신이 실패해 세션이 사라진다.
//      2) 그런데 id 는 캐시에 남아 있으니 앱은 여전히 로그인된 줄 안다.
//      3) 그 상태로 나간 쿼리는 anon 키로 붙는다. RLS 가 user_id = auth.uid() 인데
//         auth.uid() 가 null 이라 '권한 없음(에러)'이 아니라 '해당 행 없음'이 된다 —
//         200 OK + 빈 배열. 그래서 아무 데서도 에러가 안 나고 화면만 조용히 0건이 됐다.
//      4) 쓰기(포장완료·보관 등)도 같은 이유로 0행 갱신 → 눌러도 아무 일이 없다.
//
//    그래서 캐시를 믿지 않고 호출마다 getSession() 으로 확인한다. 세션이 살아 있으면
//    로컬 저장소만 읽으므로 네트워크를 타지 않고, 만료됐으면 라이브러리가 알아서
//    갱신을 시도한다. 그래도 없으면 다시 로그인한다.
//
//    동시 호출은 하나로 묶는다 — 초기 로드만 해도 10개가 한꺼번에 부르는데,
//    그때마다 signInWithPassword 를 열 번 날리면 그게 또 세션을 흔든다.
async function ensureCompanyAuth() {
  if (_companyAuthInflight) return _companyAuthInflight;
  _companyAuthInflight = (async () => {
    try {
      // 1) 기존 세션 확인 (만료됐으면 supabase-js 가 여기서 갱신을 시도한다)
      const { data: { session } } = await supabase.auth.getSession();
      if (session) { _companyUserId = session.user.id; return _companyUserId; }

      // 2) 없으면 서버에서 새 세션을 받아 심는다 (refresh token 폐기·만료 후 회복 경로)
      const fresh = await fetchAndSetSession();
      if (fresh) { _companyUserId = fresh.user.id; return _companyUserId; }

      console.error("[company-auth] 세션을 얻지 못함");
      // 캐시된 id 를 돌려주지 않는다 — 세션 없이 그 id 로 나간 쿼리는 빈 배열을 받아오고,
      // 그건 '주문이 없다'와 구별되지 않는다. 없으면 없다고 해야 위에서 화면을 지키게 된다.
      return null;
    } catch (e) {
      console.error("[company-auth] 예외:", e);
      return null;
    } finally {
      _companyAuthInflight = null;
    }
  })();
  return _companyAuthInflight;
}

// ── 현재 로그인 사용자 id 조회 (멀티테넌트 격리용) ────────────
export async function getUserId() {
  if (isCompanyMode) return ensureCompanyAuth();
  try {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.user?.id || null;
  } catch {
    return null;
  }
}

// ── helpers: snake_case <-> camelCase ─────────────────────────
const toCamel = (row) => ({
  id: row.id,
  date: row.date,
  time: row.time,
  customer: row.customer,
  phone: row.phone,
  items: row.items || [],
  payment: row.payment,
  address: row.address,
  addressDetail: row.address_detail,
  deliveryMessage: row.delivery_message || "",
  links: row.links || [],
  note: row.note,
  status: row.status,
  manager: row.manager,
  isHolding: !!row.is_holding,
  totalAmount: row.total_amount || 0,
  depositAmount: row.deposit_amount || 0,
  balanceAmount: row.balance_amount || 0,
  shippingFee: row.shipping_fee || 0,
  feeHeld: Number(row.shipping_fee_held) || null,   // 합배송으로 묶이면서 내려놓은 택배비(되돌릴 금액)
  combinedPayment: !!row.combined_payment,
  combinedShipping: !!row.combined_shipping,
  refundAmount: row.refund_amount || 0,
  refundNote: row.refund_note || "",
  refundRequest: row.refund_request || null,
  refundHistory: Array.isArray(row.refund_history) ? row.refund_history : [],
  paymentStatus: row.payment_status || "unpaid",
  salesChannel: row.sales_channel || "",
  channelOrderId: row.channel_order_id || "",   // 판매 채널(쿠팡·스마트스토어)의 주문번호 — 같은 주문을 두 번 안 넣는 열쇠(saas_features.sql)
  images: Array.isArray(row.images) ? row.images : [],
  mergeGroupId: row.merge_group_id || null,
  splitShipping: !!row.split_shipping,
  shippedAt: row.shipped_at || null,
  receiptType: row.receipt_type || null,
  receiptIssued: !!row.receipt_issued,
  memo: row.memo || "",
  otherCost: row.other_cost || 0,
  freeShippingUsed: !!row.free_shipping_used,
  // 출고예정일 — 포장 화면의 칸(긴급/당일/익일/예약) 배치 기준.
  // 기존 주문은 NULL이며, shipBucket()이 이를 '당일'로 취급한다.
  shipDate: row.ship_date || null,
  isUrgent: !!row.is_urgent,
  shipDatePulled: !!row.ship_date_pulled,
  createdAt: row.created_at,
  // 포장 시각 + 포장 순간의 품목 지문 (완료 탭 정렬, '포장 후 수정' 감지)
  packedAt: row.packed_at || null,
  packedSig: row.packed_sig || null,
  // 실제로 보관 장소에 넣은 시각. is_holding 은 '보관해 달라는 지시'이고
  // 이 값이 채워져야 '보관 중'이다 (migrations/add_held_at.sql).
  heldAt: row.held_at || null,
  // 보류 — 몇 달씩 못 나가는 건을 출고 큐에서 뺀 것 (migrations/add_parked.sql).
  // 보관과 달리 사유가 반드시 붙는다. 몇 달 뒤 꺼낼 때 그 한 줄이 유일한 단서다.
  isParked: !!row.is_parked,
  parkedAt: row.parked_at || null,
  parkReason: row.park_reason || "",
  // 원단 미도착 호출 (migrations/add_fabric_missing.sql).
  // 포장직원이 "원단이 안 왔다"를 누른 상태 — orders 가 Realtime 구독 대상이라
  // 이 값이 바뀌면 열려 있는 모든 화면에 바로 퍼진다.
  fabricMissing: !!row.fabric_missing,
  // 안 온 품목의 자리번호 배열 — 한 주문에 원단이 여럿일 때 하나만 안 오는 경우가 있다
  fabricMissingItems: Array.isArray(row.fabric_missing_items) ? row.fabric_missing_items : [],
  fabricMissingAt: row.fabric_missing_at || null,
  // 출고요청 (migrations/add_ship_request.sql).
  // 보관중이던 건을 셀러가 "이제 내보내라"고 넘긴 표시. 이 값이 차 있으면
  // 보관은 이미 풀렸고, 포장탭 당일 칸에서 포장을 기다리는 중이다.
  shipRequestedAt: row.ship_requested_at || null,
  shipRequestedBy: row.ship_requested_by || "",
  // 원단 라벨을 뽑은 시각 (migrations/add_label_printed.sql).
  // 비어 있으면 '아직 안 뽑음'이다 — 출력 담당 PC 가 이 값만 보고 대상을 고른다.
  labelPrintedAt: row.label_printed_at || null,
  // 라벨을 뽑아달라고 건 시각 (migrations/add_label_request.sql).
  // 요청 = "뽑아줘", 위의 printed = "뽑았다". 둘이 있어야 재출력이 구분된다.
  labelRequestedAt: row.label_requested_at || null,
  labelRequestedBy: row.label_requested_by || "",
  // 택배 송장을 뽑은 시각 (migrations/add_order_events.sql).
  // 전체현황 탭이 "송장은 나갔는데 출고완료가 아닌 주문"을 찾는 데 쓴다.
  invoicePrintedAt: row.invoice_printed_at || null,
  // 택배사 — 사람이 직접 고른 값. 비어 있으면 배송비로 자동 판정한다(lib/courier.js).
  courier: row.courier || null,
  trackingNo: row.tracking_no || "",   // 송장번호(saas_credit_tracking.sql) — 출고완료 때 넣는다
  // 실제로 나간 방법 — 출고되는 순간 적힌다.
  shippedVia: row.shipped_via || null,
});

const toLogCamel = (row) => ({
  id: row.id,
  date: row.date,
  time: row.time,
  type: row.type,
  itemNo: row.item_no,
  fabric: row.fabric,
  color: row.color,
  qty: row.qty,
  costPrice: row.cost_price,
  ref: row.ref,
  note: row.note,
});

const toCustCamel = (row) => ({
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
  allowCredit: !!row.allow_credit,   // 외상 거래처 — 입금 전 출고 허용(saas_credit_tracking.sql)
});

const toDepositCamel = (row) => ({
  id: row.id,
  customer: row.customer,
  phone: row.phone,
  content: row.content,
  total: row.total,
  deposit: row.deposit,
  depositDate: row.deposit_date,
  balancePaid: row.balance_paid,
  balanceDate: row.balance_date,
  regDate: row.reg_date,
  note: row.note,
});

// ── Orders ────────────────────────────────────────────────────
// ERP 워크플로우 주문만 가져오기 — 엑셀 업로드 데이터(time="00:00")는 제외
// 엑셀 데이터는 대시보드(fetchCompletedOrders)에서만 표시되어야 하므로
// 주문현황/정산관리/카운트 등 어디에도 영향을 주면 안 됨
// (Supabase REST 기본 max-rows=1000 우회 — 1000건씩 페이지네이션)
export async function fetchOrders() {
  const userId = await getUserId();
  // 세션이 끊겼으면 빈 배열이 아니라 에러를 던진다.
  // 빈 배열을 돌려주면 화면이 그걸 '주문 0건'으로 그려버린다 — 포장 화면에서는
  // 그게 "오늘 쌀 게 없다"로 읽혀서, 실제로는 밀려 있는 물량을 아무도 안 싼다.
  if (!userId) throw authLost();
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .neq("time", "00:00") // 엑셀 업로드 데이터 제외
      // 아직 일이 남은 주문만 읽는다.
      //
      // 예전에는 조건이 위의 "엑셀 제외" 하나뿐이라 4,600건을 전부 받아왔다. 그런데
      // 이 목록을 쓰는 화면은 하나같이 출고완료를 다시 걸러냈다 — 주문현황·정산관리·
      // 거래명세서·포장·자동합배송·미입금 배지가 전부. 서버가 할 일을 4,600건 받아와서
      // 하고 있었고, 그게 실시간 이벤트마다 반복됐다.
      //
      // 환불신청은 출고완료여도 남긴다. 물건은 나갔지만 돌려줄 돈이 남아 있어서
      // 정산관리에 계속 떠야 한다(DepositTab 도 같은 예외를 둔다).
      //
      // status IS NULL 을 명시적으로 넣는 이유: SQL 에서 NULL <> '출고완료' 는 참이
      // 아니라 NULL 이다. 이 절이 없으면 status 가 비어 있는 옛 주문이 통째로 사라진다.
      //
      // 출고완료 건이 필요한 화면(반품·마켓원장)은 자기가 직접 읽는다.
      .or("status.is.null,status.neq.출고완료,payment.eq.환불신청")
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  // 0건이면 한 번 더 의심한다. 토큰이 이 요청 직전에 만료되면 anon 키로 붙어
  // RLS 에 전부 걸러진 채 200 OK + 빈 배열이 온다 — 에러가 아니라 '없음'으로 보인다.
  // 여기서는 getUserId() 가 아니라 세션을 직접 본다. getUserId() 는 company 모드에서
  // 다시 로그인까지 해버리는데, 그러면 방금 실패한 요청이 성공한 것처럼 보여
  // 빈 배열이 '진짜 0건'으로 통과한다 — 고치려던 그 증상 그대로다.
  if (all.length === 0) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw authLost();
  }
  if (all.length > 0) _orderCols = new Set(Object.keys(all[0]));
  return all.map(toCamel);
}

// orders 에 그 칸이 있는가 — 읽어온 행에 그 칸이 실려 왔는지로 안다.
// 나중에 붙은 칸(송장 출력 시각 등)은 마이그레이션을 돌리기 전에는 없다. 화면이 그 칸을
// 조건으로 쓰면(예: "송장을 뽑은 박스만 인계") 칸이 없는 동안 아무것도 조건을 못 채워
// 업무가 통째로 멈춘다. 없을 때는 그 조건을 빼고 돌아가게 하려고 묻는다.
// 아직 한 건도 못 읽었으면 있다고 본다 — 모르는 걸 없다고 단정하지 않는다.
let _orderCols = null;
export function hasOrderColumn(name) {
  return _orderCols ? _orderCols.has(name) : true;
}

// 엑셀 업로드 전용: status/payment를 무조건 "출고완료"/"입금완료"로 고정.
// 청크(20건/회)로 끊어 INSERT — Supabase 페이로드 한계(~6MB) / 게이트웨이 타임아웃 회피.
// 청크 실패 시 에러 코드/상세/힌트와 첫 행 샘플을 콘솔에 출력해 원인 추적 가능.
export async function insertOrderBatch(ordersArray) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");

  const buildRow = (o) => ({
    user_id: userId,
    date: o.date,
    time: o.time,
    customer: o.customer,
    phone: o.phone || null,
    items: ensureItemIds(o.items),
    payment: "입금완료",
    address: o.address || null,
    address_detail: o.addressDetail || null,
    delivery_message: o.deliveryMessage || null,
    links: o.links || [],
    note: o.note || null,
    status: "출고완료",
    manager: o.manager || "",
    total_amount: Number(o.totalAmount) || 0,
    shipping_fee: Number(o.shippingFee) || 0,
    combined_payment: !!o.combinedPayment,
    combined_shipping: !!o.combinedShipping,
    deposit_amount: Number(o.depositAmount) || 0,
    balance_amount: Number(o.balanceAmount) || 0,
    refund_amount: Number(o.refundAmount) || 0,
    refund_note: o.refundNote || "",
    payment_status: o.paymentStatus || "unpaid",
    sales_channel: o.salesChannel || "",
    receipt_type: o.receiptType || null,
  });

  const CHUNK = 20;
  const total = ordersArray.length;
  const totalChunks = Math.ceil(total / CHUNK);
  const inserted = [];

  console.log(`[엑셀업로드] 시작 — 총 ${total}건, ${CHUNK}건씩 ${totalChunks}회`);

  for (let i = 0; i < total; i += CHUNK) {
    const sliceOrders = ordersArray.slice(i, i + CHUNK);
    const rows = sliceOrders.map(buildRow);
    const chunkIdx = Math.floor(i / CHUNK) + 1;

    let data, error;
    try {
      ({ data, error } = await supabase.from("orders").insert(rows).select());
    } catch (netErr) {
      console.error(`[엑셀업로드] 청크 ${chunkIdx}/${totalChunks} 네트워크 예외`, netErr);
      console.error(`[엑셀업로드] 실패한 청크의 첫 행:`, JSON.stringify(rows[0], null, 2));
      throw new Error(`청크 ${chunkIdx}/${totalChunks} 네트워크 실패 (${inserted.length}건 저장됨): ${netErr.message}`);
    }
    if (error) {
      console.error(`[엑셀업로드] 청크 ${chunkIdx}/${totalChunks} 실패`, {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      console.error(`[엑셀업로드] 실패한 청크의 첫 행:`, JSON.stringify(rows[0], null, 2));
      throw new Error(`청크 ${chunkIdx}/${totalChunks} 실패 (${inserted.length}건 저장됨): ${error.message}`);
    }
    inserted.push(...(data || []));
    if (chunkIdx === 1 || chunkIdx % 10 === 0 || chunkIdx === totalChunks) {
      console.log(`[엑셀업로드] 청크 ${chunkIdx}/${totalChunks} 완료 (누적 ${inserted.length}건)`);
    }
  }

  // payment_logs — 대시보드 매출 계산용 입금 로그 + 환불 파싱 로그.
  const logRows = [];
  inserted.forEach((r, idx) => {
    if ((r.total_amount || 0) > 0) {
      logRows.push({
        user_id: userId,
        order_id: r.id,
        customer: r.customer || "",
        type: "입금",
        amount: r.total_amount,
        note: "엑셀 업로드 일괄입금",
      });
    }
    const refunds = ordersArray[idx]?._refunds;
    if (refunds?.cash > 0) {
      logRows.push({
        user_id: userId,
        order_id: r.id,
        customer: r.customer || "",
        type: "현금환불",
        amount: refunds.cash,
        note: "엑셀 업로드 — 비고 자동 파싱",
      });
    }
    if (refunds?.credit > 0) {
      logRows.push({
        user_id: userId,
        order_id: r.id,
        customer: r.customer || "",
        type: "적립금전환",
        amount: refunds.credit,
        note: "엑셀 업로드 — 비고 자동 파싱",
      });
    }
  });

  if (logRows.length > 0) {
    const LOG_CHUNK = 100; // payment_logs는 컬럼이 적어 좀 더 크게
    const totalLogChunks = Math.ceil(logRows.length / LOG_CHUNK);
    console.log(`[엑셀업로드] payment_logs ${logRows.length}건 / ${LOG_CHUNK}건씩 ${totalLogChunks}회`);
    for (let i = 0; i < logRows.length; i += LOG_CHUNK) {
      const slice = logRows.slice(i, i + LOG_CHUNK);
      const logChunkIdx = Math.floor(i / LOG_CHUNK) + 1;
      const { error: logErr } = await supabase.from("payment_logs").insert(slice);
      if (logErr) {
        console.error(`[엑셀업로드] payment_logs 청크 ${logChunkIdx}/${totalLogChunks} 실패`, {
          code: logErr.code, message: logErr.message, details: logErr.details, hint: logErr.hint,
        });
        console.error(`[엑셀업로드] payment_logs 실패 첫 행:`, JSON.stringify(slice[0], null, 2));
        throw new Error(`주문 ${inserted.length}건 저장 완료. 입금이력 저장 실패: ${logErr.message}`);
      }
    }
  }

  console.log(`[엑셀업로드] 완료 — 주문 ${inserted.length}건 + 로그 ${logRows.length}건`);
  return inserted.map(toCamel);
}

// opts.route: 변경 기록에 남길 자리. 안 넘기면 현재 탭 이름이 남는다.
export async function insertOrder(order, opts = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await safeWrite(opts.route, {
    user_id: userId,
    date: order.date,
    time: order.time,
    customer: order.customer,
    phone: order.phone || null,
    items: ensureItemIds(order.items),
    payment: order.payment || "미입금",
    address: order.address || null,
    address_detail: order.addressDetail || null,
    delivery_message: order.deliveryMessage || null,
    links: order.links || [],
    note: order.note || null,
    status: order.status || "접수",
    manager: order.manager || "",
    total_amount: order.totalAmount || 0,
    shipping_fee: order.shippingFee || 0,
    combined_payment: !!order.combinedPayment,
    combined_shipping: !!order.combinedShipping,
    deposit_amount: order.depositAmount || 0,
    balance_amount: order.balanceAmount || 0,
    refund_amount: order.refundAmount || 0,
    refund_note: order.refundNote || "",
    payment_status: order.paymentStatus || "unpaid",
    sales_channel: order.salesChannel || "",
    ...(order.channelOrderId ? { channel_order_id: String(order.channelOrderId) } : {}),
    images: order.images || [],
    receipt_type: order.receiptType || null,
    receipt_issued: !!order.receiptIssued,
    memo: order.memo || null,
    other_cost: order.otherCost || 0,
    free_shipping_used: !!order.freeShippingUsed,
    // 미지정이면 NULL — 앱이 '당일'로 취급하므로 유실되지 않는다.
    ship_date: order.shipDate || null,
    is_urgent: !!order.isUrgent,
    // 택배사는 사람이 직접 골랐을 때만 넣는다. 비어 있으면 배송비로 자동 판정한다(lib/courier.js).
    ...(order.courier ? { courier: order.courier } : {}),
  }, (body) => supabase.from("orders").insert(body).select());
  if (error) throw error;
  return data?.[0] ? toCamel(data[0]) : null;
}

// 반품 등록 후보 검색 — 출고완료 주문을 서버에서 찾는다.
//
// 예전에는 화면이 들고 있는 주문 목록(4,600건 전부)에서 걸러냈다. 이제 그 목록은
// 활성 주문만 담으므로(fetchOrders), 출고완료를 다루는 이 화면은 직접 물어봐야 한다.
// 반품은 본래 "이미 나간 주문"에 거는 것이라 이 조회는 성격상 따로일 수밖에 없다.
//
// 고객명 · 주문번호 앞자리 · 전화번호로 찾는다. 결과는 상한을 둔다 — 반품 등록은
// 한 건을 골라내는 작업이라 목록이 길 이유가 없다.
export async function searchShippedOrders(query, limit = 30) {
  const userId = await getUserId();
  if (!userId) return [];
  const q = String(query || "").trim();
  if (q.length < 2) return [];   // 한 글자로는 거의 전부가 걸려 의미가 없다
  // PostgREST or() 는 쉼표로 조건을 나누므로 값에 든 쉼표·괄호는 미리 턴다.
  const safe = q.replace(/[,()*]/g, " ").trim();
  if (!safe) return [];
  const digits = q.replace(/\D/g, "");
  const conds = [`customer.ilike.*${safe}*`];
  if (digits.length >= 2) conds.push(`phone.ilike.*${digits}*`);
  // id 는 uuid 라 ilike 가 안 먹는다. 앞자리로 찾을 수 있게 텍스트 캐스팅 대신
  // 정확히 일치할 때만 얹는다(주문번호 전체를 붙여넣는 경우).
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "출고완료")
    .or(conds.join(","))
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(toCamel);
}

// 출고완료 주문의 '누구 것인지'만 전부 읽는다 — 고객관리의 출고 건수·최근 출고일용.
//
// 화면이 들고 있는 주문 목록은 활성 건뿐이다(fetchOrders). 그 뒤로 고객관리는 출고완료
// 주문을 하나도 못 봐서, 출고 건수를 저장된 숫자(total_orders)로만 때웠고 같은 이름의
// 고객이 둘 이상이면 0건으로 나왔다. 주문 이력도 전원 '주문 없음'이었다.
//
// 품목·금액은 읽지 않는다. 건수를 세는 데는 고객명·전화·날짜면 되고, 몇천 건의 품목을
// 통째로 받으면 목록을 가볍게 한 보람이 없다. 이력에 보일 몇 건은 펼칠 때 따로 읽는다
// (fetchOrdersByIds). 엑셀로 올린 과거 주문(time = "00:00")은 예전처럼 뺀다.
export async function fetchShippedOrderKeys() {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer, phone, date, status, created_at")
      .eq("user_id", userId)
      .eq("status", "출고완료")
      .neq("time", "00:00")
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(r => ({ id: r.id, customer: r.customer, phone: r.phone, date: r.date, status: r.status, createdAt: r.created_at }));
}

// id 목록으로 주문을 가져온다 — 반품 목록이 가리키는 원 주문처럼,
// 활성 목록에 없을 수도 있는 건을 콕 집어 읽을 때 쓴다.
// PostgREST in() 은 URL 길이 제한이 있어 200개씩 끊는다.
export async function fetchOrdersByIds(ids) {
  const userId = await getUserId();
  if (!userId) return [];
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (uniq.length === 0) return [];
  const CHUNK = 200;
  const all = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .in("id", uniq.slice(i, i + CHUNK));
    if (error) throw error;
    all.push(...(data || []));
  }
  return all.map(toCamel);
}

// 합배송 그룹에 속한 주문을 전부 가져온다.
//
// 담당자 락은 "같은 합배송 그룹에 내 주문이 있으면 허용"이라는 예외를 둔다.
// 그런데 그룹은 같은 날 같이 나가므로, 한 건이 출고완료면 그룹원도 대개 출고완료다 —
// 활성 주문 목록만 보면 그룹이 통째로 안 보여서, 원래 열리던 것이 잠긴다.
export async function fetchOrdersByMergeGroups(groupIds) {
  const userId = await getUserId();
  if (!userId) return [];
  const uniq = [...new Set((groupIds || []).filter(Boolean))];
  if (uniq.length === 0) return [];
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("user_id", userId)
    .in("merge_group_id", uniq);
  if (error) throw error;
  return (data || []).map(toCamel);
}

// 모든 완료 주문 조회 — 1000건씩 페이지네이션
// 출고완료(status="출고완료") 또는 전액환불(payment="환불") 주문 반환
// 호출자(DashboardTab)가 _computed.paymentStatus로 추가 필터링 (입금완료/부분환불/환불완료)
// 날짜 필터는 클라이언트에서 order.date 기준으로 적용
export async function fetchCompletedOrders() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .or("status.eq.출고완료,payment.eq.환불")
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(toCamel);
}

// 모든 주문 — 1000건씩 페이지네이션 (대시보드 통합 뷰용 — time="00:00" 엑셀 업로드 포함 전체)
export async function fetchAllOrders() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(r => ({ ...toCamel(r), createdAt: r.created_at }));
}

// 모든 출고완료 주문 — 1000건씩 페이지네이션
// 날짜 필터는 호출자(exportMarketLedger 등)에서 order.date 기준 클라이언트 필터로 적용
export async function fetchShippedOrders() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "출고완료")
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(toCamel);
}

// startDate/endDate: ISO string, null for no bound
export async function fetchUnpaidOrders(startDate, endDate) {
  const userId = await getUserId();
  if (!userId) return [];
  let q = supabase
    .from("orders")
    .select("*")
    .eq("user_id", userId)
    .neq("payment", "입금완료")
    .order("created_at", { ascending: false });
  if (startDate) q = q.gte("created_at", startDate + "T00:00:00");
  if (endDate) q = q.lte("created_at", endDate + "T23:59:59");
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(toCamel);
}

// 환불신청 처리(승인/반려/취소) 시 refund_request를 비우기 전에 이력으로 보존.
// updateOrder에 합쳐 쓸 fields 조각을 반환 — 진행 중 신청이 없으면 빈 객체.
// result: "승인" | "반려" | "취소", extra: resolvedMethod/resolvedAmount/rejectReason 등
export function archiveRefundRequest(order, result, extra = {}) {
  const rr = order?.refundRequest;
  if (!rr) return {};
  const entry = { ...rr, result, processedAt: new Date().toISOString(), ...extra };
  return { refund_history: [...(order.refundHistory || []), entry] };
}

// ── 변경 기록용 도장 (migrations/add_order_events.sql) ─────────
// 주문을 고칠 때마다 "누가 · 어느 화면에서 · 언제"를 orders 에 같이 쓴다. 기록 자체는
// DB 트리거가 남기고, 트리거는 이 도장을 읽어 작업자를 채운다.
//
// 호출하는 쪽이 매번 넘기지 않는다 — 주문을 고치는 자리가 스무 군데가 넘어서, 넘기는 걸
// 한 군데만 빠뜨려도 그 길의 기록은 작업자가 빈다. 화면(ErpApp)이 작업자와 현재 탭을
// 여기에 한 번 알려두면, 아래 쓰기 함수들이 알아서 찍는다.
// route 를 따로 넘기면 그게 우선한다("출고완료 버튼", "송장 + 출고"처럼 탭보다 구체적인 자리).
let _actor = "";
let _screen = "";
// 도장 칸이 아직 없는 DB(마이그레이션 전)에서는 끈다. 없는 칸을 쓰면 주문 저장이
// 통째로 실패하는데, 기록 때문에 저장이 막히면 안 된다.
let _stampOn = true;

export function setActor(name) { _actor = name || ""; }
export function setScreen(label) { _screen = label || ""; }

const stampOf = (route) => _stampOn
  ? { last_actor: _actor, last_route: route || _screen, last_actor_at: new Date().toISOString() }
  : {};

const STAMP_COLS = ["last_actor", "last_route", "last_actor_at"];
// 나중에 붙은 칸 — 마이그레이션을 안 돌린 DB 에는 없다. 없으면 그 칸만 빼고 저장한다.
// 여기 없는 칸이 빠졌다고 나오면 그건 진짜 오류라 그대로 돌려준다.
const OPTIONAL_COLS = [...STAMP_COLS, "invoice_printed_at", "courier", "shipped_via", "shipping_fee_held", "channel_order_id", "tracking_no"];
const MIGRATION_OF = (col) => col === "shipping_fee_held" ? "add_shipping_fee_held.sql" : col === "channel_order_id" ? "saas_features.sql" : col === "tracking_no" ? "saas_credit_tracking.sql" : "add_order_events.sql";

// PostgREST 가 "그런 칸 없다"고 할 때 어느 칸인지 — 메시지에서 이름을 꺼낸다.
//   PGRST204  Could not find the 'last_actor' column of 'orders' in the schema cache
//   42703     column "last_actor" of relation "orders" does not exist
const missingColumnOf = (error) => {
  if (!error || (error.code !== "PGRST204" && error.code !== "42703")) return null;
  const m = /'([a-z_]+)' column|column "?([a-z_]+)"?/i.exec(error.message || "");
  return m ? (m[1] || m[2]) : null;
};

/**
 * orders 에 쓴다 — 도장을 같이 찍고, 없는 칸 때문에 실패하면 그 칸을 빼고 다시 쓴다.
 * run(body) 는 쿼리를 만들어 돌려준다.
 *
 * 기록·택배사 같은 덧붙은 기능 때문에 주문 저장이 막히면 안 된다. 다시 쓰는 건 안전하다 —
 * 칸이 없어서 난 실패는 아무 행도 못 바꾼 채 끝난 것이라 두 번 쓰이지 않는다.
 *
 * 뺄 것을 다 뺐더니 쓸 게 없으면(예: 택배사만 바꾸려 했는데 그 칸이 없음) 오류를 돌려준다.
 * 조용히 성공한 척하면 화면만 바뀌고 새로고침하면 되돌아간다.
 */
async function safeWrite(route, payload, run) {
  const body = { ...payload, ...stampOf(route) };
  for (let i = 0; i < OPTIONAL_COLS.length + 1; i++) {
    const res = await run(body);
    const col = missingColumnOf(res.error);
    if (!col || !OPTIONAL_COLS.includes(col) || !(col in body)) return res;
    console.warn(`[orders] '${col}' 칸이 없습니다 — migrations/${MIGRATION_OF(col)} 을 실행하세요. 그 칸은 빼고 저장합니다.`);
    if (STAMP_COLS.includes(col)) { _stampOn = false; for (const c of STAMP_COLS) delete body[c]; }
    else delete body[col];
    if (Object.keys(body).every(k => STAMP_COLS.includes(k))) {
      return { data: null, error: { code: "ERP_NOT_MIGRATED", message: "이 기능은 아직 켜지지 않았습니다 — 관리자가 DB 설정(add_order_events.sql)을 먼저 실행해야 합니다" } };
    }
  }
  return run(body);
}

// camelCase → snake_case 호환 (호출자가 어느 쪽으로 보내도 동작).
// updateOrder 와 updateOrdersBulk 가 같은 규칙을 써야 한다 — 한쪽에만 컬럼을 추가하면
// 그쪽 경로로 저장한 값만 조용히 사라진다.
function orderFieldsToRow(fields) {
  const f = { ...fields };
  // 품목을 고쳐 저장하는 모든 길(updateOrder·updateOrdersBulk·claimShipOut)이 여기를 지난다.
  if ("items" in f) f.items = ensureItemIds(f.items);
  if ("shippedAt" in f) { f.shipped_at = f.shippedAt; delete f.shippedAt; }
  if ("receiptType" in f) { f.receipt_type = f.receiptType; delete f.receiptType; }
  if ("receiptIssued" in f) { f.receipt_issued = !!f.receiptIssued; delete f.receiptIssued; }
  if ("otherCost" in f) { f.other_cost = f.otherCost; delete f.otherCost; }
  if ("splitShipping" in f) { f.split_shipping = !!f.splitShipping; delete f.splitShipping; }
  if ("shippingFee" in f) { f.shipping_fee = Number(f.shippingFee) || 0; delete f.shippingFee; }
  if ("totalAmount" in f) { f.total_amount = Number(f.totalAmount) || 0; delete f.totalAmount; }
  if ("feeHeld" in f) { f.shipping_fee_held = Number(f.feeHeld) > 0 ? Number(f.feeHeld) : null; delete f.feeHeld; }
  if ("mergeGroupId" in f) { f.merge_group_id = f.mergeGroupId; delete f.mergeGroupId; }
  if ("freeShippingUsed" in f) { f.free_shipping_used = !!f.freeShippingUsed; delete f.freeShippingUsed; }
  if ("isHolding" in f) { f.is_holding = !!f.isHolding; delete f.isHolding; }
  if ("shipDate" in f) { f.ship_date = f.shipDate || null; delete f.shipDate; }
  if ("isUrgent" in f) { f.is_urgent = !!f.isUrgent; delete f.isUrgent; }
  if ("shipDatePulled" in f) { f.ship_date_pulled = !!f.shipDatePulled; delete f.shipDatePulled; }
  if ("packedAt" in f) { f.packed_at = f.packedAt || null; delete f.packedAt; }
  if ("packedSig" in f) { f.packed_sig = f.packedSig || null; delete f.packedSig; }
  if ("heldAt" in f) { f.held_at = f.heldAt || null; delete f.heldAt; }
  if ("isParked" in f) { f.is_parked = !!f.isParked; delete f.isParked; }
  if ("parkedAt" in f) { f.parked_at = f.parkedAt || null; delete f.parkedAt; }
  if ("parkReason" in f) { f.park_reason = f.parkReason || null; delete f.parkReason; }
  if ("fabricMissing" in f) { f.fabric_missing = !!f.fabricMissing; delete f.fabricMissing; }
  if ("fabricMissingItems" in f) { f.fabric_missing_items = f.fabricMissingItems || []; delete f.fabricMissingItems; }
  if ("fabricMissingAt" in f) { f.fabric_missing_at = f.fabricMissingAt || null; delete f.fabricMissingAt; }
  if ("labelPrintedAt" in f) { f.label_printed_at = f.labelPrintedAt || null; delete f.labelPrintedAt; }
  if ("labelRequestedAt" in f) { f.label_requested_at = f.labelRequestedAt || null; delete f.labelRequestedAt; }
  if ("labelRequestedBy" in f) { f.label_requested_by = f.labelRequestedBy || null; delete f.labelRequestedBy; }
  if ("shipRequestedAt" in f) { f.ship_requested_at = f.shipRequestedAt || null; delete f.shipRequestedAt; }
  if ("shipRequestedBy" in f) { f.ship_requested_by = f.shipRequestedBy || null; delete f.shipRequestedBy; }
  if ("invoicePrintedAt" in f) { f.invoice_printed_at = f.invoicePrintedAt || null; delete f.invoicePrintedAt; }
  if ("courier" in f) { f.courier = f.courier || null; }
  if ("shippedVia" in f) { f.shipped_via = f.shippedVia || null; delete f.shippedVia; }
  if ("channelOrderId" in f) { f.channel_order_id = f.channelOrderId || null; delete f.channelOrderId; }
  if ("trackingNo" in f) { f.tracking_no = String(f.trackingNo || "").replace(/[^0-9A-Za-z]/g, ""); delete f.trackingNo; }
  return f;
}

/**
 * 거래처 이름을 바꿀 때 이름으로 묶인 장부(적립금·입금 로그·무료배송권·주문의 거래처명)도 따라 바꾼다.
 * 적립금 잔액은 credits.customer 이름으로 합산되어서(getCustomerCredit) 이름만 바꾸면 잔액이 끊긴다(2026-10-23 점검).
 * 같은 옛 이름의 다른 거래처(동명이인)가 있으면 부르지 말 것 — 그 사람 장부까지 바뀐다. 호출자(CustomersPage)가 거른다.
 */
export async function renameCustomerRefs(oldName, newName) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const a = String(oldName || "").trim(), b = String(newName || "").trim();
  if (!a || !b || a === b) return { changed: 0 };
  let changed = 0;
  for (const table of ["credits", "payment_logs", "free_shipping_coupons", "orders"]) {
    const { data, error } = await supabase.from(table).update({ customer: b }).eq("user_id", userId).eq("customer", a).select("id");
    if (error) { console.warn(`[db] ${table} 거래처명 바꾸기 실패:`, error.message); continue; }
    changed += (data || []).length;
  }
  return { changed };
}

// 여러 주문에 같은 값을 한 번에 쓴다 — 합배송 그룹의 출고예정일처럼 "다 같이 바뀌거나
// 아무것도 안 바뀌거나"여야 하는 자리용.
//
// 하나씩 await 로 돌면 묶인 건수만큼 서버를 왕복한다(3건이면 3번). 등록 버튼을 누른
// 사람은 그 시간을 그대로 기다린다. 중간에 하나가 실패하면 반만 바뀐 채로 남기도 한다.
//
// updateOrder 와 같은 이유로 .select() 로 바뀐 행 수를 확인한다 — 세션이 끊기면 RLS 가
// 이 행들을 안 보이게 만드는데, 그건 에러가 아니라 '0행 갱신 · 200 OK' 로 온다.
// 화면만 바뀌고 DB 는 그대로인 상태를 여기서 잡는다.
export async function updateOrdersBulk(ids, fields, opts = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  if (!Array.isArray(ids) || ids.length === 0) return;
  const uniq = [...new Set(ids)];
  const f = orderFieldsToRow(fields);
  const { data, error } = await safeWrite(opts.route, f, (body) => supabase
    .from("orders")
    .update(body)
    .in("id", uniq)
    .eq("user_id", userId)
    .select("id"));
  if (error) throw error;
  if (!data || data.length !== uniq.length) {
    throw authLost(`저장되지 않았습니다 — ${uniq.length}건 중 ${data?.length || 0}건만 반영됐습니다 (연결이 끊겼거나 주문이 삭제되었습니다)`);
  }
}

export async function updateOrder(id, fields, opts = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const f = orderFieldsToRow(fields);
  // .select() 로 '몇 행이 바뀌었는지'를 받아온다.
  // 세션이 끊긴 채로 쓰면 RLS 가 이 행을 안 보이게 만드는데, 그건 에러가 아니라
  // '0행 갱신 · 200 OK' 로 돌아온다. 그대로 두면 화면은 포장완료로 바뀌고 DB 는
  // 그대로라, 다시 읽는 순간 되돌아간다 — 눌러도 아무 일이 없는 것처럼 보이던 이유다.
  const { data, error } = await safeWrite(opts.route, f, (body) => supabase
    .from("orders")
    .update(body)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id"));
  if (error) throw error;
  if (!data || data.length === 0) throw authLost("저장되지 않았습니다 — 연결이 끊겼거나 주문이 삭제되었습니다");
}

// 품목마다 고유 id. 포장 기록·재고 원장이 "이 주문의 몇 번째 품목"이 아니라 이 id 로 가리킨다.
// 자리번호(index)로 가리키면 품목을 지우거나 순서를 바꾸는 순간 기록이 엉뚱한 품목을 가리킨다.
// 이미 id 가 있는 품목은 그대로 둔다 — 수정 저장 때 id 가 바뀌면 포장 기록과 끊어진다.
// 화면 코드는 이 함수를 모른다. 저장 계층(insertOrder·insertOrderBatch·orderFieldsToRow)이 부른다.
export function ensureItemIds(items) {
  return (items || []).map(it => it?.itemId ? it : { ...it, itemId: newItemId() });
}
// crypto.randomUUID 는 https·localhost 에서만 있다. http 로 연 사내 주소에서는 없으므로 대체한다.
function newItemId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 포장 시점의 품목 구성을 한 줄로 박제한다 — "원단|색|수량|단위" 를 이어붙인 지문.
 * 이 값이 지금 품목과 다르면 박스 안과 카드가 어긋난 것이다.
 * 금액·품번은 넣지 않는다. 값을 고쳐도 박스를 다시 열 일은 없기 때문.
 */
export function itemsSig(items) {
  return (items || [])
    .map(i => `${(i.fabric || "").trim()}|${(i.color || "").trim()}|${i.qty || 0}|${i.unit || "마"}`)
    .join("~");
}

/**
 * 포장완료 / 포장완료 취소 — 상태와 함께 포장 시각·품목 지문을 맞춘다.
 * 상태만 따로 쓰는 곳이 생기면 완료 탭 정렬과 수정 감지가 조용히 어긋나므로 여기로 모은다.
 */
export async function setOrderPacked(order, packed) {
  const patch = packed
    ? { status: "포장완료", packedAt: new Date().toISOString(), packedSig: itemsSig(order.items),
        // 쌌다는 건 원단이 왔다는 뜻이다 — 별도로 해제를 누르게 하면 잊고 지나가서
        // 이미 나간 주문이 배너에 계속 걸려 있다. 포장완료가 곧 도착 확인이다.
        fabricMissing: false, fabricMissingItems: [], fabricMissingAt: null }
    : { status: "접수", packedAt: null, packedSig: null };
  // 레거시 보관(status="보관")은 상태를 덮으면 보관 표시가 사라진다 → is_holding 으로 승격
  if (order.status === "보관") patch.isHolding = true;
  await updateOrder(order.id, patch);
  return patch;
}

// ── 원단 미도착 표시 ─────────────────────────────────────────
// 세 컬럼이 늘 함께 움직여야 한다. 한 군데서라도 일부만 건드리면
// '표시는 켜져 있는데 안 온 품목은 없는' 유령 상태가 남아 배너에 빈 줄로 뜬다.

/** 표시 켜기 — 포장직원이 품목 옆 버튼을 누를 때. 안 온 원단 하나만 건다. */
export async function callForFabric(order, itemIdx) {
  const cur = (order.fabricMissingItems || []).filter(i => i !== itemIdx);
  await updateOrder(order.id, {
    fabricMissingItems: [...cur, itemIdx].sort((a, b) => a - b),
    fabricMissing: true,
    // 시각은 첫 표시 것을 유지한다 — 나중에 하나 더 막혔다고 기다린 시간이 0으로
    // 돌아가면, 30분째 서 있는 포장직원의 대기가 화면에서 사라진다.
    fabricMissingAt: order.fabricMissingAt || new Date().toISOString(),
  });
}

/** 품목 하나 해제 — 마지막 하나가 빠지면 표시 자체를 끈다. */
export async function clearFabricItem(order, itemIdx) {
  const next = (order.fabricMissingItems || []).filter(i => i !== itemIdx);
  if (next.length) { await updateOrder(order.id, { fabricMissingItems: next }); return; }
  await clearFabricCall(order.id);
}

/** 표시 전부 끄기. 같은 주문이 또 막히면 새로 시작하므로 셋을 다 비운다. */
export async function clearFabricCall(orderId) {
  await updateOrder(orderId, {
    fabricMissing: false, fabricMissingItems: [], fabricMissingAt: null,
  });
}

// ── 라벨 출력 ─────────────────────────────────────────────────
/**
 * 라벨을 뽑아달라고 요청한다 (migrations/add_label_request.sql).
 * 실제 인쇄는 라벨 PC 가 한다 — 여기서는 표시만 남긴다.
 *
 * 왜 고르는 곳과 뽑는 곳을 떼어 두는가:
 *   인쇄는 브라우저가 하는 일이라 누른 사람의 기기에서만 인쇄창이 뜨는데,
 *   PS100 은 한 대에만 물려 있다. 모바일에서 고른 사람이 직접 뽑을 방법은 없다.
 *
 * label_printed_at 을 함께 비우는 이유:
 *   버튼의 뜻이 "이거 뽑아줘"라서, 이미 뽑은 건을 다시 눌렀으면 다시 나와야 한다.
 *   안 비우면 재출력이 조용히 무시되고, 사용자는 프린터가 죽은 줄 안다.
 *
 * @returns 요청이 걸린 주문 수
 */
export async function requestLabelPrint(orderIds, requestedBy = "") {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const ids = Array.isArray(orderIds) ? orderIds : [orderIds];
  if (!ids.length) return 0;
  const { data, error } = await supabase
    .from("orders")
    .update({
      label_requested_at: new Date().toISOString(),
      label_requested_by: requestedBy || "",
      label_printed_at: null,
    })
    .in("id", ids)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

/**
 * 라벨 출력권을 집는다 (migrations/add_label_printed.sql).
 * 실제로 집었으면 true — 그때만 인쇄한다.
 *
 * '읽어보고 비어 있으면 인쇄하고 표시한다' 로 짜면 안 된다. 출력 담당 PC 가
 * 실수로 두 대 켜져 있을 때 둘 다 "비어 있네" 를 읽고 둘 다 뽑는다. 감열지는
 * 되돌릴 수 없으니 그 창을 아예 없앤다 —
 * `is("label_printed_at", null)` 을 UPDATE 조건에 넣으면 DB 가 한 대만 통과시키고,
 * 늦은 쪽은 바뀐 행이 0건으로 돌아와 스스로 물러선다.
 */
/**
 * 아직 안 뽑은 라벨 요청의 id — 주문·롤 각각. 라벨 PC 가 실시간 알림을 놓쳤는지 확인하는 데 쓴다.
 * 실시간 연결은 창이 다른 창에 가려져 있거나 잠깐 끊기면 조용히 죽는데, 그러면 누가 그 창을 눌러
 * 다시 읽게 하기 전까지 요청이 쌓이기만 했다. 가볍게(id 만) 자주 물어서 놓친 것이 있으면 그때만 다시 읽는다.
 */
export async function fetchPendingLabelIds() {
  const userId = await getUserId();
  if (!userId) return { orderIds: [], rollIds: [] };
  const [o, r, t] = await Promise.all([
    supabase.from("orders").select("id").eq("user_id", userId)
      .not("label_requested_at", "is", null).is("label_printed_at", null).limit(100),
    supabase.from("stock_rolls").select("id").eq("user_id", userId)
      .not("label_requested_at", "is", null).is("label_printed_at", null).limit(100),
    // 감사 라벨 — 테이블이 없는 DB(add_thanks_label.sql 전)에서는 오류가 나는데, 그것 때문에 원단 라벨 안전망까지 멈추면 안 된다. 빈 목록으로 본다.
    supabase.from("thanks_label_requests").select("id").eq("user_id", userId)
      .is("printed_at", null).limit(100),
  ]);
  if (o.error) throw o.error;
  return {
    orderIds: (o.data || []).map(x => String(x.id)),
    rollIds: r.error ? [] : (r.data || []).map(x => String(x.id)),
    thanksIds: t.error ? [] : (t.data || []).map(x => String(x.id)),
  };
}

export async function claimLabelPrint(orderId) {
  const userId = await getUserId();
  if (!userId) return false;
  const { data, error } = await supabase
    .from("orders")
    .update({ label_printed_at: new Date().toISOString() })
    .eq("id", orderId)
    .eq("user_id", userId)
    .is("label_printed_at", null)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

/**
 * 출고 표시를 먼저 잡는다 — 위 라벨 출력권과 같은 방식.
 *
 * 출고 처리는 "품목별 출고로그 → 재고 차감 → 주문 status 갱신" 순으로 왕복했다.
 * status 가 맨 뒤라, 그 앞을 도는 1~2초 동안 이 주문이 나가는 중인지 아무도 몰랐다.
 * 그 사이 화면이 낡은 목록으로 되살아나면(출고 직전에 출발한 조회가 뒤늦게 도착하면)
 * 사람은 "안 눌렸네" 하고 다시 누른다 — 그러면 출고로그와 재고 차감이 한 번 더 돈다.
 *
 * 실측(2026-08-25): 같은 주문·같은 품목의 출고로그가 두 번 찍힌 건 148건(주문 117건).
 *   그중 103건이 3~60초 간격 — 사람이 다시 누른 간격이다.
 *   월별로 4월 1건에서 8월 95건까지 늘었다. 데이터가 쌓여 목록 조회가 느려질수록
 *   되살아나는 창이 길어졌기 때문이다.
 *
 * 그래서 status 를 조건부로 먼저 잡는다. 이미 출고완료면 0행이 바뀌고, 호출자는
 * 그 뒤를 건너뛴다. 두 번 눌러도 두 번째는 재고도 이력도 건드리지 않는다.
 *
 * 반환  "claimed"  내가 잡았다 — 이어서 로그·재고를 처리하면 된다
 *       "already"  이미 나간 주문 — 화면만 뒤처져 있었다
 *       그 외에는 authLost 를 던진다(세션이 끊겼거나 주문이 지워진 경우).
 */
export async function claimShipOut(orderId, fields = {}, opts = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const f = orderFieldsToRow({ ...fields, status: "출고완료" });
  const { data, error } = await safeWrite(opts.route, f, (body) => supabase
    .from("orders")
    .update(body)
    .eq("id", orderId)
    .eq("user_id", userId)
    // status 가 NULL 인 옛 주문도 잡아야 한다. SQL 에서 NULL <> '출고완료' 는
    // 참이 아니라 NULL 이라, neq 만 쓰면 그 주문들이 통째로 빠진다.
    .or("status.is.null,status.neq.출고완료")
    .select("id"));
  if (error) throw error;
  if ((data || []).length > 0) return "claimed";

  // 0행이다. '이미 나갔다'와 '세션이 끊겼다'를 가른다 — 둘 다 0행 · 200 OK 로 오므로
  // 여기서 한 번 더 물어봐야 구별된다. (updateOrder 가 0행을 전부 authLost 로 보는 것과
  //  달라야 하는 자리다. 이미 나간 주문에 "저장되지 않았습니다"라고 하면 거짓말이다.)
  const { data: cur, error: e2 } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle();
  if (e2) throw e2;
  if (cur?.status === "출고완료") return "already";
  throw authLost("출고 처리가 저장되지 않았습니다 — 연결이 끊겼거나 주문이 삭제되었습니다");
}

/** 출력권을 놓아준다 — 다시 뽑아야 할 때(인쇄 실패·재출력). */
export async function releaseLabelPrint(orderId) {
  await updateOrder(orderId, { labelPrintedAt: null });
}

// ── 감사 라벨(💌) — 요청 한 줄 = "N 장" (migrations/add_thanks_label.sql) ──
// 내용은 매번 같은 그림(public/thankyou-label.png)이라 주문을 고르지 않고 장수만 적는다(2026-10-07).
// 요청·출력권·놓아주기는 원단 라벨과 같은 모양 — 담당 PC 가 claim 한 줄만 뽑는다.
// 테이블이 없는 DB(마이그레이션 전)에서는 요청이 42P01/PGRST205 로 실패한다 — 부르는 쪽이 안내한다.
const rowToThanksReq = (r) => ({
  id: r.id, count: r.count || 0, requestedBy: r.requested_by || "",
  requestedAt: r.requested_at || null, printedAt: r.printed_at || null,
});

export async function requestThanksLabels(count, requestedBy = "") {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const n = parseInt(count) || 0;
  if (n <= 0) return null;
  const { data, error } = await supabase
    .from("thanks_label_requests")
    .insert({ user_id: userId, count: n, requested_by: requestedBy || "" })
    .select();
  if (error) throw error;
  return data?.[0] ? rowToThanksReq(data[0]) : null;
}

/** 아직 안 뽑은 감사 라벨 요청 — 요청순. 테이블이 없으면 빈 목록(라벨 PC 의 나머지 일을 막지 않는다). */
export async function fetchPendingThanksRequests() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("thanks_label_requests")
    .select("*")
    .eq("user_id", userId)
    .is("printed_at", null)
    .order("requested_at", { ascending: true })
    .limit(100);
  if (error) {
    const missing = ["42P01", "PGRST205"].includes(error.code) || /thanks_label_requests/.test(String(error.message || ""));
    if (missing) return [];
    throw error;
  }
  return (data || []).map(rowToThanksReq);
}

/** 감사 라벨 출력권 — claimLabelPrint 와 같다: UPDATE 조건에 printed_at is null 을 넣어 한 대만 통과시킨다. */
export async function claimThanksLabelPrint(reqId) {
  const userId = await getUserId();
  if (!userId) return false;
  const { data, error } = await supabase
    .from("thanks_label_requests")
    .update({ printed_at: new Date().toISOString() })
    .eq("id", reqId)
    .eq("user_id", userId)
    .is("printed_at", null)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

export async function releaseThanksLabelPrint(reqId) {
  const userId = await getUserId();
  if (!userId) return;
  const { error } = await supabase
    .from("thanks_label_requests")
    .update({ printed_at: null })
    .eq("id", reqId)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── 라벨 출력 담당 기기 (migrations/add_label_station.sql) ─────
// user_id 가 PRIMARY KEY 라 회사당 한 줄뿐이다 — 곧 담당 기기는 언제나 한 대다.
// 스위치를 기기 안에만 두면 ERP 가 어느 PC 가 켜져 있는지 몰라서, 엉뚱한 PC 에서
// 켜진 걸 알아채지도 원격으로 끄지도 못한다. 그래서 서버에 못 박는다.

/** 지금 담당 기기. 없으면 null. */
export async function fetchLabelStation() {
  const userId = await getUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("label_station")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) { console.warn("[라벨담당] 조회 실패", error); return null; }
  if (!data) return null;
  return {
    deviceId: data.device_id,
    deviceName: data.device_name || "",
    armedAt: data.armed_at,
    armedBy: data.armed_by || "",
  };
}

/**
 * 이 기기를 담당으로 등록한다. 이미 다른 기기가 있으면 덮어쓴다(= 넘겨받기).
 * 덮인 기기는 Realtime 으로 이 변경을 받아 스스로 멈춘다.
 *
 * armed_at 을 여기서 새로 찍는 이유: 담당을 넘겨받은 시각이 곧 "여기서부터 뽑는다"
 * 의 기준이다. 이전 기기의 기준을 물려받으면 그 PC 가 꺼져 있던 며칠 치가
 * 넘겨받은 순간 새 PC 로 쏟아진다.
 */
export async function claimLabelStation({ deviceId, deviceName, armedBy }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const armedAt = new Date().toISOString();
  const { error } = await supabase.from("label_station").upsert({
    user_id: userId,
    device_id: deviceId,
    device_name: deviceName || "",
    armed_at: armedAt,
    armed_by: armedBy || "",
    updated_at: armedAt,
  }, { onConflict: "user_id" });
  if (error) throw error;
  return { deviceId, deviceName: deviceName || "", armedAt, armedBy: armedBy || "" };
}

/**
 * 담당을 해제한다. onlyDeviceId 를 주면 그 기기가 담당일 때만 지운다 —
 * 내 화면에서 끄는 사이 다른 PC 가 담당을 가져갔다면 그쪽을 끄면 안 된다.
 * (관리자가 설정에서 강제 해제할 때는 onlyDeviceId 없이 부른다)
 */
export async function releaseLabelStation(onlyDeviceId) {
  const userId = await getUserId();
  if (!userId) return;
  let q = supabase.from("label_station").delete().eq("user_id", userId);
  if (onlyDeviceId) q = q.eq("device_id", onlyDeviceId);
  const { error } = await q;
  if (error) throw error;
}

// ── 출고요청 (migrations/add_ship_request.sql) ────────────────
// 보관중인 건을 "이제 내보내라"고 포장팀에 넘긴다. 보관을 여기서 함께 푸는 이유는,
// 보관인 채로 두면 카드가 보관 탭에 남아 포장직원이 아침에 보는 줄에 안 나타나기
// 때문이다. 요청이 곧 꺼내라는 지시라 두 동작을 가를 실익이 없다.
//
// 출고예정일은 건드리지 않는다 — 화면에서만 당일 칸에 놓으므로,
// 취소하면 복원할 것 없이 제자리로 돌아간다.

/** 출고요청 — orders 는 합배송 묶음 전체. 한 건만 걸면 묶음이 쪼개진다. */
export async function requestShipOut(orders, by) {
  const at = new Date().toISOString();
  for (const o of orders) {
    await updateOrder(o.id, {
      shipRequestedAt: at, shipRequestedBy: by || "",
      isHolding: false, heldAt: null,
      // 옛 주문은 보관을 status="보관" 으로 갖고 있다 — 같이 되돌려야 보관이 완전히 풀린다
      ...(o.status === "보관" ? { status: "접수" } : {}),
    });
  }
  return at;
}

/** 출고요청 취소 — 보관중으로 되돌린다. 창고에 그대로 있으니 held_at 도 되살린다. */
export async function cancelShipOutRequest(orders) {
  const at = new Date().toISOString();
  for (const o of orders) {
    await updateOrder(o.id, {
      shipRequestedAt: null, shipRequestedBy: null,
      isHolding: true, heldAt: o.heldAt || at,
    });
  }
}

export async function deleteOrder(id, opts = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  // 삭제에는 도장을 같이 실을 수 없다(바뀐 뒤의 행이 없다). 지우기 직전에 도장만 먼저
  // 찍어두면 트리거가 그걸 보고 누가 지웠는지 적는다. 실패해도 삭제는 그대로 한다.
  if (_stampOn) {
    try {
      const { error: e0 } = await supabase.from("orders")
        .update(stampOf(opts.route || "주문 삭제")).eq("id", id).eq("user_id", userId);
      if (STAMP_COLS.includes(missingColumnOf(e0))) _stampOn = false;
    } catch { /* 기록용이라 무시 */ }
  }
  const { error } = await supabase
    .from("orders")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── 합배송 (merge_group_id) ────────────────────────────────────
// orderIds 의 모든 주문에 동일 mergeGroupId 부여 (null로 호출 시 그룹 해제)
export async function setMergeGroup(orderIds, mergeGroupId) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  if (!Array.isArray(orderIds) || orderIds.length === 0) return;
  const { error } = await safeWrite(null, { merge_group_id: mergeGroupId }, (body) => supabase
    .from("orders")
    .update(body)
    .in("id", orderIds)
    .eq("user_id", userId));
  if (error) throw error;
}

// ── 송장 출력 시각 (migrations/add_order_events.sql) ──────────
// 송장을 뽑았다는 표시. "송장만"은 이전까지 아무 흔적도 남기지 않아서, 송장은 나갔는데
// 출고완료가 안 된 주문을 찾을 방법이 없었다.
//
// 절대 throw 하지 않는다 — 송장 파일은 이미 내려받은 뒤라, 표시를 못 남겼다고
// 출력이 실패한 것처럼 보이면 안 된다. 칸이 아직 없는 DB 에서도 조용히 넘어간다.
export async function markInvoicePrinted(orderIds, route) {
  try {
    const userId = await getUserId();
    const ids = [...new Set((orderIds || []).filter(Boolean))];
    if (!userId || ids.length === 0) return null;
    const at = new Date().toISOString();
    const { error } = await safeWrite(route, { invoice_printed_at: at }, (body) => supabase
      .from("orders")
      .update(body)
      .in("id", ids)
      .eq("user_id", userId));
    if (error) { console.warn("[송장] 출력 시각 기록 실패:", error.message); return null; }
    return at;
  } catch (e) {
    console.warn("[송장] 출력 시각 기록 실패:", e?.message);
    return null;
  }
}

// ── 택배사 지정 (migrations/add_order_events.sql) ─────────────
// courier 가 null 이면 '자동'으로 되돌린다 — 배송비로 다시 판정한다.
// orderIds 는 박스 전체(합배송 묶음)를 넘긴다. 한 건만 바꾸면 같은 박스 안에서 값이 갈린다.
export async function setCourier(orderIds, courier, route) {
  await updateOrdersBulk(orderIds, { courier: courier || null }, { route: route || "택배사 변경" });
}

// ── 오늘의 인계 기록 ─────────────────────────────────────────
// 인계는 따로 테이블을 두지 않는다. 인계로 나간 주문은 변경 기록에 경로("CJ대한통운 인계")와
// 함께 남으므로, 그걸 모으면 "오늘 몇 시에 누가 몇 건 넘겼는지"가 나온다.
// 기록 테이블이 아직 없으면 빈 목록을 돌려준다 — 인계 화면은 이게 없어도 돌아가야 한다.
export async function fetchTodayHandovers() {
  try {
    const userId = await getUserId();
    if (!userId) return [];
    const d = new Date();
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
    const { data, error } = await supabase
      .from("order_events")
      .select("order_id, customer, actor, route, created_at")
      .eq("user_id", userId)
      .eq("status_to", "출고완료")
      .gte("created_at", start)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (error) return [];
    return (data || []).map(r => ({
      orderId: r.order_id, customer: r.customer || "", actor: r.actor || "",
      route: r.route || "", createdAt: r.created_at,
    }));
  } catch { return []; }
}

// ── 주문 변경 기록 읽기 (migrations/add_order_events.sql) ──────
// 쓰는 건 DB 트리거가 한다. 화면은 읽기만 한다.
const toEventCamel = (row) => ({
  id: row.id,
  orderId: row.order_id,
  customer: row.customer || "",
  op: row.op,
  statusFrom: row.status_from,
  statusTo: row.status_to,
  changes: row.changes || {},
  actor: row.actor || "",
  route: row.route || "",
  createdAt: row.created_at,
});

/** 주문 하나의 이력 — 오래된 것부터. */
export async function fetchOrderEvents(orderId) {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("order_events")
    .select("*")
    .eq("user_id", userId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data || []).map(toEventCamel);
}

/**
 * 최근 기록 — 새것부터. 고객명으로 좁힐 수 있다.
 * 출고완료되거나 삭제돼서 주문 목록에 없는 건도 여기서는 찾을 수 있다.
 */
export async function fetchRecentOrderEvents({ customer = "", limit = 100 } = {}) {
  const userId = await getUserId();
  if (!userId) return [];
  let q = supabase
    .from("order_events")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  // ilike 패턴 문자는 글자로 취급한다 — 고객명에 % 나 _ 가 들어 있어도 그대로 찾게
  const term = String(customer || "").trim();
  if (term) q = q.ilike("customer", `%${term.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(toEventCamel);
}

/**
 * 합배송 묶음 중 이미 출고완료된 건 — 묶음 id 별로.
 * 화면이 들고 있는 주문 목록은 활성 건뿐이라(fetchOrders), "묶음 중 일부만 나갔다"는
 * 나간 쪽을 따로 물어봐야 알 수 있다. 필요한 칸만 읽는다.
 */
export async function fetchShippedGroupMates(groupIds) {
  const userId = await getUserId();
  if (!userId) return [];
  const uniq = [...new Set((groupIds || []).filter(Boolean))];
  if (uniq.length === 0) return [];
  const CHUNK = 100;
  const all = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer, merge_group_id, split_shipping, shipped_at")
      .eq("user_id", userId)
      .eq("status", "출고완료")
      .in("merge_group_id", uniq.slice(i, i + CHUNK));
    if (error) throw error;
    all.push(...(data || []));
  }
  return all.map(r => ({
    id: r.id, customer: r.customer, mergeGroupId: r.merge_group_id,
    splitShipping: !!r.split_shipping, shippedAt: r.shipped_at,
  }));
}

export async function clearMergeGroup(orderId) {
  return updateOrder(orderId, { merge_group_id: null });
}

// ── 합배송 규칙 — 그룹 구성이 바뀐 뒤 출고일·택배비를 규칙대로 (3단계) ──────────
// 묶음·해제·분리·출고 뒤에 모든 경로가 afterGroupChange 하나를 부른다. 규칙 자체는
// lib/freight.js(택배비)·lib/autoMerge.js(출고일)의 순수 함수에 있고 여기는 DB 에 쓰는 일만 한다.
// 사람이 운임비 조정(FreightModal)으로 정한 값은 그 뒤 이걸 부르지 않으므로 그대로 남는다.

/** 그룹 택배비 재계산 결과를 DB 에 쓴다. 바뀌는 게 없으면 아무 요청도 안 보낸다. */
export async function applyGroupFreight(groupOrders, { paymentStatusOf, route } = {}) {
  const res = recomputeGroupFreight(groupOrders, { paymentStatusOf });
  // 금액이 주문마다 달라 한 건씩 쓴다 — 택배비·전체금액·내려놓은 금액(feeHeld)이 한 요청으로 같이 간다.
  // feeHeld 칸이 없는 DB(add_shipping_fee_held.sql 전)에서는 safeWrite 가 그 칸만 빼고 쓴다 — 되돌리기만 안 된다.
  const r = route || "택배비 자동 재계산";
  for (const c of res.changes) {
    await updateOrder(c.id, { shippingFee: c.shippingFee, feeHeld: c.feeHeld, ...(c.totalAmount !== undefined ? { totalAmount: c.totalAmount } : {}) }, { route: r });
  }
  return res;
}

/**
 * 그룹 변경 뒤 — 출고일(groupShipTarget) + 택배비(applyGroupFreight) 한 번에.
 * groupOrders: 그 그룹에 지금 함께 나갈 멤버들(출고완료·분리 건은 빼고 넘긴다). 1건이면 출고일은
 * 안 건드리고 택배비만 본다(혼자 남은 건 → 묶일 때 내려놓은 택배비가 있으면 되돌린다). 0건이면 아무것도 안 한다.
 * 반환: { ids, shipDate, isUrgent, dateChanged, freight } — 화면은 patchOrdersWithGroupResult 로 반영한다.
 */
export async function afterGroupChange(groupOrders, { paymentStatusOf, route } = {}) {
  const members = (groupOrders || []).filter(Boolean);
  if (members.length === 0) return null;
  let target = { shipDate: null, isUrgent: false }, dateChanged = false, working = members;
  if (members.length > 1) {
    target = groupShipTarget(members);
    const needs = members.filter(o => (o.shipDate || null) !== (target.shipDate || null) || !!o.isUrgent !== !!target.isUrgent);
    if (needs.length) {
      await updateOrdersBulk(needs.map(o => o.id), { shipDate: target.shipDate, isUrgent: target.isUrgent }, { route: route || "합배송 출고일 맞춤" });
      dateChanged = true;
    }
    working = members.map(o => ({ ...o, shipDate: target.shipDate, isUrgent: target.isUrgent }));
  }
  const freight = await applyGroupFreight(working, { paymentStatusOf, route });
  return { ids: members.map(o => o.id), shipDate: target.shipDate, isUrgent: target.isUrgent, dateChanged, freight };
}

// ── Inventory ─────────────────────────────────────────────────
export async function fetchInventory() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("inventory")
      .select("*")
      .eq("user_id", userId)
      .order("id")
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all;
}

export async function decrementStock(invId, qty) {
  const { error } = await supabase.rpc("decrement_stock", { inv_id: invId, qty });
  if (error) throw error;
}

export async function updateInventoryItem(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("inventory")
    .update(fields)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function insertInventoryItem(item) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {
    user_id: userId,
    fabric: item.fabric,
    color: item.color || "",
    stock: item.stock,
  };
  if (item.itemNo) row.item_no = item.itemNo;
  if (item.unitPrice) row.unit_price = item.unitPrice;
  const { data, error } = await supabase.from("inventory").insert(row).select();
  if (error) throw error;
  return data?.[0] || null;
}

export async function deleteInventoryItem(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("inventory")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Customers ─────────────────────────────────────────────────
export async function fetchCustomers() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("user_id", userId)
      .order("id")
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(toCustCamel);
}

export async function insertCustomer(c) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("customers").insert({
    user_id: userId,
    name: (c.name || "").trim(),  // 앞뒤 공백 제거 — 이름 불일치(적립금/매칭 실패) 방지
    phone: c.phone || "",
    address: c.address || "",
    address_detail: c.addressDetail || "",
    address2: c.address2 || "",
    address2_detail: c.address2Detail || "",
    address2_label: c.address2Label || "",
    total_orders: c.totalOrders || 0,
    last_order: c.lastOrder || null,
    note: c.note || "",
    nickname: c.nickname || "",
    allow_credit: !!c.allowCredit,
  }).select();
  if (error) throw error;
  return data?.[0] ? toCustCamel(data[0]) : null;
}

export async function updateCustomer(id, c) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("customers").update({
    name: c.name,
    phone: c.phone || "",
    address: c.address || "",
    address_detail: c.addressDetail || "",
    address2: c.address2 || "",
    address2_detail: c.address2Detail || "",
    address2_label: c.address2Label || "",
    total_orders: c.totalOrders || 0,
    last_order: c.lastOrder || null,
    note: c.note || "",
    nickname: c.nickname || "",
    allow_credit: !!c.allowCredit,
  })
    .eq("id", id)
    .eq("user_id", userId)
    .select();
  if (error) throw error;
  return data?.[0] ? toCustCamel(data[0]) : null;
}

export async function deleteCustomer(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("customers")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Order Notes (주문 메모/피드) ─────────────────────────────────
const toNoteCamel = (row) => ({
  id: row.id,
  author: row.author || "",
  body: row.body || "",
  status: row.status || "미등록",
  orderId: row.order_id || null,
  customerId: row.customer_id ?? null,
  reactions: row.reactions || {},
  createdAt: row.created_at,
});

// 로하톡 메모 조회 — 최근 500건 + '미등록' 전부.
//
// 최근 500건만 읽던 자리다. 메모가 1,600건을 넘으면서 오래된 것이 화면에서
// 사라졌는데, 그 안에 아직 등록 안 된 메모가 섞여 있었다 (확인 시점에 53건).
// 마침 전부 다른 경로로 등록돼 있어 손해는 없었지만, 진짜 누락이 생기면
// 똑같이 화면 밖으로 밀려나 아무도 모르게 된다.
// 미등록은 건수가 적으니(수십 건) 나이와 상관없이 전부 들고 온다.
export async function fetchOrderNotes() {
  const userId = await getUserId();
  if (!userId) return [];
  const base = () => supabase.from("order_notes").select("*").eq("user_id", userId);
  const [recent, pending] = await Promise.all([
    base().order("created_at", { ascending: false }).limit(500),
    base().neq("status", "등록됨").order("created_at", { ascending: false }).limit(500),
  ]);
  if (recent.error) throw recent.error;
  // 미등록 조회만 실패하면 최근 500건이라도 보여준다 — 화면이 통째로 비는 것보다 낫다.
  if (pending.error) console.warn("미등록 메모 조회 실패:", pending.error);
  const merged = new Map();
  for (const row of [...(recent.data || []), ...(pending.data || [])]) merged.set(row.id, row);
  return [...merged.values()]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(toNoteCamel);
}

// 로하톡 검색 — 서버에서 전체 메모를 뒤진다.
//
// 화면은 fetchOrderNotes 가 읽어 온 '최근 500건 + 미등록'만 들고 있고, 검색도 그 안에서만
// 돌았다. 그래서 같은 고객을 검색해도 PC 마다 결과가 달랐다 — 며칠째 열어 둔 탭은 실시간으로
// 쌓인 옛 메모까지 갖고 있어 찾고, 방금 새로고침한 탭은 500건 밖이라 못 찾았다
// (메모 2,900건 시점에 제보). 평소 로딩은 그대로 두고, 검색할 때만 서버에 묻는다.
//
// customerIds: 검색어가 이름·닉네임에 걸린 고객의 id 들. 고객검색으로 고객만 붙이고 본문에
// 이름을 안 적은 메모는 본문 검색으로는 절대 안 잡히므로 customer_id 로 따로 찾는다.
//
// 조건을 .or() 한 줄로 합치지 않고 따로 부른다 — 검색어에 쉼표·괄호가 들어가면
// .or() 문자열 문법이 깨지는데, 주문 메모에는 그런 글자가 흔하다.
const NOTE_SEARCH_LIMIT = 200;
const NOTE_SEARCH_MAX_CUSTOMERS = 100; // in(...) 이 URL 에 실리므로 상한을 둔다
export async function searchOrderNotes(q, customerIds = []) {
  const userId = await getUserId();
  const term = String(q || "").trim();
  if (!userId || !term) return { notes: [], capped: false };
  // ilike 의 와일드카드(% _)와 이스케이프 문자(\)를 글자 그대로 찾게 한다
  const pat = `%${term.replace(/[\\%_]/g, (ch) => "\\" + ch)}%`;
  const base = () => supabase.from("order_notes").select("*").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(NOTE_SEARCH_LIMIT);
  const ids = customerIds.slice(0, NOTE_SEARCH_MAX_CUSTOMERS);
  const [byBody, byAuthor, byCust] = await Promise.all([
    base().ilike("body", pat),
    base().ilike("author", pat),
    ids.length ? base().in("customer_id", ids) : Promise.resolve({ data: [], error: null }),
  ]);
  if (byBody.error) throw byBody.error;
  if (byAuthor.error) throw byAuthor.error;
  // customer_id 컬럼 미생성 환경 방어 (insertOrderNote 와 같은 이유) — 본문·작성자 결과는 살린다
  if (byCust.error) console.warn("메모 고객연결 검색 실패:", byCust.error);
  const merged = new Map();
  for (const row of [...(byBody.data || []), ...(byAuthor.data || []), ...(byCust.data || [])]) merged.set(row.id, row);
  const capped = [byBody, byAuthor, byCust].some((r) => (r.data || []).length >= NOTE_SEARCH_LIMIT)
    || customerIds.length > NOTE_SEARCH_MAX_CUSTOMERS;
  return { notes: [...merged.values()].map(toNoteCamel), capped };
}

export async function insertOrderNote(n) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {
    user_id: userId,
    author: n.author || "",
    body: (n.body || "").trim(),
    status: n.status || "미등록",
    order_id: n.orderId || null,
    customer_id: n.customerId ?? null,
  };
  let { data, error } = await supabase.from("order_notes").insert(row).select();
  // customer_id 컬럼 미생성 환경 방어 — 마이그레이션 전이면 고객연결 없이라도 저장
  if (error && /customer_id/.test(error.message || "")) {
    const { customer_id, ...rest } = row;
    ({ data, error } = await supabase.from("order_notes").insert(rest).select());
  }
  if (error) throw error;
  return data?.[0] ? toNoteCamel(data[0]) : null;
}

export async function updateOrderNote(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const patch = {};
  if (fields.body !== undefined) patch.body = fields.body;
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.orderId !== undefined) patch.order_id = fields.orderId;
  if (fields.customerId !== undefined) patch.customer_id = fields.customerId;
  const { data, error } = await supabase.from("order_notes").update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select();
  if (error) throw error;
  return data?.[0] ? toNoteCamel(data[0]) : null;
}

// 메모 리액션 토글 — 같은 사람이 같은 이모지를 다시 누르면 제거.
// 최신 reactions를 다시 읽고 토글해서 저장 (다른 담당자의 리액션을 덮어쓰지 않도록).
export async function toggleNoteReaction(id, emoji, name) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  if (!emoji || !name) return null;
  const { data: rows, error: selErr } = await supabase
    .from("order_notes")
    .select("reactions")
    .eq("id", id)
    .eq("user_id", userId)
    .limit(1);
  if (selErr) {
    // reactions 컬럼 미생성 환경 안내 (migrations/add_note_reactions.sql 실행 필요)
    if (/reactions/.test(selErr.message || "")) throw new Error("리액션 기능은 DB 마이그레이션 후 사용할 수 있어요");
    throw selErr;
  }
  const cur = rows?.[0]?.reactions || {};
  const list = Array.isArray(cur[emoji]) ? cur[emoji] : [];
  const next = { ...cur, [emoji]: list.includes(name) ? list.filter((x) => x !== name) : [...list, name] };
  if (next[emoji].length === 0) delete next[emoji];
  const { data, error } = await supabase
    .from("order_notes")
    .update({ reactions: next })
    .eq("id", id)
    .eq("user_id", userId)
    .select();
  if (error) throw error;
  return data?.[0] ? toNoteCamel(data[0]) : null;
}

export async function deleteOrderNote(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("order_notes")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// orders에 매칭되지 않는 customers 추출 — 엑셀 일괄 업로드로 들어왔지만
// 실제 거래 기록(orders)이 없는 "고아 고객" 정리용.
// 매칭 규칙: name 정확/포함 또는 normalizePhone(가운데 4자리) 일치.
export async function fetchOrphanCustomers() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;

  const allCust = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, phone, total_orders, last_order")
      .eq("user_id", userId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allCust.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const allOrd = [];
  from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("customer, phone")
      .eq("user_id", userId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allOrd.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  const norm = (raw) => {
    const d = String(raw || "").replace(/[^0-9]/g, "");
    if (d.length === 11) return d.slice(3, 7);
    if (d.length === 4) return d;
    return String(raw || "").trim();
  };
  const orderNames = new Set();
  const orderPhones = new Set();
  for (const o of allOrd) {
    if (o.customer) orderNames.add(o.customer.trim());
    const p = norm(o.phone);
    if (p) orderPhones.add(p);
  }
  const hasOrder = (c) => {
    const cname = (c.name || "").trim();
    if (cname && orderNames.has(cname)) return true;
    const cp = norm(c.phone);
    if (cp && orderPhones.has(cp)) return true;
    // 부분일치 양방향 — 고객 "김영희(복숭아)" vs 주문 "김영희" 같은 케이스 보호.
    // 한 글자 이름은 오매칭이 많아 부분일치에서 제외.
    if (cname.length >= 2) {
      for (const oname of orderNames) {
        if (oname.length >= 2 && (oname.includes(cname) || cname.includes(oname))) return true;
      }
    }
    return false;
  };

  // 안전장치: 전화번호 없는 고객은 이름으로만 판정해야 해서 오판 위험이 큼 — 정리 대상에서 제외.
  // 주문 이력이 남아 있는 고객(total_orders>0)도 주문이 삭제됐을 뿐일 수 있으니 보호.
  return allCust
    .filter(c => norm(c.phone) && !(c.total_orders > 0))
    .filter(c => !hasOrder(c))
    .map(c => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      totalOrders: c.total_orders || 0,
      lastOrder: c.last_order || "",
    }));
}

// 고아 고객 일괄 삭제 (id 배열) — chunk 단위 처리.
export async function deleteOrphanCustomers(ids) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  if (!ids || ids.length === 0) return 0;
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error, count } = await supabase
      .from("customers")
      .delete({ count: "exact" })
      .eq("user_id", userId)
      .in("id", slice);
    if (error) throw error;
    total += count || 0;
  }
  return total;
}

/**
 * 주문 등록 직전에 서버에서 바로 찾는 고객 후보 — 같은 전화번호(숫자만 견줌) 또는 같은 이름.
 * 화면이 들고 있는 고객 목록은 로그인 때 받아 둔 것에 실시간 알림을 얹은 것이라, 기기가 잠든 사이
 * 생긴 고객이나 다른 직원이 몇 초 전에 만든 고객이 빠져 있을 수 있다. 그 목록만 믿고 "없다"고
 * 판단하면 같은 사람이 이중으로 생긴다(2026-10-13 실측: 이름·번호·주소까지 같은 중복 5묶음이
 * 전부 다른 직원이 짧은 간격으로 등록한 것). 등록 한 건당 작은 조회 하나라 비용은 없다.
 * @returns 고객 배열(camel). 실패하면 던진다 — 호출부가 들고 있던 목록으로 되돌아간다.
 */
export async function findCustomersFresh({ phoneDigits = "", name = "" } = {}) {
  const userId = await getUserId();
  if (!userId) return [];
  const d = String(phoneDigits || "").replace(/\D/g, "");
  const n = String(name || "").trim();
  const qs = [];
  if (d.length >= 9) {
    // 저장된 표기가 제각각(010-1234-5678 / 01012345678)이라 뒤 8자리를 두 토막으로 느슨하게 걸고
    // 숫자만 남겨 다시 견준다.
    qs.push(supabase.from("customers").select("*").eq("user_id", userId)
      .ilike("phone", `%${d.slice(-8, -4)}%${d.slice(-4)}%`).limit(50));
  }
  if (n && n !== "미확인") {
    qs.push(supabase.from("customers").select("*").eq("user_id", userId)
      .ilike("name", n.replace(/[%_]/g, "")).limit(50));
  }
  if (!qs.length) return [];
  const rs = await Promise.all(qs);
  for (const r of rs) if (r.error) throw r.error;
  const seen = new Set();
  const out = [];
  for (const r of rs) for (const row of (r.data || [])) {
    if (seen.has(row.id)) continue;
    const rowDigits = String(row.phone || "").replace(/\D/g, "");
    const phoneHit = d.length >= 9 && rowDigits === d;
    const nameHit = n && String(row.name || "").trim().toLowerCase() === n.toLowerCase();
    if (!phoneHit && !nameHit) continue;
    seen.add(row.id);
    out.push(toCustCamel(row));
  }
  return out;
}

// 신규 고객만 INSERT, 이미 있으면 그대로 둠 (총주문수 안 건드림).
// 엑셀 일괄 업로드 시 기존 고객의 total_orders 부풀려지는 문제 방지용.
// 반환: { status: "inserted" | "exists" | "skipped", customer }
export async function insertCustomerIfNew({ name, phone, nickname, address, note }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const normName = (name || "").trim();
  const normPhone = (phone || "").trim();
  if (!normName) return { status: "skipped", customer: null };

  // 전화번호는 표기가 제각각(010-1234-5678 / 01012345678 / 010.1234.5678)이라
  // 문자열 그대로 비교하면 같은 사람이 매번 새로 등록된다. 숫자만 남겨 비교한다.
  const phoneDigits = s => String(s || "").replace(/\D/g, "");
  const wantDigits = phoneDigits(normPhone);

  const { data: existing, error: selErr } = await supabase
    .from("customers")
    .select("id, phone")
    .eq("user_id", userId)
    .eq("name", normName);
  if (selErr) throw selErr;

  if ((existing || []).some(c => phoneDigits(c.phone) === wantDigits)) {
    return { status: "exists", customer: null };
  }

  const { data, error } = await supabase.from("customers").insert({
    user_id: userId,
    name: normName,
    phone: normPhone,
    address: address || "",
    nickname: nickname || "",
    total_orders: 0,
    last_order: null,
    note: note || "",
  }).select();
  if (error) throw error;
  return { status: "inserted", customer: data?.[0] ? toCustCamel(data[0]) : null };
}

// [DEPRECATED] 이전 동작: 있으면 total_orders+=1, 없으면 insert(total_orders=1).
// 엑셀 업로드로 기존 고객의 출고건수가 부풀려지는 부작용이 있어
// insertCustomerIfNew 로 대체됨. 호출처 없음 확인 후 제거 예정.
export async function upsertCustomer({ name, phone, lastOrder, note }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const normName = (name || "").trim();
  const normPhone = (phone || "").trim();
  if (!normName) return { status: "skipped", customer: null };

  const { data: existing, error: selErr } = await supabase
    .from("customers")
    .select("*")
    .eq("user_id", userId)
    .eq("name", normName)
    .eq("phone", normPhone)
    .limit(1);
  if (selErr) throw selErr;

  if (existing && existing.length > 0) {
    const prev = existing[0];
    const prevLast = prev.last_order || "";
    const nextLast = (lastOrder && lastOrder > prevLast) ? lastOrder : (prevLast || null);
    const { data, error } = await supabase.from("customers").update({
      total_orders: (prev.total_orders || 0) + 1,
      last_order: nextLast,
      note: prev.note || note || "",
    })
      .eq("id", prev.id)
      .eq("user_id", userId)
      .select();
    if (error) throw error;
    return { status: "updated", customer: data?.[0] ? toCustCamel(data[0]) : null };
  }

  const { data, error } = await supabase.from("customers").insert({
    user_id: userId,
    name: normName,
    phone: normPhone,
    address: "",
    total_orders: 1,
    last_order: lastOrder || null,
    note: note || "",
    nickname: "",
  }).select();
  if (error) throw error;
  return { status: "inserted", customer: data?.[0] ? toCustCamel(data[0]) : null };
}

// ── Logs ──────────────────────────────────────────────────────
export async function fetchLogs() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(toLogCamel);
}

export async function insertLog(log) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("logs").insert({
    user_id: userId,
    date: log.date,
    time: log.time,
    type: log.type,
    item_no: log.itemNo || "",
    fabric: log.fabric,
    color: log.color || "",
    qty: log.qty || 0,
    cost_price: log.costPrice || 0,
    ref: log.ref || "",
    note: log.note || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toLogCamel(data[0]) : null;
}

export async function deleteLog(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("logs")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ══════════ 반품 (order_returns) — 부분 반품 지원 ══════════
// 흐름: 반품신청 → 수거중 → 반품입고(재고 복구는 UI에서 updateInventoryItem+insertLog) → 완료
const toReturnCamel = (row) => ({
  id: row.id,
  orderId: row.order_id,
  customer: row.customer || "",
  items: row.items || [],
  reason: row.reason || "",
  status: row.status || "반품신청",
  manager: row.manager || "",
  restocked: !!row.restocked,
  exchangeOrderId: row.exchange_order_id || null,
  exchangeItems: row.exchange_items || [],
  exchangeDiff: row.exchange_diff ?? null,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

export async function fetchReturns() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("order_returns")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toReturnCamel);
}

export async function insertReturn({ orderId, customer, items, reason, manager }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("order_returns").insert({
    user_id: userId,
    order_id: orderId || null,
    customer: customer || "",
    items: items || [],
    reason: reason || "",
    status: "반품신청",
    manager: manager || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toReturnCamel(data[0]) : null;
}

// fields: snake_case 그대로 ({status, restocked, completed_at})
export async function updateReturn(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("order_returns")
    .update(fields)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteReturn(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("order_returns")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteLogsByRef(ref) {
  const userId = await getUserId();
  if (!userId) return;
  const { error } = await supabase
    .from("logs")
    .delete()
    .eq("user_id", userId)
    .eq("ref", ref);
  if (error) throw error;
}

// ── Managers ──────────────────────────────────────────────────
// 반환 형태: [{id, name, isAdmin, isPublic}]
// 레거시 호출자(addManager(name) 같은)도 그대로 동작하도록 시그니처 호환 유지
export async function fetchManagers() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("managers")
    .select("*")
    .eq("user_id", userId)
    .order("id");
  if (error) throw error;
  return (data || []).map((m) => ({
    id: m.id,
    name: m.name,
    isAdmin: !!m.is_admin,
    isPublic: !!m.is_public,
    isPacker: !!m.is_packer,
    // 품번 접두어(이니셜, migrations/add_product_manager.sql). 비면 LH.
    code: m.code || "",
  }));
}

// addManager — 문자열 또는 {name, isAdmin, isPublic, isPacker} 모두 허용
export async function addManager(opts) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const name = typeof opts === "string" ? opts : opts?.name;
  if (!name) throw new Error("담당자 이름이 필요합니다");
  const isAdmin = typeof opts === "object" ? !!opts.isAdmin : false;
  const isPublic = typeof opts === "object" ? !!opts.isPublic : false;
  const isPacker = typeof opts === "object" ? !!opts.isPacker : false;
  const code = typeof opts === "object" ? String(opts.code || "").trim().toUpperCase() : "";
  const { data, error } = await supabase
    .from("managers")
    .insert({ user_id: userId, name, is_admin: isAdmin, is_public: isPublic, is_packer: isPacker, ...(code ? { code } : {}) })
    .select();
  if (error && error.code !== "23505") throw error;
  if (!data || data.length === 0) return null;
  const m = data[0];
  return { id: m.id, name: m.name, isAdmin: !!m.is_admin, isPublic: !!m.is_public, isPacker: !!m.is_packer };
}

export async function updateManager(name, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {};
  if ("name" in fields && fields.name && fields.name !== name) row.name = fields.name;
  if ("isAdmin" in fields) row.is_admin = !!fields.isAdmin;
  if ("isPublic" in fields) row.is_public = !!fields.isPublic;
  if ("isPacker" in fields) row.is_packer = !!fields.isPacker;
  if ("code" in fields) row.code = String(fields.code || "").trim().toUpperCase() || null;
  if (Object.keys(row).length === 0) return;
  const { error } = await supabase
    .from("managers")
    .update(row)
    .eq("name", name)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function removeManager(name) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("managers")
    .delete()
    .eq("name", name)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── 배송지 메모 프리셋 (자주 쓰는 배송 메모 재사용) ───────────
// 주문 등록 시 입력한 배송 메모를 기록 → 다음 입력 때 자동완성 후보로 검색.
export async function fetchDeliveryPresets() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("delivery_message_presets")
    .select("id, text")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data || []).map((r) => ({ id: r.id, text: r.text }));
}

// addDeliveryPreset — 같은 메모는 한 줄만 유지(upsert), 재사용 시 updated_at 갱신해 최신순 정렬.
export async function addDeliveryPreset(text) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const { data, error } = await supabase
    .from("delivery_message_presets")
    .upsert(
      { user_id: userId, text: trimmed, updated_at: new Date().toISOString() },
      { onConflict: "user_id,text" }
    )
    .select();
  if (error) throw error;
  return data?.[0] ? { id: data[0].id, text: data[0].text } : null;
}

export async function deleteDeliveryPreset(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("delivery_message_presets")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// 시드 + reconcile: 방문고객/마켓24(공용). 멱등.
// - 없으면 추가
// - 있는데 권한이 다르면 update (마이그레이션 후 권한 비어있는 기존 데이터 보정)
//
// 옥정점은 뺐다(2026-08-19). 원래 관리자 시드였는데, 안 쓰게 되어 지워도
// 다음 로딩에 여기서 그대로 되살아났다 — 삭제가 유지되지 않는 담당자였다.
// 권한도 마찬가지로 매번 isAdmin:true 로 되돌려 놓았다.
//
// 여기 남는 둘은 사람이 아니라 창구다. 방문고객·마켓24 는 특정인의 건이 아니라
// 누구나 처리하는 몫이라, 지워지면 그 주문들을 받을 자리가 없어진다.
// 사람 이름은 여기 두지 않는다 — 사람은 오가고, 시드는 그걸 못 따라간다.
//
// 과거 주문의 manager 는 문자열이라 그대로 "옥정점" 으로 남아 있다. 목록에
// 없는 이름이지만 화면은 원본 순서 뒤에 붙여 보여주므로 사라지지 않는다.
export async function ensureDefaultManagers() {
  const existing = await fetchManagers();
  const byName = new Map(existing.map((m) => [m.name, m]));
  const targets = [
    { name: "방문고객", isAdmin: false, isPublic: true },
    { name: "마켓24", isAdmin: false, isPublic: true },
  ];
  const ops = [];
  for (const t of targets) {
    const cur = byName.get(t.name);
    if (!cur) {
      ops.push(addManager(t));
    } else if (cur.isAdmin !== t.isAdmin || cur.isPublic !== t.isPublic) {
      ops.push(updateManager(t.name, { isAdmin: t.isAdmin, isPublic: t.isPublic }));
    }
  }
  if (ops.length === 0) return existing;
  try { await Promise.all(ops); } catch (e) { console.warn("ensureDefaultManagers 일부 실패:", e); }
  return await fetchManagers();
}

// ── Settings (per-user) ───────────────────────────────────────
export async function fetchSettings() {
  const userId = await getUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("settings")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  return data?.data || null;
}

export async function saveSettings(settings) {
  const userId = await getUserId();
  if (!userId) return; // 로그인 전/체험판에서는 무시
  const { error } = await supabase.from("settings").upsert(
    {
      user_id: userId,
      data: settings,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

// ── Deposits (계약금/잔금) ────────────────────────────────────
export async function fetchDeposits() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("deposits")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).map(toDepositCamel);
}

export async function insertDeposit(d) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("deposits").insert({
    user_id: userId,
    customer: d.customer,
    phone: d.phone || "",
    content: d.content || "",
    total: d.total || 0,
    deposit: d.deposit || 0,
    deposit_date: d.depositDate || "",
    balance_paid: !!d.balancePaid,
    balance_date: d.balanceDate || "",
    reg_date: d.regDate || "",
    note: d.note || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toDepositCamel(data[0]) : null;
}

export async function updateDeposit(id, fields) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {};
  if ("customer" in fields) row.customer = fields.customer;
  if ("phone" in fields) row.phone = fields.phone;
  if ("content" in fields) row.content = fields.content;
  if ("total" in fields) row.total = fields.total;
  if ("deposit" in fields) row.deposit = fields.deposit;
  if ("depositDate" in fields) row.deposit_date = fields.depositDate;
  if ("balancePaid" in fields) row.balance_paid = fields.balancePaid;
  if ("balanceDate" in fields) row.balance_date = fields.balanceDate;
  if ("regDate" in fields) row.reg_date = fields.regDate;
  if ("note" in fields) row.note = fields.note;
  const { error } = await supabase
    .from("deposits")
    .update(row)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

export async function deleteDeposit(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase
    .from("deposits")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── Payment Logs (정산 처리 이력) ────────────────────────────
export async function fetchPaymentLogs(orderId) {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    let q = supabase.from("payment_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (orderId) q = q.eq("order_id", orderId);
    const { data, error } = await q.range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all;
}

export async function fetchCreditUsageLogs() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase.from("payment_logs").select("order_id,amount").eq("user_id", userId).eq("type", "적립금차감");
  if (error) throw error;
  return data || [];
}

export async function insertPaymentLog(log) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("payment_logs").insert({
    user_id: userId,
    order_id: log.orderId || null,
    customer: log.customer || "",
    type: log.type || "",
    amount: log.amount || 0,
    note: log.note || "",
  }).select();
  if (error) throw error;
  return data?.[0] || null;
}

// ── Payment Logs 기반 금액 계산 헬퍼 ─────────────────────────

export async function fetchOrderLogs(orderId) {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("payment_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

export function calcOrderMoney(orderLogs, totalAmount, fallbackPayment) {
  // rawDeposit: 환불 반영 전 실제 받은 금액 (입금 + 적립금차감)
  // refund: 고객에게 돌려준 금액 (현금환불 + 적립금전환)
  // depositAmount: 환불 차감 후 실제 남은 입금액 (옵션 A — 환불액은 입금액에서 차감)
  // balanceAmount: 미수금 — 원래 입금액(rawDeposit) 기준, 환불해도 미수금은 변하지 않음
  let rawDeposit = 0, refund = 0, creditUsed = 0;
  // paidAt: 돈이 마지막으로 들어온 시각. 포장 화면이 '언제부터 쌀 수 있게 된 건지'로
  // 줄을 세우는 데 쓴다 — 등록순으로 세우면 늦게 입금된 건이 목록 중간에 끼어든다.
  let paidAt = null;
  for (const l of orderLogs) {
    const amt = l.amount || 0;
    const t = l.type || "";
    if ((t === "입금" || t === "적립금차감" || t === "배송권차감") && l.created_at
        && (!paidAt || l.created_at > paidAt)) paidAt = l.created_at;
    if (t === "입금") rawDeposit += amt;
    else if (t === "적립금차감") { rawDeposit += amt; creditUsed += amt; }
    else if (t === "적립금복원") { creditUsed -= amt; }
    else if (t === "배송권차감") rawDeposit += amt;   // 무료배송권: 배송비만큼 입금 인정 (적립금차감과 동일)
    else if (t === "배송권복원") rawDeposit -= amt;
    else if (t === "현금환불") refund += amt;
    else if (t === "적립금전환") refund += amt;
  }
  // 엑셀로 일괄 업로드된 과거 주문은 payment_logs가 없을 수 있어, 주문 자체의 payment="입금완료"/"환불신청"
  // 플래그가 있으면 totalAmount 전액 입금 처리(대시보드 매출 누락 방지).
  // 입금완료/환불신청 = 완납된 주문이므로 입금로그가 없어도(엑셀/레거시) "받은 돈"으로 인정.
  // 환불 발생 후에도 유지돼야 부분환불이 정상 계산됨(없으면 rawDeposit=0 → 부분환불을 환불완료로 오인).
  if (rawDeposit === 0 && totalAmount > 0 &&
      (fallbackPayment === "환불신청" || fallbackPayment === "입금완료")) {
    rawDeposit = totalAmount;
  }
  const depositAmount = Math.max(0, rawDeposit - refund);
  // 환불이 있으면 주문이 사실상 종결되므로, 환불 처리 후에는 미수금이 없는 것으로 간주
  // (환불 = 가격 조정 개념 — 입금액이 환불만큼 조정되고 주문은 완료 목록으로 이동)
  const balanceAmount = refund > 0 ? 0 : Math.max(0, totalAmount - rawDeposit);
  let status;
  if (refund > 0 && refund >= rawDeposit) status = "환불완료";
  else if (refund > 0) status = "부분환불";
  else if (rawDeposit >= totalAmount) status = "입금완료";
  else if (rawDeposit > 0) status = "부분입금";
  else status = "미입금";
  return { depositAmount, rawDepositAmount: rawDeposit, refundAmount: refund, creditUsed, balanceAmount, paymentStatus: status, paidAt };
}

export async function fetchOrdersWithMoney() {
  const userId = await getUserId();
  if (!userId) throw authLost();
  // 화면에 올릴 주문의 결제로그만 읽는다.
  //
  // 예전에는 결제로그를 통째로(4,449건) 읽었다. 주문 목록이 전체였을 때는 어차피 다
  // 필요했기 때문이다. 이제 주문은 활성 건만 읽으므로(fetchOrders) 그중 몇 건에
  // 딸린 로그만 있으면 된다 — 실측 4,449건 → 161건.
  //
  // ⚠️ 1000건 단위 페이지네이션은 유지한다. Supabase REST 의 기본 max-rows 가 1000이라,
  //    이걸 빼면 로그가 1000건을 넘는 순간 조용히 잘린다. 예전에 그것 때문에 최근 주문의
  //    입금/환불/배송권차감 로그가 통째로 사라져, 정산관리에서 부분환불·부분입금이
  //    payment 컬럼 폴백("입금완료")으로 잘못 뜬 적이 있다.
  const fetchLogsFor = async (orderIds) => {
    if (orderIds.length === 0) return [];
    // in() 은 id 를 URL 에 늘어놓는다. uuid 하나가 37자라 한 번에 다 넣으면 URL 이
    // 수 KB 가 되어 프록시에서 잘릴 수 있다. 100개씩 끊고, 끊은 것끼리는 동시에 읽는다.
    const CHUNK = 100;
    const chunks = [];
    for (let i = 0; i < orderIds.length; i += CHUNK) chunks.push(orderIds.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async (ids) => {
      const out = [];
      let cursor = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("payment_logs")
          .select("*")
          .eq("user_id", userId)
          .in("order_id", ids)
          .order("created_at", { ascending: true })
          .range(cursor, cursor + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        out.push(...data);
        if (data.length < PAGE) break;
        cursor += PAGE;
      }
      return out;
    }));
    return results.flat();
  };

  // 주문을 먼저 읽고, 그 주문들의 로그를 읽는다.
  //
  // 예전에는 둘을 Promise.all 로 동시에 읽었다. 서로 필요 없는 조회인데 줄줄이
  // 기다리느라 새로고침 한 번에 4초가 걸렸기 때문이다. 이제는 로그 조회가 주문 id 를
  // 알아야 해서 순서대로 가지만, 그래도 훨씬 빠르다 — 왕복이 10번(각 1000건씩 5번)에서
  // 2번(179건 + 161건)으로 줄었다. 동시성으로 가리던 문제를 아예 없앤 셈이다.
  const orders = await fetchOrders();
  if (orders.length === 0) return orders;
  const allLogs = await fetchLogsFor(orders.map(o => o.id));
  // orderId별 그룹핑
  const logMap = {};
  for (const l of (allLogs || [])) {
    const oid = l.order_id;
    if (!oid) continue;
    if (!logMap[oid]) logMap[oid] = [];
    logMap[oid].push(l);
  }
  // 각 주문에 _computed 추가
  return orders.map(o => {
    const total = o.totalAmount > 0 ? o.totalAmount : (o.items || []).reduce((s, i) => s + (i.amount || 0), 0);
    const logs = logMap[o.id] || [];
    const computed = calcOrderMoney(logs, total, o.payment);
    return { ...o, _computed: computed };
  });
}

export async function addPaymentLog(orderId, type, amount, note, customer) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("payment_logs").insert({
    user_id: userId,
    order_id: orderId,
    customer: customer || "",
    type,
    amount: amount || 0,
    note: note || "",
  }).select();
  if (error) throw error;
  return data?.[0] || null;
}

export async function deletePaymentLogsByType(orderId, type) {
  const userId = await getUserId();
  if (!userId) return;
  const { error } = await supabase.from("payment_logs").delete().eq("user_id", userId).eq("order_id", orderId).eq("type", type);
  if (error) throw error;
}

// 환불 취소 시 환불로 인해 생성된 credits 레코드를 정리.
// reason 문자열 정확 매칭 + customer 일치 + (선택) amount 일치.
// ⚠️ 과다삭제 차단(F1): 일치 항목을 전부 지우면 같은 (customer,reason,amount) 적립이
//    여러 주문에 있을 때 한 번의 환불취소로 모두 삭제됨. credits는 order_id가 없고
//    원장이 fungible(잔액=Σ, 어느 행을 지워도 잔액 동일)이므로, "가장 최근 1건"만
//    골라 삭제한다 → 호출 1회당 정확히 1건 차감 → 잔액 정확, 무더기 삭제 방지.
export async function deleteCreditsByReason(customer, reason, amount) {
  const userId = await getUserId();
  if (!userId) return;
  let sel = supabase
    .from("credits")
    .select("id")
    .eq("user_id", userId)
    .eq("customer", customer)
    .eq("reason", reason);
  if (typeof amount === "number") sel = sel.eq("amount", amount);
  const { data, error: selErr } = await sel.order("created_at", { ascending: false }).limit(1);
  if (selErr) throw selErr;
  if (!data || data.length === 0) return; // 일치 행 없음 → no-op (언더플로 없음)
  const { error } = await supabase.from("credits").delete().eq("id", data[0].id).eq("user_id", userId);
  if (error) throw error;
}

// ── Credits (적립금) ──────────────────────────────────────────
export async function fetchCredits() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("credits")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all;
}

export async function insertCredit(c) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("credits").insert({
    user_id: userId,
    customer: c.customer,
    amount: c.amount || 0,
    type: c.type || "적립",
    reason: c.reason || "",
    manager: c.manager || "",
    memo: c.memo || "",
    order_id: c.orderId || null, // 주문에서 생긴 기록이면 그 주문 — 카드에서 주문 💬 메모를 같이 보여준다
  }).select();
  if (error) throw error;
  return data?.[0] || null;
}

export async function getCustomerCredit(customerName) {
  const userId = await getUserId();
  if (!userId) return 0;
  const { data, error } = await supabase
    .from("credits")
    .select("amount,type")
    .eq("user_id", userId)
    .eq("customer", customerName);
  if (error) return 0;
  return (data || []).reduce((sum, c) => sum + (c.type === "적립" ? c.amount : -c.amount), 0);
}

// ── 주문에 적립금 적용 — 주문등록 뒷정리와 주문현황 수정창이 같은 것을 쓴다 ──
//
// 정산관리 '적립금 차감'과 같은 모양으로 쓴다: credits 에 "사용" 한 줄, payment_logs 에
// "적립금차감" 한 줄, 그 결과 완납이면 orders.payment 를 입금완료로.
//
// 한도는 여기서 한 번에 깎는다 — 부르는 쪽이 각자 검사하면 수정창처럼 금액·총액이 같은
// 창에서 바뀌는 자리에서 빠뜨린다.
//  · 고객 잔액(bal): 다른 기기에서 그 사이 바뀌었을 수 있어 저장 직전에 다시 읽는다.
//  · 미수금(unpaid): orderTotal − 이미 받은 돈(입금·적립금·배송권 로그). 새 주문은 받은 돈이
//    0 이라 orderTotal 과 같다. 수정창에서 총액을 같이 바꿨으면 바뀐 총액을 넘긴다.
//  · 돈이 들어온 상태(입금완료·부분환불·환불완료)면 적용하지 않는다. 플래그만 입금완료인 옛
//    주문(엑셀·수동)에 차감 로그를 넣으면 입금완료 폴백이 꺼져 '부분입금'으로 되돌아간다.
//
// 반환 { useAmt, bal, unpaid, skipped, savedCredit, computed }
//  · useAmt 0 이면 아무것도 쓰지 않았다. skipped 에 이유 ("완납"·"잔액 없음"·"미수금 없음").
//  · computed 는 적용 뒤 결제 계산(calcOrderMoney) — 카드의 _computed 에 그대로 넣는다.
export async function applyOrderCredit({ customer, orderId, requested, orderTotal, manager, fallbackPayment }) {
  const want = parseInt(requested) || 0;
  const total = parseInt(orderTotal) || 0;
  if (want <= 0 || !customer || !orderId) return { useAmt: 0, bal: 0, unpaid: 0, skipped: "요청 없음" };

  const [bal, before] = await Promise.all([getCustomerCredit(customer), fetchOrderLogs(orderId)]);
  const cur = calcOrderMoney(before, total, fallbackPayment);
  if (["입금완료", "부분환불", "환불완료"].includes(cur.paymentStatus)) {
    return { useAmt: 0, bal, unpaid: 0, skipped: "완납", computed: cur };
  }
  const unpaid = Math.max(0, total - (cur.rawDepositAmount || 0));
  const useAmt = Math.min(want, bal, unpaid);
  if (bal <= 0) return { useAmt: 0, bal, unpaid, skipped: "잔액 없음", computed: cur };
  if (useAmt <= 0) return { useAmt: 0, bal, unpaid, skipped: "미수금 없음", computed: cur };

  const savedCredit = await insertCredit({ customer, amount: useAmt, type: "사용", reason: "주문 차감", manager, orderId });
  await addPaymentLog(orderId, "적립금차감", useAmt, `적립금 ${useAmt.toLocaleString()}원 차감`, customer);
  const logs = await fetchOrderLogs(orderId);
  const computed = calcOrderMoney(logs, total, fallbackPayment);
  if (computed.paymentStatus === "입금완료") await updateOrder(orderId, { payment: "입금완료" });
  return { useAmt, bal, unpaid, skipped: null, savedCredit, computed };
}

// ── 주문의 적립금 사용 취소 — 무료배송권 cancelFreeShipping 과 같은 모양 ──
// 이 주문에 쓴 적립금 순액(차감 − 복원)을 고객에게 돌려주고(credits "적립" 한 줄),
// 적립금차감·적립금복원 로그를 지워 미수금을 원복한다. 주문 삭제 때 돌려주는 것과 같은 원장 방식 —
// 쓴 "사용" 행을 지우지 않고 반대 행을 넣는다(잔액은 Σ 라 같고, 흔적이 남는다).
// 돈이 들어온 주문(부분환불·환불완료)에서는 부르지 않는다 — 복원 로그가 환불 쪽 계산에 걸려 있다.
// 반환 { amount, savedCredit } — amount 0 이면 돌려줄 게 없어 아무것도 안 했다.
export async function cancelOrderCredit(customer, orderId, manager) {
  const logs = await fetchOrderLogs(orderId);
  let net = 0;
  for (const l of logs) {
    if (l.type === "적립금차감") net += l.amount || 0;
    else if (l.type === "적립금복원") net -= l.amount || 0;
  }
  if (net <= 0) return { amount: 0, savedCredit: null };
  const savedCredit = await insertCredit({ customer, amount: net, type: "적립", reason: "적립금 사용 취소", manager, orderId });
  await deletePaymentLogsByType(orderId, "적립금차감");
  await deletePaymentLogsByType(orderId, "적립금복원");
  return { amount: net, savedCredit };
}

// ── Free Shipping Coupons (무료배송권) ────────────────────────
// 적립금과 동일한 멀티테넌트 패턴 (user_id = auth.uid()). shipping_fee 는 건드리지 않음.

// 고객 보유 무료배송권 수량
export async function getCustomerFreeShipping(customerName) {
  const userId = await getUserId();
  if (!userId) return 0;
  const { data, error } = await supabase
    .from("free_shipping_coupons")
    .select("count")
    .eq("user_id", userId)
    .eq("customer", customerName)
    .maybeSingle();
  if (error) return 0;
  return data?.count || 0;
}

// 무료배송권 발급(+delta) 또는 회수(-delta). 보유 테이블 upsert + 이력 기록.
export async function adjustFreeShipping(customerName, delta, options = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { orderId = null } = options;

  const current = await getCustomerFreeShipping(customerName);
  const newCount = current + delta;
  if (newCount < 0) throw new Error("보유 수량이 부족합니다");

  const { error: e1 } = await supabase
    .from("free_shipping_coupons")
    .upsert({
      customer: customerName,
      count: newCount,
      user_id: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "customer,user_id" });
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from("free_shipping_logs")
    .insert({
      customer: customerName,
      type: delta > 0 ? "issue" : "cancel",
      count: delta,
      order_id: orderId,
      user_id: userId,
    });
  if (e2) throw e2;

  return newCount;
}

// 고객별 무료배송권 이력
export async function getFreeShippingHistory(customerName) {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("free_shipping_logs")
    .select("*")
    .eq("user_id", userId)
    .eq("customer", customerName)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data || []).map(row => ({
    id: row.id,
    customer: row.customer,
    type: row.type,
    count: row.count,
    orderId: row.order_id,
    createdAt: row.created_at,
  }));
}

// 전체 보유 현황 (count > 0)
export async function getAllFreeShipping() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("free_shipping_coupons")
      .select("*")
      .eq("user_id", userId)
      .gt("count", 0)
      .order("updated_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) return []; // 기존 동작 유지: 에러 시 throw 하지 않고 빈 배열
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(row => ({
    id: row.id,
    customer: row.customer,
    count: row.count,
    updatedAt: row.updated_at,
  }));
}

// 무료배송권 주문 적용 — 1장 차감 + payment_logs "배송권차감" 기록 (적립금차감과 동일 패턴).
// shipping_fee 는 건드리지 않고, 배송비만큼을 입금으로 인정해 미수금을 줄인다.
export async function useFreeShipping(customerName, orderId, shippingFee) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");

  const current = await getCustomerFreeShipping(customerName);
  if (current < 1) throw new Error("보유 무료배송권이 없습니다");

  const newCount = current - 1;
  const { error: e1 } = await supabase
    .from("free_shipping_coupons")
    .upsert({
      customer: customerName,
      count: newCount,
      user_id: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "customer,user_id" });
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from("free_shipping_logs")
    .insert({
      customer: customerName,
      type: "use",
      count: -1,
      order_id: orderId,
      user_id: userId,
    });
  if (e2) throw e2;

  // 적립금차감과 동일하게 "양수" 금액 + 타입으로 구분 → calcOrderMoney 에서 rawDeposit += amt
  await addPaymentLog(orderId, "배송권차감", shippingFee, "무료배송권 1장 사용", customerName);
  await updateOrder(orderId, { free_shipping_used: true });

  return newCount;
}

// 무료배송권 사용 취소 — 1장 복원 + "배송권차감" 로그 삭제 (미수금 원복).
export async function cancelFreeShipping(customerName, orderId) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");

  // 이중 복원 차단(주문 net 가드): 이 주문이 이미 복원된 상태(예: 환불 복원으로
  // restore 로그가 이미 들어가 net≤0)면 다시 복원하지 않는다. restoreFreeShippingForRefund
  // 가 free_shipping_used 를 끄지 않아 카드가 "사용 중"으로 남아도, 토글 OFF 시 재복원되지 않도록.
  const { data: netLogs } = await supabase
    .from("free_shipping_logs")
    .select("type")
    .eq("user_id", userId)
    .eq("order_id", orderId);
  let net = 0;
  for (const r of (netLogs || [])) { if (r.type === "use") net++; else if (r.type === "restore") net--; }
  if (net <= 0) return await getCustomerFreeShipping(customerName); // 이미 복원됨 → no-op

  const current = await getCustomerFreeShipping(customerName);
  const newCount = current + 1;
  const { error: e1 } = await supabase
    .from("free_shipping_coupons")
    .upsert({
      customer: customerName,
      count: newCount,
      user_id: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "customer,user_id" });
  if (e1) throw e1;

  const { error: e2 } = await supabase
    .from("free_shipping_logs")
    .insert({
      customer: customerName,
      type: "restore",
      count: 1,
      order_id: orderId,
      user_id: userId,
    });
  if (e2) throw e2;

  await deletePaymentLogsByType(orderId, "배송권차감");
  await updateOrder(orderId, { free_shipping_used: false });

  return newCount;
}

// ── 환불 연동 (적립금 복원/취소와 동일 개념) ──────────────────
// 환불 시 고객에게 무료배송권 1장 "환원"만 한다. 주문의 배송권차감 payment_log·미수금·
// free_shipping_used 플래그는 건드리지 않음 (적립금 복원이 적립금차감을 안 건드리는 것과 동일).
// 중복 복원 방지: 해당 주문의 free_shipping_logs net(use-restore) > 0 일 때만 복원.
export async function restoreFreeShippingForRefund(customerName, orderId) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data: logs } = await supabase
    .from("free_shipping_logs")
    .select("type")
    .eq("user_id", userId)
    .eq("order_id", orderId);
  let net = 0;
  for (const r of (logs || [])) { if (r.type === "use") net++; else if (r.type === "restore") net--; }
  if (net <= 0) return null; // 적용 중인 무료배송권 없음 → 복원 안 함 (이미 복원됨 포함)

  const current = await getCustomerFreeShipping(customerName);
  const newCount = current + 1;
  const { error: e1 } = await supabase
    .from("free_shipping_coupons")
    .upsert({
      customer: customerName,
      count: newCount,
      user_id: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "customer,user_id" });
  if (e1) throw e1;
  const { error: e2 } = await supabase
    .from("free_shipping_logs")
    .insert({ customer: customerName, type: "restore", count: 1, order_id: orderId, user_id: userId });
  if (e2) throw e2;
  return newCount;
}

// 환불 취소 시 위에서 환원했던 1장을 회수 (적립금 환불취소 정리와 동일).
// 가장 최근 free_shipping_logs 가 restore 일 때만 되돌린다 (환불 복원으로 생긴 행).
export async function undoFreeShippingRestoreForRefund(customerName, orderId) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data: rows } = await supabase
    .from("free_shipping_logs")
    .select("id,type")
    .eq("user_id", userId)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (!rows || rows.length === 0 || rows[0].type !== "restore") return null;

  const current = await getCustomerFreeShipping(customerName);
  const newCount = Math.max(0, current - 1);
  const { error: e1 } = await supabase
    .from("free_shipping_coupons")
    .upsert({
      customer: customerName,
      count: newCount,
      user_id: userId,
      updated_at: new Date().toISOString(),
    }, { onConflict: "customer,user_id" });
  if (e1) throw e1;
  await supabase.from("free_shipping_logs").delete().eq("id", rows[0].id).eq("user_id", userId);
  return newCount;
}

// ── Bulk: 본인 데이터만 초기화 ────────────────────────────────
export async function clearAllData() {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  await supabase.from("orders").delete().eq("user_id", userId);
  await supabase.from("logs").delete().eq("user_id", userId);
  await supabase.from("customers").delete().eq("user_id", userId);
  await supabase.from("deposits").delete().eq("user_id", userId);
}

// ── 데이터 관리 (설정 화면) ───────────────────────────────────
// 엑셀 업로드 마커: time="00:00" (insertOrderBatch에서 항상 이 값으로 저장).
// 클라이언트가 만드는 "#L..." 식 id는 DB로 전달되지 않으므로 id 패턴으로
// 식별할 수 없음. fetchOrders도 같은 기준(time="00:00")으로 엑셀분 제외 중.

export async function countExcelOrders() {
  const userId = await getUserId();
  if (!userId) return 0;
  const { count, error } = await supabase
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("time", "00:00");
  if (error) throw error;
  return count || 0;
}

export async function countAllOrders() {
  const userId = await getUserId();
  if (!userId) return 0;
  const { count, error } = await supabase
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw error;
  return count || 0;
}

// 엑셀 업로드 묶음(batch) 목록 — created_at 60초 클러스터로 그룹.
// Supabase batch insert는 한 트랜잭션이라 같은 업로드 내 모든 행이
// 동일한(또는 거의 동일한) created_at을 가짐. 이를 이용해 업로드 단위를 분리.
export async function fetchExcelUploadBatches() {
  const userId = await getUserId();
  if (!userId) return [];

  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("id, customer, date, created_at, total_amount, sales_channel")
      .eq("user_id", userId)
      .eq("time", "00:00")
      .order("created_at", { ascending: true })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  if (all.length === 0) return [];

  const WINDOW_MS = 60 * 1000;
  const batches = [];
  let current = null;
  for (const o of all) {
    const ts = new Date(o.created_at).getTime();
    if (!current || ts - current._lastTs > WINDOW_MS) {
      current = {
        firstCreatedAt: o.created_at,
        lastCreatedAt: o.created_at,
        _lastTs: ts,
        count: 0,
        _customers: new Set(),
        _dates: [],
        _channels: new Set(),
        totalAmount: 0,
      };
      batches.push(current);
    }
    current.lastCreatedAt = o.created_at;
    current._lastTs = ts;
    current.count += 1;
    if (o.customer) current._customers.add(o.customer);
    if (o.date) current._dates.push(o.date);
    if (o.sales_channel) current._channels.add(o.sales_channel);
    current.totalAmount += o.total_amount || 0;
  }

  return batches.map(b => {
    const sorted = b._dates.filter(Boolean).sort();
    return {
      id: `batch_${new Date(b.firstCreatedAt).getTime()}`,
      firstCreatedAt: b.firstCreatedAt,
      lastCreatedAt: b.lastCreatedAt,
      count: b.count,
      customerCount: b._customers.size,
      orderDateMin: sorted[0] || null,
      orderDateMax: sorted[sorted.length - 1] || null,
      channels: Array.from(b._channels),
      totalAmount: b.totalAmount,
    };
  }).reverse(); // 최신 업로드 먼저
}

// 특정 시간 범위의 엑셀 업로드분만 삭제 (created_at >= start AND <= end).
// time="00:00" 조건으로 ERP 직접 입력 주문은 안전하게 제외됨.
export async function deleteExcelOrdersByRange(startCreatedAt, endCreatedAt) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  if (!startCreatedAt || !endCreatedAt) throw new Error("범위가 잘못되었습니다");

  const PAGE = 1000;
  const ids = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("id")
      .eq("user_id", userId)
      .eq("time", "00:00")
      .gte("created_at", startCreatedAt)
      .lte("created_at", endCreatedAt)
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    ids.push(...data.map(r => r.id));
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  if (ids.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error: e1 } = await supabase
      .from("payment_logs")
      .delete()
      .eq("user_id", userId)
      .in("order_id", slice);
    if (e1) throw e1;
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error: e2 } = await supabase
      .from("orders")
      .delete()
      .eq("user_id", userId)
      .in("id", slice);
    if (e2) throw e2;
  }
  return ids.length;
}

// 엑셀 업로드분만 삭제 — 연관 payment_logs 정리 후 orders 삭제.
// 1000건씩 페이지네이션해 id 수집 → 500건씩 끊어 삭제 (URL 길이 제한 회피).
export async function deleteExcelOrders() {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");

  const PAGE = 1000;
  const ids = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("id")
      .eq("user_id", userId)
      .eq("time", "00:00")
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    ids.push(...data.map(r => r.id));
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  if (ids.length === 0) return 0;

  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error: e1 } = await supabase
      .from("payment_logs")
      .delete()
      .eq("user_id", userId)
      .in("order_id", slice);
    if (e1) throw e1;
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { error: e2 } = await supabase
      .from("orders")
      .delete()
      .eq("user_id", userId)
      .in("id", slice);
    if (e2) throw e2;
  }
  return ids.length;
}

// 모든 주문 + 연관 데이터 완전 삭제 (본인 user_id 한정).
// payment_logs / credits / logs / orders 순으로 비움.
export async function deleteAllOrdersFull() {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const total = await countAllOrders();
  const tables = ["payment_logs", "credits", "logs", "orders"];
  for (const t of tables) {
    const { error } = await supabase.from(t).delete().eq("user_id", userId);
    if (error) throw error;
  }
  return total;
}

// ── 공지판 ────────────────────────────────────────────────────
// 입금은 들어왔는데 ERP에 주문이 없는 건. 관리자가 올리고, 주인이 가져가서 처리한다.
// (migrations/add_notices.sql)

const toNoticeCamel = (r) => ({
  id: r.id,
  kind: r.kind || "deposit",
  amount: r.amount || 0,
  depositor: r.depositor || "",
  depositedAt: r.deposited_at || null,
  rawText: r.raw_text || "",
  memo: r.memo || "",
  claimedBy: r.claimed_by || "",
  claimedAt: r.claimed_at || null,
  resolvedAt: r.resolved_at || null,
  resolvedBy: r.resolved_by || "",
  resolvedOrderId: r.resolved_order_id || null,
  createdBy: r.created_by || "",
  createdAt: r.created_at,
});

// 해결된 건도 함께 가져온다 — 목록에서 접어둘 뿐 기록은 남겨야 "그거 처리됐나"에 답할 수 있다.
export async function fetchNotices() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("notices").select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data || []).map(toNoticeCamel);
}

export async function insertNotice(n) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("notices").insert({
    user_id: userId,
    kind: n.kind || "deposit",
    amount: n.amount || 0,
    depositor: (n.depositor || "").trim(),
    deposited_at: n.depositedAt || null,
    raw_text: n.rawText || "",
    memo: (n.memo || "").trim(),
    created_by: n.createdBy || "",
  }).select();
  if (error) throw error;
  return data?.[0] ? toNoticeCamel(data[0]) : null;
}

/** 주인 찾기 — 누르면 이름이 붙어 다른 사람이 중복으로 달라붙지 않는다. 눌러서 끄기도 된다. */
export async function claimNotice(id, who) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase.from("notices").update(
    who ? { claimed_by: who, claimed_at: new Date().toISOString() }
        : { claimed_by: "", claimed_at: null }
  ).eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

/** 처리 완료 / 되돌리기. orderId 를 남기면 나중에 "어느 주문이 됐는지" 추적된다. */
export async function resolveNotice(id, who, orderId) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase.from("notices").update(
    who ? { resolved_at: new Date().toISOString(), resolved_by: who, resolved_order_id: orderId || null }
        : { resolved_at: null, resolved_by: "", resolved_order_id: null }
  ).eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

export async function deleteNotice(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { error } = await supabase.from("notices").delete().eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

// ── QR 롤 재고 (migrations/add_stock_rolls.sql) ─────────────────
// 재고의 단위는 원단 종류가 아니라 롤 하나다. products 는 "이 원단이 무엇인가"만 담고
// (수량 없음), stock_rolls 가 롤 한 줄씩, stock_movements 가 잔량이 바뀐 기록이다.
//
// 잔량(length_remaining)은 여기서 직접 고치지 않는다. 기록과 잔량을 따로 보내면 하나만
// 성공하는 순간 둘이 어긋난다 — 반드시 RPC(roll_apply_movement) 하나로 보낸다.

const numOrNull = (v) => (v === null || v === undefined || v === "") ? null : Number(v);

const productFromRow = (r) => ({
  id: r.id,
  code: r.code || "",
  name: r.name || "",
  color: r.color || "",
  photoUrl: r.photo_url || "",
  // 품번 담당자(migrations/add_product_manager.sql) — 입고한 사람이 기본. 칸이 없는 옛 DB 면 빈 문자열.
  manager: r.manager || "",
  unit: r.unit || "마",
  unitPrice: numOrNull(r.unit_price),
  note: r.note || "",
  createdAt: r.created_at,
});

const rollFromRow = (r) => ({
  id: r.id,
  productId: r.product_id,
  rollCode: r.roll_code || "",
  lengthReceived: numOrNull(r.length_received),
  lengthAvailable: numOrNull(r.length_available),   // 검단 전에는 null
  lengthRemaining: numOrNull(r.length_remaining),
  status: r.status || "received",
  location: r.location || "",
  supplier: r.supplier || "",
  inspectedAt: r.inspected_at || null,
  inspectedBy: r.inspected_by || "",
  labelRequestedAt: r.label_requested_at || null,
  labelPrintedAt: r.label_printed_at || null,
  // 조각 롤 — 잘려 나갔다가 돌아온 원단(취소·반품). 입고한 롤은 origin 이 null. (add_roll_pieces.sql)
  origin: r.origin || null,
  originRollId: r.origin_roll_id || null,
  originOrderId: r.origin_order_id || null,
  note: r.note || "",
  createdAt: r.created_at,
});

const movementFromRow = (r) => ({
  id: r.id,
  rollId: r.roll_id,
  type: r.type,
  qty: numOrNull(r.qty),
  orderId: r.order_id || null,
  itemId: r.item_id || null,
  note: r.note || "",
  createdBy: r.created_by || "",
  createdAt: r.created_at,
});

// ── products ──
export async function fetchProducts() {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000; // Supabase REST 기본 max-rows 우회 (1000건씩 페이지네이션)
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", userId)
      .order("created_at")
      .order("id")
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(productFromRow);
}

/** 품번으로 찾는다(대소문자 무시). 없으면 null. */
export async function findProductByCode(code) {
  const userId = await getUserId();
  const c = String(code || "").trim();
  if (!userId || !c) return null;
  // ilike 는 % 와 _ 를 와일드카드로 읽는다. 품번에 들어 있으면 글자 그대로 찾도록 막는다.
  const pattern = c.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", userId)
    .ilike("code", pattern)
    .limit(1);
  if (error) throw error;
  return data?.[0] ? productFromRow(data[0]) : null;
}

/**
 * 새 품번을 등록한다. 품번(code)은 서버가 발급한다(next_product_code) —
 * 화면에서 만들면 두 사람이 동시에 등록할 때 같은 번호가 나온다.
 *
 * 사진은 품번을 만든 뒤에 올린다(경로에 product id 가 들어간다). 사진만 실패하면
 * 품번은 그대로 두고 photoError 를 붙여 돌려준다 — 품번까지 없던 일로 하면 이미
 * 발급된 번호가 비고, 사람은 처음부터 다시 입력해야 한다.
 */
/** 이미 있는 품번에 사진을 붙인다 — 입고하면서 찍은 사진. 반환: 사진 주소 */
export async function setProductPhoto(productId, photoFile) {
  const url = await uploadProductImage(photoFile, productId);
  await updateProduct(productId, { photoUrl: url });
  return url;
}

/**
 * 품번 발급 + 등록. prefix 는 담당자 이니셜(rollStock.prefixForManager) — 서버가 'A-2610-0005' 꼴로 만든다.
 * 안 주면 서버 기본값(LH). manager 는 품번 담당자(이름) — add_product_manager.sql 이 먼저 들어가 있어야 한다.
 */
export async function insertProduct({ name, color, unitPrice, note, photoFile, manager, prefix }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const nm = String(name || "").trim();
  if (!nm) throw new Error("원단명을 입력해 주세요");

  const { data: code, error: codeErr } = await supabase.rpc("next_product_code", prefix ? { p_prefix: String(prefix) } : {});
  if (codeErr) throw codeErr;
  if (!code) throw new Error("품번을 발급받지 못했습니다");

  const price = numOrNull(unitPrice);
  const { data, error } = await supabase.from("products").insert({
    user_id: userId,
    code,
    name: nm,
    color: String(color || "").trim(),
    manager: String(manager || "").trim(),
    unit_price: price && price > 0 ? price : null,
    note: String(note || "").trim() || null,
  }).select();
  if (error) throw error;
  let product = productFromRow(data[0]);

  if (photoFile) {
    try {
      const url = await uploadProductImage(photoFile, product.id);
      await updateProduct(product.id, { photoUrl: url });
      product = { ...product, photoUrl: url };
    } catch (e) {
      console.warn("[품번] 사진 업로드 실패", e);
      product = { ...product, photoError: e.message || "사진 업로드 실패" };
    }
  }
  return product;
}

/** 품번 정보 수정. 품번(code)은 못 바꾼다 — 이미 뽑은 롤 라벨의 QR 이 그 값으로 시작한다. */
export async function updateProduct(id, patch = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {};
  if ("name" in patch) row.name = String(patch.name || "").trim();
  if ("color" in patch) row.color = String(patch.color || "").trim();
  if ("photoUrl" in patch) row.photo_url = patch.photoUrl || null;
  if ("unit" in patch) row.unit = patch.unit || "마";
  if ("unitPrice" in patch) row.unit_price = numOrNull(patch.unitPrice);
  if ("note" in patch) row.note = patch.note || null;
  if ("manager" in patch) row.manager = String(patch.manager || "").trim();
  if (!Object.keys(row).length) return;
  if ("name" in row && !row.name) throw new Error("원단명을 입력해 주세요");
  const { error } = await supabase.from("products").update(row).eq("id", id).eq("user_id", userId);
  if (error) throw error;
}

// ── stock_rolls ──
/**
 * 롤 목록. 기본은 끝난 롤(판매 완료·폐기)을 뺀다 — 쌓일수록 늘기만 하고 볼 일은 드물다.
 * @param status 상태 하나 또는 배열. "all" 이면 전부.
 */
export async function fetchRolls({ status } = {}) {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    let q = supabase.from("stock_rolls").select("*").eq("user_id", userId);
    if (status === "all") { /* 전부 */ }
    else if (status) q = q.in("status", Array.isArray(status) ? status : [status]);
    else q = q.not("status", "in", `(${CLOSED_STATUSES.join(",")})`);
    const { data, error } = await q.order("created_at").order("id").range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(rollFromRow);
}

/**
 * 입고 — 롤을 count 개 만든다(status='received', 검단 대기).
 * roll_code 는 `${품번}-R${두 자리 순번}`. 순번은 그 품번의 기존 롤 다음부터.
 *
 * 한 번의 insert 로 보낸다 — 세 롤 중 둘만 들어가는 일이 없다.
 * 다른 사람이 같은 품번을 동시에 입고하면 순번이 겹친다(unique 충돌). 그때는 한 칸 밀어
 * 한 번만 다시 해 본다. 그래도 겹치면 에러를 그대로 올린다 — 조용히 계속 밀면 순번이
 * 어디까지 뛰었는지 아무도 모른다.
 * @returns 만든 롤 배열
 */
// lengths: 롤마다 길이 [30, 28.5, …] — 주면 count·lengthReceived 대신 이것을 쓴다(롤마다 길이가 다르다).
export async function insertRolls(productId, { count = 1, lengthReceived, lengths = null, supplier, location } = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const list = Array.isArray(lengths) ? lengths.map(Number) : null;
  const n = list ? list.length : Math.floor(Number(count));
  if (!Number.isFinite(n) || n < 1) throw new Error("롤 수는 1 이상이어야 합니다");
  if (n > 99) throw new Error("한 번에 99롤까지 등록할 수 있습니다");
  const lens = list || Array.from({ length: n }, () => Number(lengthReceived));
  if (lens.some(v => !Number.isFinite(v) || v <= 0)) throw new Error("롤마다 수량을 입력해 주세요");

  const { data: prod, error: pErr } = await supabase
    .from("products").select("id, code").eq("id", productId).eq("user_id", userId).maybeSingle();
  if (pErr) throw pErr;
  if (!prod) throw new Error("품번을 찾을 수 없습니다");

  const attempt = async (bump) => {
    // 끝난 롤(판매 완료·폐기)까지 센다 — 번호는 한 번 쓰면 다시 쓰지 않는다.
    const { data: existing, error: eErr } = await supabase
      .from("stock_rolls").select("roll_code").eq("product_id", productId).eq("user_id", userId);
    if (eErr) throw eErr;
    const codes = nextRollCodes(prod.code, (existing || []).map(r => r.roll_code), n, bump);
    return supabase.from("stock_rolls").insert(codes.map((roll_code, i) => ({
      user_id: userId,
      product_id: productId,
      roll_code,
      length_received: lens[i],
      supplier: String(supplier || "").trim(),
      location: String(location || "").trim(),
      status: "received",
    }))).select();
  };

  let { data, error } = await attempt(0);
  if (error?.code === "23505") ({ data, error } = await attempt(1));
  if (error) throw error;
  return (data || []).map(rollFromRow)
    .sort((a, b) => a.rollCode.localeCompare(b.rollCode));
}

/**
 * 입고 = 바로 판매 가능(2026-10-02 결정: 검단 단계를 생략한다).
 * 롤마다 적은 길이를 그대로 실측값으로 놓아(inspect) 판매 가능으로 만들고, 라벨을 한 번에 요청한다.
 * 롤 행을 만든 뒤 하나씩 inspect 하므로, 중간에 실패한 롤은 '검단 대기'로 남는다 — 화면이 그 목록을 보여주고
 * 거기서 마저 처리한다(failed 로 알려 준다).
 * 반환 { rolls, failed: [rollCode…], labelRequested }
 */
export async function receiveRolls(productId, { lengths, supplier, location } = {}, by = "") {
  const made = await insertRolls(productId, { lengths, supplier, location });
  const done = [], failed = [];
  for (const r of made) {
    try { done.push(await applyMovement(r.id, "inspect", r.lengthReceived, { by, note: "입고" })); }
    catch (e) { console.warn("[입고] 판매 가능 처리 실패", r.rollCode, e); failed.push(r.rollCode); }
  }
  let labelRequested = false;
  if (done.length) {
    try { labelRequested = (await requestRollLabelPrint(done.map(r => r.id), by)) === done.length; }
    catch (e) { console.warn("[입고] 라벨 요청 실패", e); }
  }
  return { rolls: done, failed, labelRequested };
}

// 잔량을 바꾸는 유일한 길. 세션이 끊긴 채로 부르면 RPC 가 'roll not found' 를 던지는데
// (auth.uid() 가 null), 그 말은 사람이 읽어도 무슨 일인지 모른다 — 먼저 확인한다.
async function applyMovement(rollId, type, qty, { note = null, by = null, orderId = null, itemId = null } = {}) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const { data, error } = await supabase.rpc("roll_apply_movement", {
    p_roll_id: rollId,
    p_type: type,
    p_qty: qty,
    p_order_id: orderId,
    p_note: note || null,
    p_by: by || null,
    // 품목 연결은 있을 때만 보낸다. 늘 보내면 2단계 SQL(7인자)이 안 들어간 DB 에서 검단·조정까지
    // 통째로 실패한다 — 인자를 빼고 부르면 6인자 판이든 7인자 판(기본값)이든 받는다.
    ...(itemId ? { p_item_id: itemId } : {}),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("롤을 찾을 수 없습니다");
  return rollFromRow(row);
}

/**
 * 검단 완료 — 실측 수량을 적고 판매 가능으로 바꾼 뒤, 라벨 출력까지 요청한다.
 * (검단을 마쳤다 = 이 롤에 라벨을 붙일 차례다)
 *
 * 라벨 요청만 실패하면 검단은 그대로 둔다. 실측은 이미 기록됐고, 라벨은 롤 재고
 * 화면에서 다시 요청할 수 있다. labelRequested 로 알려 주니 화면이 그 말을 해야 한다.
 * @returns {{ roll, labelRequested: boolean }}
 */
export async function inspectRoll(rollId, measuredLength, by) {
  let roll = await applyMovement(rollId, "inspect", measuredLength, { by });
  let labelRequested = false;
  try {
    labelRequested = (await requestRollLabelPrint([rollId], by)) > 0;
    if (labelRequested) roll = { ...roll, labelRequestedAt: new Date().toISOString(), labelPrintedAt: null };
  } catch (e) {
    console.warn("[롤라벨] 출력 요청 실패", rollId, e);
  }
  return { roll, labelRequested };
}

/** 수량 조정 — delta 는 부호 있는 변화량(줄이면 음수). 잔량이 음수가 되면 서버가 거부한다. */
export async function adjustRoll(rollId, delta, note, by) {
  return applyMovement(rollId, "adjust", delta, { note, by });
}

/**
 * 폐기 — qty 를 안 주면 남은 잔량을 전부 뺀다. 검단 전 롤(잔량 없음)은 0 을 빼고 상태만 폐기로 바뀐다.
 * qty 를 주면 그만큼만 뺀다(2026-10-08 사용자 요청 — 오염·이염으로 몇 마만 버리는 일이 있다).
 * 부분 폐기는 상태를 안 바꾼다 — 서버(roll_apply_movement)가 scrap 으로 잔량이 0 이 될 때만 'scrapped' 로 돌린다.
 * 그래서 qty 가 잔량과 같으면 전량 폐기와 결과가 같다. 잔량보다 많으면 여기서 거절한다(서버도 거절하지만
 * "remaining below zero" 보다 읽기 쉬운 말로).
 */
export async function scrapRoll(rollId, reason, by, qty = null) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const { data: cur, error } = await supabase
    .from("stock_rolls").select("length_remaining").eq("id", rollId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!cur) throw new Error("롤을 찾을 수 없습니다");
  const remaining = Number(cur.length_remaining) || 0;
  if (qty === null || qty === undefined) {
    return applyMovement(rollId, "scrap", remaining > 0 ? -remaining : 0, { note: reason, by });
  }
  const n = Math.round(Number(qty) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0) throw new Error("폐기할 수량을 입력해 주세요");
  if (n > remaining) throw new Error(`잔량 ${remaining} 보다 많이 뺄 수 없습니다 — 변경되지 않았습니다`);
  return applyMovement(rollId, "scrap", -n, { note: reason, by });
}

// 시험 품번의 롤인가 — 품번 접두어 TEST(담당자 '테스트'). 롤 번호는 '품번-R01' 꼴이라 앞글자로 안다.
export const isTestRollCode = (code) => /^TEST-/i.test(String(code || "").trim());

/**
 * 롤 삭제 — 잘못 등록한 롤(시험 입고·중복 등록)을 없던 일로 한다. 이력(검단·조정)도 같이 지워진다.
 * 주문에 잘라 나간 적이 있는 롤은 못 지운다 — 그 주문의 포장 기록이 가리킬 롤이 사라진다. 그런 롤은 폐기.
 * 단, 시험 품번(TEST-…)의 롤은 잘라 나간 기록이 있어도 지운다(2026-10-12 사용자 결정) — 시험 데이터를 치우는 용도라
 * 포장 기록이 빈 롤을 가리켜도 상관없다(order_item_packing.roll_id 는 on delete set null, 이력은 cascade).
 * 반환 { productId, remaining } — remaining 은 그 품번에 남은 롤 수(끝난 롤 포함). 0 이면 품번도 지울 수 있다.
 */
export async function deleteRoll(rollId) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const { data: roll, error } = await supabase
    .from("stock_rolls").select("id, product_id, roll_code").eq("id", rollId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!roll) throw new Error("롤을 찾을 수 없습니다");
  const used = await supabase.from("stock_movements").select("id")
    .eq("user_id", userId).eq("roll_id", rollId).in("type", ["cut", "sell_whole"]).limit(1);
  if (used.error) throw used.error;
  if ((used.data || []).length > 0 && !isTestRollCode(roll.roll_code)) {
    throw new Error(`주문에 잘라 나간 기록이 있는 롤은 삭제할 수 없습니다 (${roll.roll_code}) — 폐기를 쓰세요`);
  }
  const del = await supabase.from("stock_rolls").delete().eq("id", rollId).eq("user_id", userId).select("id");
  if (del.error) throw del.error;
  if (!del.data || del.data.length === 0) throw authLost("삭제되지 않았습니다 — 연결이 끊겼거나 이미 지워진 롤입니다");
  const left = await supabase.from("stock_rolls").select("id").eq("user_id", userId).eq("product_id", roll.product_id);
  return { productId: roll.product_id, remaining: left.error ? null : (left.data || []).length };
}

/**
 * 품번 삭제 — 롤이 하나도 없는 품번만. 롤이 남아 있으면 DB 도 막는다(on delete restrict).
 * 이 품번을 골라 등록한 주문은 그대로 남고, 품번 연결만 끊긴 것처럼 보인다(원단명·수량은 주문에 적혀 있다).
 */
export async function deleteProduct(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const left = await supabase.from("stock_rolls").select("id").eq("user_id", userId).eq("product_id", id);
  if (left.error) throw left.error;
  const n = (left.data || []).length;
  if (n > 0) throw new Error(`롤이 ${n}개 남아 있는 품번은 삭제할 수 없습니다 — 롤을 먼저 지워 주세요`);
  const { data, error } = await supabase.from("products").delete().eq("id", id).eq("user_id", userId).select("id");
  if (error) {
    if (error.code === "23503") throw new Error("이 품번으로 만든 링크 주문 초안이 있어 삭제할 수 없습니다 — 초안을 먼저 지워 주세요");
    throw error;
  }
  if (!data || data.length === 0) throw authLost("삭제되지 않았습니다 — 연결이 끊겼거나 이미 지워진 품번입니다");
  await deleteProductImages(id);
}

export async function updateRollLocation(rollId, location) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase
    .from("stock_rolls")
    .update({ location: String(location || "").trim() })
    .eq("id", rollId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  if (!(data || []).length) throw authLost("위치가 저장되지 않았습니다 — 연결이 끊겼거나 롤이 없습니다");
}

/**
 * 롤의 입고 정보 수정 — 위치·공급처(2026-10-13 사용자 요청 "입고된 롤 수정"). 수량·상태는 여기서 안 건드린다 —
 * 그건 roll_apply_movement 로만 바꿔야 이력이 남는다.
 */
export async function updateRoll(rollId, patch = {}) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {};
  if ("location" in patch) row.location = String(patch.location || "").trim();
  if ("supplier" in patch) row.supplier = String(patch.supplier || "").trim();
  if (!Object.keys(row).length) return;
  const { data, error } = await supabase
    .from("stock_rolls")
    .update(row)
    .eq("id", rollId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  if (!(data || []).length) throw authLost("롤이 저장되지 않았습니다 — 연결이 끊겼거나 롤이 없습니다");
}

/** 한 롤의 잔량 변동 기록. 최근 것부터. */
export async function fetchRollMovements(rollId) {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("stock_movements")
    .select("*")
    .eq("roll_id", rollId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data || []).map(movementFromRow);
}

// ── 롤 라벨 출력권 — 주문 라벨(requestLabelPrint / claimLabelPrint)과 같은 구조 ──
/**
 * 롤 라벨을 뽑아달라고 요청한다. 실제 인쇄는 라벨 PC 가 한다.
 * label_printed_at 을 함께 비운다 — 이미 뽑은 롤을 다시 요청했으면 다시 나와야 한다.
 *
 * requestedBy 는 주문 라벨과 모양을 맞추려고 받지만 저장하지 않는다.
 * stock_rolls 에는 요청자 칸이 없다(누가 검단했는지는 inspected_by 에 있다).
 * @returns 요청이 걸린 롤 수
 */
// eslint-disable-next-line no-unused-vars
export async function requestRollLabelPrint(rollIds, requestedBy = "") {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const ids = Array.isArray(rollIds) ? rollIds : [rollIds];
  if (!ids.length) return 0;
  const { data, error } = await supabase
    .from("stock_rolls")
    .update({ label_requested_at: new Date().toISOString(), label_printed_at: null })
    .in("id", ids)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

/**
 * 롤 라벨 출력권을 집는다. 실제로 집었으면 true — 그때만 인쇄한다.
 * `is("label_printed_at", null)` 이 UPDATE 조건에 있어 DB 가 한 대만 통과시킨다.
 */
export async function claimRollLabelPrint(rollId) {
  const userId = await getUserId();
  if (!userId) return false;
  const { data, error } = await supabase
    .from("stock_rolls")
    .update({ label_printed_at: new Date().toISOString() })
    .eq("id", rollId)
    .eq("user_id", userId)
    .is("label_printed_at", null)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

/** 출력권을 놓아준다 — 인쇄에 실패해 다시 뽑아야 할 때. */
/**
 * 라벨 요청 취소 — 아직 안 뽑힌 요청을 거둔다. 라벨 PC 가 꺼진 사이 요청이 쌓였을 때
 * 필요 없는 것을 빼는 길(2026-10-13 점검 전에는 이 길이 없어 요청이 줄지 않았다).
 */
export async function cancelRollLabelRequest(rollId) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const { data, error } = await supabase
    .from("stock_rolls")
    .update({ label_requested_at: null })
    .eq("id", rollId).eq("user_id", userId).is("label_printed_at", null)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

export async function releaseRollLabelPrint(rollId) {
  const userId = await getUserId();
  if (!userId) return;
  const { error } = await supabase
    .from("stock_rolls")
    .update({ label_printed_at: null })
    .eq("id", rollId)
    .eq("user_id", userId);
  if (error) throw error;
}

// ── 포장대 스캔 — 품목별 포장 기록 (migrations/add_item_packing.sql) ──
// 주문 품목 하나가 어느 롤에서 얼마만큼 잘려 박스에 들어갔는가. 롤 잔량 차감과 이 기록은
// RPC(pack_item_from_roll) 한 트랜잭션으로 묶인다 — 화면에서 둘을 따로 보내지 않는다.

const packingFromRow = (r) => ({
  id: r.id,
  orderId: r.order_id,
  itemId: r.item_id,
  rollId: r.roll_id || null,
  // 롤 코드는 stock_rolls 에서 같이 읽어 온다(select 의 embed). 화면이 든 롤 목록에는
  // 끝난 롤이 없어서, 통째로 판 롤의 코드를 거기서는 못 찾는다.
  rollCode: r.stock_rolls?.roll_code || "",
  length: numOrNull(r.length),
  wholeRoll: !!r.whole_roll,
  overrideReason: r.override_reason || "",
  packedBy: r.packed_by || "",
  packedAt: r.packed_at,
});

/**
 * 롤 코드로 롤 하나를 찾는다 — 끝난 롤(판매 완료·폐기)까지 본다.
 * 화면이 들고 있는 목록에는 끝난 롤이 없어서, 그런 롤을 찍으면 "등록되지 않은 코드"로
 * 보인다. 그건 틀린 말이다 — "다 팔린 롤입니다"라고 해야 사람이 다른 롤을 찾는다.
 */
export async function findRollByCode(rollCode) {
  const userId = await getUserId();
  if (!userId) return null;
  const code = String(rollCode || "").trim().toUpperCase();
  if (!code) return null;
  const { data, error } = await supabase
    .from("stock_rolls").select("*").eq("user_id", userId).eq("roll_code", code).maybeSingle();
  if (error) throw error;
  return data ? rollFromRow(data) : null;
}

/**
 * 주문들의 포장 기록. 출고 전 주문만 넘기면 된다 — 나간 주문의 기록은 볼 화면이 없다.
 * in() 은 200건씩 끊는다(URL 길이). 그 안에서 1000행씩 페이지네이션.
 */
export async function fetchItemPacking(orderIds) {
  const userId = await getUserId();
  if (!userId) return [];
  const uniq = [...new Set((orderIds || []).filter(Boolean).map(String))];
  if (uniq.length === 0) return [];
  const CHUNK = 200, PAGE = 1000;
  const all = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const ids = uniq.slice(i, i + CHUNK);
    let cursor = 0;
    while (true) {
      const { data, error } = await supabase
        .from("order_item_packing").select("*, stock_rolls(roll_code)")
        .eq("user_id", userId).in("order_id", ids)
        .order("packed_at").order("id")
        .range(cursor, cursor + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      cursor += PAGE;
    }
  }
  return all.map(packingFromRow);
}

/**
 * 롤을 찍어 품목을 포장한다 — 잔량 차감 + 포장 기록, 한 트랜잭션.
 * whole 이면 length 는 무시하고 그 롤의 잔량 전체를 가져간다(통판매).
 * 같은 품목을 두 번 보내면 unique 가 막고(23505), 잔량이 모자라면 RPC 가 되돌린다.
 */
export async function packItemFromRoll(orderId, itemId, rollId, length, whole, by) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const { data, error } = await supabase.rpc("pack_item_from_roll", {
    p_order_id: String(orderId),
    p_item_id: String(itemId),
    p_roll_id: rollId,
    p_length: whole ? null : Number(length),
    p_whole: !!whole,
    p_by: by || null,
  });
  if (error) {
    if (error.code === "23505") throw new Error("이미 포장된 품목입니다 — 취소한 뒤 다시 찍어 주세요");
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("포장 기록이 저장되지 않았습니다");
  return packingFromRow(row);
}

/**
 * 롤 없이 포장 — 옛 재고·외주·급한 건. 사유가 있어야 한다.
 * 롤이 없으니 차감할 것도 없어 RPC 를 거치지 않고 기록만 남긴다(roll_id null).
 */
export async function packItemOverride(orderId, itemId, reason, by) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const why = String(reason || "").trim();
  if (!why) throw new Error("롤 없이 포장한 사유를 적어 주세요");
  const { data, error } = await supabase
    .from("order_item_packing")
    .insert({ user_id: userId, order_id: String(orderId), item_id: String(itemId),
              roll_id: null, length: null, whole_roll: false, override_reason: why, packed_by: by || "" })
    .select();
  if (error) {
    if (error.code === "23505") throw new Error("이미 포장된 품목입니다 — 취소한 뒤 다시 해 주세요");
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw authLost("포장 기록이 저장되지 않았습니다 — 연결이 끊겼습니다");
  return packingFromRow(row);
}

/** 품목 포장 취소 — 기록을 지우고, 롤에서 뺀 길이를 되돌린다(수기 우회는 기록만). */
// ── 링크 주문 초안 (migrations/add_link_order_drafts.sql) ──────────────
// 공개 주문 페이지(/o/{품번})가 서버 함수를 거쳐 넣은 초안. orders 가 아니다 — 셀러가 주문입력 탭에서
// "주문으로 전환"을 눌러 기존 등록 경로로 주문을 만들고, 성공하면 markDraftConverted 로 표시한다.
const toDraftCamel = (r) => ({
  id: r.id, status: r.status,
  productId: r.product_id, productCode: r.product_code || "", productName: r.product_name || "",
  unitPrice: r.unit_price === null || r.unit_price === undefined ? null : Number(r.unit_price), qty: Number(r.qty) || 0, unit: r.unit || "마",
  phone: r.phone || "", customerName: r.customer_name || "", customerId: r.customer_id || null, depositorName: r.depositor_name || "",
  address: r.address || "", addressDetail: r.address_detail || "", deliveryMessage: r.delivery_message || "",
  mergeWithOrderId: r.merge_with_order_id || null, useFreeShipping: !!r.use_free_shipping,
  creditUse: Number(r.credit_use) || 0,   // 공개 링크에서 고객이 적은 적립금 사용액 (migrations/add_link_drafts_credit.sql)
  rolls: Array.isArray(r.rolls) ? r.rolls : null,   // 롤 주문에서 고객이 고른 롤 [{ id, rollCode, length }]
  shippingFee: Number(r.shipping_fee) || 0, totalAmount: Number(r.total_amount) || 0,
  convertedOrderId: r.converted_order_id || null, rejectedReason: r.rejected_reason || null,
  handledBy: r.handled_by || null, handledAt: r.handled_at || null, createdAt: r.created_at,
  // 4단계-B
  source: r.source || "public", token: r.token || null, expiresAt: r.expires_at || null, confirmedAt: r.confirmed_at || null,
  useLastAddress: !!r.use_last_address, wantsMerge: !!r.wants_merge, createdBy: r.created_by || "",
  items: Array.isArray(r.items) ? r.items : null,
});

/** 셀러 링크 토큰 — randomUUID 둘을 이어 '-' 를 뺀 64자 hex(지시서 3-1). https/localhost 가 아니면 Math.random 으로 대체. */
export function makeLinkToken() {
  const rnd = () => (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, "")
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return rnd() + rnd();
}

/**
 * 셀러 링크 초안 — ERP 직접입력 폼의 내용을 'offered' 로 저장하고 토큰을 돌려준다. orders 에는 아무것도 안 쓴다.
 * items: [{ productId, code, name, color, qty, unit, unitPrice, amount }] — 첫 품목이 product_id·qty 에도 들어간다.
 */
export async function createSellerLinkDraft({ items, customerName, phone, customerId = null, address = "", addressDetail = "", deliveryMessage = "",
  mergeWithOrderId = null, useFreeShipping = false, shippingFee = 0, totalAmount = 0, createdBy = "" }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const list = Array.isArray(items) ? items : [];
  if (!list.length || !list[0].productId) throw new Error("품번이 있는 품목이 1개 이상 필요합니다");
  const first = list[0];
  const token = makeLinkToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from("link_order_drafts").insert({
    user_id: userId, status: "offered", source: "seller", token, expires_at: expiresAt, created_by: createdBy || null,
    product_id: first.productId, product_code: first.code || "", product_name: `${first.name || ""}${first.color ? ` ${first.color}` : ""}`.trim(),
    unit_price: first.unitPrice > 0 ? first.unitPrice : null, qty: Number(first.qty) || 0, unit: first.unit || "마", items: list,
    phone: String(phone || "").replace(/\D/g, ""), customer_name: String(customerName || "").trim(), customer_id: customerId || null,
    address: address || "", address_detail: addressDetail || "", delivery_message: deliveryMessage || "",
    merge_with_order_id: mergeWithOrderId || null, use_free_shipping: !!useFreeShipping,
    shipping_fee: Math.round(Number(shippingFee) || 0), total_amount: Math.round(Number(totalAmount) || 0),
  }).select("*").single();
  if (error) throw error;
  return toDraftCamel(data);
}

/** 초안 목록. 기본은 아직 처리 안 된 것(offered·new)만, 오래된 것부터. status 는 문자열 또는 배열. 테이블이 없으면(마이그레이션 전) 에러 — 호출부가 삼킨다. */
export async function fetchLinkDrafts({ status = ["offered", "new"], limit = 200 } = {}) {
  const userId = await getUserId();
  if (!userId) return [];
  let q = supabase.from("link_order_drafts").select("*").eq("user_id", userId).order("created_at", { ascending: true }).limit(limit);
  if (Array.isArray(status)) q = q.in("status", status);
  else if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(toDraftCamel);
}

/** 거절 — 사유 필수. 이미 처리된 초안은 안 건드린다(status=new 조건). */
export async function rejectLinkDraft(id, reason, by) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const why = String(reason || "").trim();
  if (!why) throw new Error("거절 사유를 적어 주세요");
  const { data, error } = await supabase.from("link_order_drafts")
    .update({ status: "rejected", rejected_reason: why, handled_by: by || null, handled_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId).eq("status", "new").select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("이미 처리된 초안이거나 찾을 수 없습니다");
}

/**
 * 초안 삭제 — 고객 확인을 기다리는(offered) 셀러 링크를 거둔다: 잘못 만든 링크, 만료된 링크, 시험용.
 * 지우면 그 링크는 "주문서를 찾을 수 없습니다"가 된다. 고객이 이미 확인한 초안(new)은 거절로 처리한다(사유가 남는다).
 */
export async function deleteLinkDraft(id) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("link_order_drafts")
    .delete().eq("id", id).eq("user_id", userId).in("status", ["offered", "expired"]).select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("이미 처리된 초안이거나 찾을 수 없습니다");
}

/** 주문으로 전환됨 — 기존 등록 경로로 주문이 만들어진 뒤 부른다. */
export async function markDraftConverted(id, orderId, by) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const { data, error } = await supabase.from("link_order_drafts")
    .update({ status: "converted", converted_order_id: orderId ? String(orderId) : null, handled_by: by || null, handled_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId).eq("status", "new").select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("이미 처리된 초안이거나 찾을 수 없습니다");
}

/**
 * 포장 기록만 지운다 — 롤 잔량은 건드리지 않는다. 주문을 지우거나 환불로 끝낼 때 "원단은 되돌리지 않고
 * 기록만 정리"를 고른 경우(lib/packingGuard.js). itemIds 를 주면 그 품목만.
 */
export async function deleteItemPacking(orderId, itemIds = null) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  let q = supabase.from("order_item_packing").delete().eq("user_id", userId).eq("order_id", String(orderId));
  if (itemIds && itemIds.length) q = q.in("item_id", itemIds.map(String));
  const { error } = await q;
  if (error) throw error;
}

/**
 * 재단한 뒤의 포장 취소 — 기록을 지우고 잘려 나간 길이만큼 조각 롤을 만든다(바로 판매 가능, 라벨 자동 요청).
 * 원래 롤의 잔량은 그대로다 — 이미 잘렸다. 롤 통째로 나갔던 품목이면 조각이 아니라 원래 롤이 되살아난다.
 * 돌려주는 값: 생기거나 되살아난 롤. 롤 없이 포장한 기록이었으면 null.
 * 아직 안 자른 것(잘못 찍음)은 unpackItem 을 쓴다 — 원래 롤에 길이를 되돌린다.
 */
export async function unpackItemAsPiece(orderId, itemId, reason, by) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const why = String(reason || "").trim();
  if (!why) throw new Error("사유를 적어 주세요");
  const { data, error } = await supabase.rpc("unpack_item_cut", {
    p_order_id: String(orderId), p_item_id: String(itemId), p_note: why, p_by: by || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row && row.id ? rollFromRow(row) : null;
}

/**
 * 반품입고 — 돌아온 품목 하나를 롤 재고에 다시 넣는다.
 *   · 롤 통째로 나갔던 품목 → 원래 롤을 되살린다(잔량 되돌림). 이미 재고에 있는 롤이면 건너뛴다.
 *   · 잘라 나갔던 품목      → 돌아온 길이만큼 조각 롤을 만든다(바로 판매 가능, 라벨 자동 요청).
 *   · 품번을 모르는 품목    → 건너뛴다(어느 원단의 조각인지 장부가 모른다).
 * item: 반품 건에 적힌 품목(주문 품목의 itemId·productId·itemNo·unit 을 그대로 갖고 있다), qty: 돌아온 수량.
 * 반환 { kind: "revived" | "piece" | "skipped", roll?, why? }
 */
export async function restockReturnedItem({ orderId, item, qty, products = [], note = "", by = "" }) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const oid = orderId ? String(orderId) : null;
  // 포장 기록 — 어느 롤에서 얼마를 잘랐는가. 스캔 없이 나간 품목은 기록이 없다.
  let rec = null, src = null;
  if (oid && item?.itemId) {
    const p = await supabase.from("order_item_packing").select("*")
      .eq("user_id", userId).eq("order_id", oid).eq("item_id", String(item.itemId)).maybeSingle();
    if (p.error && !["42P01", "PGRST205"].includes(p.error.code)) throw p.error;
    rec = p.data || null;
    if (rec?.roll_id) {
      const r = await supabase.from("stock_rolls").select("*").eq("id", rec.roll_id).eq("user_id", userId).maybeSingle();
      if (r.error) throw r.error;
      src = r.data || null;
    }
  }
  if (rec?.whole_roll && src) {
    if (src.status !== "sold") return { kind: "skipped", why: `${src.roll_code} 은 이미 재고에 있습니다` };
    const roll = await applyMovement(src.id, "adjust", Number(rec.length), { note: note || "반품입고", by, orderId: oid, itemId: String(item.itemId) });
    return { kind: "revived", roll };
  }
  const code = String(item?.itemNo || "").trim().toUpperCase();
  const productId = src?.product_id || item?.productId
    || (code ? (products.find(p => String(p.code || "").toUpperCase() === code)?.id || null) : null);
  if (!productId) return { kind: "skipped", why: "품번이 연결되지 않은 품목" };
  if (isRollUnit(item?.unit)) return { kind: "skipped", why: "롤 단위인데 길이 기록이 없습니다 — 입고·검단에서 직접 넣어 주세요" };
  // 전량 반품이고 포장 기록에 실제 자른 길이가 있으면 그 길이로 — 주문 3마를 3.5마로 잘라 보냈으면
  // 돌아온 것도 3.5마다. 주문 수량으로 넣으면 넉넉히 자른 만큼 장부에서 사라진다(2026-10-13 점검).
  // 일부만 돌아왔으면(반품 수량 < 주문 수량) 돌아온 수량 그대로.
  const ordered = Number(item?.qty) || 0;
  const fullReturn = ordered > 0 && Number(qty) >= ordered;
  const cutLen = Number(rec?.length);
  const len = fullReturn && cutLen > 0 ? cutLen : Number(qty);
  if (!(len > 0)) return { kind: "skipped", why: "반품 수량이 없습니다" };
  const { data, error } = await supabase.rpc("roll_add_piece", {
    p_product_id: productId, p_length: len, p_origin: "return", p_origin_roll_id: src?.id || null,
    p_order_id: oid, p_item_id: item?.itemId ? String(item.itemId) : null, p_note: note || "반품입고", p_by: by || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.id) throw new Error("조각 롤이 만들어지지 않았습니다");
  return { kind: "piece", roll: rollFromRow(row) };
}

export async function unpackItem(orderId, itemId, by) {
  const userId = await getUserId();
  if (!userId) throw authLost();
  const { error } = await supabase.rpc("unpack_item", {
    p_order_id: String(orderId), p_item_id: String(itemId), p_by: by || null,
  });
  if (error) throw error;
}

// ── 새 SaaS UI(src/saas) 전용 읽기 — 2026-10-19 추가. 기존 함수는 손대지 않는다(지시서 4절). ──
// 홈·정산의 "이번 달 매출"은 입금 로그 기준이다. 기존 fetchPaymentLogs() 는 전체(수천 건)를 받아오므로
// 기간을 잘라 필요한 칸만 읽는 함수를 따로 둔다. 1000건 페이지네이션은 같은 이유로 유지한다.
export async function fetchPaymentLogsBetween(startIso, endIso) {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    let q = supabase.from("payment_logs").select("id, order_id, customer, type, amount, note, created_at").eq("user_id", userId);
    if (startIso) q = q.gte("created_at", startIso);
    if (endIso) q = q.lt("created_at", endIso);
    const { data, error } = await q.order("created_at", { ascending: false }).range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all;
}

// 최근 출고완료 주문 — shipped_at 이 sinceIso 이후인 것만. 홈의 "이번 주 출고 차트"와 재고의 "이번 달 판매"가 쓴다.
// 기존 fetchShippedOrders() 는 출고완료 전부(수천 건, 품목 포함)를 받아와 이 두 칸에는 과하다.
export async function fetchShippedOrdersSince(sinceIso) {
  const userId = await getUserId();
  if (!userId) return [];
  const PAGE = 1000;
  const all = [];
  let cursor = 0;
  while (true) {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "출고완료")
      .gte("shipped_at", sinceIso)
      .order("shipped_at", { ascending: false })
      .range(cursor, cursor + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    cursor += PAGE;
  }
  return all.map(toCamel);
}

// ══════════════════════════════════════════════════════════════
// 구독형 SaaS — 회사 계정·담당자 PIN (migrations/saas_company_accounts.sql). 새 UI(src/saas)만 쓴다. 추가만.
// ══════════════════════════════════════════════════════════════

// 회사 계정 한 줄. 표가 없거나(마이그레이션 전) 행이 없으면(사내 계정) null — 둘 다 "구독 제한 없음"으로 다룬다.
export async function fetchCompanyAccount() {
  const userId = await getUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("company_accounts")
    .select("owner_id, login_id, name, contact, plan, status, trial_end, current_period_end, max_managers, created_at, is_demo")
    .eq("owner_id", userId)
    .maybeSingle();
  if (error) { console.warn("[company_accounts] 조회 실패(마이그레이션 전?):", error.message); return null; }
  return data || null;
}

// 회사명·연락처만 — 요금제·기간은 DB 트리거가 막는다(서버 전용).
export async function updateCompanyAccount({ name, contact }) {
  const userId = await getUserId();
  if (!userId) throw new Error("로그인이 필요합니다");
  const row = {};
  if (name !== undefined) row.name = String(name || "").trim();
  if (contact !== undefined) row.contact = String(contact || "").trim();
  if (!Object.keys(row).length) return;
  const { error } = await supabase.from("company_accounts").update(row).eq("owner_id", userId);
  if (error) throw error;
}

// 결제·연장 이력(읽기만). 서버가 쓴다.
export async function fetchSubscriptionEvents() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase
    .from("subscription_events")
    .select("id, kind, amount, plan, period_start, period_end, memo, created_at")
    .eq("owner_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return [];
  return data || [];
}

// ── 담당자 토큰 — PIN 통과 시 서버가 준 토큰을 모든 요청의 x-manager-token 헤더로 보낸다 ──
// DB 쪽(migrations/saas_manager_sessions.sql)이 이 헤더로 "지금 작업하는 담당자"를 알고, 관리자 전용 작업을 정책·트리거로 막는다.
// 기기별 localStorage 에 두고(erp_manager_token), 담당자를 바꾸거나 로그아웃하면 지운다.
export const MANAGER_TOKEN_KEY = "erp_manager_token";
const MANAGER_HEADER = "x-manager-token";
function applyManagerHeader(token) {
  const h = supabase?.rest?.headers;
  if (!h || typeof h.set !== "function") return;
  if (token) h.set(MANAGER_HEADER, token); else h.delete(MANAGER_HEADER);
}
export function setManagerToken(token) {
  try { if (token) localStorage.setItem(MANAGER_TOKEN_KEY, token); else localStorage.removeItem(MANAGER_TOKEN_KEY); } catch { /* 저장소 불가 */ }
  applyManagerHeader(token);
}
export function getManagerToken() { try { return localStorage.getItem(MANAGER_TOKEN_KEY) || ""; } catch { return ""; } }
// 모듈이 로드될 때 기기에 남은 토큰을 바로 헤더에 싣는다 — 옛 화면(/legacy)도 같은 토큰으로 관리자 작업을 한다.
try { applyManagerHeader(getManagerToken()); } catch { /* 서버 환경 */ }
// 서버 쪽 세션도 지운다(로그아웃·담당자 바꾸기). 실패해도 로컬 토큰은 지운다.
export async function revokeManagerToken() {
  const had = getManagerToken();
  if (had) { try { await supabase.rpc("revoke_manager_token"); } catch (e) { console.warn("[manager-token] 폐기 실패(무시)", e?.message); } }
  setManagerToken("");
}

// 담당자별 PIN 상태 — [{manager_id, has_pin, locked_until}]. 해시는 절대 내려오지 않는다.
// RPC 가 없으면(마이그레이션 전) 빈 배열 → 화면은 "PIN 없음"으로 보고 묻지 않는다.
export async function fetchManagerPinStatus() {
  const userId = await getUserId();
  if (!userId) return [];
  const { data, error } = await supabase.rpc("manager_pin_status");
  if (error) { console.warn("[manager_pins] 상태 조회 실패(마이그레이션 전?):", error.message); return []; }
  return Array.isArray(data) ? data : [];
}

// PIN 검증 — { ok, no_pin?, locked_until?, attempts_left?, error? }. 잠금·횟수는 DB 가 센다.
export async function verifyManagerPin(managerId, pin) {
  const { data, error } = await supabase.rpc("verify_manager_pin", { p_manager_id: managerId, p_pin: String(pin || "") });
  if (error) throw error;
  return data || { ok: false, error: "응답 없음" };
}

// PIN 설정/변경 — 처음이면 증명 없이, 있으면 본인 현재 PIN 또는 관리자 PIN 으로(by*). { ok, error? }
export async function setManagerPin(managerId, pin, byManagerId = null, byPin = null) {
  const { data, error } = await supabase.rpc("set_manager_pin", {
    p_manager_id: managerId, p_pin: String(pin || ""),
    p_by_manager_id: byManagerId ?? null, p_by_pin: byPin == null ? null : String(byPin),
  });
  if (error) throw error;
  return data || { ok: false, error: "응답 없음" };
}

// 새 UI 의 회사 설정(settings.data.saas) — 옛 화면의 설정(kakao·sender…)과 한 jsonb 를 나눠 쓰므로
// 저장 직전에 다시 읽어 합친다. 다른 키는 건드리지 않는다.
export async function saveSaasSettings(patch) {
  const current = (await fetchSettings()) || {};
  const next = { ...current, saas: { ...(current.saas || {}), ...patch } };
  await saveSettings(next);
  return next;
}

// ── 채널 주문 가져오기(새 UI, saas_features.sql) ────────────────────────
/** 이미 들어온 채널 주문번호 — 같은 판매처·같은 번호는 건너뛴다. 반환 Set(channel_order_id). 칸이 없는 DB 에서는 빈 Set. */
export async function fetchChannelOrderIds(salesChannel, channelOrderIds) {
  const userId = await getUserId();
  if (!userId) return new Set();
  const ids = [...new Set((channelOrderIds || []).map(String).filter(Boolean))];
  if (!ids.length) return new Set();
  const out = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from("orders").select("channel_order_id")
      .eq("user_id", userId).eq("sales_channel", salesChannel).in("channel_order_id", ids.slice(i, i + 200));
    if (error) { if (missingColumnOf(error)) return out; throw error; }
    for (const r of data || []) if (r.channel_order_id) out.add(String(r.channel_order_id));
  }
  return out;
}

// ── 이번 달 AI 호출·문자 건수(새 UI 설정·AI 게이트 안내용, 2026-10-23) ──────────────
// 서버(service role)만 올리고, 브라우저는 자기 회사 행을 읽기만 한다(RLS). 표가 아직 없으면 0.
export async function fetchMonthlyUsage(now = new Date()) {
  const userId = await getUserId();
  if (!userId) return { ai: 0, sms: 0 };
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const read = async (table) => {
    try {
      const { data, error } = await supabase.from(table).select("count").eq("owner_id", userId).eq("month", month).maybeSingle();
      if (error) return 0;
      return Number(data?.count) || 0;
    } catch { return 0; }
  };
  const [ai, sms] = await Promise.all([read("saas_ai_usage"), read("saas_sms_usage")]);
  return { ai, sms };
}
