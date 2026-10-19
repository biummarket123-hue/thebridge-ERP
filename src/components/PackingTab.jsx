import { useMemo, useState, useEffect, useRef } from "react";
import { Card, Empty } from "./UI.jsx";
import { S, SF, getPayStatus, isHold, isParked, isFabricMissing, missingItemIdx, stripCardDup, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { shipBucket, todayYmd, parseYmd, ymd, addDays } from "../lib/shipDate.js";
import LinkPreview from "./LinkPreview.jsx";
import HandoverPanel from "./HandoverPanel.jsx";
import { CourierTag, PickupTag } from "./Courier.jsx";
import { courierMap } from "../lib/courier.js";
import { parseScan, packingOf, scanStats, packGate, resolveScan, resolveItemScan, resolvePendingRoll, parseCutLength, autoCutPlan, allItemsPacked, productOfItem } from "../lib/packing.js";
import { fmtLen, rollErrorText, isRollUnit } from "../lib/rollStock.js";
import ScreenKeyboard from "./ScreenKeyboard.jsx";

// 포장직원 전용 화면.
//
// 왜 따로 만드는가:
//  · 주문현황은 등록순 목록이다. 등록 시각은 셀러 사정(주말에 몰아 넣는 사람,
//    미리미리 넣는 사람)이라 포장 우선순위와 무관하다. 그 순서대로 포장하면
//    늦게 나가도 될 주문이 먼저 나간다.
//  · 화면의 한 칸이 '주문 1건'이라 합배송 3건이 카드 3장으로 흩어진다.
//    놓치는 게 주의력 문제가 아니라 화면 구조가 만드는 실수였다.
//
// 그래서 이 화면은:
//  · 탭 = 출고 마감(긴급/당일/익일/예약). 매일 오늘 기준으로 계산한다.
//  · 작업 단위 = 박스. 합배송 그룹은 카드 1장으로 합쳐 구조적으로 놓칠 수 없게 한다.
//  · 출고완료 전 주문을 전부 보여준다. 미입금도 포장은 한다 — 돈이 덜 들어온 건
//    카드에 배지로 알리고, 실제로 막는 건 출고 단계(관리자 전용)에서 한다.
//  · 금액을 걷어내고 품목·주소·배송메시지를 크게 — 포장에 필요한 것만.

// 탭은 두 줄이다. 일곱 칸을 한 줄에 똑같은 크기로 늘어놓으면 일곱 개가 전부
// 똑같이 중요해 보인다 — 헷갈리는 건 개수가 아니라 위계가 없어서다.
//
//  · 윗줄(날짜축) = 오늘 해야 할 일. 넷은 서로 배타적이라 합치면 '안 싼 물량 전체'다.
//    아침에 보는 건 이 줄뿐이어야 한다.
//  · 아랫줄(상태축) = 윗줄에서 빠져나간 것. 하루에 몇 번 안 보고, 볼 때는 찾으러 간다.
//
// 접어서 감추지 않고 크기만 줄인다. 숨기면 "보관 요청 3건 밀림"을 아무도 못 본다.
const QUEUE_VIEWS = [
  { k: "urgent",   label: "긴급", emoji: "🔴", color: "red" },
  { k: "today",    label: "당일", emoji: "🟠", color: "copper" },
  { k: "tomorrow", label: "익일", emoji: "🔵", color: "blue" },
  { k: "later",    label: "예약", emoji: "📅", color: "purple" },
];
// 아랫줄은 '방금 끝낸 것 → 잡아둔 것 → 얼려둔 것' 순이다. 왼쪽일수록 자주 열고,
// 오른쪽으로 갈수록 손댈 일이 뜸해진다.
const ASIDE_VIEWS = [
  // 원단 미도착은 칸을 따로 두지 않는다. 원단은 대부분 몇 분 안에 오는데 그때마다
  // 카드가 칸을 옮겨다니면 포장직원이 방금 보던 걸 다시 찾아야 한다.
  // 제자리에 두고 품목 줄만 분홍으로 표시한다.
  // 완료 — 싼 박스를 되돌리거나, 기사에게 건넨 뒤 출고완료로 넘긴다(HandoverPanel).
  // 방금 싼 박스를 되돌리는 일이 이 줄에서 제일 잦다.
  { k: "done",     label: "완료", emoji: "✅", color: "green" },
  // 보관은 '지금 안 나가는 것'이다. 등록순 목록에 섞이면 오래된 보관 건이 맨 위를
  // 차지해 매번 지나쳐야 한다 — 따로 뺀다.
  { k: "hold",     label: "보관", emoji: "📦", color: "yellow" },
  // 보류는 보관과 다르다. 보관은 물건이 다 돼서 창고에 잡아둔 것이고, 보류는
  // 나갈 수 없는 것(연락 두절·단종·결제 분쟁)이다. 한 칸에 섞으면 곧 나갈 건 사이에
  // 죽은 건이 끼어 보관 탭을 훑을 때마다 매번 지나쳐야 한다.
  // 색을 회색으로 두는 것도 의도다 — 눈이 가면 안 되는 칸이다.
  { k: "parked",   label: "보류", emoji: "🗄️", color: "creamMuted" },
];
const VIEWS = [...QUEUE_VIEWS, ...ASIDE_VIEWS];

// 당일·익일 묶어보기.
//
// 익일까지는 어차피 그날 다 싸므로, 두 칸을 오가는 것 자체가 일이다.
// 다만 다섯 번째 칸(당일+익일)을 만들지는 않는다 — 윗줄 네 칸이 서로 배타적이라
// 다 더하면 '안 싼 물량 전체'가 되는데, 겹치는 칸이 하나 생기면 그 계산이 깨진다.
// 숫자를 못 믿게 되는 순간 탭 줄 전체가 쓸모없어진다.
// 그래서 칸(groups)은 넷 그대로 두고, 화면에 그릴 때만 두 목록을 이어 붙인다.
const DAY_PAIR = new Set(["today", "tomorrow"]);
const MERGE_KEY = "erp_pack_merge_day";

// 정렬 방향. 어느 시각을 기준으로 세는지는 탭마다 다르다 —
// 큐(긴급·당일·익일·예약)와 보관은 주문 등록 시각, 완료는 포장한 시각, 보류는 넣은 시각.
// 탭마다 다른 이름을 붙이지 않는 이유는, 어느 탭에서든 사람이 묻는 게 하나뿐이라서다:
// "오래된 것부터 볼까, 새것부터 볼까."
const SORT_KEY = "erp_pack_sort";

// 스캔 모드. 켜면 탭을 열 때·확인창이 닫힐 때 스캔칸이 커서를 잡는다(HID 스캐너는 커서가 있는 곳에 친다).
// 기본은 꺼짐 — 스캐너가 없는 태블릿에서 커서가 저절로 가면 화면 키보드가 올라와 목록을 가린다.
// 스캐너를 페어링한 태블릿에서만 켜고, 그 기기에 기억한다.
const SCAN_KEY = "erp_pack_scan_mode";
const SORT_VIEWS = [
  { k: "old", label: "과거순", emoji: "🕒", hint: "오래된 것부터 — 새로 들어온 건이 맨 아래에 붙어, 훑던 자리가 밀리지 않습니다" },
  { k: "new", label: "최신순", emoji: "🆕", hint: "새것부터 — 방금 들어온 건을 맨 위에서 봅니다" },
];

// 출고를 막아야 하는 결제 상태. calcOrderMoney 가 내는 값 기준.
// (입금완료·부분환불은 통과 — 부분환불은 결제 후 금액 조정일 뿐이다)
const BLOCKING_PAY = new Set(["미입금", "부분입금", "환불신청"]);

/** 미출고 주문을 '박스' 단위로 묶는다 — 합배송 그룹 1개 = 작업 1개. */
function buildUnits(orders) {
  const active = orders.filter(o =>
    o.status !== "출고완료" && o.payment !== "환불" && (o._computed?.paymentStatus !== "환불완료"));
  const byGroup = new Map();
  const units = [];
  for (const o of active) {
    // splitShipping 은 같은 그룹이어도 따로 나가는 건이라 별도 작업으로 둔다.
    if (!o.mergeGroupId || o.splitShipping) { units.push({ key: `o:${o.id}`, orders: [o], merged: false }); continue; }
    let u = byGroup.get(o.mergeGroupId);
    if (!u) { u = { key: `g:${o.mergeGroupId}`, orders: [], merged: true }; byGroup.set(o.mergeGroupId, u); units.push(u); }
    u.orders.push(o);
  }
  return units;
}

/** 작업 1건의 상태 요약 — 탭 배치, 막힘 사유, 완료 여부. */
function summarize(unit, today) {
  const os = unit.orders;
  // 그룹은 가장 급한 건에 맞춘다 — 긴급 1건 + 익일 1건이 묶이면 둘 다 긴급으로 나가야 한다.
  const buckets = os.map(o => shipBucket(o, today));
  let bucket = buckets.includes("urgent") ? "urgent"
    : buckets.includes("today") ? "today"
    : buckets.includes("tomorrow") ? "tomorrow" : "later";

  // 돈이 덜 들어온 건만 막는다. '부분환불'은 결제가 끝난 뒤 금액이 조정된 것이라
  // 출고를 막을 이유가 없다(막으면 정상 주문이 대기 서랍에 갇힌다).
  const blocked = [];
  const unpaid = os.filter(o => BLOCKING_PAY.has(getPayStatus(o)));
  if (unpaid.length) blocked.push(unpaid.length === os.length ? getPayStatus(unpaid[0]) : "미입금");
  // 보관은 두 단계다. 셀러가 '보관해 주세요'(is_holding)를 누르면 포장직원 할 일이 되고,
  // 실제로 보관 장소에 넣고 나서야(held_at) 보관 탭으로 빠진다.
  // 두 단계를 안 가르면 셀러가 누르는 순간 화면에서 사라져, 지시가 전달되지 않는다.
  const held = os.some(isHold);
  const heldDone = held && os.some(o => isHold(o) && o.heldAt);
  const holdPending = held && !heldDone;

  // 출고요청 — 셀러가 "보관분을 이제 내보내라"고 넘긴 건. 보관은 이미 풀려 있고,
  // 이 카드의 원단은 작업대가 아니라 창고 선반에 있다. 그 사실을 배지로 알린다.
  const shipRequested = !held && os.some(o => o.shipRequestedAt);
  const shipRequestedBy = os.map(o => (o.shipRequestedBy || "").trim()).filter(Boolean)[0] || "";

  // 보류는 카드 단위로 넣고 뺀다 — 합배송 한 박스의 일부만 얼려둘 방법이 없다.
  // 사유·넣은 시각은 가장 먼저 넣은 건 것을 대표로 쓴다(전부 같은 값이 들어간다).
  const parked = os.some(isParked);
  const parkedOs = os.filter(isParked);
  const parkedAt = parkedOs.reduce((mn, o) => {
    const t = o.parkedAt || "";
    return !mn || (t && t < mn) ? t : mn;
  }, "");
  const parkReason = parkedOs.map(o => (o.parkReason || "").trim()).filter(Boolean)[0] || "";

  // 원단 미도착 표시 — 시각은 가장 먼저 건 것 기준(제일 오래 기다린 시간이 이 카드의 시간이다).
  const fabricMissing = os.some(isFabricMissing);
  const fabricCalledAt = os.filter(isFabricMissing).reduce((mn, o) => {
    const t = o.fabricMissingAt || "";
    return !mn || (t && t < mn) ? t : mn;
  }, "");

  const packed = os.filter(o => o.status === "포장완료");
  const allPacked = packed.length === os.length;
  // 박스를 다시 열어야 하는 두 가지 —
  //  (1) 합배송 그룹에 새 주문이 붙어 일부만 포장된 상태
  //  (2) 포장한 뒤 품목·수량이 바뀐 상태. 지문(packedSig)이 지금 품목과 다르면 어긋난 것이다.
  //      지문이 없는 옛 주문은 판단하지 않는다 — 언제 포장했는지 모르는 걸 수정됐다고 할 수 없다.
  const mergeRepack = unit.merged && packed.length > 0 && !allPacked;
  const editedAfterPack = packed.some(o => o.packedSig && o.packedSig !== db.itemsSig(o.items));
  const needsRepack = mergeRepack || editedAfterPack;

  // 출고예정일이 지났는데 아직 못 싼 건 — 당일 칸에 그대로 남지만(사라지면 안 되므로)
  // 오늘 것과 섞이면 구분이 안 되므로 며칠 밀렸는지 센다.
  const shipDates = os.map(o => o.shipDate).filter(Boolean).sort();
  const earliest = shipDates[0] || null;
  const t = ymd(today);
  // 보관·보류는 일부러 잡아둔 것이라 '밀렸다'고 세지 않는다. 보류를 빼지 않으면
  // 몇 달 묵은 건이 전부 "🔺 90일 지남"으로 긴급 탭에 쏟아진다.
  //
  // 출고요청도 같다. 보관 건의 출고예정일은 몇 달 전인 채로 남아 있는데(요청이
  // 날짜를 덮지 않는다 — 취소하면 제자리로 돌려야 하므로), 그대로 세면 꺼내라는
  // 지시가 전부 "🔺 90일 지남"을 달고 긴급 탭에 떨어진다. 요청한 그날이 이 건의
  // 출발점이므로 오늘 것으로 본다.
  const overdueDays = (!held && !parked && !shipRequested && earliest && earliest < t)
    ? Math.round((parseYmd(t) - parseYmd(earliest)) / 86400000)
    : 0;
  // 하루라도 밀리면 긴급으로 올린다 — 당일 칸에 두면 오늘 물량에 묻힌다.
  if (overdueDays >= 1) bucket = "urgent";
  // 출고요청은 당일 칸에 놓는다. 예약·익일 칸에 떨어지면 오늘 꺼내라고 한 지시가
  // 내일 이후로 밀려, 셀러는 요청했는데 포장팀은 못 보는 상태가 된다.
  if (shipRequested) bucket = "today";
  const sellerUrgent = os.some(o => o.isUrgent);
  // 보류함에서 며칠째인가 — 잊힌 채 썩는 걸 막는 유일한 표시다.
  const parkedDays = parkedAt
    ? Math.max(0, Math.round((parseYmd(t) - parseYmd(ymd(new Date(parkedAt)))) / 86400000))
    : 0;

  return { bucket, blocked, held, heldDone, holdPending, allPacked, needsRepack, mergeRepack, editedAfterPack,
    parked, parkedAt, parkReason, parkedDays,
    shipRequested, shipRequestedBy,
    fabricMissing, fabricCalledAt,
    // 정렬용 날짜 — 출고예정일이 없는 옛 주문은 '오늘'로 본다.
    // shipBucket 이 NULL 을 당일 칸에 넣는 이유가 "이미 밀린 건이라 숨으면 안 된다"인데,
    // 정렬에서 NULL 을 '제일 늦은 날짜'로 취급하면 바로 그 건들이 당일 탭 맨 아래에
    // 깔린다 — 넣어둔 의도와 정확히 반대다. 오늘 것과 같은 줄에 세우고 등록순으로 가른다.
    sortDate: earliest || t,
    shipDate: earliest, overdueDays, sellerUrgent, payBlocked: unpaid.length > 0,
    // 완료 탭 정렬용 — 그룹은 마지막으로 싼 시각 기준
    packedAt: os.reduce((mx, o) => ((o.packedAt || "") > mx ? o.packedAt : mx), "") };
}

/** 그룹이 처음 등록된 시각 — 합배송이면 가장 먼저 들어온 주문 기준. */
const registeredAt = (row) => row.orders.reduce((mn, o) => {
  const t = o.createdAt || "";
  return !mn || (t && t < mn) ? t : mn;
}, "");

// 출고예정일 빠른 순 → 같으면 등록 시각 순. dir 이 등록 시각의 방향을 뒤집는다.
//
// 출고예정일 자체는 고르게 두지 않는다. 먼저 나갈 게 위에 있어야 하는 건 취향이 아니라
// 업무 규칙이고, 뒤집으면 오늘 나갈 건이 목록 아래에 깔린다.
// 사람이 고르는 건 '같은 날짜 안에서 오래된 것부터인가, 새것부터인가'다.
//
// 등록 시각은 한 번 정해지면 바뀌지 않는다. 그래서 과거순에서는 새 주문이 언제나
// 맨 아래에 붙고, 포장직원이 훑고 지나간 자리에 카드가 새로 끼어드는 일이 없다.
// 최신순은 그 대가를 치르고 방금 들어온 걸 먼저 보겠다는 선택이다.
const sortRows = (dir) => (a, b) =>
  a.sortDate.localeCompare(b.sortDate) ||
  dir * registeredAt(a).localeCompare(registeredAt(b));

/**
 * 시각 하나로만 줄 세우는 탭(완료·보류)의 정렬.
 * 값이 없는 옛 주문은 방향과 무관하게 맨 뒤로 보낸다 — 빈 문자열을 그냥 비교하면
 * 과거순에서 '언제 처리했는지 모르는 건'들이 목록 맨 위를 차지한다.
 */
const byTime = (get, dir) => (a, b) => {
  const x = get(a) || "", y = get(b) || "";
  if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
  return dir * x.localeCompare(y);
};

// 스캔 거부 배너가 떠 있는 시간(5초, 사용자 요청 2026-10-15). 다음 롤을 찍으면 그 전에 갈린다.
// 화면 맨 위에 고정으로 떴다가 사라진다 — 스캔창 밑에 끼워 넣으면 스크롤이 내려가 있을 때 안 보인다.
const BANNER_MS = 5000;
// 사라지기 전 서서히 옅어지는 시간. 애니메이션 시작 시점 = BANNER_MS - BANNER_FADE_MS.
const BANNER_FADE_MS = 500;
// 라벨 QR 을 찍고 롤 QR 을 기다리는 시간. 지나면 조용히 풀린다 — 다른 조각으로 넘어갔는데 옛 품목이 걸려 있으면
// 다음 롤이 엉뚱한 품목에 기록된다.
const PENDING_MS = 120000;

// 짧은 경고음 — 롤이 이 주문 것이 아닐 때. 화면만 빨개지면 박스를 보느라 고개를 숙인
// 사람은 못 본다. 소리가 안 나는 환경(권한·오래된 브라우저)이면 조용히 넘어간다.
// kind: "error"(기본, 낮고 거친 소리 — 거부) · "ask"(높은 두 음 — 롤 QR 을 이어서 찍으라는 신호).
// 포장직원은 찍고 나서 화면을 안 볼 때가 많다 — 소리가 다르면 고개를 들지 않고도 다음 동작을 안다.
function beep(kind = "error") {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ac = new AC();
    const osc = ac.createOscillator(), gain = ac.createGain();
    const ask = kind === "ask";
    osc.type = ask ? "sine" : "square"; osc.frequency.value = ask ? 880 : 520;
    gain.gain.value = 0.12;
    osc.connect(gain); gain.connect(ac.destination);
    osc.start();
    if (ask) osc.frequency.setValueAtTime(1175, ac.currentTime + 0.12);
    osc.stop(ac.currentTime + (ask ? 0.24 : 0.3));
    osc.onended = () => { try { ac.close(); } catch { /* 이미 닫힘 */ } };
  } catch { /* 소리는 보조 수단이다 — 실패해도 배너가 있다 */ }
}

