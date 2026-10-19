// 새 UI 의 데이터 한곳 — 지시서 4절의 계약 함수만 부른다. 화면은 여기서 받은 것만 그린다.
//
// 옛 ErpApp 이 하던 초기 로드·실시간 구독·다시 읽기(번호 붙여 낡은 응답 버리기)를 같은 방식으로 옮겼다.
// 한 세션의 작업자(activeManager)는 옛 화면과 같은 localStorage 'erp_manager' 를 쓴다 — 두 화면을 오가도 같은 사람이다.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as db from "../../lib/db.js";
import { useUserId, useRealtimeOrdersAndPayments, useRealtimeCustomers, useRealtimeCredits, useRealtimeProducts, useRealtimeStockRolls } from "../../lib/realtime.js";
import { preloadHolidays } from "../../lib/shipDate.js";
import { courierMap, setPickupCutoffs } from "../../lib/courier.js";
import { groupRollsByProduct } from "../../lib/rollStock.js";
import { isHold, isParked, getPayStatus } from "../../constants.js";
import { buildOverview } from "../../lib/overview.js";
import { monthRange } from "../lib/metrics.js";
import { resolveConfig } from "../config.js";
import { subscriptionState, pinNeeded } from "../lib/subscription.js";

const Ctx = createContext(null);
export const useSaas = () => useContext(Ctx);

const MANAGER_KEY = "erp_manager";
const SCOPE_KEY = "erp_overview_scope";   // 옛 OverviewTab 과 같은 키 — 범위 선택을 두 화면이 공유한다
const PIN_AT_KEY = "erp_manager_pin_at";   // 마지막 PIN 확인 시각(ms) — 담당자 이름과 짝
const PIN_PINNED_KEY = "erp_manager_pinned"; // "1" 이면 이 기기에 담당자 고정(한 번 확인하면 다시 묻지 않음 — 포장 패드)
const readLS = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const writeLS = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch {} };
const readScope = () => { try { const v = localStorage.getItem(SCOPE_KEY); return v === "all" || v === "mine" ? v : null; } catch { return null; } };

