import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx-js-style";
import { G, GL, SF, S, baseInp, dlXlsx, sC, pC, getPayStatus, isHold, isParked, isFabricMissing, missingItemIdx, fabricWaitMins, nowT, stripCardDup, ThemeCtx } from "./constants.js";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, CuteLoader, CuteFullLoader } from "./components/UI.jsx";
import OrderInput from "./components/OrderInput.jsx";
import DepositTab from "./components/DepositTab.jsx";
import { InoutForm } from "./components/InoutForm.jsx";
import InspectionTab from "./components/InspectionTab.jsx";
import RollStockTab from "./components/RollStockTab.jsx";
import CustomerTab from "./components/CustomerTab.jsx";
import DashboardTab from "./components/DashboardTab.jsx";
import ExcelImport from "./components/ExcelImport.jsx";
import ManagerSettings from "./components/ManagerSettings.jsx";
import SideScroller from "./components/SideScroller.jsx";
import LinkPreview from "./components/LinkPreview.jsx";
import RefundRequestModal from "./components/RefundRequestModal.jsx";
import DataManagement from "./components/DataManagement.jsx";
import { MergeModal, FreightModal } from "./components/MergeModal.jsx";
import ReturnsTab from "./components/ReturnsTab.jsx";
import { settlePackingBefore, settleMessage } from "./lib/packingGuard.js";
import StatementTab from "./components/StatementTab.jsx";
import * as db from "./lib/db.js";
import { supabase } from "./lib/supabase.js";
import { deleteOrderImages, uploadOrderImages } from "./lib/storage.js";
import { checkOrderLock, checkAdminOnly, getManagerDisplay, isPacker } from "./lib/managerLock.js";
import { preloadHolidays } from "./lib/shipDate.js";
import PackingTab from "./components/PackingTab.jsx";
import NoticeTab from "./components/NoticeTab.jsx";
import OverviewTab, { SCOPE_KEY as OVERVIEW_SCOPE_KEY, readScope as readOverviewScope, scopeOrders as scopeOverviewOrders } from "./components/OverviewTab.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { InvoicePanel, ShippingModal } from "./components/InvoicePanel.jsx";
import { buildOverview } from "./lib/overview.js";
import { CJ, COURIERS, COURIER_SHORT, legacyCourierMap as courierMap } from "./lib/courier.js";
import { CourierTag, PickupTag } from "./components/Courier.jsx";
import { printFabricLabels, printThanksLabels } from "./lib/labelPrint.js";
import { printRollLabels } from "./lib/rollLabelPrint.js";
import { summarizeRolls } from "./lib/rollStock.js";
import { indexPacking } from "./lib/packing.js";
import { patchOrdersWithGroupResult } from "./lib/freight.js";
import {
  useUserId,
  useRealtimeProducts,
  useRealtimeStockRolls,
  useRealtimeItemPacking,
  useRealtimeLinkDrafts,
  useRealtimeOrdersAndPayments,
  useRealtimeInventory,
  useRealtimeCustomers,
  useRealtimeCredits,
  useRealtimeOrderNotes,
  useRealtimeNotices,
  useRealtimeLabelStation,
  useRealtimeThanksRequests,
  rowToCustomerCamel,
  rowToOrderNoteCamel,
} from "./lib/realtime.js";

// 관리자의 송장출력 탭 — 당분간 숨긴다(2026-09-29). 송장은 주문현황의 '송장 출력' 버튼으로 뽑는다.
// 화면과 코드는 그대로 두었다. true 로 바꾸면 탭이 다시 나온다.
const SHOW_INVOICE_TAB = false;