// packingByOrder: Map<orderId, Map<itemId, 포장 기록>> — 롤을 찍어 품목을 포장한 기록(order_item_packing).
// rolls·products: 찍은 코드를 롤로, 롤을 품번으로 바꾸는 데 쓴다.
// packingReady: 포장 기록 테이블이 있는가. 마이그레이션 전 DB 에서는 false — 그때는
//   스캔 칸과 게이트를 감추고 옛 방식대로 돈다(코드가 먼저 배포되어도 포장이 막히지 않게).
function PackingTab({ orders, customers, reloadOrders, showToast, activeManager, onOpenImage, syncLost = false, onHandover,
  packingByOrder = null, rolls = [], products = [], reloadPacking, packingReady = true }) {
  const T = useTheme();
  const [view, setView] = useState("today");
  // 포장 PC는 하루 종일 켜둔 채로 쓴다 — 매일 아침 다시 누르게 하면 안 된다.
  const [mergeDays, setMergeDays] = useState(() => {
    try { return localStorage.getItem(MERGE_KEY) === "1"; } catch { return false; }
  });
  // 기본은 과거순 — 지금까지의 순서다. 바꾸면 저장해서 다음에도 그대로 연다.
  const [sortDir, setSortDir] = useState(() => {
    try { return localStorage.getItem(SORT_KEY) === "new" ? "new" : "old"; } catch { return "old"; }
  });
  // 스캔 모드 — 기본 켜짐(2026-10-08 사용자 결정: 긴급·당일·익일·예약 탭에서는 스캔이 상시 살아 있어야 한다).
  // 10-01 에는 기본 꺼짐이었다(스캐너 없는 태블릿에서 화면 키보드가 올라와서). 끄고 싶은 기기는 버튼으로 끄고,
  // 그 기기만 기억한다(SCAN_KEY). 저장값이 없으면 켜짐.
  const [scanMode, setScanMode] = useState(() => {
    try { return localStorage.getItem(SCAN_KEY) !== "0"; } catch { return true; }
  });
  const scanModeRef = useRef(scanMode);
  scanModeRef.current = scanMode;
  const [busy, setBusy] = useState(null);
  const [search, setSearch] = useState("");
  // 보류 사유를 적는 중인 카드. 텍스트는 state 로 들고 있지 않고 ref 로 읽는다 —
  // OrderCard 가 렌더마다 새로 만들어지는 내부 컴포넌트라, 한 글자 칠 때마다
  // 부모가 리렌더되면 입력칸이 통째로 다시 mount 되어 포커스가 날아간다.
  const [parking, setParking] = useState(null);
  const parkRef = useRef(null);
  // 자정을 넘기면 익일 주문이 저절로 당일 칸으로 올라와야 한다.
  // 칸은 오늘 날짜로 계산하지만, rows 를 units 에만 의존해 memo 하면 날짜가 바뀌어도
  // 주문에 변화가 없는 한 다시 계산되지 않는다(밤새 켜 둔 화면이 어제 배치로 남는다).
  // 1분마다 날짜만 확인하고, 실제로 넘어간 날에만 상태를 바꿔 불필요한 리렌더를 막는다.
  const [todayStr, setTodayStr] = useState(todayYmd);
  // 원단 호출은 '몇 분째'로 세므로 분 단위로 다시 그려야 한다. 날짜 확인과 같은 타이머에 얹는다.
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setTodayStr(p => { const n = todayYmd(); return p === n ? p : n; });
      setNowTs(Date.now());
    }, 30000);
    return () => clearInterval(id);
  }, []);
  const today = useMemo(() => parseYmd(todayStr) || new Date(), [todayStr]);
  // 익일 구분선에 적을 날짜. 자정을 넘기면 today 가 바뀌면서 같이 따라간다.
  const tomorrowLabel = useMemo(() => {
    const d = addDays(today, 1);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }, [today]);

  // 닉네임은 고객 레코드에만 있고 주문에는 없다 — 이름+전화로 찾아온다.
  // 전화가 같은 다른 사람(가족·공방 대표번호)이 있으므로, 번호만으로 맞히는 건
  // 그 번호를 쓰는 고객이 한 명뿐일 때로 제한한다. 틀린 닉네임은 안 쓰느니만 못하다.
  const nickOf = useMemo(() => {
    const dg = s => String(s || "").replace(/\D/g, "");
    const sq = s => String(s || "").replace(/\s+/g, "").toLowerCase();
    const exact = new Map(), byPhone = new Map(), phoneCount = new Map();
    for (const c of customers || []) {
      const n = sq(c.name), p = dg(c.phone);
      if (p) phoneCount.set(p, (phoneCount.get(p) || 0) + 1);
      if (!c.nickname) continue;
      if (n && p) exact.set(`${n}|${p}`, c.nickname);
      if (p && !byPhone.has(p)) byPhone.set(p, c.nickname);
    }
    return (o) => {
      const n = sq(o.customer), p = dg(o.phone);
      return exact.get(`${n}|${p}`) || (p && phoneCount.get(p) === 1 ? byPhone.get(p) : "") || "";
    };
  }, [customers]);

  const units = useMemo(() => buildUnits(orders), [orders]);
  // scanTotal·scanDone — 이 박스에서 찍어야 할 품목 수와 찍은 수(포장완료 게이트).
  const rows = useMemo(
    () => units.map(u => ({ ...u, ...summarize(u, today), ...scanStats(u.orders, packingByOrder) })),
    [units, today, packingByOrder]);
  const productById = useMemo(() => new Map((products || []).map(p => [p.id, p])), [products]);
  const rollById = useMemo(() => new Map((rolls || []).map(r => [r.id, r])), [rolls]);
  // 택배사 — 박스를 어느 쪽에 쌓을지. 박스(합배송 묶음) 단위로 판정한다.
  const courierById = useMemo(() => courierMap(orders), [orders]);

  // 다 쌌더라도 포장 후 품목이 바뀐 건은 완료가 아니다 — 박스를 다시 열어야 한다.
  // 보관·보류까지 끝난 건은 싼 것도 안 싼 것도 전부 각자 탭으로 빠진다(아래 groups).
  // 보관 요청만 들어온 건은 아직 할 일이 남았으므로 완료로 치지 않는다.
  const allDone = rows.filter(r => r.allPacked && !r.needsRepack && !r.held && !r.parked);
  const allPending = rows.filter(r => (!r.allPacked || r.needsRepack) || r.held || r.parked);
  // 재포장 경고는 검색과 무관하게 전체 기준 — 검색 중이라고 경고가 사라지면 안 된다.
  // 보류 건은 뺀다. 몇 달 뒤에나 열 박스라 지금 다시 싸라고 재촉할 이유가 없다.
  const repack = allPending.filter(r => r.needsRepack && !r.parked);

  // 검색 — 고객이 전화로 물어보거나 박스를 다시 찾아야 할 때 쓴다.
  // 이름·닉네임·전화·원단·품번·주소·메모까지 한 칸에서 찾는다.
  const q = search.trim().toLowerCase();
  const matchRow = useMemo(() => {
    const dg = s => String(s || "").replace(/\D/g, "");
    const qd = dg(q);
    return (row) => {
      if (!q) return true;
      const nick = nickOf(row.orders[0]);
      if (nick && nick.toLowerCase().includes(q)) return true;
      return row.orders.some(o => {
        const hay = [o.customer, o.address, o.addressDetail, o.deliveryMessage, o.memo, o.note,
          ...(o.items || []).flatMap(it => [it.fabric, it.color, it.itemNo])]
          .filter(Boolean).join(" ").toLowerCase();
        if (hay.includes(q)) return true;
        return !!(qd.length >= 3 && o.phone && dg(o.phone).includes(qd));
      });
    };
  }, [q, nickOf]);
  const done = q ? allDone.filter(matchRow) : allDone;
  const pending = q ? allPending.filter(matchRow) : allPending;

  // 정렬 방향 — 과거순 +1, 최신순 -1.
  const dir = sortDir === "new" ? -1 : 1;

  // 탭별 목록 — 재포장 건은 어느 탭에 있든 긴급으로 끌어올린다(박스를 다시 열어야 하므로).
  const groups = useMemo(() => {
    const g = {};
    for (const v of VIEWS) g[v.k] = { ready: [], blocked: [] };
    for (const r of pending) {
      // 미입금은 목록에 그대로 둔다 — 접어 두면 있는 줄도 모르고, 포장 자체는
      // 결제와 무관하게 할 수 있다(막는 건 출고 단계).
      // 보관 '중'인 것만 따로 뺀다. 보관 '요청'은 아직 원단이 작업대에 있으므로
      // 출고 큐에 그대로 남아야 포장직원이 처리한다.
      // 재포장은 보관보다 급하다 — 박스가 이미 어긋나 있다.
      // 보류는 그보다 앞선다. 나갈 수 없는 건이라 급한지 따질 단계가 아니다.
      g[r.parked ? "parked" : r.needsRepack ? "urgent" : r.heldDone ? "hold" : r.bucket].ready.push(r);
    }
    const byRow = sortRows(dir);
    for (const v of VIEWS) g[v.k].ready.sort(byRow);
    // 재포장은 정렬과 무관하게 긴급 탭 맨 위로 — 박스가 이미 어긋나 있는 건이라
    // 어떤 순서로 보든 먼저 처리해야 한다.
    g.urgent.ready.sort((a, b) => (b.needsRepack ? 1 : 0) - (a.needsRepack ? 1 : 0));
    // 보류는 넣은 시각으로 센다 — 출고예정일 순으로 두면 넣은 지 반년 된 건이
    // 아래에 깔려 영영 안 보인다. 과거순이면 오래 묵은 것부터(서랍은 위에서부터 썩는다).
    g.parked.ready.sort(byTime(r => r.parkedAt, dir));
    // 완료 탭은 포장한 시각으로 센다. 최신순이면 방금 싼 박스부터 —
    // 되돌릴 일이 생기는 건 대개 직전에 싼 박스다.
    g.done = { ready: [...done].sort(byTime(r => r.packedAt, dir)), blocked: [] };
    return g;
  }, [pending, done, dir]);

  // 묶기는 당일·익일 칸에서만 걸린다. 긴급·예약·완료 탭까지 따라붙으면
  // 그 탭들이 무엇을 보여주는 칸인지 흐려진다.
  const dayMerged = mergeDays && DAY_PAIR.has(view);
  // 이어 붙인 목록에서 익일이 시작하는 자리. 정렬이 출고예정일 순(sortRows)이라
  // 당일이 앞, 익일이 뒤로 자연히 갈리므로 경계는 당일 건수 하나로 정해진다.
  const daySplit = dayMerged ? (groups.today?.ready.length || 0) : -1;
  const cur = dayMerged
    ? { ready: [...(groups.today?.ready || []), ...(groups.tomorrow?.ready || [])], blocked: [] }
    : (groups[view] || { ready: [], blocked: [] });
  const overdueCount = (groups.urgent?.ready || []).filter(r => r.overdueDays > 0).length;

  // 검색어는 맞는데 지금 탭에 없을 때 — 어느 탭에 있는지 알려주고 바로 넘어가게 한다.
  // 묶여 있으면 당일·익일 둘 다 지금 보고 있는 것이라 '다른 탭'에서 뺀다.
  const shownKeys = dayMerged ? DAY_PAIR : new Set([view]);
  const otherHits = q ? VIEWS.filter(v => !shownKeys.has(v.k) && (groups[v.k]?.ready.length || 0) > 0) : [];
  // 완료 칸(HandoverPanel)에 넘길 박스 — 검색을 거르고 포장한 시각으로 줄 세운다.
  // 싼 박스만이 아니라 전부 넘긴다: 송장은 나왔는데 아직 안 싼 박스도 그 화면에서 보여야 한다.
  const handRows = useMemo(
    () => (q ? rows.filter(matchRow) : rows).slice().sort(byTime(r => r.packedAt, dir)),
    [rows, q, matchRow, dir]);

  // ── 재포장 경고의 위치 ───────────────────────────────────
  // 카드를 훑느라 아래로 내려가 있으면 구역 탭이 헤더 뒤로 숨어 경고를 놓친다.
  // 그래서 탭이 안 보이는 동안에만 상단에 경고를 띄우고, 탭이 다시 보이면
  // 배너를 걷고 긴급 탭 자체를 깜빡인다 — 경고는 항상 화면에 하나만 있게.
  const tabsRef = useRef(null);
  const [tabsSeen, setTabsSeen] = useState(true);
  // ERP 상단 바들이 sticky라 그 아래에 띄워야 가려지지 않는다. 본문은 화면 전체가 아니라
  // 가운데 정렬된 열(1279px 화면에서 250~1030)이므로 가로 위치·너비도 상단 바에서 그대로 가져온다.
  // 픽셀을 박으면 화면 폭이 바뀔 때 어긋난다.
  const [anchor, setAnchor] = useState(null);
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      // 원단 호출 배너가 떠 있으면 그 아래에 붙는다 — 둘 다 탭 바 밑을 노리므로
      // .erp-tabs 만 보면 재포장 경고가 원단 호출을 덮어 하나가 사라진다.
      const bar = document.querySelector(".erp-fabric-bar") || document.querySelector(".erp-tabs");
      if (!bar) { setAnchor(null); return; }
      const r = bar.getBoundingClientRect();   // 화면 좌표(zoom 반영된 실측값)
      // .erp-root 에 zoom(글자 크기 설정, 0.80~1.30)이 걸려 있다. 그 안의 fixed 요소는
      // 좌표가 zoom 배로 늘어나 붙으므로, 실측 화면값을 zoom 으로 나눠서 돌려줘야
      // 상단 바와 정확히 겹친다. zoom 이 1이면 그대로다.
      let z = 1;
      for (let p = bar; p && p !== document.documentElement; p = p.parentElement) {
        const v = parseFloat(getComputedStyle(p).zoom);
        if (v && v !== 1) z *= v;
      }
      const rd = n => Math.round(n * 100) / 100;
      const next = { top: rd(r.bottom / z), left: rd(r.left / z), width: rd(r.width / z) };
      setAnchor(p => (p && p.top === next.top && p.left === next.left && p.width === next.width) ? p : next);

      // 구역 탭이 헤더 아래로 얼마나 나와 있는가. IntersectionObserver 는 zoom 걸린
      // 조상 안에서 좌표가 어긋나 늘 '안 보임'으로 나왔다 — 같은 좌표계(실측)로 직접 잰다.
      const el = tabsRef.current;
      if (el) {
        const t = el.getBoundingClientRect();
        const shown = t.bottom - Math.max(t.top, r.bottom);   // 헤더에 가린 부분을 뺀 높이
        setTabsSeen(shown > t.height * 0.4);
      }
    };
    // 스크롤 중에도 다시 잰다 — 마운트 때 한 번만 재면 상단 바가 붙기 전 값이 남아
    // 배너와 헤더 사이가 벌어진다. rAF로 묶어 프레임당 한 번만.
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; measure(); });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  const curDef = VIEWS.find(v => v.k === view) || VIEWS[1];
  const colorOf = c => T[c] || T.copper;

  const toggleMerge = () => {
    const next = !mergeDays;
    setMergeDays(next);
    try { localStorage.setItem(MERGE_KEY, next ? "1" : "0"); } catch { /* 저장만 포기 — 이번 세션은 그대로 동작한다 */ }
    // 보관·예약 탭에서 눌렀으면 묶인 목록으로 데려간다. 그 자리에 머무르면
    // 눌러도 아무 일이 없는 것처럼 보여 고장으로 읽힌다.
    if (next && !DAY_PAIR.has(view)) setView("today");
  };

  const toggleScanMode = () => {
    const next = !scanMode;
    setScanMode(next);
    try { localStorage.setItem(SCAN_KEY, next ? "1" : "0"); } catch { /* 저장만 포기 — 이번 세션은 그대로 동작한다 */ }
  };

  const pickSort = (k) => {
    setSortDir(k);
    try { localStorage.setItem(SORT_KEY, k); } catch { /* 저장만 포기 — 이번 세션은 그대로 동작한다 */ }
  };

  // ── 액션 ─────────────────────────────────────────────────
  const setPacked = async (row, packed) => {
    setBusy(row.key);
    // 합배송은 전부 되거나 전부 안 되거나여야 한다. 중간에 실패해 반만 바뀌면
    // '일부만 포장됨' = 재포장 필요로 잘못 떠서, 멀쩡한 박스를 다시 열게 된다.
    const changed = [];
    try {
      for (const o of row.orders) {
        await db.setOrderPacked(o, packed);
        changed.push(o);
      }
      await reloadOrders();
      showToast?.(packed
        ? `포장완료 — ${row.orders[0].customer}${row.orders.length > 1 ? ` 외 ${row.orders.length - 1}건` : ""}`
        : "포장완료 취소됨");
    } catch (e) {
      // 이미 바뀐 건을 원래 상태로 되돌린다. 되돌리기까지 실패하면 사람이 봐야 하므로
      // 토스트에 그대로 알린다(조용히 넘어가면 반쪽 상태가 그대로 남는다).
      let rollbackFailed = false;
      for (const o of changed) {
        try { await db.updateOrder(o.id, { status: o.status, packedAt: o.packedAt, packedSig: o.packedSig }); }
        catch { rollbackFailed = true; }
      }
      await reloadOrders();
      showToast?.(rollbackFailed
        ? "처리 실패 — 일부 주문이 중간 상태로 남았습니다. 관리자에게 알려주세요"
        : `처리 실패 — 변경 없이 되돌렸습니다. 다시 눌러주세요 (${e.message})`, "error");
    } finally { setBusy(null); }
  };

  // 보관 처리 — 포장직원이 실제로 원단을 보관 장소에 넣었을 때 누른다.
  //  done    : 보관 완료(요청이 있었든, 포장직원이 스스로 넣든 결과는 같다)
  //  release : 보관 해제 — 요청도 완료도 없던 일로
  //
  // 보관 건은 포장 전이다 — 원단만 창고에 넣어두고, 포장은 출고요청이 와서
  // 꺼낸 뒤에 한다. 그래서 주문현황에서는 보관중이면 포장 상태를 못 바꾸게 막았다.
  // 여기(포장탭)에서는 열어둔다. 선반의 박스를 실제로 여는 사람만 되돌릴 수 있다.
  const setHold = async (row, mode) => {
    const done = mode === "done";
    setBusy(row.key);
    try {
      for (const o of row.orders) {
        // 옛 주문은 보관을 status="보관" 으로 갖고 있다 — 해제할 땐 status 도 같이 되돌려야
        // 보관이 완전히 풀린다(안 그러면 isHold 가 계속 true).
        const demote = !done && o.status === "보관";
        await db.updateOrder(o.id, {
          isHolding: done,
          heldAt: done ? new Date().toISOString() : null,
          ...(demote ? { status: "접수" } : {}),
        });
      }
      await reloadOrders();
      showToast?.(done ? `📦 보관 완료 — ${row.orders[0].customer}` : "보관 해제");
    } catch (e) {
      showToast?.("처리 실패: " + e.message, "error");
    } finally { setBusy(null); }
  };

  // 보류 — 나갈 수 없는 건을 출고 큐에서 통째로 뺀다. 포장직원이 카드에서 직접 넣고 뺀다.
  //
  // 사유를 반드시 받는다: 꺼내는 건 몇 달 뒤고, 그때 "이건 왜 여기 있지"에 답할 수 있는 건
  // 넣을 때 적어둔 한 줄뿐이다. 안 적으면 꺼낼 수도 버릴 수도 없는 건이 하나 늘 뿐이다.
  const park = async (row) => {
    const reason = (parkRef.current?.value || "").trim();
    if (!reason) {
      showToast?.("보류 사유를 적어주세요 — 몇 달 뒤 꺼낼 때 이 한 줄이 유일한 단서입니다", "error");
      parkRef.current?.focus();
      return;
    }
    setBusy(row.key);
    // 합배송 건이 서로 다른 시각으로 들어가면 '며칠째'가 건마다 달라진다 — 한 번만 찍는다.
    const at = new Date().toISOString();
    try {
      for (const o of row.orders) {
        await db.updateOrder(o.id, { isParked: true, parkedAt: at, parkReason: reason });
      }
      await reloadOrders();
      setParking(null);
      showToast?.(`🗄️ 보류함으로 — ${row.orders[0].customer}`);
    } catch (e) {
      showToast?.("처리 실패: " + e.message, "error");
    } finally { setBusy(null); }
  };

  // 보류 해제 — 출고예정일을 오늘로 다시 맞춘다.
  // 안 맞추면 반년 묵은 예정일 그대로 큐에 돌아와 "🔺 180일 지남"을 달고 긴급 탭에
  // 떨어진다. 꺼낸 순간이 이 주문의 실질적인 출발점이므로 거기서 다시 센다.
  const unpark = async (row) => {
    setBusy(row.key);
    try {
      for (const o of row.orders) {
        await db.updateOrder(o.id, {
          isParked: false, parkedAt: null, parkReason: null,
          shipDate: todayStr, shipDatePulled: true,
        });
      }
      await reloadOrders();
      showToast?.(`보류 해제 — ${row.orders[0].customer} · 출고예정일을 오늘로 맞췄습니다`);
    } catch (e) {
      showToast?.("처리 실패: " + e.message, "error");
    } finally { setBusy(null); }
  };

  // 원단 호출 토글 — 품목 한 줄에 하나씩 붙는다.
  //
  // 왜 주문이 아니라 품목 단위인가: 한 주문에 원단이 셋인데 하나만 안 오는 경우가 있다.
  // 주문째로 부르면 이미 와 있는 두 개까지 "안 왔다"가 되어, 셀러는 뭘 가져와야 하는지
  // 모른 채 창고를 다 뒤진다. 합배송이면 건마다 담당자가 달라 더 심해진다.
  const toggleFabric = async (row, order, itemIdx) => {
    const on = missingItemIdx(order).includes(itemIdx);
    setBusy(row.key);
    try {
      if (on) await db.clearFabricItem(order, itemIdx);
      else await db.callForFabric(order, itemIdx);
      await reloadOrders();
      const it = (order.items || [])[itemIdx];
      const name = it ? `${it.fabric}${it.color ? ` ${it.color}` : ""}` : "원단";
      // 부를 사람은 원단 주인(품번 담당자)이다 — 주문 담당자가 남의 원단을 판 경우 주문 담당자에겐 원단이 없다. 품번을 모르면 주문 담당자.
      const who = productOfItem(it, productById)?.manager || order.manager || "담당자 없음";
      showToast?.(on ? `원단 받음 — ${name}` : `🧶 원단 호출 — ${name} · ${who}님`);
    } catch (e) {
      showToast?.("처리 실패: " + e.message, "error");
    } finally { setBusy(null); }
  };

  // ── 롤 스캔 ──────────────────────────────────────────────
  // 포장직원이 롤 QR 을 찍으면(HID 스캐너 = 키보드 입력 + Enter) 그 롤의 품번을 기다리는
  // 주문 품목을 찾아 확인창을 띄운다. 판정 규칙은 lib/packing.js 에 있다.
  const scanRef = useRef(null);
  const [scanVal, setScanVal] = useState("");
  const [scanFocused, setScanFocused] = useState(false);
  // 활성 박스 — 카드를 누르면 스캔이 그 박스에만 적용된다. 없으면 화면의 모든 박스에서 찾는다.
  const [activeKey, setActiveKey] = useState(null);
  const activeRow = useMemo(() => (activeKey ? rows.find(r => r.key === activeKey) || null : null), [rows, activeKey]);
  // 거부 배너 — { message, hint }. 다음 스캔이나 3초 뒤에 사라진다.
  const [banner, setBanner] = useState(null);
  const bannerTimer = useRef(0);
  // 스캔 뒤 열리는 창 — confirm(길이 확인) · choose(품목 고르기) · override(롤 없이 포장 사유)
  const [scanModal, setScanModal] = useState(null);
  const [cutLen, setCutLen] = useState("");
  const [whole, setWhole] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [unpackReason, setUnpackReason] = useState("");   // 재단 후 취소 사유(조각 롤에 남는다)
  // ERP 자체 화면 키보드(2026-10-15, ScreenKeyboard.jsx) — 적는 칸 옆 ⌨ 버튼으로 연다. { field, mode?, title?, presets? }
  // 아이패드에 스캐너가 붙어 있으면 화면 키보드가 안 올라와서 둔다. 입력칸에 커서를 주지 않고 값만 오간다.
  const [kbd, setKbd] = useState(null);
  const [parkMirror, setParkMirror] = useState("");   // 보류 사유 칸은 ref(비제어)라 키보드 미리보기용 거울

  // 스캔으로 기록한 박스로 화면을 옮긴다(2026-10-02 요청). 포장완료되면 그 박스는 완료 탭으로 가므로
  // 탭을 바꾸고, 카드를 화면 가운데로 끌어와 잠깐 초록 테두리로 표시한다.
  //   다 안 찍은 박스 → 그 박스를 활성 박스로 — 다음 롤은 이 박스에 들어간다
  //   포장완료된 박스 → 활성 해제 — 다음 스캔은 출고 대기 탭 전체에서 찾는다
  const [focusReq, setFocusReq] = useState(null);   // { key, at }
  const [flashKey, setFlashKey] = useState(null);
  const flashTimer = useRef(0);
  // 방금 기록한 박스를 활성으로 두고 카드로 스크롤한다. 마지막 품목을 찍어도 박스는 이 탭에 남는다 —
  // 포장완료는 사람이 버튼으로 확정한다(2026-10-15 사용자 결정, afterItemPacked).
  // activate=false 면 보기만 한다(활성 박스로 잡지 않는다) — 이미 포장된 라벨을 찍어 그 주문을 보여줄 때.
  // 완료·보관 탭의 박스를 활성으로 잡으면 다음 롤 스캔이 그 박스에서 품목을 찾다 엉뚱하게 거부된다.
  const revealRow = (key, { activate = true } = {}) => {
    if (!key) return;
    if (activate) setActiveKey(key);
    setFocusReq({ key, at: Date.now() });
  };
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // 이동 요청 처리 — 박스가 어느 탭에 있는지 찾아 탭을 바꾸고, 그려진 뒤 카드로 스크롤한다.
  // 목록을 다시 읽는 중이라 아직 못 찾으면 다음 갱신을 기다린다(5초 지나면 포기 — 엉뚱한 때 화면이 튀지 않게).
  useEffect(() => {
    if (!focusReq) return;
    if (Date.now() - focusReq.at > 5000) { setFocusReq(null); return; }
    const where = VIEWS.find(v => (groups[v.k]?.ready || []).some(r => r.key === focusReq.key));
    if (!where) return;
    const shown = dayMerged ? DAY_PAIR.has(where.k) : view === where.k;
    if (!shown) { setView(where.k); return; }
    // 검색어 때문에 안 보이면 검색을 지운다 — 방금 찍은 박스가 화면에 없는 게 더 헷갈린다.
    const el = document.getElementById(`pk-${focusReq.key}`);
    if (!el) { if (search) setSearch(""); return; }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashKey(focusReq.key);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => { flashTimer.current = 0; setFlashKey(null); }, 2500);
    setFocusReq(null);
  }, [focusReq, groups, view, dayMerged, search]);
  const [scanBusy, setScanBusy] = useState(false);

  // ── 라벨 QR 뒤 롤을 기다리는 품목 (2026-10-08) ──
  // 주문 라벨 QR 을 찍으면 품목은 바로 정해진다. 그 품번에 진행 중인 롤이 하나면 거기서 바로 빠지고,
  // 둘 이상(또는 없음)이면 어느 롤을 잘랐는지 모르니 품목을 여기 걸어 두고 다음 롤 QR 을 기다린다.
  // 다음 라벨을 찍거나, 취소하거나, PENDING_MS 가 지나면 풀린다. 규칙은 lib/packing.js 주문 라벨 QR 절.
  const [waitRoll, setWaitRoll] = useState(null);   // { candidate, product, rolls, at }
  const pendingTimer = useRef(0);
  const clearPending = () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = 0;
    setWaitRoll(null);
  };
  const keepPending = (p) => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    setWaitRoll(p);
    pendingTimer.current = setTimeout(() => { pendingTimer.current = 0; setWaitRoll(null); }, PENDING_MS);
  };
  useEffect(() => () => { if (pendingTimer.current) clearTimeout(pendingTimer.current); }, []);

  // 스캔칸에 커서를 둔다. 저절로 가는 건(탭 열림·확인창 닫힘·처리 끝) 스캔 모드일 때만 —
  // 꺼져 있으면 화면 키보드가 올라오면 안 된다. 사람이 칸이나 표시를 눌렀을 때는 force 로 간다.
  const focusScan = (force = false) => {
    if (!force && !scanModeRef.current) return;
    // preventScroll — 커서만 주고 화면은 그 자리에 둔다. 없으면 브라우저가 스캔칸(맨 위)이 보이게 화면을 올려서,
    // 포장 취소 뒤나 스캔할 때마다 위로 튀었다가 카드로 내려왔다(사용자 2026-10-08).
    try { scanRef.current?.focus({ preventScroll: true }); } catch { /* 없는 순간이면 그만 */ }
  };
  // 탭이 열리거나 스캔 모드를 켜면 스캔 칸에 커서를 둔다 — 스캐너는 커서가 있는 곳에 친다.
  useEffect(() => { if (packingReady && scanMode) focusScan(); }, [packingReady, scanMode]);
  // 출고 대기 탭(긴급·당일·익일·예약)에서는 스캔칸이 상시 커서를 쥔다(사용자 2026-10-08).
  //   · 탭을 바꾸면 바로 스캔칸으로
  //   · 카드·빈 곳을 눌러 커서를 잃어도 돌아온다(글자를 치는 칸·버튼을 누른 건 빼고 — 검색·메모를 못 치면 안 된다)
  //   · 다른 앱에 갔다 돌아와도(창 포커스·화면 복귀) 돌아온다
  // 완료·보관·보류 탭에서는 안 한다 — 거긴 찍을 박스가 없다.
  const inQueue = dayMerged || QUEUE_VIEWS.some(v => v.k === view);
  useEffect(() => {
    if (!packingReady || !scanMode || !inQueue) return;
    focusScan();
    const typing = (el) => !!el?.closest?.("input, textarea, select, button, a, [contenteditable], [role=dialog]");
    const onClick = (e) => { if (!typing(e.target)) setTimeout(() => focusScan(), 0); };
    const onBack = () => { if (document.visibilityState === "visible") setTimeout(() => focusScan(), 50); };
    document.addEventListener("click", onClick);
    window.addEventListener("focus", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("focus", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [packingReady, scanMode, inQueue, view]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current); }, []);

  // 최근 스캔(2026-10-08) — 스캐너가 실제로 보낸 글자와 판정을 남긴다. "됐다 안 됐다" 할 때 무엇이 들어왔는지 보려고.
  // 화면 아래 '🧾 최근 스캔'으로 편다. 기기 안에서만 산다(저장 안 함).
  const [scanLog, setScanLog] = useState([]);
  const [scanLogOpen, setScanLogOpen] = useState(false);
  const noteScan = (entry) => setScanLog(l => (entry.result !== undefined && entry.raw === undefined
    ? l.map((x, i) => i === 0 ? { ...x, result: entry.result } : x)   // 결과만 — 맨 앞(최근) 항목에
    : [entry, ...l]).slice(0, 10));
  const showBanner = (message, hint = "") => {
    noteScan({ result: `⛔ ${message}` });
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    // id 를 바꿔야 같은 글이 연달아 와도 토스트가 새로 떠서(애니메이션 재시작) "안 찍혔나" 헷갈리지 않는다.
    setBanner({ message, hint, id: Date.now() });
    bannerTimer.current = setTimeout(() => { bannerTimer.current = 0; setBanner(null); }, BANNER_MS);
  };
  const closeScanModal = () => { setScanModal(null); setCutLen(""); setWhole(false); setOverrideReason(""); setUnpackReason(""); setTimeout(focusScan, 0); };

  // 스캔값 하나를 처리한다. 화면이 든 롤 목록(진행 중인 롤)에 없으면 DB 에서 한 번 더
  // 찾는다 — 다 팔린 롤을 찍었을 때 "등록되지 않은 코드"가 아니라 "판매 완료"라고 해야 한다.
  //
  // 찍은 것이 주문 라벨 QR 이면(2026-10-08) 품목이 바로 정해진다 — 같은 원단을 기다리는 박스가 여럿이어도
  // 고르는 창 없이 그 주문의 그 품목에만 기록된다. 롤이 하나면 바로 재단, 둘 이상이면 롤 QR 을 이어서 찍는다.
  // 롤 QR 을 먼저 찍는 옛 흐름은 그대로다(QR 없는 옛 라벨이 섞여 있어도 막히지 않게).
  // ── 키 신호 직접 받기 (2026-10-08) ──
  // 태블릿이 한글 자판 상태면 스캐너(키보드처럼 치는 기기)가 친 글자를 한글 입력기가 조합한다. 그 과정에서
  // 자음(ㄸ·ㅊ 등) 바로 뒤의 숫자가 맨 뒤로 밀리는 일이 있었다 — 같은 라벨이 "E481FC70…84" / "E81FC70…844" /
  // "E481FC04…847" 로 그때그때 다르게 들어왔다(최근 스캔 원문으로 확인). 칸에 찍힌 글자 대신 keydown 의 물리 키
  // (e.code: KeyE·Digit4·Semicolon…)를 모아 읽으면 입력기와 무관하다. 글자가 칸에 안 들어가게 preventDefault.
  // 화면 키보드(e.code 없음)나 붙여넣기는 전처럼 칸의 값으로 간다.
  const keyBuf = useRef({ s: "", at: 0, enterAt: 0, lastCode: "", lastAt: 0, lastIme: false, dup: 0 });
  const charFromKey = (e) => {
    const c = e.code || "";
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit[0-9]$/.test(c)) return e.shiftKey ? ({ 1: "!", 2: "@", 3: "#", 4: "$", 5: "%", 6: "^", 7: "&", 8: "*", 9: "(", 0: ")" })[c.slice(5)] : c.slice(5);
    if (/^Numpad[0-9]$/.test(c)) return c.slice(6);
    const PUNCT = { Semicolon: [";", ":"], Minus: ["-", "_"], Slash: ["/", "?"], Period: [".", ">"], Equal: ["=", "+"], Comma: [",", "<"], Space: [" ", " "], Backslash: ["\\", "|"], Quote: ["'", "\""], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backquote: ["`", "~"] };
    if (PUNCT[c]) return PUNCT[c][e.shiftKey ? 1 : 0];
    return null;
  };
  const onScanKeyDown = (e) => {
    if (e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter") {
      e.preventDefault();
      const b = keyBuf.current; const s = b.s, dup = b.dup; b.s = ""; b.dup = 0; b.lastCode = ""; b.enterAt = Date.now();
      handleScan(s || undefined, s ? (dup ? `키·중복 ${dup} 제거` : "키") : "칸");
      return;
    }
    const ch = charFromKey(e);
    if (ch === null) return;                      // Shift·화살표·화면 키보드(e.code 없음) 등
    const b = keyBuf.current, now = Date.now();
    if (now - b.at > 1500) { b.s = ""; b.dup = 0; } // 사람이 느리게 치다 만 것은 버린다
    // 한글 입력기가 자음을 조합하다가 영문 아닌 키(숫자·':')가 오면 "조합 끝" 신호(keyCode 229)와 진짜 키를
    // 같은 e.code 로 연달아 두 번 알린다 — "OI::E4481FC7704…" 처럼 영문 뒤 글자만 겹쳤다(최근 스캔 원문).
    // 같은 키가 60ms 안에 두 번 오고 그중 하나가 입력기 신호면 한 번만 센다. 스캐너가 진짜로 "44"를 치면 둘 다 진짜 키라 둘 다 센다.
    const ime = e.keyCode === 229 || e.key === "Process" || e.key === "Unidentified" || !!e.nativeEvent?.isComposing;
    const dupOfPrev = b.lastCode === e.code && now - b.lastAt < 60 && (ime || b.lastIme);
    if (dupOfPrev) b.dup++; else b.s += ch;
    b.lastCode = e.code; b.lastAt = now; b.lastIme = ime; b.at = now;
    e.preventDefault();                            // 입력기로 안 보낸다 — 칸은 비어 있어야 한다
  };
  // 화면 키보드의 Enter 는 keydown 이 229 로 와서 위에서 못 잡는다 — keyup 에서 받되 방금 처리한 것은 건너뛴다.
  const onScanKeyUp = (e) => {
    if ((e.key === "Enter" || e.keyCode === 13) && Date.now() - keyBuf.current.enterAt > 300) handleScan(undefined, "칸");
  };

  const handleScan = async (rawOverride, src = "칸") => {
    // 키 신호로 모은 글자가 있으면 그것, 없으면 칸의 실제 값(화면 키보드·붙여넣기). 상태(scanVal)는 IME 확정보다 한 박자 늦다.
    const raw = rawOverride !== undefined ? String(rawOverride) : String(scanRef.current?.value ?? scanVal ?? "");
    const parsed = parseScan(raw);
    setScanVal("");
    if (scanRef.current) scanRef.current.value = "";
    if (!parsed) return;
    noteScan({ at: Date.now(), raw, src, kind: parsed.kind, code: parsed.kind === "item" ? `품목 ${parsed.key.slice(0, 8)}…` : parsed.code, result: "" });
    const shown = parsed.kind === "item" ? "주문 라벨" : parsed.code;
    // 앞의 스캔을 처리하는 중이다 — 조용히 버리면 찍었는데 아무 일도 없는 것처럼 보인다.
    if (scanBusy) { showBanner(`처리 중이라 ${shown} 은(는) 받지 못했습니다 — 잠시 뒤 다시 찍어 주세요`); beep(); return; }
    setScanBusy(true);
    try {
      if (parsed.kind === "item") {
        // 라벨은 박스를 특정하므로 화면에 보이는 박스로 한정하지 않는다(완료·보관·보류는 판정 함수가 거른다).
        const res = resolveItemScan({ key: parsed.key, rows, packingByOrder, products: productById, rolls });
        if (res.kind === "reject") {
          showBanner(res.message, res.hint); beep();
          // 라벨의 주문은 찾았는데 이미 포장·완료·보류·보관이면 그 박스로 화면을 옮긴다(사용자 2026-10-15) —
          // 알림만 뜨면 어느 주문인지 찾기 힘들다. 완료 탭에 있으면 탭도 바뀐다(focusReq 처리).
          if (res.candidate?.row?.key) revealRow(res.candidate.row.key, { activate: false });
          return;
        }
        setBanner(null);
        setActiveKey(res.candidate.row.key);
        if (res.kind === "pack") { clearPending(); openConfirm(res.roll, res.product, res.candidate); return; }
        // 롤이 둘 이상이거나 없다 — 품목을 걸어 두고 롤 QR 을 기다린다. 소리로도 알린다.
        // 그 주문 카드로 화면을 옮기고(사용자 2026-10-08) 그 위에 안내창을 띄운다. 안내창은 커서를 안 가져간다 —
        // 스캐너는 여전히 스캔칸에 친다(focusScan).
        noteScan({ result: res.kind === "pick-roll" ? `롤 ${res.rolls.length}개 — 롤 QR 기다림` : "진행 중인 롤 없음 — 롤 QR 기다림" });
        revealRow(res.candidate.row.key);
        keepPending({ candidate: res.candidate, product: res.product, rolls: res.kind === "pick-roll" ? res.rolls : [], at: Date.now() });
        beep("ask");
        setTimeout(() => focusScan(), 0);
        return;
      }
      const v = parsed.code;
      let roll = (rolls || []).find(r => r.rollCode === v) || null;
      if (!roll) {
        try { roll = await db.findRollByCode(v); }
        catch (e) { showBanner("롤 조회 실패: " + rollErrorText(e)); beep(); return; }
      }
      if (!roll) { showBanner(`등록되지 않은 롤 코드: ${v}`); beep(); return; }
      const product = productById.get(roll.productId) || null;
      // 라벨 QR 을 먼저 찍어 둔 품목이 있으면 이 롤은 그 품목의 것이다 — 품번만 맞으면 바로 재단.
      if (waitRoll) {
        const res = resolvePendingRoll({ pending: waitRoll, roll, product });
        if (res.kind === "reject") { showBanner(res.message, res.hint); beep(); return; }
        setBanner(null);
        clearPending();
        openConfirm(roll, product, res.candidate);
        return;
      }
      // 완료·보관·보류 탭을 보고 있을 때(방금 싼 박스로 화면이 넘어간 뒤 등)는 출고 대기 탭 전체에서 찾는다 —
      // 그 탭들의 박스는 찍을 대상이 아니다.
      const scanScope = dayMerged || QUEUE_VIEWS.some(v => v.k === view)
        ? cur.ready : QUEUE_VIEWS.flatMap(v => groups[v.k]?.ready || []);
      const res = resolveScan({ roll, product, activeRow, visibleRows: scanScope, allRows: rows, packingByOrder });
      if (res.kind === "reject") { showBanner(res.message, res.hint); beep(); return; }
      setBanner(null);
      if (res.kind === "confirm") openConfirm(roll, product, res.candidate);
      else setScanModal({ type: "choose", roll, product, candidates: res.candidates });
    } finally { setScanBusy(false); }
  };

  // 품목이 정해졌다(후보 하나, 또는 목록에서 고름). 2026-10-02 결정: 재단 확인창 없이 주문 수량대로 바로
  // 기록한다 — 롤·필 단위는 롤 통째. 사람이 숫자를 정해야 할 때(수량 이상, 롤 잔량 부족)만 확인창을 띄운다.
  const openConfirm = (roll, product, candidate) => {
    const plan = autoCutPlan(candidate.item, roll);
    if (plan.auto) { setScanModal(null); packCandidate(roll, candidate, plan.len, plan.whole); return; }
    if (plan.reject) { setScanModal(null); showBanner(plan.reason); noteScan?.({ result: `✗ ${plan.reason}` }); return; }
    showBanner(`확인이 필요합니다 — ${plan.reason}`);
    setCutLen(candidate.item.qty ? String(candidate.item.qty) : "");
    setWhole(isRollUnit(candidate.item.unit));
    setScanModal({ type: "confirm", roll, product, candidate });
  };

  // 포장 기록이 하나 생긴 뒤 — 박스의 모든 품목에 기록이 있으면 "다 찍었다"고만 알린다.
  // 10-08 까지는 여기서 저절로 포장완료(setPacked)했는데, 박스가 바로 완료 탭으로 가 버려 포장직원이
  // 확인할 틈이 없었다. 이제 포장완료는 사람이 버튼을 눌러 확정한다(2026-10-15 사용자 결정).
  const afterItemPacked = (row, order, item) =>
    !!row && allItemsPacked(row, packingByOrder, [{ orderId: order.id, itemId: item.itemId }]);
  const ALL_DONE_HINT = "모두 찍었습니다 — 📦 포장완료 버튼을 눌러 확정하세요";

  // RPC(잔량 차감 + 포장 기록, 한 트랜잭션). 원단 호출이 걸려 있던 품목이면 푼다 —
  // 롤을 찍었다는 건 원단이 왔다는 뜻이다.
  const packCandidate = async (roll, candidate, len, whole) => {
    const { row, order, item, itemIdx } = candidate;
    setScanBusy(true);
    try {
      const rec = await db.packItemFromRoll(order.id, item.itemId, roll.id, len, whole, activeManager);
      if (missingItemIdx(order).includes(itemIdx)) {
        try { await db.clearFabricItem(order, itemIdx); await reloadOrders(); }
        catch (e) { console.warn("[스캔] 원단 호출 해제 실패", e); }
      }
      const name = `${item.fabric || ""}${item.color ? ` ${item.color}` : ""}`.trim() || "품목";
      const msg = `✅ ${order.customer} · ${name} ${fmtLen(rec.length)}${item.unit || "마"} — ${roll.rollCode}${whole ? " (롤 통째)" : ""}`;
      noteScan({ result: msg });
      await reloadPacking?.();
      closeScanModal();
      clearPending();
      const allDone = afterItemPacked(row, order, item);
      showToast?.(allDone ? `${msg} · ${ALL_DONE_HINT}` : msg);
      revealRow(row?.key);
    } catch (e) {
      noteScan({ result: `⛔ ${rollErrorText(e)}` });
      showToast?.(rollErrorText(e), "error");
      beep();
    } finally { setScanBusy(false); }
  };

  // 확인창에서 누른 경우 — 사람이 길이를 정했다.
  const submitPack = async () => {
    const m = scanModal;
    if (!m || m.type !== "confirm") return;
    const { roll, candidate } = m;
    let len = null;
    if (!whole) {
      const p = parseCutLength(cutLen);
      if (!p.ok) { showToast?.(p.reason, "error"); return; }
      len = p.value;
      if (roll.lengthRemaining !== null && len > roll.lengthRemaining) { showToast?.("잔량이 부족합니다", "error"); return; }
    }
    await packCandidate(roll, candidate, len, whole);
  };

  // 롤 없이 포장 — 옛 재고·외주·급한 건. 사유 없이는 저장하지 않는다.
  const submitOverride = async () => {
    const m = scanModal;
    if (!m || m.type !== "override") return;
    const why = overrideReason.trim();
    if (!why) { showToast?.("롤 없이 포장한 사유를 적어 주세요", "error"); return; }
    setScanBusy(true);
    try {
      await db.packItemOverride(m.order.id, m.item.itemId, why, activeManager);
      if (missingItemIdx(m.order).includes(m.itemIdx)) {
        try { await db.clearFabricItem(m.order, m.itemIdx); await reloadOrders(); }
        catch (e) { console.warn("[스캔] 원단 호출 해제 실패", e); }
      }
      await reloadPacking?.();
      closeScanModal();
      clearPending();
      const allDone = afterItemPacked(m.row, m.order, m.item);
      revealRow(m.row?.key);
      showToast?.(`✅ 롤 없이 포장 — ${m.item.fabric || "품목"} · ${why}${allDone ? ` · ${ALL_DONE_HINT}` : ""}`);
    } catch (e) {
      showToast?.(rollErrorText(e), "error");
    } finally { setScanBusy(false); }
  };

  // 품목 포장 취소 — 창을 띄워 묻는다. 잘라 낸 원단은 원래 롤로 못 돌아가므로 두 길이 있다:
  //   아직 안 잘랐음(잘못 찍음) → 원래 롤에 길이를 되돌린다(unpack_item)
  //   이미 잘랐음               → 조각 롤을 하나 만든다 + 사유(unpack_item_cut). 롤 통째면 원래 롤이 되살아난다
  const unpackItem = (order, item, rec) => { setUnpackReason(""); setScanModal({ type: "unpack", order, item, rec }); };
  const submitUnpack = async (asPiece) => {
    const m = scanModal;
    if (!m || m.type !== "unpack") return;
    const { order, item } = m;
    const name = `${item.fabric || ""}${item.color ? ` ${item.color}` : ""}`.trim() || "품목";
    const why = unpackReason.trim();
    if (asPiece && !why) { showToast?.("사유를 적어 주세요", "error"); return; }
    setScanBusy(true);
    try {
      if (asPiece) {
        const piece = await db.unpackItemAsPiece(order.id, item.itemId, why, activeManager);
        showToast?.(piece ? `포장 취소 — ${name} · 조각 롤 ${piece.rollCode} ${fmtLen(piece.lengthRemaining)}${item.unit || "마"} 입고(라벨이 나옵니다)` : `포장 취소 — ${name}`);
      } else {
        await db.unpackItem(order.id, item.itemId, activeManager);
        showToast?.(`포장 취소 — ${name}`);
      }
      await reloadPacking?.();
      closeScanModal();
    } catch (e) {
      showToast?.(rollErrorText(e), "error");
    } finally { setScanBusy(false); }
  };

  // ── 카드 ─────────────────────────────────────────────────
  const OrderCard = ({ row }) => {
    const head = row.orders[0];
    // 합배송이면 여러 주문의 것을 모아 중복 제거 — 같은 링크/메시지가 두 번 뜨지 않게.
    const uniq = arr => [...new Set(arr.filter(Boolean))];
    const msgs = uniq(row.orders.map(o => (o.deliveryMessage || "").trim()));
    const links = uniq(row.orders.flatMap(o => o.links || []));
    const images = uniq(row.orders.flatMap(o => Array.isArray(o.images) ? o.images : []));
    const memos = uniq(row.orders.map(o => (o.memo || "").trim()));
    // stripCardDup: 품목·금액이 그대로 적힌 줄은 걷어낸다(카드에 이미 있는 내용).
    const notes = uniq(row.orders.map(o => stripCardDup(o.note, o).trim()));
    const pulled = row.orders.some(o => o.shipDatePulled);
    const working = busy === row.key;
    const nick = nickOf(head);
    // 주문 등록 정보 — 언제 누가 넣은 주문인지. 밀린 건을 확인하거나
    // 품목이 애매할 때 누구에게 물어볼지 바로 알 수 있게.
    // 합배송은 주문마다 다를 수 있어 건별로 보여주되 완전히 같으면 한 줄로 합친다.
    const fmtReg = o =>
      `${String(o.date || "").replace(/^\d{4}\.\s*/, "").replace(/\.$/, "").trim()} ${o.time || ""} · ${o.manager || "담당자 없음"}`.trim();
    const regs = uniq(row.orders.map(fmtReg));
    // 합배송 카드는 여러 주문의 품목이 한 박스에 섞인다. 어느 게 이미 싼 건지,
    // 어느 게 돈이 안 들어온 건지 카드 위쪽 배지만으로는 알 수 없어 주문별로 나눈다.
    const perOrder = row.orders.map(o => ({
      o,
      items: o.items || [],
      packed: o.status === "포장완료",
      unpaid: BLOCKING_PAY.has(getPayStatus(o)),
      held: isHold(o),
      edited: !!o.packedSig && o.packedSig !== db.itemsSig(o.items),
      // 이 주문에서 안 온 품목의 자리번호 — 아래 품목 줄이 하나씩 대조한다
      missing: missingItemIdx(o),
    }));

    // 스캔 게이트 — 찍어야 할 품목이 남았으면 포장완료를 못 누른다. 옛 주문(itemId 없음)은 게이트가 없다.
    // 전환 기간에는 잠그지 않는다(packing.js PACK_GATE_ENFORCED) — 스캔은 선택, 포장완료는 지금처럼.
    const gate = packGate(row);
    const gateLocked = packingReady && !row.allPacked && gate.locked;
    const isActive = activeKey === row.key;
    const flash = flashKey === row.key;   // 방금 스캔으로 기록한 박스 — 잠깐 초록 테두리
    return (
      <div id={`pk-${row.key}`} onClick={() => { if (packingReady && !row.parked && !row.allPacked) setActiveKey(row.key); }} style={{
        // 활성 박스는 파란 테두리 — 스캔이 이 박스에만 적용된다는 표시
        border: flash ? `2px solid ${T.green}` : isActive ? `2px solid ${T.blue}` : `1px solid ${row.needsRepack ? T.red : `${T.copper}55`}`,
        background: row.needsRepack ? T.redBg : T.surface,
        borderRadius: 11, padding: isActive || flash ? "11px 12px" : "12px 13px", marginBottom: 8,
        boxShadow: flash ? `0 0 0 4px ${T.green}44` : isActive ? `0 0 0 3px ${T.blue}33` : "none",
        transition: "box-shadow 0.3s, border-color 0.3s",
      }}>
        {isActive && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7,fontSize:11.5,fontWeight:800,color:T.blue}}>
            <span>📷 이 박스에 스캔 중{gate.progress ? ` · ${gate.progress}` : ""}</span>
            <button onClick={(e)=>{ e.stopPropagation(); setActiveKey(null); setTimeout(focusScan, 0); }} style={{
              marginLeft:"auto",padding:"3px 9px",borderRadius:6,border:`1px solid ${T.blue}`,background:"transparent",
              color:T.blue,fontFamily:S,fontSize:11,fontWeight:800,cursor:"pointer"}}>해제</button>
          </div>
        )}
        {row.needsRepack && (
          <div style={{fontSize:11.5,fontWeight:800,color:T.red,marginBottom:7,lineHeight:1.5}}>
            {row.mergeRepack
              ? "🔁 이미 포장한 박스에 주문이 추가됐습니다 — 박스를 다시 열어 합쳐 주세요"
              : "🔁 포장한 뒤 품목이 바뀌었습니다 — 박스를 열어 아래 내용과 맞춰 주세요"}
          </div>
        )}

        <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:7}}>
        <div style={{flex:1,minWidth:0,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          <span style={{fontFamily:SF,fontSize:17,fontWeight:800,color:T.cream}}>{head.customer}</span>
          {nick && (
            <span style={{fontFamily:SF,fontSize:14,fontWeight:700,color:T.copper}}>({nick})</span>
          )}
          {/* 택배사 — 박스를 CJ 쪽에 쌓을지 경동 쪽에 쌓을지. 싸기 전에 알아야 한다 */}
          {courierById.get(head.id) && (
            (courierById.get(head.id).pickup
              ? <PickupTag size={10.5}/>
              : <CourierTag courier={courierById.get(head.id).courier} why={courierById.get(head.id).why} size={10.5}/>)
          )}
          {row.overdueDays > 0 && (
            <span style={{fontSize:10.5,fontWeight:800,color:T.white,background:T.red,padding:"2px 7px",borderRadius:5}}>
              🔺 {row.overdueDays}일 지남
            </span>
          )}
          {row.sellerUrgent && (
            <span style={{fontSize:10.5,fontWeight:800,color:T.red,background:T.redBg,padding:"2px 7px",borderRadius:5}}>
              ⚡ 긴급 지정
            </span>
          )}
          {row.merged && (
            <span style={{fontSize:10.5,fontWeight:800,color:T.purple,background:"rgba(138,106,184,0.15)",padding:"2px 7px",borderRadius:5}}>
              📦 합배송 {row.orders.length}건
            </span>
          )}
          {pulled && <span style={{fontSize:10.5,fontWeight:800,color:T.copper,background:T.copperGlow,padding:"2px 7px",borderRadius:5}}>⏫ 당김</span>}
          {/* 셀러가 보관을 요청한 건 — 원단을 보관 장소에 넣어야 카드가 넘어간다.
              보관 '중'인 건이 재포장 등으로 다른 탭에 올라온 경우도 표시한다. */}
          {row.holdPending && <span style={{fontSize:10.5,fontWeight:800,color:T.white,background:T.yellow,padding:"2px 7px",borderRadius:5}}>📦 보관 요청</span>}
          {row.heldDone && <span style={{fontSize:10.5,fontWeight:800,color:T.yellow,background:T.yellowBg,padding:"2px 7px",borderRadius:5}}>📦 보관중</span>}
          {/* 보관분 출고요청 — 이 카드의 원단은 작업대가 아니라 창고 선반에 있다.
              일반 주문과 나란히 놓이면 어디서 가져와야 하는지 알 길이 없어 헛걸음한다. */}
          {row.shipRequested && (
            <span title={row.shipRequestedBy ? `${row.shipRequestedBy}님 요청` : undefined}
              style={{fontSize:10.5,fontWeight:800,color:T.white,background:T.copper,padding:"2px 7px",borderRadius:5}}>
              📦 보관분 출고요청 — 창고에서 꺼내오세요
            </span>
          )}
          {/* 며칠째인지가 보류 배지의 본론이다 — 잊힌 채 썩는 걸 막는 유일한 표시라
              '보류중'만 달아두면 반년 된 건과 어제 넣은 건이 똑같아 보인다. */}
          {row.parked && (
            <span style={{fontSize:10.5,fontWeight:800,color:T.creamMuted,background:T.subtleBg,
              padding:"2px 7px",borderRadius:5,border:`1px solid ${T.border}`}}>
              🗄️ 보류 {row.parkedDays}일째
            </span>
          )}
          {/* 원단 대기 — 카드는 제자리에 있고 이 배지와 아래 분홍 품목 줄로만 표시한다.
              몇 분째인지가 본론이다. 오래 걸리는 건은 사람이 가서 챙겨야 한다. */}
          {row.fabricMissing && (
            <span style={{fontSize:10.5,fontWeight:800,color:T.white,background:T.pink,
              padding:"2px 7px",borderRadius:5}}>
              🧶 원단 대기 {row.fabricCalledAt ? Math.max(0, Math.floor((nowTs - new Date(row.fabricCalledAt)) / 60000)) : 0}분째
            </span>
          )}
          {row.allPacked && <span style={{fontSize:10.5,fontWeight:800,color:T.green,background:T.greenBg,padding:"2px 7px",borderRadius:5}}>✅ 포장완료</span>}
          {/* 합배송은 아래 주문별 칸이 어느 건이 미입금·보관인지 정확히 알려준다.
              여기서 또 붙이면 '어느 주문 얘기인지' 없이 같은 말만 반복된다. */}
          {!row.merged && row.blocked.map(b => (
            <span key={b} style={{fontSize:10.5,fontWeight:800,color:b==="보관"?T.blue:T.red,
              background:b==="보관"?T.blueBg:T.redBg,padding:"2px 7px",borderRadius:5}}>{b}</span>
          ))}
        </div>
        {/* 주문 등록 정보 — 언제 누가 넣은 주문인지. 품목이 애매하거나 밀린 건을
            확인할 때 누구에게 물어볼지 바로 알 수 있게 오른쪽 위에 둔다.
            합배송은 아래 주문별 칸에서 각자 보여주므로 여기서는 생략한다. */}
        {!row.merged && (
          <div style={{flexShrink:0,textAlign:"right",fontSize:10.5,color:T.creamMuted,lineHeight:1.55,whiteSpace:"nowrap"}}>
            {regs.map((r, i) => <div key={i}>{r}</div>)}
          </div>
        )}
        </div>

        {/* 보류 사유 — 카드에서 가장 먼저 읽혀야 한다. 몇 달 뒤 이 카드를 여는 사람에게
            '왜 여기 있는지'를 답하는 유일한 줄이라 품목보다 위에 둔다. */}
        {row.parked && row.parkReason && (
          <div style={{marginBottom:8,fontSize:12.5,fontWeight:700,color:T.cream,background:T.subtleBg,
            border:`1px solid ${T.border}`,padding:"7px 10px",borderRadius:7,lineHeight:1.55,whiteSpace:"pre-wrap"}}>
            🗄️ 보류 사유 · {row.parkReason}
          </div>
        )}

        {/* 품목 — 포장직원이 실제로 담아야 하는 것. 글씨를 키운다(서서 하는 작업).
            합배송이면 주문별로 칸을 나눠 어느 게 포장됐고 어느 게 미입금인지 붙인다. */}
        <div style={{marginBottom:8}}>
          {perOrder.map(({ o, items: oItems, packed, unpaid, held, edited, missing }, gi) => (
            <div key={o.id} style={row.merged ? {
              marginTop: gi ? 7 : 0, padding: "6px 9px", borderRadius: 9,
              border: `1px solid ${edited ? T.red : packed ? `${T.green}66` : unpaid ? `${T.red}66` : T.border}`,
              background: edited ? T.redBg : packed ? T.greenBg : unpaid ? T.redBg : "transparent",
            } : undefined}>
              {row.merged && (
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap",marginBottom:3,
                  fontSize:10.5,color:T.creamMuted}}>
                  {edited && <b style={{color:T.red,fontWeight:800}}>✏️ 포장 후 수정</b>}
                  {packed && !edited && <b style={{color:T.green,fontWeight:800}}>✅ 포장완료</b>}
                  {!packed && row.mergeRepack && <b style={{color:T.copper,fontWeight:800}}>🆕 새로 추가</b>}
                  {unpaid && <b style={{color:T.red,fontWeight:800}}>💰 미입금</b>}
                  {held && <b style={{color:T.blue,fontWeight:800}}>📦 보관</b>}
                  <span style={{marginLeft:"auto",whiteSpace:"nowrap"}}>{fmtReg(o)}</span>
                </div>
              )}
              {oItems.map((it, i) => {
                // 이 원단 한 줄이 호출 중인가. 버튼을 마수 옆에 두는 이유는,
                // 포장직원이 "이건 있고 이건 없다"를 훑는 눈이 원단명·마수 줄을 따라가기 때문이다.
                const called = missing.includes(i);
                // 스캔 상태 — itemId 있는 품목만. 옛 주문의 품목은 아무 표시도 안 한다(옛 방식).
                const scannable = packingReady && !!it.itemId;
                const rec = scannable ? packingOf(packingByOrder, o.id, it.itemId) : null;
                const recRoll = rec?.rollCode || (rec?.rollId ? rollById.get(rec.rollId)?.rollCode : "") || (rec?.rollId ? "롤" : "");
                return (
                <div key={i} style={{display:"flex",gap:8,alignItems:"center",padding:"4px 0",flexWrap:"wrap",
                  borderTop: i ? `1px solid ${T.border}55` : "none"}}>
                  {it.itemNo && <span style={{fontSize:11.5,fontWeight:800,color:T.copper,minWidth:46}}>{it.itemNo}</span>}
                  {/* 원단명은 포장의 핵심 정보 — 주문현황 카드처럼 테두리로 감싸 한눈에 잡히게 한다.
                      색상은 원단명에 함께 적으므로 나누지 않는다(옛 주문의 color 는 뒤에 붙여 유지). */}
                  <span style={{flex:1,fontSize:15,fontWeight:700,
                    color: called ? T.pink : T.cream,
                    padding:"5px 10px",borderRadius:8,
                    background: called ? T.pinkBg : T.surface,
                    border:`1px solid ${called ? T.pink : T.border}`}}>
                    {it.fabric}{it.color ? ` ${it.color}` : ""}
                  </span>
                  <span style={{fontSize:16,fontWeight:900,color: called ? T.pink : T.cream,fontFamily:SF}}>
                    {it.qty}{it.unit || "마"}
                  </span>
                  <button onClick={()=>toggleFabric(row, o, i)} disabled={working}
                    title={called ? "원단이 도착했으면 눌러서 호출을 해제합니다" : "이 원단이 아직 안 왔다고 담당자를 부릅니다"}
                    style={{flexShrink:0,padding:"5px 9px",borderRadius:7,fontFamily:S,fontSize:11.5,fontWeight:800,
                      cursor:working?"wait":"pointer",
                      border:`1px ${called ? "solid" : "dashed"} ${T.pink}`,
                      background: called ? T.pink : "transparent",
                      color: called ? "#fff" : T.pink}}>
                    {called ? "✓ 확인" : "🧶 없음"}
                  </button>
                  {/* 스캔 상태 — 찍었으면 어느 롤에서 얼마를 잘랐는지, 아니면 '롤 없이 포장' 길 */}
                  {scannable && (rec ? (
                    <span style={{display:"inline-flex",alignItems:"center",gap:6,flexBasis:"100%",fontSize:12,fontWeight:800,color:T.green}}>
                      {rec.rollId
                        ? <span>✅ {recRoll} {fmtLen(rec.length)}{it.unit || "마"}{rec.wholeRoll ? " · 롤 통째" : ""}</span>
                        : <span>✅ 롤 없이 — {rec.overrideReason || "사유 없음"}</span>}
                      {rec.packedBy && <span style={{fontWeight:600,color:T.creamMuted}}>· {rec.packedBy}</span>}
                      <button onClick={(e)=>{ e.stopPropagation(); unpackItem(o, it, rec); }} disabled={working || scanBusy}
                        title="이 품목의 포장을 취소합니다 — 안 잘랐으면 원래 롤로, 잘랐으면 조각 롤로"
                        style={{padding:"2px 8px",borderRadius:6,border:`1px solid ${T.border}`,background:"transparent",
                          color:T.creamMuted,fontFamily:S,fontSize:11,fontWeight:700,cursor:"pointer"}}>취소</button>
                    </span>
                  ) : (
                    <button onClick={(e)=>{ e.stopPropagation(); setOverrideReason(""); setScanModal({ type:"override", row, order:o, item:it, itemIdx:i }); }}
                      disabled={working || scanBusy} title="롤이 없는 원단(옛 재고·외주)을 사유를 적고 포장합니다"
                      style={{flexBasis:"100%",alignSelf:"flex-start",width:"max-content",padding:"3px 9px",borderRadius:6,
                        border:`1px dashed ${T.border}`,background:"transparent",color:T.creamMuted,
                        fontFamily:S,fontSize:11,fontWeight:700,cursor:"pointer"}}>
                      롤 없이 포장
                    </button>
                  ))}
                </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* 송장에 들어갈 정보 — 전화번호는 눌러서 바로 걸 수 있게 */}
        {head.phone && (
          <div style={{fontSize:17,fontWeight:800,color:T.cream,marginBottom:4,fontFamily:SF,letterSpacing:"0.2px"}}>
            <a href={`tel:${head.phone.replace(/[^0-9+]/g,"")}`} style={{color:T.cream,textDecoration:"none"}}>
              📞 {head.phone}
            </a>
          </div>
        )}
        <div style={{fontSize:12.5,color:T.creamMuted,lineHeight:1.6}}>
          {head.address || "주소 없음"}{head.addressDetail ? ` ${head.addressDetail}` : ""}
        </div>

        {msgs.map((m, i) => (
          <div key={i} style={{marginTop:6,fontSize:12,fontWeight:700,color:T.blue,
            background:T.blueBg,padding:"6px 9px",borderRadius:6,lineHeight:1.5}}>💬 {m}</div>
        ))}
        {notes.map((n, i) => (
          <div key={i} style={{marginTop:6,fontSize:12,color:T.cream,background:T.subtleBg,
            padding:"6px 9px",borderRadius:6,lineHeight:1.55,whiteSpace:"pre-wrap"}}>📝 {n}</div>
        ))}
        {memos.map((m, i) => (
          <div key={i} style={{marginTop:6,fontSize:12,fontWeight:700,color:T.copper,background:T.copperGlow,
            padding:"6px 9px",borderRadius:6,lineHeight:1.55,whiteSpace:"pre-wrap"}}>🗒 담당자 · {m}</div>
        ))}

        {/* 링크 미리보기 · 첨부 이미지 — 어떤 원단인지 눈으로 확인하는 용도라 크게 띄운다.
            auto-fit 이라 1장이면 카드 전체 폭까지 늘어난다. */}
        {links.length > 0 && (
          <LinkPreview links={links} T={T} className="pack-img-grid"
            onOpenImage={(img, link)=>onOpenImage?.({images:[img],index:0,link})}/>
        )}

        {images.length > 0 && (
          <div className="pack-img-grid">
            {images.map((url, i) => (
              <div key={i} onClick={()=>onOpenImage?.({images, index:i})} style={{position:"relative",aspectRatio:"1/1",
                borderRadius:9,overflow:"hidden",border:`1px solid ${T.border}`,cursor:"pointer",background:T.surface}}>
                <img src={url} alt="" loading="lazy" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
              </div>
            ))}
          </div>
        )}

        {/* 보류 사유 입력 — 열려 있는 동안엔 다른 버튼을 감춘다.
            사유 없이 넣을 길을 열어두면 아무도 안 적고, 안 적힌 보류는 못 꺼낸다. */}
        {parking === row.key && (
          <div style={{marginTop:10,padding:"10px 11px",borderRadius:9,
            border:`1px solid ${T.border}`,background:T.subtleBg}}>
            <div style={{fontSize:11.5,fontWeight:800,color:T.cream,marginBottom:6,lineHeight:1.5}}>
              🗄️ 왜 못 나가나요? — 몇 달 뒤 꺼낼 때 읽을 사람을 위해 적습니다
            </div>
            {/* defaultValue + ref. value/onChange 로 묶으면 부모가 리렌더되며
                이 입력칸이 다시 mount 돼 한 글자마다 포커스가 날아간다. */}
            <div style={{display:"flex",gap:6}}>
            <input ref={parkRef} defaultValue={row.parkReason || ""} autoFocus
              onKeyDown={e=>{ if (e.key === "Enter") park(row); if (e.key === "Escape") setParking(null); }}
              onChange={e=>setParkMirror(e.target.value)}
              placeholder="예) 연락 두절 · 원단 단종, 대체품 협의 중 · 결제 분쟁"
              style={{flex:1,minWidth:0,boxSizing:"border-box",padding:"9px 11px",borderRadius:8,
                border:`1px solid ${T.border}`,background:T.surface,color:T.cream,
                fontFamily:S,fontSize:13,outline:"none"}}/>
            {kbdBtn("park", { title: "보류 사유", presets: ["연락 두절", "입금 대기", "원단 단종, 대체품 협의 중", "결제 분쟁"] })}
            </div>
            <div style={{display:"flex",gap:6,marginTop:8}}>
              <button onClick={()=>setParking(null)} disabled={working} style={{
                padding:"9px 13px",borderRadius:8,cursor:"pointer",fontFamily:S,fontSize:12.5,fontWeight:800,
                border:`1px solid ${T.border}`,background:"transparent",color:T.creamMuted}}>취소</button>
              <button onClick={()=>park(row)} disabled={working} style={{
                flex:1,padding:"9px 13px",borderRadius:8,cursor:working?"wait":"pointer",fontFamily:S,
                fontSize:13.5,fontWeight:900,border:"none",background:T.creamMuted,color:T.surface,
                opacity:working?0.6:1}}>
                {working ? "처리 중…" : "🗄️ 보류함에 넣기"}
              </button>
            </div>
          </div>
        )}

        {/* 보류 카드에는 보관·당김·포장 버튼을 두지 않는다. 나갈 수 없는 건이라
            그 버튼들이 할 일이 없고, 여기서 유일하게 필요한 건 다시 꺼내는 것뿐이다. */}
        {/* 원단이 없어도 버튼은 그대로 둔다. 카드가 제자리에 있고, 포장완료를 누르면
            원단이 왔다는 뜻이라 표시가 저절로 꺼진다(db.setOrderPacked). */}
        {row.parked ? (
          <div style={{display:"flex",gap:6,marginTop:10}}>
            <button onClick={()=>unpark(row)} disabled={working} style={{
              flex:1,padding:"12px",borderRadius:8,cursor:working?"wait":"pointer",fontFamily:S,
              fontSize:14.5,fontWeight:900,border:`1px solid ${T.copper}`,background:"transparent",
              color:T.copper,opacity:working?0.6:1}}>
              {working ? "처리 중…" : "↩️ 보류 해제 — 오늘 출고 예정으로"}
            </button>
          </div>
        ) : parking === row.key ? null : (
        <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
          {/* 원단 호출은 여기 없다 — 품목 줄마다 붙어 있다. 한 주문에 원단이 여럿이면
              어느 것이 안 왔는지 이 자리에서는 가리킬 수 없기 때문이다. */}
          {/* 보류 — 보관 왼쪽에 둔다. 둘 다 '지금 안 내보낸다'는 같은 갈래라
              나란히 있어야 고를 때 견줘 보게 된다.
              다만 한 해에 몇 번 쓰는 버튼이라 회색 점선으로 눌러 둔다 —
              찾으면 있고 훑을 땐 안 걸리게. */}
          <button onClick={()=>setParking(row.key)} disabled={working} title="몇 달씩 못 나가는 주문을 출고 큐에서 빼둡니다" style={{
            padding:"10px 13px",borderRadius:8,cursor:working?"wait":"pointer",fontFamily:S,fontSize:12.5,fontWeight:800,
            flex:"0 0 auto",
            border:`1px dashed ${T.border}`,background:"transparent",color:T.creamMuted}}>
            🗄️ 보류
          </button>
          {/* 보관 — 셀러가 요청한 건이면 '보관완료'가 이 카드의 할 일이다.
              요청이 없어도 포장직원이 스스로 보관으로 보낼 수 있다. */}
          <button onClick={()=>setHold(row, row.heldDone ? "release" : "done")} disabled={working} style={{
            padding:"10px 13px",borderRadius:8,cursor:working?"wait":"pointer",fontFamily:S,
            fontSize: row.holdPending ? 14.5 : 12.5, fontWeight:row.holdPending?900:800,
            flex: row.holdPending ? 1 : "0 0 auto",
            border: row.holdPending ? "none" : `1px ${row.heldDone ? "solid" : "dashed"} ${T.yellow}`,
            background: row.holdPending ? T.yellow : row.heldDone ? T.yellowBg : "transparent",
            color: row.holdPending ? T.white : T.yellow}}>
            {row.heldDone ? "📦 보관 해제" : row.holdPending ? "📦 보관완료" : "📦 보관"}
          </button>
          {/* '당일로' 버튼은 없앴다. 출고 일정은 관리자가 정하는 것이고, 포장팀은
              익일이든 당일이든 쌀 수 있는 건 미리 싸두면 된다 — 날짜를 당길 이유가 없다.
              (⏫ 당김 배지는 남는다. 보류 해제나 예전에 당긴 건을 계속 표시해야 한다) */}
          {/* 보관 건은 원칙적으로 포장 전이지만, 잘못 눌렀거나 다시 싸야 하는 건이
              생긴다. 되돌리는 길은 물건을 만지는 이 화면에만 열어둔다. */}
          {/* 스캔 게이트 — 잠그기로 하면(PACK_GATE_ENFORCED) 품목을 다 찍기 전엔 잠긴다. 포장완료 취소는
              포장 기록을 지우지 않는다(원단은 이미 잘렸다). 재단을 무르는 건 품목 줄의 '취소'로만. */}
          <button onClick={()=>setPacked(row, !row.allPacked)} disabled={working || gateLocked}
            title={gateLocked ? `롤을 찍지 않은 품목이 있습니다 (${gate.progress}) — 다 찍거나 '롤 없이 포장'을 눌러야 열립니다` : undefined}
            style={{
            flex:1,minWidth:130,padding:"12px",borderRadius:8,fontFamily:S,fontSize:14.5,fontWeight:900,
            cursor: working ? "wait" : gateLocked ? "not-allowed" : "pointer",
            border: row.allPacked || gateLocked ? `1px solid ${T.border}` : "none",
            background: row.allPacked ? "transparent" : gateLocked ? T.subtleBg : `linear-gradient(135deg,${T.copper},${T.copperLight})`,
            color: row.allPacked || gateLocked ? T.creamMuted : T.white,
            opacity:working?0.6:1}}>
            {working ? "처리 중…"
              : row.allPacked ? "포장완료 취소"
              : `${row.mergeRepack ? "합쳐서 완료" : row.editedAfterPack ? "다시 포장 완료" : "포장완료"}${packingReady && gate.progress ? ` (${gate.progress})` : ""}`}
          </button>
        </div>
        )}
        {/* 포장은 하되, 이 박스가 아직 돈이 덜 들어왔다는 건 알고 넘어가야 한다 */}
        {row.payBlocked && (
          <div style={{marginTop:6,fontSize:11.5,fontWeight:700,color:T.red,lineHeight:1.5}}>
            💰 입금 확인 전입니다 — 포장은 해도 되지만 출고는 입금 후에 나갑니다
          </div>
        )}
      </div>
    );
  };

  // 검색 결과가 이 탭엔 없을 때 — 빈 화면만 두면 '없다'고 오해한다. 어느 탭에 있는지 알려준다.
  const SearchMiss = () => (
    <div style={{padding:"30px 12px",textAlign:"center"}}>
      <div style={{fontSize:13,color:T.creamMuted,lineHeight:1.6}}>
        <b style={{color:T.cream}}>{search.trim()}</b> — 이 탭에는 없습니다
      </div>
      {otherHits.length > 0 && (
        <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap",marginTop:12}}>
          {otherHits.map(v => (
            <button key={v.k} onClick={()=>setView(v.k)} style={{
              padding:"7px 12px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:12,fontWeight:800,
              border:`1px solid ${colorOf(v.color)}`,background:"transparent",color:colorOf(v.color)}}>
              {v.emoji} {v.label} {groups[v.k].ready.length}건
            </button>
          ))}
        </div>
      )}
    </div>
  );

  // ── 화면 키보드 값 오가기 ──
  const kbdVal = () => {
    switch (kbd?.field) {
      case "search": return search;
      case "park": return parkRef.current ? parkRef.current.value : parkMirror;
      case "cut": return cutLen;
      case "unpack": return unpackReason;
      case "override": return overrideReason;
      default: return "";
    }
  };
  const kbdSet = (v) => {
    switch (kbd?.field) {
      case "search": setSearch(v); break;
      case "park": if (parkRef.current) parkRef.current.value = v; setParkMirror(v); break;
      case "cut": setCutLen(v); break;
      case "unpack": setUnpackReason(v); break;
      case "override": setOverrideReason(v); break;
      default: break;
    }
  };
  // 칸이 사라지면(보류 취소·확인창 닫힘) 키보드도 내린다
  useEffect(() => {
    if (!kbd) return;
    if (kbd.field === "park" && parking === null) setKbd(null);
    if (["cut", "unpack", "override"].includes(kbd.field) && !scanModal) setKbd(null);
  }, [kbd, parking, scanModal]);
  const kbdBtn = (field, extra = {}) => {
    const on = kbd?.field === field;
    return (
      <button type="button" onClick={() => setKbd(on ? null : { field, ...extra })} aria-label="화면 키보드" aria-pressed={on}
        title="화면 키보드 — 아이패드에 스캐너가 붙어 있어 키보드가 안 올라올 때"
        style={{flexShrink:0,width:46,minHeight:40,borderRadius:9,cursor:"pointer",fontSize:19,lineHeight:1,
          border:`1px solid ${on ? T.copper : T.border}`,background: on ? T.copperGlow : T.surface,color: on ? T.copper : T.creamMuted}}>⌨</button>
    );
  };

  // ── 렌더 ─────────────────────────────────────────────────
  return (
    <div>
      <style>{`
        @keyframes packBlink{0%,100%{opacity:1}50%{opacity:.45}}
        /* 스캔 거부 토스트 — 위에서 살짝 내려오며 뜨고, 끝나기 전에 옅어진다 */
        @keyframes packToastIn{from{opacity:0;transform:translate(-50%,-10px)}to{opacity:1;transform:translate(-50%,0)}}
        @keyframes packToastOut{from{opacity:1}to{opacity:0}}
        /* 링크·첨부 이미지 — 가로 4장. 인라인 스타일로는 미디어 쿼리를 못 써서 클래스로 뺀다. */
        .pack-img-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:9px}
        /* 폰처럼 좁은 화면에서 4장이면 원단이 안 보인다 — 2장으로 */
        @media (max-width:480px){ .pack-img-grid{grid-template-columns:repeat(2,1fr)} }
      `}</style>

      {/* 스캔 거부 토스트 — 화면 맨 위 고정(스크롤과 무관), 확인창(zIndex 60)보다 위. BANNER_MS 뒤 사라진다. */}
      {banner && (
        <div key={banner.id} role="alert" style={{
          // 맨 위 '로하이마켓 ERP' 바(AppEntry, fixed·높이 약 40px·zIndex 900)에 가려지지 않게 그 아래에, 그보다 위 층에(2026-10-15)
          position:"fixed",zIndex:920,top:"calc(env(safe-area-inset-top, 0px) + 50px)",left:"50%",
          // 가운데 정렬은 여기 고정 — 애니메이션(packToastIn) 안에만 두면 0.22초 뒤 변환이 풀려 토스트가
          // 화면 가운데에서 오른쪽으로 튀어 나갔다(2026-10-15 "이상한 곳에 뜬다").
          transform:"translate(-50%,0)",
          width:"min(620px, calc(100% - 24px))",boxSizing:"border-box",
          padding:"12px 16px",borderRadius:12,
          background:`linear-gradient(${T.redBg},${T.redBg}), ${T.surface}`,
          border:`2px solid ${T.red}`,boxShadow:"0 8px 28px rgba(0,0,0,0.45)",
          color:T.red,fontFamily:S,fontSize:14.5,fontWeight:900,lineHeight:1.5,
          animation:`packToastIn .22s ease-out, packToastOut ${BANNER_FADE_MS}ms ease-in ${BANNER_MS - BANNER_FADE_MS}ms forwards`,
        }}>
          ⛔ {banner.message}
          {banner.hint && <div style={{fontSize:12.5,fontWeight:800,color:T.cream,marginTop:3}}>{banner.hint}</div>}
        </div>
      )}

      {/* ERP 자체 화면 키보드 — 적는 칸 옆 ⌨ 버튼으로 연다. 확인창(zIndex 60)보다 위, 토스트(70)보다 아래 */}
      {kbd && (
        <ScreenKeyboard value={kbdVal()} onChange={kbdSet} mode={kbd.mode || "text"} title={kbd.title || ""}
          presets={kbd.presets || []} onDone={() => setKbd(null)} />
      )}

      {/* 재포장 경고 — 구역 탭이 화면 밖일 때만. 탭이 보이면 긴급 탭이 대신 깜빡인다.
          눌러서 긴급 탭 맨 위로 이동. 상단 sticky 바 아래(headerH)에 붙인다. */}
      {repack.length > 0 && !tabsSeen && (
        <div onClick={()=>{ setView("urgent"); window.scrollTo({top:0,behavior:"smooth"}); }} style={{
          position:"fixed",zIndex:8,boxSizing:"border-box",cursor:"pointer",
          top:anchor?.top ?? 0, left:anchor?.left ?? 0, width:anchor?.width ?? "100%",
          padding:"11px 14px",
          // 반투명이면 뒤 카드 글씨가 비쳐 경고가 묻힌다. redBg 를 surface 위에 얹어
          // '옅은 빨강'을 불투명하게 만든다 — 꽉 찬 빨강은 너무 세다.
          background:`linear-gradient(${T.redBg},${T.redBg}), ${T.surface}`,
          border:`2px solid ${T.red}`,borderTop:"none",borderRadius:"0 0 10px 10px",
          boxShadow:"0 6px 16px rgba(0,0,0,0.28)",
          fontSize:13,fontWeight:900,color:T.red,fontFamily:S}}>
          {/* 깜빡임은 글자에만 — 판 전체를 깜빡이면 흐려질 때 뒤가 비친다 */}
          <span style={{animation:"packBlink 1.1s ease-in-out infinite"}}>
            🔁 재포장 필요 {repack.length}건 — 포장 끝난 박스를 다시 열어야 합니다 ▲
          </span>
        </div>
      )}

      {/* 연결이 끊긴 동안의 알림.
          탭의 숫자는 마지막으로 읽어온 순간의 것이지 지금의 사실이 아니다. 이 줄이 없으면
          0건이 '오늘 쌀 게 없다'로 읽힌다 — 포장대에서 그건 물량을 통째로 흘리는 오해다.
          누르면 즉시 다시 읽는다(자동 재시도는 15초마다 이미 돌고 있다). */}
      {syncLost && (
        <div onClick={()=>reloadOrders()} style={{
          marginBottom:10,padding:"10px 13px",borderRadius:10,cursor:"pointer",
          background:`linear-gradient(${T.redBg},${T.redBg}), ${T.surface}`,
          border:`2px solid ${T.red}`,color:T.red,fontFamily:S,fontSize:13,fontWeight:900}}>
          <span style={{animation:"packBlink 1.1s ease-in-out infinite"}}>
            ⚠️ 서버와 연결이 끊겼습니다 — 아래 숫자는 최신이 아닙니다. 눌러서 다시 불러오기
          </span>
        </div>
      )}

      {/* 롤 스캔 칸 — 항상 보인다. 스캐너는 커서가 있는 곳에 치므로, 커서가 여기 있는지가
          곧 "스캔이 되는 상태인지"다. 표시로 알려주고, 잃었으면 눌러서 되찾는다.
          커서가 저절로 오는 건 스캔 모드를 켠 태블릿뿐 — 나머지는 사람이 눌러야 온다. */}
      {packingReady ? (
        <div id="pk-top" style={{marginBottom:10}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <input ref={scanRef} value={scanVal} onChange={e=>setScanVal(e.target.value)}
              onFocus={()=>setScanFocused(true)} onBlur={()=>setScanFocused(false)}
              onKeyDown={onScanKeyDown}
              onKeyUp={onScanKeyUp}
              placeholder={waitRoll ? "📷 롤 QR 을 찍으세요 — 어느 롤에서 잘랐습니까?" : "📷 주문 라벨 QR 또는 롤 QR 을 찍으세요 (롤 코드 입력 후 Enter 도 됩니다)"}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} aria-label="롤 스캔"
              style={{flex:1,minWidth:0,boxSizing:"border-box",padding:"12px 13px",borderRadius:10,
                border:`2px solid ${scanFocused ? T.green : T.border}`,background:T.surface,color:T.cream,
                fontFamily:"monospace",fontSize:15,fontWeight:800,letterSpacing:"0.04em",outline:"none"}}/>
            <span onClick={()=>focusScan(true)} style={{flexShrink:0,padding:"7px 11px",borderRadius:20,cursor:"pointer",
              fontFamily:S,fontSize:11.5,fontWeight:800,whiteSpace:"nowrap",
              border:`1px solid ${scanFocused ? T.green : T.border}`,
              background: scanFocused ? T.greenBg : "transparent",
              color: scanFocused ? T.green : T.creamMuted}}>
              {scanFocused ? "● 스캔 대기 중" : "칸을 눌러 스캔 준비"}
            </span>
            {/* 스캔 모드 — 스캐너를 페어링한 태블릿에서만 켠다. 켜면 커서가 스캔칸으로 저절로 돌아온다. */}
            <button onClick={toggleScanMode}
              title={scanMode ? "스캔 상시를 끕니다 — 커서가 스캔칸으로 저절로 가지 않습니다(스캐너 없는 기기에서 화면 키보드가 거슬릴 때)" : "스캔 상시를 켭니다 — 출고 대기 탭에서 커서가 늘 스캔칸에 있습니다"}
              style={{flexShrink:0,padding:"7px 11px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:11.5,fontWeight:800,whiteSpace:"nowrap",
                border:`1px ${scanMode ? "solid" : "dashed"} ${scanMode ? T.copper : T.border}`,
                background: scanMode ? T.copperGlow : "transparent",
                color: scanMode ? T.copper : T.creamMuted}}>
              {scanMode ? "📷 스캔 상시" : "📷 스캔 꺼짐"}
            </button>
          </div>
          <div style={{marginTop:5,fontSize:11,color:T.creamMuted,lineHeight:1.5}}>
            {activeRow
              ? <span>롤 QR 은 <b style={{color:T.blue}}>{activeRow.orders[0].customer}</b> 박스에만 적용됩니다 · 다른 박스를 누르면 바뀝니다</span>
              : "주문 라벨 QR 을 찍으면 그 주문의 품목이 바로 잡힙니다 · 롤 QR 만 찍으면 박스를 누르거나 화면의 모든 박스에서 찾습니다"}
            {scanLog.length > 0 && (
              <button onClick={() => setScanLogOpen(v => !v)} style={{marginLeft:8,padding:"1px 7px",borderRadius:10,border:`1px dashed ${T.border}`,background:"transparent",color:T.creamMuted,fontFamily:S,fontSize:10.5,fontWeight:700,cursor:"pointer"}}>
                🧾 최근 스캔 {scanLog.length}{scanLogOpen ? " ▲" : " ▼"}
              </button>
            )}
          </div>
          {/* 스캐너가 실제로 보낸 글자 — 앞이 잘렸는지, 둘이 붙었는지, 한글 자판이었는지가 여기서 보인다 */}
          {scanLogOpen && scanLog.length > 0 && (
            <div style={{marginTop:6,padding:"8px 10px",borderRadius:8,border:`1px solid ${T.border}`,background:T.surface,fontSize:11,lineHeight:1.6,fontFamily:"monospace",color:T.creamMuted,overflowWrap:"anywhere"}}>
              {scanLog.map((e, i) => (
                <div key={e.at + ":" + i} style={{borderTop: i ? `1px solid ${T.border}55` : "none",paddingTop: i ? 4 : 0}}>
                  <span style={{color:T.cream}}>{new Date(e.at).toTimeString().slice(0, 8)}</span> [{e.kind === "item" ? "라벨" : "롤"}{e.src ? `·${e.src}` : ""}] <span style={{color:T.copper}}>{e.code}</span>
                  {e.result ? <span style={{color: e.result.startsWith("⛔") ? T.red : T.green}}> → {e.result}</span> : null}
                  <div style={{color:T.creamMuted,fontSize:10.5}}>원문: {e.raw.length > 70 ? e.raw.slice(0, 70) + "…" : e.raw}{e.raw.length !== e.raw.trim().length ? " (공백 포함)" : ""}</div>
                </div>
              ))}
            </div>
          )}
          {/* 스캔 거부는 화면 맨 위 고정 토스트로 뜬다(렌더 맨 앞) — 여기 끼워 넣으면 스크롤 내린 상태에서 안 보였다 */}
        </div>
      ) : (
        <div style={{marginBottom:10,padding:"9px 12px",borderRadius:9,border:`1px dashed ${T.border}`,
          fontSize:11.5,color:T.creamMuted,lineHeight:1.5}}>
          롤 스캔 DB 가 아직 준비되지 않았습니다 — migrations/add_item_packing.sql 을 먼저 실행해 주세요. 그전까지는 옛 방식대로 포장완료를 누릅니다
        </div>
      )}

      {/* 구역 탭 — 윗줄은 오늘 할 일(날짜축), 아랫줄은 큐에서 빠진 것(상태축).
          좁은 화면에서는 각 줄이 따로 가로 스크롤된다. */}
      <div ref={tabsRef} style={{marginBottom:12}}>
        <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch"}}>
          {QUEUE_VIEWS.map(v => {
            const n = (groups[v.k]?.ready || []).length;
            const on = view === v.k || (dayMerged && DAY_PAIR.has(v.k));
            const c = colorOf(v.color);
            // 탭이 보이는 동안엔 상단 배너 대신 긴급 탭이 깜빡여 재포장을 알린다.
            const blink = v.k === "urgent" && repack.length > 0 && tabsSeen;
            // 묶였을 때 두 칸을 맞붙여 한 덩어리로 만든다. 둘 다 진하게 칠하기만 하면
            // '두 칸이 따로 켜진 것'과 구분이 안 된다. 각자 색은 남긴다 —
            // 주황/파랑이 사라지면 어디까지가 오늘 것인지 탭에서도 읽을 수 없게 된다.
            const joinR = dayMerged && v.k === "today";      // 오른쪽을 익일에 붙인다
            const joinL = dayMerged && v.k === "tomorrow";   // 왼쪽을 당일에 붙인다
            return (
              <button key={v.k} onClick={()=>setView(v.k)} style={{
                flex:"1 0 auto",minWidth:78,padding:"9px 10px",borderRadius:10,cursor:"pointer",fontFamily:S,
                // 안 고른 칸도 자기 색 테두리를 옅게 두른다 — T.border(회색)로 두면 네 칸이
                // 배경에 묻혀 어디를 눌러야 할지 매번 글자를 읽어야 했다. 색이 남아 있으면
                // 빨강=긴급, 주황=당일이 위치만으로 잡힌다. 고른 칸은 진하게 2px.
                border:`2px solid ${blink ? T.red : on ? c : `${c}66`}`,
                background: blink ? T.redBg : on ? `${c}1f` : "transparent",
                animation: blink ? "packBlink 1.1s ease-in-out infinite" : undefined,
                // 붙는 쪽은 모서리를 펴고 테두리를 지운다. marginRight 는 flex 의 gap:5 를
                // 되돌려 두 칸 사이의 틈을 없애는 값이다(픽셀을 바꾸면 여기도 같이 바꿔야 한다).
                ...(joinR ? { borderTopRightRadius:0, borderBottomRightRadius:0, borderRight:"none", marginRight:-5 } : null),
                ...(joinL ? { borderTopLeftRadius:0, borderBottomLeftRadius:0 } : null),
                display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                <span style={{fontSize:11.5,fontWeight:on?900:700,color:on?c:T.creamMuted,whiteSpace:"nowrap"}}>
                  {v.emoji} {v.label}
                </span>
                <span style={{fontFamily:SF,fontSize:17,fontWeight:900,color:on?c:(n?T.cream:T.creamMuted)}}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>
        {/* 아랫줄 — 폭은 꽉 채우되(3칸 균등) 높이는 윗줄의 절반쯤.
            윗줄은 라벨과 숫자를 2줄로 쌓고, 아랫줄은 한 줄에 나란히 둔다.
            같은 가로폭이어도 높이와 줄 수가 달라 한눈에 다른 급으로 읽힌다. */}
        <div style={{display:"flex",gap:5,marginTop:5}}>
          {ASIDE_VIEWS.map(v => {
            const n = (groups[v.k]?.ready || []).length;
            const on = view === v.k;
            const c = colorOf(v.color);
            return (
              <button key={v.k} onClick={()=>setView(v.k)} style={{
                flex:1,minWidth:0,padding:"9px 10px",borderRadius:10,cursor:"pointer",fontFamily:S,
                border:`1px solid ${on ? c : T.border}`,
                background: on ? `${c}1f` : "transparent",
                display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
                <span style={{fontSize:12.5,fontWeight:on?900:700,color:on?c:T.creamMuted,whiteSpace:"nowrap"}}>
                  {v.emoji} {v.label}
                </span>
                <span style={{fontFamily:SF,fontSize:15.5,fontWeight:900,color:on?c:(n?T.cream:T.creamMuted)}}>
                  {n}
                </span>
              </button>
            );
          })}
        </div>

        {/* 당일·익일 묶기 — 켜고 끄는 스위치 하나. 탭 자체를 늘리지 않는 이유는 위 DAY_PAIR 주석에.
            항상 자리에 두고 숨기지 않는다. 탭에 따라 나타났다 사라지면 그때마다 아래 목록이
            한 줄씩 밀려, 훑던 자리를 다시 찾아야 한다. */}
        <div style={{display:"flex",alignItems:"center",gap:6,marginTop:6,flexWrap:"wrap"}}>
          <button onClick={toggleMerge}
            title={mergeDays ? "당일과 익일을 다시 따로 봅니다" : "당일과 익일을 한 목록으로 이어서 봅니다"}
            style={{
              padding:"6px 12px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:11.5,fontWeight:800,
              border:`1px ${mergeDays ? "solid" : "dashed"} ${mergeDays ? T.copper : T.border}`,
              background: mergeDays ? T.copperGlow : "transparent",
              color: mergeDays ? T.copper : T.creamMuted}}>
            {mergeDays ? "🔗 당일·익일 묶는 중 — 따로 보기" : "🔗 당일·익일 묶어보기"}
          </button>

          {/* 정렬 — 오른쪽 끝에 붙인다. 묶기와 달리 목록을 훑다 말고 손대는 일이 드물어,
              탭·묶기와 같은 급으로 보이면 안 된다. 두 칸을 다 그려 지금 어느 쪽인지가
              누르기 전에 보이게 한다(한 칸짜리 토글은 눌러봐야 방향을 안다). */}
          <div style={{marginLeft:"auto",display:"flex",gap:4}}>
            {SORT_VIEWS.map(s => {
              const on = sortDir === s.k;
              return (
                <button key={s.k} onClick={()=>pickSort(s.k)} title={s.hint} style={{
                  padding:"6px 11px",borderRadius:20,cursor:"pointer",fontFamily:S,fontSize:11.5,
                  fontWeight: on ? 900 : 700,
                  border:`1px ${on ? "solid" : "dashed"} ${on ? T.copper : T.border}`,
                  background: on ? T.copperGlow : "transparent",
                  color: on ? T.copper : T.creamMuted}}>
                  {s.emoji} {s.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 검색 — 탭 전체를 훑는다. 어느 탭에 있는지 모르는 채로 찾는 경우가 대부분이라
          탭 숫자도 검색 결과에 맞춰 줄어든다(어디 있는지가 숫자로 보인다). */}
      <div style={{display:"flex",gap:6,marginBottom:10}}>
      <div style={{position:"relative",flex:1,minWidth:0}}>
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="🔍 고객명 · 닉네임 · 전화 · 원단 · 주소로 찾기"
          style={{width:"100%",boxSizing:"border-box",padding:"10px 34px 10px 12px",borderRadius:9,
            border:`1px solid ${q ? T.copper : T.border}`,background:T.surface,color:T.cream,
            fontFamily:S,fontSize:13,outline:"none"}}/>
        {search && (
          <button onClick={()=>setSearch("")} aria-label="검색어 지우기" style={{
            position:"absolute",right:6,top:"50%",transform:"translateY(-50%)",
            width:24,height:24,borderRadius:"50%",border:"none",background:"transparent",
            color:T.creamMuted,fontSize:14,cursor:"pointer",lineHeight:1}}>✕</button>
        )}
      </div>
      {kbdBtn("search", { title: "검색" })}
      </div>

      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
        {dayMerged ? (
          <>
            <span style={{fontFamily:SF,fontSize:15,fontWeight:900,color:T.copper}}>
              🟠🔵 당일+익일 {cur.ready.length}건
            </span>
            {/* 합계만 두면 '오늘 반드시 나갈 것'이 몇 건인지가 사라진다 — 내역을 같이 적는다 */}
            <span style={{fontSize:11.5,fontWeight:700,color:T.creamMuted}}>
              당일 {daySplit} · 익일 {cur.ready.length - daySplit}
            </span>
          </>
        ) : (
          <span style={{fontFamily:SF,fontSize:15,fontWeight:900,color:colorOf(curDef.color)}}>
            {curDef.emoji} {curDef.label} {cur.ready.length}건
          </span>
        )}
        {q && <span style={{fontSize:11,fontWeight:800,color:T.copper}}>검색 중</span>}
        <span style={{marginLeft:"auto",fontSize:11,color:T.creamMuted}}>
          {activeManager ? `${activeManager} · ` : ""}{today.getMonth()+1}/{today.getDate()} 기준
        </span>
      </div>

      {view === "done" ? (
        <HandoverPanel rows={handRows} courierById={courierById} nickOf={nickOf}
          onHandover={onHandover} onUnpack={(r)=>setPacked(r, false)} busyKey={busy}
          showToast={showToast} searching={!!q}
          sortHint={sortDir === "new" ? "방금 포장한 것부터" : "먼저 포장한 것부터"}/>
      ) : (
        <>
          {view === "later" && cur.ready.length > 0 && (
            <div style={{fontSize:11.5,color:T.creamMuted,marginBottom:8}}>
              모레 이후 출고 예정 — 여유 있으면 미리 싸두셔도 됩니다
            </div>
          )}
          {view === "hold" && cur.ready.length > 0 && (
            <div style={{fontSize:11.5,color:T.creamMuted,marginBottom:8}}>
              창고에 잡아둔 주문입니다 — 출고 순번에서 빠져 있고, 지연으로 세지 않습니다
            </div>
          )}
          {view === "parked" && cur.ready.length > 0 && (
            <div style={{fontSize:11.5,color:T.creamMuted,marginBottom:8,lineHeight:1.55}}>
              당장 나갈 수 없어 빼둔 주문입니다 — {sortDir === "new" ? "최근 넣은 것부터" : "오래 묵은 것부터"} 위에 있습니다.
              풀리면 <b style={{color:T.cream}}>보류 해제</b>를 눌러 오늘 출고 예정으로 되돌립니다
            </div>
          )}
          {/* 밀린 건은 긴급으로 올라온다 — 몇 건인지 먼저 알린다 */}
          {view === "urgent" && overdueCount > 0 && (
            <div style={{fontSize:12,fontWeight:800,color:T.red,background:T.redBg,
              padding:"8px 11px",borderRadius:8,marginBottom:8,lineHeight:1.5}}>
              🔺 출고예정일이 지난 주문 {overdueCount}건 — 오늘 안에 내보내야 합니다
            </div>
          )}

          {cur.ready.length === 0 ? (
            q ? <SearchMiss/> : (
              <div style={{padding:"36px 12px",textAlign:"center",fontSize:13,color:T.creamMuted}}>
                {dayMerged ? "당일·익일 모두 완료 🎉"
                  : view === "today" ? "오늘 할당량 완료 🎉"
                  : view === "urgent" ? "긴급 건 없음"
                  : view === "hold" ? "보관 중인 주문이 없습니다"
                  : view === "parked" ? "보류함이 비어 있습니다"
                  : "없음"}
              </div>
            )
          ) : cur.ready.map((r, i) => (
            // 묶어 놓으면 어디까지가 오늘 나갈 것인지가 목록에서 사라진다 — 경계에 선을 하나 긋는다.
            // 당일이 0건이면 선이 맨 위에 오는데, 그게 맞다: 남은 게 전부 내일 것이라는 뜻이다.
            <div key={r.key}>
              {dayMerged && i === daySplit && (
                <div style={{display:"flex",alignItems:"center",gap:9,margin:"14px 0 10px"}}>
                  <div style={{flex:1,height:1,background:`${T.blue}55`}}/>
                  <span style={{fontSize:11.5,fontWeight:800,color:T.blue,whiteSpace:"nowrap"}}>
                    🔵 여기부터 익일({tomorrowLabel}) 출고분
                  </span>
                  <div style={{flex:1,height:1,background:`${T.blue}55`}}/>
                </div>
              )}
              <OrderCard row={r}/>
            </div>
          ))}
        </>
      )}

      {/* ── 스캔 창들 ─────────────────────────────────────── */}
      {/* 라벨 QR 을 찍었는데 그 원단의 롤이 여럿(또는 없음) — 어느 롤에서 잘랐는지 묻는 안내창(2026-10-08, 상단 패널에서 옮김).
          화면은 이미 그 주문 카드로 옮겨져 있다(revealRow). 롤 QR 을 찍으면 닫히고, 롤 번호를 눌러도 된다.
          커서는 스캔칸에 그대로 — 안내창에 autoFocus 를 두지 않는다. 거부 배너는 안내창 안에도 보여준다(위 배너는 안내창에 가린다). */}
      {waitRoll && !scanModal && (() => {
        const c = waitRoll.candidate;
        const name = `${c.item.fabric || ""}${c.item.color ? ` ${c.item.color}` : ""}`.trim() || "품목";
        const unit = c.item.unit || "마";
        const pick = (r) => { const p = waitRoll; clearPending(); openConfirm(r, p.product, p.candidate); };
        const override = () => { clearPending(); setOverrideReason(""); setScanModal({ type: "override", row: c.row, order: c.order, item: c.item, itemIdx: c.itemIdx }); };
        const overlay = { position:"fixed",inset:0,zIndex:60,background:"rgba(0,0,0,0.45)",display:"flex",alignItems: kbd ? "flex-start" : "center",justifyContent:"center",padding:16 };
        const box = { width:"100%",maxWidth:440,background:T.card || T.surface,border:`2px solid ${T.copper}`,borderRadius:14,padding:"16px 18px",boxShadow:"0 12px 40px rgba(0,0,0,0.45)",fontFamily:S };
        const chip = { padding:"10px 12px",borderRadius:9,cursor:"pointer",fontFamily:S,fontSize:13.5,fontWeight:800,border:`1px solid ${T.border}`,background:T.surface,color:T.cream,textAlign:"left" };
        return (
          <div style={overlay} onMouseDown={e => { if (e.target === e.currentTarget) clearPending(); }}>
            <div style={box} role="dialog" aria-label="어느 롤에서 잘랐습니까">
              <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:T.cream,marginBottom:4}}>
                {waitRoll.rolls.length ? "어느 롤에서 잘랐습니까?" : "진행 중인 롤이 없습니다"}
              </div>
              <div style={{fontSize:12.5,color:T.creamMuted,marginBottom:10,lineHeight:1.5}}>
                🏷️ <b style={{color:T.cream}}>{c.order.customer}</b> · {name} <b style={{fontFamily:SF,color:T.cream}}>{c.item.qty}{unit}</b>
                <br/>{waitRoll.rolls.length
                  ? `이 원단의 롤이 ${waitRoll.rolls.length}개입니다 — 자른 롤의 QR 을 찍어 주세요. 또는 아래에서 누르세요.`
                  : "롤 QR 을 찍거나 '롤 없이 포장'으로 기록해 주세요."}
              </div>
              {waitRoll.rolls.length > 0 && (
                <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:"45vh",overflowY:"auto"}}>
                  {waitRoll.rolls.map(r => (
                    <button key={r.id} onClick={() => pick(r)} style={chip}>
                      <span style={{fontFamily:"monospace",fontWeight:900,color:T.copper}}>{r.rollCode}</span>
                      <span style={{marginLeft:8}}>잔량 <b style={{fontFamily:SF}}>{fmtLen(r.lengthRemaining)}{waitRoll.product?.unit || unit}</b>{r.location ? ` · ${r.location}` : ""}</span>
                    </button>
                  ))}
                </div>
              )}
              {/* 거부 배너는 화면 맨 위 고정 토스트(zIndex 70)가 이 창 위로 뜬다 */}
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button onClick={override} style={{...chip,borderStyle:"dashed",color:T.creamMuted,fontSize:12.5}}>롤 없이 포장</button>
                <button onClick={clearPending} style={{...chip,marginLeft:"auto",fontSize:12.5}}>취소</button>
              </div>
            </div>
          </div>
        );
      })()}
      {scanModal && (() => {
        const overlay = { position:"fixed",inset:0,zIndex:60,background:"rgba(0,0,0,0.55)",display:"flex",
          alignItems: kbd ? "flex-start" : "center",justifyContent:"center",padding:16 };   // 키보드가 떠 있으면 창을 위로
        const box = { width:"100%",maxWidth:440,background:T.card || T.surface,border:`1px solid ${T.border}`,
          borderRadius:14,padding:"16px 18px",boxShadow:"0 12px 40px rgba(0,0,0,0.45)",fontFamily:S };
        const inp = { width:"100%",boxSizing:"border-box",padding:"11px 12px",borderRadius:9,border:`1px solid ${T.border}`,
          background:T.surface,color:T.cream,fontFamily:S,fontSize:15,outline:"none" };
        const btn = (text, onClick, primary, disabled = false) => (
          <button onClick={onClick} disabled={disabled || scanBusy} style={{
            flex: primary ? 1 : "0 0 auto",padding:"11px 14px",borderRadius:9,fontFamily:S,fontSize:14,fontWeight:900,
            cursor: disabled || scanBusy ? "not-allowed" : "pointer",
            border: primary ? "none" : `1px solid ${T.border}`,
            background: primary ? (disabled ? T.border : `linear-gradient(135deg,${T.copper},${T.copperLight})`) : "transparent",
            color: primary ? (disabled ? T.creamMuted : T.white) : T.creamMuted,opacity: scanBusy ? 0.6 : 1}}>
            {scanBusy && primary ? "처리 중…" : text}
          </button>
        );
        const itemName = (it) => `${it.fabric || ""}${it.color ? ` ${it.color}` : ""}`.trim() || "(품목 없음)";
        const line = (k, v, strong = false) => (
          <div style={{display:"flex",gap:10,padding:"5px 0",borderTop:`1px solid ${T.border}55`,fontSize:13}}>
            <span style={{flex:"0 0 74px",color:T.creamMuted}}>{k}</span>
            <span style={{flex:1,color:T.cream,fontWeight:strong?900:700,fontSize:strong?15:13}}>{v}</span>
          </div>
        );

        if (scanModal.type === "confirm") {
          const { roll, product, candidate: { order, item } } = scanModal;
          const parsed = whole ? { ok: true, value: roll.lengthRemaining } : parseCutLength(cutLen);
          const remaining = roll.lengthRemaining;
          const short = !whole && parsed.ok && remaining !== null && parsed.value > remaining;
          const canGo = parsed.ok && !short;
          return (
            <div style={overlay} onClick={closeScanModal}>
              <div style={box} onClick={e=>e.stopPropagation()}>
                <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:T.cream,marginBottom:8}}>✂️ 재단 확인</div>
                {line("고객", `${order.customer}${nickOf(order) ? ` (${nickOf(order)})` : ""}`, true)}
                {line("품목", itemName(item), true)}
                {line("주문 수량", `${item.qty}${item.unit || "마"}`, true)}
                {line("롤", <span style={{fontFamily:"monospace"}}>{roll.rollCode}</span>)}
                {line("품번", `${product?.code || ""} ${product?.name || ""}${product?.color ? ` ${product.color}` : ""}`)}
                {line("롤 잔량", `${fmtLen(remaining)}${item.unit || "마"}${roll.location ? ` · 위치 ${roll.location}` : ""}`)}
                <div style={{marginTop:12}}>
                  <div style={{fontSize:11.5,fontWeight:800,color:T.creamMuted,marginBottom:5}}>자른 길이 ({item.unit || "마"})</div>
                  <div style={{display:"flex",gap:6}}>
                  <input value={whole ? fmtLen(remaining) : cutLen} onChange={e=>setCutLen(e.target.value)} disabled={whole}
                    inputMode="decimal" autoFocus onKeyDown={e=>{ if (e.key === "Enter" && canGo) submitPack(); if (e.key === "Escape") closeScanModal(); }}
                    style={{...inp,flex:1,minWidth:0,fontFamily:SF,fontSize:20,fontWeight:900,textAlign:"right",
                      borderColor: short ? T.red : parsed.ok ? T.border : T.red,opacity: whole ? 0.6 : 1}}/>
                  {!whole && kbdBtn("cut", { mode: "number", title: `자른 길이 (${item.unit || "마"})` })}
                  </div>
                  {short && <div style={{marginTop:5,fontSize:12,fontWeight:800,color:T.red}}>잔량 부족 — 롤에 {fmtLen(remaining)}{item.unit || "마"}밖에 없습니다</div>}
                  {!whole && !parsed.ok && cutLen.trim() && <div style={{marginTop:5,fontSize:12,fontWeight:800,color:T.red}}>{parsed.reason}</div>}
                  <label style={{display:"flex",alignItems:"center",gap:8,marginTop:10,cursor:"pointer",fontSize:13,fontWeight:800,color:T.cream}}>
                    <input type="checkbox" checked={whole} onChange={e=>setWhole(e.target.checked)} style={{accentColor:T.copper,width:18,height:18}}/>
                    롤 통째 — 남은 {fmtLen(remaining)}{item.unit || "마"} 전부 이 주문으로
                  </label>
                </div>
                <div style={{display:"flex",gap:8,marginTop:14}}>
                  {btn("취소", closeScanModal, false)}
                  {btn(`✂️ ${whole ? fmtLen(remaining) : (parsed.ok ? fmtLen(parsed.value) : "—")}${item.unit || "마"} 재단 확인`, submitPack, true, !canGo)}
                </div>
              </div>
            </div>
          );
        }

        if (scanModal.type === "choose") {
          const { roll, product, candidates } = scanModal;
          return (
            <div style={overlay} onClick={closeScanModal}>
              <div style={box} onClick={e=>e.stopPropagation()}>
                <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:T.cream,marginBottom:4}}>어느 주문의 것입니까?</div>
                <div style={{fontSize:12,color:T.creamMuted,marginBottom:10,lineHeight:1.5}}>
                  <span style={{fontFamily:"monospace",fontWeight:800,color:T.copper}}>{roll.rollCode}</span> · {product?.name}{product?.color ? ` ${product.color}` : ""} — 이 원단을 기다리는 품목이 {candidates.length}개입니다
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:"50vh",overflowY:"auto"}}>
                  {candidates.map((c, i) => (
                    <button key={`${c.order.id}:${c.item.itemId}`} onClick={()=>openConfirm(roll, product, c)} style={{
                      textAlign:"left",padding:"10px 12px",borderRadius:9,border:`1px solid ${T.border}`,background:T.surface,
                      cursor:"pointer",fontFamily:S,color:T.cream}}>
                      <div style={{fontSize:14.5,fontWeight:900}}>{c.order.customer}{nickOf(c.order) ? <span style={{color:T.copper}}> ({nickOf(c.order)})</span> : null}</div>
                      <div style={{fontSize:12.5,marginTop:2}}>{itemName(c.item)} · <b style={{fontFamily:SF}}>{c.item.qty}{c.item.unit || "마"}</b></div>
                    </button>
                  ))}
                </div>
                <div style={{display:"flex",gap:8,marginTop:12}}>{btn("취소", closeScanModal, false)}</div>
              </div>
            </div>
          );
        }

        if (scanModal.type === "unpack") {
          const { order, item, rec } = scanModal;
          const unit = item.unit || "마";
          const code = rec.rollCode || rollById.get(rec.rollId)?.rollCode || "롤";
          return (
            <div style={overlay} onClick={closeScanModal}>
              <div style={box} onClick={e=>e.stopPropagation()}>
                <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:T.cream,marginBottom:4}}>포장 취소</div>
                <div style={{fontSize:12.5,color:T.creamMuted,marginBottom:12,lineHeight:1.6}}>
                  {order.customer} · {itemName(item)} {item.qty}{unit}
                  {rec.rollId && <> — <span style={{fontFamily:"monospace",fontWeight:800,color:T.copper}}>{code}</span> 에서 {fmtLen(rec.length)}{unit}{rec.wholeRoll ? " (롤 통째)" : ""}</>}
                </div>
                {!rec.rollId ? (
                  <>
                    <div style={{fontSize:12.5,color:T.cream,lineHeight:1.6,marginBottom:14}}>롤 없이 포장한 기록입니다. 기록만 지웁니다 — 롤 재고는 바뀌지 않습니다.</div>
                    <div style={{display:"flex",gap:8}}>{btn("닫기", closeScanModal, false)}{btn("기록 지우기", ()=>submitUnpack(false), true)}</div>
                  </>
                ) : rec.wholeRoll ? (
                  <>
                    <div style={{fontSize:12.5,color:T.cream,lineHeight:1.6,marginBottom:14}}>롤 통째로 나가던 품목입니다. 취소하면 <b>{code}</b> 롤이 {fmtLen(rec.length)}{unit} 남은 판매 가능 롤로 되살아납니다.</div>
                    <div style={{display:"flex",gap:8}}>{btn("닫기", closeScanModal, false)}{btn("취소하고 롤 되살리기", ()=>submitUnpack(false), true)}</div>
                  </>
                ) : (
                  <>
                    <div style={{border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 12px",marginBottom:10}}>
                      <div style={{fontSize:13,fontWeight:900,color:T.cream}}>아직 안 잘랐습니다 (잘못 찍음)</div>
                      <div style={{fontSize:11.5,color:T.creamMuted,lineHeight:1.6,margin:"3px 0 8px"}}>{code} 롤에 {fmtLen(rec.length)}{unit}를 되돌립니다.</div>
                      {btn("원래 롤로 되돌리기", ()=>submitUnpack(false), true)}
                    </div>
                    <div style={{border:`1px solid ${T.border}`,borderRadius:10,padding:"10px 12px",marginBottom:12}}>
                      <div style={{fontSize:13,fontWeight:900,color:T.cream}}>이미 잘랐습니다</div>
                      <div style={{fontSize:11.5,color:T.creamMuted,lineHeight:1.6,margin:"3px 0 8px"}}>
                        자른 원단은 원래 롤로 못 돌아갑니다. 같은 품번의 <b style={{color:T.cream}}>조각 롤 {fmtLen(rec.length)}{unit}</b>가 하나 생기고(바로 판매 가능), 라벨이 나옵니다. {code} 잔량은 그대로입니다.
                      </div>
                      <div style={{display:"flex",gap:6,marginBottom:8}}>
                      <input value={unpackReason} onChange={e=>setUnpackReason(e.target.value)}
                        onKeyDown={e=>{ if (e.key === "Enter" && unpackReason.trim()) submitUnpack(true); if (e.key === "Escape") closeScanModal(); }}
                        placeholder="사유 — 예) 주문 취소 · 수량 변경 · 잘못 재단" style={{...inp,flex:1,minWidth:0}}/>
                      {kbdBtn("unpack", { title: "포장 풀기 사유", presets: ["주문 취소", "수량 변경", "잘못 재단"] })}
                      </div>
                      {btn("조각 롤로 입고", ()=>submitUnpack(true), true, !unpackReason.trim())}
                    </div>
                    <div style={{display:"flex",gap:8}}>{btn("닫기", closeScanModal, false)}</div>
                  </>
                )}
              </div>
            </div>
          );
        }

        if (scanModal.type === "override") {
          const { order, item } = scanModal;
          return (
            <div style={overlay} onClick={closeScanModal}>
              <div style={box} onClick={e=>e.stopPropagation()}>
                <div style={{fontFamily:SF,fontSize:17,fontWeight:800,color:T.cream,marginBottom:4}}>롤 없이 포장</div>
                <div style={{fontSize:12,color:T.creamMuted,marginBottom:10,lineHeight:1.5}}>
                  {order.customer} · {itemName(item)} {item.qty}{item.unit || "마"} — 롤 재고에서 빠지지 않습니다. 왜 롤 없이 나가는지 적어 주세요
                </div>
                <div style={{display:"flex",gap:6}}>
                <input value={overrideReason} onChange={e=>setOverrideReason(e.target.value)} autoFocus
                  onKeyDown={e=>{ if (e.key === "Enter") submitOverride(); if (e.key === "Escape") closeScanModal(); }}
                  placeholder="예) 옛 재고 · 외주 원단 · 라벨 없는 롤" style={{...inp,flex:1,minWidth:0}}/>
                {kbdBtn("override", { title: "롤 없이 포장 사유", presets: ["옛 재고", "외주 원단", "라벨 없는 롤", "롤 미등록"] })}
                </div>
                <div style={{display:"flex",gap:8,marginTop:14}}>
                  {btn("취소", closeScanModal, false)}
                  {btn("롤 없이 포장 기록", submitOverride, true, !overrideReason.trim())}
                </div>
              </div>
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
}

export default PackingTab;