export function SaasDataProvider({ children }) {
  const userId = useUserId();
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [managers, setManagers] = useState([]);
  const [settings, setSettings] = useState(null);
  const [products, setProducts] = useState([]);
  const [rolls, setRolls] = useState([]);           // 끝난 롤(판매 완료·폐기)까지 전부 — 재고량 바의 분모(입고 총 길이)에 쓴다
  const [credits, setCredits] = useState([]);
  const [freeShipping, setFreeShipping] = useState([]);
  const [returns, setReturns] = useState([]);
  const [paymentLogs, setPaymentLogs] = useState([]); // 최근 6개월 — 이번 달 매출·월별 매출
  const [shipped, setShipped] = useState([]);         // 최근 60일 출고완료 — 이번 주 차트·이번 달 판매
  const [overviewMates, setOverviewMates] = useState([]);
  const [account, setAccount] = useState(null);       // company_accounts 행(없으면 null = 사내 계정)
  const [pinStatus, setPinStatus] = useState([]);     // [{manager_id, has_pin, locked_until}]
  const [loaded, setLoaded] = useState(false);
  const [syncLost, setSyncLost] = useState(false);
  const [error, setError] = useState(null);

  const [activeManager, _setActiveManager] = useState(() => readLS(MANAGER_KEY));
  // PIN 확인 시각 — 담당자가 바뀌면 0 으로(다른 사람 PIN 으로 통과한 기록을 물려받지 않게)
  const [pinVerifiedAt, _setPinVerifiedAt] = useState(() => Number(readLS(PIN_AT_KEY)) || 0);
  const [pinned, _setPinned] = useState(() => readLS(PIN_PINNED_KEY) === "1");
  const setActiveManager = useCallback((name) => {
    const n = name || "";
    _setActiveManager(n);
    writeLS(MANAGER_KEY, n);
    _setPinVerifiedAt(0); writeLS(PIN_AT_KEY, "");
    db.revokeManagerToken();   // 다른 사람 토큰을 물려받지 않는다
  }, []);
  // token: verify_manager_pin 이 준 담당자 토큰(없으면 PIN 없는 담당자·건너뛰기 — 관리자 작업은 DB 가 막는다)
  const markPinVerified = useCallback((token) => {
    const t = Date.now(); _setPinVerifiedAt(t); writeLS(PIN_AT_KEY, String(t));
    if (token) db.setManagerToken(token);
  }, []);
  const setPinned = useCallback((v) => { _setPinned(!!v); writeLS(PIN_PINNED_KEY, v ? "1" : ""); }, []);
  const manager = useMemo(() => managers.find(m => m.name === activeManager) || null, [managers, activeManager]);
  const isAdmin = !!manager?.isAdmin;
  const isPacker = !!manager && !!manager.isPacker && !manager.isAdmin;
  // 변경 기록용 도장 — 누가 바꿨는지(lib/db.js 참고)
  db.setActor(activeManager);

  const [scopeSaved, setScopeSaved] = useState(readScope);
  const overviewScope = scopeSaved || (isAdmin ? "all" : "mine");
  const setOverviewScope = useCallback((v) => { setScopeSaved(v); try { localStorage.setItem(SCOPE_KEY, v); } catch {} }, []);

  // ── 다시 읽기 ─────────────────────────────────────────────
  const seqRef = useRef(0), appliedRef = useRef(0);
  const reloadOrders = useCallback(async () => {
    const seq = ++seqRef.current;
    try {
      const o = await db.fetchOrdersWithMoney();
      if (seq <= appliedRef.current) return;
      appliedRef.current = seq;
      setOrders(o); setSyncLost(false);
    } catch (e) { console.error("[saas] 주문 다시 읽기 실패", e); setSyncLost(true); }
  }, []);
  const reloadCustomers = useCallback(async () => { try { const c = await db.fetchCustomers(); if (c.length) setCustomers(c); } catch (e) { console.warn("[saas] 고객", e); } }, []);
  const reloadProducts = useCallback(async () => { try { setProducts(await db.fetchProducts()); } catch (e) { console.warn("[saas] 품번", e); } }, []);
  const reloadRolls = useCallback(async () => { try { setRolls(await db.fetchRolls({ status: "all" })); } catch (e) { console.warn("[saas] 롤", e); } }, []);
  const reloadCredits = useCallback(async () => { try { setCredits(await db.fetchCredits()); } catch (e) { console.warn("[saas] 적립금", e); } }, []);
  const reloadFreeShipping = useCallback(async () => { try { setFreeShipping(await db.getAllFreeShipping()); } catch (e) { console.warn("[saas] 배송권", e); } }, []);
  const reloadReturns = useCallback(async () => { try { setReturns(await db.fetchReturns()); } catch (e) { console.warn("[saas] 반품", e); setReturns([]); } }, []);
  const reloadManagers = useCallback(async () => { try { setManagers(await db.fetchManagers()); } catch (e) { console.warn("[saas] 담당자", e); } }, []);
  const reloadAccount = useCallback(async () => { try { setAccount(await db.fetchCompanyAccount()); } catch (e) { console.warn("[saas] 회사 계정", e); } }, []);
  const reloadPinStatus = useCallback(async () => { try { setPinStatus(await db.fetchManagerPinStatus()); } catch (e) { console.warn("[saas] PIN 상태", e); } }, []);
  const reloadSettings = useCallback(async () => { try { setSettings(await db.fetchSettings()); } catch (e) { console.warn("[saas] 설정", e); } }, []);
  const reloadMoney = useCallback(async () => {
    const now = new Date();
    const since6 = monthRange(now, -5).start.toISOString();
    const since60 = new Date(now.getTime() - 60 * 86400000).toISOString();
    try { setPaymentLogs(await db.fetchPaymentLogsBetween(since6, null)); } catch (e) { console.warn("[saas] 입금 로그", e); }
    try { setShipped(await db.fetchShippedOrdersSince(since60)); } catch (e) { console.warn("[saas] 출고완료", e); }
  }, []);

  // ── 초기 로드 ─────────────────────────────────────────────
  useEffect(() => {
    preloadHolidays().catch(() => {});
    (async () => {
      try {
        const [o, c, m, s, a, p] = await Promise.all([
          db.fetchOrdersWithMoney().catch(e => { console.error("[saas] 주문 로드 실패", e); setSyncLost(true); if (e?.code === "AUTH_LOST") setError(e.message); return []; }),
          db.fetchCustomers().catch(() => []),
          db.fetchManagers().catch(() => []),
          db.fetchSettings().catch(() => null),
          db.fetchCompanyAccount().catch(() => null),
          db.fetchManagerPinStatus().catch(() => []),
        ]);
        appliedRef.current = Math.max(appliedRef.current, 1);
        if (o.length) setOrders(o);
        setCustomers(c); setManagers(m); setSettings(s); setAccount(a); setPinStatus(p);
      } finally { setLoaded(true); }
      // 나머지는 뒤에 — 첫 화면이 주문·담당자만 있으면 뜬다
      await Promise.all([reloadProducts(), reloadRolls(), reloadCredits(), reloadFreeShipping(), reloadReturns(), reloadMoney()]);
    })();
  }, [reloadProducts, reloadRolls, reloadCredits, reloadFreeShipping, reloadReturns, reloadMoney]);

  // ── 실시간 ────────────────────────────────────────────────
  useRealtimeOrdersAndPayments(userId, { onAny: () => { reloadOrders(); reloadMoney(); } });
  useRealtimeCustomers(userId, { onInsert: reloadCustomers, onUpdate: reloadCustomers, onDelete: reloadCustomers, onResubscribe: reloadCustomers });
  useRealtimeCredits(userId, { onInsert: reloadCredits, onUpdate: reloadCredits, onDelete: reloadCredits });
  useRealtimeProducts(userId, { onAny: reloadProducts });
  useRealtimeStockRolls(userId, { onAny: reloadRolls });

  // 깨어날 때(탭 복귀·네트워크 복귀) 다시 읽기 — 30초 안에 읽었으면 건너뛴다(옛 ErpApp 과 같은 규칙)
  const lastWake = useRef(0);
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastWake.current < 30000) return;
      lastWake.current = now;
      reloadOrders(); reloadRolls(); reloadCustomers();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => { document.removeEventListener("visibilitychange", wake); window.removeEventListener("focus", wake); window.removeEventListener("online", wake); };
  }, [reloadOrders, reloadRolls, reloadCustomers]);

  // ── 파생값 ────────────────────────────────────────────────
  const courierById = useMemo(() => courierMap(orders), [orders]);
  const groups = useMemo(() => groupRollsByProduct(products, rolls), [products, rolls]);
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);

  // 합배송 묶음 중 이미 나간 건 — 묶음별 남은 건수가 바뀔 때만 다시 읽는다(옛 ErpApp 의 overviewGroupKey)
  const groupKey = useMemo(() => {
    const left = new Map();
    for (const o of orders) {
      if (!o.mergeGroupId || o.splitShipping || o.status === "출고완료") continue;
      left.set(o.mergeGroupId, (left.get(o.mergeGroupId) || 0) + 1);
    }
    return [...left].map(([g, n]) => `${g}:${n}`).sort().join(",");
  }, [orders]);
  const reloadMates = useCallback(async () => {
    const ids = groupKey ? groupKey.split(",").map(s => s.split(":")[0]) : [];
    try { setOverviewMates(await db.fetchShippedGroupMates(ids)); } catch (e) { console.warn("[saas] 묶음 출고", e); }
  }, [groupKey]);
  useEffect(() => { reloadMates(); }, [reloadMates]);

  // 전체현황(lib/overview.js) — 수거 마감이 지나면 숫자가 바뀌어야 해서 30초마다 시계를 돌린다
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNowTs(Date.now()), 30000); return () => clearInterval(t); }, []);
  const mineOn = overviewScope === "mine" && !!activeManager;
  const overviewOrders = useMemo(() => mineOn ? orders.filter(o => o.manager === activeManager) : orders, [orders, mineOn, activeManager]);
  const overview = useMemo(() => buildOverview(overviewOrders, overviewMates, {
    isHold, isParked, getPayStatus,
    courierOf: (o) => courierById.get(o.id)?.courier, isPickup: (o) => !!courierById.get(o.id)?.pickup,
  }, new Date(nowTs)), [overviewOrders, overviewMates, courierById, nowTs]);

  // 회사별 설정·구독 상태·PIN 게이트
  const config = useMemo(() => resolveConfig(settings, account), [settings, account]);
  useEffect(() => { setPickupCutoffs(config.pickupCutoff); }, [config.pickupCutoff]);   // 출고예정일·전체현황이 이 마감을 쓴다
  const subscription = useMemo(() => subscriptionState(account, new Date(nowTs)), [account, nowTs]);
  const readOnly = subscription.readOnly;   // 만료 — DB 가 쓰기를 막는다(saas_readonly_when_expired.sql). 화면은 버튼을 숨기고 안내한다
  const pinOf = useCallback((m) => pinStatus.find(p => p.manager_id === m?.id) || null, [pinStatus]);
  const managerHasPin = !!pinOf(manager)?.has_pin;
  const pinRequired = !!manager && !manager.isPublic && pinNeeded({ hasPin: managerHasPin, verifiedAt: pinVerifiedAt, pinned, now: nowTs });

  const value = {
    userId, loaded, syncLost, error,
    account, subscription, readOnly, config, reloadAccount, reloadSettings, reloadManagers,
    pinStatus, pinOf, managerHasPin, pinRequired, pinVerifiedAt, markPinVerified, pinned, setPinned, reloadPinStatus,
    orders, setOrders, customers, setCustomers, managers, settings, products, rolls, groups, productById,
    credits, setCredits, freeShipping, returns, setReturns, paymentLogs, shipped, overviewMates,
    activeManager, setActiveManager, manager, isAdmin, isPacker,
    overviewScope, setOverviewScope, overview, mineOn,
    courierById,
    reloadOrders, reloadCustomers, reloadProducts, reloadRolls, reloadCredits, reloadFreeShipping, reloadReturns, reloadMoney, reloadMates,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
