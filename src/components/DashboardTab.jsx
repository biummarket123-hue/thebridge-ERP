import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx-js-style";
import ExcelJS from "exceljs";
import { SF, S, baseInp, useTheme, sC, pC, getPayStatus, isHold, dlXlsx, nowT } from "../constants.js";
import { Tag, SecTitle, Card, Empty, GhostBtn, CuteLoader } from "./UI.jsx";
import { ReturnRegisterModal } from "./ReturnsTab.jsx";
import { checkOrderLock } from "../lib/managerLock.js";
import { settlePackingBefore } from "../lib/packingGuard.js";
import * as db from "../lib/db.js";

const FILTERS = [
  { key: "today", label: "오늘" },
  { key: "week", label: "이번주" },
  { key: "month", label: "이번달" },
  { key: "all", label: "전체" },
];

const SHIP_FILTERS = ["", "대기", "보관", "포장완료", "출고완료"];
const PAY_FILTERS = ["", "미입금", "부분입금", "입금완료", "부분환불", "환불완료", "환불신청"];
const RECEIPT_FILTERS = [
  { v: "", l: "전체" },
  { v: "cash", l: "🧾 현금영수증" },
  { v: "business", l: "📋 지출증빙" },
  { v: "tax_invoice", l: "📄 세금계산서" },
  { v: "none", l: "발행 안 함" },
];
// 영수증 종류별 이모지+라벨 (대시보드 칩 표기 공용)
const RECEIPT_LABELS = { cash: "🧾 현금영수증", business: "📋 지출증빙", tax_invoice: "📄 세금계산서" };

function toISO(d) {
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

function getDateRange(filterKey) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (filterKey) {
    case "today":
      return { from: toISO(today), to: toISO(today) };
    case "week": {
      const day = today.getDay();
      const mon = new Date(today);
      mon.setDate(mon.getDate() - (day === 0 ? 6 : day - 1));
      return { from: toISO(mon), to: toISO(today) };
    }
    case "month":
      return { from: toISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: toISO(today) };
    default:
      return { from: null, to: null };
  }
}

function getOrderAmount(order) {
  if (order.totalAmount > 0) return order.totalAmount;
  return (order.items || []).reduce((sum, item) => sum + (item.amount || 0), 0);
}

// "2026. 04. 16.", "2026-04-16", "2026. 4. 16." 등 다양한 형식 → Date
function parseOrderDate(s) {
  if (!s) return null;
  const cleaned = String(s).trim().replace(/\s/g, "").replace(/\./g, "-").replace(/-+$/, "");
  const m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d);
}


// 출고상태(출고완료/포장완료/보관/대기)
// 보관은 status와 독립 토글이라 '포장완료 + 보관'이 동시에 성립한다 → 출고 관점에선 나가지 않는 보관이 우선.
// (구주문의 status="보관"도 isHold가 함께 인정)
function getShipStatus(o) {
  if (o.status === "출고완료") return "출고완료";
  if (isHold(o)) return "보관";
  if (o.status === "포장완료") return "포장완료";
  return "대기";
}

// 출고일 표기 — shipped_at(UTC 타임스탬프) → 로컬 날짜 문자열. 없거나 파싱 실패 시 null
function fmtShippedDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return toISO(d);
}

// 입금일 — payment_logs에서 type="입금" 첫 로그의 created_at, 없으면 null
function getPaymentDate(o, logsByOrder) {
  const logs = logsByOrder?.[o.id] || [];
  const depositLog = logs.find(l => l.type === "입금");
  if (depositLog?.created_at) {
    const d = new Date(depositLog.created_at);
    if (!isNaN(d)) return d;
  }
  return null;
}

// localStorage 1회 마이그레이션 — 통합 뷰 첫 진입 시 기존 필터 잔존값 모두 초기화
const FILTER_MIGRATION_KEY = "dashboard_unified_view_v1_reset";
function ensureFilterMigration() {
  if (typeof window === "undefined") return;
  if (localStorage.getItem(FILTER_MIGRATION_KEY)) return;
  ["dashboard_dateFilter","dashboard_shipFilter","dashboard_payFilter","dashboard_search","dashboard_customFrom","dashboard_customTo"]
    .forEach(k => localStorage.removeItem(k));
  localStorage.setItem(FILTER_MIGRATION_KEY, "1");
}