function ErpApp() {
  // ── 기본값 ─────────────────────────────────────────────────
  const DEFAULT_INV = [];
  const DEFAULT_SETTINGS = {kakaoWebhook:"",lowStockAlert:10,kakaoEnabled:false,senderName:"로하이마켓",senderPhone:"",senderAddr:"서울 중구 동대문 원단시장",anthropicKey:""};
  const DEFAULT_MANAGERS = [];

  const APP_VERSION = "v2.1";

  const [tab, _setTab] = useState(()=>parseInt(localStorage.getItem("erp_tab"))||0);
  const setTab = (v)=>{ const n = typeof v==="function"?v(tab):v; _setTab(n); localStorage.setItem("erp_tab",n); };
  const [loaded, setLoaded] = useState(false);
  const [newerUrl, setNewerUrl] = useState(null);
  const [orders, setOrders] = useState([]);
  // 서버에서 주문을 다시 못 읽어온 상태. 화면의 숫자가 지금 이 순간의 사실이 아니라는 뜻이다.
  // 포장 화면은 이 값으로 배너를 띄운다 — 0건과 '못 읽었다'는 반드시 달라 보여야 한다.
  const [syncLost, setSyncLost] = useState(false);
  const [inv, setInv] = useState(DEFAULT_INV);
  const [logs, setLogs] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [credits, setCredits] = useState([]);
  const [freeShipping, setFreeShipping] = useState([]);
  const [notes, setNotes] = useState([]); // 주문 메모/피드
  const [noteToRegister, setNoteToRegister] = useState(null); // 메모→주문입력 핸드오프
  // 링크 주문 초안(4단계) — 공개 페이지가 넣은 것. 주문입력 탭 상단 카드에 보이고, 전환은 메모와 같은 핸드오프.
  const [linkDrafts, setLinkDrafts] = useState([]);
  const [draftToConvert, setDraftToConvert] = useState(null);
  const [notices, setNotices] = useState([]);                // 공지판(입금-미등록)
  const SETTINGS_KEY = 'erp_settings_v1';
  const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  const [settings, setSettings] = useState({...DEFAULT_SETTINGS, ...savedSettings});
  const [managers, setManagers] = useState(DEFAULT_MANAGERS);
  // QR 롤 재고 — 품번(products)과 롤(stock_rolls). 끝난 롤(판매 완료·폐기)은 여기 없다.
  // (migrations/add_stock_rolls.sql)
  const [products, setProducts] = useState([]);
  const [rolls, setRolls] = useState([]);
  // 품목별 포장 기록(order_item_packing) — 포장대에서 롤을 찍은 결과. 출고 전 주문 것만 든다.
  // packingReady: 그 테이블이 있는가. 마이그레이션 전 DB 면 false — 포장 화면이 옛 방식으로 돈다.
  // (migrations/add_item_packing.sql)
  const [packingRecords, setPackingRecords] = useState([]);
  const [packingReady, setPackingReady] = useState(true);
  const [theme, setTheme] = useState(()=>localStorage.getItem("erp_theme")||"light");
  const [fontScale, setFontScale] = useState(()=>parseInt(localStorage.getItem("erp_fontScale"))||0);
  const [toast, setToast] = useState({msg:"",type:"ok"});
  const T = theme==="dark" ? G : GL;
  const zoomLevel = 1.05 + fontScale * 0.025; // 0 기준 = 1.05(현재보다 약간 크게), -10=0.80, +10=1.30
  // 글씨 확대는 CSS zoom 이라 미디어쿼리는 실제 폭(예: 390px)을 보지만, 배치는 390/1.3≈300px 폭에서
  // 이뤄진다. 그래서 +10 에서 버튼 글자가 두 줄로 꺾이고 숫자가 잘렸다. 이 '체감 폭'을 클래스로
  // 달아 두고(erp-narrow ≤520, erp-tight ≤360) 좁은 화면 규칙이 확대 배율을 따라오게 한다.
  const [viewportW, setViewportW] = useState(()=>window.innerWidth);
  useEffect(()=>{ const f=()=>setViewportW(window.innerWidth); window.addEventListener("resize",f); return ()=>window.removeEventListener("resize",f); },[]);
  const effectiveW = viewportW / zoomLevel;
  const narrowCls = effectiveW<=360 ? " erp-narrow erp-tight" : effectiveW<=520 ? " erp-narrow" : "";
  // 휴대폰에서는 '입고' 버튼을 맨 위 검은 바(로하이마켓 ERP · 로그아웃) 가운데로 올린다(2026-10-02).
  // 그 바는 AppEntry 에 있어서 거기 비워 둔 자리(#app-top-slot)에 그려 넣는다. 자리가 없으면(체험판 등) 헤더에 둔다.
  const isNarrow = effectiveW <= 520;
  const [topSlot, setTopSlot] = useState(null);
  useEffect(() => { setTopSlot(document.getElementById("app-top-slot")); }, []);
  const inspectOnTop = isNarrow && !!topSlot;
  const [editingOrder, setEditingOrder] = useState(null);
  const [editingInv, setEditingInv] = useState(null);
  const [editingCust, setEditingCust] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [shippingOpen, setShippingOpen] = useState(false);
  const [imageViewer, setImageViewer] = useState(null); // {images: string[], index: number}
  // 원단 호출 배너 — 펼침 여부와, '확인'으로 접어둔 호출 지문(내 화면에서만)
  const [fabricOpen, setFabricOpen] = useState(false);
  const [fabricDismissed, setFabricDismissed] = useState("");
  // '몇 분째'를 세려면 주기적으로 다시 그려야 한다. 30초면 분 표시가 1분 이상 안 틀린다.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  // 입출고 서브탭 표시 여부 — 입고·재고현황·내역은 당분간 미사용이라 가림.
  // 기능·코드는 그대로 유지, true로 바꾸면 원래대로 전부 표시됨.
  // (자동출고는 없앴다 — 출고완료 버튼과 달리 합배송 묶음·출고 시각·중복 방지를 전부
  //  건너뛰어서, 다시 켜면 그 길로 나간 주문이 미아가 된다. 출고는 handleShipOut 하나로 한다.)
  // 입고·검단(inspect)과 롤 재고(rolls)는 옛 입고·재고현황을 대신하는 새 화면이다.
  // 옛 것은 '원단 종류당 수량 하나'라 쓰이지 않았고, 새 것은 롤 하나를 한 줄로 센다.
  const SHOW_IO_ALL_TABS = false;
  const IO_VISIBLE_TABS = SHOW_IO_ALL_TABS
    ? ["in","rolls","returns","holding","statement","inspect","stock","history"]
    : ["rolls","returns"];   // 입고·검단은 헤더 버튼(INSPECT_TAB)으로 옮겼다. 보관·명세서는 2026-10-08 사용자 지시로 숨김 — 코드는 그대로, 다시 필요하면 "holding","statement" 를 여기 넣으면 된다
  const [ioTab, setIoTab] = useState(SHOW_IO_ALL_TABS ? "in" : "rolls");   // 첫 탭이 곧 기본 탭
  const [returns, setReturns] = useState([]); // 반품 목록 — 입출고 탭 진입 시 로드
  useEffect(() => {
    if (tab !== 2) return;
    let alive = true;
    db.fetchReturns().then(r => { if (alive) setReturns(r); }).catch(e => console.warn("반품 목록 로드 실패:", e));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  // 숨긴 서브탭으로 진입 시(헤더 '부족' 배지 등) 보이는 탭으로 복귀
  useEffect(() => {
    if (!IO_VISIBLE_TABS.includes(ioTab)) setIoTab(IO_VISIBLE_TABS[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ioTab]);
  const [logTypeFilter, setLogTypeFilter] = useState("");
  const [logDateFilter, setLogDateFilter] = useState("");
  const [stockFilter, _setStockFilter] = useState(()=>localStorage.getItem("erp_stock_filter")||"");
  const setStockFilter = v=>{_setStockFilter(v);localStorage.setItem("erp_stock_filter",v);};
  const [stockSearch, setStockSearch] = useState("");
  const [stockSort, _setStockSort] = useState(()=>localStorage.getItem("erp_stock_sort")||"qty_desc");
  const setStockSort = v=>{_setStockSort(v);localStorage.setItem("erp_stock_sort",v);};
  const [selectedOrders, setSelectedOrders] = useState([]);
  // 선택 모드 — null | "label" | "ship". 무엇을 위해 고르는지가 모드에 붙어 있어야
  // 하단 실행 버튼과 전체출력이 같은 뜻으로 움직인다.
  const [selectMode, setSelectMode] = useState(null);
  // 합배송 그룹 배지 클릭 시 펼쳐 보일 그룹 ID (한 번에 하나만)
  const [expandedMergeGroup, setExpandedMergeGroup] = useState(null);
  const [mergeViewOpen, setMergeViewOpen] = useState(false); // 주문현황 '합배송 모아보기' — 묶음별 그룹 카드 뷰
  const [autoMergeUndo, setAutoMergeUndo] = useState(null); // 마지막 '같은 고객 자동 묶기' 결과 [{groupId, ids}] — 되돌리기용
  // ── 라벨 자동 출력 담당 기기 ──────────────────────────────────
  // 직원들은 각자 PC·모바일에서 등록하는데 PS100 은 한 대에만 물려 있다. 인쇄는
  // 브라우저가 하는 일이라 등록한 사람 기기에서만 인쇄창이 뜨므로, 프린터가 붙은
  // 그 한 대가 ERP 를 켜둔 채 새 주문을 실시간으로 받아 대신 뽑는다.
  //
  // 담당은 서버에 한 줄로 못 박는다(label_station). 기기 안에만 두면 ERP 가 어느
  // PC 가 켜져 있는지 몰라서, 엉뚱한 PC 에서 켜진 걸 알아채지도 원격으로 끄지도
  // 못한다 — A4 프린터로 라벨이 나가도 아무도 모른다.
  //
  // 기기 ID 는 브라우저가 처음 켤 때 한 번 만들어 붙박는다. 브라우저 데이터를 지우면
  // 새 ID 가 되는데, 그때는 담당이 아니게 되어 조용히 멈춘다 — 잘못 뽑는 것보다 낫다.
  const deviceId = useMemo(() => {
    let id = localStorage.getItem("erp_device_id");
    if (!id) {
      id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem("erp_device_id", id);
    }
    return id;
  }, []);
  // 서버에 등록된 담당 기기 (null = 아무도 담당이 아님)
  const [labelStationRow, setLabelStationRow] = useState(null);
  const reloadLabelStation = useCallback(async () => {
    try { setLabelStationRow(await db.fetchLabelStation()); }
    catch (e) { console.warn("[라벨담당] 조회 실패", e); }
  }, []);
  // 내가 담당인가 — 라벨이 이 기기에서 나오는 유일한 조건이다.
  // 켠 시각(armedAt)은 더 이상 대상을 고르는 데 쓰지 않는다 — 사람이 요청한 것만
  // 뽑으므로, 켜기 전에 걸린 요청이라고 버릴 이유가 없다(설정 화면 안내 참고).
  const labelStation = !!labelStationRow && labelStationRow.deviceId === deviceId;
  // 담당이 다른 기기라면 여기에 이름이 담긴다. 설정 화면이 이걸 보여줘야
  // "어디서 뽑히고 있는지"를 그 PC 앞까지 가지 않고 알 수 있다.
  const labelStationOther = labelStationRow && !labelStation ? labelStationRow : null;
  const [activeManager, _setActiveManager] = useState(()=>localStorage.getItem("erp_manager")||"");
  const setActiveManager = (v)=>{ const n = typeof v==="function"?v(activeManager):v; _setActiveManager(n); localStorage.setItem("erp_manager",n); };
  const currentManagerObj = managers.find(m => m.name === activeManager) || null;
  // 포장 담당자 여부 — 제한된 권한 (메모/접수·포장완료 상태변경만 허용)
  const isPackerRole = isPacker(activeManager, managers);
  const isAdminRole = !!currentManagerObj?.isAdmin;   // 위에서 쓰는 곳(runPrint 등)보다 먼저 선언해 둔다
  // 셀러 — 관리자·공용·포장 어느 역할도 없는 담당자. 설정에서 화면테마·글씨크기만 노출
  const isSellerRole = !!currentManagerObj && !currentManagerObj.isAdmin && !currentManagerObj.isPublic && !currentManagerObj.isPacker;
  // 설정 탭 축소 대상 — 셀러·포장 담당자는 화면테마·글씨크기만 노출
  const basicSettingsOnly = isSellerRole || isPackerRole;

  // 포장 담당자는 주문입력(0)·정산관리(4) 탭 접근 불가 — 포장 화면으로 이동.
  // 로그인 직후에도 포장 화면이 먼저 보이도록, 다른 탭에서 넘어온 경우도 여기서 잡는다.
  // 탭은 localStorage 에 저장된다 — 포장 담당자가 쓰던 브라우저를 셀러가 열면
  // 7번(포장)에 머물 수 있으므로 되돌려 보낸다.
  useEffect(() => {
    if (isPackerRole && (tab === 0 || tab === 4)) setTab(7);
    if (!isPackerRole && tab === 7) setTab(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPackerRole, tab]);
  // 송장출력(10)은 관리자 전용. 담당자 목록을 다 읽기 전에는 판단하지 않는다 —
  // 그 전에는 누구나 '관리자 아님'이라, 관리자가 새로고침만 해도 주문현황으로 튕긴다.
  // (전체현황(9)은 2026-09-29 부터 전 직원이 본다 — 여기서 막지 않는다)
  useEffect(() => {
    if (tab === 10 && managers.length > 0 && !currentManagerObj?.isAdmin) setTab(1);
    // 송장출력 탭은 지금 숨겨 두었다(파일 맨 위 SHOW_INVOICE_TAB). 탭은 localStorage 에 저장되므로
    // 그 탭을 보던 관리자는 탭 줄에 없는 화면에 갇힌다 — 주문현황으로 보낸다.
    if (tab === 10 && !SHOW_INVOICE_TAB) setTab(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, managers.length, currentManagerObj?.isAdmin]);
  // 변경 기록용 — 누가(현재 작업자) 주문을 고치는지 db 에 알려둔다. 어느 화면인지는
  // 아래 TABS 가 정해진 뒤에 알린다. (lib/db.js 의 '변경 기록용 도장' 참고)
  db.setActor(activeManager);
  // 포장 담당자로 전환되는 순간 1회만 포장 화면으로 — 이후 탭 이동은 막지 않는다.
  const packerLandedRef = useRef(false);
  useEffect(() => {
    if (isPackerRole && !packerLandedRef.current) { packerLandedRef.current = true; setTab(7); }
    if (!isPackerRole) packerLandedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPackerRole]);
  // 상단 작업자 드롭다운에는 개인 담당자만 노출 (공용은 제외)
  const personalManagers = managers.filter(m => !m.isPublic);
  const [workerDropdownOpen, setWorkerDropdownOpen] = useState(false);
  const [mergeModalOrder, setMergeModalOrder] = useState(null); // 합배송 묶기 시작 주문
  const [freightModal, setFreightModal] = useState(null); // {target, group}
  const [refundReqModal, setRefundReqModal] = useState(null); // {order, paid} — 환불신청 입력 모달
  const [orderSearch, setOrderSearch] = useState("");
  const [orderFilter, _setOrderFilter] = useState(()=>{try{return JSON.parse(localStorage.getItem("erp_order_filter"))||{dateFrom:"",dateTo:"",manager:"",status:"",payment:"",combinedShipping:false,combinedPayment:false,receiptType:""};}catch{return{dateFrom:"",dateTo:"",manager:"",status:"",payment:"",combinedShipping:false,combinedPayment:false,receiptType:""};}});
  const setOrderFilter = (v)=>{ const n = typeof v==="function"?v(orderFilter):v; _setOrderFilter(n); localStorage.setItem("erp_order_filter",JSON.stringify(n)); };
  const [showFilter, setShowFilter] = useState(false);
  const [orderShowCount, setOrderShowCount] = useState(50);
  // 정산관리 진입 시 적용할 프리셋 — 헤더 '환불' 배지 클릭 시 환불신청 필터로 열기 (ts로 재클릭도 감지)
  const [depositPreset, setDepositPreset] = useState(null); // {filter, ts}

  // 공휴일·회사휴무일 미리 받기 — 출고예정일 계산이 동기 함수라 미리 채워둬야 정확하다.
  // 실패해도 내장 폴백 표로 동작하므로 await 하지 않고 백그라운드로 돌린다.
  useEffect(()=>{ preloadHolidays().catch(()=>{}); }, []);

  // ── Supabase 초기 로드 ──────────────────────────────────────
  useEffect(()=>{
    (async()=>{
      try {
        const [o,i,l,c,m,s,cr,fs,nt,nc] = await Promise.all([
          // 주문만 따로 감싼다 — 세션이 끊긴 채로 열면 여기서 던지는데, Promise.all 이라
          // 담당자·설정까지 통째로 안 불러와 화면이 아예 안 뜬다.
          db.fetchOrdersWithMoney().catch(e => { console.error("주문 로드 실패:", e); setSyncLost(true); return []; }),
          db.fetchInventory(),
          db.fetchLogs(),
          db.fetchCustomers(),
          db.fetchManagers(),
          db.fetchSettings(),
          db.fetchCredits(),
          db.getAllFreeShipping(),
          db.fetchOrderNotes().catch(()=>[]), // order_notes 테이블 미생성 환경 방어
          db.fetchNotices().catch(()=>[]),     // notices 테이블 미생성 환경 방어
        ]);
        setNotices(nc);
        if (o.length) setOrders(o);
        if (i.length) setInv(i);
        if (l.length) setLogs(l);
        if (c.length) setCustomers(c);
        // 담당자: 비어있거나 방문고객/마켓24 가 누락됐으면 시드 — 로하이마켓 사내(company) 모드에서만.
        // SaaS 회사가 /legacy 를 열었을 때 남의 가게 담당자(마켓24)가 생기면 안 된다(2026-10-19).
        try {
          const seeded = import.meta.env.VITE_MODE === "company" ? await db.ensureDefaultManagers() : m;
          setManagers(seeded);
        } catch (e) {
          console.error("담당자 시드 실패:", e);
          if (m.length) setManagers(m);
        }
        if (cr.length) setCredits(cr);
        if (fs.length) setFreeShipping(fs);
        if (nt.length) setNotes(nt);
        if (s) { setSettings(prev=>({...prev,...s})); localStorage.setItem(SETTINGS_KEY, JSON.stringify({...savedSettings,...s})); }
      } catch(e) {
        console.error("Supabase load error:", e);
      } finally {
        setLoaded(true);
      }
    })();
  },[]);

  // 미등록 알림판 다시 읽기 — 아래 실시간 구독이 이걸 부르므로 그보다 먼저 정의해야 한다
  const reloadNotices = useCallback(async () => {
    try { setNotices(await db.fetchNotices()); } catch (e) { console.warn("[미등록] 조회 실패", e); }
  }, []);

  // 품번·롤 다시 읽기 — 건수가 적어(창고에 있는 롤만) 통째로 다시 읽는다.
  // 못 읽으면 들고 있던 목록을 그대로 둔다. 마이그레이션을 아직 안 돌린 DB 에서는
  // 테이블이 없어 여기서 실패하는데, 그때도 나머지 화면은 그대로 돌아가야 한다.
  const reloadProducts = useCallback(async () => {
    try { setProducts(await db.fetchProducts()); } catch (e) { console.warn("[품번] 조회 실패", e); }
  }, []);
  const reloadRolls = useCallback(async () => {
    try { setRolls(await db.fetchRolls()); } catch (e) { console.warn("[롤] 조회 실패", e); }
  }, []);
  // 고객 목록 통째로 다시 읽기 — 기기가 잠든 사이(실시간 알림을 못 받는 사이) 다른 직원이 만든
  // 고객을 따라잡는다. 안 따라잡으면 주문 등록의 중복 방어선이 그 고객을 모르고 같은 사람을
  // 또 만든다(2026-10-13). 못 읽으면 들고 있던 목록을 그대로 둔다.
  const reloadCustomers = useCallback(async () => {
    try { const c = await db.fetchCustomers(); if (c.length) setCustomers(c); } catch (e) { console.warn("[고객] 조회 실패", e); }
  }, []);
  // 감사 라벨 요청(💌) — 안 뽑은 것만. 라벨 PC 가 이걸 보고 뽑는다. 테이블이 없으면 빈 목록.
  const [thanksReqs, setThanksReqs] = useState([]);
  const reloadThanksReqs = useCallback(async () => {
    try { setThanksReqs(await db.fetchPendingThanksRequests()); } catch (e) { console.warn("[감사라벨] 조회 실패", e); }
  }, []);
  const [thanksAsk, setThanksAsk] = useState(null);   // 장수 묻는 창 — null | { qty }
  // 링크 주문 초안 — 테이블이 없으면(마이그레이션 전) 조용히 빈 목록. 카드가 안 보일 뿐 나머지는 그대로.
  const reloadLinkDrafts = useCallback(async () => {
    try { setLinkDrafts(await db.fetchLinkDrafts({ status: ["offered", "new"] })); }
    catch (e) {
      const missing = ["42P01", "PGRST205"].includes(e?.code) || /link_order_drafts/.test(String(e?.message || ""));
      if (!missing) console.warn("[링크 초안] 조회 실패", e);
      setLinkDrafts([]);
    }
  }, []);
  // 포장 기록 — 출고 전 주문의 것만. 테이블이 없으면(마이그레이션 전) packingReady 를 내려
  // 포장 화면의 스캔·게이트를 감춘다. 코드가 SQL 보다 먼저 배포되어도 포장이 막히지 않게.
  const activeOrderIdsKey = useMemo(
    () => orders.filter(o => o.status !== "출고완료").map(o => String(o.id)).sort().join(","),
    [orders]);
  const reloadPacking = useCallback(async () => {
    const ids = activeOrderIdsKey ? activeOrderIdsKey.split(",") : [];
    try {
      setPackingRecords(ids.length ? await db.fetchItemPacking(ids) : []);
      setPackingReady(true);
    } catch (e) {
      const missing = ["42P01", "PGRST205", "PGRST200"].includes(e?.code) || /order_item_packing/.test(String(e?.message || ""));
      if (missing) setPackingReady(false);
      console.warn("[포장 기록] 조회 실패", e);
    }
  }, [activeOrderIdsKey]);
  const packingByOrder = useMemo(() => indexPacking(packingRecords), [packingRecords]);
  // 품번별 롤 요약(가장 긴 롤 = 최대 재단 가능) — 주문 등록의 자동완성이 "얼마나 있나"를 여기서 본다.
  const rollSummary = useMemo(() => {
    const by = new Map();
    for (const r of rolls) { if (!by.has(r.productId)) by.set(r.productId, []); by.get(r.productId).push(r); }
    return new Map([...by].map(([pid, list]) => [pid, summarizeRolls(list)]));
  }, [rolls]);

  // 다시 읽기는 여러 개가 동시에 날아다닌다 — 실시간 이벤트(주문/결제), 창 포커스,
  // 끊긴 뒤 재시도, 화면에서 누른 버튼. 이것들은 서로를 기다리지 않고, 응답이 출발한
  // 순서대로 돌아오지도 않는다.
  //
  // 그래서 '늦게 도착한 낡은 응답이 새 목록을 덮는' 일이 생겼다. 주문을 등록하기
  // 직전에 출발한 조회에는 방금 넣은 주문이 없다 — 그게 등록 뒤에 도착하면 낙관적으로
  // 넣어둔 카드를 지워버린다. 다음 조회가 올 때까지 주문현황에서 사라져 있으니,
  // 등록이 늦게 되는 것처럼 보였다. 아침 피크에 여러 사람이 같이 쓰면 조회가 계속
  // 날아다녀서 "어떨 땐 바로 뜨고 어떨 땐 한참 뒤에 뜨는" 증상이 된다.
  //
  // 요청마다 번호를 붙이고, '이미 반영한 것보다 새것'만 반영한다.
  // '가장 최신 것만'이 아니다 — 그렇게 하면 먼저 도착한 성공 응답을 버린 뒤 나중 것이
  // 실패했을 때, 멀쩡한 데이터를 잃은 채 끊김 배너만 뜬다(포장 패드에서 가장 나쁜 상태).
  const reloadSeqRef = useRef(0);
  const reloadAppliedRef = useRef(0);
  const reloadOrders = useCallback(async () => {
    const seq = ++reloadSeqRef.current;
    try {
      const o = await db.fetchOrdersWithMoney();
      if (seq <= reloadAppliedRef.current) return;  // 더 새 응답이 이미 반영됨 — 이건 낡았다
      reloadAppliedRef.current = seq;
      setOrders(o);
      setSyncLost(false);
    } catch(e) {
      // 못 읽었으면 들고 있던 목록을 그대로 둔다. 지우면 화면이 '할 일 없음'이 되는데,
      // 포장 화면에서 그건 가장 위험한 거짓말이다 — 물량은 그대로 밀려 있다.
      console.error("reload error:", e);
      setSyncLost(true);
    }
  }, []);

  // 끊긴 뒤 스스로 돌아오게 하는 길.
  //
  // 포장 패드는 하루 종일 켜둔 채 잠들었다 깨기를 반복한다. 자는 동안 웹소켓이 끊기고
  // 토큰이 만료되는데, 이 앱에는 주기적으로 다시 읽는 곳이 없었다 — 실시간 이벤트가
  // 유일한 갱신 통로라 그게 끊기면 화면이 잠든 시각에 멈춘 채 남았다.
  // 그래서 사람이 패드를 집어드는 순간(visible/focus), 네트워크가 돌아온 순간(online),
  // 토큰이 갱신된 순간(TOKEN_REFRESHED)마다 다시 읽는다.
  // 다만 매번 다시 읽지는 않는다. 로하톡을 팝업으로 띄워놓고 쓰면 본 창과 팝업을
  // 하루 종일 오가는데, 창을 옮길 때마다 focus 가 떠서 주문 4,600건 + 결제로그
  // 전부를 다시 받아왔다. 방금 읽은 것을 몇 초 만에 또 읽는 셈이고, 그 사이
  // 화면 전체가 다시 그려지느라 타이핑이 끊긴다. 30초 안에 이미 읽었으면 건너뛴다.
  // 실시간 구독은 그대로라, 다른 사람이 넣은 주문은 이것과 무관하게 바로 들어온다.
  const lastWakeRef = useRef(0);
  useEffect(() => {
    const wake = (force = false) => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (!force && now - lastWakeRef.current < 30000) return;
      lastWakeRef.current = now;
      reloadOrders();
      // 롤도 같이 — 라벨 PC 가 자는 동안 걸린 롤 라벨 요청을 깨어나면서 받아 온다.
      reloadRolls();
      // 고객도 같이 — 자는 동안 다른 직원이 만든 고객을 모르면 같은 사람을 또 만든다.
      reloadCustomers();
    };
    const onWake = () => wake(false);
    // 네트워크 복귀는 중복 신호가 아니라 진짜 상태 변화다 — 끊긴 동안 들어온 주문이
    // 있을 수 있으니 쓰로틀을 건너뛴다.
    const onOnline = () => wake(true);
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onOnline);
    let unsub = null;
    try {
      const { data } = supabase.auth.onAuthStateChange((event) => {
        if (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") reloadOrders();
      });
      unsub = data?.subscription;
    } catch (e) { console.warn("[auth] 상태 구독 실패", e); }
    return () => {
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onOnline);
      try { unsub?.unsubscribe?.(); } catch { /* 이미 정리됨 */ }
    };
  }, [reloadOrders, reloadRolls, reloadCustomers]);

  // 끊긴 동안에는 스스로 다시 붙어본다. 사람이 화면을 만지지 않아도 복구돼야 한다 —
  // 포장 패드는 대개 작업대 위에 놓인 채 아무도 안 건드린다.
  // 화면이 꺼져 있을 때는 시도하지 않는다(어차피 못 붙고 배터리만 먹는다).
  useEffect(() => {
    if (!syncLost) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") reloadOrders();
    }, 15000);
    return () => clearInterval(id);
  }, [syncLost, reloadOrders]);

  // ── Supabase Realtime 구독 (다중 사용자 동시 작업 동기화) ──
  // editingOrder는 ref로 보관해 핸들러가 항상 최신값 참조하도록 함
  const userId = useUserId();
  const editingOrderRef = useRef(null);
  useEffect(() => { editingOrderRef.current = editingOrder; }, [editingOrder]);

  // 주문/결제 변경 → orders 전체 reload (타이머 하나로 합침, debounce 500ms)
  // 모달로 같은 주문을 편집 중이면 토스트로 알림
  useRealtimeOrdersAndPayments(userId, {
    onAny: () => { reloadOrders(); },
    onUpdate: (newRow) => {
      const eo = editingOrderRef.current;
      if (!eo || eo.id !== newRow.id) return;
      setToast({ msg: "다른 사용자가 이 주문을 수정했습니다", type: "ok" });
      setTimeout(() => setToast({ msg: "", type: "ok" }), 2500);
    },
    onDelete: (oldRow) => {
      const eo = editingOrderRef.current;
      if (!eo || eo.id !== oldRow.id) return;
      setEditingOrder(null);
      setToast({ msg: "이 주문이 다른 사용자에 의해 삭제되었습니다", type: "error" });
      setTimeout(() => setToast({ msg: "", type: "ok" }), 2500);
    },
  });

  // 라벨 출력 담당 기기 — 로그인 직후 한 번 읽고, 이후 바뀔 때마다 따라간다.
  // 담당이 다른 PC 로 넘어가거나 관리자가 해제하면 이 기기는 즉시 멈춰야 한다.
  useEffect(() => { if (userId) reloadLabelStation(); }, [userId, reloadLabelStation]);
  useRealtimeLabelStation(userId, { onAny: reloadLabelStation });

  // 재고 — 부분 업데이트 (전체 reload 없이 해당 row만)
  useRealtimeInventory(userId, {
    onInsert: (row) => setInv(p => p.find(i => i.id === row.id) ? p : [...p, row]),
    onUpdate: (row) => setInv(p => p.map(i => i.id === row.id ? { ...i, ...row } : i)),
    onDelete: (row) => setInv(p => p.filter(i => i.id !== row.id)),
  });

  // 고객 — 부분 업데이트
  useRealtimeCustomers(userId, {
    onInsert: (row) => setCustomers(p => p.find(c => c.id === row.id) ? p : [...p, rowToCustomerCamel(row)]),
    // 기존 객체 위에 덮어쓴다 — 매퍼에 아직 없는 칸이 생겨도 화면·DB 에서 통째로 사라지지 않게.
    onUpdate: (row) => setCustomers(p => p.map(c => c.id === row.id ? { ...c, ...rowToCustomerCamel(row) } : c)),
    onDelete: (row) => setCustomers(p => p.filter(c => c.id !== row.id)),
    // 끊겼다 다시 붙으면 그 사이 알림은 사라졌다 — 통째로 다시 읽어 따라잡는다.
    onResubscribe: reloadCustomers,
  });

  // 적립금 — 부분 업데이트
  useRealtimeCredits(userId, {
    onInsert: (row) => setCredits(p => p.find(c => c.id === row.id) ? p : [row, ...p]),
    onUpdate: (row) => setCredits(p => p.map(c => c.id === row.id ? row : c)),
    onDelete: (row) => setCredits(p => p.filter(c => c.id !== row.id)),
  });

  // 주문 메모 — 부분 업데이트 (최신순 유지)
  useRealtimeOrderNotes(userId, {
    onInsert: (row) => setNotes(p => p.find(n => n.id === row.id) ? p : [rowToOrderNoteCamel(row), ...p]),
    onUpdate: (row) => setNotes(p => p.map(n => n.id === row.id ? rowToOrderNoteCamel(row) : n)),
    onDelete: (row) => setNotes(p => p.filter(n => n.id !== row.id)),
  });

  // 미등록 알림판 — 건수가 적어(하루 몇 건) 통째로 다시 읽는다.
  // 행 단위로 병합하면 claimed/resolved 가 얽혀 화면과 DB가 어긋날 여지가 생긴다.
  useRealtimeNotices(userId, { onAny: () => { reloadNotices(); } });

  // 품번·롤 — 로그인 직후 한 번 읽고, 이후 바뀔 때마다 따라간다.
  // 롤 구독은 라벨 PC 에 꼭 필요하다. 다른 PC 에서 검단을 마친 순간 여기로 알림이 와야
  // 아래 출력 루프가 그 롤의 라벨을 뽑는다.
  useEffect(() => { if (userId) { reloadProducts(); reloadRolls(); } }, [userId, reloadProducts, reloadRolls]);
  useRealtimeProducts(userId, { onAny: reloadProducts });
  useRealtimeStockRolls(userId, { onAny: reloadRolls });
  useRealtimeThanksRequests(userId, { onAny: reloadThanksReqs });
  useEffect(() => { if (userId) reloadThanksReqs(); }, [userId, reloadThanksReqs]);
  // 포장 기록 — 출고 전 주문 목록이 바뀌거나(새 주문·출고) 다른 태블릿이 찍으면 다시 읽는다.
  useEffect(() => { if (userId) reloadPacking(); }, [userId, reloadPacking]);
  useRealtimeItemPacking(userId, { onAny: reloadPacking });
  useEffect(() => { if (userId) reloadLinkDrafts(); }, [userId, reloadLinkDrafts]);
  useRealtimeLinkDrafts(userId, { onAny: reloadLinkDrafts });

  // 무료배송권 보유 현황 새로고침
  const reloadFreeShipping = useCallback(async () => {
    try { const data = await db.getAllFreeShipping(); setFreeShipping(data); } catch (e) { console.error(e); }
  }, []);

  // ── 주문 메모/피드 핸들러 ──────────────────────────────────
  const handleSendNote = async (body, customerId = null) => {
    try {
      const saved = await db.insertOrderNote({ author: activeManager || "", body, customerId });
      if (saved) setNotes(p => p.find(n => n.id === saved.id) ? p : [saved, ...p]); // 낙관적 추가(실시간 중복은 dedupe)
    } catch (e) { console.error("메모 전송 실패:", e); showToast("메모 전송 실패: " + e.message, "error"); }
  };
  const handleUpdateNoteBody = async (id, body) => {
    try {
      const updated = await db.updateOrderNote(id, { body });
      if (updated) setNotes(p => p.map(n => n.id === id ? updated : n));
    } catch (e) { console.error("메모 수정 실패:", e); showToast("메모 수정 실패: " + e.message, "error"); }
  };
  const handleDeleteNote = async (id) => {
    setNotes(p => p.filter(n => n.id !== id)); // 낙관적 제거
    try { await db.deleteOrderNote(id); }
    catch (e) { console.error("메모 삭제 실패:", e); showToast("메모 삭제 실패: " + e.message, "error"); }
  };
  // 메모 리액션 토글 — 본인 포함 모든 담당자가 이모지 리액션 가능 (실시간 공유)
  const handleToggleNoteReaction = async (id, emoji) => {
    try {
      const updated = await db.toggleNoteReaction(id, emoji, activeManager || "");
      if (updated) setNotes(p => p.map(n => n.id === id ? updated : n));
    } catch (e) { console.error("메모 리액션 실패:", e); showToast("리액션 실패: " + e.message, "error"); }
  };
  // 로하톡 검색 — 서버에서 찾은 옛 메모를 notes 에 합친다 (db.searchOrderNotes 참고).
  // 검색 결과를 로하톡 안에 따로 들고 있지 않는 이유: 수정·삭제·리액션·등록됨 처리와
  // 실시간 갱신이 전부 이 notes 를 고친다. 따로 들고 있으면 검색으로 찾은 메모만
  // 고쳐도 화면이 안 바뀐다. 오래 열어 둔 탭이 옛 메모를 쌓아 두는 것과 같은 상태가 될 뿐이다.
  const handleSearchNotes = useCallback(async (q, customerIds) => {
    const { notes: hits, capped } = await db.searchOrderNotes(q, customerIds);
    if (hits.length) setNotes(p => {
      const have = new Set(p.map(n => n.id));
      const add = hits.filter(n => !have.has(n.id));
      if (!add.length) return p;
      return [...p, ...add].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    });
    return { capped };
  }, []);
  // 메모 → 주문입력 탭으로 넘겨 AI 분석 시작
  const handleRegisterNote = (note) => {
    setNoteToRegister(note);
    setTab(0);
  };
  // 주문입력에서 등록 성공 시 — 해당 메모를 '등록됨'으로 표시하고 주문번호 연결
  const handleNoteRegistered = async (noteId, order) => {
    try {
      const updated = await db.updateOrderNote(noteId, { status: "등록됨", orderId: order?.id || null });
      if (updated) setNotes(p => p.map(n => n.id === noteId ? updated : n));
    } catch (e) { console.error("메모 등록표시 실패:", e); }
  };
  // 링크 주문 초안 → 주문입력 폼으로(메모 핸드오프와 같은 방식). 등록은 기존 경로가 한다.
  const handleConvertDraft = (draft) => { setDraftToConvert(draft); setTab(0); };
  const handleDraftConverted = async (draftId, order) => {
    try { await db.markDraftConverted(draftId, order?.id || null, activeManager || ""); }
    catch (e) { console.error("초안 전환 표시 실패:", e); showToast("주문은 등록됐지만 초안 전환 표시에 실패했습니다: " + e.message, "error"); }
    reloadLinkDrafts();
  };
  const handleRejectDraft = async (draft) => {
    const reason = window.prompt(`${draft.customerName} 님의 링크 주문 초안을 거절합니다.\n사유를 적어 주세요.`);
    if (reason === null) return;
    if (!reason.trim()) { showToast("사유를 적어 주세요", "error"); return; }
    try { await db.rejectLinkDraft(draft.id, reason.trim(), activeManager || ""); showToast("초안을 거절했습니다"); }
    catch (e) { showToast("거절 실패: " + e.message, "error"); }
    reloadLinkDrafts();
  };
  // 고객 확인을 기다리는(또는 만료된) 셀러 링크를 거둔다 — 잘못 만든 링크·시험용. 지우면 그 링크는 열리지 않는다.
  const handleDeleteDraft = async (draft) => {
    if (!window.confirm(`${draft.customerName} 님에게 만든 주문 링크를 삭제할까요?

삭제하면 고객이 그 링크를 열어도 주문서가 보이지 않습니다.`)) return;
    try { await db.deleteLinkDraft(draft.id); showToast("주문 링크를 삭제했습니다"); }
    catch (e) { showToast("삭제 실패: " + e.message, "error"); }
    reloadLinkDrafts();
  };

  // 무료배송권 적용/취소는 주문 수정창에서 한다(2026-10-07) — 적립금과 같은 가드(돈 들어온 주문·
  // 고객명 변경·배송비 0 막기)를 한 자리에서 보려고 카드 토글을 걷어냈다. 저장 핸들러(EditOrderModal onSave) 참고.

  // ── settings: localStorage + Supabase 동기화 ─────────────
  useEffect(()=>{
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    db.saveSettings(settings).catch(e=>console.error("Settings save error:", e));
  },[settings]);

  useEffect(()=>{
    document.body.style.background = T.bg;
    document.body.style.color = T.cream;
  },[theme]);

  const showToast = (msg, type="ok") => {
    setToast({msg,type});
    setTimeout(()=>setToast({msg:"",type:"ok"}), 2500);
  };

  // 환불신청 모달 오픈 — 주문현황·반품 탭·대시보드 공용
  // opts.initialAmount: 교환 차액 등 특정 금액 지정 시 부분환불+해당 금액이 기본값
  const openRefundRequest = async (o, opts = {}) => {
    try {
      const total=(o.totalAmount>0?o.totalAmount:(o.items||[]).reduce((s,i)=>s+(i.amount||0),0));
      const lg=await db.fetchOrderLogs(o.id);
      const computed=db.calcOrderMoney(lg,total,o.payment);
      const paid=computed.depositAmount>0?computed.depositAmount:total;
      setRefundReqModal({order:o,paid,...opts});
    } catch(e){ showToast("환불신청 열기 실패: "+e.message,"error"); }
  };

  const kakaoAlert = useCallback(async (message) => {
    if (!settings.kakaoEnabled || !settings.kakaoWebhook) return;
    try {
      await fetch(settings.kakaoWebhook,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:message})});
      showToast("카톡 알림 전송");
    } catch { showToast("카톡 전송 실패","error"); }
  },[settings]);

  useEffect(()=>{
    const low = inv.filter(i=>i.stock>0&&i.stock<=settings.lowStockAlert);
    if (low.length>0 && settings.kakaoEnabled) {
      kakaoAlert(`⚠️ 재고 부족\n${low.map(i=>`${i.fabric} ${i.color}: ${i.stock}마`).join("\n")}`);
    }
  },[inv]);

  // 출고 가능한 입금 상태 — 입금완료/부분환불/환불완료만.
  // _computed가 아직 안 채워진 신규 주문은 order.payment로 폴백
  const payStatusOf = (o) => o._computed?.paymentStatus || o.payment;
  const canShipByPayment = (o) => ["입금완료","부분환불","환불완료"].includes(payStatusOf(o));

  // ── 합배송 규칙(3단계) — 그룹 구성이 바뀐 뒤 출고일·택배비를 규칙대로 맞추고 화면에 반영 ──
  // 묶음·해제·분리·출고 뒤에 부른다. 규칙은 lib/freight.js·lib/autoMerge.js, DB 쓰기는 db.afterGroupChange.
  // 운임비 조정(FreightModal)으로 사람이 정한 값은 그 뒤 이걸 부르지 않으므로 그대로 남는다.
  const settleGroup = async (members, route) => {
    try {
      const res = await db.afterGroupChange(members, { paymentStatusOf: payStatusOf, route });
      if (res) {
        setOrders(p => patchOrdersWithGroupResult(p, res));
        if (res.freight?.conflict) showToast("입금완료 2건에 택배비가 각각 있어 운임비 조정이 필요합니다", "error");
        // 되돌릴 택배비가 있는데 입금이 끝난 주문 — 건드리지 않고 알리기만 한다. 이 뒤에 뜨는
        // 완료 토스트에 묻히지 않게 조금 늦게 띄운다.
        const back = res.freight?.heldBack || [];
        if (back.length) setTimeout(() => showToast(`입금완료 주문이라 택배비 ${back.map(b => b.fee.toLocaleString() + "원").join(", ")}은 되돌리지 않았습니다 — 따로 받으려면 수정에서 넣어 주세요`, "error"), 2700);
      }
      return res;
    } catch (e) {
      console.error("합배송 출고일·택배비 조정 실패:", e);
      showToast("출고일·택배비 자동 조정 실패: " + e.message, "error");
      return null;
    }
  };
  // 그룹 id 하나의 미출고 멤버 전체를 규칙대로. 함께 나갈 멤버는 한 그룹으로, 분리(splitShipping) 건은
  // 각각 1건 그룹으로 본다(묶일 때 내려놓은 택배비가 있으면 되돌아온다). snapshot: 방금 바뀐 내용이 반영된
  // 주문 목록(state 는 아직 옛것일 수 있다).
  const settleGroupId = async (gid, snapshot, route) => {
    if (!gid) return;
    const live = snapshot.filter(o => o.mergeGroupId === gid && o.status !== "출고완료");
    const together = live.filter(o => !o.splitShipping);
    if (together.length) await settleGroup(together, route);
    for (const o of live.filter(o => o.splitShipping)) await settleGroup([o], route);
  };

  // 같은 박스로 같이 나가는 합배송 묶음 (아직 안 나간 건만, 자기 자신 포함).
  // 분리(splitShipping)로 지정된 건은 따로 나가므로 묶음에 넣지 않는다 — 송장 출력과 같은 기준.
  const shipGroupOf = (order) => (order.mergeGroupId && !order.splitShipping)
    ? [order, ...orders.filter(o => o.mergeGroupId === order.mergeGroupId && o.id !== order.id && !o.splitShipping && o.status !== "출고완료")]
    : [order];

  const shipLine = (o) => `· #${String(o.id).slice(0,8)} ${o.customer}`;

  // 단일 주문 출고 처리 (재고 차감 + 로그 + status 갱신)
  // shippedAt: 합배송 그룹 동시 출고 시 동일 타임스탬프 공유
  // route: 변경 기록에 남길 자리("출고완료 버튼" 등). 안 넘기면 현재 탭 이름이 남는다.
  // extra: 출고와 함께 쓸 칸 — 어떻게 나갔는지(shippedVia) 등.
  const shipOneOrder = async (order, shippedAt, route, extra = {}) => {
    if (!canShipByPayment(order)) return { ok: false, reason: "입금확인 후 출고해주세요" };
    const ts = shippedAt || new Date().toISOString();

    // ── 출고 표시를 먼저 잡는다 ──────────────────────────────────────────
    // 예전에는 이게 맨 뒤였다. 품목별 출고로그 + 재고 차감을 도는 1~2초 동안 이 주문이
    // 나가는 중인지 아무도 몰랐고, 그 사이 화면이 낡은 목록으로 되살아나면(출고 직전에
    // 출발한 조회가 뒤늦게 도착하면) 사람은 "안 눌렸네" 하고 다시 눌렀다.
    // 그러면 로그와 재고가 한 번 더 빠졌다 — 실측 148건(주문 117건).
    // 라벨 출력권(claimLabelPrint)과 같은 방식으로, 먼저 잡고 나서 실행한다.
    //
    // 보관·보류는 '아직 못 내보낸다'는 표시다 — 나간 순간 둘 다 참이 아니게 된다.
    // 안 지우면 주문현황에 출고완료된 건이 "📦 보관중"·"🗄️ 보류"를 달고 남는다.
    // 보류는 사유·넣은 시각까지 같이 지운다(보류 해제와 같은 처리). 나간 주문에
    // 남겨봐야 보여주는 화면이 없고, 출고취소 시 보류함으로 되돌아가지도 않는다.
    // 보관도 넣은 시각(held_at)까지 함께 지운다. 안 지우면 출고취소로 되살아난 주문에
    // 다시 보관을 걸었을 때, 아무도 창고에 넣지 않았는데 옛 시각 때문에 곧바로
    // '보관중'으로 보인다 — 요청과 완료를 가르는 기준이 그 값 하나뿐이다.
    // 출고요청도 함께 지운다 — 요청은 "내보내라"는 지시이고, 나간 순간 할 일이 끝난다.
    // 남겨두면 출고취소로 되살린 주문이 '보관분 출고요청'을 단 채 돌아온다.
    let claim;
    try {
      claim = await db.claimShipOut(order.id, {
        isHolding: false, heldAt: null, images: [], shipped_at: ts,
        isParked: false, parkedAt: null, parkReason: null,
        shipRequestedAt: null, shipRequestedBy: null,
        fabricMissing: false, fabricMissingItems: [], fabricMissingAt: null,
        ...extra,
      }, { route });
    } catch (e) {
      console.error("출고 표시 실패:", e);
      return { ok: false, reason: e.message };
    }

    // 목록에서 지우는 일은 잡았든 이미 나갔든 똑같이 한다 — DB 가 사실이다.
    const markShipped = () => setOrders(p=>p.map(o=>o.id===order.id?{...o,status:"출고완료",isHolding:false,heldAt:null,images:[],shippedAt:ts,
      isParked:false,parkedAt:null,parkReason:"",shipRequestedAt:null,shipRequestedBy:"",
      fabricMissing:false,fabricMissingItems:[],fabricMissingAt:null}:o));

    if (claim === "already") {
      // 이미 나간 주문이다. 화면만 뒤처져 있었다.
      // 오류로 알리지 않는다 — 사람이 원한 결과("이 주문을 내보내라")는 이미 이뤄져 있고,
      // 여기서 빨간 토스트를 띄우면 멀쩡히 나간 주문을 문제로 착각하게 만든다.
      markShipped();
      return { ok: true, already: true };
    }

    // ── 여기서부터는 이 주문을 내가 잡았다. 로그는 한 번만 돈다. ──
    // 재고는 여기서 깎지 않는다. 포장대에서 롤을 찍는 순간 이미 빠졌다(pack_item_from_roll).
    // 옛 inventory 를 깎던 루프(decrementStock)는 그 테이블이 0행이라 빈 동작이었다.
    const t = nowT();
    const newLogs = [];
    try {
      for (const item of (order.items||[])) {
        const log = await db.insertLog({...t, type:"출고", fabric:item.fabric, color:item.color||"", qty:item.qty, itemNo:item.itemNo||"", ref:order.id, note:`판매출고 — ${order.customer}`});
        if (log) newLogs.push(log);
      }
    } catch (e) {
      // 출고 표시는 이미 들어갔다. 되돌리지 않는다 — 물건은 나갔고, 그게 사실이다.
      // 대신 무엇이 안 됐는지 정확히 알린다. 사람이 입출고 이력에서 채워 넣을 수 있다.
      // (예전에는 이 실패가 status 갱신 실패로 나타나, 다시 누르면 로그가 두 번 남았다)
      console.error("출고 이력 처리 실패:", e);
      showToast(`출고는 처리됐지만 입출고 이력 기록에 실패했습니다: ${e.message}`, "error");
    }
    if (newLogs.length) setLogs(p=>[...newLogs,...p]);
    deleteOrderImages(order.id).catch(()=>{});
    markShipped();
    return { ok: true };
  };

  // 인계 — 포장팀이 기사에게 박스를 건넨 뒤 누른다. 출고완료는 여기서 난다.
  //
  // boxes: 박스 단위 배열([[주문, …], …]). 합배송 묶음은 한 박스다.
  // via:   택배사('CJ대한통운'·'경동화물') 또는 직접 전달 방법('퀵'·'직접 배달'·'방문 수령')
  //
  // 박스는 통째로 나가거나 통째로 남는다. 입금 안 된 주문이 섞인 박스는 건드리지 않는다 —
  // 한 건만 빼고 내보내면 그 한 건이 송장도 없이 주문현황에 남는다.
  //
  // noInvoice: 송장 없이 포장팀 판단으로 내보낸 박스(첫 주문 id 의 Set). 변경 기록의 경로에
  // '(송장 없이)'를 붙여 둔다 — 나중에 송장 출력 기록이 없는 출고를 보고 사고로 오해하지 않게.
  const handOver = async (boxes, via, { noInvoice } = {}) => {
    const ts = new Date().toISOString();
    const baseRoute = COURIERS.includes(via) ? `${via} 인계` : `직접 전달 (${via})`;
    let shippedBoxes = 0;
    const failed = [];
    for (const box of boxes) {
      const name = `${box[0].customer}${box.length > 1 ? ` 외 ${box.length - 1}건` : ""}`;
      if (box.some(o => !canShipByPayment(o))) { failed.push(`· ${name} — 입금 확인 전`); continue; }
      const route = noInvoice?.has(box[0].id) ? `${baseRoute} (송장 없이)` : baseRoute;
      let done = 0, reason = "";
      for (const o of box) {
        // 포장완료를 안 누르고 보낸 박스 — 포장 시각을 지금으로 채워 둔다.
        // 비워 두면 "언제 쌌는지 모르는 주문"이 되어 나중에 되짚을 수 없다.
        const r = await shipOneOrder(o, ts, route, { shippedVia: via, ...(o.packedAt ? {} : { packedAt: ts }) });
        if (!r.ok) { reason = r.reason; break; }
        done++;
      }
      if (done === box.length) shippedBoxes++;
      else failed.push(`· ${name} — ${done > 0 ? `${box.length}건 중 ${done}건만 처리됨, ` : ""}${reason}`);
      // 나간 뒤 그룹에 미출고 멤버가 남았으면(분리 건 등) 남은 멤버들로 출고일·택배비 재계산 — 3단계
      const shippedIds = new Set(box.slice(0, done).map(o => o.id));
      for (const gid of new Set(box.map(o => o.mergeGroupId).filter(Boolean))) {
        await settleGroupId(gid, orders.map(o => shippedIds.has(o.id) ? { ...o, status: "출고완료" } : o), "출고 뒤 재계산");
      }
    }
    await reloadOrders();
    if (failed.length) {
      window.alert(`${shippedBoxes}박스를 넘겼습니다.\n\n처리되지 않은 박스 ${failed.length}개:\n${failed.join("\n")}\n\n이 박스들은 목록에 그대로 남아 있습니다.`);
    } else {
      showToast(`🚚 ${COURIER_SHORT[via] || via} ${shippedBoxes}박스 인계 완료`);
    }
    return { shippedBoxes, failed: failed.length };
  };

  // 출고요청 — 보관중인 건을 "이제 내보내라"고 포장팀에 넘긴다.
  //
  // 출고완료와 다른 점: 재고도 로그도 건드리지 않는다. 물건이 아직 선반에 있으니
  // 장부만 먼저 나가면 안 된다. 여기서는 보관을 풀어 카드를 포장탭 당일 칸으로
  // 올려보내는 것까지만 한다.
  //
  // 합배송은 묶음째 움직인다. 한 건만 걸면 같은 박스로 나갈 것들이 서로 다른
  // 칸에 흩어져, 포장직원이 묶음을 다시 모아야 한다.
  const requestShipOut = async (order) => {
    const group = order.mergeGroupId
      ? orders.filter(x => x.mergeGroupId === order.mergeGroupId && x.status !== "출고완료")
      : [order];
    try {
      await db.requestShipOut(group, activeManager || "");
      await reloadOrders();
      showToast(group.length > 1
        ? `🚚 출고요청 — ${order.customer} 외 합배송 ${group.length}건이 포장 당일 칸으로 갑니다`
        : `🚚 출고요청 — ${order.customer} · 포장 당일 칸으로 갑니다`);
    } catch (e) {
      showToast("처리 실패: " + e.message, "error");
    }
  };

  // 출고요청 취소 — 보관중으로 되돌린다. 요청을 걸었어도 아무도 선반에서 꺼내지
  // 않았으므로 '요청' 단계가 아니라 '보관중'으로 돌아가는 게 맞다. 요청 단계로
  // 떨어뜨리면 물건이 창고에 그대로 있는데 포장직원이 보관완료를 또 눌러야 한다.
  const cancelShipRequest = async (order) => {
    const group = order.mergeGroupId
      ? orders.filter(x => x.mergeGroupId === order.mergeGroupId && x.status !== "출고완료")
      : [order];
    try {
      await db.cancelShipOutRequest(group);
      await reloadOrders();
      showToast(`출고요청을 취소했습니다 — ${order.customer} · 보관중으로 되돌림`);
    } catch (e) {
      showToast("처리 실패: " + e.message, "error");
    }
  };

  // 돌려주는 값: 출고가 끝까지 됐으면 true, 막혔거나 취소·실패면 false
  const handleShipOut = async (orderId) => {
    const order = orders.find(o=>o.id===orderId);
    if (!order) return false;
    if (order.status==="출고완료") { showToast("이미 출고완료된 주문입니다"); return false; }

    if (!canShipByPayment(order)) {
      showToast("입금확인 후 출고해주세요","error");
      return false;
    }

    // 합배송 묶음은 통째로 나가거나, 통째로 안 나간다.
    // 예전에는 "이 주문만 출고"를 고를 수 있었고, 묶음에 미입금 건이 있으면 토스트만 띄우고
    // 누른 주문 한 건을 내보냈다. 송장은 묶음당 한 장이라 남은 건은 송장도 없이 주문현황에
    // 남았고, 누가 일일이 찾기 전까지 아무도 몰랐다(미아 주문).
    // 따로 보낼 주문은 "분리"로 지정한다 — 그러면 묶음에서 빠져 혼자 나간다.
    const toShip = shipGroupOf(order);
    if (toShip.length > 1) {
      const unpaid = toShip.filter(o => !canShipByPayment(o));
      if (unpaid.length > 0) {
        window.alert(`합배송 묶음에 입금확인이 안 된 주문이 있어 출고할 수 없습니다.\n\n${unpaid.map(o=>`${shipLine(o)} (${payStatusOf(o)||"미입금"})`).join("\n")}\n\n입금확인을 먼저 하거나, 따로 보낼 주문이면 합배송 묶음 목록에서 "🚚 분리"로 지정해 주세요.`);
        return false;
      }
      // 보관·보류인 건은 표시를 붙인다. 묶음으로 나가면 그 표시도 같이 풀리는데,
      // 물건이 아직 창고에 있는 걸 모르고 누르면 장부만 먼저 나간다.
      const mark = (o) => `${shipLine(o)}${isHold(o) ? "  [보관]" : ""}${isParked(o) ? "  [보류]" : ""}`;
      const stuck = toShip.some(o => isHold(o) || isParked(o));
      if (!window.confirm(`합배송 묶음 ${toShip.length}건을 함께 출고합니다.\n\n${toShip.map(mark).join("\n")}\n\n${stuck ? "⚠ 보관·보류 중인 주문이 들어 있습니다. 같이 나가는 게 맞는지 확인해 주세요.\n" : ""}따로 보낼 주문이 있으면 [취소] 후 "🚚 분리"로 지정해 주세요.`)) return false;
    }

    // 재고 매칭 사전 검증 (모든 출고 대상 합산)
    const missingItems = [];
    for (const o of toShip) {
      for (const item of (o.items||[])) {
        const noKey = item.itemNo?.toLowerCase();
        const invItem = noKey
          ? inv.find(i=>(i.item_no||"").toLowerCase()===noKey) || inv.find(i=>i.fabric===item.fabric&&i.color===item.color)
          : inv.find(i=>i.fabric===item.fabric&&i.color===item.color);
        if (!invItem) missingItems.push({ ...item, _orderId: o.id });
      }
    }
    if (missingItems.length > 0) {
      const list = missingItems.map(m => `[${m.itemNo||"No없음"}] ${m.fabric} ${m.color||""}`).join("\n");
      if (!window.confirm(`아래 아이템의 재고를 찾을 수 없습니다:\n\n${list}\n\n재고 차감 없이 출고를 계속할까요?`)) return false;
    }

    const done = [];
    try {
      // 합배송 그룹 출고 시 동일 타임스탬프 공유
      const groupShippedAt = new Date().toISOString();
      for (const o of toShip) {
        const r = await shipOneOrder(o, groupShippedAt, toShip.length > 1 ? "출고완료 버튼 (합배송 묶음)" : "출고완료 버튼");
        if (!r.ok) throw new Error(r.reason);
        done.push(o.id);
      }
      const cnt = toShip.length;
      // 나간 뒤 그룹에 미출고 멤버가 남았으면(분리 건 등) 남은 멤버들로 출고일·택배비 재계산 — 3단계
      if (order.mergeGroupId) await settleGroupId(order.mergeGroupId, orders.map(o => done.includes(o.id) ? { ...o, status: "출고완료" } : o), "출고 뒤 재계산");
      showToast(cnt > 1 ? `합배송 ${cnt}건 출고 완료` : "출고 처리 완료");
      return true;
    } catch(e) {
      console.error("출고 실패:", e);
      // 묶음은 한 건씩 처리된다. 중간에 끊기면 앞 건만 나간 상태로 남으므로,
      // 몇 건이 나갔고 무엇이 남았는지 사라지지 않는 창으로 알린다.
      if (done.length > 0) {
        const left = toShip.filter(o => !done.includes(o.id));
        window.alert(`합배송 ${toShip.length}건 중 ${done.length}건만 출고완료 처리됐습니다.\n\n아직 출고완료가 안 된 주문:\n${left.map(shipLine).join("\n")}\n\n오류: ${e.message}\n\n남은 주문에서 출고완료를 다시 눌러 주세요.`);
      } else {
        showToast("출고 실패: "+e.message,"error");
      }
      return false;
    }
  };

  const handleUndoShipOut = async (orderId, newStatus) => {
    const order = orders.find(o=>o.id===orderId);
    if (!order || order.status!=="출고완료") {
      await db.updateOrder(orderId, { status: newStatus, shipped_at: null }, { route: "출고 취소" });
      setOrders(p=>p.map(o=>o.id===orderId?{...o,status:newStatus,shippedAt:null}:o));
      return;
    }
    try {
      // 재고 복구 (itemNo 우선, fabric+color 폴백, 대소문자 무시)
      for (const item of (order.items||[])) {
        const noKey = item.itemNo?.toLowerCase();
        const invItem = noKey
          ? inv.find(i=>(i.item_no||"").toLowerCase()===noKey) || inv.find(i=>i.fabric===item.fabric&&i.color===item.color)
          : inv.find(i=>i.fabric===item.fabric&&i.color===item.color);
        if (invItem) {
          const restored = invItem.stock + (item.qty||0);
          await db.updateInventoryItem(invItem.id, { stock: restored });
          setInv(p=>p.map(i=>i.id===invItem.id?{...i,stock:restored}:i));
        }
      }
      // 해당 주문의 출고 로그 삭제
      const shipLogs = logs.filter(l=>l.type==="출고"&&l.ref===orderId);
      for (const sl of shipLogs) {
        await db.deleteLog(sl.id);
      }
      setLogs(p=>p.filter(l=>!(l.type==="출고"&&l.ref===orderId)));
      await db.updateOrder(orderId, { status: newStatus, shipped_at: null }, { route: "출고 취소" });
      setOrders(p=>p.map(o=>o.id===orderId?{...o,status:newStatus,shippedAt:null}:o));
      showToast(`출고 취소 → ${newStatus}`);
    } catch(e) { console.error("출고 취소 실패:", e); showToast("출고 취소 실패","error"); }
  };

  const exportOrders = () => {
    const rows = orders.flatMap(o=>o.items.map(it=>({주문번호:o.id,날짜:o.date,고객명:o.customer,원단:it.fabric,색상:it.color,수량:it.qty,결제:o.payment,상태:o.status,배송지:o.address||"",메모:o.note||""})));
    const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"주문현황"); dlXlsx(wb,"로하이마켓_주문현황.xlsx"); showToast("엑셀 다운로드 완료");
  };
  const exportLogs = () => {
    const rows=logs.map(l=>({날짜:l.date,구분:l.type,아이템No:l.itemNo||"",원단:l.fabric,색상:l.color,수량:l.qty,입고가:l.costPrice||0,참조:l.ref,메모:l.note}));
    const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"입출고이력"); dlXlsx(wb,"로하이마켓_입출고이력.xlsx"); showToast("엑셀 다운로드 완료");
  };
  const exportCustomers = () => {
    const rows=customers.map(c=>({고객명:c.name,연락처:c.phone||"",주소:c.address||"",총주문:c.totalOrders||0,메모:c.note||""}));
    const ws=XLSX.utils.json_to_sheet(rows); const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,"고객목록"); dlXlsx(wb,"로하이마켓_고객목록.xlsx"); showToast("엑셀 다운로드 완료");
  };
  // 송장만 뽑는다. 출고완료는 하지 않는다 — 박스를 기사에게 건넨 뒤 포장팀이 인계에서 한다.
  const exportShipping = async (selIds, courier) => {
    const COLS = {
      "CJ대한통운":{
        // CJ LOIS Parcel 표준 16개 컬럼 (품목명이 10번/16번 두 번 등장 — CJ 양식 그대로)
        cols:["예약구분","집하예정일","받는분성명","받는분전화번호","받는분기타연락처","받는분우편번호","받는분주소(전체, 분할)","운송장번호","고객주문번호","품목명","박스수량","박스타입","기본운임","배송메세지1","배송메세지2","품목명"],
        // CJ 양식 그대로: H~M(운송장번호/고객주문번호/품목명/박스수량/박스타입/기본운임) 숨김
        widths:[
          { wch: 10 },                    // A 예약구분
          { wch: 13 },                    // B 집하예정일
          { wch: 15.375 },                // C 받는분성명
          { wch: 15.375 },                // D 받는분전화번호
          { wch: 18 },                    // E 받는분기타연락처
          { wch: 14 },                    // F 받는분우편번호
          { wch: 73.375 },                // G 받는분주소
          { wch: 10, hidden: true },      // H 운송장번호 (숨김)
          { wch: 10, hidden: true },      // I 고객주문번호 (숨김)
          { wch: 10, hidden: true },      // J 품목명 (숨김)
          { wch: 10, hidden: true },      // K 박스수량 (숨김)
          { wch: 10, hidden: true },      // L 박스타입 (숨김)
          { wch: 10, hidden: true },      // M 기본운임 (숨김)
          { wch: 16 },                    // N 배송메세지1
          { wch: 16 },                    // O 배송메세지2
          { wch: 12 },                    // P 품목명
        ],
        purple:[2,3,6], // 받는분성명/받는분전화번호/받는분주소 강조
        row:(o,s,c)=>{
          const phone = o.phone || c.find(x=>x.name===o.customer)?.phone || "";
          const addr = [o.address,o.addressDetail].filter(Boolean).join(" ") || "";
          // 데이터 채우는 컬럼은 3개(받는분성명/전화번호/주소)만, 나머지 13개는 빈칸
          return [
            "",            // 1 예약구분
            "",            // 2 집하예정일
            o.customer,    // 3 받는분성명
            phone,         // 4 받는분전화번호
            "",            // 5 받는분기타연락처
            "",            // 6 받는분우편번호
            addr,          // 7 받는분주소(전체, 분할)
            "",            // 8 운송장번호
            "",            // 9 고객주문번호
            "",            // 10 품목명
            "",            // 11 박스수량
            "",            // 12 박스타입
            "",            // 13 기본운임
            o.deliveryMessage||"",  // 14 배송메세지1
            "",            // 15 배송메세지2
            "",            // 16 품목명 (CJ 양식 중복)
          ];
        },
      },
      "경동화물":{
        cols:["받는분","주소","상세주소","운송장번호","고객사주문번호","우편번호","도착영업소","전화번호","기타전화번호","선불후불","품목명","수량","포장상태","가로","세로","높이","무게","개별단가","배송운임","기타운임","별도운임","할증운임","도서운임","메모"],
        widths:[15,41,42,11,15,9,11,14,13,9,7,5,9,5,5,5,5,9,10,9,9,9,9,26],
        blue:[0,1,2,7,12,18],
        row:(o,s,c)=>{
          let base = o.address||"", detail = o.addressDetail||"";
          // 도로명 끝부분("길 N"/"로 N")이 detail로 잘못 분리된 케이스 보정.
          // 예: AI 파싱 시 base="...다가9", detail="길 22"로 저장된 기존 데이터 → "다가9길 22"로 합침.
          if (base && detail) {
            const alreadyComplete = /[로길]$/.test(base) || /[로길]\s*\d+(?:-\d+)?$/.test(base);
            if (!alreadyComplete) {
              const fix = detail.match(/^(로|길)\s*(\d+(?:-\d+)?)\s*(.*)$/);
              if (fix) {
                const [, suffix, num, rest] = fix;
                base = `${base}${suffix} ${num}`;
                detail = rest.trim();
              }
            }
          }
          // detail 없는 한줄 주소를 번지 기준으로 분리. greedy + 마지막 공백 + 후행 .+ 를
          // 강제해야 정확. 이전 \s? 옵션 + non-greedy 조합은 "다가9길 22"를 "다가9"+"길 22"로
          // 잘못 자르고, "성남대로 43번길 10 하나ez..."도 "...번길"+"10 하나..."로 잘못 자른다.
          if(base && !detail){
            const m = base.match(/^(.+\s\d+(?:-\d+)?(?:번지|번길)?)\s+(.+)$/);
            if(m){ base=m[1].trim(); detail=m[2].trim(); }
          }
          return {
          "받는분":o.customer,
          "주소":base,
          "상세주소":detail,
          "운송장번호":"",
          "고객사주문번호":"",
          "우편번호":"",
          "도착영업소":"",
          "전화번호":o.phone||c.find(x=>x.name===o.customer)?.phone||"",
          "기타전화번호":"",
          "선불후불":"선불",
          "품목명":"원단",
          "수량":"",
          "포장상태":"",
          "가로":"","세로":"","높이":"","무게":"",
          "개별단가":100,
          "배송운임":"","기타운임":100,"별도운임":"","할증운임":"","도서운임":"",
          "메모":o.deliveryMessage||"",
          };
        }
      },
    };
    // 송장 출력 대상 결정 (주문별 splitShipping 자동 적용)
    // - splitShipping=true 주문: 항상 개별 송장 1장
    // - 그 외 합배송 그룹: 그룹당 첫 주문만 대표로 (송장 1장)
    // - 그 외 개별 주문: 그대로
    const seenGroups = new Set();
    const invoiceIds = selIds.filter(id => {
      const o = orders.find(x => x.id === id);
      if (!o) return false;
      if (!o.mergeGroupId || o.splitShipping) return true;
      if (seenGroups.has(o.mergeGroupId)) return false;
      seenGroups.add(o.mergeGroupId);
      return true;
    });
    const targets = orders.filter(o=>invoiceIds.includes(o.id))
      .sort((a,b)=>(a.customer||"").localeCompare(b.customer||"","ko-KR"));
    if (!targets.length) { showToast("선택된 주문이 없습니다","error"); return; }

    const fmt = COLS[courier]||COLS["CJ대한통운"];
    const dataRows = targets.map(o=>{
      const r = fmt.row(o,settings,customers);
      // row가 배열이면 그대로 사용 (CJ 양식처럼 컬럼명 중복 가능), 객체면 컬럼명으로 매핑
      if (Array.isArray(r)) return r.map(v => v != null ? v : "");
      return fmt.cols.map(col=>r[col]!=null?r[col]:"");
    });
    const aoa = [fmt.cols, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // widths가 객체({wch, hidden})면 그대로 사용, 숫자면 wch만 설정
    ws["!cols"]=(fmt.widths||fmt.cols.map(()=>22)).map(w=>typeof w==="object"?w:{wch:w});
    const purpleSet = new Set(fmt.purple||[]);
    const blueSet = new Set(fmt.blue||[]);
    fmt.cols.forEach((_,ci)=>{
      const hAddr = XLSX.utils.encode_cell({r:0,c:ci});
      if(!ws[hAddr]) ws[hAddr]={v:"",t:"s"};
      const isAccent = purpleSet.has(ci) || blueSet.has(ci);
      const accentRgb = purpleSet.has(ci) ? "7030A0" : blueSet.has(ci) ? "0070C0" : "000000";
      ws[hAddr].s = {
        font:{ bold:isAccent, sz:13, color:{ rgb: accentRgb } },
        fill:{ fgColor:{ rgb:"F0F0F0" } },
        alignment:{ horizontal:"center", vertical:"center" },
      };
      for(let ri=1;ri<aoa.length;ri++){
        const dAddr = XLSX.utils.encode_cell({r:ri,c:ci});
        if(!ws[dAddr]) ws[dAddr]={v:"",t:"s"};
        ws[dAddr].s = { font:{ sz:13, color:{ rgb:"000000" } } };
      }
    });
    ws["!rows"]=aoa.map((_,i)=>({hpt: i===0 ? 22 : 20}));
    const wb=XLSX.utils.book_new();
    // CJ대한통운은 LOIS Parcel 표준 시트명 'sheet1' 사용, 그 외는 기존 '송장출력'
    const sheetName = courier === "CJ대한통운" ? "sheet1" : "송장출력";
    XLSX.utils.book_append_sheet(wb,ws,sheetName);
    dlXlsx(wb,`로하이마켓_${courier}_송장.xlsx`);

    // 송장을 뽑았다는 표시를 남긴다.
    // 송장은 묶음당 한 장이지만 그 한 장에 묶음 전체가 실려 나가므로, 표시는 묶음 전원에 남긴다.
    // 인계 화면은 이 표시를 보고 "오늘 나갈 박스"를 고른다 — 송장이 없는 박스는 붙일 게 없어 못 나간다.
    const printedIds = [...new Set(selIds.flatMap(id => {
      const o = orders.find(x => x.id === id);
      return (!o || o.status === "출고완료") ? [] : shipGroupOf(o).map(x => x.id);
    }))];
    const printedAt = await db.markInvoicePrinted(printedIds, `${COURIER_SHORT[courier] || courier} 송장 출력`);
    if (printedAt) setOrders(p=>p.map(o=>printedIds.includes(o.id)?{...o,invoicePrintedAt:printedAt}:o));
    showToast(`${courier} 송장 ${targets.length}건 출력`);
    setShippingOpen(false);
  };

  const deleteItem = async () => {
    if (!confirmDel) return;
    const type = confirmDel.type;
    let ok = false;
    let doneMsg = "삭제 완료";
    try {
      if (type==="order") {
        // 출고 전 주문 삭제 시 이 주문에 사용된 적립금(차감−복원 순액)을 자동 반환.
        // 출고완료 주문은 거래가 완결된 것이므로 반환하지 않음 (대시보드 '주문취소'가 복원 경로).
        // 로그를 삭제 전에 읽는 건 순서를 지키기 위해서다. deleteOrder 는 orders 행만
        // 지우고 payment_logs 는 남긴다(cascade 없음) — 실수로 주문을 지웠을 때
        // "돈은 들어왔는데 흔적이 없는" 상태를 만들지 않으려는 의도다.
        // 남은 로그는 집계에 안 잡힌다. 매출·정산은 주문을 순회하며 logsByOrder[o.id] 로
        // 붙이는 구조라(DashboardTab:205) 주인 없는 로그는 조회되지 않는다.
        const delOrd = orders.find(o=>o.id===confirmDel.id);
        // 포장대에서 잘라 둔 원단이 있으면 먼저 묻는다 — 조각으로 되돌리거나 기록만 지운다. 돌아가기면 삭제 중단.
        const settled = await settlePackingBefore(confirmDel.id, { what: "주문 삭제", by: activeManager });
        if (!settled) { setConfirmDel(null); showToast("삭제를 중단했습니다"); return; }
        const packMsg = settleMessage(settled);
        let creditToRestore = 0;
        let fsMsg = "";
        if (delOrd && delOrd.status!=="출고완료") {
          try {
            const pLogs = await db.fetchOrderLogs(delOrd.id);
            creditToRestore = pLogs.reduce((s,l)=>s+(l.type==="적립금차감"?(l.amount||0):l.type==="적립금복원"?-(l.amount||0):0),0);
          } catch(lgErr) { console.error("삭제 전 적립금 사용액 조회 실패:", lgErr); }
          // 무료배송권도 돌려준다 — 적립금과 같은 이유(출고 전 삭제 = 거래 무효). 반드시 주문을 지우기 *전에*:
          // free_shipping_logs.order_id 가 ON DELETE SET NULL 이라, 지운 뒤에는 cancelFreeShipping 이
          // 이 주문의 사용 기록을 못 찾아 아무것도 안 한다(2026-10-07 — 수정창에서 쓰고 삭제하니 안 돌아온 건).
          if (delOrd.freeShippingUsed) {
            try {
              await db.cancelFreeShipping(delOrd.customer, delOrd.id);   // 1장 복원 + 배송권차감 로그 삭제. 이미 복원된 건이면 no-op
              reloadFreeShipping?.();
              fsMsg = " · 무료배송권 1장 반환";
            } catch(fsErr) {
              console.error("무료배송권 반환 실패:", fsErr);
              fsMsg = " · 무료배송권 반환 실패 — 정산관리에서 직접 등록해주세요";
            }
          }
        }
        deleteOrderImages(confirmDel.id).catch(()=>{});
        await db.deleteOrder(confirmDel.id);
        setOrders(p=>p.filter(o=>o.id!==confirmDel.id));
        ok = true;
        if (creditToRestore > 0) {
          try {
            const savedCredit = await db.insertCredit({customer:delOrd.customer, amount:creditToRestore, type:"적립", reason:"주문 삭제 — 사용 적립금 반환", manager:activeManager});
            if (savedCredit) setCredits(p=>[savedCredit,...p]);
            doneMsg = `삭제 완료 — ${delOrd.customer}님 적립금 ${creditToRestore.toLocaleString()}원 반환`;
          } catch(crErr) {
            console.error("적립금 반환 실패:", crErr);
            doneMsg = `주문은 삭제됐지만 적립금 ${creditToRestore.toLocaleString()}원 반환 실패 — 정산관리에서 직접 등록해주세요`;
          }
        }
        if (fsMsg) doneMsg = (creditToRestore > 0 ? doneMsg : `삭제 완료 — ${delOrd.customer}님`) + fsMsg;
        if (packMsg) doneMsg += packMsg;
      }
      else if (type==="inv") { await db.deleteInventoryItem(confirmDel.id); setInv(p=>p.filter(i=>i.id!==confirmDel.id)); ok = true; }
      else if (type==="log") { await db.deleteLog(confirmDel.id); setLogs(p=>p.filter(l=>l.id!==confirmDel.id)); ok = true; }
      else if (type==="customer") {
        const delCust = customers.find(c=>c.id===confirmDel.id);
        await db.deleteCustomer(confirmDel.id);
        setCustomers(p=>p.filter(c=>c.id!==confirmDel.id));
        ok = true;
        // 감사 기록 — 누가·언제·어떤 고객을 지웠는지 입출고 로그에 남김 (실패해도 삭제 자체는 유지)
        try {
          const log = await db.insertLog({...nowT(), type:"고객삭제", fabric:delCust?.name||confirmDel.label||"", ref:"고객관리", note:`연락처 ${delCust?.phone||"없음"} — 삭제자: ${activeManager||"미지정"}`});
          if (log) setLogs(p=>[log,...p]);
        } catch(auditErr) { console.error("고객 삭제 기록 실패:", auditErr); }
      }
      else if (type==="reset") {
        await db.clearAllData();
        const [i,m] = await Promise.all([db.fetchInventory(), db.fetchManagers()]);
        setOrders([]);
        setInv(i.length ? i : DEFAULT_INV);
        setLogs([]);
        setCustomers([]);
        setSettings(DEFAULT_SETTINGS);
        setManagers(m.length ? m : DEFAULT_MANAGERS);
        ok = true;
        showToast("전체 초기화 완료");
      }
    } catch(e) {
      console.error("Delete error:", e);
      showToast("삭제 실패: "+(e.message||"오류"),"error");
    }
    setConfirmDel(null);
    if (ok && type!=="reset") showToast(doneMsg);
  };

  const totalQty = orders.reduce((a,o)=>a+o.items.reduce((b,i)=>b+i.qty,0),0);
  // 미수금이 남은 건 — 상단 미입금 배지와 주문현황 결제 필터가 같은 걸 봐야 한다.
  //
  // payment 컬럼 원값이 아니라 계산된 결제상태(getPayStatus)로 판단한다. 엑셀로 들여온
  // 주문은 결제구분 칸의 셀 값("카드"·"무통장"·"-")이 컬럼에 그대로 들어가 있어서
  // (ExcelImport.jsx:355), 원값을 비교하면 실제로는 미입금인 건이 목록에서 통째로 빠졌다.
  // 배지는 계산값을 보고 필터는 원값을 봤기 때문에, 숫자를 눌러도 그만큼 나오지 않았다.
  //
  // 부분입금도 포함한다 — 세려는 건 '아직 돈이 덜 들어온 주문'이지 '한 푼도 안 들어온
  // 주문'이 아니다. 환불/환불신청은 결제가 아니라 되돌리는 절차라 여기서 뺀다.
  const isUnpaidOrder = (o) => {
    if (o.payment === "환불" || o.payment === "환불신청") return false;
    const s = getPayStatus(o);
    return s === "미입금" || s === "부분입금";
  };
  const unpaid = orders.filter(o=>o.status!=="출고완료"&&isUnpaidOrder(o)).length;
  // 주문현황 탭 필터 — 출고완료/환불완료/환불(전액 종결) 외 모두 표시 (배포본과 동일)
  const orderListFiltered = useMemo(() => {
    const q = orderSearch.trim().toLowerCase();
    const f = orderFilter;
    // 닉네임 검색 — 주문엔 닉네임이 없어, q를 닉네임에 포함하는 고객들의 이름 집합으로 매칭
    const nickNames = q ? new Set(customers.filter(c=>(c.nickname||"").toLowerCase().includes(q)).map(c=>c.name)) : null;
    return orders.filter(o => {
      const cs = o._computed?.paymentStatus || o.payment;
      if (o.status === "출고완료") return false;
      if (o.payment === "환불" || cs === "환불완료") return false;
      if (q && !(
        (o.customer||"").toLowerCase().includes(q) ||
        (o.phone||"").includes(q) ||
        (o.note||"").toLowerCase().includes(q) ||
        (o.memo||"").toLowerCase().includes(q) ||
        (o.address||"").toLowerCase().includes(q) ||
        (o.addressDetail||"").toLowerCase().includes(q) ||
        (o.deliveryMessage||"").toLowerCase().includes(q) ||
        (nickNames && nickNames.has(o.customer)) ||
        (o.items||[]).some(it=>(it.fabric||"").toLowerCase().includes(q)||(it.color||"").toLowerCase().includes(q)||(it.itemNo||"").toLowerCase().includes(q))
      )) return false;
      if (f.dateFrom && o.date && o.date.replace(/\./g,"-") < f.dateFrom) return false;
      if (f.dateTo && o.date && o.date.replace(/\./g,"-") > f.dateTo) return false;
      if (f.manager && o.manager !== f.manager) return false;
      // "미포장" 가상 상태 — 아직 포장 전인 주문 (포장완료·보관·보류·출고완료 제외, 상태 없는 구주문 포함)
      //
      // 보관·보류는 status 가 아니라 플래그다(is_holding / is_parked). status 만 보면
      // status="보관" 인 옛 주문만 빠지고, 요즘 보관한 건은 status 가 "접수"인 채라
      // 미포장에 그대로 남는다 — 같은 건이 미포장과 보관 양쪽에 이중으로 잡혔다.
      if (f.status === "미포장") { if (o.status === "포장완료" || o.status === "출고완료" || isHold(o) || isParked(o)) return false; }
      // 보관은 status와 독립 토글 — '포장완료 + 보관' 동시 건도 보관 필터에 잡혀야 한다
      else if (f.status === "보관") { if (!isHold(o)) return false; }
      else if (f.status && o.status !== f.status) return false;
      // 결제 필터도 계산된 상태로 거른다(위 isUnpaidOrder 주석 참고) — 상단 미입금 배지를
      // 눌러 들어오는 길이라, 배지와 다른 걸 보면 숫자와 목록이 어긋난다.
      // 입금완료에 부분환불을 함께 넣는 이유: 부분환불은 돈을 다 받은 뒤 금액을 조정한
      // 것이라 payment 컬럼이 "입금완료"로 남는다. 빼면 지금까지 보이던 건이 사라진다.
      if (f.payment === "미입금") { if (!isUnpaidOrder(o)) return false; }
      else if (f.payment === "입금완료") { const s = getPayStatus(o); if (s !== "입금완료" && s !== "부분환불") return false; }
      else if (f.payment && o.payment !== f.payment) return false;
      if (f.combinedShipping && !o.combinedShipping) return false;
      if (f.combinedPayment && !o.combinedPayment) return false;
      if (f.receiptType) {
        if (f.receiptType === "none") { if (o.receiptType) return false; }
        else if (o.receiptType !== f.receiptType) return false;
      }
      return true;
    });
  }, [orders, orderSearch, orderFilter, customers]);
  // 상단 "환불" 카운트 — 정산관리 환불목록에 떠있는 건만(payment="환불신청")
  // 환불완료/부분환불 등 이미 처리된 건은 제외
  const refundCount = orders.filter(o=>o.payment==="환불신청").length;
  // 상단 현황 공통 — 진행중 주문 (출고완료·환불 종결 제외)
  const isActiveOrder = o => {const cs=o._computed?.paymentStatus||o.payment;return o.status!=="출고완료"&&o.payment!=="환불"&&cs!=="환불완료";};
  const activeOrderCount = orders.filter(isActiveOrder).length;
  // 포장 담당자 헤더용 — 미포장(포장 전) · 보관 · 합배송 카운트
  // 보관·보류는 isHold/isParked 로 뺀다. status="보관" 만 보면 그건 옛 주문 표기뿐이라
  // 요즘 보관한 건(is_holding=true, status="접수")이 미포장에 그대로 남아, 바로 옆
  // 보관 칩(storedCount)과 같은 건을 두 번 세게 된다.
  const unpackedCount = orders.filter(o=>isActiveOrder(o)&&o.status!=="포장완료"&&!isHold(o)&&!isParked(o)).length;
  // 라벨·송장 출력 — 고른 것과 전체출력이 같은 길을 타게 한 곳에 모은다.
  //
  // 라벨은 누른 기기에서 뽑지 않는다. 요청만 걸고 라벨 PC 가 대신 뽑는다 —
  // PS100 은 한 대에만 물려 있어서, 누른 기기에서 인쇄창을 띄우면 모바일로 고른
  // 사람은 아예 못 뽑는다. 이 기기가 마침 라벨 PC 여도 같은 길을 탄다.
  // 경로가 둘이면 한쪽만 고쳐지고 어긋난다.
  const runPrint = async (mode, ids) => {
    if (mode === "ship") {   // 송장은 기존 모달이 처리 — 관리자만 (버튼도 관리자에게만 보인다)
      if (!isAdminRole) { showToast("송장 출력은 관리자만 할 수 있습니다", "error"); return; }
      setShippingOpen(true); return;
    }
    const targets = orders.filter(o => ids.includes(o.id) && (o.items || []).length > 0);
    if (!targets.length) { showToast("라벨을 뽑을 품목이 없습니다", "error"); return; }
    try {
      const n = await db.requestLabelPrint(targets.map(o => o.id), activeManager || "");
      setSelectedOrders([]); setSelectMode(null);
      // 담당 기기가 없으면 요청이 아무 데도 안 간다. 조용히 넘어가면 사람은
      // 뽑힌 줄 알고 포장대에서 라벨을 찾다가 없다는 걸 나중에 안다.
      if (!labelStationRow) {
        showToast(`🏷️ ${n}건 요청 — 다만 라벨 출력 담당 기기가 없습니다. `
          + "설정 → 라벨 자동 출력에서 PS100 이 연결된 컴퓨터를 지정해 주세요", "error");
      } else {
        showToast(labelStation
          ? `🏷️ 라벨 ${n}건 요청 — 이 컴퓨터에서 곧 나옵니다`
          : `🏷️ 라벨 ${n}건 요청 — ${labelStationRow.deviceName || "담당 기기"} 에서 나옵니다`);
      }
      await reloadOrders();
    } catch (e) {
      showToast("라벨 요청 실패: " + e.message, "error");
    }
  };
  // 전체출력 — 지금 검색·필터에 걸린 것 전부. 목록에 안 보이는 걸 뽑지 않도록
  // orders 전체가 아니라 걸러진 목록을 쓴다.
  const printAll = (mode) => runPrint(mode, orderListFiltered.map(o => o.id));

  // 감사 라벨(💌) — 주문을 고르지 않고 장수만 건다. 원단 라벨과 같은 길(요청 → 담당 PC 출력).
  const requestThanks = async (qty) => {
    const n = parseInt(qty) || 0;
    if (n <= 0) { showToast("장수를 입력하세요", "error"); return; }
    try {
      await db.requestThanksLabels(n, activeManager || "");
      setThanksAsk(null);
      if (!labelStationRow) {
        showToast(`💌 ${n}장 요청 — 다만 라벨 출력 담당 기기가 없습니다. `
          + "설정 → 라벨 자동 출력에서 PS100 이 연결된 컴퓨터를 지정해 주세요", "error");
      } else {
        showToast(labelStation
          ? `💌 감사 라벨 ${n}장 요청 — 이 컴퓨터에서 곧 나옵니다`
          : `💌 감사 라벨 ${n}장 요청 — ${labelStationRow.deviceName || "담당 기기"} 에서 나옵니다`);
      }
      reloadThanksReqs();
    } catch (e) {
      const missing = ["42P01", "PGRST205"].includes(e?.code) || /thanks_label_requests/.test(String(e?.message || ""));
      showToast("감사 라벨 요청 실패: " + (missing ? "DB 에 감사 라벨 표가 없습니다 — migrations/add_thanks_label.sql 을 먼저 실행하세요" : e.message), "error");
    }
  };

  // ── 라벨 출력 (담당 기기) ────────────────────────────────────
  // 스위치를 켠 기기에서만 돈다. 다른 기기에서 건 출력요청이 Realtime 으로 들어오면
  // 여기서 뽑는다 — 요청한 사람은 인쇄에 대해 아무것도 하지 않는다.
  //
  // 한 번에 보내는 장수. 밀린 게 있으면 이만큼씩 끊어 보내고, 출력권을 집으면
  // Realtime 이 목록을 다시 돌려주므로 다음 묶음이 이어서 나간다 — 결국 밀린 건
  // 전부 나온다. 끊는 건 인쇄 작업 하나가 지나치게 커지지 않게 하려는 것뿐이다.
  const AUTO_PRINT_MAX = 10;
  // 밀린 게 이보다 많으면 아예 자동으로 뽑지 않는다.
  // 여기까지 쌓였다는 건 정상 흐름이 아니다 — 스위치를 켜둔 채 며칠 방치했거나,
  // 프린터가 죽어 있었거나, 기준 시각이 잘못 잡힌 것이다. 감열지는 되돌릴 수 없어서
  // 그 상태로 수백 장을 쏟는 것보다 사람에게 묻는 쪽이 언제나 싸다.
  const AUTO_PRINT_ALARM = 30;
  const autoPrintingRef = useRef(false);
  // 경고를 한 번만 띄우기 위한 표식. 밀린 건수가 그대로면 다시 알리지 않는다 —
  // orders 가 바뀔 때마다 토스트가 뜨면 화면을 덮어 정작 다른 알림을 가린다.
  const autoPrintAlarmedRef = useRef(0);
  const rollPrintAlarmedRef = useRef(0);   // 롤 라벨용 — 주문 라벨과 따로 센다
  useEffect(() => {
    if (!labelStation) return;
    if (autoPrintingRef.current) return;

    // 스위치를 켠 시각(labelStationAt)은 더 이상 기준이 아니다.
    //
    // 등록만으로 뽑던 시절엔 켠 시각이 필요했다 — 안 그러면 스위치를 켜는 순간
    // 지난 주문이 통째로 쏟아졌다. 지금은 사람이 고른 것만 뽑으므로 그럴 일이 없고,
    // 오히려 기준을 두면 라벨 PC 가 잠깐 꺼져 있는 동안 걸린 요청이 조용히 사라진다.
    // 요청은 사람이 명시적으로 한 것이라 늦게라도 나와야 한다.
    const pending = orders
      // 이미 나간 주문·환불 건은 뽑을 이유가 없다. 요청이 걸렸고 아직 안 뽑은 것만.
      .filter(o => isActiveOrder(o) && o.labelRequestedAt && !o.labelPrintedAt
        && (o.items || []).length > 0)
      // 요청한 순서대로 뽑아야 포장대에 쌓인 순서가 사람이 고른 순서와 같아진다.
      // 시각은 숫자로 비교한다 — DB 는 '...11.123456+00:00' 로 주고 브라우저는
      // '...11.123Z' 를 만드는데, 문자열로 견주면 같은 순간인데도 '4' < 'Z' 라 어긋난다.
      .sort((a, b) => Date.parse(a.labelRequestedAt) - Date.parse(b.labelRequestedAt));

    // 롤 라벨 — 검단을 마친 롤. 주문 라벨과 같은 자리에서 훑되 인쇄는 따로 보낸다
    // (한 문서에 섞지 않는다 — 내용도 붙이는 곳도 다르다).
    const pendingRolls = rolls
      .filter(r => r.labelRequestedAt && !r.labelPrintedAt)
      .sort((a, b) => Date.parse(a.labelRequestedAt) - Date.parse(b.labelRequestedAt));
    // 감사 라벨(💌) — 요청 한 줄 = N 장. 내용은 다 같으니 장수를 합쳐 한 문서로 보낸다.
    const pendingThanks = [...thanksReqs]
      .filter(r => !r.printedAt)
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));

    if (!pending.length) autoPrintAlarmedRef.current = 0;
    if (!pendingRolls.length) rollPrintAlarmedRef.current = 0;
    if (!pending.length && !pendingRolls.length && !pendingThanks.length) return;

    // 너무 많이 밀렸으면 그쪽만 멈춘다. 주문 라벨이 밀렸다고 롤 라벨까지 막지 않는다.
    let waiting = [];
    if (pending.length > AUTO_PRINT_ALARM) {
      if (autoPrintAlarmedRef.current !== pending.length) {
        autoPrintAlarmedRef.current = pending.length;
        showToast(`🏷️ 출력요청이 ${pending.length}건 밀렸습니다 — 너무 많아 출력을 멈췄습니다. `
          + "주문현황에서 필요한 것만 다시 골라 주세요", "error");
      }
    } else {
      autoPrintAlarmedRef.current = 0;
      waiting = pending.slice(0, AUTO_PRINT_MAX);
    }
    // 롤 라벨은 밀려도 멈추지 않는다 — 요청 하나가 실물 롤 하나라 어차피 다 뽑아야 하고,
    // 멈추면 요청을 거두는 길이 없어 영영 안 나왔다(2026-10-13 점검). 10장씩 끊어 보내면 결국 다 나온다.
    // 많이 밀렸을 때는 한 번만 알린다 — 필요 없는 건 롤 재고의 '라벨 요청 취소'로 뺀다.
    if (pendingRolls.length > AUTO_PRINT_ALARM && rollPrintAlarmedRef.current !== pendingRolls.length) {
      rollPrintAlarmedRef.current = pendingRolls.length;
      showToast(`🏷️ 롤 라벨 요청이 ${pendingRolls.length}건 밀려 있습니다 — ${AUTO_PRINT_MAX}장씩 차례로 뽑습니다. `
        + "필요 없는 건 롤 재고에서 '라벨 요청 취소'", "error");
    }
    const waitingRolls = pendingRolls.slice(0, AUTO_PRINT_MAX);
    // 감사 라벨은 밀림 경보를 따로 두지 않는다 — 한 번에 AUTO_PRINT_MAX 장씩 끊어 보내면 결국 다 나온다.
    const waitingThanks = pendingThanks.slice(0, AUTO_PRINT_MAX);
    if (!waiting.length && !waitingRolls.length && !waitingThanks.length) return;

    autoPrintingRef.current = true;
    (async () => {
      try {
        // 인쇄보다 출력권을 먼저 집는다. 순서를 뒤집으면 인쇄는 됐는데 표시가
        // 실패하는 창이 생기고, 그다음 새로고침에 같은 라벨이 또 나온다.
        // 못 집은 건(다른 기기가 이미 가져간 건)은 조용히 버린다.
        const mine = [];
        for (const o of waiting) {
          try { if (await db.claimLabelPrint(o.id)) mine.push(o); }
          catch (e) { console.warn("[라벨자동] 출력권 실패", o.id, e); }
        }
        if (mine.length) {
          const n = await printFabricLabels(mine, orders);
          // 누가 요청한 건지 붙인다 — 이 PC 앞의 사람은 뽑히는 이유를 모른 채
          // 라벨이 나오는 걸 보게 되고, 잘못 나왔을 때 되물을 상대도 이 이름이다.
          const who = [...new Set(mine.map(o => (o.labelRequestedBy || "").trim()).filter(Boolean))];
          showToast(`🏷️ 라벨 출력 — ${mine.length}건 · ${n}장`
            + (who.length ? ` · ${who.join("·")}님 요청` : ""));
          await reloadOrders();
        }

        // ── 롤 라벨 ──
        const myRolls = [];
        for (const r of waitingRolls) {
          try { if (await db.claimRollLabelPrint(r.id)) myRolls.push(r); }
          catch (e) { console.warn("[롤라벨] 출력권 실패", r.id, e); }
        }
        if (myRolls.length) {
          // 주문 라벨을 방금 보냈으면 한 박자 쉰다. 인쇄 두 건이 같은 순간에 겹치면
          // 브라우저가 뒤의 것을 버릴 수 있다.
          if (mine.length) await new Promise(res => setTimeout(res, 1500));
          try {
            // 품번 정보가 아직 안 온 롤이 있으면(방금 등록한 품번) 다시 읽어 온다.
            // 없이 뽑으면 라벨에 원단명이 비어 나온다.
            let plist = products;
            if (myRolls.some(r => !plist.find(p => p.id === r.productId))) {
              plist = await db.fetchProducts();
              setProducts(plist);
            }
            const n = await printRollLabels(myRolls, plist, { company: settings.senderName || "로하이마켓" });
            showToast(`🏷️ 롤 라벨 출력 — ${n}장 · ${myRolls.map(r => r.rollCode).join(", ")}`);
          } catch (e) {
            // 못 뽑았으면 출력권을 놓아준다. 쥐고 있으면 '뽑았다'로 남아 다시는 안 나온다.
            console.error("[롤라벨] 인쇄 실패", e);
            for (const r of myRolls) {
              try { await db.releaseRollLabelPrint(r.id); }
              catch (e2) { console.warn("[롤라벨] 출력권 되돌리기 실패", r.id, e2); }
            }
            showToast("롤 라벨 인쇄 실패: " + (e.message || "오류"), "error");
          }
          await reloadRolls();
        }

        // ── 감사 라벨 ──
        const myThanks = [];
        for (const r of waitingThanks) {
          try { if (await db.claimThanksLabelPrint(r.id)) myThanks.push(r); }
          catch (e) { console.warn("[감사라벨] 출력권 실패", r.id, e); }
        }
        if (myThanks.length) {
          if (mine.length || myRolls.length) await new Promise(res => setTimeout(res, 1500));
          const total = myThanks.reduce((s, r) => s + (r.count || 0), 0);
          try {
            const n = printThanksLabels(total);
            const who = [...new Set(myThanks.map(r => (r.requestedBy || "").trim()).filter(Boolean))];
            showToast(`💌 감사 라벨 출력 — ${n}장` + (who.length ? ` · ${who.join("·")}님 요청` : ""));
          } catch (e) {
            console.error("[감사라벨] 인쇄 실패", e);
            for (const r of myThanks) {
              try { await db.releaseThanksLabelPrint(r.id); }
              catch (e2) { console.warn("[감사라벨] 출력권 되돌리기 실패", r.id, e2); }
            }
            showToast("감사 라벨 인쇄 실패: " + (e.message || "오류"), "error");
          }
          await reloadThanksReqs();
        }
      } finally {
        autoPrintingRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, rolls, thanksReqs, labelStation]);

  // 라벨 PC 의 안전망 — 실시간 알림을 놓쳐도 20초 안팎에 스스로 받아 온다.
  //
  // 라벨 PC 는 사람이 다른 일을 하는 컴퓨터라 ERP 창이 다른 창 뒤에 가려져 있는 시간이 길다. 크롬은
  // 가려진 창을 '안 보이는 창'으로 보고 타이머를 늦추는데, 그 사이 실시간 연결이 끊기면 다시 붙지
  // 못한 채 남았다. 위의 깨우기(wake)는 창이 보일 때만 돌아서, 누가 창을 눌러 줘야 밀린 라벨이 나왔다
  // (2026-10-02 확인: 9/29~10/1 에 6~21분 늦게 나온 건이 6번, 전부 창을 누른 시각에 몰려 나왔다).
  // 그래서 담당 기기에서만, 창이 보이든 말든 안 뽑은 요청이 있는지 가볍게 묻고, 이 화면이 모르는
  // 요청이 있을 때만 다시 읽는다. 가려진 창에서는 크롬이 타이머를 최대 1분 간격으로 늦출 수 있다.
  const ordersRef = useRef(orders); ordersRef.current = orders;
  const rollsRef = useRef(rolls); rollsRef.current = rolls;
  const thanksRef = useRef(thanksReqs); thanksRef.current = thanksReqs;
  useEffect(() => {
    if (!labelStation) return;
    let busy = false;
    // 한 번 다시 읽었는데도 화면에 안 들어오는 요청(이미 나간 주문 등 — 화면은 미출고만 든다)은
    // 다시 읽어도 소용없다. 그런 id 는 기억해 두고 또 읽지 않는다 — 20초마다 전체를 다시 받게 된다.
    const tried = new Set();
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const { orderIds, rollIds, thanksIds = [] } = await db.fetchPendingLabelIds();
        const knownOrders = new Set(ordersRef.current.filter(o => o.labelRequestedAt && !o.labelPrintedAt).map(o => String(o.id)));
        const knownRolls = new Set(rollsRef.current.filter(r => r.labelRequestedAt && !r.labelPrintedAt).map(r => String(r.id)));
        const knownThanks = new Set(thanksRef.current.filter(r => !r.printedAt).map(r => String(r.id)));
        const missedOrders = orderIds.filter(id => !knownOrders.has(id) && !tried.has(`o:${id}`));
        const missedRolls = rollIds.filter(id => !knownRolls.has(id) && !tried.has(`r:${id}`));
        const missedThanks = thanksIds.filter(id => !knownThanks.has(id) && !tried.has(`t:${id}`));
        // 뽑혀서 사라진 요청은 잊는다 — 같은 주문이 나중에 다시 요청되면 그때 또 받아 와야 한다.
        const live = new Set([...orderIds.map(id => `o:${id}`), ...rollIds.map(id => `r:${id}`), ...thanksIds.map(id => `t:${id}`)]);
        for (const k of [...tried]) if (!live.has(k)) tried.delete(k);
        missedOrders.forEach(id => tried.add(`o:${id}`));
        missedRolls.forEach(id => tried.add(`r:${id}`));
        missedThanks.forEach(id => tried.add(`t:${id}`));
        if (missedOrders.length) await reloadOrders();
        if (missedThanks.length) await reloadThanksReqs();
        if (missedRolls.length) await reloadRolls();
      } catch (e) { console.warn("[라벨자동] 밀린 요청 확인 실패", e); }
      finally { busy = false; }
    };
    const id = setInterval(check, 20000);
    return () => clearInterval(id);
  }, [labelStation, reloadOrders, reloadRolls, reloadThanksReqs]);

  const storedCount = orders.filter(o=>isActiveOrder(o)&&isHold(o)).length;

  // ── 원단 호출 ───────────────────────────────────────────────
  // 오래 부른 것부터. 제일 오래 기다린 포장직원이 배너 맨 위에 있어야 한다.
  const fabricCalls = useMemo(() =>
    orders.filter(isFabricMissing)
      .sort((a,b)=>(a.fabricMissingAt||"").localeCompare(b.fabricMissingAt||"")), [orders]);
  const fabricOldestMins = fabricCalls.length ? fabricWaitMins(fabricCalls[0], nowTs) : 0;
  // 5분 넘게 남아 있으면 판을 빨갛게 올린다 — 원단은 보통 몇 분이면 오므로
  // 5분을 넘겼다는 건 담당자가 못 봤거나 자리에 없다는 뜻이다.
  const fabricUrgent = fabricOldestMins >= 5;
  // 지금 걸려 있는 호출들의 지문. '확인'은 이 지문을 기억해 배너를 접는 것뿐이라
  // DB를 건드리지 않는다 — 원단이 실제로 도착하는 것보다 확실한 신호가 없는데,
  // 그걸 위해 셀러에게 버튼을 하나 더 누르게 할 이유가 없다.
  // 새 호출이 뜨거나 안 온 품목이 바뀌면 지문이 달라져 배너가 저절로 다시 올라온다.
  const fabricSig = useMemo(() =>
    fabricCalls.map(o=>`${o.id}:${missingItemIdx(o).join("-")}`).join("|"), [fabricCalls]);
  // 포장직원에게는 배너도 소리도 없다. 부른 사람이 자기 자신이고, 카드에 분홍 품목 줄과
  // '원단 대기 N분째' 배지가 이미 떠 있다. 방금 누른 걸 다시 알려주면 소음일 뿐이고,
  // 소음이 쌓이면 정작 봐야 할 때 안 보게 된다. 이 알림은 셀러(와 옆사람)를 향한 것이다.
  const fabricShown = !isPackerRole && fabricCalls.length > 0 && fabricDismissed !== fabricSig;
  // 건수는 주문이 아니라 원단 개수로 센다. 한 주문에서 원단 셋이 안 왔는데 '1건'이라고
  // 하면 셀러가 하나만 들고 온다 — 세는 단위가 곧 가져올 개수여야 한다.
  const fabricByManager = useMemo(() => {
    const m = new Map();
    for (const o of fabricCalls) {
      const k = o.manager || "담당자 없음";
      m.set(k, (m.get(k)||0) + missingItemIdx(o).length);
    }
    return [...m].map(([name,n])=>({name,n}));
  }, [fabricCalls]);

  // 소리 — 파일을 두지 않고 그때그때 만든다(자산·네트워크 없음).
  // 두 번 짧게 울리는 이유: 한 번이면 작업장 소음에 묻힌다.
  const audioCtxRef = useRef(null);
  const beep = useCallback(() => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioCtxRef.current || (audioCtxRef.current = new Ctx());
      if (ctx.state === "suspended") ctx.resume();

      // 압축기를 물려 끝 음량을 끌어올린다. 배음을 여러 개 겹치면 봉우리에서 찌그러지는데,
      // 압축기가 그 봉우리만 눌러줘서 '찌그러지지 않으면서 더 크게' 들린다.
      // 사이렌처럼 계속 밀어붙이지 않고도 한 번에 확실히 들리게 하는 방법이다.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 10;
      comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.15;
      comp.connect(ctx.destination);

      // 한 음 = 기음 + 배음 둘. 사인 하나만 쓰면 같은 음량값이어도 훨씬 작게 들린다 —
      // 소리에 몸이 있어야 작업장 소음 위로 뜬다. 여운을 길게 끌어 종소리처럼 남긴다.
      const chime = (freq, at, dur) => {
        for (const [mult, amp] of [[1, 1], [2, 0.45], [3, 0.18]]) {
          const osc = ctx.createOscillator(), g = ctx.createGain();
          osc.type = "sine"; osc.frequency.value = freq * mult;
          g.gain.setValueAtTime(0.0001, at);
          // 0.45 는 실측으로 고른 값 — 더 올려도 압축기가 눌러서 이득이 거의 없고
          // (0.60 → 체감 +1dB), 여기서 피크가 0.70 이라 찌그러질 여유도 남는다.
          g.gain.exponentialRampToValueAtTime(0.45 * amp, at + 0.012); // 빠른 어택 = 또렷함
          g.gain.exponentialRampToValueAtTime(0.0001, at + dur);       // 긴 감쇠 = 종소리
          osc.connect(g); g.connect(comp);
          osc.start(at); osc.stop(at + dur + 0.02);
        }
      };

      // 미–솔–도 올림 화음. 주파수를 훑지 않고 음을 딛고 올라가므로 사이렌으로 안 들린다.
      // 마지막 음을 길게 남겨 "불렀다"는 여운을 준다. 전체 1.2초 남짓.
      const t = ctx.currentTime + 0.02;
      chime(659.25, t,        0.55);   // E5
      chime(783.99, t + 0.14, 0.55);   // G5
      chime(1046.50, t + 0.28, 0.95);  // C6
    } catch { /* 소리는 덤이다 — 실패해도 배너는 그대로 뜬다 */ }
  }, []);

  // 브라우저는 사용자가 한 번이라도 페이지를 건드리기 전에는 소리를 막는다.
  // 첫 클릭 때 오디오를 미리 열어두지 않으면 그날의 첫 호출이 조용히 지나갈 수 있다 —
  // 작은 소리보다 안 나는 소리가 훨씬 나쁘다.
  useEffect(() => {
    const unlock = () => {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = audioCtxRef.current || (audioCtxRef.current = new Ctx());
        if (ctx.state === "suspended") ctx.resume();
      } catch { /* 못 열어도 배너는 뜬다 */ }
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // 새 호출이 뜨는 순간 한 번. Realtime 이 orders 를 밀어주므로 부른 사람 화면뿐
  // 아니라 열려 있는 모든 화면에서 동시에 울린다.
  //
  // '주문 수'로 세면 안 된다 — 같은 주문에서 원단이 하나 더 막히면 주문 수는
  // 그대로(1→1)라 소리가 안 난다. 실제로 부르는 단위는 품목이다.
  // 개수 대신 품목 집합으로 비교하는 이유: 하나가 해제되고 다른 하나가 걸린 게
  // 한 번에 반영되면 개수는 같지만 새로 부른 원단이 있다. 그때도 울려야 한다.
  const fabricKeys = useMemo(
    () => fabricCalls.flatMap(o => missingItemIdx(o).map(i => `${o.id}:${i}`)), [fabricCalls]);
  const prevKeysRef = useRef(new Set());
  useEffect(() => {
    const prev = prevKeysRef.current;
    prevKeysRef.current = new Set(fabricKeys);
    // 기록은 역할과 무관하게 갱신한다. 안 그러면 포장 담당자를 껐다 켰을 때
    // 기준이 비어 있어 이미 걸려 있던 호출이 전부 새 호출로 잡혀 한꺼번에 울린다.
    if (isPackerRole) return;
    if (fabricKeys.some(k => !prev.has(k))) beep();
  }, [fabricKeys, beep, isPackerRole]);

  // 반복해서 울리지는 않는다 — 호출이 뜨는 순간 한 번뿐이다.
  // 계속 우는 알림은 결국 소리를 꺼버리게 만들고, 그러면 정작 급할 때 안 들린다.
  // 무응답이 길어질 때의 재촉은 소리 대신 배너 색으로 한다(5분 넘으면 빨강).
  const combinedCount = orders.filter(o=>isActiveOrder(o)&&o.combinedShipping).length;

  // 같은 고객 자동 묶기 — 미지정 합배송(표시만 있고 그룹 없음) + 접수 상태 주문을 고객명별로 그룹 생성
  const autoMergeSameCustomer = async () => {
    const pool = orders.filter(o=>isActiveOrder(o) && o.combinedShipping && !o.mergeGroupId && o.status==="접수");
    const byCust = {};
    pool.forEach(o=>{ if(o.customer) (byCust[o.customer] = byCust[o.customer] || []).push(o); });
    const targets = Object.values(byCust).filter(l=>l.length>=2);
    if (targets.length===0) { showToast("같은 고객끼리 묶을 미지정 합배송 주문(2건 이상)이 없습니다","error"); return; }
    try {
      const created = [];
      for (const list of targets) {
        const gid = (typeof crypto!=="undefined" && crypto.randomUUID) ? crypto.randomUUID() : `mg_${Date.now()}_${Math.random().toString(36).slice(2,10)}`;
        const ids = list.map(o=>o.id);
        await db.setMergeGroup(ids, gid);
        created.push({groupId: gid, ids});
        await settleGroup(list.map(o => ({ ...o, mergeGroupId: gid })), "같은 고객 자동 묶기");
      }
      const idToGid = new Map(created.flatMap(c=>c.ids.map(id=>[id, c.groupId])));
      setOrders(p=>p.map(o=>idToGid.has(o.id)?{...o,mergeGroupId:idToGid.get(o.id)}:o));
      setAutoMergeUndo(created);
      showToast(`같은 고객 ${created.length}묶음 자동 생성 (${created.reduce((s,c)=>s+c.ids.length,0)}건)`);
    } catch(e){ console.error(e); showToast("자동 묶기 실패: "+e.message,"error"); }
  };
  // 자동 묶기 되돌리기 — 방금 만든 그룹만 해제 (수동으로 만든 묶음은 건드리지 않음)
  const undoAutoMerge = async () => {
    if (!autoMergeUndo?.length) return;
    try {
      const allIds = autoMergeUndo.flatMap(c=>c.ids);
      await db.setMergeGroup(allIds, null);
      setOrders(p=>p.map(o=>allIds.includes(o.id)?{...o,mergeGroupId:null}:o));
      // 풀린 주문은 각각 1건 그룹 — 묶일 때 내려놓은 택배비가 있으면 되돌아온다 (3단계)
      for (const id of allIds) { const o = orders.find(x => x.id === id); if (o) await settleGroup([{ ...o, mergeGroupId: null }], "자동 묶기 되돌림"); }
      setAutoMergeUndo(null);
      showToast(`자동 묶기 ${autoMergeUndo.length}묶음 되돌림`);
    } catch(e){ console.error(e); showToast("되돌리기 실패: "+e.message,"error"); }
  };
  const low = inv.filter(i=>i.stock<settings.lowStockAlert);
  // 포장(7)은 뒤에 붙인다 — 기존 인덱스(setTab(1), setTab(4) 등)가 코드 전반에 박혀 있어
  // 중간에 끼우면 전부 어긋난다. 화면상의 순서는 아래 PACK_TAB / visibleTabs 로 따로 정한다.
  const TABS = [{icon:"✦",l:"주문입력"},{icon:"◈",l:"주문현황"},{icon:"◉",l:"재고/반품"},{icon:"♦",l:"고객관리"},{icon:"💰",l:"정산관리"},{icon:"◇",l:"대시보드"},{icon:"⚙",l:"설정"},{icon:"📦",l:"포장"},{icon:"📣",l:"공지"},{icon:"🧭",l:"전체현황"},{icon:"🚚",l:"송장출력"},{icon:"🏷",l:"입고·검단"}];
  const PACK_TAB = 7;
  // 전체현황 — 진행 중 주문에서 놓치고 있는 것을 모아 본다. 전 직원이 본다.
  // 처음에는 관리자 전용이었다. 놓친 주문을 실제로 풀 수 있는 사람은 그 주문의 담당자와
  // 박스를 만지는 포장팀인데, 관리자만 보면 매번 관리자가 찾아서 전해 줘야 했다.
  // 읽기만 하는 화면이라(고치는 버튼이 없다) 열어도 권한이 늘지 않는다.
  const OVERVIEW_TAB = 9;
  // 송장출력 — 관리자 전용. 택배사별로 뽑을 송장이 몇 건 남았는지 늘 펼쳐 놓고 본다.
  // 주문현황의 '송장 출력' 버튼(골라서 뽑기)은 그대로 있다 — 같은 판을 창으로 띄운다.
  const INVOICE_TAB = 10;
  // 입고·검단 — 원단이 들어오면 그 자리에서 바로 한다(2026-10-02 요청: "언제 어디서든 바로").
  // 보관/반품 안의 서브탭이었는데, 원단이 도착하는 순간 하는 일이라 거기까지 찾아 들어가는 게 걸렸다.
  // 탭 줄이 아니라 헤더(전체현황 옆) 버튼으로 연다 — 탭 줄은 한 줄에 들어오게 6개로 묶어 두었다.
  const INSPECT_TAB = 11;
  // 변경 기록에 "어느 화면에서 바꿨는지"로 남는다. 렌더 중에 바로 알린다 — effect 로 미루면
  // 탭을 바꾸자마자 누른 버튼이 이전 탭 이름으로 기록된다.
  db.setScreen(TABS[tab]?.l || "");
  // 택배사 — 직접 지정 → 메모의 '롤' → CJ. 판정은 박스(합배송 묶음) 단위라 목록 전체로 한 번에 낸다.
  const courierById = useMemo(() => courierMap(orders), [orders]);
  // 박스 전체의 택배사를 바꾼다. 한 건만 바꾸면 같은 박스 안에서 값이 갈린다.
  const changeCourier = async (order, courier) => {
    const box = (order.mergeGroupId && !order.splitShipping)
      ? orders.filter(x => x.mergeGroupId === order.mergeGroupId && !x.splitShipping)
      : [order];
    const ids = box.map(x => x.id);
    try {
      await db.setCourier(ids, courier);
      setOrders(p => p.map(x => ids.includes(x.id) ? { ...x, courier: courier || null } : x));
      showToast(courier ? `🚚 ${COURIER_SHORT[courier]}로 지정${ids.length > 1 ? ` — 합배송 ${ids.length}건` : ""}` : "🚚 택배사를 자동 판정으로 되돌렸습니다");
      return true;
    } catch (e) {
      showToast("택배사 변경 실패: " + e.message, "error");
      return false;
    }
  };
  // 라벨 프린터 이름 — 안내 문구에만 쓴다(브라우저는 프린터를 지정할 수 없다)
  const LABEL_PRINTER = "PS100";
  const NOTICE_TAB = 8;
  // 포장 화면은 포장 담당자 전용 — 셀러·관리자에게는 탭 자체를 노출하지 않는다.
  // 포장 담당자는 포장이 첫 탭이자 기본 화면이고, 주문입력(0)·정산관리(4)는 접근 불가.
  // 공지(NOTICE_TAB)는 탭 줄에 없다 — 전체현황 화면 맨 위의 "미등록" 버튼으로 연다(2026-10-02, 작업자 바를 없애며 옮김).
  // 포장직원을 포함해 전원이 볼 수 있다. 담당자를 못 찾은 입금을 옆에서 알아보는
  // 사람이 누구일지 미리 정할 수 없어서다 — 아는 사람이 답하면 된다.
  //
  // 설정(6)·전체현황(OVERVIEW_TAB)도 탭 줄에 없다. 관리자는 탭이 8개까지 늘어 한 줄에
  // 안 들어왔다 — 옆으로 밀어야 보이는 탭은 없는 탭과 같다. 설정은 헤더의 ⚙ 로,
  // 전체현황은 헤더의 건수 배지 옆으로 옮겼다(화면이 아니라 '남은 일이 몇 건인가').
  // 나머지 탭은 자리와 이름을 그대로 둔다 — 매일 누르던 자리가 바뀌면 그게 더 큰 비용이다.
  const visibleTabs = isPackerRole ? [PACK_TAB,1,2,3,5]
    : isAdminRole && SHOW_INVOICE_TAB ? [0,1,INVOICE_TAB,2,3,4,5] : [0,1,2,3,4,5];

  // 전체현황 건수 — 헤더의 전체현황 버튼에 붙는다.
  // 합배송 묶음 중 이미 나간 건은 화면의 주문 목록에 없다(활성 건만 읽는다) — 따로 물어본다.
  // 묶음 id 목록이 바뀔 때만 다시 읽는다. 주문이 바뀔 때마다 읽으면 실시간 이벤트마다 조회가 나간다.
  const [overviewMates, setOverviewMates] = useState([]);
  //
  // 키에 묶음별 '남은 건수'를 같이 넣는다. 묶음 id 만 넣으면 묶음 중 한 건이 나가도
  // 남은 건이 같은 id 를 들고 있어 키가 그대로다 — 정작 "일부만 나갔다"가 생긴 그 순간에
  // 다시 읽지 않아서, 건수 배지가 새로고침 전까지 틀린 숫자를 보여준다.
  const overviewGroupKey = useMemo(() => {
    const left = new Map();
    for (const o of orders) {
      if (!o.mergeGroupId || o.splitShipping || o.status === "출고완료") continue;
      left.set(o.mergeGroupId, (left.get(o.mergeGroupId) || 0) + 1);
    }
    return [...left].map(([g, n]) => `${g}:${n}`).sort().join(",");
  }, [orders]);
  const reloadOverviewMates = useCallback(async () => {
    const groupIds = overviewGroupKey ? overviewGroupKey.split(",").map(s => s.split(":")[0]) : [];
    try { setOverviewMates(await db.fetchShippedGroupMates(groupIds)); }
    catch (e) { console.warn("[전체현황] 묶음 출고 조회 실패:", e?.message); }
  }, [overviewGroupKey]);
  useEffect(() => { reloadOverviewMates(); }, [reloadOverviewMates]);
  // 보는 범위("전체"/"내 담당") — 전체현황 화면의 토글과 이 배지가 같은 값을 쓴다.
  // 배지만 전체로 세면 셀러 화면에 '12건'이 붙었는데 열어 보면 '3건'이라 숫자가 서로 안 맞는다.
  // 기본값은 역할로 가른다(관리자 전체, 셀러 내 담당). 기기에 기억한다.
  // 저장된 값이 없으면 null 로 두고 역할로 그때그때 정한다 — 담당자 목록은 뒤늦게 오므로
  // 처음 한 번만 정하면 관리자가 '내 담당'으로 굳는다.
  const [overviewScopeSaved, setOverviewScopeSaved] = useState(() => readOverviewScope(null));
  const overviewScope = overviewScopeSaved || (currentManagerObj?.isAdmin ? "all" : "mine");
  const setOverviewScope = useCallback((v) => {
    setOverviewScopeSaved(v);
    try { localStorage.setItem(OVERVIEW_SCOPE_KEY, v); } catch {}
  }, []);
  const overviewOrders = useMemo(() => scopeOverviewOrders(orders, overviewScope, activeManager), [orders, overviewScope, activeManager]);
  const overviewFlagged = useMemo(
    () => buildOverview(overviewOrders, overviewMates,
      { isHold, isParked, getPayStatus,
        courierOf: (o) => courierById.get(o.id)?.courier, isPickup: (o) => !!courierById.get(o.id)?.pickup }).flagged,
    // nowTs: 주문이 안 바뀌어도 수거 마감 시각이 지나면 숫자가 달라져야 한다(30초마다 도는 시계)
    [overviewOrders, overviewMates, courierById, nowTs]);
  // 미해결 건수 — 탭 라벨에 붙는 빨간 숫자. 밴드와 달리 안 끝난 게 늘 눈에 남는다.
  const openNoticeCount = useMemo(() => notices.filter(n => !n.resolvedAt).length, [notices]);

  return (
    <ThemeCtx.Provider value={T}>
    {/* minHeight 를 zoomLevel 로 나눈다 — 이 요소 자신에게 zoom 이 걸려 있어서
        100vh 를 그대로 쓰면 화면의 (100 × 배율)% 가 된다. 배율 1.3 이면 내용이
        한 줄뿐이어도 화면의 130% 높이가 잡혀 빈 공간이 스크롤됐다. */}
    <div className={"erp-root"+narrowCls} style={{fontFamily:S,background:T.bg,minHeight:`calc(100vh / ${zoomLevel})`,color:T.cream,maxWidth:600,margin:"0 auto",zoom:zoomLevel}}>
      {!loaded && <CuteFullLoader brand="로하이마켓 ERP" text="데이터 불러오는 중이에요 🧶" />}

      {/* ── 구버전 안내 화면 ── */}
      {loaded && newerUrl && (
        <div style={{position:"fixed",inset:0,background:T.bg,zIndex:998,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20,padding:24,textAlign:"center"}}>
          <div style={{fontSize:48}}>🔄</div>
          <div style={{fontFamily:SF,fontSize:22,fontWeight:800,color:T.copper}}>새 버전이 있습니다</div>
          <div style={{fontSize:14,color:T.creamMuted,lineHeight:1.8}}>
            현재 버전은 구버전입니다.<br/>
            최신 버전으로 이동해서<br/>
            <b style={{color:T.cream}}>동일한 데이터</b>를 이용하세요.
          </div>
          <a href={newerUrl} target="_blank" rel="noreferrer"
            style={{display:"block",width:"100%",maxWidth:320,padding:"16px",borderRadius:12,background:`linear-gradient(135deg,${T.copper},${T.copperLight})`,color:T.white,fontWeight:800,fontSize:16,textDecoration:"none",boxShadow:`0 6px 30px ${T.copperGlow}`,fontFamily:S}}>
            🚀 최신 버전으로 이동
          </a>
          <button onClick={()=>setNewerUrl(null)} style={{padding:"10px 20px",borderRadius:10,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,fontFamily:S,fontSize:13,cursor:"pointer"}}>
            이 버전으로 계속 사용
          </button>
          <div style={{fontSize:10,color:T.creamMuted}}>현재: {APP_VERSION}</div>
        </div>
      )}

      <style>{`
        .erp-root {
          --bg: ${T.bg};
          --surface: ${T.surface};
          --card: ${T.card};
          --border: ${T.border};
          --copper: ${T.copper};
          --copperLight: ${T.copperLight};
          --copperGlow: ${T.copperGlow};
          --cream: ${T.cream};
          --muted: ${T.creamMuted};
          --green: ${T.green};
          --red: ${T.red};
          --yellow: ${T.yellow};
          --blue: ${T.blue};
          --inputBg: ${T.inputBg};
          background: ${T.bg} !important;
          color: ${T.cream} !important;
        }
        .erp-root * { transition: background 0.2s, border-color 0.2s, color 0.15s, box-shadow 0.2s; }
        .erp-root input, .erp-root select, .erp-root textarea {
          background: ${T.inputBg} !important;
          color: ${T.cream} !important;
          border-color: ${T.border} !important;
          box-shadow: ${theme==="light"?"inset 0 1px 2px rgba(0,0,0,0.04)":"none"};
        }
        /* ── 터치 기기 입력창은 16px ──────────────────────────────────
           iOS 사파리는 글자가 16px 보다 작은 입력창을 누르면 화면을 제멋대로
           확대한다. 되돌려 주지도 않아서 사람이 손으로 축소해야 한다. 검색창을
           한 번 누를 때마다 그 짓을 해야 했다. 공용 입력 스타일(constants.js
           baseInp)이 13px 이고 거기서 더 줄여 쓴 자리도 많다.
           여기서 한 번에 올린다 — 인라인 스타일을 이겨야 해서 !important 다.
           16px 를 넘는 입력은 앱에 하나도 없으므로 이 규칙이 무엇을 줄이지는 않는다.
           pointer:coarse = 손가락으로 쓰는 기기. 마우스로 쓰는 PC 는 건드리지 않는다.
           확대 배율(zoom)은 렌더링만 키울 뿐 계산상 글자 크기는 그대로라
           배율을 올려도 이 문제는 안 없어진다 — 그래서 px 자체를 올려야 한다. */
        @media (pointer: coarse) {
          .erp-root input, .erp-root select, .erp-root textarea { font-size: 16px !important; }
        }
        .erp-root input::placeholder, .erp-root textarea::placeholder {
          color: ${T.creamMuted} !important;
          opacity: 0.65;
        }
        .erp-root input[type="date"], .erp-root input[type="number"] {
          color-scheme: ${theme==="dark"?"dark":"light"};
        }
        .erp-root input[type="checkbox"] { accent-color: ${T.copper}; }
        .erp-root select option { background: ${T.card}; color: ${T.cream}; }
        .erp-card {
          background: ${T.card} !important;
          border-color: ${T.border} !important;
          box-shadow: ${T.cardShadow};
        }
        /* 선택된 주문카드 — 위 .erp-card 가 배경·테두리를 !important 로 고정하고 있어서
           인라인 스타일로는 못 이긴다(그래서 선택 강조가 여태 안 보이고 있었다).
           클래스를 둘 겹쳐 특이도를 높여 되찾는다. 색은 출력 모드를 따라간다. */
        .erp-card.sel-label { background: ${T.blueBg} !important; border-color: ${T.blue} !important; }
        .erp-card.sel-ship  { background: ${T.copperGlow} !important; border-color: ${T.copper} !important; }
        .erp-surface { background: ${T.surface} !important; }
        .erp-border { border-color: ${T.border} !important; }
      `}</style>
      <Toast msg={toast.msg} type={toast.type}/>
      {editingOrder && (
        <EditOrderModal
          order={editingOrder}
          memoOnly={isPackerRole}
          customers={customers}
          // 이 고객의 적립금 잔액 — 창은 이걸로 칸을 보일지·한도를 정한다 (DepositTab getCreditBalance 와 같은 계산)
          creditBal={(credits||[]).filter(c=>c.customer===editingOrder.customer).reduce((s,c)=>s+(c.type==="적립"?c.amount:-c.amount),0)}
          fsBal={freeShipping.find(f=>f.customer===editingOrder.customer)?.count || 0}
          onSave={async (o, newImgs=[])=>{
            try {
              // 포장 담당자는 메모/담당자 메모(공유)만 저장 (다른 필드 변경 차단)
              if (isPackerRole) {
                await db.updateOrder(o.id, {
                  note: o.note || null,
                  memo: (o.memo && o.memo.trim()) ? o.memo.trim() : null,
                });
                setOrders(p=>p.map(x=>x.id===o.id?{...x,note:o.note,memo:o.memo}:x));
                setEditingOrder(null);
                showToast("메모 저장 완료");
                return;
              }
              // 새로 첨부한 이미지 업로드 → 기존 목록(모달에서 삭제 반영된) 뒤에 추가
              let images = Array.isArray(o.images) ? o.images : [];
              if (newImgs.length > 0) {
                const urls = await uploadOrderImages(newImgs, o.id);
                images = [...images, ...urls];
              }
              // 바꾼 칸만 저장한다.
              //
              // 예전에는 창에 있던 값을 전부 다시 썼다. 창이 들고 있는 건 '열 때'의 값이라,
              // 열어 둔 사이 다른 사람이 입금완료로 바꿨으면 메모만 고쳐 저장해도 미입금으로
              // 되돌아갔다. 처리상태도 같은 식으로 포장완료가 접수로 돌아갔다(그 칸은 아예 뺐다 —
              // UI.jsx EditOrderModal 참고).
              //
              // 열 때의 값(editingOrder)과 저장하려는 값(o)을 같은 식으로 다듬어 견준다.
              // 다듬지 않고 견주면 null 과 "" 처럼 뜻이 같은 값이 '바뀐 것'으로 잡힌다.
              const FIELDS = [
                // [화면 칸, DB 칸, 다듬는 식]
                ["customer",      "customer",       v => v.customer],
                ["phone",         "phone",          v => v.phone || null],
                ["payment",       "payment",        v => v.payment],
                ["address",       "address",        v => v.address || null],
                ["addressDetail", "address_detail", v => v.addressDetail || null],
                ["note",          "note",           v => v.note || null],
                ["memo",          "memo",           v => (v.memo && v.memo.trim()) ? v.memo.trim() : null],
                ["items",         "items",          v => v.items || []],
                ["links",         "links",          v => (v.links || []).map(l => String(l).trim()).filter(Boolean)],
                ["receiptType",   "receiptType",    v => v.receiptType ?? null],
                ["totalAmount",   "total_amount",   v => parseInt(v.totalAmount) || 0],
                ["shippingFee",   "shipping_fee",   v => parseInt(v.shippingFee) || 0],
                ["otherCost",     "other_cost",     v => parseInt(v.otherCost) || 0],
              ];
              const patch = {};   // DB 에 쓸 것
              const local = {};   // 화면 목록에 반영할 것
              for (const [key, col, norm] of FIELDS) {
                const next = norm(o);
                if (JSON.stringify(norm(editingOrder)) === JSON.stringify(next)) continue;
                patch[col] = next;
                local[key] = typeof next === "number" ? next : o[key];
              }
              if (JSON.stringify(editingOrder.images || []) !== JSON.stringify(images)) {
                patch.images = images;
                local.images = images;
              }
              // 택배사는 박스 전체에 쓴다(changeCourier) — 이 주문 하나만 바꾸면 같은 박스 안에서 갈린다.
              const courierChanged = (o.courier || null) !== (editingOrder.courier || null);
              // 적립금 — 창이 이미 걸러서 넘긴다(돈 들어온 주문·고객명 바뀐 저장·한도 초과면 0).
              // 여기서도 같은 조건을 한 번 더 본다. 창과 저장 사이에 다른 기기가 입금했을 수 있다.
              const sameCustomer = (o.customer || "").trim() === (editingOrder.customer || "").trim();
              const creditCancel = sameCustomer && !!o._creditCancel && (editingOrder._computed?.creditUsed || 0) > 0;
              const creditUse = sameCustomer && o.payment !== "입금완료" && !creditCancel ? (parseInt(o._creditUse) || 0) : 0;
              // 무료배송권 — 창이 넘긴 '저장 뒤 상태'(_fsUse)와 지금 상태를 견준다. 고객명 바뀐 저장은 건드리지 않는다.
              const wasUsed = !!editingOrder.freeShippingUsed;
              const fsOn = sameCustomer && "_fsUse" in o ? !!o._fsUse : wasUsed;
              const newFee = parseInt(o.shippingFee) || 0, oldFee = parseInt(editingOrder.shippingFee) || 0;
              const fsTurnOn = !wasUsed && fsOn && newFee > 0 && o.payment !== "입금완료";
              const fsTurnOff = wasUsed && !fsOn;
              const fsRelog = wasUsed && fsOn && newFee !== oldFee && newFee > 0;   // 켠 채 배송비 변경 → 새 금액으로 다시
              const fsWork = fsTurnOn || fsTurnOff || fsRelog;
              if (Object.keys(patch).length === 0 && !courierChanged && creditUse <= 0 && !creditCancel && !fsWork) {
                setEditingOrder(null);
                showToast("바뀐 내용이 없습니다");
                return;
              }
              // 줄을 지운 품목에 포장 기록이 있으면(포장대에서 이미 잘라 둔 원단) 먼저 묻는다.
              // 안 물으면 기록은 DB 에만 남고 화면에서는 보이지 않게 된다(2026-10-13 점검).
              let packMsg = "";
              if (patch.items) {
                const keep = new Set((o.items || []).map(i => String(i.itemId || "")));
                const removed = (editingOrder.items || []).map(i => i.itemId).filter(id => id && !keep.has(String(id)));
                if (removed.length) {
                  const settled = await settlePackingBefore(o.id, { what: "품목 삭제", by: activeManager, itemIds: removed });
                  if (!settled) { showToast("저장을 중단했습니다"); return; }
                  packMsg = settleMessage(settled);
                }
              }
              // 주문 칸을 먼저 쓴다 — 배송권차감 로그는 바뀐 배송비로, 적립금 한도는 바뀐 총액으로 계산해야 하고,
              // 완납이면 payment 도 그 위에 쓴다.
              if (Object.keys(patch).length > 0) await db.updateOrder(o.id, patch);
              if (courierChanged) await changeCourier(editingOrder, o.courier || null);
              const orderTotal = (parseInt(o.totalAmount) || 0) > 0 ? parseInt(o.totalAmount)
                : (o.items||[]).reduce((s,i)=>s+(parseInt(i.amount)||0),0)+newFee+(parseInt(o.otherCost)||0);
              const cust = (o.customer || "").trim();
              let fsMsg = "";
              if (fsWork) {
                try {
                  if (fsTurnOff || fsRelog) {
                    await db.cancelFreeShipping(cust, o.id);
                    local.freeShippingUsed = false;
                  }
                  if (fsTurnOn || fsRelog) {
                    const bal = await db.getCustomerFreeShipping(cust);
                    if (bal < 1) {
                      fsMsg = " · 무료배송권은 적용 안 됨(보유 0장)";
                    } else {
                      await db.useFreeShipping(cust, o.id, newFee);
                      local.freeShippingUsed = true;
                      fsMsg = fsRelog ? ` · 무료배송권 ${newFee.toLocaleString()}원으로 다시 적용` : ` · 무료배송권 1장 사용 (잔여 ${bal - 1}장)`;
                    }
                  } else if (fsTurnOff) {
                    fsMsg = " · 무료배송권 1장 복원";
                  }
                  // 받은 돈이 바뀌었으니 결제 상태를 다시 센다 — 배송권으로 완납되거나, 끄면서 미수금이 다시 생긴다.
                  const logs = await db.fetchOrderLogs(o.id);
                  const computed = db.calcOrderMoney(logs, orderTotal, o.payment);
                  local._computed = computed;
                  if (computed.paymentStatus === "입금완료" && o.payment !== "입금완료") {
                    await db.updateOrder(o.id, { payment: "입금완료" }); local.payment = "입금완료"; fsMsg += " — 완납 처리됨";
                  } else if (fsTurnOff && o.payment === "입금완료" && (computed.paymentStatus === "미입금" || computed.paymentStatus === "부분입금")) {
                    await db.updateOrder(o.id, { payment: "미입금" }); local.payment = "미입금"; fsMsg += " — 미수금이 생겨 미입금으로";
                  }
                  reloadFreeShipping?.();
                } catch (fsErr) {
                  console.error("무료배송권 처리 실패:", fsErr);
                  fsMsg = " · 무료배송권 처리 실패: " + fsErr.message;
                }
              }
              let creditMsg = "";
              if (creditCancel) {
                try {
                  const r = await db.cancelOrderCredit(cust, o.id, activeManager);
                  if (r.amount > 0) {
                    if (r.savedCredit) setCredits(p=>[r.savedCredit,...p]);
                    creditMsg = ` · 적립금 ${r.amount.toLocaleString()}원 사용 취소(돌려줌)`;
                    // 받은 돈이 줄었으니 결제 상태를 다시 센다 — 적립금으로 완납됐던 주문은 미입금으로 돌아간다.
                    const logs = await db.fetchOrderLogs(o.id);
                    const computed = db.calcOrderMoney(logs, orderTotal, "미입금");
                    local._computed = computed;
                    const payNow = local.payment || o.payment;
                    if (payNow === "입금완료" && computed.paymentStatus !== "입금완료") {
                      await db.updateOrder(o.id, { payment: "미입금" }); local.payment = "미입금"; creditMsg += " — 미수금이 생겨 미입금으로";
                    }
                  } else {
                    creditMsg = " · 취소할 적립금 사용이 없음";
                  }
                } catch (ccErr) {
                  console.error("적립금 사용 취소 실패:", ccErr);
                  creditMsg = " · 적립금 사용 취소 실패: " + ccErr.message;
                }
              }
              if (creditUse > 0) {
                try {
                  const r = await db.applyOrderCredit({ customer: cust, orderId: o.id, requested: creditUse, orderTotal, manager: activeManager, fallbackPayment: local.payment || o.payment });
                  if (r.useAmt <= 0) {
                    creditMsg = ` · 적립금은 적용 안 됨(${r.skipped})`;
                  } else {
                    if (r.savedCredit) setCredits(p=>[r.savedCredit,...p]);
                    if (r.computed.paymentStatus === "입금완료") local.payment = "입금완료";
                    local._computed = r.computed;
                    creditMsg = ` · 적립금 ${r.useAmt.toLocaleString()}원 사용${r.computed.paymentStatus==="입금완료" ? " — 완납 처리됨" : ""}`;
                    if (r.useAmt < creditUse) creditMsg += ` (잔액·미수금 변동으로 ${creditUse.toLocaleString()}원 중 일부만)`;
                  }
                } catch (cErr) {
                  console.error("적립금 적용 실패:", cErr);
                  creditMsg = " · 적립금 적용 실패: " + cErr.message;
                }
              }
              // 화면도 바꾼 칸만 덮는다 — 나머지는 지금 목록이 들고 있는 값이 더 새것이다
              setOrders(p=>p.map(x=>x.id===o.id?{...x,...local}:x));
              setEditingOrder(null);
              const tailMsg = fsMsg + creditMsg;
              showToast("주문 수정 완료" + tailMsg, tailMsg.includes("실패") || tailMsg.includes("안 됨") ? "error" : "ok");
            } catch(e) {
              console.error("주문 수정 실패:", e);
              showToast("주문 수정 실패: "+e.message, "error");
            }
          }}
          onClose={()=>setEditingOrder(null)}
        />
      )}
      {editingInv && (
        <EditInvModal
          item={editingInv}
          onSave={it=>{setInv(p=>p.map(x=>x.id===it.id?it:x));setEditingInv(null);showToast("재고 수정 완료");}}
          onClose={()=>setEditingInv(null)}
        />
      )}
      {editingCust && (
        <EditCustModal
          cust={editingCust}
          onSave={async c=>{
            try {
              const updated = await db.updateCustomer(c.id, c);
              setCustomers(p=>p.map(x=>x.id===c.id?(updated||c):x));
              setEditingCust(null);
              showToast("고객 수정 완료");
            } catch(e) {
              console.error("고객 수정 실패:", e);
              showToast("고객 수정 실패: "+e.message, "error");
            }
          }}
          onClose={()=>setEditingCust(null)}
        />
      )}
      {confirmDel && <ConfirmModal item={confirmDel} onConfirm={deleteItem} onCancel={()=>setConfirmDel(null)}/>}
      {/* 감사 라벨 장수 — 감열지는 되돌릴 수 없어서 숫자를 눈으로 보고 보낸다 */}
      {thanksAsk && (
        <div onClick={()=>setThanksAsk(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:20,backdropFilter:"blur(4px)"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:T.card,borderRadius:16,border:`1px solid ${T.border}`,boxShadow:"0 20px 60px rgba(0,0,0,0.15)",padding:24,width:"100%",maxWidth:320,textAlign:"center"}}>
            <div style={{fontSize:30,marginBottom:10}}>💌</div>
            <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:T.cream,marginBottom:6}}>감사 라벨 몇 장?</div>
            <div style={{fontSize:12,color:T.creamMuted,marginBottom:14,lineHeight:1.6}}>
              {labelStationRow ? (labelStation ? "이 컴퓨터에서 나옵니다" : `${labelStationRow.deviceName || "담당 기기"} 에서 나옵니다`) : "라벨 출력 담당 기기가 없습니다"}
            </div>
            <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:10}}>
              <button onClick={()=>setThanksAsk(a=>({ qty: Math.max(1,(parseInt(a.qty)||1)-1) }))} style={{width:44,height:44,borderRadius:10,border:`1px solid ${T.border}`,background:"transparent",color:T.cream,fontSize:20,cursor:"pointer",fontFamily:S}}>−</button>
              <input type="text" inputMode="numeric" value={thanksAsk.qty}
                onChange={e=>setThanksAsk({ qty: e.target.value.replace(/[^0-9]/g,"").slice(0,3) })}
                onKeyDown={e=>{ if (e.key==="Enter") requestThanks(thanksAsk.qty); }}
                autoFocus
                style={{flex:1,minWidth:0,height:44,borderRadius:10,border:`1.5px solid ${T.pink}`,background:T.surface,color:T.cream,fontFamily:SF,fontSize:22,fontWeight:800,textAlign:"center",outline:"none"}}/>
              <button onClick={()=>setThanksAsk(a=>({ qty: Math.min(200,(parseInt(a.qty)||0)+1) }))} style={{width:44,height:44,borderRadius:10,border:`1px solid ${T.border}`,background:"transparent",color:T.cream,fontSize:20,cursor:"pointer",fontFamily:S}}>+</button>
            </div>
            <div style={{display:"flex",gap:6,marginBottom:16}}>
              {[1,5,10,20].map(n=>(
                <button key={n} onClick={()=>setThanksAsk({ qty: n })} style={{flex:1,padding:"8px 0",borderRadius:8,border:`1px solid ${String(thanksAsk.qty)===String(n)?T.pink:T.border}`,background:String(thanksAsk.qty)===String(n)?T.pinkBg:"transparent",color:String(thanksAsk.qty)===String(n)?T.pink:T.creamMuted,fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:S}}>{n}장</button>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>requestThanks(thanksAsk.qty)} style={{flex:1,padding:"12px",borderRadius:10,border:"none",background:T.pink,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:S}}>{parseInt(thanksAsk.qty)||0}장 출력</button>
              <button onClick={()=>setThanksAsk(null)} style={{flex:1,padding:"12px",borderRadius:10,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,fontSize:14,cursor:"pointer",fontFamily:S}}>취소</button>
            </div>
          </div>
        </div>
      )}
      {imageViewer && (
        // zIndex 950 인 이유: 앱 바깥 셸의 상단 바(홈·로그아웃)가 fixed·zIndex 900 으로
        // 화면 맨 위 44px 을 덮고 있다(App.jsx·main.jsx·SaasRoot.jsx). 뷰어가 300 이던
        // 시절엔 '🔗 원본 열기'와 ✕ 가 그 바 뒤에 깔려 통째로 안 보였다.
        // 다른 모달들은 가운데 정렬이라 그 띠에 내용이 없어 지금껏 드러나지 않았다.
        // 토스트(999)와 전체화면 안내(998)보다는 낮게 둬서 그것들은 계속 위에 뜨게 한다.
        //
        // 배치는 세로 3단(상단 바 / 이미지 / 쪽수). vw·vh 를 쓰지 않는 게 핵심이다 —
        // .erp-root 에 zoom(글자 크기, 최대 1.30)이 걸려 있어 92vh 가 실제로는 119vh 로
        // 부풀어 이미지가 화면 밖으로 넘쳤다. 이제 이미지는 '남은 높이'(flex:1)만 쓴다.
        // minHeight:0 은 flex 자식이 내용 크기 아래로 줄어들게 하는 장치 — 없으면 또 넘친다.
        <div onClick={()=>setImageViewer(null)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.92)",zIndex:950,display:"flex",flexDirection:"column"}}>
          <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:8,padding:"12px 14px"}}>
            {/* 링크 썸네일로 연 경우에만 — 보이는 건 og:image 라, 원글로 갈 길을 남겨둔다.
                첨부 이미지로 연 경우엔 출처 링크가 없으므로 버튼도 없다. */}
            {imageViewer.link && (
              <a href={imageViewer.link} target="_blank" rel="noopener noreferrer"
                onClick={e=>e.stopPropagation()}
                style={{display:"flex",alignItems:"center",gap:6,
                  padding:"9px 14px",borderRadius:20,textDecoration:"none",
                  background:"rgba(255,255,255,0.14)",color:"#fff",fontFamily:S,fontSize:13,fontWeight:800}}>
                🔗 원본 열기
              </a>
            )}
            <button onClick={(e)=>{e.stopPropagation();setImageViewer(null);}} style={{marginLeft:"auto",flexShrink:0,width:40,height:40,borderRadius:"50%",border:"none",background:"rgba(255,255,255,0.12)",color:"#fff",fontSize:18,cursor:"pointer"}}>✕</button>
          </div>

          {/* 화살표는 이미지 칸 안에 둔다 — 상단 바를 뺀 높이의 가운데에 와야 이미지와 나란하다 */}
          <div style={{flex:1,minHeight:0,position:"relative",display:"flex",alignItems:"center",justifyContent:"center",padding:"0 14px"}}>
            <img src={imageViewer.images[imageViewer.index]} alt="" onClick={e=>e.stopPropagation()} style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain"}}/>
            {imageViewer.images.length>1 && (
              <>
                <button onClick={(e)=>{e.stopPropagation();setImageViewer(v=>({...v,index:(v.index-1+v.images.length)%v.images.length}));}} style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",width:44,height:44,borderRadius:"50%",border:"none",background:"rgba(255,255,255,0.12)",color:"#fff",fontSize:20,cursor:"pointer",zIndex:2}}>‹</button>
                <button onClick={(e)=>{e.stopPropagation();setImageViewer(v=>({...v,index:(v.index+1)%v.images.length}));}} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",width:44,height:44,borderRadius:"50%",border:"none",background:"rgba(255,255,255,0.12)",color:"#fff",fontSize:20,cursor:"pointer",zIndex:2}}>›</button>
              </>
            )}
          </div>

          {imageViewer.images.length>1 && (
            <div style={{flexShrink:0,textAlign:"center",padding:"12px 0 16px"}}>
              <span style={{color:"#fff",fontSize:12,background:"rgba(0,0,0,0.5)",padding:"4px 10px",borderRadius:12}}>
                {imageViewer.index+1} / {imageViewer.images.length}
              </span>
            </div>
          )}
        </div>
      )}
      {shippingOpen && (
        <ShippingModal
          // 고른 주문이 있으면 그것 전부 — 화면에 보이든 말든. 검색을 바꿔 가며 여러 건을
          // 체크하는데, 마지막 검색어 때문에 화면에 남은 것만 넘기면 골라 둔 나머지가 조용히
          // 빠진다(2026-09-30: 5건 골랐는데 1장만 나옴). 선택 없이 열면 지금 보이는 목록.
          // 주문현황 탭에서 연 경우 현재 검색/필터가 적용된 주문만 대상,
          // 다른 탭(설정 등)에서 연 경우 전체 주문 유지
          orders={selectMode && selectedOrders.length>0
            ? orders.filter(o => selectedOrders.includes(o.id))
            : tab===1 ? orderListFiltered : orders.filter(isActiveOrder)}
          preSelected={selectMode && selectedOrders.length>0 ? selectedOrders : null}
          courierById={courierById}
          onSetCourier={changeCourier}
          onExport={async (ids,c)=>{
            await exportShipping(ids,c);
            setSelectedOrders([]);setSelectMode(null);
          }}
          onClose={()=>setShippingOpen(false)}
        />
      )}

      {mergeModalOrder && (
        <MergeModal
          sourceOrder={mergeModalOrder}
          orders={orders}
          customers={customers}
          sameCustomerOnly={isPackerRole}
          showToast={showToast}
          onConfirm={(groupId,ids,res)=>{setOrders(p=>patchOrdersWithGroupResult(p.map(o=>ids.includes(o.id)?{...o,mergeGroupId:groupId}:o), res));}}
          onClose={()=>setMergeModalOrder(null)}
        />
      )}

      {freightModal && (
        <FreightModal
          targetOrder={freightModal.target}
          groupOrders={freightModal.group}
          showToast={showToast}
          onConfirm={({bearerId,amount})=>{setOrders(p=>p.map(o=>{
            if(!freightModal.group.find(g=>g.id===o.id))return o;
            return {...o,shippingFee:o.id===bearerId?amount:0,feeHeld:null};
          }));}}
          onClose={()=>setFreightModal(null)}
        />
      )}

      {refundReqModal && (
        <RefundRequestModal
          order={refundReqModal.order}
          paid={refundReqModal.paid}
          initialAmount={refundReqModal.initialAmount ?? null}
          initialReason={refundReqModal.initialReason || ""}
          requestedBy={activeManager}
          G={T}
          onClose={()=>setRefundReqModal(null)}
          onSubmit={async(req)=>{
            try {
              await db.updateOrder(refundReqModal.order.id, { payment:"환불신청", payment_status:"refund_requested", refund_request:req });
              await reloadOrders();
              setRefundReqModal(null);
              showToast("환불 신청 완료 — 정산관리에서 대표님 승인 후 처리됩니다");
            } catch(e) { showToast("환불 신청 실패: "+e.message,"error"); }
          }}
        />
      )}

      {/* ── 화면 위 고정 묶음 ─────────────────────────────────────────
          헤더 · 작업자바 · 탭바 · 원단호출배너를 한 덩어리로 묶어 통째로 고정한다.
          예전에는 넷이 각자 sticky 였고 top 이 실측 상수(0 / 42 / 50 / 96)였다.
          그런데 탭 버튼 높이는 화면 폭에 따라 달라진다(@media 600/400/340 에서
          padding·font-size 가 줄어든다) — 상수는 한 폭에서만 맞는다. 실제로는
          작업자바(z20)가 탭바(z9)를 통째로 덮어서, 스크롤만 하면 탭이 0px 남고
          사라졌다(기본 배율에서도 동일). 탭을 바꾸려면 맨 위로 되돌아가야 했다.
          묶어 두면 높이를 아무도 계산하지 않는다 — 폭이든 글씨 배율이든 저절로 맞는다.
          z 30: 본문 위, 모달(200~950)·토스트(999) 아래. */}
      <div className="erp-topbars" style={{position:"sticky",top:0,zIndex:30}}>

      {/* Header */}
      {/* 헤더 한 줄 — 왼쪽은 현재 작업자, 오른쪽은 건수 배지·입고·전체현황·설정(2026-10-02 정리).
          예전에는 왼쪽에 '로하이마켓 ERP v2.1' 글자가, 그 아래 둘째 줄에 작업자 바(담당자·미등록)가 있었다.
          이름은 맨 위 로그인 바에 이미 있고, 미등록은 전체현황 안으로 옮겨 둘째 줄을 없앴다 — 위에 붙는 줄이
          하나 줄어 본문이 그만큼 더 보인다.
          position·zIndex: 담당자 펼침 목록이 아래 탭바를 덮어야 한다. */}
      <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"8px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,position:"relative",zIndex:2}}>
        {/* 현재 작업자 — 변경 기록에 이 이름이 남는다. 그 옆에 입고 */}
        <div style={{flexShrink:0,display:"flex",alignItems:"center",gap:6}}>
        <div style={{position:"relative"}}>
          <button onClick={()=>setWorkerDropdownOpen(o=>!o)} style={{
            padding:"5px 12px",borderRadius:8,border:`1px solid ${activeManager?T.copper:T.border}`,
            background:activeManager?T.copperGlow:"transparent",
            color:activeManager?T.copper:T.creamMuted,fontFamily:S,fontWeight:700,fontSize:12,
            cursor:"pointer",display:"flex",alignItems:"center",gap:6,whiteSpace:"nowrap"
          }}>
            <span>{activeManager || "선택 안 됨"}</span>
            {currentManagerObj?.isAdmin && <span style={{fontSize:9,fontWeight:800,background:T.copper,color:T.white,padding:"1px 5px",borderRadius:4}}>관리자</span>}
            <span style={{fontSize:9,opacity:0.6}}>{workerDropdownOpen?"▲":"▼"}</span>
          </button>
          {workerDropdownOpen && (
            <div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:T.card,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",zIndex:100,minWidth:160,overflow:"hidden"}}>
              <button onClick={()=>{setActiveManager("");setWorkerDropdownOpen(false);}} style={{display:"block",width:"100%",padding:"8px 12px",border:"none",background:!activeManager?T.copperGlow:"transparent",color:!activeManager?T.copper:T.creamMuted,fontFamily:S,fontSize:12,fontWeight:!activeManager?700:500,cursor:"pointer",textAlign:"left",borderBottom:`1px solid ${T.border}`}}>
                선택 안 함
              </button>
              {personalManagers.length === 0 ? (
                <div style={{padding:"8px 12px",fontSize:11,color:T.creamMuted,fontStyle:"italic"}}>등록된 담당자 없음</div>
              ) : personalManagers.map(m=>(
                <button key={m.name} onClick={()=>{setActiveManager(m.name);setWorkerDropdownOpen(false);}} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,width:"100%",padding:"8px 12px",border:"none",background:activeManager===m.name?T.copperGlow:"transparent",color:activeManager===m.name?T.copper:T.cream,fontFamily:S,fontSize:12,fontWeight:activeManager===m.name?700:500,cursor:"pointer",textAlign:"left"}}>
                  <span>{m.name}</span>
                  {m.isAdmin && <span style={{fontSize:9,fontWeight:800,background:T.copper,color:T.white,padding:"1px 5px",borderRadius:4}}>관리자</span>}
                </button>
              ))}
            </div>
          )}
        </div>
          {/* 입고·검단 — 원단이 들어오면 어느 화면에 있든 한 번에 연다. PC 는 작업자 옆 고정 자리(2026-10-02),
              휴대폰은 맨 위 검은 바 가운데(아래 createPortal) — 그래서 휴대폰에서는 여기 그리지 않는다. */}
          {inspectOnTop && createPortal(
            <button onClick={()=>{setTab(INSPECT_TAB);reloadProducts();reloadRolls();}}
              aria-label="입고·검단" aria-pressed={tab===INSPECT_TAB} style={{
              padding:"5px 16px",borderRadius:9,cursor:"pointer",fontFamily:S,
              fontSize:13.5,fontWeight:900,whiteSpace:"nowrap",
              border:`2px solid ${T.copper}`,
              background: tab===INSPECT_TAB ? T.copper : "rgba(0,0,0,0.35)",
              color: tab===INSPECT_TAB ? "#fff" : T.copperLight || T.copper,
              display:"flex",alignItems:"center",gap:5}}>
              <span aria-hidden style={{fontSize:15,lineHeight:1}}>🏷</span>
              <span>입고</span>
            </button>, topSlot)}
          {!inspectOnTop && <button onClick={()=>{setTab(INSPECT_TAB);reloadProducts();reloadRolls();}}
            title="입고·검단 — 롤 등록·실측·QR 라벨" aria-label="입고·검단" aria-pressed={tab===INSPECT_TAB} style={{
            padding:"7px 13px",borderRadius:9,cursor:"pointer",fontFamily:S,
            fontSize:14,fontWeight:900,whiteSpace:"nowrap",
            border:`2px solid ${T.copper}`,
            background: tab===INSPECT_TAB ? T.copper : "transparent",
            color: tab===INSPECT_TAB ? "#fff" : T.copper,
            display:"flex",alignItems:"center",gap:5}}>
            <span aria-hidden style={{fontSize:16,lineHeight:1}}>🏷</span>
            <span>입고</span>
          </button>}
        </div>
        <div className="erp-hdr-stats" style={{display:"flex",gap:4,alignItems:"center"}}>
          {(isPackerRole ? [
            {l:"주문",v:activeOrderCount,c:T.copper},
            {l:"미포장",v:unpackedCount,c:unpackedCount>0?T.red:T.creamMuted},
            {l:"보관",v:storedCount,c:storedCount>0?T.blue:T.creamMuted},
            {l:"합배송",v:combinedCount,c:combinedCount>0?T.purple:T.creamMuted},
            {l:"부족",v:low.length,c:low.length>0?T.yellow:T.creamMuted},
          ] : [
            {l:"주문",v:activeOrderCount,c:T.copper},
            {l:"미입금",v:unpaid,c:unpaid>0?T.red:T.creamMuted},
            {l:"환불",v:refundCount,c:refundCount>0?T.purple:T.creamMuted},
            {l:"부족",v:low.length,c:low.length>0?T.yellow:T.creamMuted},
          ]).map(s=>(
            <div key={s.l} className="erp-stat-pill" onClick={()=>{
              // 배지 클릭 → 해당 현황 화면으로 이동
              const emptyFilter = {dateFrom:"",dateTo:"",manager:"",status:"",payment:"",combinedShipping:false,combinedPayment:false,receiptType:""};
              if (s.l==="주문") { setOrderFilter(emptyFilter); setOrderSearch(""); setShowFilter(false); setTab(1); reloadOrders(); }
              else if (s.l==="미입금") { setOrderFilter({...emptyFilter,payment:"미입금"}); setOrderSearch(""); setShowFilter(false); setTab(1); reloadOrders(); }
              else if (s.l==="환불") { setDepositPreset({filter:"환불신청",ts:Date.now()}); setTab(4); reloadOrders(); }
              else if (s.l==="미포장") { setOrderFilter({...emptyFilter,status:"미포장"}); setOrderSearch(""); setShowFilter(false); setTab(1); reloadOrders(); }
              else if (s.l==="보관") { setOrderFilter({...emptyFilter,status:"보관"}); setOrderSearch(""); setShowFilter(false); setTab(1); reloadOrders(); }
              else if (s.l==="합배송") { setOrderFilter({...emptyFilter,combinedShipping:true}); setOrderSearch(""); setShowFilter(false); setTab(1); reloadOrders(); }
              else if (s.l==="부족") { setIoTab("stock"); setTab(2); }
            }} style={{display:"flex",alignItems:"center",gap:3,padding:"4px 8px",borderRadius:8,background:T.card,border:`1px solid ${T.border}`,cursor:"pointer"}}>
              <span style={{fontWeight:900,fontSize:13,lineHeight:1,color:s.c}}>{s.v}</span>
              <span style={{fontSize:9,color:T.creamMuted}}>{s.l}</span>
            </div>
          ))}
          {/* 전체현황 — 전 직원에게 보인다. 탭 줄이 아니라 건수 배지들 옆에 둔다: 어느 탭에 있든
              놓친 주문이 몇 건인지 보여야 한다. 탭 안에 있으면 그 탭을 열어야만 알 수 있다.
              옆의 배지들과 섞여 보이지 않게 색을 뒤집었다 — 글자색을 바탕으로, 바탕색을
              글자로 쓴다. 테마가 바뀌어도 늘 반대편에 선다. */}
          {(
            <button onClick={()=>{setTab(OVERVIEW_TAB);reloadOrders();reloadOverviewMates();}}
              title="전체현황 — 진행 중인 주문에서 놓치고 있는 것" aria-label="전체현황" aria-pressed={tab===OVERVIEW_TAB} style={{
              padding:"5px 9px",borderRadius:8,cursor:"pointer",fontFamily:S,
              fontSize:11,fontWeight:900,whiteSpace:"nowrap",
              border:`1.5px solid ${tab===OVERVIEW_TAB ? T.copper : T.cream}`,
              background: tab===OVERVIEW_TAB ? T.copper : T.cream,
              color: tab===OVERVIEW_TAB ? "#fff" : T.bg,
              display:"flex",alignItems:"center",gap:5}}>
              <span className="erp-ov-txt">전체현황</span>
              <span className="erp-ov-ico" aria-hidden>🧭</span>
              {/* 놓친 주문 + 미등록(입금은 왔는데 주문이 없는 건). 미등록은 전체현황 안으로 옮겼다 */}
              {(overviewFlagged + openNoticeCount) > 0 && (
                <span style={{minWidth:16,height:16,padding:"0 4px",borderRadius:999,
                  background:T.red,color:"#fff",fontSize:10,fontWeight:900,
                  display:"inline-flex",alignItems:"center",justifyContent:"center"}}>{overviewFlagged + openNoticeCount}</span>
              )}
            </button>
          )}
          {/* 설정 — 탭 줄에서 여기로 옮겼다. 하루에 몇 번 안 여는 화면이 매일 쓰는 탭과
              같은 줄에서 자리를 차지하고 있었다. */}
          <button onClick={()=>setTab(6)} title="설정" aria-label="설정" aria-pressed={tab===6} style={{padding:"5px 10px",borderRadius:8,
            border:`1.5px solid ${tab===6?T.copper:T.border}`,
            background:tab===6?T.copperGlow:"transparent",color:tab===6?T.copper:T.creamMuted,fontWeight:800,fontSize:11,
            cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>
            ⚙
          </button>
        </div>
      </div>


      {/* Tabs */}
      <style>{`
        .erp-tabs{scrollbar-width:none;-ms-overflow-style:none;}
        .erp-tabs::-webkit-scrollbar{display:none;width:0;height:0;}
        .erp-tab-btn{padding:12px 14px;font-size:14px;}
        /* 모바일(≤520px) 헤더 — 통계 배지 4개+링크 버튼이 좁은 화면 폭을 넘어
           페이지 전체에 가로 스크롤을 만들던 문제. v2.1 숨기고 배지를 압축,
           그래도 넘치면 배지 영역 안에서만 스크롤. PC(>520px)는 그대로. */
        @media (max-width:520px){
          .erp-hdr-ver{display:none;}
          .erp-hdr-stats{min-width:0;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;gap:3px!important;}
          .erp-hdr-stats::-webkit-scrollbar{display:none;width:0;height:0;}
          .erp-hdr-stats>button{padding:5px 6px!important;flex:none;}
          .erp-stat-pill{padding:4px 4px!important;gap:2px!important;flex:none;white-space:nowrap;}
          .erp-stat-pill span:first-child{font-size:12px!important;}
          .erp-stat-pill span:last-child{font-size:8px!important;}
          .erp-hdr-name{font-size:14px!important;}
        }
        @media (max-width:600px){
          .erp-tab-btn{padding:8px 10px;font-size:12px;}
        }
        @media (max-width:400px){
          .erp-tab-btn{padding:7px 8px;font-size:11px;}
        }
        @media (max-width:340px){
          .erp-tab-btn{padding:6px 6px;font-size:10.5px;}
        }
        /* ── 체감 폭(실제 폭 ÷ 글씨 확대 배율) 기준 규칙 — 미디어쿼리가 못 보는 영역 ──
           글씨 +10(1.3배)이면 390px 폰이 300px 폭처럼 배치된다. 아래는 그때 두 줄로 꺾이거나
           잘리던 자리들. 인라인 스타일을 덮어야 해서 !important 를 쓴다. */
        .erp-tight .erp-tab-btn{padding:6px 6px;font-size:10.5px;}
        /* 헤더의 전체현황 버튼 — 좁은 화면에서는 글자 대신 아이콘만 남긴다(건수는 그대로).
           글자를 두면 배지 줄이 넘쳐 옆으로 밀리고, 그러면 ⚙ 가 화면 밖으로 나간다. */
        .erp-ov-ico{display:none;}
        .erp-narrow .erp-ov-txt{display:none;}
        .erp-narrow .erp-ov-ico{display:inline;}
        .erp-tight .oi-mode-btn{white-space:nowrap;font-size:11px!important;padding:10px 2px!important;}
        .erp-tight .oi-ship-opt{white-space:nowrap;padding-left:4px!important;padding-right:4px!important;font-size:11px!important;}
        .erp-tight .dep-kpi-val{font-size:11px!important;white-space:nowrap;}
        .erp-tight .dep-subtab{white-space:nowrap;font-size:11px!important;padding:9px 2px!important;}
        .erp-narrow .dash-stat{padding:14px 12px!important;}
        .erp-narrow .dash-stat-val{font-size:16px!important;white-space:nowrap;}
        /* 주문입력 하단 고정 바 — 좁은 화면에선 금액을 윗줄로 올린다.
           한 줄에 [금액][초기화][주문등록] 을 두는데 버튼 둘이 flexShrink:0 이라
           줄지 않는다. 그래서 좁아지면 금액만 눌렸다 — 체감 폭 300px(390px 폰을
           글씨 +10 으로 보는 경우)에서 바 346px 중 버튼이 258px 을 가져가고
           금액 칸에 16px 이 남아, "0원" 조차 잘렸다(실측).
           버튼을 줄이는 대신 금액에 한 줄을 통째로 준다 — 금액은 등록 직전에
           확인하는 가장 중요한 숫자이고, 버튼을 줄이면 손가락 표적이 작아진다.
           주문등록은 남은 폭을 채워 오히려 누르기 쉬워진다. 라벨·순서는 그대로. */
        .erp-narrow .oi-bottom-bar{flex-wrap:wrap;}
        .erp-narrow .oi-bottom-amt{flex:1 0 100%!important;}
        .erp-narrow .oi-bottom-submit{flex:1 1 auto!important;}
        .erp-tight .mgr-row{flex-wrap:wrap;}
        .erp-tight .mgr-name{flex:1 1 100%!important;}
        /* 우측 떠 있는 스크롤 위젯 — 좁은 화면에선 배지·버튼 위에 올라타므로 가장자리에 붙이고 가늘게 */
        .erp-narrow .erp-side-scroller{right:0!important;}
        .erp-narrow .erp-side-scroller button{width:22px!important;height:22px!important;font-size:10px!important;}
        .erp-narrow .erp-side-scroller > div > div{width:10px!important;}
      `}</style>
      <div className="erp-tabs" style={{background:T.surface,borderBottom:`1px solid ${T.border}`,display:"flex",width:"100%",maxWidth:"100%",boxSizing:"border-box",overflowX:"auto",overflowY:"hidden",WebkitOverflowScrolling:"touch",whiteSpace:"nowrap"}}>
        {visibleTabs.map(i=>{ const t = TABS[i]; return (
          <button key={i} className="erp-tab-btn" onClick={()=>{setTab(i);if(i===1||i===4||i===PACK_TAB||i===OVERVIEW_TAB||i===INVOICE_TAB)reloadOrders();}} style={{
            flex:"none",border:"none",cursor:"pointer",
            borderBottom:tab===i?`2px solid ${T.copper}`:"2px solid transparent",
            background:tab===i?T.copperGlow:"transparent",
            color:tab===i?T.copper:T.cream,
            fontFamily:S,fontWeight:tab===i?900:800,
            whiteSpace:"nowrap",transition:"all 0.15s"}}>
            {t.l}
          </button>
        );})}
      </div>

      {/* ── 원단 호출 배너 ─────────────────────────────────────────
          포장직원이 자리에서 셀러를 부르는 장치. 탭 바 바로 아래에 sticky 로 붙어
          어느 탭에 있든 스크롤을 따라온다(재포장 경고와 같은 방식).

          위치를 스스로 계산하지 않는다 — 위 '화면 위 고정 묶음' 안에 들어 있어
          탭바 바로 아래에 저절로 붙는다. 예전에는 sticky top:96 이라는 실측 상수를
          들고 있었는데, 그 96 은 헤더·작업자바·탭바가 서로 겹친 상태를 전제로 잰
          값이었고 탭 버튼 높이가 화면 폭마다 달라져서 한 폭에서만 맞았다.

          '개인 알림'이 아니라 '공개 호출'인 게 핵심이다. 담당자가 자리에 없어도
          옆사람이 보고 말로 전해주는 경로가 실제로 제일 빠르다. 그래서 대상을
          가리지 않고 전원에게 같은 판을 띄우고, 이름을 크게 건다.

          '확인'은 내 화면에서 이 판을 접는 것뿐이다(DB를 건드리지 않는다).
          원단이 실제로 도착하는 것보다 확실한 신호가 없는데 그걸 위해 버튼을
          하나 더 누르게 할 이유가 없어서다. 표시를 지우는 건 원단을 받은
          포장직원 몫이고, 포장완료를 누르면 그것도 저절로 꺼진다. */}
      {fabricShown && (
        <div className="erp-fabric-bar" style={{
          background:`linear-gradient(${fabricUrgent?T.redBg:T.pinkBg},${fabricUrgent?T.redBg:T.pinkBg}), ${T.surface}`,
          borderBottom:`2px solid ${fabricUrgent?T.red:T.pink}`,
          boxShadow:"0 4px 12px rgba(0,0,0,0.18)"}}>
          <div onClick={()=>setFabricOpen(v=>!v)} style={{padding:"10px 14px",cursor:"pointer",
            display:"flex",alignItems:"center",gap:10}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13.5,fontWeight:900,color:fabricUrgent?T.red:T.pink,fontFamily:S,lineHeight:1.5,
                animation: "packBlink 1.2s ease-in-out infinite"}}>
                🧶 포장팀이 원단을 기다립니다 · {fabricOldestMins}분째
              </div>
              <div style={{fontSize:11.5,color:T.creamMuted,marginTop:2,lineHeight:1.5}}>
                {fabricByManager.map(m => `${m.name} ${m.n}개`).join(" · ")}
              </div>
            </div>
            {/* 확인 = 내 화면에서 접기. 새 호출이 뜨면 지문이 달라져 다시 올라온다. */}
            <button onClick={(e)=>{e.stopPropagation();setFabricDismissed(fabricSig);}} style={{
              flexShrink:0,padding:"9px 15px",borderRadius:8,border:"none",cursor:"pointer",
              background:T.pink,color:"#fff",fontFamily:S,fontSize:12.5,fontWeight:900}}>
              확인
            </button>
            <span style={{flexShrink:0,fontSize:12,color:T.creamMuted}}>{fabricOpen?"▲":"▼"}</span>
          </div>

          {/* 펼친 목록 — 셀러는 포장 탭을 볼 수 없으므로(포장직원 전용) 여기서
              '어느 주문의 무슨 원단 몇 마'까지 다 보여줘야 원단을 찾아올 수 있다. */}
          {fabricOpen && (
            <div style={{padding:"0 14px 10px"}}>
              {fabricCalls.map(o => {
                const mine = activeManager && o.manager === activeManager;
                // 안 온 원단만 적는다 — 이미 가져다 준 것까지 나열하면 셀러가
                // 무엇을 들고 가야 하는지 다시 골라내야 한다.
                const missing = missingItemIdx(o);
                return (
                  <div key={o.id} style={{padding:"8px 0",borderTop:`1px solid ${T.border}`}}>
                    <div style={{fontSize:12.5,color:T.cream,fontWeight:800,lineHeight:1.5}}>
                      <span style={{color:mine?T.pink:T.creamMuted,fontWeight:900}}>{o.manager||"담당자 없음"}</span>
                      {" · "}{o.customer}
                    </div>
                    {/* 원단마다 따로 테두리를 두른다. 쉼표로 이어붙이면 '인견코튼 그린 3마,
                        풍기인견 2마'가 한 덩어리로 읽혀 몇 개를 들고 가야 하는지 흐려진다.
                        칸 하나 = 가져올 원단 하나로 세어지게 한다.

                        칸은 글자 길이만큼만 차지하고 왼쪽부터 채운다. 폭을 균등하게 나누면
                        짧은 원단명 칸에 빈자리가 생기고, 긴 이름은 좁은 칸 안에서 접힌다.
                        열 수를 정해두지 않으므로 줄이 차면 알아서 다음 줄로 내려간다 —
                        화면이 좁은 폰에서도 잘리지 않고 제 폭에 맞춰 접힌다. */}
                    <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:4}}>
                      {missing.map(i => {
                        const it = o.items[i];
                        return (
                          // flex:0 0 auto = 내용만큼만. maxWidth:100% 는 폰에서 원단명이
                          // 아주 길 때 칸이 화면 밖으로 삐져나가지 않게 하는 안전장치다
                          // (그때는 minWidth:0 덕에 이름이 칸 안에서 줄바꿈된다).
                          <div key={i} style={{flex:"0 0 auto",maxWidth:"100%",
                            display:"inline-flex",alignItems:"baseline",gap:8,
                            padding:"6px 10px",borderRadius:7,
                            border:`1px solid ${T.pink}66`,background:T.pinkBg}}>
                            <span style={{minWidth:0,fontSize:12.5,fontWeight:800,
                              color:T.cream,lineHeight:1.4,wordBreak:"keep-all"}}>
                              {it.fabric}{it.color ? ` ${it.color}` : ""}
                            </span>
                            <span style={{flexShrink:0,fontSize:14,fontWeight:900,
                              color:T.cream,fontFamily:SF}}>
                              {it.qty}{it.unit || "마"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      </div>{/* ── 화면 위 고정 묶음 끝 ── */}

      <div style={{padding:16}}>
        {/* 주문입력 탭: 다른 탭으로 잠깐 이동 후 돌아와도 입력 중이던 내용이 유지되도록
            언마운트하지 않고 display로만 토글 */}
        <div style={{display:tab===0?"block":"none"}}>
          <OrderInput
            products={products} rollSummary={rollSummary} orders={orders} setOrders={setOrders}
            logs={logs} setLogs={setLogs} customers={customers} setCustomers={setCustomers}
            setTab={setTab} showToast={showToast} kakaoAlert={kakaoAlert}
            managers={managers} setManagers={setManagers}
            activeManager={activeManager} setActiveManager={setActiveManager}
            shipOneOrder={shipOneOrder}
            reloadFreeShipping={reloadFreeShipping}
            credits={credits} setCredits={setCredits}
            tabActive={tab===0}
            noteToRegister={noteToRegister}
            onConsumeNote={()=>setNoteToRegister(null)}
            onNoteRegistered={handleNoteRegistered}
            linkDrafts={linkDrafts}
            draftToConvert={draftToConvert}
            onConsumeDraft={()=>setDraftToConvert(null)}
            onDraftConverted={handleDraftConverted}
            onConvertDraft={handleConvertDraft}
            onRejectDraft={handleRejectDraft}
            onDeleteDraft={handleDeleteDraft}
            notes={notes}
            onSendNote={handleSendNote}
            onUpdateNoteBody={handleUpdateNoteBody}
            onToggleNoteReaction={handleToggleNoteReaction}
            onDeleteNote={handleDeleteNote}
            onRegisterNote={handleRegisterNote}
            onSearchNotes={handleSearchNotes}
          />
        </div>

        {tab===PACK_TAB && isPackerRole && (
          <ErrorBoundary name="포장 화면">
          <PackingTab
            orders={orders}
            customers={customers}
            reloadOrders={reloadOrders}
            showToast={showToast}
            activeManager={activeManager}
            onOpenImage={setImageViewer}
            syncLost={syncLost}
            onHandover={handOver}
            packingByOrder={packingByOrder}
            rolls={rolls}
            products={products}
            reloadPacking={reloadPacking}
            packingReady={packingReady}
          />
          </ErrorBoundary>
        )}

        {tab===INVOICE_TAB && isAdminRole && SHOW_INVOICE_TAB && (
          <ErrorBoundary name="송장 출력 화면">
          <div>
            <div style={{fontFamily:SF,fontSize:22,fontWeight:800,color:T.cream,marginBottom:4}}>송장 출력</div>
            <div style={{fontSize:12,color:T.creamMuted,marginBottom:14,lineHeight:1.6}}>
              입금이 끝났고 아직 송장을 안 뽑은 주문이 기본으로 선택됩니다 · 택배사를 고르고 출력하세요
            </div>
            <InvoicePanel
              orders={orders.filter(isActiveOrder)}
              courierById={courierById}
              onSetCourier={changeCourier}
              onExport={exportShipping}
            />
          </div>
          </ErrorBoundary>
        )}

        {tab===INSPECT_TAB && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:6}}>
              <div style={{fontFamily:SF,fontSize:22,fontWeight:800,whiteSpace:"nowrap"}}>🏷 입고·검단</div>
              {/* 롤 재고는 재고/반품 안에 그대로 있다 — 검단한 롤을 바로 확인하러 가는 길 */}
              <GhostBtn onClick={()=>{setIoTab("rolls");setTab(2);}} small>🧵 롤 재고 보기</GhostBtn>
            </div>
            <ErrorBoundary name="입고·검단 화면">
              <InspectionTab products={products} rolls={rolls} managers={managers}
                reloadProducts={reloadProducts} reloadRolls={reloadRolls}
                showToast={showToast} activeManager={activeManager}
                labelStationRow={labelStationRow} labelStationHere={labelStation}/>
            </ErrorBoundary>
          </div>
        )}

        {tab===OVERVIEW_TAB && (
          <ErrorBoundary name="전체현황 화면">
          {/* 미등록 — 입금은 왔는데 주문이 없는 건. 둘째 줄 작업자 바에 있던 버튼을 여기로 옮겼다(2026-10-02).
              전체현황 버튼의 빨간 숫자에 이 건수도 들어간다. */}
          <div style={{display:"flex",justifyContent:"flex-end",marginBottom:10}}>
            <button onClick={()=>{setTab(NOTICE_TAB);reloadNotices();}} title="입금은 왔는데 주문이 없는 건" style={{
              flexShrink:0,padding:"5px 10px",borderRadius:8,cursor:"pointer",fontFamily:S,
              fontSize:12,fontWeight:900,whiteSpace:"nowrap",
              // 흰 바탕·검은 글씨·빨간 두꺼운 테두리. 어두운 테마에서도 그대로 흰 판이라
              // 화면에서 유일한 차림이 된다 — 드롭다운과 헷갈릴 여지가 없다.
              border:`2px solid ${T.red}`,
              background: tab===NOTICE_TAB ? "#FFE9E9" : "#fff",
              color:"#111",
              display:"flex",alignItems:"center",gap:6}}>
              {/* 이모지는 기기마다 색이 달라(윈도우는 노란 확성기) 빨강이 안 나온다.
                  모양을 직접 그려 색을 고정한다. */}
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden style={{flexShrink:0}}>
                <path d="M18 4 L7 9.5 H4.5 A1.5 1.5 0 0 0 3 11 v2 A1.5 1.5 0 0 0 4.5 14.5 H7 L18 20 Z" fill={T.red}/>
                <path d="M7.6 14.8 L8.7 19.4 A1 1 0 0 0 10.7 19 L9.9 14.8 Z" fill={T.red}/>
                <path d="M20.2 9.4 a4 4 0 0 1 0 5.2" stroke={T.red} strokeWidth="1.8" fill="none" strokeLinecap="round"/>
              </svg>
              미등록
              {openNoticeCount > 0 && (
                // 빨간 동그라미에 흰 숫자. 두 자리가 되면 알약으로 늘어난다.
                <span style={{minWidth:17,height:17,padding:"0 4px",borderRadius:999,
                  background:T.red,color:"#fff",fontSize:10.5,fontWeight:900,
                  display:"inline-flex",alignItems:"center",justifyContent:"center"}}>{openNoticeCount}</span>
              )}
            </button>
          </div>
          <OverviewTab
            orders={orders}
            shippedMates={overviewMates}
            courierById={courierById}
            reloadMates={reloadOverviewMates}
            reloadOrders={reloadOrders}
            showToast={showToast}
            activeManager={activeManager}
            scope={overviewScope}
            setScope={setOverviewScope}
            onOpenOrder={(o)=>{
              // 필터를 비우고 고객명으로 찾는다 — 남아 있던 필터에 걸려 안 보이면 "없는 주문"으로 읽힌다
              setOrderFilter({dateFrom:"",dateTo:"",manager:"",status:"",payment:"",combinedShipping:false,combinedPayment:false,receiptType:""});
              setOrderSearch(o.customer||""); setShowFilter(false); setTab(1);
            }}
          />
          </ErrorBoundary>
        )}

        {tab===NOTICE_TAB && (
          <NoticeTab
            notices={notices}
            orders={orders}
            reloadNotices={reloadNotices}
            showToast={showToast}
            activeManager={activeManager}
            isAdmin={!!currentManagerObj?.isAdmin}
          />
        )}

        {tab===1 && (
          <div style={{paddingBottom: selectMode && selectedOrders.length>0 ? 80 : 0}}>
            {/* 헤더 */}
            {/* 제목은 한 줄 고정(nowrap·flexShrink 0). 모바일 글씨 +10 처럼 폭이 모자라면
                제목이 글자 단위로 꺾여 '황'만 아래로 떨어졌다 — 대신 버튼 묶음이 다음 줄로 내려간다. */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:6}}>
              <div style={{fontFamily:SF,fontSize:22,fontWeight:800,whiteSpace:"nowrap",flexShrink:0}}>주문 현황</div>
              {/* 라벨·송장 모두 '골라서 뽑는' 같은 일이라 버튼이 곧 선택 모드를 켠다.
                  예전의 '선택'(무엇을 위한 선택인지 없는 버튼)과 '전체송장'을 이 둘로 합쳤다. */}
              <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
                {!isPackerRole && [
                  { k:"label", on:"✕ 라벨 취소", off:"🏷️ 라벨 출력", c:T.blue },
                  // 송장은 관리자만 (2026-10-07 사용자 결정) — 택배 접수는 관리자가 모아서 한다
                  ...(isAdminRole ? [{ k:"ship", on:"✕ 송장 취소", off:"🚚 송장 출력", c:T.copper }] : []),
                ]
                // 한 모드에 들어가면 다른 쪽 버튼은 감춘다 — 고르는 중에 옆 버튼을
                // 잘못 누르면 골라둔 게 통째로 날아간다(모드가 바뀌며 선택이 초기화된다).
                .filter(b => !selectMode || selectMode === b.k)
                .map(b => {
                  const active = selectMode === b.k;
                  return (
                    <button key={b.k} onClick={()=>{setSelectMode(m=>m===b.k?null:b.k);setSelectedOrders([]);}} style={{
                      padding:"6px 12px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12,fontWeight:700,
                      border:`1.5px solid ${active?b.c:T.border}`,
                      background:active?`${b.c}1f`:"transparent",
                      color:active?b.c:T.creamMuted}}>
                      {active ? b.on : b.off}
                    </button>
                  );
                })}
                {/* 감사 라벨(💌) — 선물 상자용. 주문을 고르지 않고 장수만 묻는다(2026-10-07).
                    고르는 중(selectMode)에는 감춘다 — 옆 버튼과 같은 이유. */}
                {!isPackerRole && !selectMode && (
                  <button onClick={()=>setThanksAsk({ qty: 1 })} style={{
                    padding:"6px 12px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12,fontWeight:700,
                    border:`1.5px solid ${T.border}`,background:"transparent",color:T.creamMuted}}>
                    💌 감사 라벨
                  </button>
                )}
                {/* 전체출력 — 지금 검색·필터에 걸린 전체가 대상이다.
                    건수를 버튼에 박아 둔다. 감열지는 되돌릴 수 없어서, 누르기 전에
                    몇 장이 나올지 눈으로 보고 가야 한다. */}
                {selectMode && (
                  <button onClick={()=>printAll(selectMode)} style={{
                    padding:"6px 12px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12,fontWeight:800,
                    border:"none",color:"#fff",
                    background: selectMode==="label" ? T.blue : T.copper}}>
                    ⚡ 전체출력 {orderListFiltered.length}건
                  </button>
                )}
              </div>
            </div>

            {/* 검색 */}
            <div style={{marginBottom:10}}>
              <input value={orderSearch} onChange={e=>setOrderSearch(e.target.value)} placeholder="고객명·닉네임·연락처·원단·색상·아이템No·배송지·메모 검색..." style={{...baseInp,background:T.surface,color:T.cream,border:`1px solid ${T.border}`}}/>
            </div>

            {/* 필터 토글 · 합배송 모아보기 */}
            <div style={{marginBottom:10,display:"flex",alignItems:"center",flexWrap:"wrap",gap:6}}>
              <button onClick={()=>setShowFilter(f=>!f)} style={{fontSize:12,color:showFilter?T.copper:T.creamMuted,background:showFilter?T.copperGlow:"transparent",border:`1px solid ${showFilter?T.copper:T.border}`,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:S,fontWeight:600}}>
                🔍 필터 {showFilter?"▲":"▼"} {Object.values(orderFilter).filter(v=>v).length>0?`(${Object.values(orderFilter).filter(v=>v).length})`:""}
              </button>
              <button onClick={()=>setMergeViewOpen(v=>!v)} style={{fontSize:12,color:mergeViewOpen?T.purple:T.creamMuted,background:mergeViewOpen?"rgba(138,106,184,0.15)":"transparent",border:`1px solid ${mergeViewOpen?T.purple:T.border}`,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontFamily:S,fontWeight:mergeViewOpen?800:600}}>
                🔗 합배송 모아보기 {mergeViewOpen?"◉":"○"}
              </button>
              {Object.values(orderFilter).filter(v=>v).length>0 && (
                <button onClick={()=>setOrderFilter({dateFrom:"",dateTo:"",manager:"",status:"",payment:"",combinedShipping:false,combinedPayment:false,receiptType:""})} style={{fontSize:11,color:T.creamMuted,background:"transparent",border:"none",cursor:"pointer",fontFamily:S}}>초기화</button>
              )}
            </div>

            {showFilter && (
              /* 필터 패널 — 주문 카드(웜톤)와 구별되는 쿨톤 배경.
                 Card(.erp-card)는 전역 CSS가 배경을 !important로 고정하므로 일반 div로 렌더링 */
              <div style={{marginBottom:12,background:T.filterBg,borderRadius:14,border:`1px solid ${T.filterBorder}`,boxShadow:T.cardShadow,padding:16}}>
                <div style={{display:"flex",gap:8,marginBottom:10}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>시작일</div>
                    <input type="date" value={orderFilter.dateFrom} onChange={e=>setOrderFilter(f=>({...f,dateFrom:e.target.value}))} style={{...baseInp,fontSize:12,background:T.surface,color:T.cream,border:`1px solid ${T.border}`}}/>
                  </div>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>종료일</div>
                    <input type="date" value={orderFilter.dateTo} onChange={e=>setOrderFilter(f=>({...f,dateTo:e.target.value}))} style={{...baseInp,fontSize:12,background:T.surface,color:T.cream,border:`1px solid ${T.border}`}}/>
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>담당자</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {managers.map(m=>{
                      const active = orderFilter.manager===m.name;
                      const accent = m.isPublic ? T.blue : T.copper;
                      const accentBg = m.isPublic ? T.blueBg : T.copperGlow;
                      return (
                        <button key={m.name} onClick={()=>setOrderFilter(f=>({...f,manager:active?"":m.name}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${active?accent:T.border}`,background:active?accentBg:"transparent",color:active?accent:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:active?700:400}}>
                          {m.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>상태</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {["","미포장","접수","포장완료","보관","출고완료"].map(s=>(
                      <button key={s} onClick={()=>setOrderFilter(f=>({...f,status:s}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.status===s?T.copper:T.border}`,background:orderFilter.status===s?T.copperGlow:"transparent",color:orderFilter.status===s?T.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.status===s?700:400}}>
                        {s||"전체"}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>결제</div>
                  <div style={{display:"flex",gap:5}}>
                    {["","입금완료","미입금"].map(p=>(
                      <button key={p} onClick={()=>setOrderFilter(f=>({...f,payment:p}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.payment===p?T.copper:T.border}`,background:orderFilter.payment===p?T.copperGlow:"transparent",color:orderFilter.payment===p?T.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.payment===p?700:400}}>
                        {p||"전체"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>합배송 / 합입금</div>
                  <div style={{display:"flex",gap:5}}>
                    <button onClick={()=>setOrderFilter(f=>({...f,combinedShipping:!f.combinedShipping}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.combinedShipping?T.copper:T.border}`,background:orderFilter.combinedShipping?T.copperGlow:"transparent",color:orderFilter.combinedShipping?T.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.combinedShipping?700:400}}>
                      📦 합배송
                    </button>
                    <button onClick={()=>setOrderFilter(f=>({...f,combinedPayment:!f.combinedPayment}))} style={{padding:"4px 10px",fontSize:11,borderRadius:16,border:`1px solid ${orderFilter.combinedPayment?T.blue:T.border}`,background:orderFilter.combinedPayment?T.blueBg:"transparent",color:orderFilter.combinedPayment?T.blue:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:orderFilter.combinedPayment?700:400}}>
                      🔗 합입금
                    </button>
                  </div>
                </div>
                <div>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:4}}>영수증</div>
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {[
                      {v:"",            l:"전체",        c:T.copper,     bg:T.copperGlow},
                      {v:"none",        l:"발행 안 함",   c:T.creamMuted, bg:"transparent"},
                      {v:"cash",        l:"🧾 현금영수증", c:T.red,        bg:T.redBg},
                      {v:"business",    l:"📋 지출증빙",   c:T.blue,       bg:T.blueBg},
                      {v:"tax_invoice", l:"📄 계산서",     c:T.green,      bg:T.greenBg},
                    ].map(opt => {
                      const active = (orderFilter.receiptType||"") === opt.v;
                      return (
                        <button key={opt.v||"all"} onClick={()=>setOrderFilter(f=>({...f,receiptType:opt.v}))}
                          style={{padding:"4px 10px",fontSize:11,borderRadius:16,
                            border:`1px solid ${active?opt.c:T.border}`,
                            background:active?opt.bg:"transparent",
                            color:active?opt.c:T.creamMuted,
                            cursor:"pointer",fontFamily:S,fontWeight:active?700:400}}>
                          {opt.l}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}


            {/* 합배송 모아보기 — 정식 묶음(mergeGroupId) 그룹 카드 + 아직 안 묶인 합배송 표시(combinedShipping) 주문 */}
            {mergeViewOpen && (()=>{
              const groups = {};
              orders.filter(o=>o.mergeGroupId && isActiveOrder(o)).forEach(o=>{ (groups[o.mergeGroupId] = groups[o.mergeGroupId] || []).push(o); });
              const entries = Object.entries(groups).sort((a,b)=>b[1].length-a[1].length);
              // 합배송 표시는 됐지만 묶음이 없는 주문 — 고객명순 정렬로 짝이 될 주문끼리 인접 표시
              const unassigned = orders
                .filter(o=>isActiveOrder(o) && o.combinedShipping && !o.mergeGroupId)
                .sort((a,b)=>(a.customer||"").localeCompare(b.customer||"") || (a.id||"").localeCompare(b.id||""));
              if (entries.length===0 && unassigned.length===0) return <Empty text="합배송 묶음이 없습니다" sub="주문 카드의 '🔗 묶기' 버튼으로 합배송 그룹을 만들 수 있어요"/>;
              return (
                <>
                  <div style={{fontSize:11,color:T.creamMuted,marginBottom:8}}>
                    묶음 <b style={{color:T.purple}}>{entries.length}개</b> · {entries.reduce((s,[,l])=>s+l.length,0)}건
                    {unassigned.length>0 && <> · 미지정 합배송 <b style={{color:T.copper}}>{unassigned.length}건</b></>}
                  </div>
                  {/* 같은 고객 자동 묶기 / 되돌리기 — 포장 담당자도 사용 가능 (돈 안 건드리는 포장 작업) */}
                  {(
                    <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                      <button onClick={autoMergeSameCustomer}
                        style={{padding:"6px 12px",fontSize:11,fontWeight:800,color:T.purple,background:"rgba(138,106,184,0.14)",border:`1px solid ${T.purple}`,borderRadius:8,cursor:"pointer",fontFamily:S}}>
                        ⚡ 같은 고객 자동 묶기
                      </button>
                      {autoMergeUndo?.length > 0 && (
                        <button onClick={undoAutoMerge}
                          style={{padding:"6px 12px",fontSize:11,fontWeight:700,color:T.creamMuted,background:"transparent",border:`1px dashed ${T.border}`,borderRadius:8,cursor:"pointer",fontFamily:S}}>
                          ↩ 되돌리기 ({autoMergeUndo.length}묶음)
                        </button>
                      )}
                    </div>
                  )}
                  {entries.map(([gid, list], gi)=>{
                    const sorted = [...list].sort((a,b)=>(a.id||"").localeCompare(b.id||""));
                    const unpacked = list.filter(x=>x.status!=="포장완료"&&x.status!=="보관").length;
                    const names = [...new Set(list.map(x=>x.customer))];
                    return (
                      <Card key={gid} style={{marginBottom:10,border:`1.5px solid ${T.purple}66`,background:"rgba(138,106,184,0.06)"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:8}}>
                          <span style={{fontSize:12,fontWeight:800,color:T.purple}}>🔗 묶음 {gi+1}</span>
                          <span style={{fontSize:13,fontWeight:800,color:T.cream}}>{names.join(" · ")}</span>
                          <span style={{fontSize:11,color:T.creamMuted,fontWeight:600}}>{list.length}건</span>
                          {unpacked>0
                            ? <span style={{fontSize:10,fontWeight:800,color:T.red,background:T.redBg,padding:"1px 7px",borderRadius:10,border:`1px solid ${T.red}40`}}>미포장 {unpacked}</span>
                            : <span style={{fontSize:10,fontWeight:800,color:T.green,background:T.greenBg,padding:"1px 7px",borderRadius:10,border:`1px solid ${T.green}40`}}>모두 포장됨</span>}
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {sorted.map(g=>{
                            const itemsLabel = (g.items||[]).map(it=>`${it.fabric||""}${it.color?" "+it.color:""} ${it.qty||0}${it.unit||"마"}`).filter(s=>s.trim()).join(", ");
                            const stColor = g.status==="포장완료"?T.green:isHold(g)?T.blue:T.red;
                            return (
                              <div key={g.id} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,padding:"6px 8px",background:T.card,borderRadius:7,border:`1px solid ${T.border}`}}>
                                <span style={{fontFamily:SF,fontSize:10,color:T.copper,fontWeight:700,flexShrink:0}}>#{String(g.id).slice(0,8)}</span>
                                <span style={{fontWeight:700,color:T.cream,flexShrink:0}}>{g.customer}</span>
                                <span style={{flex:1,minWidth:0,color:T.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{itemsLabel||"(상품 없음)"}</span>
                                {g.splitShipping && <span style={{fontSize:9,fontWeight:800,color:"#9a3412",background:"#fed7aa",padding:"1px 5px",borderRadius:4,flexShrink:0}}>🚚 분리</span>}
                                <span style={{fontSize:10,fontWeight:800,color:stColor,flexShrink:0}}>{g.status||"접수"}{isHold(g)&&g.status!=="보관"?" · 📦":""}</span>
                              </div>
                            );
                          })}
                        </div>
                      </Card>
                    );
                  })}
                  {/* 미지정 합배송 — combinedShipping 표시만 있고 묶음이 없는 주문. 여기서 바로 묶기 가능 */}
                  {unassigned.length>0 && (
                    <>
                      <div style={{fontSize:11,color:T.creamMuted,margin:"14px 0 8px"}}>
                        📦 <b style={{color:T.copper}}>합배송 표시만 있고 아직 묶이지 않은 주문 {unassigned.length}건</b> — 같은 고객끼리 인접 정렬됨 · 🔗 묶기로 그룹을 만들어 주세요
                      </div>
                      <Card style={{marginBottom:10,border:`1.5px solid ${T.copper}55`,background:T.copperGlow.replace("0.15","0.05").replace("0.12","0.05")}}>
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {unassigned.map(g=>{
                            const itemsLabel = (g.items||[]).map(it=>`${it.fabric||""}${it.color?" "+it.color:""} ${it.qty||0}${it.unit||"마"}`).filter(s=>s.trim()).join(", ");
                            const stColor = g.status==="포장완료"?T.green:isHold(g)?T.blue:T.red;
                            return (
                              <div key={g.id} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,padding:"6px 8px",background:T.card,borderRadius:7,border:`1px solid ${T.border}`}}>
                                <span style={{fontFamily:SF,fontSize:10,color:T.copper,fontWeight:700,flexShrink:0}}>#{String(g.id).slice(0,8)}</span>
                                <span style={{fontWeight:700,color:T.cream,flexShrink:0}}>{g.customer}</span>
                                <span style={{flex:1,minWidth:0,color:T.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{itemsLabel||"(상품 없음)"}</span>
                                <span style={{fontSize:10,fontWeight:800,color:stColor,flexShrink:0}}>{g.status||"접수"}{isHold(g)&&g.status!=="보관"?" · 📦":""}</span>
                                {g.status==="접수" && (
                                  <button onClick={()=>setMergeModalOrder(g)}
                                    style={{flexShrink:0,padding:"4px 9px",borderRadius:7,border:`1px solid ${T.purple}`,background:"rgba(138,106,184,0.14)",color:T.purple,fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:S}}>
                                    🔗 묶기
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </Card>
                    </>
                  )}
                </>
              );
            })()}

            {!mergeViewOpen && (()=>{
              const filtered = orderListFiltered;
              return filtered.length===0
              ? <Empty text="검색 결과가 없습니다" sub={orders.length>0?"필터를 조정해보세요":"카톡 주문장을 붙여넣어 시작하세요"}/>
              : filtered.slice(0, orderShowCount).map(o=>{
                  const isSelected = selectedOrders.includes(o.id);
                  // 선택 강조색은 모드를 따라간다 — 상단 버튼·하단 실행 버튼과 같은 색이어야
                  // 지금 무엇을 고르는 중인지가 카드에서도 읽힌다.
                  const selC = selectMode==="label" ? T.blue : T.copper;
                  const selBg = selectMode==="label" ? T.blueBg : T.copperGlow;
                  return (
                    <Card key={o.id}
                      className={`${selectMode ? "selecting" : ""}${isSelected ? (selectMode==="label" ? " sel-label" : " sel-ship") : ""}`.trim()}
                      onClick={selectMode ? ()=>setSelectedOrders(p=>isSelected?p.filter(x=>x!==o.id):[...p,o.id]) : undefined}
                      style={{marginBottom:10,border:`1.5px solid ${isSelected?selC:(o.mergeGroupId?T.purple:T.border)}`,background:isSelected?selBg:(o.mergeGroupId?"rgba(138,106,184,0.06)":T.card),transition:"all 0.15s"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"flex-start",gap:10,flex:1}}>
                          {selectMode && (
                            <input type="checkbox" checked={isSelected}
                              onChange={e=>setSelectedOrders(p=>e.target.checked?[...p,o.id]:p.filter(x=>x!==o.id))}
                              style={{accentColor:selC,width:18,height:18,marginTop:2,flexShrink:0,cursor:"pointer"}}
                            />
                          )}
                          <div style={{flex:1}}>
                            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                              <span style={{fontFamily:SF,fontSize:11,color:T.copper,fontWeight:700}}>#{String(o.id).slice(0,8)}</span>
                              <span style={{fontWeight:800,fontSize:16,wordBreak:"keep-all"}}>{o.customer}{(()=>{
                                // 같은 이름 고객이 여럿이면 폰 가운데 4자리로 disambiguate.
                                const extractMid = (p) => {
                                  if (!p) return "";
                                  const d = String(p).replace(/\D/g, "");
                                  if (d.length === 4) return d;
                                  if (d.length >= 10) return d.slice(3, 7);
                                  return "";
                                };
                                const list = customers.filter(c => c.name === o.customer);
                                if (list.length === 0) return "";
                                let matched = list.length === 1 ? list[0] : null;
                                if (!matched) {
                                  // 전체 번호 일치 우선 — 동명이인이 가운데 4자리까지 같은 케이스(예: 010-9268-5543 / 010-9268-2696) 오매칭 방지
                                  const oDigits = String(o.phone || "").replace(/\D/g, "");
                                  if (oDigits.length >= 10) matched = list.find(c => String(c.phone || "").replace(/\D/g, "") === oDigits) || null;
                                  if (!matched) {
                                    const oMid = extractMid(o.phone);
                                    if (oMid) {
                                      const midHits = list.filter(c => extractMid(c.phone) === oMid);
                                      if (midHits.length === 1) matched = midHits[0]; // 후보가 여럿이면 표시 안 함 (틀린 닉네임보다 빈 칸이 낫다)
                                    }
                                  }
                                }
                                const nick = matched?.nickname?.trim();
                                return nick ? <span style={{fontWeight:600,fontSize:13,color:T.creamMuted,marginLeft:2}}>({nick})</span> : "";
                              })()}</span>
                              {(()=>{const md=getManagerDisplay(o.manager,activeManager,managers,T);return <span style={{fontSize:10,color:md.color,background:md.bg,padding:"1px 6px",borderRadius:4,fontStyle:md.italic?"italic":"normal"}}>{md.label}</span>;})()}
                            </div>
                            <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:o.combinedPayment||o.combinedShipping||o.salesChannel||o.mergeGroupId||o.receiptType||o.freeShippingUsed||isHold(o)?2:0}}>
                              {o.mergeGroupId && (()=>{
                                const cnt=orders.filter(x=>x.mergeGroupId===o.mergeGroupId).length;
                                const isOpen = expandedMergeGroup === o.mergeGroupId;
                                return (
                                  <button
                                    onClick={(e)=>{e.stopPropagation();setExpandedMergeGroup(p=>p===o.mergeGroupId?null:o.mergeGroupId);}}
                                    title="클릭하면 묶인 주문 목록을 볼 수 있어요"
                                    style={{fontSize:10,fontWeight:800,color:T.purple,background:isOpen?"rgba(138,106,184,0.32)":"rgba(138,106,184,0.18)",padding:"1px 6px",borderRadius:4,border:`1px solid ${T.purple}`,cursor:"pointer",fontFamily:S}}
                                  >
                                    🔗 합배송 그룹 {cnt}건 {isOpen?"▴":"▾"}
                                  </button>
                                );
                              })()}
                              {o.splitShipping && <span style={{fontSize:10,fontWeight:800,color:"#9a3412",background:"#fed7aa",padding:"1px 6px",borderRadius:4,border:"1px solid #fb923c"}}>🚚 분리</span>}
                              {courierById.get(o.id) && (courierById.get(o.id).pickup
                                ? <PickupTag/>
                                : <CourierTag courier={courierById.get(o.id).courier} why={courierById.get(o.id).why}/>)}
                              {/* 보관 — 요청과 완료를 가른다. 여기서 둘을 뭉쳐 '보관중'이라 쓰면,
                                  아무도 물건을 창고에 넣지 않았는데 넣은 것처럼 읽힌다. 실제로
                                  넣는 사람은 포장직원이고 그 표시가 held_at 이다(포장탭과 같은 기준).
                                  status 태그가 '보관'인 구주문은 중복이라 제외. */}
                              {isHold(o) && o.status!=="보관" && (
                                o.heldAt
                                  ? <span style={{fontSize:10,fontWeight:700,color:T.yellow,background:T.yellowBg,padding:"1px 6px",borderRadius:4,border:`1px solid ${T.yellow}30`}}>📦 보관중</span>
                                  : <span title="포장직원이 '보관 완료'를 누르면 보관중이 됩니다" style={{fontSize:10,fontWeight:800,color:T.white,background:T.yellow,padding:"1px 6px",borderRadius:4}}>📦 보관 요청</span>
                              )}
                              {/* 보관분 출고요청 — 창고에서 꺼내 포장하는 중이라는 표시.
                                  일반 주문과 섞여 있으면 포장직원이 원단을 어디서 가져와야 하는지
                                  모른다(작업대가 아니라 선반이다). 나가면 지워진다. */}
                              {o.shipRequestedAt && !isHold(o) && o.status!=="출고완료" && (
                                <span title={o.shipRequestedBy ? `${o.shipRequestedBy}님 요청` : undefined}
                                  style={{fontSize:10,fontWeight:800,color:T.white,background:T.copper,padding:"1px 6px",borderRadius:4}}>
                                  📦 보관분 출고요청
                                </span>
                              )}
                              {/* 보류 — 포장 큐에서 빠져 있다는 걸 여기서도 알려야 한다. 안 그러면
                                  '접수' 상태로 몇 달 멈춰 있는 걸 보고 누락으로 오해한다. 사유는 툴팁으로. */}
                              {isParked(o) && <span title={o.parkReason || undefined} style={{fontSize:10,fontWeight:700,color:T.creamMuted,background:T.subtleBg,padding:"1px 6px",borderRadius:4,border:`1px solid ${T.border}`}}>🗄️ 보류</span>}
                              {o.salesChannel && <span style={{fontSize:10,fontWeight:700,color:T.purple,background:"rgba(138,106,184,0.12)",padding:"1px 6px",borderRadius:4,border:`1px solid ${T.purple}30`}}>{o.salesChannel}</span>}
                              {o.combinedPayment && <span style={{fontSize:10,fontWeight:700,color:T.blue,background:T.blueBg,padding:"1px 6px",borderRadius:4,border:`1px solid ${T.blue}30`}}>🔗 합입금</span>}
                              {o.combinedShipping && <span style={{fontSize:10,fontWeight:700,color:T.copper,background:T.copperGlow,padding:"1px 6px",borderRadius:4,border:`1px solid ${T.copper}30`}}>📦 합배송</span>}
                              {(o.note||"").startsWith("교환 출고") && <span style={{fontSize:10,fontWeight:700,color:T.blue,background:T.blueBg,padding:"1px 6px",borderRadius:4,border:`1px solid ${T.blue}30`}}>🔄 교환건</span>}
                              {o.receiptType==="cash"        && <span style={{fontSize:10,fontWeight:700,color:T.red,  background:T.redBg,  padding:"1px 6px",borderRadius:4,border:`1px solid ${T.red}30`}}>🧾 현금영수증</span>}
                              {o.receiptType==="business"    && <span style={{fontSize:10,fontWeight:700,color:T.blue, background:T.blueBg, padding:"1px 6px",borderRadius:4,border:`1px solid ${T.blue}30`}}>📋 지출증빙</span>}
                              {o.receiptType==="tax_invoice" && <span style={{fontSize:10,fontWeight:700,color:T.green,background:T.greenBg,padding:"1px 6px",borderRadius:4,border:`1px solid ${T.green}30`}}>📄 계산서</span>}
                              {o.freeShippingUsed && <span title="무료배송권 사용" style={{fontSize:10,fontWeight:700,color:"#92400e",background:"#fef3c7",padding:"1px 6px",borderRadius:4,border:"1px solid #f59e0b"}}>🎟️ 배송권</span>}
                            </div>
                            {o.mergeGroupId && expandedMergeGroup === o.mergeGroupId && (
                              <div style={{marginTop:6,marginBottom:4,padding:"8px 10px",background:"rgba(138,106,184,0.08)",border:`1px solid ${T.purple}55`,borderRadius:7,display:"flex",flexDirection:"column",gap:6}}>
                                <div style={{fontSize:10,fontWeight:700,color:T.purple,fontFamily:S,marginBottom:2}}>🔗 같은 합배송 묶음</div>
                                {orders
                                  .filter(x => x.mergeGroupId === o.mergeGroupId)
                                  .sort((a,b)=>(a.id||"").localeCompare(b.id||""))
                                  .map(g => {
                                    const isMe = g.id === o.id;
                                    const itemsLabel = (g.items||[]).map(it=>`${it.fabric||""}${it.color?" "+it.color:""} ${it.qty||0}${it.unit||"마"}`).filter(s=>s.trim()).join(", ");
                                    const shipped = g.status === "출고완료";
                                    const splitOn = !!g.splitShipping;
                                    return (
                                      <div key={g.id} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:isMe?T.copper:T.cream,fontWeight:isMe?700:500}}>
                                        <span style={{fontFamily:SF,minWidth:60,color:T.copper}}>#{String(g.id).slice(0,8)}</span>
                                        <span style={{minWidth:50}}>{g.customer}</span>
                                        <span style={{flex:1,color:T.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{itemsLabel||"(상품 없음)"}</span>
                                        <span style={{fontSize:9,color:T.creamMuted}}>{g.status}</span>
                                        <button
                                          onClick={async (e)=>{
                                            e.stopPropagation();
                                            if (shipped) return;
                                            const next = !splitOn;
                                            try {
                                              await db.updateOrder(g.id, { splitShipping: next });
                                              setOrders(p=>p.map(x=>x.id===g.id?{...x,splitShipping:next}:x));
                                              // 분리된 건은 1건 그룹(내려놓은 택배비 되돌림), 남은 그룹은 다시 계산 — 3단계
                                              await settleGroupId(g.mergeGroupId, orders.map(x=>x.id===g.id?{...x,splitShipping:next}:x), next?"분리 배송":"분리 해제");
                                              showToast(next?"분리 배송으로 설정됨":"합배송으로 변경됨");
                                            } catch (err) {
                                              console.error(err);
                                              showToast("설정 실패: "+err.message,"error");
                                            }
                                          }}
                                          disabled={shipped}
                                          title={shipped?"출고완료된 주문은 변경 불가":(splitOn?"분리 배송 해제":"이 주문만 분리 배송")}
                                          style={{
                                            fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:4,fontFamily:S,
                                            cursor:shipped?"not-allowed":"pointer",
                                            opacity:shipped?0.4:1,
                                            color: splitOn ? "#9a3412" : T.creamMuted,
                                            background: splitOn ? "#fed7aa" : "transparent",
                                            border: `1px solid ${splitOn ? "#fb923c" : T.border}`,
                                          }}
                                        >
                                          🚚 {splitOn?"분리":"분리?"}
                                        </button>
                                        {isMe && <span style={{fontSize:9,color:T.copper,fontWeight:800}}>← 현재</span>}
                                      </div>
                                    );
                                  })}
                              </div>
                            )}
                            {(()=>{
                              const phone = o.phone || customers.find(x=>x.name===o.customer)?.phone || "";
                              // 포장 담당자 화면 — 전화번호를 크게 (송장 입력/조회용으로 바로 읽히게)
                              if (isPackerRole && phone) return (
                                <>
                                  <span style={{fontSize:11,color:T.creamMuted}}>{o.date}</span>
                                  <div style={{fontSize:16,fontWeight:800,fontFamily:SF,color:T.cream,letterSpacing:"0.04em",marginTop:3}}>📞 {phone}</div>
                                </>
                              );
                              return <span style={{fontSize:11,color:T.creamMuted}}>{o.date}{phone ? ` · ${phone}` : ""}</span>;
                            })()}
                            {o.address && <div style={{fontSize:11,color:T.creamMuted,marginTop:4}}>📦 {o.address}{o.addressDetail ? ` ${o.addressDetail}` : ""}</div>}
                          </div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",flexShrink:0}}>
                          {(()=>{
                            const displayPay = getPayStatus(o);
                            const creditUsed = o._computed?.creditUsed || 0; // 이 주문에 사용된 적립금 순액 (차감−복원)
                            return (
                              <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap",justifyContent:"flex-end"}}>
                                {creditUsed>0 && (
                                  <span title="이 주문에 사용된 적립금" style={{fontSize:10,fontWeight:800,color:T.purple,background:"rgba(138,106,184,0.12)",border:`1px solid ${T.purple}40`,borderRadius:6,padding:"2px 7px",whiteSpace:"nowrap"}}>
                                    💰 적립금 {creditUsed.toLocaleString()}원
                                  </span>
                                )}
                                <span onClick={async()=>{if(isPackerRole){showToast("포장 담당자는 입금/환불을 처리할 수 없습니다","error");return;}if(displayPay==="입금완료"&&window.confirm("입금을 취소하시겠습니까?")){await db.deletePaymentLogsByType(o.id,"입금");await db.updateOrder(o.id,{payment:"미입금"});await reloadOrders();showToast("입금 취소됨");}}} style={{cursor:displayPay==="입금완료"?"pointer":"default"}}><Tag c={pC(displayPay,T)[0]} bg={pC(displayPay,T)[1]}>{displayPay}</Tag></span>
                              </div>
                            );
                          })()}
                          <Tag c={sC(o.status,T)[0]} bg={sC(o.status,T)[1]}>{o.status}</Tag>
                          {(()=>{
                            const itemsSum=(o.items||[]).reduce((s,i)=>s+(i.amount||0),0);
                            const total=o.totalAmount>0?o.totalAmount:itemsSum+(o.shippingFee||0)+(o.otherCost||0);
                            if(total<=0) return null;
                            const isPartial=o._computed?.paymentStatus==="부분환불";
                            const refund=o._computed?.refundAmount||0;
                            const remaining=o._computed?.depositAmount ?? Math.max(0,total-refund);
                            const method=(o.refundNote||"").includes("적립")?"적립금":(o.refundNote||"").includes("현금")?"현금":"";
                            // 입금필요 — 적립금·배송권 차감과 부분입금을 반영해 실제로 더 받아야 할 돈 (db.calcOrderMoney)
                            //  · 총액과 같으면 숨김 — 차감·입금이 하나도 없는 전액 미입금이라 위 '총' 줄과 같은 숫자
                            //  · 부분환불/환불완료는 balanceAmount가 0으로 고정돼(db.js:1369) 아래 '남은' 줄이 담당
                            //  · totalAmount가 없는 레거시/엑셀 주문은 제외 — balanceAmount의 기준 총액(품목합만, db.js:1415)이
                            //    이 카드의 총액(품목합+배송비+기타)과 달라 배송비만큼 적게 나온다. 틀린 숫자보단 미표시가 낫다.
                            const bal=o._computed?.balanceAmount||0;
                            const showBal=!isPartial && o.totalAmount>0 && bal>0 && bal!==total;
                            return (
                              <div style={{marginTop:2,textAlign:"right",lineHeight:1.55}}>
                                <div style={{fontSize:11,color:T.creamMuted,fontWeight:600}}>총 <span style={{color:T.copper,fontWeight:800}}>{total.toLocaleString()}원</span></div>
                                {showBal && <div style={{fontSize:11,color:T.yellow,fontWeight:800}}>입금필요 {bal.toLocaleString()}원</div>}
                                {isPartial && <>
                                  <div style={{fontSize:11,color:T.red,fontWeight:700}}>환불 -{refund.toLocaleString()}원{method?` · ${method}`:""}</div>
                                  <div style={{fontSize:11,color:T.green,fontWeight:800}}>남은 {remaining.toLocaleString()}원</div>
                                </>}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                      <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                        {o.items.map((item,i)=>(
                          <div key={i} style={{padding:"4px 10px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`,fontSize:12}}>
                            {item.itemNo && <span style={{color:T.copper,fontFamily:"monospace",fontWeight:700,marginRight:4,fontSize:11}}>{item.itemNo.toUpperCase()}</span>}
                            <span style={{color:T.creamMuted}}>{item.fabric}{item.color?" "+item.color:""} </span>
                            <span style={{fontWeight:700,whiteSpace:"nowrap"}}>{item.qty}{item.unit||"마"}</span>
                            {item.amount>0 && <span style={{color:T.copper,marginLeft:4,fontSize:11}}>{item.amount.toLocaleString()}원</span>}
                          </div>
                        ))}
                        {(o.shippingFee||0)>0 && (
                          <div style={{padding:"4px 10px",background:`${T.blue}1A`,borderRadius:8,border:`1px solid ${T.blue}55`,fontSize:12,color:T.blue,fontWeight:700}}>
                            🚚 {(o.shippingFee).toLocaleString()}원
                          </div>
                        )}
                        {(o.otherCost||0)>0 && (
                          <div style={{padding:"4px 10px",background:T.surface,borderRadius:8,border:`1px solid ${T.border}`,fontSize:12,color:T.creamMuted,fontWeight:700}}>
                            🧷 기타 {(o.otherCost).toLocaleString()}원
                          </div>
                        )}
                      </div>
                      {(o.links||[]).length>0 && <div style={{fontSize:11,marginBottom:6,display:"flex",flexDirection:"column",gap:3}}>{o.links.map((lnk,i)=><a key={i} href={lnk} target="_blank" rel="noopener noreferrer" style={{color:T.blue,textDecoration:"underline"}}>🔗 {lnk.length>50?lnk.slice(0,50)+"...":lnk}</a>)}</div>}
                      {(o.links||[]).length>0 && <LinkPreview links={o.links} T={T} onOpenImage={(img,link)=>setImageViewer({images:[img],index:0,link})} />}
                      {(()=>{
                        // 카드가 이미 배지·칩·필드로 보여주는 내용은 걷어내고 표시 (DB 원문은 그대로 — 주문수정에선 원문이 보임)
                        const noteView = stripCardDup(o.note, o);
                        if (!noteView) return null;
                        return (
                          <div title={o.note} style={{fontSize:12,color:T.cream,marginBottom:10,padding:"6px 10px",background:T.surface,borderRadius:7,border:`1px solid ${T.border}`,display:"flex",gap:6,alignItems:"flex-start"}}>
                            <span style={{color:T.yellow,fontSize:13,flexShrink:0}}>💬</span>
                            <span style={{lineHeight:1.6,whiteSpace:"pre-wrap"}}>{noteView}</span>
                          </div>
                        );
                      })()}
                      {o.memo && o.memo.trim() && (
                        <div style={{fontSize:12,marginBottom:10,padding:"8px 12px",background:"#fef3c7",borderRadius:6,border:"1px solid #fde68a",display:"flex",gap:6,alignItems:"flex-start",color:"#78350f"}}>
                          <span style={{fontSize:13,flexShrink:0}}>📝</span>
                          <span style={{lineHeight:1.5,whiteSpace:"pre-wrap",wordBreak:"break-word",flex:1}}>{o.memo}</span>
                        </div>
                      )}
                      {Array.isArray(o.images) && o.images.length>0 && (
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(72px,1fr))",gap:5,marginBottom:10}}>
                          {o.images.map((url,i)=>(
                            <div key={i} onClick={()=>setImageViewer({images:o.images,index:i})} style={{position:"relative",aspectRatio:"1/1",borderRadius:6,overflow:"hidden",border:`1px solid ${T.border}`,cursor:"pointer",background:T.surface}}>
                              <img src={url} alt="" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
                            </div>
                          ))}
                        </div>
                      )}
                      {!selectMode && <>
                        <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                          {(()=>{const cp=o._computed?.paymentStatus||o.payment; return <>{o.payment==="환불신청" ? (
                            <button onClick={()=>{if(isPackerRole){showToast("포장 담당자는 입금/환불을 처리할 수 없습니다","error");return;}const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}if(window.confirm("환불 신청을 취소하시겠습니까?")){db.updateOrder(o.id,{payment:"입금완료",payment_status:"paid",refund_request:null,...db.archiveRefundRequest(o,"취소")});reloadOrders();showToast("환불 신청 취소 — 입금완료로 복원");}}} style={{padding:"4px 14px",fontSize:11,borderRadius:20,border:`1px solid ${T.red}`,background:T.redBg,color:T.red,fontFamily:S,fontWeight:700,cursor:"pointer"}}>환불신청{o.refundRequest?` · ${o.refundRequest.kind==="full"?"전액":"부분"} ${o.refundRequest.method==="credit"?"적립금":"현금"} ${(o.refundRequest.amount||0).toLocaleString()}원`:""}</button>
                          ) : (o.payment==="환불"||cp==="환불완료") ? (
                            <span style={{padding:"4px 14px",fontSize:11,borderRadius:20,border:`1px solid ${T.red}`,background:T.redBg,color:T.red,fontFamily:S,fontWeight:700}}>환불 완료</span>
                          ) : ["접수","포장완료","보관","출고완료"].map(s=>{
                            const [c,bg]=sC(s,T);
                            // 보관은 상호배타 status 가 아니라 독립 토글이다.
                            // 다만 업무상 보관 건은 포장 전이다 — 원단만 창고에 넣어둔 상태.
                            // 그래서 창고에 들어간 뒤(held_at)에는 포장 상태를 못 바꾸게 막는다.
                            const isHoldBtn = s==="보관";
                            const held = isHold(o);
                            const stored = !!o.heldAt;      // 요청이 아니라 '실제로 창고에 들어감'
                            // 보관중이면 '출고완료' 자리가 '출고요청'이 된다. 물건이 아직 선반에
                            // 있는데 출고완료를 누르면 재고와 로그만 먼저 나간다.
                            const isShipReqBtn = s==="출고완료" && stored && o.status!=="출고완료";
                            const isActive = isHoldBtn ? held : o.status===s;
                            // 출고완료 버튼: 입금 미확인 상태면 시각적 비활성화 + 클릭 시 토스트.
                            // 출고'요청'은 통과시킨다 — 요청은 포장팀에 넘기는 것뿐이라 돈과 무관하고,
                            // 실제로 나가는 문(출고완료)은 그대로 잠겨 있다.
                            const shipBlocked = s==="출고완료" && !isShipReqBtn && o.status!=="출고완료" && !(cp==="입금완료"||cp==="부분환불"||cp==="환불완료");
                            // 출고완료 / 출고취소(출고완료→다른상태)는 관리자만 가능.
                            // 출고요청은 셀러도 할 수 있다 — 고객이 "이제 보내주세요" 하는 걸
                            // 먼저 듣는 사람이 담당 셀러다.
                            const isShipAction = (s==="출고완료" && !isShipReqBtn) || (o.status==="출고완료" && s!=="출고완료");
                            const adminOnly = isShipAction && !currentManagerObj?.isAdmin;
                            // 포장 담당자: '접수'·'포장완료'·'보관'까지 허용. 출고는 요청도 완료도 차단
                            const packerBlocked = isPackerRole && s==="출고완료";
                            // 창고에 들어간 뒤에는 보관을 먼저 풀어야 포장 상태를 바꿀 수 있다.
                            // 포장탭(물건을 만지는 사람)에서는 열어둔다 — 되돌릴 수 있어야 하는 건
                            // 선반의 박스를 실제로 여는 사람뿐이다.
                            const storedLock = stored && (s==="접수" || s==="포장완료");
                            const blocked = shipBlocked || adminOnly || packerBlocked || storedLock;
                            return (
                              <button key={s}
                                title={storedLock?"보관중입니다 — 보관을 해제한 뒤 변경하세요":(shipBlocked?"입금확인 후 출고 가능":(adminOnly?"관리자만 가능":(packerBlocked?"포장 담당자는 출고를 변경할 수 없습니다":(isShipReqBtn?"보관분을 포장팀에 넘깁니다 — 재고는 아직 빠지지 않습니다":(isHoldBtn?"눌러서 켜고 끄기":undefined)))))}
                                onClick={()=>{
                                  if(!isHoldBtn && o.status===s) return;   // 보관은 토글이라 같은 값이어도 통과
                                  if(storedLock){ showToast("보관중입니다 — 보관을 해제한 뒤 변경해주세요","error"); return; }
                                  if(packerBlocked){ showToast("포장 담당자는 출고를 변경할 수 없습니다","error"); return; }
                                  if(adminOnly){ showToast("출고완료/취소는 관리자만 가능합니다","error"); return; }
                                  if(shipBlocked){ showToast("입금확인 후 출고해주세요","error"); return; }
                                  if(isShipReqBtn){ requestShipOut(o); }
                                  else if(s==="출고완료"){ handleShipOut(o.id); }
                                  else if(o.status==="출고완료"){ handleUndoShipOut(o.id, s); }
                                  else {
                                    // 포장 담당자는 담당자 락 예외 — 다른 담당자 주문이라도 접수/포장완료/보관 변경 가능
                                    // (packerBlocked 가 출고완료를 이미 막으므로 여기선 접수/포장완료/보관만 도달)
                                    if(!isPackerRole){
                                      const lock=checkOrderLock(o,activeManager,managers,orders);
                                      if(lock){ showToast(lock,"error"); return; }
                                    }
                                    if(isHoldBtn){
                                      // 출고요청이 걸린 건에 보관을 다시 누르는 건 곧 요청 취소다.
                                      // 물건은 아직 선반에 있으니 '요청'이 아니라 '보관중'으로 돌아간다.
                                      if(!held && o.shipRequestedAt){ cancelShipRequest(o); return; }
                                      // 보관 토글 — status는 건드리지 않는다.
                                      // 끄는데 구주문(status="보관")이면 status도 "접수"로 되돌려야 보관이 완전히 해제됨
                                      const next = !held;
                                      const demote = !next && o.status==="보관";
                                      // 여기서 켜는 건 '보관해 달라'는 요청까지다. 실제로 창고에 넣는 건
                                      // 포장직원이고, 그 순간 포장탭이 held_at 을 찍는다.
                                      //
                                      // 끌 때는 held_at 도 같이 지운다. 안 지우면 보관중이던 건을 한 번
                                      // 껐다 켰을 때 옛 held_at 이 살아 있어, 아무도 다시 넣지 않았는데
                                      // 곧바로 '보관중'으로 돌아온다.
                                      //
                                      // 보관을 다시 거는 것이 곧 출고요청 취소다. 요청은 "창고에서
                                      // 꺼내라"는 뜻인데 다시 넣으라고 했으니 둘이 함께 설 수 없다.
                                      const heldPatch = next ? {} : { heldAt: null };
                                      setOrders(p=>p.map(x=>x.id===o.id?{...x,isHolding:next,
                                        ...(next?{}:{heldAt:null}),...(demote?{status:"접수"}:{})}:x));
                                      db.updateOrder(o.id,{isHolding:next,...heldPatch,...(demote?{status:"접수"}:{})});
                                      showToast(next?"📦 보관 요청 — 포장직원이 창고에 넣으면 보관중이 됩니다":"보관 해제");
                                    } else {
                                      // 구주문(status="보관")에서 다른 상태로 옮길 때는 보관 표시를 is_holding으로 승격 — 보관 정보 유실 방지
                                      const promote = o.status==="보관";
                                      // 포장 시각·품목 지문 — 포장탭의 완료 정렬과 '포장 후 수정' 감지가 쓰는 값이라
                                      // 여기서 상태만 바꾸면 두 화면이 어긋난다.
                                      const packFields = s==="포장완료"
                                        ? { packedAt: new Date().toISOString(), packedSig: db.itemsSig(o.items) }
                                        : (o.status==="포장완료" ? { packedAt: null, packedSig: null } : {});
                                      setOrders(p=>p.map(x=>x.id===o.id?{...x,status:s,...(promote?{isHolding:true}:{}),...packFields}:x));
                                      db.updateOrder(o.id,{status:s,...(promote?{is_holding:true}:{}),...packFields});
                                    }
                                  }
                                }}
                                style={{padding:"4px 10px",fontSize:11,borderRadius:20,
                                  border:`1px ${isHoldBtn?"dashed":"solid"} ${isShipReqBtn?T.copper:(isActive?c:T.border)}`,
                                  background:isShipReqBtn?T.copperGlow:(isActive?bg:"transparent"),
                                  color:isShipReqBtn?T.copper:(isActive?c:T.creamMuted),
                                  cursor:blocked?"not-allowed":"pointer",fontFamily:S,
                                  fontWeight:(isActive||isShipReqBtn)?700:400,opacity:blocked?0.45:1}}
                              >
                                {/* 눌린 보관 버튼도 두 단계를 가른다 — 배지와 같은 말을 해야
                                    "버튼은 보관중인데 배지는 요청"이라는 모순이 안 생긴다. */}
                                {isHoldBtn ? (isActive ? (o.heldAt?"📦 보관중":"📦 보관 요청") : "📦 보관")
                                  : isShipReqBtn ? "🚚 출고요청" : s}
                                {s==="출고완료" && isActive && o.shippedAt ? (()=>{const d=new Date(o.shippedAt);return ` (${d.getMonth()+1}/${d.getDate()})`;})() : ""}
                              </button>
                            );
                          })}
                          {cp!=="입금완료" && o.payment!=="환불신청" && o.payment!=="환불" && cp!=="환불완료" ? (
                            <button onClick={async()=>{if(isPackerRole){showToast("포장 담당자는 입금/환불을 처리할 수 없습니다","error");return;}const total=(o.totalAmount>0?o.totalAmount:(o.items||[]).reduce((s,i)=>s+(i.amount||0),0));const logs=await db.fetchOrderLogs(o.id);const computed=db.calcOrderMoney(logs,total);const remaining=computed.balanceAmount;if(remaining<=0){showToast("이미 완납된 주문입니다","error");return;}await db.addPaymentLog(o.id,"입금",remaining,`입금확인 ${remaining.toLocaleString()}원`,o.customer);await db.updateOrder(o.id,{payment:"입금완료"});await reloadOrders();kakaoAlert(`✅ 입금확인\n${o.id} — ${o.customer}`);showToast("입금 확인 완료");}} style={{marginLeft:"auto",padding:"4px 12px",fontSize:11,borderRadius:20,border:`1px solid ${T.green}`,background:T.greenBg,color:T.green,cursor:"pointer",fontFamily:S,fontWeight:700}}>
                              입금확인 ✓
                            </button>
                          ) : (o.payment==="입금완료"||cp==="입금완료") ? (
                            <button onClick={async()=>{if(isPackerRole){showToast("포장 담당자는 입금/환불을 처리할 수 없습니다","error");return;}const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}const total=(o.totalAmount>0?o.totalAmount:(o.items||[]).reduce((s,i)=>s+(i.amount||0),0));const logs=await db.fetchOrderLogs(o.id);const computed=db.calcOrderMoney(logs,total,o.payment);const paid=computed.depositAmount>0?computed.depositAmount:total;setRefundReqModal({order:o,paid});}} style={{marginLeft:"auto",padding:"4px 12px",fontSize:11,borderRadius:20,border:`1px solid ${T.red}`,background:T.redBg,color:T.red,cursor:"pointer",fontFamily:S,fontWeight:700}}>
                              환불신청
                            </button>
                          ) : null}</>; })()}
                        </div>
                        <div style={{display:"flex",gap:6,paddingTop:8,borderTop:`1px solid ${T.border}`,flexWrap:"wrap"}}>
                          {/* 합배송 묶기/해제/운임비 (status="접수"일 때만) — 포장 담당자 제외 */}
                          {!isPackerRole && o.status==="접수" && !o.mergeGroupId && (
                            <button onClick={()=>{const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}setMergeModalOrder(o);}} style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${T.purple}60`,background:"rgba(138,106,184,0.12)",color:T.purple,fontSize:11,cursor:"pointer",fontFamily:S,fontWeight:700}}>🔗 합배송</button>
                          )}
                          {!isPackerRole && o.mergeGroupId && (
                            <>
                              <button onClick={async()=>{
                                const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}
                                if(!window.confirm(`#${String(o.id).slice(0,8)} 주문을 합배송 그룹에서 빼시겠습니까?`))return;
                                try{
                                  const gid = o.mergeGroupId;
                                  await db.clearMergeGroup(o.id);
                                  setOrders(p=>p.map(x=>x.id===o.id?{...x,mergeGroupId:null}:x));
                                  // 빠진 건은 1건 그룹(묶일 때 내려놓은 택배비가 있으면 되돌린다), 남은 그룹은 다시 계산 — 3단계
                                  await settleGroup([{ ...o, mergeGroupId: null }], "합배송 해제");
                                  await settleGroupId(gid, orders.filter(x => x.id !== o.id), "합배송 해제");
                                  showToast("합배송 그룹에서 제외");
                                }catch(e){showToast("실패: "+e.message,"error");}
                              }} style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${T.purple}60`,background:"transparent",color:T.purple,fontSize:11,cursor:"pointer",fontFamily:S,fontWeight:700}}>🔗 해제</button>
                              <button onClick={()=>{const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}const group=orders.filter(x=>x.mergeGroupId===o.mergeGroupId);setFreightModal({target:o,group});}} style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${T.copper}60`,background:T.copperGlow,color:T.copper,fontSize:11,cursor:"pointer",fontFamily:S,fontWeight:700}}>💰 운임비</button>
                            </>
                          )}
                          {/* 거래명세서 HWPX 다운로드 — 모든 역할 허용 (읽기 전용 출력).
                              합배송 그룹(분리배송 제외)이면 그룹 전체를 한 장으로 병합 */}
                          <button onClick={async()=>{
                            try{
                              const { downloadStatementsHwpx } = await import("./lib/statementHwpx.js");
                              const group = o.mergeGroupId && !o.splitShipping
                                ? orders.filter(x=>x.mergeGroupId===o.mergeGroupId && !x.splitShipping)
                                : [o];
                              await downloadStatementsHwpx(group, customers);
                              showToast(group.length>1?`합배송 ${group.length}건을 한 장의 명세서로 다운로드했어요`:"거래명세서 다운로드 완료 — 한글에서 열어 인쇄하세요");
                            }catch(e){ console.error("[명세서]", e); showToast("명세서 생성 실패: "+e.message,"error"); }
                          }} style={{padding:"7px 10px",borderRadius:8,border:`1px solid ${T.copper}60`,background:T.copperGlow,color:T.copper,fontSize:11,cursor:"pointer",fontFamily:S,fontWeight:700}}>🧾 명세서</button>
                          {/* 라벨은 카드마다 뽑지 않는다 — 인쇄 대화창을 건마다 여는 것보다
                              여러 건을 골라 한 번에 보내는 편이 빠르고, 상단 '라벨 출력'이 그 길이다. */}
                          {isPackerRole ? (
                            /* 포장 담당자: 전체 수정/삭제 불가 — 메모만 편집 */
                            <button onClick={()=>{setEditingOrder({...o,items:o.items.map(i=>({...i}))});}} style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S}}>📝 메모</button>
                          ) : (
                            <>
                              <button onClick={()=>{const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}setEditingOrder({...o,items:o.items.map(i=>({...i}))});}} style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>✏ 수정</button>
                              <button onClick={()=>{const lock=checkOrderLock(o,activeManager,managers,orders);if(lock){showToast(lock,"error");return;}setConfirmDel({type:"order",id:o.id,label:`주문 #${String(o.id).slice(0,8)} (${o.customer})`});}} style={{flex:1,padding:"7px",borderRadius:8,border:`1px solid ${T.red}40`,background:T.redBg,color:T.red,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>🗑 삭제</button>
                            </>
                          )}
                        </div>
                      </>}
                      {selectMode && (
                        <div onClick={()=>setSelectedOrders(p=>isSelected?p.filter(x=>x!==o.id):[...p,o.id])}
                          style={{paddingTop:8,borderTop:`1px solid ${T.border}40`,textAlign:"center",fontSize:12,color:isSelected?selC:T.creamMuted,cursor:"pointer",fontWeight:isSelected?700:400}}>
                          {isSelected?"✓ 선택됨":"탭하여 선택"}
                        </div>
                      )}
                    </Card>
                  );
                })
            })()}

            {(()=>{const total=orderListFiltered.length;return total>orderShowCount?(
              <button onClick={()=>setOrderShowCount(c=>c+50)} style={{width:"100%",padding:12,borderRadius:10,border:`1px solid ${T.border}`,background:T.surface,color:T.creamMuted,fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:S,marginBottom:12}}>
                더 보기 ({orderShowCount}/{total}건)
              </button>
            ):null;})()}

            {/* 플로팅 송장 버튼 */}
            {selectMode && selectedOrders.length>0 && (
              <div style={{position:"fixed",bottom:20,left:"50%",transform:"translateX(-50%)",zIndex:50,maxWidth:560,width:"calc(100% - 32px)"}}>
                <button onClick={()=>runPrint(selectMode, selectedOrders)} style={{width:"100%",padding:"15px",borderRadius:14,border:"none",background: selectMode==="label"
  ? `linear-gradient(135deg,${T.blue},${T.blue})`
  : `linear-gradient(135deg,${T.copper},${T.copperLight})`,
color:T.white,fontWeight:800,fontSize:16,cursor:"pointer",fontFamily:S,
boxShadow: selectMode==="label" ? `0 6px 30px ${T.blue}55` : `0 6px 30px ${T.copperGlow}`,
display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                  <span>{selectMode==="label" ? "🏷️" : "🚚"}</span>
                  <span>{selectedOrders.length}건 선택 — {selectMode==="label" ? "라벨 출력" : "송장 출력"}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {tab===2 && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:6}}>
              <div style={{fontFamily:SF,fontSize:22,fontWeight:800,whiteSpace:"nowrap",flexShrink:0}}>재고/반품 관리</div>
              <GhostBtn onClick={exportLogs} small>⬇ 엑셀</GhostBtn>
            </div>

            {/* 서브 탭 */}
            <div style={{display:"flex",gap:0,background:T.surface,borderRadius:12,padding:3,marginBottom:16}}>
              {/* 탭 순서는 IO_VISIBLE_TABS 가 정한다(사용자 지정 순서) — 여기 목록은 아이콘·이름표다 */}
              {IO_VISIBLE_TABS.map(id => [{id:"in",icon:"📥",label:"입고"},{id:"holding",icon:"📦",label:"보관"},{id:"returns",icon:"↩️",label:"반품"},{id:"statement",icon:"🧾",label:"명세서"},{id:"inspect",icon:"🏷",label:"입고·검단"},{id:"rolls",icon:"🧵",label:"롤 재고"},{id:"stock",icon:"🏷",label:"재고현황"},{id:"history",icon:"📋",label:"내역"}].find(t=>t.id===id)).filter(Boolean).map(t=>(
                <button key={t.id} onClick={()=>setIoTab(t.id)} style={{
                  flex:1,padding:"9px 2px",borderRadius:9,border:"none",cursor:"pointer",fontFamily:S,
                  fontWeight:ioTab===t.id?800:500,fontSize:11,
                  background:ioTab===t.id?`linear-gradient(135deg,${T.copper},${T.copperLight})`:"transparent",
                  color:ioTab===t.id?T.white:T.creamMuted,
                  display:"flex",flexDirection:"column",alignItems:"center",gap:2,transition:"all 0.15s",
                }}>
                  <span style={{fontSize:14}}>{t.icon}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </div>

            {/* ── 입고 ── */}
            {ioTab==="in" && (
              <InoutForm inv={inv} setInv={setInv} logs={logs} setLogs={setLogs} showToast={showToast}/>
            )}

            {/* ── 명세서 출력 ── */}
            {ioTab==="statement" && (
              <StatementTab orders={orders} customers={customers} showToast={showToast} T={T}/>
            )}

            {/* ── 롤 재고 — 품번별로 묶어 본다. 가용치는 합계가 아니라 가장 긴 롤 ── */}
            {ioTab==="rolls" && (
              <ErrorBoundary name="롤 재고 화면">
                <RollStockTab products={products} rolls={rolls} managers={managers} reloadRolls={reloadRolls} reloadProducts={reloadProducts}
                  showToast={showToast} activeManager={activeManager}
                  labelStationRow={labelStationRow} labelStationHere={labelStation}/>
              </ErrorBoundary>
            )}

            {/* ── 보관 원단 ── */}
            {ioTab==="holding" && (()=>{
              // is_holding 토글(신규) · status="보관"(구주문) 둘 다 보관 탭에 표시
              const holdingList = orders.filter(o=>isHold(o)&&o.status!=="출고완료");
              return (
              <div>
                <SecTitle>보관 원단 ({holdingList.length}건)</SecTitle>
                {holdingList.length===0
                  ? <Empty text="보관 중인 원단이 없습니다" sub="주문현황 카드에서 📦 보관을 눌러 표시"/>
                  : holdingList.map(o=>(
                    <Card key={o.id} style={{marginBottom:8,border:`1px solid ${T.yellow}40`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <div>
                          <span style={{fontFamily:SF,fontSize:11,color:T.copper,fontWeight:700}}>#{String(o.id).slice(0,8)}</span>
                          <span style={{fontWeight:800,fontSize:15,marginLeft:8}}>{o.customer}</span>
                        </div>
                        {/* 여기도 요청과 완료를 가른다 — 이 목록에서 '보관중'만 보이면
                            아직 창고에 안 들어간 건까지 다 넣은 것으로 읽힌다. */}
                        {o.heldAt
                          ? <Tag c={T.yellow} bg={T.yellowBg}>보관중</Tag>
                          : <Tag c={T.white} bg={T.yellow}>보관 요청</Tag>}
                      </div>
                      <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                        {o.items.map((item,i)=>(
                          <span key={i} style={{fontSize:11,padding:"3px 8px",background:T.surface,borderRadius:6,border:`1px solid ${T.border}`,color:T.creamMuted}}>
                            {item.itemNo && <b style={{color:T.copper,fontFamily:"monospace",marginRight:3}}>{item.itemNo.toUpperCase()}</b>}
                            {item.fabric}{item.color?" "+item.color:""} <b style={{color:T.cream}}>{item.qty}{item.unit||"마"}</b>
                          </span>
                        ))}
                      </div>
                      <div style={{fontSize:11,color:T.creamMuted,marginBottom:10}}>{o.date} · {o.address||"주소 없음"}</div>
                      <button onClick={async()=>{
                        if (!currentManagerObj?.isAdmin) { showToast("배송 완료 처리는 관리자만 가능합니다","error"); return; }
                        // status="보관"이면 handleShipOut으로 출고완료 처리 (재고 차감 포함)
                        // 출고가 막히거나 취소되면 여기서 멈춘다 — 안 나간 주문에 "배송 완료 처리"를 띄우지 않는다
                        if(o.status!=="출고완료"){
                          if (!(await handleShipOut(o.id))) return;
                        }
                        // legacy is_holding 정리 — 넣은 시각도 같이 지운다.
                        // 남겨두면 나중에 다시 보관 요청을 걸었을 때, 아무도 창고에 넣지
                        // 않았는데 옛 held_at 때문에 곧바로 '보관중'으로 보인다.
                        if(o.isHolding){
                          await db.updateOrder(o.id,{isHolding:false,heldAt:null});
                          setOrders(p=>p.map(x=>x.id===o.id?{...x,isHolding:false,heldAt:null}:x));
                        }
                        showToast("배송 완료 처리");
                      }} style={{width:"100%",padding:"10px",borderRadius:8,border:"none",background:`linear-gradient(135deg,${T.green},#34D399)`,color:T.white,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:S}}>
                        배송 완료 처리
                      </button>
                    </Card>
                  ))
                }
              </div>
              );
            })()}

            {/* ── 반품 — 부분 반품 지원, 반품입고 시 재고 복구 ── */}
            {ioTab==="returns" && (
              <ReturnsTab
                orders={orders} setOrders={setOrders} products={products} reloadRolls={reloadRolls} setLogs={setLogs}
                returns={returns} setReturns={setReturns}
                credits={credits} setCredits={setCredits}
                managers={managers}
                showToast={showToast} activeManager={activeManager}
                isAdmin={!!currentManagerObj?.isAdmin}
                onRefundRequest={openRefundRequest}
              />
            )}

            {/* ── 재고현황 ── */}
            {ioTab==="stock" && (()=>{
              const filteredInv = inv.filter(i => {
                if (stockFilter==="low" && i.stock>=settings.lowStockAlert) return false;
                if (stockFilter==="mid" && (i.stock<settings.lowStockAlert||i.stock>=30)) return false;
                if (stockFilter==="ok" && i.stock<30) return false;
                if (stockSearch.trim()) {
                  const q = stockSearch.trim().toLowerCase();
                  if (!(i.fabric||"").toLowerCase().includes(q) && !(i.color||"").toLowerCase().includes(q) && !(i.item_no||"").toLowerCase().includes(q)) return false;
                }
                return true;
              }).sort((a,b) => {
                if (stockSort==="qty_asc") return a.stock - b.stock;
                if (stockSort==="name") return (a.fabric||"").localeCompare(b.fabric||"","ko");
                if (stockSort==="itemno") return (a.item_no||"").localeCompare(b.item_no||"","ko");
                return b.stock - a.stock;
              });
              const lowCnt = inv.filter(i=>i.stock<settings.lowStockAlert).length;
              const midCnt = inv.filter(i=>i.stock>=settings.lowStockAlert&&i.stock<30).length;
              const okCnt = inv.filter(i=>i.stock>=30).length;
              return (
              <div>
                {/* 필터 버튼 */}
                <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
                  {[
                    {k:"",l:"전체",cnt:inv.length},
                    {k:"low",l:"\u{1F534} 부족",cnt:lowCnt},
                    {k:"mid",l:"\u{1F7E1} 주의",cnt:midCnt},
                    {k:"ok",l:"\u{1F7E2} 정상",cnt:okCnt},
                  ].map(f=>(
                    <button key={f.k} onClick={()=>setStockFilter(f.k)} style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${stockFilter===f.k?T.copper:T.border}`,background:stockFilter===f.k?T.copperGlow:"transparent",color:stockFilter===f.k?T.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:stockFilter===f.k?700:400}}>
                      {f.l} ({f.cnt})
                    </button>
                  ))}
                </div>
                {/* 검색 + 정렬 */}
                <div style={{display:"flex",gap:6,marginBottom:12}}>
                  <input value={stockSearch} onChange={e=>setStockSearch(e.target.value)} placeholder="원단명 / 색상 / 아이템No 검색" style={{...baseInp,flex:1,fontSize:12,padding:"8px 10px",background:T.inputBg,border:`1px solid ${T.border}`,color:T.cream}}/>
                  <select value={stockSort} onChange={e=>setStockSort(e.target.value)} style={{padding:"8px 10px",fontSize:11,borderRadius:10,border:`1px solid ${T.border}`,background:T.inputBg,color:T.cream,fontFamily:S,cursor:"pointer"}}>
                    <option value="qty_desc">재고 많은순</option>
                    <option value="qty_asc">재고 적은순</option>
                    <option value="name">이름순</option>
                    <option value="itemno">아이템No순</option>
                  </select>
                </div>

                <Card style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <SecTitle>재고 현황 ({filteredInv.length}/{inv.length}품목)</SecTitle>
                  </div>
                  {filteredInv.length===0
                    ? <Empty text="조건에 맞는 재고가 없습니다" sub="필터를 조정해보세요"/>
                    : filteredInv.map((i,idx)=>(
                      <div key={i.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderTop:idx>0?`1px solid ${T.border}`:"none"}}>
                        <div>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            {i.item_no && <span style={{fontSize:11,color:T.copper,fontFamily:"monospace",fontWeight:700}}>{i.item_no.toUpperCase()}</span>}
                            <span style={{fontSize:14,fontWeight:700}}>{i.fabric}</span>
                          </div>
                          {i.color && <div style={{fontSize:11,color:T.creamMuted,marginTop:1}}>{i.color}</div>}
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{textAlign:"right"}}>
                            <span style={{fontFamily:SF,fontSize:20,fontWeight:800,color:i.stock<settings.lowStockAlert?T.red:i.stock<30?T.yellow:T.green}}>{i.stock}</span>
                            <span style={{fontSize:11,color:T.creamMuted,marginLeft:2}}>마{i.stock<settings.lowStockAlert?" ⚠":""}</span>
                          </div>
                          <button onClick={()=>setEditingInv({...i})} style={{padding:"4px 9px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,fontSize:12,cursor:"pointer",fontFamily:S}}>✏</button>
                          <button onClick={()=>setConfirmDel({type:"inv",id:i.id,label:`${i.fabric} ${i.color}`})} style={{padding:"4px 9px",borderRadius:7,border:`1px solid ${T.red}40`,background:T.redBg,color:T.red,fontSize:12,cursor:"pointer",fontFamily:S}}>🗑</button>
                        </div>
                      </div>
                    ))
                  }
                </Card>
                {/* 재고 바 차트 */}
                <Card>
                  <SecTitle>재고 시각화</SecTitle>
                  {filteredInv.slice(0,12).map(i=>(
                    <div key={i.id} style={{marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
                        <span style={{fontWeight:600}}>{i.item_no?i.item_no.toUpperCase()+" ":""}{i.fabric}{i.color?" · "+i.color:""}</span>
                        <span style={{fontWeight:700,color:i.stock<settings.lowStockAlert?T.red:i.stock<30?T.yellow:T.green}}>{i.stock}마</span>
                      </div>
                      <div style={{height:6,background:T.trackBg,borderRadius:3,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${Math.min(100,(i.stock/Math.max(...filteredInv.map(x=>x.stock),1))*100)}%`,background:i.stock<settings.lowStockAlert?T.red:i.stock<30?T.yellow:T.copper,borderRadius:3,transition:"width 0.5s"}}/>
                      </div>
                    </div>
                  ))}
                </Card>
              </div>
              );
            })()}

            {/* ── 내역 ── */}
            {ioTab==="history" && (()=>{
              const filteredLogs = logs.filter(l => {
                if (logTypeFilter && l.type !== logTypeFilter) return false;
                if (logDateFilter) {
                  const [y,m,d] = logDateFilter.split("-");
                  const target = `${+y}. ${+m}. ${+d}.`;
                  if (l.date !== target) return false;
                }
                return true;
              });
              return (
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontFamily:SF,fontSize:16,fontWeight:700}}>입출고 내역 ({filteredLogs.length}건)</div>
                  <div style={{display:"flex",gap:6}}>
                    <Tag c={T.green} bg={T.greenBg}>입고 {filteredLogs.filter(l=>l.type==="입고").length}</Tag>
                    <Tag c={T.copper} bg={T.copperGlow}>출고 {filteredLogs.filter(l=>l.type==="출고").length}</Tag>
                  </div>
                </div>
                {/* 필터 */}
                <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
                  {["","입고","출고"].map(f=>(
                    <button key={f} onClick={()=>setLogTypeFilter(f)} style={{padding:"5px 14px",fontSize:11,borderRadius:16,border:`1px solid ${logTypeFilter===f?T.copper:T.border}`,background:logTypeFilter===f?T.copperGlow:"transparent",color:logTypeFilter===f?T.copper:T.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:logTypeFilter===f?700:400}}>
                      {f||"전체"}
                    </button>
                  ))}
                  <input type="date" value={logDateFilter} onChange={e=>setLogDateFilter(e.target.value)} style={{marginLeft:"auto",padding:"4px 8px",fontSize:11,borderRadius:8,border:`1px solid ${T.border}`,background:T.inputBg,color:T.cream,fontFamily:S}}/>
                  {logDateFilter&&<button onClick={()=>setLogDateFilter("")} style={{padding:"4px 8px",fontSize:10,borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted,cursor:"pointer",fontFamily:S}}>초기화</button>}
                </div>
                {filteredLogs.length===0
                  ? <Empty text="입출고 내역이 없습니다" sub={logTypeFilter||logDateFilter?"필터를 조정해보세요":""}/>
                  : filteredLogs.map(log=>(
                    <div key={log.id} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",background:T.card,borderRadius:10,border:`1px solid ${T.border}`,marginBottom:6}}>
                      <Tag c={log.type==="입고"?T.green:T.copper} bg={log.type==="입고"?T.greenBg:T.copperGlow}>{log.type}</Tag>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:14,fontWeight:700}}>{log.fabric}{log.color?" · "+log.color:""}</div>
                        <div style={{fontSize:11,color:T.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                      {log.date} · {log.ref}
                      {log.costPrice>0&&<span style={{color:T.copper,marginLeft:4}}>@{log.costPrice.toLocaleString()}원</span>}
                      {log.note&&log.note!=="—"?<span> · {log.note}</span>:""}
                    </div>
                      </div>
                      <span style={{fontFamily:SF,fontSize:18,fontWeight:800,color:log.type==="입고"?T.green:T.copper}}>{log.qty}<span style={{fontSize:10,color:T.creamMuted,marginLeft:2}}>마</span></span>
                      <button onClick={()=>setConfirmDel({type:"log",id:log.id,label:`${log.type} ${log.fabric} ${log.qty}마`})} style={{padding:"4px 7px",borderRadius:6,border:`1px solid ${T.red}40`,background:T.redBg,color:T.red,fontSize:11,cursor:"pointer",fontFamily:S,flexShrink:0}}>🗑</button>
                    </div>
                  ))
                }
              </div>
              );
            })()}
          </div>
        )}

        {tab===3 && (
          <CustomerTab
            customers={customers} setCustomers={setCustomers} orders={orders}
            exportCustomers={exportCustomers} showToast={showToast} kakaoAlert={kakaoAlert}
            setConfirmDel={setConfirmDel} setEditingCust={setEditingCust}
            credits={credits} freeShipping={freeShipping}
            isAdmin={!!currentManagerObj?.isAdmin}
          />
        )}

        {tab===4 && (
          <DepositTab showToast={showToast} customers={customers} orders={orders} setOrders={setOrders} credits={credits} setCredits={setCredits} freeShipping={freeShipping} setFreeShipping={setFreeShipping} reloadOrders={reloadOrders} managers={managers} activeManager={activeManager} preset={depositPreset} />
        )}

        {tab===5 && (
          <DashboardTab orders={orders} customers={customers} setOrders={setOrders} showToast={showToast} credits={credits} setCredits={setCredits} inv={inv} reloadOrders={reloadOrders} managers={managers} isAdmin={!!currentManagerObj?.isAdmin} activeManager={activeManager} onRefundRequest={openRefundRequest} onUndoShipOut={handleUndoShipOut} />
        )}

        {tab===6 && (
          <div>
            <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:20,color:T.cream}}>설정</div>

            {/* 업무 매뉴얼 — 전 직원 노출 */}
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>업무 매뉴얼</SecTitle>
              <div style={{fontSize:12,color:T.creamMuted,marginBottom:10,lineHeight:1.7}}>
                환불 · 반품 · 적립금 처리 방법을 상황별로 정리 (로그인 없이 열람 가능)
              </div>
              <button onClick={()=>{
                window.open("/manual.html","_blank");
              }} style={{width:"100%",padding:13,borderRadius:10,border:`1.5px solid ${T.copper}`,
                background:T.copperGlow,color:T.copper,fontWeight:800,fontSize:14,
                cursor:"pointer",fontFamily:S,marginBottom:8}}>
                📒 환불·반품·적립금 매뉴얼 열기
              </button>
              <button onClick={()=>{
                const url = window.location.origin + "/manual.html";
                if(navigator.clipboard) navigator.clipboard.writeText(url).then(()=>showToast("✓ 매뉴얼 링크 복사!"));
                else showToast("위 버튼을 탭해서 접속하세요");
              }} style={{width:"100%",padding:11,borderRadius:10,border:`1px solid ${T.border}`,
                background:"transparent",color:T.creamMuted,fontWeight:700,fontSize:13,
                cursor:"pointer",fontFamily:S}}>
                🔗 링크 복사
              </button>
            </Card>

            {/* 담당자 관리 — 관리자만 노출 */}
            {currentManagerObj?.isAdmin && (
              <ManagerSettings
                T={T} S={S} SF={SF} baseInp={baseInp}
                managers={managers} setManagers={setManagers}
                activeManager={activeManager} setActiveManager={setActiveManager}
                showToast={showToast}
              />
            )}

            {/* 테마 */}
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>화면 테마</SecTitle>
              <div style={{display:"flex",gap:10}}>
                {["dark","light"].map(th=>(
                  <button key={th} onClick={()=>{setTheme(th);localStorage.setItem("erp_theme",th);}} style={{
                    flex:1,padding:"14px 0",borderRadius:12,cursor:"pointer",fontFamily:S,fontWeight:700,fontSize:13,
                    border:`2px solid ${theme===th?T.copper:T.border}`,
                    background:theme===th?T.copperGlow:(th==="dark"?"#0D0B09":"#F8F9FA"),
                    color:theme===th?T.copper:(th==="dark"?"#F0E6D6":"#1A1A2E"),
                    display:"flex",flexDirection:"column",alignItems:"center",gap:6,transition:"all 0.2s",
                  }}>
                    <span style={{fontSize:22}}>{th==="dark"?"🌙":"☀️"}</span>
                    <span>{th==="dark"?"다크 모드":"화이트 모드"}</span>
                  </button>
                ))}
              </div>
            </Card>

            {/* 라벨 자동 출력 — 기기 설정이라 역할로 가리지 않는다.
                프린터가 물려 있는 그 PC 가 포장 계정으로 로그인돼 있을 수도 있는데,
                운영성 설정 안쪽에 넣으면 정작 켜야 할 사람이 이 화면을 못 본다. */}
            <Card style={{marginBottom:14,background:T.card,
              border:`1px solid ${labelStation ? T.blue : T.border}`}}>
              <SecTitle>라벨 자동 출력</SecTitle>
              <div style={{fontSize:12,color:T.creamMuted,marginBottom:10,lineHeight:1.7}}>
                <b style={{color:T.cream}}>{LABEL_PRINTER} 이 연결된 컴퓨터에서만</b> 켜세요.
                켜 두면 누가 어느 기기에서 <b style={{color:T.cream}}>주문현황 → 🏷️ 라벨 출력</b> 을 누르든
                이 컴퓨터에서 원단 라벨이 나옵니다. 모바일에서 눌러도 됩니다 —
                고르는 사람은 인쇄에 대해 아무것도 하지 않습니다.
              </div>
              {/* 담당이 다른 기기면 여기서 먼저 보여준다. 이게 있어야 "지금 어디서
                  뽑히고 있나"를 그 PC 앞까지 걸어가지 않고 알 수 있다. */}
              {labelStationOther && (
                <div style={{marginBottom:10,padding:"10px 12px",borderRadius:9,
                  background:T.subtleBg,border:`1px solid ${T.border}`,
                  fontSize:12,color:T.cream,lineHeight:1.7}}>
                  🏷️ 현재 담당 — <b style={{color:T.copper}}>{labelStationOther.deviceName || "이름 없는 기기"}</b>
                  {labelStationOther.armedBy && ` · ${labelStationOther.armedBy}님이 지정`}<br/>
                  <span style={{fontSize:11,color:T.creamMuted}}>
                    {new Date(labelStationOther.armedAt).toLocaleString("ko-KR")} 부터 · 이 컴퓨터에서는 나오지 않습니다
                  </span>
                </div>
              )}

              <button onClick={async ()=>{
                try {
                  if (labelStation) {
                    // 내 기기가 담당일 때만 지운다 — 누르는 사이 다른 PC 가 가져갔다면
                    // 그쪽을 꺼버리게 된다.
                    await db.releaseLabelStation(deviceId);
                    await reloadLabelStation();
                    showToast("라벨 자동 출력을 껐습니다");
                    return;
                  }
                  // 담당을 뺏는 건 되돌리기 어려운 일이다(이전 PC 가 조용히 멈춘다).
                  // 누가 담당인지 보여주고 한 번 묻는다.
                  if (labelStationOther && !window.confirm(
                    `현재 라벨 출력 담당은 "${labelStationOther.deviceName || "이름 없는 기기"}" 입니다.\n\n`
                    + "이 컴퓨터로 가져오면 그 기기에서는 더 이상 라벨이 나오지 않습니다.\n계속할까요?")) return;

                  // 기기 이름을 받는다. 무작위 ID 만으로는 관리자가 설정 화면에서
                  // 어느 컴퓨터인지 분간할 수 없어 해제 판단을 못 한다.
                  const name = window.prompt(
                    "이 컴퓨터의 이름을 적어주세요 — 나중에 설정에서 이 이름으로 보입니다.\n예) 포장대 PC",
                    localStorage.getItem("erp_device_name") || "");
                  if (name === null) return;                 // 취소
                  const deviceName = name.trim() || "이름 없는 기기";
                  localStorage.setItem("erp_device_name", deviceName);

                  await db.claimLabelStation({ deviceId, deviceName, armedBy: activeManager || "" });
                  await reloadLabelStation();
                  showToast(`🏷️ "${deviceName}" 이 라벨 출력 담당입니다 — 출력요청이 걸린 주문이 여기서 나옵니다`);
                } catch (e) {
                  showToast("처리 실패: " + e.message, "error");
                }
              }} style={{width:"100%",padding:14,borderRadius:10,cursor:"pointer",fontFamily:S,
                fontWeight:800,fontSize:14,
                border:`1.5px solid ${labelStation ? T.blue : T.border}`,
                background: labelStation ? T.blue : "transparent",
                color: labelStation ? "#fff" : T.creamMuted}}>
                {labelStation ? "🏷️ 자동 출력 켜짐 — 누르면 끕니다"
                  : labelStationOther ? "이 컴퓨터로 담당 가져오기"
                  : "이 컴퓨터를 라벨 출력 담당으로"}
              </button>

              {/* 관리자 강제 해제 — 담당 PC 가 꺼져 있거나 손이 닿지 않을 때.
                  그 기기 앞까지 걸어가지 않고 끌 수 있어야 이 기능이 의미가 있다. */}
              {labelStationOther && !!currentManagerObj?.isAdmin && (
                <button onClick={async ()=>{
                  if (!window.confirm(`"${labelStationOther.deviceName || "이름 없는 기기"}" 의 라벨 출력 담당을 해제할까요?\n\n`
                    + "해제하면 어느 컴퓨터에서도 자동 출력이 되지 않습니다.")) return;
                  try {
                    await db.releaseLabelStation();
                    await reloadLabelStation();
                    showToast("담당을 해제했습니다 — 자동 출력이 멈춥니다");
                  } catch (e) { showToast("처리 실패: " + e.message, "error"); }
                }} style={{width:"100%",marginTop:8,padding:11,borderRadius:10,cursor:"pointer",
                  fontFamily:S,fontWeight:700,fontSize:12.5,
                  border:`1px solid ${T.red}55`,background:"transparent",color:T.red}}>
                  담당 해제 (관리자)
                </button>
              )}

              {labelStation && (
                <div style={{marginTop:10,padding:"10px 12px",borderRadius:9,
                  background:T.subtleBg,border:`1px solid ${T.border}`,
                  fontSize:11.5,color:T.creamMuted,lineHeight:1.75}}>
                  {/* 지킬 것을 여기 적어둔다. 이걸 모르면 "안 나온다" 로 돌아온다.
                      특히 '창 닫기'와 '스위치 끄기'가 다르다는 점 — 여기서 제일 헷갈린다. */}
                  · <b style={{color:T.cream}}>이 창을 켜 두세요.</b> 창을 닫아도 스위치는 그대로라,
                  다시 열면 <b style={{color:T.cream}}>그동안 밀린 요청부터 나옵니다</b><br/>
                  · <b style={{color:T.cream}}>주문을 등록하는 것만으로는 나오지 않습니다.</b>
                  주문현황에서 🏷️ 라벨 출력으로 골라야 요청이 걸립니다<br/>
                  · 인쇄창 없이 바로 뽑으려면 크롬 바로가기 속성 → 대상 맨 뒤에
                  <b style={{color:T.cream}}> --kiosk-printing</b> 을 붙이고,
                  이 컴퓨터의 기본 프린터를 <b style={{color:T.cream}}>{LABEL_PRINTER}</b> 로 지정하세요<br/>
                  · 이 컴퓨터가 꺼져 있는 동안 걸린 요청도 <b style={{color:T.cream}}>켜면 이어서 나옵니다</b>
                  — 요청은 사람이 고른 것이라 조용히 버리지 않습니다<br/>
                  · 이미 뽑은 주문을 다시 고르면 <b style={{color:T.cream}}>다시 나옵니다</b>(재출력)<br/>
                  · 밀린 요청이 <b style={{color:T.cream}}>{AUTO_PRINT_ALARM}건을 넘으면 출력을 멈추고</b> 알려드립니다
                  — 수백 장이 한꺼번에 쏟아지는 걸 막습니다<br/>
                  · 담당은 <b style={{color:T.cream}}>회사 전체에서 한 대뿐</b>입니다.
                  다른 컴퓨터에서 담당을 가져가면 이 컴퓨터는 그 즉시 멈춥니다
                  {labelStationRow?.deviceName && ` (이 기기 이름: ${labelStationRow.deviceName})`}
                </div>
              )}
            </Card>

            {/* 이하 운영성 설정 — 셀러(역할 미지정)·포장 담당자에게는 화면테마·글씨크기만 노출 */}
            {!basicSettingsOnly && (
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>더브릿지 소개 페이지</SecTitle>
              <div style={{fontSize:12,color:T.creamMuted,marginBottom:10,lineHeight:1.7}}>
                더브릿지 서비스 소개 · 요금제 · 데모 체험
              </div>
              <button onClick={()=>{
                window.open("https://thebridge.ai.kr/","_blank");
              }} style={{width:"100%",padding:13,borderRadius:10,border:`1.5px solid ${T.copper}`,
                background:T.copperGlow,color:T.copper,fontWeight:800,fontSize:14,
                cursor:"pointer",fontFamily:S,marginBottom:8}}>
                🌐 더브릿지 랜딩페이지 바로가기
              </button>
              <button onClick={()=>{
                const url = "https://thebridge.ai.kr/";
                if(navigator.clipboard) navigator.clipboard.writeText(url).then(()=>showToast("✓ 랜딩페이지 링크 복사!"));
                else showToast("위 버튼을 탭해서 접속하세요");
              }} style={{width:"100%",padding:11,borderRadius:10,border:`1px solid ${T.border}`,
                background:"transparent",color:T.creamMuted,fontWeight:700,fontSize:13,
                cursor:"pointer",fontFamily:S}}>
                🔗 링크 복사
              </button>
            </Card>
            )}

            {false && (
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>AI 주문 분석</SecTitle>
              <div style={{marginBottom:10}}>
                <FLabel>Anthropic API Key</FLabel>
                {settings.anthropicKey ? (
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <div style={{...baseInp,flex:1,cursor:"not-allowed",opacity:0.6,letterSpacing:3}}>••••••••••••••••</div>
                    <GhostBtn small color={T.red} onClick={()=>setSettings(s=>({...s,anthropicKey:""}))}>초기화</GhostBtn>
                  </div>
                ) : (
                  <input type="password" value="" onChange={e=>setSettings(s=>({...s,anthropicKey:e.target.value}))} placeholder="sk-ant-..." style={baseInp}/>
                )}
              </div>
              <div style={{fontSize:11,color:T.creamMuted,lineHeight:1.5}}>AI 주문 분석 기능에 사용됩니다. 키는 브라우저에만 저장됩니다.</div>
            </Card>
            )}

            {!basicSettingsOnly && (<>
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`,opacity:0.6}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                <SecTitle>카카오톡 알림</SecTitle>
                <span style={{fontSize:10,fontWeight:800,color:T.copper,background:T.copperGlow,padding:"3px 8px",borderRadius:6,letterSpacing:"0.04em"}}>준비중</span>
              </div>
              <div style={{fontSize:12,color:T.creamMuted,lineHeight:1.6}}>
                카카오톡 알림 기능은 현재 준비 중입니다. 곧 지원될 예정입니다.
              </div>
            </Card>
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>재고 알림</SecTitle>
              <div><FLabel>저재고 기준 (마)</FLabel><input type="number" value={settings.lowStockAlert} onChange={e=>setSettings(s=>({...s,lowStockAlert:parseInt(e.target.value)||10}))} style={baseInp}/></div>
            </Card>
            {/* 택배사·합배송 규칙 안내 — 관리자만. 배송비 기준 칸은 2026-10-12 사용자 결정으로 뺐다(택배사는 배송비와 무관). */}
            {isAdminRole && (
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>택배사·합배송 규칙</SecTitle>
              <div style={{fontSize:11,color:T.creamMuted,lineHeight:1.6}}>
                택배사는 주문 메모(일반 메모·담당자 메모)에 '롤'이 있으면 경동, 없으면 CJ 로 자동 판정합니다. 배송비는 보지 않습니다.
                안 맞는 건은 주문 등록·수정 화면에서 택배사를 직접 고릅니다. 합배송 묶음은 한 박스라 한 건에만 '롤'이 있어도 묶음 전체가 경동입니다.
              </div>
              <div style={{fontSize:11,color:T.creamMuted,marginTop:6,lineHeight:1.6}}>
                합배송을 묶으면 출고예정일은 가장 늦은 주문에 맞춰지고, 택배비가 여러 건에 있으면 먼저 등록된 한 건에만 남습니다. 묶음에서 빠지거나 분리되거나 한 건만 먼저 출고되면, 묶일 때 빠졌던 택배비가 원래대로 돌아옵니다(원래 없던 주문은 없는 그대로 · 입금완료 주문은 바꾸지 않음).
              </div>
            </Card>
            )}
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>📂 엑셀 파일 업로드</SecTitle>
              <ExcelImport orders={orders} setOrders={setOrders} customers={customers} setCustomers={setCustomers} showToast={showToast} />
            </Card>
            </>)}

            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>글씨 크기</SecTitle>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                <span style={{fontSize:13,fontWeight:700,color:T.cream}}>크기 조절</span>
                <span style={{fontSize:13,fontWeight:800,color:T.copper,minWidth:32,textAlign:"center"}}>{fontScale>0?`+${fontScale}`:fontScale}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                <span style={{fontSize:11,color:T.creamMuted,flexShrink:0}}>가</span>
                <input type="range" min={-10} max={10} step={1} value={fontScale}
                  onChange={e=>{const v=parseInt(e.target.value);setFontScale(v);localStorage.setItem("erp_fontScale",v);}}
                  style={{flex:1,accentColor:T.copper,height:6,cursor:"pointer"}}
                />
                <span style={{fontSize:16,fontWeight:700,color:T.creamMuted,flexShrink:0}}>가</span>
              </div>
              <div style={{display:"flex",gap:6}}>
                {[{d:-5,label:"5씩 감소"},{d:0,label:"기본"},{d:5,label:"5씩 증가"}].map(({d,label})=>(
                  <button key={label} onClick={()=>{
                    const nv=d===0?0:Math.max(-10,Math.min(10,fontScale+d));
                    setFontScale(nv);localStorage.setItem("erp_fontScale",String(nv));
                  }}
                    style={{flex:1,padding:"8px 0",borderRadius:8,fontSize:12,fontWeight:500,cursor:"pointer",fontFamily:S,
                      border:`1px solid ${T.border}`,
                      background:"transparent",
                      color:T.creamMuted}}>
                    {label}
                  </button>
                ))}
              </div>
              <div style={{fontSize:11,color:T.creamMuted,marginTop:10,lineHeight:1.5}}>
                0 기준이 기본 크기입니다. 슬라��더를 움직여 -10(작게)~+10(크게) 조절할 수 있습니다.
              </div>
            </Card>

            {!basicSettingsOnly && (
            <Card style={{marginBottom:14,background:T.card,border:`1px solid ${T.border}`}}>
              <SecTitle>데이터 내보내기</SecTitle>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                <GhostBtn onClick={exportOrders} full>⬇ 주문현황 엑셀</GhostBtn>
                <GhostBtn onClick={exportLogs} full>⬇ 입출고이력 엑셀</GhostBtn>
                <GhostBtn onClick={exportCustomers} full>⬇ 고객목록 엑셀</GhostBtn>
              </div>
            </Card>
            )}

            {currentManagerObj?.isAdmin && (
              <DataManagement showToast={showToast} reloadOrders={reloadOrders} activeManager={activeManager} />
            )}
          </div>
        )}
      </div>
    </div>
    <SideScroller />
    </ThemeCtx.Provider>
  );
}

export default ErpApp;