export default function DashboardTab({ orders, customers, setOrders, showToast, credits, setCredits, inv, reloadOrders, managers = [], isAdmin = false, activeManager = "", onRefundRequest, onUndoShipOut }) {
  const T = useTheme();
  const [returnModalOrder, setReturnModalOrder] = useState(null); // ↩️ 반품 신청 모달 대상 주문

  // 영수증 발급 여부 토글 — 칩 클릭 시 receiptIssued 반전(낙관적 갱신 + DB 저장).
  // 대시보드는 orders prop이 아니라 allOrders 상태로 렌더 → allOrders를 직접 갱신해야 즉시 반영됨.
  // (setOrders를 쓰면 화면 미반영 + orders 변경이 loadData 재조회를 유발해 DB 쓰기와 레이스 → "두 번 클릭" 버그)
  const toggleReceiptIssued = async (e, o) => {
    e.stopPropagation();
    const next = !o.receiptIssued;
    setAllOrders(p => p.map(x => x.id === o.id ? { ...x, receiptIssued: next } : x));
    try {
      await db.updateOrder(o.id, { receiptIssued: next });
      showToast?.(next ? `발급 표시 — ${RECEIPT_LABELS[o.receiptType] || "영수증"}` : "발급 표시 해제");
    } catch (err) {
      setAllOrders(p => p.map(x => x.id === o.id ? { ...x, receiptIssued: !next } : x));
      showToast?.("저장 실패: " + err.message, "error");
    }
  };

  // 영수증 종류 지정/변경 — 출고완료된 주문도 취소·재출고 없이 대시보드에서 바로 바꾼다.
  // 종류를 없앨 때는 발급 표시도 함께 해제. 낙관적 갱신 + 실패 시 원복 (toggleReceiptIssued와 동일 패턴).
  const setReceiptType = async (e, o, type) => {
    e.stopPropagation();
    if ((o.receiptType || null) === (type || null)) return;
    const prev = { receiptType: o.receiptType || null, receiptIssued: !!o.receiptIssued };
    const patch = type ? { receiptType: type } : { receiptType: null, receiptIssued: false };
    setAllOrders(p => p.map(x => x.id === o.id ? { ...x, ...patch } : x));
    try {
      await db.updateOrder(o.id, patch);
      showToast?.(type ? `영수증 종류 변경 — ${RECEIPT_LABELS[type]}` : "영수증 발행 안 함으로 변경");
    } catch (err) {
      setAllOrders(p => p.map(x => x.id === o.id ? { ...x, ...prev } : x));
      showToast?.("저장 실패: " + err.message, "error");
    }
  };

  // 영수증 칩 — 배경 통일(greenBg), 발급 시 초록 테두리+✓. 클릭으로 발급 토글.
  const receiptChip = (o, compact = false) => {
    if (!o.receiptType) return null;
    const issued = !!o.receiptIssued;
    return (
      <span onClick={(e) => toggleReceiptIssued(e, o)}
        title={issued ? "발급 완료 — 클릭하면 해제" : "클릭하면 발급 표시"}
        style={{
          fontSize: compact ? 9 : 10, fontWeight: 700,
          color: issued ? T.green : T.cream,
          background: T.greenBg,
          padding: compact ? "1px 5px" : "2px 8px",
          borderRadius: compact ? 4 : 5,
          border: issued ? `2px solid ${T.green}` : `1px solid ${T.border}`,
          cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap",
        }}>
        {issued ? "✓ " : ""}{RECEIPT_LABELS[o.receiptType] || ""}
      </span>
    );
  };

  const [dateFilter, setDateFilter] = useState("today"); // 기본값 오늘 — 전체는 목록이 커서 첫 진입이 무거움
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [search, setSearch] = useState("");
  const [shipFilter, setShipFilter] = useState("");
  const [payFilter, setPayFilter] = useState("");
  const [receiptFilter, setReceiptFilter] = useState("");
  const [managerFilter, setManagerFilter] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [shipDateId, setShipDateId] = useState(null); // 출고완료 태그 클릭 시 출고일을 보여줄 주문 id
  const [allOrders, setAllOrders] = useState([]);

  // 담당자 필터 표시 순서 (고정) — 목록에 없는 담당자는 뒤에 원본 순서대로 붙음
  const MANAGER_ORDER = ["고문님", "실장님", "옥정점", "장향숙", "송미송", "손희우", "방문고객", "마켓24"];
  const sortedManagers = useMemo(() => {
    const rank = new Map(MANAGER_ORDER.map((n, i) => [n, i]));
    return managers.slice().sort((a, b) => {
      const ra = rank.has(a.name) ? rank.get(a.name) : MANAGER_ORDER.length;
      const rb = rank.has(b.name) ? rank.get(b.name) : MANAGER_ORDER.length;
      if (ra !== rb) return ra - rb;
      return 0;
    });
  }, [managers]);
  const [loading, setLoading] = useState(false);
  const [logsByOrderType, setLogsByOrderType] = useState({});
  const [logsByOrder, setLogsByOrder] = useState({});
  const [returnsByOrder, setReturnsByOrder] = useState({}); // 주문별 반품/교환 기록 — 상세보기 표시용

  // 마지막으로 전체 조회를 시작한 시각.
  //
  // 이 화면은 주문 목록(orders)이 바뀔 때마다 자기 전체 조회를 다시 돈다 — 주문 전체
  // (엑셀 업로드분 포함) + 결제로그 전체 + 반품 전체. 그런데 주문 1건을 등록하면
  // 목록 갱신이 여러 번 터지므로 그때마다 이걸 다 다시 읽었다. 대시보드를 켜둔 채
  // 일하면 읽는 양이 그대로 두 배가 됐다.
  //
  // 창 포커스마다 전체를 다시 읽던 걸 30초로 막아둔 자리(ErpApp.jsx)와 같은 방식으로
  // 텀을 둔다. 탭을 새로 열면 컴포넌트가 다시 만들어지므로 그때는 항상 읽는다.
  const lastLoadRef = useRef(0);
  const RELOAD_GAP_MS = 15000;

  useEffect(() => { ensureFilterMigration(); }, []);

  const loadData = useCallback(async () => {
    lastLoadRef.current = Date.now();
    setLoading(true);
    try {
      const [all, allLogs, allReturns] = await Promise.all([
        db.fetchAllOrders(),
        db.fetchPaymentLogs(),
        db.fetchReturns().catch(() => []), // 반품 테이블 미생성 환경에서도 대시보드는 동작
      ]);
      const retMap = {};
      for (const r of allReturns) { if (r.orderId) (retMap[r.orderId] = retMap[r.orderId] || []).push(r); }
      setReturnsByOrder(retMap);
      const byOrder = {};
      for (const l of allLogs) {
        const oid = l.order_id;
        if (!oid) continue;
        if (!byOrder[oid]) byOrder[oid] = [];
        byOrder[oid].push(l);
      }
      // payment_logs는 created_at desc 순으로 옴 — 입금일 계산 위해 asc로 뒤집기
      for (const oid in byOrder) {
        byOrder[oid] = byOrder[oid].slice().sort((a,b) => {
          const da = a.created_at ? new Date(a.created_at).getTime() : 0;
          const db_ = b.created_at ? new Date(b.created_at).getTime() : 0;
          return da - db_;
        });
      }
      const withComputed = all.map(o => {
        const total = getOrderAmount(o);
        const logs = byOrder[o.id] || [];
        return { ...o, _computed: db.calcOrderMoney(logs, total, o.payment) };
      });
      setAllOrders(withComputed);
      setLogsByOrder(byOrder);
      const byOrderType = {};
      for (const oid in byOrder) {
        byOrderType[oid] = {};
        for (const l of byOrder[oid]) {
          byOrderType[oid][l.type] = (byOrderType[oid][l.type]||0) + (l.amount||0);
        }
      }
      setLogsByOrderType(byOrderType);
    } catch (e) {
      console.error("대시보드 조회 실패:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // 담당자 락은 orders 프롭이 아니라 allOrders 로 판정한다.
  // 이 화면이 다루는 건 대개 출고완료 주문인데, 락에는 "같은 합배송 그룹에 내 주문이
  // 있으면 허용"이라는 예외가 있다. 그룹은 같은 날 같이 나가므로 그룹원도 출고완료다 —
  // 활성 주문만 담은 orders 로 훑으면 그룹이 안 보여서 원래 열리던 것이 잠긴다.
  // allOrders 는 이 화면이 직접 읽은 전체 목록이라 그럴 일이 없다.

  useEffect(() => {
    const wait = RELOAD_GAP_MS - (Date.now() - lastLoadRef.current);
    if (wait <= 0) { loadData(); return; }
    // 텀 안에 들어온 변경은 버리지 않고 텀이 끝날 때 한 번 읽는다.
    // 그냥 건너뛰면, 아침 피크처럼 여러 사람이 15초보다 촘촘히 작업할 때 마지막 변경이
    // 화면에 영영 안 들어온다 — 사람이 새로고침을 눌러야 하는 상태가 되는데
    // 이 화면에는 새로고침 버튼이 없다. 그 사이 또 바뀌면 예약이 뒤로 밀려 한 번으로 접힌다.
    const timer = setTimeout(() => loadData(), wait);
    return () => clearTimeout(timer);
  }, [loadData, orders]);

  const creditMap = useMemo(() => {
    const map = {};
    for (const c of credits) {
      if (!map[c.customer]) map[c.customer] = 0;
      map[c.customer] += c.type === "적립" ? c.amount : -c.amount;
    }
    return map;
  }, [credits]);

  // 날짜 비교용 — order.date 기준
  const getFilterDate = useCallback((o) => parseOrderDate(o.date), []);

  // 메인 필터링 — 모든 주문 통합 뷰 (베이스 제한 없음)
  const customerMap = useMemo(() => {
    const m = {};
    for (const c of customers) m[c.name] = c;
    return m;
  }, [customers]);

  const filtered = useMemo(() => {
    let list = allOrders;

    // 날짜 필터
    if (dateFilter !== "all") {
      let range;
      if (dateFilter === "custom") {
        range = { from: customFrom || null, to: customTo || null };
      } else {
        range = getDateRange(dateFilter);
      }
      const fromD = range.from ? new Date(range.from + "T00:00:00") : null;
      const toD = range.to ? new Date(range.to + "T23:59:59") : null;
      if (fromD || toD) {
        list = list.filter(o => {
          const od = getFilterDate(o);
          if (!od) return false;
          if (fromD && od < fromD) return false;
          if (toD && od > toD) return false;
          return true;
        });
      }
    }

    // 출고상태 필터
    if (shipFilter) list = list.filter(o => getShipStatus(o) === shipFilter);

    // 입금상태 필터
    if (payFilter) list = list.filter(o => getPayStatus(o) === payFilter);

    // 영수증 종류 필터 ("none" = 미발행, 그 외 cash/business/tax_invoice)
    if (receiptFilter) {
      if (receiptFilter === "none") list = list.filter(o => !o.receiptType);
      else list = list.filter(o => o.receiptType === receiptFilter);
    }

    // 담당자 필터 ("__empty__" = 미지정, 그 외 정확 매칭)
    if (managerFilter) {
      if (managerFilter === "__empty__") list = list.filter(o => !o.manager || !String(o.manager).trim());
      else list = list.filter(o => o.manager === managerFilter);
    }

    // 검색 — 고객명 · 닉네임 · 전화번호 일부 (가운데 4자리 등, 하이픈 유무 무관)
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const qDigits = q.replace(/[^0-9]/g, "");
      list = list.filter(o => {
        if ((o.customer || "").toLowerCase().includes(q)) return true;
        const cust = customerMap[o.customer];
        if ((cust?.nickname || "").toLowerCase().includes(q)) return true;
        // 전화번호는 주문 스냅샷(o.phone) 우선, 없으면 고객 정보.
        // 1자리 숫자는 거의 전부 일치해 무의미하므로 2자리부터 번호 검색으로 취급.
        if (qDigits.length >= 2 && qDigits === q.replace(/[\s-]/g, "")) {
          const phoneDigits = String(o.phone || cust?.phone || "").replace(/[^0-9]/g, "");
          if (phoneDigits.includes(qDigits)) return true;
        }
        return false;
      });
    }

    return list;
  }, [allOrders, dateFilter, customFrom, customTo, shipFilter, payFilter, receiptFilter, managerFilter, search, getFilterDate, customerMap]);

  // stat cards
  const getReceivedAmount = (o) => {
    if (o._computed?.depositAmount !== undefined) return o._computed.depositAmount;
    const raw = o._computed?.rawDepositAmount ?? o.depositAmount ?? 0;
    const refund = o._computed?.refundAmount ?? o.refundAmount ?? 0;
    return Math.max(0, raw - refund);
  };
  const getNetAmount = (o) => {
    const total = getOrderAmount(o);
    const refund = o._computed?.refundAmount ?? o.refundAmount ?? 0;
    return total - refund;
  };
  const filteredTotal = filtered.reduce((s, o) => s + getReceivedAmount(o), 0);
  const filteredCount = filtered.length;
  const unpaidFiltered = filtered.filter(o => {
    const ps = getPayStatus(o);
    return ps === "미입금" || ps === "부분입금";
  });
  const unpaidTotal = unpaidFiltered.reduce((s, o) => s + Math.max(0, getOrderAmount(o) - getReceivedAmount(o)), 0);
  const avgPerOrder = filteredCount > 0 ? Math.round(filteredTotal / filteredCount) : 0;

  // 정렬: order.date 내림차순 (최신순). 단, 미래 날짜(today 초과)는 후순위로 강등.
  // 동률 시 created_at(DB 등록 시각) 내림차순으로 안정화.
  const sorted = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return filtered.slice().sort((a, b) => {
      const da = getFilterDate(a);
      const db_ = getFilterDate(b);
      const aFuture = da && da > today ? 1 : 0;
      const bFuture = db_ && db_ > today ? 1 : 0;
      if (aFuture !== bFuture) return aFuture - bFuture; // 미래는 뒤로
      // 둘 다 정상이면 date 내림차순
      if (da && db_ && da.getTime() !== db_.getTime()) return db_ - da;
      if (!da && db_) return 1;
      if (da && !db_) return -1;
      // date 동률 또는 둘 다 없음 → created_at 내림차순
      const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return cb - ca;
    });
  }, [filtered, getFilterDate]);

  // 페이지네이션
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const pageItems = sorted.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => { setPage(1); }, [dateFilter, customFrom, customTo, search, shipFilter, payFilter, receiptFilter, managerFilter, pageSize]);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  // ── 마켓원장 다운로드 ── (exceljs 기반, 표준 양식 100% 재현 — 원장DB 시트)
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const exportMarketLedger = async () => {
    setLedgerLoading(true);
    try {
      // 정렬: 주문일 ASC → created_at ASC (등록순)
      const target = sorted.slice().sort((a, b) => {
        const da = parseOrderDate(a.date);
        const db_ = parseOrderDate(b.date);
        const at = da ? da.getTime() : 0;
        const bt = db_ ? db_.getTime() : 0;
        if (at !== bt) return at - bt;
        const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return ca - cb;
      });
      if (target.length === 0) { showToast?.("내보낼 주문이 없습니다", "error"); return; }

      // 가운데 4자리 (예: 010-1234-5678 → 1234)
      const mid4 = (ph) => {
        const d = (ph || "").replace(/[^0-9]/g, "");
        if (d.length >= 7) return parseInt(d.slice(3, 7), 10);
        return d ? parseInt(d, 10) : null;
      };

      // 환불 합계 + 마지막 환불일
      const refundsFor = (oid) => {
        const r = { cash: 0, credit: 0, lastDate: null };
        const logs = logsByOrder[oid] || [];
        for (const l of logs) {
          if (l.type === "현금환불") r.cash += l.amount || 0;
          else if (l.type === "적립금전환") r.credit += l.amount || 0;
          else continue;
          if (l.created_at) {
            const d = new Date(l.created_at);
            if (!r.lastDate || d > r.lastDate) r.lastDate = d;
          }
        }
        return r;
      };

      // 마지막 입금일
      const lastDepositDate = (oid) => {
        const logs = (logsByOrder[oid] || []).filter(l => l.type === "입금");
        if (!logs.length) return null;
        const last = logs[logs.length - 1];
        return last.created_at ? new Date(last.created_at) : null;
      };

      // 타임존 보정: 로컬 Date(또는 UTC ISO Date)의 Y/M/D만 추출해서
      // UTC 기반 자정 Date를 만든다. exceljs는 Date를 UTC 기준 시리얼로
      // 변환하므로, 그렇게 안 하면 KST 자정이 UTC 전일 15:00이 되어
      // Excel에서 하루 일찍 표시되는 버그가 생김.
      const toExcelDateOnly = (d) => {
        if (!d || isNaN(d)) return null;
        return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      };

      // ── 합계 미리 계산 (Row 2 하드코딩용) ──
      // sumD: depositAmount는 이미 환불 차감된 net 값 → 추가 차감 X
      // sumN/sumP: 전체 items.amount 합 기반. 환불 행에서 -refund 처리 (의도)
      // sumQ: 총환불액 (현금 + 적립금)
      let sumD = 0, sumN = 0, sumO = 0, sumP = 0, sumQ = 0;
      for (const o of target) {
        const dep = o._computed?.depositAmount || 0;
        sumD += dep;
        const items = o.items || [];
        const itemsTotalAmt = items.reduce((s, x) => s + (x?.amount || 0), 0);
        if (itemsTotalAmt > 0) sumN += itemsTotalAmt;
        const sh = o.shippingFee || 0;
        if (sh > 0) sumO += sh;
        // P(운임비포함매출)는 totalAmount와 일치해야 하므로 기타비용도 포함
        const tot = itemsTotalAmt + sh + (o.otherCost || 0);
        if (tot > 0) sumP += tot;
        const r = refundsFor(o.id);
        if (r.cash > 0)   { sumN -= r.cash;   sumP -= r.cash;   sumQ += r.cash; }
        if (r.credit > 0) { sumN -= r.credit; sumP -= r.credit; sumQ += r.credit; }
      }

      // ── exceljs Workbook ──
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("원장DB");

      // 탭 색상 #F79646 (주황)
      ws.properties.tabColor = { argb: "FFF79646" };

      // 컬럼 너비 (A-W 23개) — character width 단위로 직접 지정
      // 큰 숫자(829,313,437원) 등이 ##### 없이 표시되도록 충분히 넓게
      const widths = [5, 5, 13, 14, 18, 6, 9, 6, 8, 22, 6, 7, 9, 13, 11, 14, 14, 9, 8, 7, 7, 12, 12];
      ws.columns = widths.map(w => ({ width: w }));

      // 페이지 설정 (Landscape A4, 70%, 분석 결과 여백)
      ws.pageSetup = {
        orientation: "landscape",
        paperSize: 9,
        scale: 70,
        pageOrder: "downThenOver",
        margins: {
          left: 17.01 / 72,
          right: 17.01 / 72,
          top: 11.34 / 72,
          bottom: 11.34 / 72,
          header: 22.68 / 72,
          footer: 22.68 / 72,
        },
      };

      // 베이스 폰트 (굴림체 10pt)
      const baseFont = { name: "굴림체", size: 10 };
      const baseBold = { ...baseFont, bold: true };

      // Row 1~4 행 높이 18
      [1, 2, 3, 4].forEach(r => { ws.getRow(r).height = 18; });

      // ── Row 1 ── (A1, B1 비움 / C1에 텍스트 + numFmt)
      ws.getCell("C1").value = "*매출기준 입금일 기준";
      ws.getCell("C1").font = baseFont;
      ws.getCell("C1").numFmt = "m/d/yyyy";

      // ── Row 2: 합계 영역 ── (A2, B2 비움 / C2에 라벨 / D·L·N·O·P·Q에 합계)
      ws.getCell("C2").value = "*입금일 기준 매출 ";
      ws.getCell("C2").font = baseBold;
      const skyBlue = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6D9F0" } };

      // D2 — 입금액 합계 (하드코딩)
      ws.getCell("D2").value = sumD;
      ws.getCell("D2").numFmt = "#,##0";
      ws.getCell("D2").fill = skyBlue;
      ws.getCell("D2").font = baseBold;
      ws.getCell("D2").alignment = { horizontal: "center", vertical: "middle" };

      // L2 — 마수 합계 (수식 유지)
      ws.getCell("L2").value = { formula: "SUM(L5:L9999)" };
      ws.getCell("L2").numFmt = "0";
      ws.getCell("L2").font = baseBold;
      ws.getCell("L2").alignment = { horizontal: "center", vertical: "middle" };

      // N2 — 매출 합계 (하드코딩, 오른쪽 정렬)
      ws.getCell("N2").value = sumN;
      ws.getCell("N2").numFmt = "#,##0";
      ws.getCell("N2").fill = skyBlue;
      ws.getCell("N2").font = baseBold;
      ws.getCell("N2").alignment = { horizontal: "right", vertical: "middle" };

      // O2 — 운임비 합계
      ws.getCell("O2").value = sumO;
      ws.getCell("O2").numFmt = "#,##0";
      ws.getCell("O2").fill = skyBlue;
      ws.getCell("O2").font = baseBold;
      ws.getCell("O2").alignment = { horizontal: "right", vertical: "middle" };

      // P2 — 운임비포함매출 합계
      ws.getCell("P2").value = sumP;
      ws.getCell("P2").numFmt = "#,##0";
      ws.getCell("P2").fill = skyBlue;
      ws.getCell("P2").font = baseBold;
      ws.getCell("P2").alignment = { horizontal: "right", vertical: "middle" };

      // Q2 — 환불 합계 (하드코딩, 빨강, 가운데)
      ws.getCell("Q2").value = sumQ;
      ws.getCell("Q2").numFmt = "#,##0";
      ws.getCell("Q2").fill = skyBlue;
      ws.getCell("Q2").font = { ...baseBold, color: { argb: "FFFF0000" } };
      ws.getCell("Q2").alignment = { horizontal: "center", vertical: "middle" };

      // ── Row 3: 빈 행 (하단 테두리) ──
      const grayBorder = { style: "thin", color: { argb: "FF7F7F7F" } };
      const mediumBorder = { style: "medium", color: { argb: "FF7F7F7F" } };
      for (let c = 1; c <= 21; c++) ws.getCell(3, c).border = { bottom: grayBorder };

      // ── Row 4: 컬럼 헤더 ──
      const headers = ["구분","판매처","입금일","입금액","입금자명","연락처","담당자","주문일","출고","품목","절수","마수","단가","매출","운임비","운입비포함매출","비고","현영/계산","년","월","일","입고가","입고가매출"];
      const headerBgs = ["D8D8D8","FDE9D9","D8D8D8","D8D8D8","D8D8D8","FDE9D9","FDE9D9","FDE9D9","FDE9D9","D8D8D8","D8D8D8","D8D8D8","D8D8D8","D8D8D8","D8D8D8","D8D8D8","D8D8D8","D8D8D8","FBD4B4","FBD4B4","FBD4B4","DAEEF3","DAEEF3"];
      // 열 인덱스(0-based) → 글자색 (P=15→파랑, R=17→빨강)
      const headerFontColor = { 15: "FF0070C0", 17: "FFFF0000" };
      headers.forEach((h, i) => {
        const cell = ws.getCell(4, i + 1);
        cell.value = h;
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + headerBgs[i] } };
        cell.font = { ...baseBold, color: { argb: headerFontColor[i] || "FF000000" } };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      });
      // A4:U4 테두리 (상 thin / 하 medium / 좌우 thin)
      for (let c = 1; c <= 21; c++) {
        ws.getCell(4, c).border = { top: grayBorder, bottom: mediumBorder, left: grayBorder, right: grayBorder };
      }
      // V4: 왼쪽 thin border (분석 결과 그대로)
      ws.getCell(4, 22).border = { left: grayBorder };
      // W4: 테두리 없음 (기본값)

      // ── 데이터 행 ──
      const peachFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDE9D9" } };
      const greenFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAF1DD" } };
      const skyFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDAEEF3" } };
      const blueFont = { color: { argb: "FF0070C0" } };
      const redFont = { color: { argb: "FFFF0000" } };

      const numFmtAcc = '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@';
      const numFmtMoney = '#,##0_ ;[Red]-#,##0 ';
      const numFmtMa = '0_ ;[Red]-0 ';

      // 한 데이터 행 채우기 (refund=true → 환불 행)
      // item: 이 행에 표시할 단일 상품 (없으면 null)
      // isFirstRow: 한 주문의 첫 행 여부 (입금일·입금액·운임비·비고는 첫 행에만)
      const fillRow = (rowIdx, o, item, opts = {}) => {
        const { refund = false, refundDate = null, refundAmount = 0, refundType = "", isFirstRow = true } = opts;
        const orderDate = parseOrderDate(o.date);
        const refundsAgg = refundsFor(o.id);
        const hasRefund = refundsAgg.cash > 0 || refundsAgg.credit > 0;

        const itemAmount = refund ? -refundAmount : (item?.amount || 0);
        const unitPrice = item?.unitPrice || item?.price || 0;
        // 운임비: 첫 행에만 표시 (환불행 제외)
        const shFee = (refund || !isFirstRow) ? 0 : (o.shippingFee || 0);
        // 운임비포함매출: 첫 행은 매출+운임+기타비용, 나머지 행은 매출만 (totalAmount와 일치)
        const totalWithFreight = refund
          ? -refundAmount
          : (itemAmount + (isFirstRow ? ((o.shippingFee || 0) + (o.otherCost || 0)) : 0));

        // A 구분
        if (refund || hasRefund) ws.getCell(rowIdx, 1).value = "이슈";
        // B 판매처
        ws.getCell(rowIdx, 2).value = o.salesChannel || "";
        ws.getCell(rowIdx, 2).fill = peachFill;
        // C 입금일 — 주문일(H열)과 동일한 값. 첫 행에만 (환불행 제외)
        if (orderDate && isFirstRow && !refund) {
          ws.getCell(rowIdx, 3).value = toExcelDateOnly(orderDate);
          ws.getCell(rowIdx, 3).numFmt = "m/d/yyyy";
        }
        // D 입금액 — 첫 행에만 (depositAmount는 이미 환불 차감된 net 값)
        // 환불 행: D열 비움 (이중 차감 방지)
        if (!refund && isFirstRow) {
          const dep = o._computed?.depositAmount || 0;
          if (dep > 0) {
            ws.getCell(rowIdx, 4).value = dep;
            ws.getCell(rowIdx, 4).numFmt = numFmtAcc;
          }
        } else {
          ws.getCell(rowIdx, 4).numFmt = numFmtAcc;  // 포맷만 적용, 값은 비움
        }
        // E 입금자명
        ws.getCell(rowIdx, 5).value = o.customer || "";
        // F 연락처
        const m4 = mid4(o.phone);
        if (m4 !== null) {
          ws.getCell(rowIdx, 6).value = m4;
          ws.getCell(rowIdx, 6).numFmt = "0000";
        }
        // G 담당자
        ws.getCell(rowIdx, 7).value = o.manager || "";
        // H 주문일
        if (orderDate) {
          ws.getCell(rowIdx, 8).value = toExcelDateOnly(orderDate);
          ws.getCell(rowIdx, 8).numFmt = 'm"/"d';
          ws.getCell(rowIdx, 8).font = { bold: true };
        }
        // I 출고 — shippedAt이 있으면 그 날짜, 없으면 빈칸 (기존 데이터/미출고 동일)
        if (o.shippedAt) {
          ws.getCell(rowIdx, 9).value = toExcelDateOnly(new Date(o.shippedAt));
          ws.getCell(rowIdx, 9).numFmt = 'm"/"d';
        }
        ws.getCell(rowIdx, 9).fill = greenFill;
        ws.getCell(rowIdx, 9).font = { bold: true };
        // J 품목
        ws.getCell(rowIdx, 10).value = item?.fabric || "";
        // K 절수 (데이터 모델에 없음 — 빈칸)
        // L 마수
        if (item?.qty) {
          ws.getCell(rowIdx, 12).value = item.qty;
          ws.getCell(rowIdx, 12).numFmt = numFmtMa;
        }
        // M 단가
        if (unitPrice > 0) {
          ws.getCell(rowIdx, 13).value = unitPrice;
          ws.getCell(rowIdx, 13).numFmt = numFmtMoney;
        }
        // N 매출
        if (refund) {
          ws.getCell(rowIdx, 14).value = -refundAmount;
          ws.getCell(rowIdx, 14).numFmt = numFmtMoney;
        } else if (itemAmount > 0) {
          ws.getCell(rowIdx, 14).value = itemAmount;
          ws.getCell(rowIdx, 14).numFmt = numFmtMoney;
        }
        // O 운임비
        if (refund) {
          ws.getCell(rowIdx, 15).value = 0;
          ws.getCell(rowIdx, 15).numFmt = numFmtMoney;
        } else if (shFee > 0) {
          ws.getCell(rowIdx, 15).value = shFee;
          ws.getCell(rowIdx, 15).numFmt = numFmtMoney;
        }
        // P 운임비포함매출
        if (refund) {
          ws.getCell(rowIdx, 16).value = -refundAmount;
          ws.getCell(rowIdx, 16).numFmt = numFmtMoney;
        } else if (totalWithFreight > 0) {
          ws.getCell(rowIdx, 16).value = totalWithFreight;
          ws.getCell(rowIdx, 16).numFmt = numFmtMoney;
        }
        ws.getCell(rowIdx, 16).font = blueFont;
        // Q 비고 — 환불행은 그대로, 일반행은 첫 행에만 표시
        if (refund) {
          ws.getCell(rowIdx, 17).value = refundType;
        } else if (isFirstRow) {
          const parts = [];
          if (o.note) parts.push(o.note);
          if (o.otherCost > 0) parts.push(`기타비용 ${o.otherCost.toLocaleString()}원`);
          if (refundsAgg.cash > 0) parts.push(`현금환불 ${refundsAgg.cash.toLocaleString()}원`);
          if (refundsAgg.credit > 0) parts.push(`적립금환불 ${refundsAgg.credit.toLocaleString()}원`);
          if (parts.length) ws.getCell(rowIdx, 17).value = parts.join(" ");
        }
        // R 현영/계산 (빈칸 — 폰트 색만)
        ws.getCell(rowIdx, 18).font = redFont;
        // S/T/U 년/월/일
        if (orderDate) {
          ws.getCell(rowIdx, 19).value = orderDate.getFullYear();
          ws.getCell(rowIdx, 19).numFmt = '####"년"';
          ws.getCell(rowIdx, 20).value = orderDate.getMonth() + 1;
          ws.getCell(rowIdx, 20).numFmt = '##"월"';
          ws.getCell(rowIdx, 21).value = orderDate.getDate();
          ws.getCell(rowIdx, 21).numFmt = '##"일"';
        }
        // V 입고가 (빈칸)
        ws.getCell(rowIdx, 22).fill = skyFill;
        ws.getCell(rowIdx, 22).numFmt = numFmtAcc;
        // W 입고가매출 (빈칸, 굵게)
        ws.getCell(rowIdx, 23).fill = skyFill;
        ws.getCell(rowIdx, 23).font = { ...baseBold };
        ws.getCell(rowIdx, 23).numFmt = numFmtAcc;

        // 좌우 테두리 A:U
        for (let c = 1; c <= 21; c++) {
          const cell = ws.getCell(rowIdx, c);
          const existing = cell.border || {};
          cell.border = { ...existing, left: grayBorder, right: grayBorder };
        }
        // V열: 왼쪽 thin border만 / W열: 테두리 없음
        ws.getCell(rowIdx, 22).border = { ...(ws.getCell(rowIdx, 22).border || {}), left: grayBorder };

        // E·G 컬럼 numFmt: 'm"/"d' (분석 결과 그대로 — 텍스트 값에도 적용)
        ws.getCell(rowIdx, 5).numFmt = 'm"/"d';
        ws.getCell(rowIdx, 7).numFmt = 'm"/"d';

        // 컬럼별 정렬 + 베이스 폰트 일괄 적용
        const ALIGN_DATA = ["center","center","center","center","center","center","center","center","center","center","center","center","right","right","right","right","left","left","center","center","center","left","left"];
        for (let c = 1; c <= 23; c++) {
          const cell = ws.getCell(rowIdx, c);
          // 폰트: 기존에 색·굵기가 지정돼 있으면 보존하면서 굴림체/10pt만 강제
          cell.font = { ...baseFont, ...(cell.font || {}), name: "굴림체", size: 10 };
          // 정렬: 기존 alignment가 있으면 horizontal만 지정
          cell.alignment = { ...(cell.alignment || {}), horizontal: ALIGN_DATA[c - 1], vertical: "middle" };
        }
      };

      let rowIdx = 5;
      for (const o of target) {
        // 한 주문 = 상품 개수만큼 행 (items 비어있으면 빈 placeholder 한 행)
        const items = (o.items && o.items.length > 0) ? o.items : [null];
        items.forEach((item, idx) => {
          fillRow(rowIdx, o, item, { isFirstRow: idx === 0 });
          rowIdx++;
        });

        // 환불 행 추가 (기존 로직 유지)
        const r = refundsFor(o.id);
        if (r.cash > 0) {
          fillRow(rowIdx, o, null, { refund: true, refundDate: r.lastDate, refundAmount: r.cash, refundType: "현금환불" });
          rowIdx++;
        }
        if (r.credit > 0) {
          fillRow(rowIdx, o, null, { refund: true, refundDate: r.lastDate, refundAmount: r.credit, refundType: "적립금환불" });
          rowIdx++;
        }
      }

      // ── Freeze A5 (4행까지 고정) ──
      ws.views = [{ state: "frozen", xSplit: 0, ySplit: 4 }];

      // ── AutoFilter A4:U{lastRow} (V/W 제외) ──
      const lastRow = Math.max(rowIdx - 1, 4);
      ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: lastRow, column: 21 } };

      // ─────────────────────────────────────────────
      // 월별 매출 피벗 시트
      // ─────────────────────────────────────────────
      // 매출 정의: items[0].amount (원장DB N열과 동일) - (현금환불 + 적립금환불)
      // 기준: 주문일(o.date)의 년/월 — 환불도 원래 주문의 년/월에 차감 반영
      const monthMap = {}; // "YYYY-MM" → 매출 합계
      for (const o of target) {
        const od = parseOrderDate(o.date);
        if (!od) continue;
        const y = od.getFullYear();
        const m = od.getMonth() + 1;
        const key = `${y}-${String(m).padStart(2, "0")}`;
        if (monthMap[key] === undefined) monthMap[key] = 0;
        const baseAmount = (o.items && o.items[0]?.amount) || 0;
        monthMap[key] += baseAmount;
        const r = refundsFor(o.id);
        monthMap[key] -= (r.cash + r.credit);
      }

      const pivotWs = wb.addWorksheet("월별 매출 피벗");

      // 탭 색상 #8DB4E2 (연파랑)
      pivotWs.properties.tabColor = { argb: "FF8DB4E2" };

      // 컬럼 너비 (75px → character width: (75-5)/7 ≈ 10)
      pivotWs.columns = [{ width: 12 }, { width: 17 }];

      // 공통 폰트 / 스타일
      const pivotFont = { name: "맑은 고딕", size: 11 };
      const pivotBold = { ...pivotFont, bold: true };
      const pivotMoneyFmt = '#,##0_ ;[Red]-#,##0 ';
      const pivotHeaderFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
      const pivotBorderColor = { argb: "FF95B3D7" };
      const pivotBorder = { style: "thin", color: pivotBorderColor };
      const pivotBox = { top: pivotBorder, bottom: pivotBorder, left: pivotBorder, right: pivotBorder };

      // Row 4: 헤더
      pivotWs.getCell(4, 1).value = "행 레이블";
      pivotWs.getCell(4, 2).value = "합계 : 매출";
      [1, 2].forEach(c => {
        const cell = pivotWs.getCell(4, c);
        cell.font = pivotBold;
        cell.fill = pivotHeaderFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.border = pivotBox;
      });

      // 년/월 그룹화
      const yearGroups = {};
      Object.keys(monthMap).sort().forEach(key => {
        const [y, m] = key.split("-");
        if (!yearGroups[y]) yearGroups[y] = [];
        yearGroups[y].push({ month: parseInt(m, 10), amount: monthMap[key] });
      });

      // Outline: 요약(년 행)이 자식(월 행) 위에 있도록
      pivotWs.properties.outlineProperties = { summaryBelow: false, summaryRight: false };

      // Compact 레이아웃: 년 행(indent 0, B비움) → 월 행들(indent 1, B에 매출) → ... → 총합계
      let pr = 5;
      let grandTotal = 0;
      Object.keys(yearGroups).sort().forEach(y => {
        // 년 행 (들여쓰기 0, 매출값 비움) — outlineLevel 0 (부모)
        pivotWs.getCell(pr, 1).value = `${y}년`;
        pivotWs.getCell(pr, 1).font = pivotBold;
        pivotWs.getCell(pr, 1).alignment = { vertical: "middle", indent: 0 };
        pivotWs.getCell(pr, 1).border = pivotBox;
        pivotWs.getCell(pr, 2).font = pivotFont;
        pivotWs.getCell(pr, 2).border = pivotBox;
        pivotWs.getRow(pr).outlineLevel = 0;
        pr++;

        // 월 행들 (들여쓰기 1, 매출값 표시) — outlineLevel 1 (자식, 접기 대상)
        yearGroups[y].forEach(({ month, amount }) => {
          pivotWs.getCell(pr, 1).value = `${month}월`;
          pivotWs.getCell(pr, 1).font = pivotFont;
          pivotWs.getCell(pr, 1).alignment = { vertical: "middle", indent: 1 };
          pivotWs.getCell(pr, 1).border = pivotBox;
          pivotWs.getCell(pr, 2).value = amount;
          pivotWs.getCell(pr, 2).numFmt = pivotMoneyFmt;
          pivotWs.getCell(pr, 2).font = pivotFont;
          pivotWs.getCell(pr, 2).border = pivotBox;
          pivotWs.getRow(pr).outlineLevel = 1;
          grandTotal += amount;
          pr++;
        });
      });

      // 총합계 행 (마지막)
      pivotWs.getCell(pr, 1).value = "총합계";
      pivotWs.getCell(pr, 2).value = grandTotal;
      pivotWs.getCell(pr, 2).numFmt = pivotMoneyFmt;
      [1, 2].forEach(c => {
        pivotWs.getCell(pr, c).font = pivotBold;
        pivotWs.getCell(pr, c).fill = pivotHeaderFill;
        pivotWs.getCell(pr, c).border = pivotBox;
      });
      pivotWs.getCell(pr, 1).alignment = { vertical: "middle", indent: 0 };

      // ─────────────────────────────────────────────
      // 사원별 매출 피벗 시트 (분석 결과 100% 매치)
      // ─────────────────────────────────────────────
      // 매트릭스: { manager: { year: { month?: amount, _total: amount } } }
      // 2024: 통합(월 분리 X), 2025: 1~12월별, 2026: 1~4월별
      const empMatrix = {};
      for (const o of target) {
        const od = parseOrderDate(o.date);
        if (!od) continue;
        const y = od.getFullYear();
        const mm = od.getMonth() + 1;
        const mgr = (o.manager && o.manager.trim()) ? o.manager : "(비어 있음)";
        const baseAmt = (o.items && o.items[0]?.amount) || 0;
        const rr = refundsFor(o.id);
        const net = baseAmt - (rr.cash + rr.credit);
        if (!empMatrix[mgr]) empMatrix[mgr] = {};
        if (!empMatrix[mgr][y]) empMatrix[mgr][y] = {};
        empMatrix[mgr][y][mm] = (empMatrix[mgr][y][mm] || 0) + net;
        empMatrix[mgr][y]._total = (empMatrix[mgr][y]._total || 0) + net;
      }

      // 분석 결과의 고정 담당자 순서 (행 위치 + 숨김 + 특별 강조)
      const FIXED_MGRS = [
        { name: "고문님",       row: 7,  hidden: false, special: false },
        { name: "실장님",       row: 8,  hidden: false, special: false },
        { name: "장부장님",     row: 9,  hidden: false, special: false },
        { name: "송미송",       row: 10, hidden: false, special: false },
        { name: "김민주",       row: 11, hidden: false, special: false },
        { name: "손희우",       row: 12, hidden: false, special: false },
        { name: "방문",         row: 13, hidden: false, special: false },
        { name: "기타",         row: 14, hidden: false, special: false },
        { name: "1호점",        row: 15, hidden: true,  special: false },
        { name: "(비어 있음)",  row: 16, hidden: true,  special: false },
        { name: "프리미엄셀러", row: 17, hidden: false, special: false },
        { name: "-",            row: 18, hidden: true,  special: false },
        { name: "김명옥",       row: 19, hidden: true,  special: true },
        { name: "조현숙",       row: 20, hidden: true,  special: true },
        { name: "박명진",       row: 21, hidden: true,  special: true },
      ];

      const empWs = wb.addWorksheet("사원별 매출 피벗");

      // 탭 색상 #8DB4E2
      empWs.properties.tabColor = { argb: "FF8DB4E2" };

      // 컬럼 너비 (px → character: (px-5)/7, 약간 여유 추가)
      // A=68.25, B=66, C-N=60, O=hidden, P-S=60, T=66, U=75
      empWs.columns = [
        { width: 11 },     // A 행 레이블 (담당자)
        { width: 13 },     // B 2024년 통합
        { width: 12 },     // C 2025-1
        { width: 12 },     // D 2025-2
        { width: 12 },     // E 2025-3
        { width: 12, hidden: true }, // F 2025-4 (숨김)
        { width: 12 },     // G 2025-5
        { width: 12 },     // H 2025-6
        { width: 12 },     // I 2025-7
        { width: 12 },     // J 2025-8
        { width: 12 },     // K 2025-9
        { width: 12 },     // L 2025-10
        { width: 12 },     // M 2025-11
        { width: 12 },     // N 2025-12
        { width: 13, hidden: true }, // O 2025 요약 (숨김)
        { width: 12 },     // P 2026-1
        { width: 12 },     // Q 2026-2
        { width: 12 },     // R 2026-3
        { width: 12 },     // S 2026-4
        { width: 13 },     // T 2026 요약
        { width: 15 },     // U 총합계
      ];

      // 페이지 설정
      empWs.pageSetup = {
        orientation: "landscape",
        paperSize: 9,
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 1,
        margins: {
          left: 50.4 / 72, right: 50.4 / 72,
          top: 54 / 72, bottom: 54 / 72,
          header: 21.6 / 72, footer: 21.6 / 72,
        },
      };

      // FIXED_MGRS에 없는 추가 담당자 자동 추출 (가나다순) — Row 22부터 append
      const fixedNamesSet = new Set(FIXED_MGRS.map(m => m.name));
      const extraMgrs = Object.keys(empMatrix)
        .filter(name => !fixedNamesSet.has(name) && name !== "(비어 있음)")
        .sort((a, b) => a.localeCompare(b, "ko-KR"));
      const empTotalRow = 22 + extraMgrs.length;

      // 행 높이
      empWs.getRow(1).height = 12.75;
      [2, 3, 4, 5].forEach(r => { empWs.getRow(r).height = 16.5; });
      [6, 7, 8, 9, 10, 11, 12, 13, 14].forEach(r => { empWs.getRow(r).height = 21.75; });
      empWs.getRow(15).height = 0; empWs.getRow(15).hidden = true;
      empWs.getRow(16).height = 0; empWs.getRow(16).hidden = true;
      empWs.getRow(17).height = 21.75;
      [18, 19, 20, 21].forEach(r => { empWs.getRow(r).height = 0; empWs.getRow(r).hidden = true; });
      // 추가 담당자 행 (22, 23, ...)
      for (let i = 0; i < extraMgrs.length; i++) {
        empWs.getRow(22 + i).height = 21.75;
      }
      empWs.getRow(empTotalRow).height = 12.75;

      // 스타일 상수
      const empHeaderFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
      const empSummaryFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
      const empSpecialFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
      const empBlueBorder = { style: "thin", color: { argb: "FF95B3D7" } };
      const empBox = { top: empBlueBorder, bottom: empBlueBorder, left: empBlueBorder, right: empBlueBorder };
      const empFontReg = { name: "맑은 고딕", size: 10 };
      const empFontBold = { name: "맑은 고딕", size: 10, bold: true };

      // ── Row 4: 피벗 라벨 ──
      empWs.getCell(4, 1).value = "합계 : 매출";
      empWs.getCell(4, 2).value = "열 레이블";
      for (let c = 1; c <= 21; c++) {
        const cell = empWs.getCell(4, c);
        cell.font = empFontBold;
        cell.fill = empHeaderFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // ── Row 5: 년도 헤더 ──
      empWs.getCell(5, 2).value = 2024; empWs.getCell(5, 2).numFmt = '####"년"';
      empWs.getCell(5, 3).value = 2025; empWs.getCell(5, 3).numFmt = '####"년"';
      empWs.getCell(5, 15).value = "2025년 요약";
      empWs.getCell(5, 16).value = 2026; empWs.getCell(5, 16).numFmt = '####"년"';
      empWs.getCell(5, 20).value = "2026년 요약";
      empWs.getCell(5, 21).value = "총합계";
      for (let c = 1; c <= 21; c++) {
        const cell = empWs.getCell(5, c);
        cell.font = empFontBold;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        // O5(2025요약)과 T5(2026요약)은 회색, 나머지는 연파랑
        cell.fill = (c === 15 || c === 20) ? empSummaryFill : empHeaderFill;
      }

      // ── Row 6: 월 헤더 + "행 레이블" ──
      empWs.getCell(6, 1).value = "행 레이블";
      // C-N: 2025년 1~12월
      for (let m = 1; m <= 12; m++) {
        const cell = empWs.getCell(6, 2 + m); // C=3 → 1월, ..., N=14 → 12월
        cell.value = m; cell.numFmt = '##"월"';
      }
      // P-S: 2026년 1~4월
      for (let m = 1; m <= 4; m++) {
        const cell = empWs.getCell(6, 15 + m); // P=16 → 1월, ..., S=19 → 4월
        cell.value = m; cell.numFmt = '##"월"';
      }
      // 6행 전체 스타일
      for (let c = 1; c <= 21; c++) {
        const cell = empWs.getCell(6, c);
        cell.font = empFontBold;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        cell.fill = (c === 15 || c === 20) ? empSummaryFill : empHeaderFill;
        cell.border = { ...empBox, bottom: empBlueBorder };
      }

      // ── 데이터 행 (Row 7~21 고정 + Row 22~ 추가 담당자) ──
      // 컬럼 → 년/월 매핑 (1-indexed)
      // B=2: 2024, C-N=3..14: 2025/1-12, O=15: 2025 summary, P-S=16..19: 2026/1-4, T=20: 2026 summary, U=21: grand
      const colTotals = new Array(22).fill(0);

      // FIXED_MGRS + 추가 담당자(extraMgrs)를 동일 루프로 처리
      const ALL_MGRS = [
        ...FIXED_MGRS,
        ...extraMgrs.map((name, i) => ({ name, row: 22 + i, special: false })),
      ];

      ALL_MGRS.forEach(({ name, row, special }) => {
        const data = empMatrix[name] || {};

        // A: 담당자 라벨
        const labelCell = empWs.getCell(row, 1);
        labelCell.value = name;
        labelCell.font = empFontBold;
        labelCell.alignment = { horizontal: "center", vertical: "middle" };
        labelCell.border = (row === 7 ? { ...empBox, top: empBlueBorder } : empBox);
        if (special) labelCell.fill = empSpecialFill;

        // B: 2024년 통합 합계
        const v2024 = (data[2024] && data[2024]._total) || 0;
        const cellB = empWs.getCell(row, 2);
        if (v2024 !== 0) cellB.value = v2024;
        cellB.numFmt = pivotMoneyFmt;
        cellB.font = empFontReg;
        cellB.border = empBox;
        if (special) cellB.fill = empSpecialFill;
        colTotals[2] += v2024;

        // C-N: 2025년 1~12월
        let total2025 = 0;
        for (let m = 1; m <= 12; m++) {
          const c = 2 + m; // 3=1월 → 14=12월
          const v = (data[2025] && data[2025][m]) || 0;
          const cell = empWs.getCell(row, c);
          if (v !== 0) cell.value = v;
          cell.numFmt = pivotMoneyFmt;
          cell.font = empFontReg;
          cell.border = empBox;
          if (special) cell.fill = empSpecialFill;
          total2025 += v;
          colTotals[c] += v;
        }

        // O: 2025년 요약
        const cellO = empWs.getCell(row, 15);
        if (total2025 !== 0) cellO.value = total2025;
        cellO.numFmt = pivotMoneyFmt;
        cellO.font = empFontReg;
        cellO.border = empBox;
        cellO.fill = special ? empSpecialFill : empSummaryFill;
        colTotals[15] += total2025;

        // P-S: 2026년 1~4월
        let total2026 = 0;
        for (let m = 1; m <= 4; m++) {
          const c = 15 + m; // 16=1월 → 19=4월
          const v = (data[2026] && data[2026][m]) || 0;
          const cell = empWs.getCell(row, c);
          if (v !== 0) cell.value = v;
          cell.numFmt = pivotMoneyFmt;
          cell.font = empFontReg;
          cell.border = empBox;
          if (special) cell.fill = empSpecialFill;
          total2026 += v;
          colTotals[c] += v;
        }

        // T: 2026년 요약
        const cellT = empWs.getCell(row, 20);
        if (total2026 !== 0) cellT.value = total2026;
        cellT.numFmt = pivotMoneyFmt;
        cellT.font = empFontReg;
        cellT.border = empBox;
        cellT.fill = special ? empSpecialFill : empSummaryFill;
        colTotals[20] += total2026;

        // U: 총합계
        const grand = v2024 + total2025 + total2026;
        const cellU = empWs.getCell(row, 21);
        if (grand !== 0) cellU.value = grand;
        cellU.numFmt = pivotMoneyFmt;
        cellU.font = empFontBold;
        cellU.border = empBox;
        cellU.fill = special ? empSpecialFill : empHeaderFill;
        colTotals[21] += grand;
      });

      // ── 총합계 행 (행 위치 동적 — 추가 담당자 만큼 아래로 이동) ──
      empWs.getCell(empTotalRow, 1).value = "총합계";
      empWs.getCell(empTotalRow, 1).font = empFontBold;
      empWs.getCell(empTotalRow, 1).alignment = { horizontal: "left", vertical: "middle" };
      empWs.getCell(empTotalRow, 1).fill = empHeaderFill;
      empWs.getCell(empTotalRow, 1).border = { ...empBox, top: empBlueBorder };
      for (let c = 2; c <= 21; c++) {
        const cell = empWs.getCell(empTotalRow, c);
        cell.font = empFontBold;
        cell.numFmt = pivotMoneyFmt;
        cell.fill = empHeaderFill;
        cell.border = { ...empBox, top: empBlueBorder };
        if (colTotals[c] !== 0) cell.value = colTotals[c];
      }

      // Freeze: Row 1~3 + A열 (frozen_rows=3, frozen_columns=1)
      empWs.views = [{ state: "frozen", xSplit: 1, ySplit: 3 }];

      // ─────────────────────────────────────────────
      // 일별구입내역 시트 (분석 결과 100% 매치)
      // ─────────────────────────────────────────────
      // 필터 년: 데이터에 있는 가장 최근 년 (없으면 현재 년)
      const yearsInData = new Set();
      target.forEach(o => {
        const od = parseOrderDate(o.date);
        if (od) yearsInData.add(od.getFullYear());
      });
      const sortedDataYears = Array.from(yearsInData).sort((a, b) => b - a);
      const filterYear = sortedDataYears[0] || new Date().getFullYear();

      // 매트릭스: { day: { month: { customers: Set, sales: number } } }
      // 입금자명수 = unique customer count (Set 사용)
      const dailyMatrix = {};
      const monthsInYear = new Set();
      target.forEach(o => {
        const od = parseOrderDate(o.date);
        if (!od || od.getFullYear() !== filterYear) return;
        const month = od.getMonth() + 1;
        const day = od.getDate();
        monthsInYear.add(month);
        if (!dailyMatrix[day]) dailyMatrix[day] = {};
        if (!dailyMatrix[day][month]) dailyMatrix[day][month] = { customers: new Set(), sales: 0 };
        const cust = (o.customer && o.customer.trim()) || "(미확인)";
        dailyMatrix[day][month].customers.add(cust);
        const baseAmt = (o.items && o.items[0]?.amount) || 0;
        dailyMatrix[day][month].sales += baseAmt;
        const rd = refundsFor(o.id);
        dailyMatrix[day][month].sales -= (rd.cash + rd.credit);
      });

      const sortedMonths = Array.from(monthsInYear).sort((a, b) => a - b);
      const dailyWs = wb.addWorksheet("일별구입내역");

      // 탭 색상 #8DB4E2
      dailyWs.properties.tabColor = { argb: "FF8DB4E2" };

      // 컬럼 너비 (px → character: (px-5)/7, 약간 여유)
      // A=40.5(일) / B=75 / C=60 / D=57.75 / E=60 / F=57.75 / G=60 / H=57.75 / I=60 / J=82.5 / K=81.75
      // 분석 결과의 12개월 데이터 패턴: 각 월 (입금자명수, 매출) 페어 + 마지막 (전체 입금자명수, 전체 매출)
      const dailyWidths = [{ width: 7 }];   // A 일자
      sortedMonths.forEach(() => {
        dailyWidths.push({ width: 9 });    // 입금자명수
        dailyWidths.push({ width: 12 });   // 매출
      });
      dailyWidths.push({ width: 12 });   // 전체 입금자명수
      dailyWidths.push({ width: 14 });   // 전체 매출
      dailyWs.columns = dailyWidths;
      const dailyTotalCols = sortedMonths.length * 2 + 2; // monthly pairs + (전체 입금자명수, 전체 매출)
      const dailyColCount = 1 + dailyTotalCols;            // +A
      const totalCustColIdx = 2 + sortedMonths.length * 2;  // 전체 입금자명수 컬럼
      const totalSalesColIdx = totalCustColIdx + 1;         // 전체 매출 컬럼

      // 페이지 설정 (Portrait A4, 100%, 분석 결과 여백)
      dailyWs.pageSetup = {
        orientation: "portrait",
        paperSize: 9,
        scale: 100,
        margins: {
          left: 50.4 / 72, right: 50.4 / 72,
          top: 54 / 72, bottom: 54 / 72,
          header: 21.6 / 72, footer: 21.6 / 72,
        },
      };

      // 스타일 상수
      const dailyHeaderFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
      const dailyBorderColor = { argb: "FF95B3D7" };
      const dailyBorder = { style: "thin", color: dailyBorderColor };
      const dailyFontReg = { name: "맑은 고딕", size: 10 };
      const dailyFontBold = { name: "맑은 고딕", size: 10, bold: true };
      const dailySalesFmt = '#,##0_ ;[Red]-#,##0 ';
      const dailyCountFmt = '#,##0_ ;[Red]-#,##0 ';
      const dailyDayFmt = '##"일"';
      const dailyMonthFmt = '##"월"';

      // 행 높이
      dailyWs.getRow(1).height = 13.5;
      dailyWs.getRow(2).height = 16.5;
      dailyWs.getRow(3).height = 24;
      dailyWs.getRow(4).height = 24;
      [5, 6, 7].forEach(r => { dailyWs.getRow(r).height = 16.5; });

      // Row 1, 2: 빈 (폰트만 지정)
      dailyWs.getCell(1, 1).font = dailyFontReg;
      dailyWs.getCell(2, 1).font = { name: "맑은 고딕", size: 11 };
      dailyWs.getCell(2, 2).font = { name: "맑은 고딕", size: 11 };

      // Row 3: 필터 (년)
      dailyWs.getCell(3, 1).value = "년";
      dailyWs.getCell(3, 1).font = dailyFontReg;
      dailyWs.getCell(3, 1).fill = dailyHeaderFill;
      dailyWs.getCell(3, 1).border = { bottom: dailyBorder };
      dailyWs.getCell(3, 2).value = filterYear;
      dailyWs.getCell(3, 2).numFmt = '####"년"';
      dailyWs.getCell(3, 2).font = dailyFontReg;
      dailyWs.getCell(3, 2).fill = dailyHeaderFill;
      dailyWs.getCell(3, 2).alignment = { horizontal: "left", vertical: "middle" };
      dailyWs.getCell(3, 2).border = { bottom: dailyBorder };
      // C3~K3은 빈 셀 흰배경 (알아서 빈)

      // Row 4: 빈 행 (A4:B4 상단 테두리)
      dailyWs.getCell(4, 1).border = { top: dailyBorder };
      dailyWs.getCell(4, 2).border = { top: dailyBorder };

      // Row 5: 열 레이블 헤더
      dailyWs.getCell(5, 2).value = "열 레이블";
      for (let c = 1; c <= dailyColCount; c++) {
        const cell = dailyWs.getCell(5, c);
        cell.font = dailyFontBold;
        cell.fill = dailyHeaderFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // Row 6: 월 헤더 (입금자명수 컬럼에 월 숫자, 매출 컬럼은 빈, 마지막 두 컬럼은 라벨)
      sortedMonths.forEach((m, idx) => {
        const cMonth = 2 + idx * 2;  // 입금자명수 컬럼
        dailyWs.getCell(6, cMonth).value = m;
        dailyWs.getCell(6, cMonth).numFmt = dailyMonthFmt;
      });
      dailyWs.getCell(6, totalCustColIdx).value = "전체 입금자명수";
      dailyWs.getCell(6, totalSalesColIdx).value = "전체 합계 : 매출";
      for (let c = 1; c <= dailyColCount; c++) {
        const cell = dailyWs.getCell(6, c);
        cell.font = dailyFontBold;
        cell.fill = dailyHeaderFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // Row 7: 필드명 헤더 (월별, 입금자명수, 합계 : 매출, …)
      dailyWs.getCell(7, 1).value = "월별";
      sortedMonths.forEach((_, idx) => {
        const cBase = 2 + idx * 2;
        dailyWs.getCell(7, cBase).value = "입금자명수";
        dailyWs.getCell(7, cBase + 1).value = "합계 : 매출";
      });
      // J7, K7는 빈 셀 (Row 6에 라벨 있으므로)
      for (let c = 1; c <= dailyColCount; c++) {
        const cell = dailyWs.getCell(7, c);
        cell.font = dailyFontBold;
        cell.fill = dailyHeaderFill;
        cell.alignment = { horizontal: c === 1 ? "left" : "center", vertical: "middle" };
        cell.border = { ...(cell.border || {}), bottom: dailyBorder };
      }

      // Row 8~38: 1일~31일 데이터
      const dailyColTotals = new Array(dailyColCount + 1).fill(0);
      for (let day = 1; day <= 31; day++) {
        const r = 7 + day;  // day=1 → row 8, day=31 → row 38
        dailyWs.getRow(r).height = 16.5;

        // A열 일자
        const labelCell = dailyWs.getCell(r, 1);
        labelCell.value = day;
        labelCell.numFmt = dailyDayFmt;
        labelCell.font = dailyFontBold;
        labelCell.alignment = { horizontal: "left", vertical: "middle" };

        // 월별 (입금자명수, 매출)
        let dayTotalCust = 0;
        let dayTotalSales = 0;
        sortedMonths.forEach((m, idx) => {
          const cBase = 2 + idx * 2;
          const v = dailyMatrix[day] && dailyMatrix[day][m];
          const cellCust = dailyWs.getCell(r, cBase);
          const cellSales = dailyWs.getCell(r, cBase + 1);
          cellCust.font = dailyFontReg;
          cellCust.numFmt = dailyCountFmt;
          cellSales.font = dailyFontReg;
          cellSales.numFmt = dailySalesFmt;
          if (v) {
            const cnt = v.customers.size;
            if (cnt > 0) {
              cellCust.value = cnt;
              dailyColTotals[cBase] += cnt;
              dayTotalCust += cnt;
            }
            if (v.sales !== 0) {
              cellSales.value = v.sales;
              dailyColTotals[cBase + 1] += v.sales;
              dayTotalSales += v.sales;
            }
          }
        });

        // J: 전체 입금자명수
        const cellJ = dailyWs.getCell(r, totalCustColIdx);
        cellJ.font = dailyFontReg;
        cellJ.numFmt = dailyCountFmt;
        cellJ.alignment = { horizontal: "center", vertical: "middle" };
        if (dayTotalCust > 0) {
          cellJ.value = dayTotalCust;
          dailyColTotals[totalCustColIdx] += dayTotalCust;
        }
        // K: 전체 합계:매출
        const cellK = dailyWs.getCell(r, totalSalesColIdx);
        cellK.font = dailyFontReg;
        cellK.numFmt = dailySalesFmt;
        cellK.alignment = { horizontal: "center", vertical: "middle" };
        if (dayTotalSales !== 0) {
          cellK.value = dayTotalSales;
          dailyColTotals[totalSalesColIdx] += dayTotalSales;
        }
      }

      // Row 39: 총합계
      const totalRow = 39;
      dailyWs.getRow(totalRow).height = 16.5;
      dailyWs.getCell(totalRow, 1).value = "총합계";
      dailyWs.getCell(totalRow, 1).font = dailyFontBold;
      dailyWs.getCell(totalRow, 1).fill = dailyHeaderFill;
      dailyWs.getCell(totalRow, 1).alignment = { horizontal: "left", vertical: "middle" };
      dailyWs.getCell(totalRow, 1).border = { top: dailyBorder };
      for (let c = 2; c <= dailyColCount; c++) {
        const cell = dailyWs.getCell(totalRow, c);
        cell.font = dailyFontBold;
        cell.fill = dailyHeaderFill;
        cell.border = { top: dailyBorder };
        // 입금자명수(짝수 c, c-2가 짝수) vs 매출(홀수 c)
        const isCustCol = (c - 2) % 2 === 0 && c < totalCustColIdx;
        const isSalesCol = (c - 2) % 2 === 1 && c <= totalSalesColIdx;
        if (c === totalCustColIdx) {
          cell.numFmt = dailyCountFmt;
          cell.alignment = { horizontal: "center", vertical: "middle" };
        } else if (c === totalSalesColIdx) {
          cell.numFmt = dailySalesFmt;
          cell.alignment = { horizontal: "center", vertical: "middle" };
        } else if (isCustCol) {
          cell.numFmt = dailyCountFmt;
        } else if (isSalesCol) {
          cell.numFmt = dailySalesFmt;
        }
        if (dailyColTotals[c] !== 0) cell.value = dailyColTotals[c];
      }

      // Freeze: Row 1~7 + A열
      dailyWs.views = [{ state: "frozen", xSplit: 1, ySplit: 7 }];

      // ─────────────────────────────────────────────
      // 고객별 매출실적 피벗 시트 (분석 결과 100% 매치)
      // ─────────────────────────────────────────────
      // 필터 년: 데이터 있는 가장 최근 년
      const custFilterYear = sortedDataYears[0] || new Date().getFullYear();

      // 매트릭스: { customer: { month: sales } }
      const custMatrix = {};
      const custMonthsSet = new Set();
      target.forEach(o => {
        const od = parseOrderDate(o.date);
        if (!od || od.getFullYear() !== custFilterYear) return;
        const month = od.getMonth() + 1;
        const cust = (o.customer && o.customer.trim()) ? o.customer : "(미확인)";
        custMonthsSet.add(month);
        if (!custMatrix[cust]) custMatrix[cust] = {};
        if (custMatrix[cust][month] === undefined) custMatrix[cust][month] = 0;
        const baseAmt = (o.items && o.items[0]?.amount) || 0;
        custMatrix[cust][month] += baseAmt;
        const rd = refundsFor(o.id);
        custMatrix[cust][month] -= (rd.cash + rd.credit);
      });

      const custMonths = Array.from(custMonthsSet).sort((a, b) => a - b);

      // 고객별 총합 계산 + 매출 내림차순 정렬
      const customerTotals = Object.keys(custMatrix).map(c => {
        let total = 0;
        for (const m in custMatrix[c]) total += custMatrix[c][m];
        return { customer: c, total };
      }).sort((a, b) => b.total - a.total);

      const custWs = wb.addWorksheet("고객별 매출실적 피벗");

      // 탭 색상 #8DB4E2
      custWs.properties.tabColor = { argb: "FF8DB4E2" };

      // 컬럼 레이아웃:
      // A=입금자명, B...=각 월 매출 (동적), 끝에 총합계, 그 다음 G=순위(좌)
      // 항상 O(15)=순위(우), H~N은 빈 패딩
      const monthColCnt = custMonths.length;
      const totalColIdx = 2 + monthColCnt;        // 예: 4개월=> 6 (F)
      const rankLeftIdx = totalColIdx + 1;         // 예: G
      const rankRightIdx = 15;                     // 항상 O

      // 컬럼 너비 (##### 방지 위해 충분히 넓게)
      const cWidths = [];
      for (let i = 1; i <= Math.max(rankRightIdx, totalColIdx + 1); i++) {
        if (i === 1) cWidths.push({ width: 18 });          // A 입금자명
        else if (i < totalColIdx) cWidths.push({ width: 13 }); // 월별 매출
        else if (i === totalColIdx) cWidths.push({ width: 15 }); // 총합계
        else if (i === rankLeftIdx) cWidths.push({ width: 9 });  // 순위(좌)
        else if (i === rankRightIdx) cWidths.push({ width: 8 }); // 순위(우)
        else if (i === 14) cWidths.push({ width: 10 });    // N
        else cWidths.push({ width: 9 });                    // H~M 빈 패딩
      }
      custWs.columns = cWidths;

      // 페이지 설정 (Portrait A4, 100%, 분석 결과 여백)
      custWs.pageSetup = {
        orientation: "portrait",
        paperSize: 9,
        scale: 100,
        margins: {
          left: 50.4 / 72, right: 50.4 / 72,
          top: 54 / 72, bottom: 54 / 72,
          header: 21.6 / 72, footer: 21.6 / 72,
        },
      };

      // 행 높이
      [1, 2, 3, 4, 5].forEach(r => { custWs.getRow(r).height = 12.75; });
      [6, 7].forEach(r => { custWs.getRow(r).height = 16.5; });

      // 스타일 상수 (분홍 계열)
      const custFontReg = { name: "맑은 고딕", size: 10 };
      const custFontBold = { name: "맑은 고딕", size: 10, bold: true };
      const custHeaderFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2DCDB" } };
      const custBorder = { style: "thin", color: { argb: "FFDA9694" } };
      const custMoneyFmt = '#,##0_ ;[Red]-#,##0 ';

      // ── Row 4: 피벗 필터 (년) ──
      custWs.getCell(4, 1).value = "년";
      custWs.getCell(4, 1).font = custFontReg;
      custWs.getCell(4, 1).fill = custHeaderFill;
      custWs.getCell(4, 1).border = { bottom: custBorder };
      custWs.getCell(4, 2).value = custFilterYear;
      custWs.getCell(4, 2).numFmt = '####"년"';
      custWs.getCell(4, 2).font = custFontReg;
      custWs.getCell(4, 2).fill = custHeaderFill;
      custWs.getCell(4, 2).alignment = { horizontal: "left", vertical: "middle" };
      custWs.getCell(4, 2).border = { bottom: custBorder };

      // ── Row 5: 빈 행 (A5:B5 상단 테두리) ──
      custWs.getCell(5, 1).border = { top: custBorder };
      custWs.getCell(5, 2).border = { top: custBorder };

      // ── Row 6: 피벗 헤더 1 ──
      custWs.getCell(6, 1).value = "합계 : 매출";
      custWs.getCell(6, 2).value = "월별";
      // A6:F6 (또는 totalColIdx까지) 모두 헤더 fill
      for (let c = 1; c <= totalColIdx; c++) {
        const cell = custWs.getCell(6, c);
        cell.font = custFontBold;
        cell.fill = custHeaderFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // ── Row 7: 피벗 헤더 2 (월 헤더) ──
      custWs.getCell(7, 1).value = "입금자명";
      custMonths.forEach((m, idx) => {
        const c = 2 + idx;
        custWs.getCell(7, c).value = m;
        custWs.getCell(7, c).numFmt = '##"월"';
      });
      custWs.getCell(7, totalColIdx).value = "총합계";
      // A7:F7 (또는 totalColIdx까지) 헤더 fill + 하단 테두리
      for (let c = 1; c <= totalColIdx; c++) {
        const cell = custWs.getCell(7, c);
        cell.font = custFontBold;
        cell.fill = custHeaderFill;
        cell.alignment = c === 1 ? { horizontal: "left", vertical: "middle" } : { horizontal: "center", vertical: "middle" };
        cell.border = { bottom: custBorder };
      }

      // ── Row 8 이상: 데이터 (매출 내림차순) ──
      const colSums = {};
      let grandSum = 0;
      let cRow = 8;
      customerTotals.forEach((entry, idx) => {
        custWs.getRow(cRow).height = 16.5;

        // A 입금자명
        const aCell = custWs.getCell(cRow, 1);
        aCell.value = entry.customer;
        aCell.font = custFontReg;
        aCell.alignment = { horizontal: "left", vertical: "middle" };

        // B~ 월별 매출
        let cI = 2;
        let custTot = 0;
        custMonths.forEach(m => {
          const v = custMatrix[entry.customer][m] || 0;
          const cell = custWs.getCell(cRow, cI);
          cell.font = custFontReg;
          cell.numFmt = custMoneyFmt;
          if (v !== 0) {
            cell.value = v;
            colSums[m] = (colSums[m] || 0) + v;
          }
          custTot += v;
          cI++;
        });

        // F 총합계 (가운데 정렬)
        const tCell = custWs.getCell(cRow, totalColIdx);
        tCell.font = custFontBold;
        tCell.numFmt = custMoneyFmt;
        tCell.alignment = { horizontal: "center", vertical: "middle" };
        if (custTot !== 0) tCell.value = custTot;
        grandSum += custTot;

        // 순위 (상위 20명만)
        if (idx < 20) {
          const rank = idx + 1;
          const gCell = custWs.getCell(cRow, rankLeftIdx);
          gCell.value = rank;
          gCell.font = custFontReg;
          gCell.numFmt = custMoneyFmt; // G는 피벗 영역 상속
          gCell.alignment = { horizontal: "center" };
          const oCell = custWs.getCell(cRow, rankRightIdx);
          oCell.value = rank;
          oCell.font = custFontReg;
          oCell.alignment = { horizontal: "center" };
        }
        cRow++;
      });

      // ── 마지막 총합계 행 ──
      custWs.getRow(cRow).height = 16.5;
      const totRow = cRow;
      custWs.getCell(totRow, 1).value = "총합계";
      custWs.getCell(totRow, 1).font = custFontBold;
      custWs.getCell(totRow, 1).fill = custHeaderFill;
      custWs.getCell(totRow, 1).alignment = { horizontal: "left", vertical: "middle" };
      custWs.getCell(totRow, 1).border = { top: custBorder };
      // 월별 합계
      custMonths.forEach((m, idx) => {
        const c = 2 + idx;
        const v = colSums[m] || 0;
        const cell = custWs.getCell(totRow, c);
        cell.font = custFontBold;
        cell.numFmt = custMoneyFmt;
        cell.fill = custHeaderFill;
        cell.border = { top: custBorder };
        if (v !== 0) cell.value = v;
      });
      // 전체 총합계
      const gtCell = custWs.getCell(totRow, totalColIdx);
      gtCell.font = custFontBold;
      gtCell.numFmt = custMoneyFmt;
      gtCell.fill = custHeaderFill;
      gtCell.alignment = { horizontal: "center", vertical: "middle" };
      gtCell.border = { top: custBorder };
      if (grandSum !== 0) gtCell.value = grandSum;
      // G~O 총합계 행은 빈 셀 (스펙)

      // ─────────────────────────────────────────────
      // 온라인 매출 피벗 시트 (분석 결과 100% 매치)
      // ─────────────────────────────────────────────
      // 매트릭스: { channel: { "YYYY-MM": { count, sales } } }
      const onlineMatrix = {};
      const onlineKeysSet = new Set();
      target.forEach(o => {
        const od = parseOrderDate(o.date);
        if (!od) return;
        const ch = (o.salesChannel && o.salesChannel.trim()) ? o.salesChannel : "(비어 있음)";
        const yy = od.getFullYear();
        const mm = od.getMonth() + 1;
        const key = `${yy}-${String(mm).padStart(2, "0")}`;
        onlineKeysSet.add(key);
        if (!onlineMatrix[ch]) onlineMatrix[ch] = {};
        if (!onlineMatrix[ch][key]) onlineMatrix[ch][key] = { count: 0, sales: 0 };
        onlineMatrix[ch][key].count += 1;
        const baseAmt = (o.items && o.items[0]?.amount) || 0;
        onlineMatrix[ch][key].sales += baseAmt;
        const rd = refundsFor(o.id);
        onlineMatrix[ch][key].sales -= (rd.cash + rd.credit);
      });

      // 년/월 그룹핑
      const onYearMap = {};
      Array.from(onlineKeysSet).forEach(k => {
        const [yy, mo] = k.split("-");
        if (!onYearMap[yy]) onYearMap[yy] = [];
        onYearMap[yy].push(parseInt(mo, 10));
      });
      const onYears = Object.keys(onYearMap).sort();
      onYears.forEach(yy => onYearMap[yy].sort((a, b) => a - b));

      // 컬럼 레이아웃: A=label, 각 (year, month) → count+sales 페어,
      // 각 year 끝에 year요약 (count+sales), 마지막에 grandTotal (count+sales)
      const onlineCols = [{ type: "label" }];
      onYears.forEach(yy => {
        onYearMap[yy].forEach(m => {
          onlineCols.push({ type: "month", year: yy, month: m, kind: "count" });
          onlineCols.push({ type: "month", year: yy, month: m, kind: "sales" });
        });
        onlineCols.push({ type: "yearSummary", year: yy, kind: "count" });
        onlineCols.push({ type: "yearSummary", year: yy, kind: "sales" });
      });
      onlineCols.push({ type: "grandTotal", kind: "count" });
      onlineCols.push({ type: "grandTotal", kind: "sales" });

      const onWs = wb.addWorksheet("온라인 매출 피벗");
      // 탭 색상 미설정 (분석 결과 그대로)

      // 컬럼 너비 (##### 방지 위해 충분히 넓게)
      onWs.columns = onlineCols.map((col, i) => {
        if (i === 0) return { width: 13 };           // A 판매처
        if (col.type === "yearSummary") {
          return col.kind === "count" ? { width: 10 } : { width: 15 };
        }
        if (col.type === "grandTotal") {
          return col.kind === "count" ? { width: 11 } : { width: 16 };
        }
        // 일반 월 페어
        return col.kind === "count" ? { width: 8 } : { width: 13 };
      });

      // 페이지 설정 (Portrait A4, 100%)
      onWs.pageSetup = {
        orientation: "portrait",
        paperSize: 9,
        scale: 100,
        margins: {
          left: 50.4 / 72, right: 50.4 / 72,
          top: 54 / 72, bottom: 54 / 72,
          header: 21.6 / 72, footer: 21.6 / 72,
        },
      };

      // 행 높이
      [1, 2, 3, 4, 5].forEach(r => { onWs.getRow(r).height = 16.5; });
      onWs.getRow(6).height = 21.75;
      [7, 8, 9, 10, 11, 12, 13, 14, 15].forEach(r => { onWs.getRow(r).height = 20.25; });

      // 스타일 상수 (맑은 고딕 11pt — 다른 시트와 다름)
      const onlineFontReg = { name: "맑은 고딕", size: 11 };
      const onlineFontBold = { name: "맑은 고딕", size: 11, bold: true };
      const onlineHeaderFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
      const onlineSummaryFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
      const onlineAccountFmt = '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)';
      const blackBorder = { style: "thin", color: { argb: "FF000000" } };
      const blueBorder = { style: "thin", color: { argb: "FF95B3D7" } };
      const totalCols = onlineCols.length;

      // ── Row 3: 피벗 헤더 1 ("열 레이블") ──
      onWs.getCell(3, 2).value = "열 레이블";
      for (let c = 1; c <= totalCols; c++) {
        const cell = onWs.getCell(3, c);
        cell.font = onlineFontBold;
        cell.fill = onlineHeaderFill;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // ── Row 4: 년 헤더 ──
      // 각 년의 첫 컬럼에 년 숫자, 요약 두 컬럼에 라벨, 마지막 두 컬럼에 "전체"
      let firstColOfYear = {}; // year → first column index
      onlineCols.forEach((col, i) => {
        const c = i + 1;
        if (col.type === "month" && firstColOfYear[col.year] === undefined) {
          firstColOfYear[col.year] = c;
        }
      });
      Object.entries(firstColOfYear).forEach(([yy, c]) => {
        onWs.getCell(4, c).value = parseInt(yy, 10);
        onWs.getCell(4, c).numFmt = "General";
      });
      onlineCols.forEach((col, i) => {
        const c = i + 1;
        if (col.type === "yearSummary") {
          const label = col.kind === "count"
            ? `${col.year} 건수`
            : `${col.year} 합계 : 매출`;
          onWs.getCell(4, c).value = label;
        } else if (col.type === "grandTotal") {
          const label = col.kind === "count" ? "전체 건수" : "전체 합계 : 매출";
          onWs.getCell(4, c).value = label;
        }
      });
      for (let c = 1; c <= totalCols; c++) {
        const cell = onWs.getCell(4, c);
        cell.font = onlineFontBold;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        const col = onlineCols[c - 1];
        cell.fill = (col && col.type === "yearSummary") ? onlineSummaryFill : onlineHeaderFill;
      }

      // ── Row 5: 월 헤더 ──
      onlineCols.forEach((col, i) => {
        const c = i + 1;
        if (col.type === "month" && col.kind === "count") {
          onWs.getCell(5, c).value = col.month;
          onWs.getCell(5, c).numFmt = '##"월"';
        }
      });
      for (let c = 1; c <= totalCols; c++) {
        const cell = onWs.getCell(5, c);
        cell.font = onlineFontBold;
        cell.alignment = { horizontal: "right", vertical: "middle" };
        const col = onlineCols[c - 1];
        cell.fill = (col && col.type === "yearSummary") ? onlineSummaryFill : onlineHeaderFill;
      }

      // ── Row 6: 필드명 헤더 (판매처/건수/합계:매출) ──
      onWs.getCell(6, 1).value = "판매처";
      onlineCols.forEach((col, i) => {
        const c = i + 1;
        if (col.type === "label") return;
        const label = col.kind === "count" ? "건수" : "합계 : 매출";
        onWs.getCell(6, c).value = label;
      });
      for (let c = 1; c <= totalCols; c++) {
        const cell = onWs.getCell(6, c);
        cell.font = onlineFontBold;
        cell.alignment = { horizontal: "center", vertical: "middle" };
        const col = onlineCols[c - 1];
        cell.fill = (col && col.type === "yearSummary") ? onlineSummaryFill : onlineHeaderFill;
        cell.border = { ...(cell.border || {}), bottom: blueBorder };
      }

      // ── 월 경계선: 4·5·6·데이터·총합 행에 매출 컬럼 우측 검정 thin ──
      const applyMonthBorders = (rowIdx) => {
        onlineCols.forEach((col, i) => {
          if (col.type === "month" && col.kind === "sales") {
            const c = i + 1;
            const cell = onWs.getCell(rowIdx, c);
            cell.border = { ...(cell.border || {}), right: blackBorder };
          }
          // 다음 월의 count 컬럼 좌측에도 (실제론 right로 충분)
        });
      };
      [4, 5, 6].forEach(r => applyMonthBorders(r));

      // ── Row 7~14: 8개 고정 판매처 데이터 ──
      const FIXED_CHANNELS = ["스레드","스마트스토어","인스타","쿠팡","롯데on","당근","로하이몰","카페24"];
      const onlineColTotals = new Array(totalCols + 1).fill(0);

      FIXED_CHANNELS.forEach((ch, idx) => {
        const r = 7 + idx;
        // A 판매처
        const aCell = onWs.getCell(r, 1);
        aCell.value = ch;
        aCell.font = onlineFontReg;
        aCell.alignment = { horizontal: "center", vertical: "middle" };

        const yearAggs = {};
        let chCount = 0;
        let chSales = 0;

        for (let c = 2; c <= totalCols; c++) {
          const col = onlineCols[c - 1];
          const cell = onWs.getCell(r, c);
          cell.font = onlineFontReg;
          cell.numFmt = onlineAccountFmt;

          if (col.type === "month") {
            const key = `${col.year}-${String(col.month).padStart(2, "0")}`;
            const entry = onlineMatrix[ch] && onlineMatrix[ch][key];
            const v = entry ? (col.kind === "count" ? entry.count : entry.sales) : 0;
            if (v !== 0) cell.value = v;
            if (!yearAggs[col.year]) yearAggs[col.year] = { count: 0, sales: 0 };
            yearAggs[col.year][col.kind] += v;
            onlineColTotals[c] += v;
            if (col.kind === "count") chCount += v;
            else chSales += v;
            if (col.kind === "sales") cell.border = { ...(cell.border || {}), right: blackBorder };
          } else if (col.type === "yearSummary") {
            const yt = yearAggs[col.year] || { count: 0, sales: 0 };
            const v = yt[col.kind];
            if (v !== 0) cell.value = v;
            cell.fill = onlineSummaryFill;
            onlineColTotals[c] += v;
            if (col.kind === "sales") cell.border = { ...(cell.border || {}), right: blackBorder };
          } else if (col.type === "grandTotal") {
            const v = col.kind === "count" ? chCount : chSales;
            if (v !== 0) cell.value = v;
            onlineColTotals[c] += v;
          }
        }
      });

      // ── Row 15: 총합계 ──
      const totalRowOnline = 15;
      onWs.getCell(totalRowOnline, 1).value = "총합계";
      onWs.getCell(totalRowOnline, 1).font = onlineFontBold;
      onWs.getCell(totalRowOnline, 1).fill = onlineHeaderFill;
      onWs.getCell(totalRowOnline, 1).alignment = { horizontal: "center", vertical: "middle" };
      onWs.getCell(totalRowOnline, 1).border = { top: blueBorder, bottom: blackBorder };
      for (let c = 2; c <= totalCols; c++) {
        const col = onlineCols[c - 1];
        const cell = onWs.getCell(totalRowOnline, c);
        cell.font = onlineFontBold;
        cell.fill = onlineHeaderFill;  // 총합계 행은 모두 #DCE6F1 (요약 회색 X)
        cell.numFmt = onlineAccountFmt;
        cell.border = { top: blueBorder, bottom: blackBorder };
        if (col.kind === "sales") cell.border = { ...cell.border, right: blackBorder };
        if (onlineColTotals[c] !== 0) cell.value = onlineColTotals[c];
      }

      // Freeze 없음 (분석 결과)

      // ─────────────────────────────────────────────
      // 시재 시트 (분석 결과 100% 매치 — 빈 양식, 178행 + 합계 행)
      // ─────────────────────────────────────────────
      const cashWs = wb.addWorksheet("시재");

      // 탭 색상 #8DB4E2
      cashWs.properties.tabColor = { argb: "FF8DB4E2" };

      // 컬럼 너비 (px → character: (px-5)/7)
      // A=66.75, B=264.75, C/D/E=86.25, F~K=66.75
      cashWs.columns = [
        { width: 11 },    // A 날짜
        { width: 37 },    // B 내역
        { width: 15 },    // C 입금
        { width: 15 },    // D 출금
        { width: 16 },    // E 잔액
        { width: 12 },    // F 메모/계산 (실제 시재)
        { width: 12 },    // G 메모/계산 (장부 차이)
        { width: 10 },    // H 메모/계산
        { width: 10 },    // I 빈
        { width: 10 },    // J 빈
        { width: 10 },    // K 메모
      ];

      // 페이지 설정 (Portrait A4, 100%)
      cashWs.pageSetup = {
        orientation: "portrait",
        paperSize: 9,
        scale: 100,
        margins: {
          left: 50.4 / 72, right: 50.4 / 72,
          top: 54 / 72, bottom: 54 / 72,
          header: 0.3, footer: 0.3,
        },
      };

      const cashFontReg = { name: "맑은 고딕", size: 11 };
      const cashFontBlue = { name: "맑은 고딕", size: 11, color: { argb: "FF0070C0" } };
      const cashAccountFmt = '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)';
      const cashDateFmt = 'm"/"d;@';

      const CASH_ROWS = 178;   // 데이터 영역 마지막 행 (R2~R178)
      const cashSumRow = 179;  // 합계 행

      // 모든 행 높이 27.75
      for (let r = 1; r <= cashSumRow; r++) {
        cashWs.getRow(r).height = 27.75;
      }

      // ── Row 1: 헤더 ──
      // A1: 빈 (날짜 레이블 없음, numFmt만)
      cashWs.getCell(1, 1).numFmt = cashDateFmt;
      cashWs.getCell(1, 1).font = cashFontReg;
      // B1~E1: 라벨
      cashWs.getCell(1, 2).value = "내역";
      cashWs.getCell(1, 3).value = "입금";
      cashWs.getCell(1, 4).value = "출금";
      cashWs.getCell(1, 5).value = "잔액";
      // C/D/E numFmt 회계
      [3, 4, 5].forEach(c => { cashWs.getCell(1, c).numFmt = cashAccountFmt; });
      // 헤더 정렬 + 폰트
      for (let c = 1; c <= 11; c++) {
        const cell = cashWs.getCell(1, c);
        cell.font = cashFontReg;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // ── Row 2~178: 빈 양식 + 잔액 자동 수식 ──
      for (let r = 2; r <= CASH_ROWS; r++) {
        // A 날짜
        cashWs.getCell(r, 1).numFmt = cashDateFmt;
        cashWs.getCell(r, 1).font = cashFontReg;
        // B 내역
        cashWs.getCell(r, 2).font = cashFontReg;
        // C 입금, D 출금, E 잔액
        [3, 4, 5].forEach(c => {
          cashWs.getCell(r, c).numFmt = cashAccountFmt;
          cashWs.getCell(r, c).font = cashFontReg;
        });
        // E 잔액 수식
        if (r === 2) {
          cashWs.getCell(r, 5).value = { formula: "C2" };
        } else {
          cashWs.getCell(r, 5).value = { formula: `E${r - 1}+C${r}-D${r}` };
        }
        // F~K 빈 (폰트만)
        for (let c = 6; c <= 11; c++) {
          cashWs.getCell(r, c).font = cashFontReg;
        }
      }

      // ── Row 179: 합계 (모두 글자색 #0070C0 파랑) ──
      cashWs.getCell(cashSumRow, 1).value = "합계";
      cashWs.getCell(cashSumRow, 1).font = cashFontBlue;
      cashWs.getCell(cashSumRow, 1).alignment = { horizontal: "center", vertical: "middle" };

      cashWs.getCell(cashSumRow, 2).font = cashFontBlue;
      cashWs.getCell(cashSumRow, 2).alignment = { horizontal: "center", vertical: "middle" };

      // C179: =SUM(C2:C178)
      cashWs.getCell(cashSumRow, 3).value = { formula: `SUM(C2:C${CASH_ROWS})` };
      cashWs.getCell(cashSumRow, 3).numFmt = cashAccountFmt;
      cashWs.getCell(cashSumRow, 3).font = cashFontBlue;

      // D179: =SUM(D2:D178)
      cashWs.getCell(cashSumRow, 4).value = { formula: `SUM(D2:D${CASH_ROWS})` };
      cashWs.getCell(cashSumRow, 4).numFmt = cashAccountFmt;
      cashWs.getCell(cashSumRow, 4).font = cashFontBlue;

      // E179: =C179-D179
      cashWs.getCell(cashSumRow, 5).value = { formula: `C${cashSumRow}-D${cashSumRow}` };
      cashWs.getCell(cashSumRow, 5).numFmt = cashAccountFmt;
      cashWs.getCell(cashSumRow, 5).font = cashFontBlue;

      // F179: 빈 (사용자가 실제 시재 입력)
      cashWs.getCell(cashSumRow, 6).numFmt = cashAccountFmt;
      cashWs.getCell(cashSumRow, 6).font = cashFontBlue;

      // G179: =F179-E179 (실제 시재 - 장부 잔액)
      cashWs.getCell(cashSumRow, 7).value = { formula: `F${cashSumRow}-E${cashSumRow}` };
      cashWs.getCell(cashSumRow, 7).numFmt = cashAccountFmt;
      cashWs.getCell(cashSumRow, 7).font = cashFontBlue;

      // H~K: 빈 (폰트만)
      for (let c = 8; c <= 11; c++) {
        cashWs.getCell(cashSumRow, c).font = cashFontBlue;
      }

      // Freeze: 1행
      cashWs.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

      // 테두리 없음 (분석 결과 그대로)

      // ─────────────────────────────────────────────
      // 현금영수증 시트 (분석 결과 매치 — 빈 양식)
      // ─────────────────────────────────────────────
      const receiptWs = wb.addWorksheet("현금영수증");
      // 탭 색상 미설정 (분석 결과)

      // 컬럼 너비 (px → character: (px-5)/7)
      // A=122.25 / B=77.25 / C=161.25 / D=83.25
      receiptWs.columns = [
        { width: 17 },   // A 이름
        { width: 10 },   // B 번호
        { width: 22 },   // C 연락처/사업자번호
        { width: 11 },   // D 비고
      ];

      // 페이지 설정 (Portrait A4 100%, 좌우 18pt 좁음 — 분석 결과 그대로)
      receiptWs.pageSetup = {
        orientation: "portrait",
        paperSize: 9,
        scale: 100,
        margins: {
          left: 18 / 72, right: 18 / 72,
          top: 54 / 72, bottom: 54 / 72,
          header: 21.6 / 72, footer: 21.6 / 72,
        },
      };

      const gulimReg = { name: "굴림", size: 11 };
      const gulimHead = { name: "굴림", size: 14, bold: true };

      const RECEIPT_ROWS = 50;

      // 모든 행 높이 25.5
      for (let r = 1; r <= RECEIPT_ROWS; r++) {
        receiptWs.getRow(r).height = 25.5;
      }

      // ── Row 1: 헤더 ──
      receiptWs.getCell(1, 1).value = "이름";
      receiptWs.getCell(1, 2).value = "번호";
      receiptWs.getCell(1, 3).value = "연락처/사업자번호";
      receiptWs.getCell(1, 4).value = "비고";
      // B1 / C1: 텍스트 numFmt
      receiptWs.getCell(1, 2).numFmt = "@";
      receiptWs.getCell(1, 3).numFmt = "@";
      for (let c = 1; c <= 4; c++) {
        const cell = receiptWs.getCell(1, c);
        cell.font = gulimHead;
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // ── Row 2~50: 빈 데이터 영역 (사용자 입력용, 모두 가운데 정렬) ──
      for (let r = 2; r <= RECEIPT_ROWS; r++) {
        for (let c = 1; c <= 4; c++) {
          const cell = receiptWs.getCell(r, c);
          cell.font = gulimReg;
          cell.alignment = { horizontal: "center", vertical: "middle" };
        }
        // B/C 텍스트 형식 (앞자리 0 보존)
        receiptWs.getCell(r, 2).numFmt = "@";
        receiptWs.getCell(r, 3).numFmt = "@";
      }

      // Freeze: 1행
      receiptWs.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];

      // ── 다운로드 ──
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const now = new Date();
      const yyyymmdd = now.getFullYear() + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
      a.href = url;
      a.download = `마켓원장_${yyyymmdd}.xlsx`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.error("마켓원장 내보내기 실패:", e);
      showToast?.("마켓원장 내보내기 실패: " + e.message, "error");
    } finally {
      setLedgerLoading(false);
    }
  };

  return (
    <div>
      {/* 모바일(≤520px) 전용 주문목록 레이아웃 — 6열 고정폭 그리드가 좁은 화면에서 잘리므로
          고객/금액/상태 3열 × 2행으로 재배치. PC(>520px)는 인라인 스타일 그대로. */}
      <style>{`
        @media (max-width: 520px) {
          .dash-ogrid {
            grid-template-columns: minmax(0, 1fr) auto auto !important;
            grid-template-areas: "cust dep ship" "mgr ref pay";
            gap: 3px 10px !important;
            padding-left: 12px !important;
            padding-right: 12px !important;
          }
          .dash-oc-cust { grid-area: cust; }
          .dash-oc-mgr  { grid-area: mgr; text-align: left !important; }
          .dash-oc-dep  { grid-area: dep; align-self: center; }
          .dash-oc-ref  { grid-area: ref; align-self: center; }
          .dash-oc-ship { grid-area: ship; }
          .dash-oc-pay  { grid-area: pay; }
        }
      `}</style>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontFamily: SF, fontSize: 22, fontWeight: 800, color: T.cream }}>대시보드</div>
        <div style={{ display: "flex", gap: 6 }}>
          <GhostBtn onClick={exportMarketLedger} small disabled={ledgerLoading}>{ledgerLoading ? <CuteLoader size="sm" /> : "⬇ 엑셀"}</GhostBtn>
        </div>
      </div>

      {/* ── Stat Cards (관리자만) ── */}
      {isAdmin && (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        {[
          { icon: "◈", l: "수금액", v: filteredTotal, u: "원", c: T.copper, fmt: true },
          { icon: "◉", l: "주문 건수", v: filteredCount, u: "건", c: T.blue, fmt: true },
          { icon: "◇", l: "미수금", v: unpaidTotal, u: "원", c: unpaidTotal > 0 ? T.red : T.creamMuted, fmt: true },
          { icon: "♦", l: "건당 평균", v: avgPerOrder, u: "원", c: T.purple, fmt: true },
        ].map(s => (
          <div key={s.l} className="dash-stat" style={{ background: T.card, borderRadius: 14, border: `1px solid ${T.border}`, boxShadow: T.cardShadow, padding: "16px 18px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: -10, right: -10, width: 60, height: 60, background: `radial-gradient(circle,${s.c}25,transparent 70%)` }} />
            <div style={{ fontSize: 16, marginBottom: 8 }}>{s.icon}</div>
            <div className="dash-stat-val" style={{ fontFamily: SF, fontSize: 22, fontWeight: 700, color: s.c, lineHeight: 1 }}>
              {s.fmt ? s.v.toLocaleString() : s.v}
              <span style={{ fontSize: 11, fontWeight: 400, color: T.creamMuted, marginLeft: 3 }}>{s.u}</span>
            </div>
            <div style={{ fontSize: 11, color: T.creamMuted, marginTop: 5 }}>{s.l}</div>
          </div>
        ))}
      </div>
      )}

      {/* ── Filters ── */}
      <Card style={{ marginBottom: 12, padding: 12 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => { setDateFilter(f.key); setCustomFrom(""); setCustomTo(""); }} style={{
              padding: "6px 14px", borderRadius: 8, border: `1px solid ${dateFilter === f.key ? T.copper : T.border}`,
              background: dateFilter === f.key ? T.copperGlow : "transparent",
              color: dateFilter === f.key ? T.copper : T.creamMuted,
              fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: S,
            }}>
              {f.label}
            </button>
          ))}
          {loading && <span style={{ alignSelf: "center", marginLeft: 4 }}><CuteLoader text="조회중" size="sm" /></span>}
        </div>
        {/* date 인풋은 내재 min-width(~150px)가 있어 좁은 화면에서 flex로 안 줄어듦 → minWidth:0으로 축소 허용 */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
          <input type="date" value={customFrom} onChange={e => { setCustomFrom(e.target.value); setDateFilter("custom"); }}
            style={{ ...baseInp, flex: 1, minWidth: 0, padding: "8px 10px", fontSize: 12, background: T.inputBg, border: `1px solid ${dateFilter === "custom" ? T.copper : T.border}`, color: T.cream }} />
          <span style={{ fontSize: 12, color: T.creamMuted, flexShrink: 0 }}>~</span>
          <input type="date" value={customTo} onChange={e => { setCustomTo(e.target.value); setDateFilter("custom"); }}
            style={{ ...baseInp, flex: 1, minWidth: 0, padding: "8px 10px", fontSize: 12, background: T.inputBg, border: `1px solid ${dateFilter === "custom" ? T.copper : T.border}`, color: T.cream }} />
        </div>

        {/* 출고상태 필터 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: T.creamMuted, fontWeight: 700, marginRight: 2 }}>출고</span>
          {SHIP_FILTERS.map(s => (
            <button key={s||"all"} onClick={() => setShipFilter(s)} style={{
              padding: "4px 10px", fontSize: 11, borderRadius: 16,
              border: `1px solid ${shipFilter === s ? T.copper : T.border}`,
              background: shipFilter === s ? T.copperGlow : "transparent",
              color: shipFilter === s ? T.copper : T.creamMuted,
              cursor: "pointer", fontFamily: S, fontWeight: shipFilter === s ? 700 : 400,
            }}>{s || "전체"}</button>
          ))}
        </div>

        {/* 입금상태 필터 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: T.creamMuted, fontWeight: 700, marginRight: 2 }}>입금</span>
          {PAY_FILTERS.map(p => (
            <button key={p||"all"} onClick={() => setPayFilter(p)} style={{
              padding: "4px 10px", fontSize: 11, borderRadius: 16,
              border: `1px solid ${payFilter === p ? T.copper : T.border}`,
              background: payFilter === p ? T.copperGlow : "transparent",
              color: payFilter === p ? T.copper : T.creamMuted,
              cursor: "pointer", fontFamily: S, fontWeight: payFilter === p ? 700 : 400,
            }}>{p || "전체"}</button>
          ))}
        </div>

        {/* 영수증 종류 필터 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: T.creamMuted, fontWeight: 700, marginRight: 2 }}>영수증</span>
          {RECEIPT_FILTERS.map(opt => (
            <button key={opt.v || "all"} onClick={() => setReceiptFilter(opt.v)} style={{
              padding: "4px 10px", fontSize: 11, borderRadius: 16,
              border: `1px solid ${receiptFilter === opt.v ? T.copper : T.border}`,
              background: receiptFilter === opt.v ? T.copperGlow : "transparent",
              color: receiptFilter === opt.v ? T.copper : T.creamMuted,
              cursor: "pointer", fontFamily: S, fontWeight: receiptFilter === opt.v ? 700 : 400,
            }}>{opt.l}</button>
          ))}
        </div>

        {/* 담당자 필터 */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: T.creamMuted, fontWeight: 700, marginRight: 2 }}>담당</span>
          <button onClick={() => setManagerFilter("")} style={{
            padding: "4px 10px", fontSize: 11, borderRadius: 16,
            border: `1px solid ${managerFilter === "" ? T.copper : T.border}`,
            background: managerFilter === "" ? T.copperGlow : "transparent",
            color: managerFilter === "" ? T.copper : T.creamMuted,
            cursor: "pointer", fontFamily: S, fontWeight: managerFilter === "" ? 700 : 400,
          }}>전체</button>
          {sortedManagers.map(m => (
            <button key={m.name} onClick={() => setManagerFilter(managerFilter === m.name ? "" : m.name)} style={{
              padding: "4px 10px", fontSize: 11, borderRadius: 16,
              border: `1px solid ${managerFilter === m.name ? T.copper : T.border}`,
              background: managerFilter === m.name ? T.copperGlow : "transparent",
              color: managerFilter === m.name ? T.copper : T.creamMuted,
              cursor: "pointer", fontFamily: S, fontWeight: managerFilter === m.name ? 700 : 400,
            }}>{m.name}</button>
          ))}
          <button onClick={() => setManagerFilter(managerFilter === "__empty__" ? "" : "__empty__")} style={{
            padding: "4px 10px", fontSize: 11, borderRadius: 16,
            border: `1px solid ${managerFilter === "__empty__" ? T.copper : T.border}`,
            background: managerFilter === "__empty__" ? T.copperGlow : "transparent",
            color: managerFilter === "__empty__" ? T.copper : T.creamMuted,
            cursor: "pointer", fontFamily: S, fontWeight: managerFilter === "__empty__" ? 700 : 400,
          }}>미지정</button>
        </div>

        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="고객명 · 닉네임 · 전화번호 검색..."
          style={{ ...baseInp, padding: "8px 12px", fontSize: 12, background: T.inputBg, border: `1px solid ${T.border}`, color: T.cream }}
        />
      </Card>

      {/* ── Order List (개별 카드) ── */}
      <Card style={{ marginBottom: 12, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px 8px" }}>
          <SecTitle>주문 목록</SecTitle>
        </div>

        {sorted.length === 0 ? (
          loading
            ? <div style={{padding:"50px 0",textAlign:"center"}}><CuteLoader text="주문 불러오는 중..." size="md" /></div>
            : <Empty text="주문이 없습니다" sub="필터를 조정해 보세요" />
        ) : (
          <div>
            {/* Header */}
            <div className="dash-ogrid" style={{ display: "grid", gridTemplateColumns: "1fr 55px 70px 60px 55px 65px", gap: 6, padding: "6px 16px", fontSize: 10, fontWeight: 700, color: T.creamMuted, borderBottom: `1px solid ${T.border}`, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <span className="dash-oc-cust">고객</span>
              <span className="dash-oc-mgr" style={{ textAlign: "center" }}>담당자</span>
              <span className="dash-oc-dep" style={{ textAlign: "right" }}>입금액</span>
              <span className="dash-oc-ref" style={{ textAlign: "right" }}>환불액</span>
              <span className="dash-oc-ship" style={{ textAlign: "center" }}>출고</span>
              <span className="dash-oc-pay" style={{ textAlign: "center" }}>입금</span>
            </div>

            {pageItems.map(o => {
              const cust = customerMap[o.customer];
              const expanded = expandedId === o.id;
              const shipStat = getShipStatus(o);
              const payStat = getPayStatus(o);
              const total = getOrderAmount(o);
              const refund = o._computed?.refundAmount ?? 0;
              const rawDeposit = o._computed?.rawDepositAmount ?? o._computed?.depositAmount ?? o.depositAmount ?? 0;
              const received = getReceivedAmount(o);
              const balance = Math.max(0, total - received - refund);
              // 반품 상태를 출고 상태 태그에 반영 (표시만 — 필터 기준 status는 그대로 출고완료)
              // 진행 중: 반품신청 → 수거중 → 반품입고 중 가장 진행된 단계
              // 전부 완료: 반품 수량 >= 주문 수량이면 반품완료, 아니면 부분반품
              const retStat = (() => {
                const list = returnsByOrder[o.id] || [];
                if (list.length === 0) return null;
                const active = list.filter(r => r.status !== "완료");
                if (active.length > 0) {
                  const stages = ["반품신청", "수거중", "반품입고"];
                  let stage = "반품신청";
                  for (const r of active) if (stages.indexOf(r.status) > stages.indexOf(stage)) stage = r.status;
                  return stage;
                }
                const orderQty = (o.items || []).reduce((s, it) => s + (parseFloat(it.qty) || 0), 0);
                const retQty = list.reduce((s, r) => s + (r.items || []).reduce((ss, it) => ss + (parseFloat(it.qty) || 0), 0), 0);
                return (orderQty > 0 && retQty >= orderQty) ? "반품완료" : "부분반품";
              })();
              // 반품 상태 전용 색 — 기존 태그 색(초록=출고완료·노랑=보관·핑크=포장완료·파랑=접수·빨강=미입금·보라=환불)과 겹치지 않게 구성
              const RET_STAT_COLORS = {
                "반품신청": [T.copper, T.copperGlow],                    // 카퍼(주황)
                "수거중":   ["#14B8A6", "rgba(20,184,166,0.14)"],        // 청록(teal)
                "반품입고": ["#6366F1", "rgba(99,102,241,0.14)"],        // 남색(indigo)
                "부분반품": ["#84CC16", "rgba(132,204,22,0.14)"],        // 라임
                "반품완료": [T.creamMuted, T.subtleBg],                  // 회색(종결)
              };
              const [shipColor, shipBg] = retStat ? RET_STAT_COLORS[retStat] : sC(shipStat, T);
              const dispShipStat = retStat || shipStat;
              const [payColor, payBg] = pC(payStat, T);
              return (
                <div key={o.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <div
                    className="dash-ogrid"
                    onClick={() => setExpandedId(expanded ? null : o.id)}
                    style={{
                      display: "grid", gridTemplateColumns: "1fr 55px 70px 60px 55px 65px", gap: 6,
                      padding: "10px 16px", fontSize: 12, cursor: "pointer", alignItems: "center",
                      background: expanded ? T.subtleBg : "transparent",
                      transition: "background 0.15s",
                    }}
                  >
                    <div className="dash-oc-cust" style={{ overflow: "hidden" }}>
                      <div style={{ fontWeight: 700, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.customer}</span>
                        {(() => {
                          // 전화번호 중간 4자리 — order.phone 우선, 없으면 customer 정보에서.
                          // 11자리(010-XXXX-YYYY) → 가운데 4자리, 4자리 그대로면 그대로.
                          const raw = o.phone || cust?.phone || "";
                          const digits = String(raw).replace(/[^0-9]/g, "");
                          const mid4 = digits.length >= 10 ? digits.slice(3, 7) : (digits.length === 4 ? digits : null);
                          return mid4
                            ? <span style={{ fontSize: 10, color: T.creamMuted, fontFamily: SF, fontWeight: 500, flexShrink: 0 }}>·{mid4}</span>
                            : null;
                        })()}
                        {receiptChip(o, true)}
                        {(((returnsByOrder[o.id] || []).some(r => (r.exchangeItems || []).length > 0)) || (o.note || "").startsWith("교환 출고")) && <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, color: T.blue, background: T.blueBg, padding: "1px 5px", borderRadius: 4, border: `1px solid ${T.blue}30` }}>🔄 교환</span>}
                        {(returnsByOrder[o.id] || []).length > 0 && !(returnsByOrder[o.id] || []).some(r => (r.exchangeItems || []).length > 0) && <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 800, color: T.yellow, background: T.yellowBg, padding: "1px 5px", borderRadius: 4, border: `1px solid ${T.yellow}30` }}>↩️ 반품</span>}
                      </div>
                      <div style={{ fontSize: 10, color: T.creamMuted, fontFamily: SF, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.date}</div>
                    </div>
                    <span className="dash-oc-mgr" style={{ textAlign: "center", fontSize: 11, color: o.manager ? T.cream : T.creamMuted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {o.manager || "—"}
                    </span>
                    <span className="dash-oc-dep" style={{ textAlign: "right", fontWeight: 700, fontFamily: SF, fontSize: 12, color: rawDeposit > 0 ? T.copper : T.creamMuted }}>
                      {rawDeposit > 0 ? rawDeposit.toLocaleString() : "0"}
                    </span>
                    <span className="dash-oc-ref" style={{ textAlign: "right", fontFamily: SF, fontSize: 11, color: refund > 0 ? T.red : T.creamMuted }}>
                      {refund > 0 ? `-${refund.toLocaleString()}` : "0"}
                    </span>
                    <span className="dash-oc-ship" style={{ textAlign: "center" }}>
                      {shipStat === "출고완료" ? (
                        /* 출고완료 태그 클릭 → 출고일 토글 (행 펼침과 분리하려고 stopPropagation) */
                        <span
                          onClick={(e) => { e.stopPropagation(); setShipDateId(prev => prev === o.id ? null : o.id); }}
                          style={{ cursor: "pointer", display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 2 }}
                        >
                          <Tag c={shipColor} bg={shipBg}>{dispShipStat}</Tag>
                          {shipDateId === o.id && (
                            <span style={{ fontSize: 9, color: T.creamMuted, fontFamily: SF, whiteSpace: "nowrap" }}>
                              {fmtShippedDate(o.shippedAt) || "기록 없음"}
                            </span>
                          )}
                        </span>
                      ) : (
                        <Tag c={shipColor} bg={shipBg}>{dispShipStat}</Tag>
                      )}
                    </span>
                    <span className="dash-oc-pay" style={{ textAlign: "center" }}><Tag c={payColor} bg={payBg}>{payStat}</Tag></span>
                  </div>

                  {expanded && (
                    <div style={{ padding: "12px 16px", background: T.subtleBg }}>
                      {/* 고객 정보 — 주문에 저장된 스냅샷 우선. 동명이인(같은 이름 다른 사람)일 때
                          customerMap[이름]은 한 명만 가리키므로, 이름으로 찾은 cust를 그대로 쓰면
                          엉뚱한 사람 연락처/주소가 붙는다. o.phone/o.address(주문 시점 값)를 먼저 사용. */}
                      {(() => {
                        const phone = o.phone || cust?.phone || "";
                        const addr = [o.address || cust?.address, o.addressDetail || cust?.addressDetail].filter(Boolean).join(" ");
                        if (!phone && !addr) return null;
                        return (
                          <div style={{ marginBottom: 10, fontSize: 11, color: T.creamMuted }}>
                            {phone && <span>{phone}</span>}
                            {addr && <span style={{ marginLeft: 8 }}>{addr}</span>}
                          </div>
                        );
                      })()}
                      {/* 아이템 */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                        {(o.items || []).map((item, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                            {item.itemNo && <span style={{ color: T.copper, fontFamily: "monospace", fontWeight: 700, fontSize: 10 }}>{item.itemNo.toUpperCase()}</span>}
                            <span style={{ flex: 1 }}>
                              <span style={{ fontWeight: 600 }}>{item.fabric}</span>
                              {item.color && <span style={{ color: T.creamMuted, marginLeft: 4 }}>{item.color}</span>}
                            </span>
                            <span style={{ fontWeight: 700 }}>{item.qty}{item.unit||"마"}</span>
                            {item.amount > 0 && <span style={{ color: T.copper, fontSize: 10 }}>{item.amount.toLocaleString()}원</span>}
                          </div>
                        ))}
                      </div>
                      {o.shippingFee > 0 && (
                        <div style={{ fontSize: 10, color: T.blue, marginBottom: 6 }}>배송비 {o.shippingFee.toLocaleString()}원</div>
                      )}
                      {/* 영수증 — 종류 지정/변경은 출고완료 후에도 여기서 바로 가능 */}
                      <div style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {o.receiptType ? (
                          <>
                            {receiptChip(o, false)}
                            <span style={{ fontSize: 9, color: T.creamMuted }}>{o.receiptIssued ? "발급 완료" : "클릭하면 발급 표시"}</span>
                          </>
                        ) : (
                          <span style={{ fontSize: 10, fontWeight: 700, color: T.creamMuted }}>영수증 발행 안 함</span>
                        )}
                        <span style={{ display: "flex", gap: 4, marginLeft: "auto", flexWrap: "wrap" }}>
                          {[{ v: null, l: "없음" }, { v: "cash", l: "🧾 현금영수증" }, { v: "business", l: "📋 지출증빙" }, { v: "tax_invoice", l: "📄 세금계산서" }].map(opt => {
                            const active = (o.receiptType || null) === opt.v;
                            return (
                              <span key={opt.l} onClick={(e) => setReceiptType(e, o, opt.v)}
                                title={active ? "현재 선택됨" : "클릭하면 이 종류로 변경"}
                                style={{
                                  fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 5,
                                  color: active ? T.green : T.creamMuted,
                                  background: active ? T.greenBg : T.surface,
                                  border: active ? `1.5px solid ${T.green}` : `1px solid ${T.border}`,
                                  cursor: "pointer", whiteSpace: "nowrap",
                                }}>
                                {opt.l}
                              </span>
                            );
                          })}
                        </span>
                      </div>
                      {o.note && o.note.trim() && o.note.trim() !== "None" && (
                        <div style={{ marginBottom: 8, fontSize: 10, color: T.creamMuted, padding: "4px 6px", background: T.surface, borderRadius: 4 }}>{o.note}</div>
                      )}
                      {o.memo && o.memo.trim() && (
                        <div style={{ marginBottom: 8, fontSize: 10, padding: "4px 8px", background: "#fef3c7", borderRadius: 4, color: "#78350f", display: "flex", gap: 4, alignItems: "flex-start", border: "1px solid #fde68a" }}>
                          <span style={{ flexShrink: 0 }}>📝</span>
                          <span style={{ lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1 }}>{o.memo}</span>
                        </div>
                      )}

                      {/* 결제 상세 */}
                      {(()=>{
                        const lot = logsByOrderType[o.id] || {};
                        const payDeposit = lot["입금"]||0;
                        const payCreditUsed = (lot["적립금차감"]||0) - (lot["적립금복원"]||0);
                        const payRefundCash = lot["현금환불"]||0;
                        const payRefundCredit = lot["적립금전환"]||0;
                        const hasAny = payDeposit + payCreditUsed + payRefundCash + payRefundCredit > 0;
                        if (!hasAny) return null;
                        return (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
                            {payDeposit > 0 && (
                              <div style={{ background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                                <div style={{ fontSize: 9, color: T.creamMuted }}>입금(현금)</div>
                                <div style={{ fontFamily: SF, fontWeight: 700, fontSize: 12, color: T.blue }}>{payDeposit.toLocaleString()}원</div>
                              </div>
                            )}
                            {payCreditUsed > 0 && (
                              <div style={{ background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                                <div style={{ fontSize: 9, color: T.creamMuted }}>적립금 사용</div>
                                <div style={{ fontFamily: SF, fontWeight: 700, fontSize: 12, color: T.purple }}>-{payCreditUsed.toLocaleString()}원</div>
                              </div>
                            )}
                            {payRefundCash > 0 && (
                              <div style={{ background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                                <div style={{ fontSize: 9, color: T.creamMuted }}>환불(현금)</div>
                                <div style={{ fontFamily: SF, fontWeight: 700, fontSize: 12, color: T.red }}>-{payRefundCash.toLocaleString()}원</div>
                              </div>
                            )}
                            {payRefundCredit > 0 && (
                              <div style={{ background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, padding: "6px 8px", textAlign: "center" }}>
                                <div style={{ fontSize: 9, color: T.creamMuted }}>환불(적립금)</div>
                                <div style={{ fontFamily: SF, fontWeight: 700, fontSize: 12, color: T.purple }}>-{payRefundCredit.toLocaleString()}원</div>
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {balance > 0 && (
                        <div style={{ background: T.card, borderRadius: 6, border: `1px solid ${T.red}40`, padding: "6px 10px", marginBottom: 8, display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                          <span style={{ color: T.red, fontWeight: 700 }}>미수금</span>
                          <span style={{ fontFamily: SF, fontWeight: 800, color: T.red }}>{balance.toLocaleString()}원</span>
                        </div>
                      )}

                      {/* 환불 취소 (환불 내역 있을 때) */}
                      {refund > 0 && (
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm(`환불 ${refund.toLocaleString()}원을 취소하고 입금완료 상태로 되돌리시겠습니까?`)) return;
                          try {
                            const orderLogs = await db.fetchOrderLogs(o.id);
                            const creditRefunds = orderLogs.filter(l => l.type === "적립금전환");
                            const creditRestores = orderLogs.filter(l => l.type === "적립금복원");
                            await db.deletePaymentLogsByType(o.id, "현금환불");
                            await db.deletePaymentLogsByType(o.id, "적립금전환");
                            await db.deletePaymentLogsByType(o.id, "적립금복원");
                            for (const l of creditRefunds) await db.deleteCreditsByReason(o.customer, "환불→적립금 전환", l.amount || 0);
                            for (const l of creditRestores) await db.deleteCreditsByReason(o.customer, "환불로 복원", l.amount || 0);
                            await db.updateOrder(o.id, { payment: "입금완료", refund_note: "" });
                            const freshCredits = await db.fetchCredits();
                            setCredits(freshCredits);
                            if (reloadOrders) await reloadOrders();
                            await loadData();
                            showToast(`환불 ${refund.toLocaleString()}원 취소 — 입금완료로 복원`);
                          } catch (err) {
                            showToast("환불 취소 실패: " + err.message, "error");
                          }
                        }} style={{ width: "100%", padding: "8px", borderRadius: 8, border: `1px solid ${T.purple}60`, background: "rgba(138,106,184,0.12)", color: T.purple, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: S, marginBottom: 8 }}>
                          ↺ 환불 취소
                        </button>
                      )}

                      {/* 환불 신청 기록 — 진행 중 신청 + 처리된 이력. 신청일시·신청자·사유·환불계좌가
                          승인/반려/취소 후에도 refund_history에 보존되어 여기서 계속 확인 가능 */}
                      {(() => {
                        const pending = (o.payment === "환불신청" && o.refundRequest) ? [{ ...o.refundRequest, result: "대기중" }] : [];
                        const hist = Array.isArray(o.refundHistory) ? o.refundHistory : [];
                        const entries = [...pending, ...[...hist].reverse()]; // 최신이 위
                        if (entries.length === 0) return null;
                        const RES_COLORS = { "대기중": [T.yellow, T.yellowBg], "승인": [T.green, T.greenBg], "반려": [T.red, T.redBg], "취소": [T.creamMuted, T.subtleBg] };
                        const fmtDT = (iso) => iso ? new Date(iso).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
                        return (
                          <div style={{ marginBottom: 8, padding: "10px 12px", background: T.surface, borderRadius: 8, border: `1px solid ${T.red}40` }}>
                            <div style={{ fontSize: 11, fontWeight: 800, color: T.red, marginBottom: 6 }}>💸 환불 신청 기록</div>
                            {entries.map((r, i) => {
                              const [rc, rbg] = RES_COLORS[r.result] || [T.creamMuted, T.subtleBg];
                              return (
                                <div key={i} style={{ padding: "6px 0", borderTop: `1px solid ${T.border}`, fontSize: 11 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                    <span style={{ fontSize: 9, fontWeight: 800, color: rc, background: rbg, padding: "1px 7px", borderRadius: 10, border: `1px solid ${rc}40` }}>{r.result}</span>
                                    <span style={{ color: T.creamMuted, fontFamily: SF }}>{fmtDT(r.requestedAt)}</span>
                                    {r.requestedBy && <span style={{ color: T.creamMuted }}>{r.requestedBy}</span>}
                                    <span style={{ fontWeight: 700, color: r.method === "credit" ? T.purple : T.red }}>{r.method === "credit" ? "🪙 적립금" : "💵 현금"}</span>
                                    <span style={{ color: T.copper, fontWeight: 700 }}>{r.kind === "full" ? "전액" : "부분"}</span>
                                    <span style={{ fontFamily: SF, fontWeight: 800, color: T.red }}>{(r.amount || 0).toLocaleString()}원</span>
                                  </div>
                                  {(r.bank || r.accountNumber || r.accountHolder) && (
                                    <div style={{ marginTop: 3, color: T.cream }}>
                                      🏦 {r.bank || "은행 미기입"} <span style={{ fontFamily: SF, fontWeight: 700 }}>{r.accountNumber || "계좌번호 미기입"}</span>
                                      {r.accountHolder && <span style={{ color: T.creamMuted }}> · {r.accountHolder}</span>}
                                    </div>
                                  )}
                                  {r.reason && <div style={{ marginTop: 2, color: T.creamMuted }}>💬 {r.reason}</div>}
                                  {r.result !== "대기중" && r.processedAt && (
                                    <div style={{ marginTop: 2, fontSize: 10, color: T.creamMuted }}>
                                      처리 {fmtDT(r.processedAt)}
                                      {r.result === "승인" && r.resolvedMethod ? ` · ${r.resolvedMethod}` : ""}
                                      {r.result === "승인" && r.resolvedAmount > 0 && r.resolvedAmount !== r.amount ? ` ${r.resolvedAmount.toLocaleString()}원` : ""}
                                      {r.result === "반려" && r.rejectReason ? ` · 사유: ${r.rejectReason}` : ""}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}

                      {/* 반품/교환 기록 — 이 주문에 연결된 반품·교환 이력 */}
                      {(returnsByOrder[o.id] || []).length > 0 && (
                        <div style={{ marginBottom: 8, padding: "10px 12px", background: T.surface, borderRadius: 8, border: `1px solid ${T.blue}40` }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: T.blue, marginBottom: 6 }}>↩️ 반품/교환 기록</div>
                          {(returnsByOrder[o.id] || []).map(r => (
                            <div key={r.id} style={{ padding: "6px 0", borderTop: `1px solid ${T.border}`, fontSize: 11 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", color: T.creamMuted }}>
                                <span>{String(r.createdAt || "").slice(0, 10)}</span>
                                <span style={{ fontWeight: 800, color: r.status === "완료" ? T.green : T.yellow }}>{r.status}</span>
                                {r.manager && <span>{r.manager}</span>}
                                {r.restocked && <span style={{ color: T.green, fontWeight: 700 }}>재고복구</span>}
                                {/* 반품 취소 — 아직 입고 전(신청/수거중)인 건은 기록만 삭제 */}
                                {(r.status === "반품신청" || r.status === "수거중") && !r.restocked && (
                                  <button onClick={async (e) => {
                                    e.stopPropagation();
                                    const lock = checkOrderLock(o, activeManager, managers, allOrders);
                                    if (lock) { showToast?.(lock, "error"); return; }
                                    if (!window.confirm(`${r.customer} 반품 신청을 취소할까요?`)) return;
                                    try {
                                      await db.deleteReturn(r.id);
                                      setReturnsByOrder(p => ({ ...p, [o.id]: (p[o.id] || []).filter(x => x.id !== r.id) }));
                                      showToast?.("반품 신청 취소됨");
                                    } catch (err) { showToast?.("취소 실패: " + err.message, "error"); }
                                  }} style={{ marginLeft: "auto", padding: "2px 9px", fontSize: 10, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.red}40`, background: T.redBg, color: T.red, cursor: "pointer", fontFamily: S }}>
                                    반품 취소
                                  </button>
                                )}
                                {/* 취소하고 다시 — 입고/완료(교환 포함)된 건 전체 원복: 복구 재고 회수 + 차액 원복 + 기록 삭제 */}
                                {(r.status === "반품입고" || r.status === "완료") && (
                                  <button onClick={async (e) => {
                                    e.stopPropagation();
                                    if (!isAdmin) { showToast?.("반품입고 이후 취소는 관리자만 가능합니다", "error"); return; }
                                    const hasEx = (r.exchangeItems || []).length > 0;
                                    const diff = r.exchangeDiff ?? 0;
                                    let msg = `${r.customer} 반품${hasEx ? "/교환" : ""} 건을 완전히 취소할까요?\n`;
                                    if (r.restocked) msg += "\n· 복구했던 재고를 다시 차감합니다";
                                    if (hasEx && diff > 0) msg += `\n· 원 주문에 가산된 차액 ${diff.toLocaleString()}원을 차감합니다`;
                                    if (hasEx && diff < 0) msg += "\n· 차액 환불신청을 이미 했다면 정산관리에서 별도로 취소하세요";
                                    msg += "\n· 기록이 삭제되어 처음부터 다시 등록할 수 있습니다";
                                    if (!window.confirm(msg)) return;
                                    try {
                                      // 1) 재고 복구 취소 — 복구했던 수량을 재차감 (등록된 재고만)
                                      if (r.restocked) {
                                        const t = nowT();
                                        for (const it of (r.items || [])) {
                                          const noKey = (it.itemNo || "").trim().toLowerCase();
                                          const match = (inv || []).find(v => noKey ? (v.item_no || "").toLowerCase() === noKey : (v.fabric === it.fabric && (v.color || "") === (it.color || "")));
                                          if (match) {
                                            const newStock = Math.max(0, (parseFloat(match.stock) || 0) - (parseFloat(it.qty) || 0));
                                            await db.updateInventoryItem(match.id, { stock: newStock });
                                            await db.insertLog({ date: t.date, time: t.time, type: "반품취소", itemNo: it.itemNo || "", fabric: it.fabric || "", color: it.color || "", qty: it.qty || 0, ref: `반품취소 #${String(r.orderId || "").slice(0, 8)}`, note: "반품 취소 — 복구 재고 회수" });
                                          }
                                        }
                                      }
                                      // 2) 교환 차액(양수) 원복
                                      if (hasEx && diff > 0) {
                                        const curTotal = o.totalAmount > 0 ? o.totalAmount : (o.items || []).reduce((s, i) => s + (i.amount || 0), 0);
                                        const newTotal = Math.max(0, curTotal - diff);
                                        await db.updateOrder(o.id, { total_amount: newTotal });
                                        setAllOrders(p => p.map(x => x.id === o.id ? { ...x, totalAmount: newTotal } : x));
                                        setOrders?.(p => p.map(x => x.id === o.id ? { ...x, totalAmount: newTotal } : x));
                                      }
                                      // 3) 기록 삭제
                                      await db.deleteReturn(r.id);
                                      setReturnsByOrder(p => ({ ...p, [o.id]: (p[o.id] || []).filter(x => x.id !== r.id) }));
                                      showToast?.("반품/교환 취소 완료 — 처음부터 다시 등록할 수 있습니다");
                                    } catch (err) { console.error(err); showToast?.("취소 실패: " + err.message, "error"); }
                                  }} style={{ marginLeft: "auto", padding: "2px 9px", fontSize: 10, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.red}40`, background: T.redBg, color: T.red, cursor: "pointer", fontFamily: S }}>
                                    ↩ 취소하고 다시
                                  </button>
                                )}
                              </div>
                              <div style={{ color: T.cream, marginTop: 2 }}>
                                반품: {(r.items || []).map(it => `${it.fabric || "?"}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`).join(", ") || "—"}
                              </div>
                              {(r.exchangeItems || []).length > 0 && (
                                <div style={{ color: T.blue, fontWeight: 600, marginTop: 2 }}>
                                  교환: {r.exchangeItems.map(it => `${it.fabric || "?"}${it.color ? ` ${it.color}` : ""} ${it.qty}${it.unit || "마"}`).join(", ")}
                                  {(r.exchangeDiff ?? 0) !== 0 && <span style={{ color: r.exchangeDiff > 0 ? T.red : T.blue }}> · 차액 {(r.exchangeDiff > 0 ? "+" : "") + r.exchangeDiff.toLocaleString()}원{r.exchangeDiff > 0 ? " (추가 결제)" : " (환불)"}</span>}
                                </div>
                              )}
                              {/* 교환 차액 추가결제 상태 — 미수면 대기 배지 + 바로 입금확인, 완납이면 완료 배지 */}
                              {(r.exchangeDiff ?? 0) > 0 && (() => {
                                const totalAmt = getOrderAmount(o);
                                const dep = o._computed?.depositAmount || 0;
                                const unpaid = Math.max(0, totalAmt - dep);
                                if (unpaid <= 0) return (
                                  <div style={{ marginTop: 3, fontSize: 10, fontWeight: 800, color: T.green }}>✓ 추가결제 완료</div>
                                );
                                const collectAmt = Math.min(unpaid, r.exchangeDiff);
                                return (
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                                    <span style={{ fontSize: 10, fontWeight: 800, color: T.red, background: T.redBg, padding: "2px 8px", borderRadius: 10, border: `1px solid ${T.red}40` }}>⚠ 추가결제 대기 {collectAmt.toLocaleString()}원</span>
                                    <button onClick={async (e) => {
                                      e.stopPropagation();
                                      const lock = checkOrderLock(o, activeManager, managers, allOrders);
                                      if (lock) { showToast?.(lock, "error"); return; }
                                      if (!window.confirm(`${o.customer} 교환 차액 ${collectAmt.toLocaleString()}원 입금을 확인했나요?`)) return;
                                      try {
                                        await db.addPaymentLog(o.id, "입금", collectAmt, `교환 차액 입금 ${collectAmt.toLocaleString()}원`, o.customer);
                                        const logs = await db.fetchOrderLogs(o.id);
                                        const computed = db.calcOrderMoney(logs, totalAmt, o.payment);
                                        if (computed.paymentStatus === "입금완료") await db.updateOrder(o.id, { payment: "입금완료" });
                                        await loadData();
                                        showToast?.(`교환 차액 ${collectAmt.toLocaleString()}원 입금 처리`);
                                      } catch (err) { console.error(err); showToast?.("입금 처리 실패: " + err.message, "error"); }
                                    }} style={{ padding: "2px 9px", fontSize: 10, fontWeight: 700, borderRadius: 6, border: `1px solid ${T.green}60`, background: T.greenBg, color: T.green, cursor: "pointer", fontFamily: S }}>
                                      💰 입금확인
                                    </button>
                                  </div>
                                );
                              })()}
                              {r.reason && <div style={{ color: T.creamMuted, marginTop: 2 }}>사유: {r.reason}</div>}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 반품 신청 — 출고완료된 주문에만 노출 (부분 반품 가능, 입출고 > 반품에서 진행). 본인 담당 주문만 */}
                      {o.status === "출고완료" && (
                        <button onClick={(e) => { e.stopPropagation(); const lock = checkOrderLock(o, activeManager, managers, allOrders); if (lock) { showToast?.(lock, "error"); return; } setReturnModalOrder(o); }}
                          style={{ width: "100%", padding: "8px", borderRadius: 8, border: `1px solid ${T.blue}60`, background: T.blueBg, color: T.blue, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: S, marginBottom: 8 }}>
                          ↩️ 반품 신청
                        </button>
                      )}

                      {/* 환불신청 — 출고완료 + 입금완료 주문만. 물건 회수 없는 환불용 (회수가 필요하면 반품 신청 사용) */}
                      {o.status === "출고완료" && onRefundRequest && o.payment !== "환불신청" && o.payment !== "환불" &&
                        (o.payment === "입금완료" || getPayStatus(o) === "입금완료") && (
                        <button onClick={(e) => { e.stopPropagation(); const lock = checkOrderLock(o, activeManager, managers, allOrders); if (lock) { showToast?.(lock, "error"); return; } onRefundRequest(o); }}
                          style={{ width: "100%", padding: "8px", borderRadius: 8, border: `1px solid ${T.yellow}60`, background: T.yellowBg, color: T.yellow, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: S, marginBottom: 8 }}>
                          💸 환불신청
                        </button>
                      )}

                      {/* 출고취소 — 출고완료만 해제하고 포장완료(출고 직전)로 되돌림.
                          결제·주문 내용은 그대로 두고 재고 복원 + 출고 로그만 삭제 (ErpApp.handleUndoShipOut 재사용).
                          주문 내용을 고치고 싶을 때 전체를 날리는 주문취소 대신 이걸 쓴다. */}
                      {o.status === "출고완료" && onUndoShipOut && (
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          if (!isAdmin) { showToast?.("출고완료/취소는 관리자만 가능합니다", "error"); return; }
                          if (!window.confirm(`${o.customer} 출고완료를 해제하고 포장완료로 되돌리시겠습니까?\n(결제 내역·주문 내용은 그대로 유지됩니다)`)) return;
                          try {
                            await onUndoShipOut(o.id, "포장완료");
                            setAllOrders(p => p.map(x => x.id === o.id ? { ...x, status: "포장완료", shippedAt: null } : x));
                            await loadData();
                          } catch (err) {
                            showToast?.("출고취소 실패: " + err.message, "error");
                          }
                        }} style={{ width: "100%", padding: "8px", borderRadius: 8, border: `1px solid ${T.copper}60`, background: T.copperGlow, color: T.copper, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: S, marginBottom: 8 }}>
                          📦 출고취소 — 내용은 그대로, 출고완료만 해제
                        </button>
                      )}

                      {/* 주문 취소 — 출고완료된 주문에만 노출 (주문현황으로 되돌림, 모든 결제/출고 내역 삭제) */}
                      {o.status === "출고완료" && (
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          if (!window.confirm(`${o.customer} 주문을 주문현황으로 되돌리시겠습니까?\n(출고 내역·결제 내역도 함께 삭제됩니다)`)) return;
                          // 포장 기록이 남아 있으면 되돌아간 주문이 포장탭에 '포장됨'으로 다시 나타나 그대로 또 출고될 수 있다.
                          // 원단이 돌아왔으면 조각으로, 아니면 기록만 지우고 되돌린다(2026-10-13 점검).
                          if (!(await settlePackingBefore(o.id, { what: "주문 취소(되돌리기)", by: activeManager }))) { showToast?.("되돌리기를 중단했습니다"); return; }
                          try {
                            const orderLogs = await db.fetchOrderLogs(o.id);
                            let creditUsed = 0, creditRefunded = 0;
                            for (const l of orderLogs) {
                              if (l.type === "적립금차감") creditUsed += l.amount || 0;
                              if (l.type === "적립금복원") creditUsed -= l.amount || 0;
                              if (l.type === "적립금전환") creditRefunded += l.amount || 0;
                            }
                            const creditOps = [];
                            if (creditUsed > 0) creditOps.push(db.insertCredit({ customer: o.customer, amount: creditUsed, type: "적립", reason: "주문취소 — 적립금 복원", manager: activeManager, orderId: o.id }));
                            if (creditRefunded > 0) creditOps.push(db.insertCredit({ customer: o.customer, amount: creditRefunded, type: "사용", reason: "주문취소 — 환불 적립금 회수", manager: activeManager, orderId: o.id }));
                            const creditResults = await Promise.all(creditOps);
                            if (creditResults.length > 0) setCredits(p => [...creditResults.filter(Boolean), ...p]);
                            await Promise.all([
                              db.updateOrder(o.id, { status: "접수", payment: "미입금", payment_status: "pending", deposit_amount: 0, balance_amount: 0, refund_amount: 0, refund_note: "", shipped_at: null }),
                              db.deleteLogsByRef(o.id),
                              db.deletePaymentLogsByType(o.id, "입금"),
                              db.deletePaymentLogsByType(o.id, "현금환불"),
                              db.deletePaymentLogsByType(o.id, "적립금전환"),
                              db.deletePaymentLogsByType(o.id, "적립금차감"),
                              db.deletePaymentLogsByType(o.id, "적립금복원"),
                            ]);
                            if (reloadOrders) await reloadOrders();
                            await loadData();
                            showToast("주문현황으로 이동됨");
                          } catch (err) {
                            showToast("실패: " + err.message, "error");
                          }
                        }} style={{ width: "100%", padding: "8px", borderRadius: 8, border: `1px solid ${T.red}40`, background: T.redBg, color: T.red, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: S, marginBottom: 8 }}>
                          주문취소 — 결제·출고 내역까지 모두 삭제
                        </button>
                      )}

                      <div style={{ textAlign: "center", marginTop: 8 }}>
                        <button onClick={(e) => { e.stopPropagation(); setExpandedId(null); }} style={{
                          padding: "6px 20px", borderRadius: 8, border: `1px solid ${T.border}`,
                          background: "transparent", color: T.creamMuted, fontSize: 11, fontWeight: 600,
                          cursor: "pointer", fontFamily: S,
                        }}>닫기</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* 페이지네이션 */}
            {(sorted.length > 10 || totalPages > 1) && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: `1px solid ${T.border}`, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 11, color: T.creamMuted, marginRight: 4 }}>보기:</span>
                  {[10, 30, 50].map(n => (
                    <button key={n} onClick={() => setPageSize(n)} style={{
                      padding: "4px 10px", borderRadius: 6,
                      border: `1px solid ${pageSize === n ? T.copper : T.border}`,
                      background: pageSize === n ? T.copperGlow : "transparent",
                      color: pageSize === n ? T.copper : T.creamMuted,
                      fontSize: 11, fontWeight: pageSize === n ? 700 : 500,
                      cursor: "pointer", fontFamily: S,
                    }}>{n}</button>
                  ))}
                </div>

                {totalPages > 1 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <button onClick={() => setPage(1)} disabled={page === 1} style={{
                      padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                      background: page === 1 ? "transparent" : T.surface, color: page === 1 ? T.border : T.creamMuted,
                      fontSize: 11, cursor: page === 1 ? "default" : "pointer", fontFamily: S,
                    }}>«</button>
                    <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={{
                      padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                      background: page === 1 ? "transparent" : T.surface, color: page === 1 ? T.border : T.creamMuted,
                      fontSize: 11, cursor: page === 1 ? "default" : "pointer", fontFamily: S,
                    }}>‹</button>
                    <span style={{ fontSize: 12, color: T.cream, fontFamily: SF, fontWeight: 700, padding: "0 8px" }}>
                      {page} / {totalPages}
                    </span>
                    <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={{
                      padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                      background: page === totalPages ? "transparent" : T.surface, color: page === totalPages ? T.border : T.creamMuted,
                      fontSize: 11, cursor: page === totalPages ? "default" : "pointer", fontFamily: S,
                    }}>›</button>
                    <button onClick={() => setPage(totalPages)} disabled={page === totalPages} style={{
                      padding: "6px 10px", borderRadius: 6, border: `1px solid ${T.border}`,
                      background: page === totalPages ? "transparent" : T.surface, color: page === totalPages ? T.border : T.creamMuted,
                      fontSize: 11, cursor: page === totalPages ? "default" : "pointer", fontFamily: S,
                    }}>»</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Summary Footer ── */}
      <Card style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            합계 <span style={{ fontFamily: SF, fontWeight: 800, color: T.copper, marginLeft: 4 }}>{filtered.length}</span>
            <span style={{ fontSize: 11, color: T.creamMuted, marginLeft: 2 }}>건</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>
            <span style={{ fontFamily: SF, fontWeight: 800, color: T.copper }}>{filteredTotal.toLocaleString()}</span>
            <span style={{ fontSize: 11, color: T.creamMuted, marginLeft: 2 }}>원</span>
          </div>
        </div>
      </Card>

      {/* ↩️ 반품 신청 모달 */}
      {returnModalOrder && (
        <ReturnRegisterModal
          order={returnModalOrder}
          activeManager={activeManager}
          showToast={showToast}
          onClose={() => setReturnModalOrder(null)}
          onCreated={(saved) => {
            // 등록 즉시 반품 목록에 반영 → 출고 상태 태그가 바로 '반품신청'으로 바뀜
            if (saved?.orderId) setReturnsByOrder(p => ({ ...p, [saved.orderId]: [saved, ...(p[saved.orderId] || [])] }));
          }}
        />
      )}
    </div>
  );
}
