import { useState, useEffect, useMemo, useRef } from "react";
import { Tag, SecTitle, Card, Empty } from "./UI.jsx";
import { SF, S, baseInp, pC, getPayStatus, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { checkOrderLock } from "../lib/managerLock.js";
import { settlePackingBefore, settleMessage } from "../lib/packingGuard.js";

function DepositTab({showToast, customers, orders, setOrders, credits, setCredits, freeShipping = [], setFreeShipping, reloadOrders, managers = [], activeManager = "", preset = null}) {
  const G = useTheme();

  const [sub, setSub] = useState("list");
  const [search, setSearch] = useState("");
  const [payFilter, setPayFilter] = useState("");
  const [depositShowCount, setDepositShowCount] = useState(50);
  const [refundHistShowCount, setRefundHistShowCount] = useState(20);
  const [selectedOrder, setSelectedOrder] = useState(null);

  // 헤더 배지 클릭 등 외부 프리셋 — ts가 바뀔 때마다 (이미 열려 있어도) 필터 적용
  useEffect(() => {
    if (!preset) return;
    setSub("list");
    setSelectedOrder(null);
    setPayFilter(preset.filter || "");
  }, [preset?.ts]);

  // ── 적립금 ──
  const [creditForm, setCreditForm] = useState({customer:"",amount:"",reason:"",memo:""});
  const [expandedCreditId, setExpandedCreditId] = useState(null);
  const [creditSearch, setCreditSearch] = useState("");
  const [showCreditDropdown, setShowCreditDropdown] = useState(false);
  const [creditHistSearch, setCreditHistSearch] = useState("");
  const [creditHistFilter, setCreditHistFilter] = useState("");
  const [creditPage, setCreditPage] = useState(1);
  const CREDIT_PER_PAGE = 10;

  // 적립금 카드에 주문 💬 메모를 같이 보여주기 위한 주문 조회.
  // 활성 주문(orders)에 있으면 그걸 쓰고, 출고완료 등으로 빠진 주문은 펼칠 때 한 번만 가져와 둔다.
  const [creditOrderCache, setCreditOrderCache] = useState({}); // order_id → order | null(없음)
  const findCreditOrder = (c) => {
    if (!c?.order_id) return null;
    return (orders||[]).find(o => o.id === c.order_id) || creditOrderCache[c.order_id] || null;
  };
  useEffect(() => {
    const c = (credits||[]).find(x => x.id === expandedCreditId);
    if (!c?.order_id) return;
    if ((orders||[]).some(o => o.id === c.order_id)) return;
    if (c.order_id in creditOrderCache) return;
    let alive = true;
    db.fetchOrdersByIds([c.order_id])
      .then(rows => { if (alive) setCreditOrderCache(p => ({...p, [c.order_id]: rows[0] || null})); })
      .catch(() => { if (alive) setCreditOrderCache(p => ({...p, [c.order_id]: null})); });
    return () => { alive = false; };
  }, [expandedCreditId]);

  // ── 무료배송권 (적립금과 분리된 신규 상태) ──
  const [benefitType, setBenefitType] = useState("credit"); // "credit" | "freeShipping"
  const [fsCount, setFsCount] = useState("");

  const getCreditBalance = name => (credits||[]).filter(c=>c.customer===name).reduce((sum,c)=>sum+(c.type==="적립"?c.amount:-c.amount),0);

  // ── 입금/처리 입력 ──
  const [payInput, setPayInput] = useState("");
  const [refundInput, setRefundInput] = useState("");
  const [creditInput, setCreditInput] = useState("");

  // ── 처리 내역 (DB) ──
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(null); // orderId loaded

  const getOrderTotal = (o) => {
    if (o.totalAmount > 0) return o.totalAmount;
    return (o.items||[]).reduce((s,i) => s + (i.amount||0), 0);
  };

  const getUnpaid = (o) => {
    if (o._computed) return o._computed.balanceAmount;
    const total = getOrderTotal(o);
    return Math.max(0, total - (o.depositAmount||0) - (o.balanceAmount||0));
  };

  const getPaid = (o) => {
    if (o._computed) return o._computed.depositAmount;
    return (o.depositAmount||0) + (o.balanceAmount||0);
  };

  // ── 필터링된 주문 목록 ──
  // 정산관리 = 출고완료/환불완료/환불(전액 종결) 외 모두 (배포본과 동일)
  // 단, 환불신청은 출고완료여도 처리(환불)가 남아있으므로 항상 표시 — 상단 환불 카운트와 일치시킴
  const filteredOrders = useMemo(() => {
    let list = (orders || []).filter(o => {
      const cs = o._computed?.paymentStatus || o.payment;
      if (o.payment === "환불신청") return true;
      if (o.status === "출고완료") return false;
      if (o.payment === "환불" || cs === "환불완료") return false;
      return true;
    });
    if (payFilter === "환불신청") {
      list = list.filter(o => o.payment==="환불신청");
    } else if (payFilter === "미입금") {
      list = list.filter(o => { const cs=o._computed?.paymentStatus||o.payment; return cs!=="입금완료"; });
    } else if (payFilter === "입금완료") {
      list = list.filter(o => { const cs=o._computed?.paymentStatus||o.payment; return cs==="입금완료"; });
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(o => o.customer.toLowerCase().includes(q) || (o.phone||"").includes(q));
    }
    return list;
  }, [orders, payFilter, search]);

  // KPI
  const kpiTotal = filteredOrders.reduce((s,o) => s + getOrderTotal(o), 0);
  const kpiPaid = filteredOrders.reduce((s,o) => s + getPaid(o), 0);
  const kpiUnpaid = filteredOrders.reduce((s,o) => s + getUnpaid(o), 0);

  // ── selectedOrder 동기화 ──
  useEffect(() => {
    if (selectedOrder) {
      const fresh = orders.find(o => o.id === selectedOrder.id);
      if (fresh) setSelectedOrder(fresh);
    }
  }, [orders]);

  // ── 입금 처리 ──
  const handlePay = async () => {
    if (!selectedOrder) return;
    const amt = parseInt(String(payInput).replace(/[^0-9]/g,""))||0;
    if (amt <= 0) { showToast("금액을 입력해주세요","error"); return; }
    const unpaid = getUnpaid(selectedOrder);
    if (amt > unpaid) { showToast(`미수금(${unpaid.toLocaleString()}원)을 초과할 수 없습니다`,"error"); return; }
    try {
      const log = await db.addPaymentLog(selectedOrder.id, "입금", amt, `입금 ${amt.toLocaleString()}원`, selectedOrder.customer);
      if (log) setHistory(h => [log,...h]);
      setPayInput("");
      const total = getOrderTotal(selectedOrder);
      const logs = await db.fetchOrderLogs(selectedOrder.id);
      const computed = db.calcOrderMoney(logs, total);
      if (computed.paymentStatus === "입금완료") {
        await db.updateOrder(selectedOrder.id, { payment: "입금완료" });
      }
      await reloadOrders();
      showToast(computed.paymentStatus === "입금완료" ? `${amt.toLocaleString()}원 입금 — 완납 처리됨` : `${amt.toLocaleString()}원 입금 처리`);
    } catch(e) { showToast("처리 실패: "+e.message,"error"); }
  };

  // ── 적립금 차감 ──
  const handleCreditUse = async () => {
    if (!selectedOrder) return;
    const lock = checkOrderLock(selectedOrder, activeManager, managers, orders);
    if (lock) { showToast(lock, "error"); return; }
    const amt = parseInt(String(creditInput).replace(/[^0-9]/g,""))||0;
    if (amt <= 0) { showToast("금액을 입력해주세요","error"); return; }
    const bal = getCreditBalance(selectedOrder.customer);
    if (amt > bal) { showToast(`적립금 잔액(${bal.toLocaleString()}원) 부족`,"error"); return; }
    const unpaid = getUnpaid(selectedOrder);
    if (amt > unpaid) { showToast(`미수금(${unpaid.toLocaleString()}원)을 초과할 수 없습니다`,"error"); return; }
    try {
      const saved = await db.insertCredit({customer:selectedOrder.customer, amount:amt, type:"사용", reason:"주문 차감", manager:activeManager, orderId:selectedOrder.id});
      if (saved) setCredits(p => [saved,...p]);
      const log = await db.addPaymentLog(selectedOrder.id, "적립금차감", amt, `적립금 ${amt.toLocaleString()}원 차감`, selectedOrder.customer);
      if (log) setHistory(h => [log,...h]);
      setCreditInput("");
      const total = getOrderTotal(selectedOrder);
      const logs = await db.fetchOrderLogs(selectedOrder.id);
      const computed = db.calcOrderMoney(logs, total);
      if (computed.paymentStatus === "입금완료") {
        await db.updateOrder(selectedOrder.id, { payment: "입금완료" });
      }
      await reloadOrders();
      showToast(`적립금 ${amt.toLocaleString()}원 차감${computed.paymentStatus==="입금완료"?" — 완납 처리됨":""}`);
    } catch(e) { showToast("차감 실패","error"); }
  };

  // ── 환불 처리 (현금환불 / 적립금전환) ──
  const handleRefund = async (mode) => {
    if (!selectedOrder) return;
    const lock = checkOrderLock(selectedOrder, activeManager, managers, orders);
    if (lock) { showToast(lock, "error"); return; }
    const amt = parseInt(String(refundInput).replace(/[^0-9]/g,""))||0;
    if (amt <= 0) { showToast("금액을 입력해주세요","error"); return; }
    const paid = getPaid(selectedOrder);
    if (amt > paid) { showToast(`입금액(${paid.toLocaleString()}원)을 초과할 수 없습니다`,"error"); return; }
    const label = mode === "cash" ? "현금환불" : "적립금전환";
    if (!window.confirm(`${amt.toLocaleString()}원 ${label} 하시겠습니까?`)) return;

    let packMsg = "";
    try {
      // 사용된 적립금 조회 (복원량 계산 — 실제 복원은 전액환불일 때만, 아래 computed 게이트)
      const logs = await db.fetchOrderLogs(selectedOrder.id);
      // 전액 환불이 되는 건이면 포장대에서 잘라 둔 원단부터 묻는다 — 환불로 주문이 포장 목록에서
      // 빠지면 기록과 잘린 원단이 조용히 남는다(2026-10-13 점검). 로그를 쓰기 *전에* 묻는다 —
      // 돌아가기를 골랐을 때 환불 로그만 남는 일이 없어야 한다.
      const willBeFull = db.calcOrderMoney([...logs, { type: label, amount: amt }], getOrderTotal(selectedOrder), selectedOrder.payment).paymentStatus === "환불완료";
      if (willBeFull) {
        const settled = await settlePackingBefore(selectedOrder.id, { what: "환불 처리", by: activeManager });
        if (!settled) { showToast("환불을 중단했습니다"); return; }
        packMsg = settleMessage(settled);
      }
      let creditUsed = 0;
      for (const l of logs) {
        if (l.type === "적립금차감") creditUsed += (l.amount||0);
        if (l.type === "적립금복원") creditUsed -= (l.amount||0);
      }

      // 환불 로그 추가
      const log = await db.addPaymentLog(selectedOrder.id, label, amt, `${label} ${amt.toLocaleString()}원`, selectedOrder.customer);
      if (log) setHistory(h => [log,...h]);

      // 적립금전환 시 적립금 추가
      if (mode === "credit") {
        const saved = await db.insertCredit({customer:selectedOrder.customer, amount:amt, type:"적립", reason:"환불→적립금 전환", manager:activeManager, orderId:selectedOrder.id});
        if (saved) setCredits(p => [saved,...p]);
      }

      setRefundInput("");
      // 전액환불만 주문을 종결(대시보드 완료 목록 이동)으로 처리.
      // 부분환불은 정산관리에 남아서 계속 진행됨 (출고, 추가 입금, 환불 취소 등).
      const total = getOrderTotal(selectedOrder);
      const updatedLogs = await db.fetchOrderLogs(selectedOrder.id);
      // fallbackPayment(3번째 인자) 필수 — 입금로그 없는 주문(주문입력에서 바로 '입금완료'로
      // 만든 건 등)은 이게 없으면 rawDeposit=0으로 계산돼 부분환불도 '환불완료'로 오판된다.
      const computed = db.calcOrderMoney(updatedLogs, total, selectedOrder.payment);
      // 사용 적립금 복원 — 배송권과 정책 통일: "전액환불(환불완료)"일 때만 복원.
      // 부분환불은 주문이 정산관리에 계속 남아 진행되므로 사용 적립금을 유지한다.
      if (creditUsed > 0 && computed.paymentStatus === "환불완료") {
        await db.addPaymentLog(selectedOrder.id, "적립금복원", creditUsed, "환불로 적립금 복원", selectedOrder.customer);
        const saved = await db.insertCredit({customer:selectedOrder.customer, amount:creditUsed, type:"적립", reason:"환불로 복원", manager:activeManager, orderId:selectedOrder.id});
        if (saved) setCredits(p => [saved,...p]);
      }
      // 환불 발생 시 합배송 그룹에서 자동 제외 (다른 그룹원은 유지)
      const baseUpdate = selectedOrder.mergeGroupId ? { merge_group_id: null } : {};
      // 승인 처리 완료 시 환불신청 정보(refund_request)는 비운다.
      // 대신 refund_history에 신청 내용(계좌·사유·신청일)+처리 결과를 보존 (대시보드 기록용).
      const archived = db.archiveRefundRequest(selectedOrder, "승인", { resolvedMethod: label, resolvedAmount: amt });
      if (computed.paymentStatus === "환불완료") {
        await db.updateOrder(selectedOrder.id, { payment: "환불", refund_note: label, refund_request: null, ...archived, ...baseUpdate });
      } else {
        // 부분환불 — 환불신청 경유 건이면 신청 플래그 해제 (라벨/상단 카운트가 '부분환불'로 정확히 반영되도록).
        // payment_status는 _computed가 부분환불을 계산하므로 paid로 두어 레거시 표시와 충돌 방지.
        const partialFields = { refund_note: label, refund_request: null, ...archived, ...baseUpdate };
        if (selectedOrder.payment === "환불신청") { partialFields.payment = "입금완료"; partialFields.payment_status = "paid"; }
        await db.updateOrder(selectedOrder.id, partialFields);
      }
      await reloadOrders();
      // 무료배송권 복원 — 적립금과 분리: "전액환불(환불완료)"일 때만 1장 환원.
      // 부분환불은 주문이 정산관리에 계속 남아 진행되므로 배송권을 유지한다.
      // (환불취소 undo는 그대로 — restore 로그가 있을 때만 회수하므로 부분환불엔 무영향)
      let fsMsg = "";
      if (selectedOrder.freeShippingUsed && computed.paymentStatus === "환불완료") {
        try {
          const nc = await db.restoreFreeShippingForRefund(selectedOrder.customer, selectedOrder.id);
          if (nc !== null) { await reloadFreeShipping(); fsMsg = " · 무료배송권 1장 복원"; }
        } catch (err) { console.warn("무료배송권 복원 실패:", err); }
      }
      showToast(`${amt.toLocaleString()}원 ${label} 처리${fsMsg}${packMsg}`);
    } catch(e) { showToast("환불 실패: "+e.message,"error"); }
  };

  // ── 환불 신청 반려 ──
  // 대표가 직원의 환불 신청을 거절 — 입금완료로 되돌리고 신청정보를 비운다.
  // 반려 사유(선택)를 적으면 공유 담당자 메모에 남겨 직원이 확인할 수 있게 함.
  const [rejectReason, setRejectReason] = useState("");
  const handleRejectRefund = async () => {
    if (!selectedOrder) return;
    const lock = checkOrderLock(selectedOrder, activeManager, managers, orders);
    if (lock) { showToast(lock, "error"); return; }
    if (!window.confirm("이 환불 신청을 반려하고 입금완료 상태로 되돌릴까요?")) return;
    try {
      const reason = rejectReason.trim();
      // 반려된 신청도 이력으로 보존 — 계좌·사유·신청일이 대시보드 기록에 남는다.
      const archived = db.archiveRefundRequest(selectedOrder, "반려", reason ? { rejectReason: reason } : {});
      const fields = { payment: "입금완료", payment_status: "paid", refund_request: null, ...archived };
      if (reason) {
        const prev = (selectedOrder.memo || "").trim();
        fields.memo = `🔴 환불반려: ${reason}${prev ? `\n${prev}` : ""}`;
      }
      await db.updateOrder(selectedOrder.id, fields);
      setRejectReason("");
      await reloadOrders();
      showToast("환불 신청 반려 — 입금완료로 복원");
    } catch (e) { showToast("반려 실패: " + e.message, "error"); }
  };

  // 환불신청 건을 열면 신청 금액을 환불 입력칸에 자동으로 채워준다 (대표가 조정 후 승인).
  useEffect(() => {
    const rr = selectedOrder?.refundRequest;
    if (rr && selectedOrder.payment === "환불신청" && rr.amount > 0) {
      setRefundInput(String(rr.amount));
    }
  }, [selectedOrder?.id]);

  // ── 환불 취소 ──
  // 주문의 환불 관련 로그/credits를 정리하고 payment를 "입금완료"로 되돌림.
  const handleCancelRefund = async () => {
    if (!selectedOrder) return;
    const lock = checkOrderLock(selectedOrder, activeManager, managers, orders);
    if (lock) { showToast(lock, "error"); return; }
    try {
      const logs = await db.fetchOrderLogs(selectedOrder.id);
      const cashRefunds = logs.filter(l => l.type === "현금환불");
      const creditRefunds = logs.filter(l => l.type === "적립금전환");
      const creditRestores = logs.filter(l => l.type === "적립금복원");
      const totalRefund = [...cashRefunds, ...creditRefunds].reduce((s,l)=>s+(l.amount||0), 0);
      if (totalRefund <= 0) { showToast("취소할 환불 내역이 없습니다","error"); return; }
      if (!window.confirm(`환불 ${totalRefund.toLocaleString()}원을 취소하고 입금완료 상태로 되돌리시겠습니까?`)) return;

      await db.deletePaymentLogsByType(selectedOrder.id, "현금환불");
      await db.deletePaymentLogsByType(selectedOrder.id, "적립금전환");
      await db.deletePaymentLogsByType(selectedOrder.id, "적립금복원");
      for (const l of creditRefunds) {
        await db.deleteCreditsByReason(selectedOrder.customer, "환불→적립금 전환", l.amount||0);
      }
      for (const l of creditRestores) {
        await db.deleteCreditsByReason(selectedOrder.customer, "환불로 복원", l.amount||0);
      }
      await db.updateOrder(selectedOrder.id, { payment: "입금완료", refund_note: "" });

      const freshCredits = await db.fetchCredits();
      setCredits(freshCredits);
      await reloadOrders();
      if (historyLoaded === selectedOrder.id) {
        const freshLogs = await db.fetchOrderLogs(selectedOrder.id);
        setHistory(freshLogs);
      }
      // 무료배송권 복원분 회수 (환불 취소 = 환불로 환원했던 1장 되돌리기)
      let fsMsg = "";
      if (selectedOrder.freeShippingUsed) {
        try {
          const nc = await db.undoFreeShippingRestoreForRefund(selectedOrder.customer, selectedOrder.id);
          if (nc !== null) { await reloadFreeShipping(); fsMsg = " · 무료배송권 복원분 회수"; }
        } catch (err) { console.warn("무료배송권 복원분 회수 실패:", err); }
      }
      showToast(`환불 ${totalRefund.toLocaleString()}원 취소 — 입금완료로 복원${fsMsg}`);
    } catch(e) { showToast("환불 취소 실패: "+e.message,"error"); }
  };

  // ── 적립금·배송권 버튼 잠금 ─────────────────────────────────────────
  // 발급 버튼을 같은 초에 세 번 누르면 요청 셋이 한꺼번에 나갔다 — 원장에는 issue 3건,
  // 보유는 서로 덮어써서 2. 사람이 그걸 보고 1장 회수하니 보유 1 vs 원장합 2 로 굳었다
  // (노미혜, 9/7). 출고완료 버튼과 같은 이치다(397ed24): 요청이 나가 있는 동안은
  // 잠그고, 잠겨 있을 때 온 클릭은 버린다.
  // ref 로 잠그는 이유: 같은 틱 안의 연타는 state 갱신보다 빨라서 state 검사는 둘 다 통과한다.
  // state(benefitBusy)는 버튼을 회색으로 보이게 하는 용도다.
  const benefitLock = useRef(false);
  const [benefitBusy, setBenefitBusy] = useState(false);
  const runLocked = async (fn) => {
    if (benefitLock.current) return; // 두 번째 클릭은 무시
    benefitLock.current = true;
    setBenefitBusy(true);
    try { await fn(); }
    finally { benefitLock.current = false; setBenefitBusy(false); }
  };

  // ── 적립금 등록 ──
  const addCredit = () => runLocked(async () => {
    const input=creditForm.customer.trim();
    if(!input||!creditForm.amount){showToast("고객명과 금액은 필수입니다","error");return;}
    // 저장된 고객명에 앞뒤 공백이 섞여 있어도 매칭되도록 양쪽 trim 비교.
    // 적립금은 고객 '실제 이름'으로 저장해야 잔액 조회(getBalance)와 키가 일치한다.
    const cust=customers.find(c=>(c.name||"").trim()===input);
    if(!cust){showToast("등록되지 않은 고객입니다","error");return;}
    const amount=parseInt(String(creditForm.amount).replace(/,/g,""))||0;
    if(amount<=0){showToast("금액을 입력해주세요","error");return;}
    try{
      // 사유를 비워도 카드에 "—"가 아니라 "직접 적립"이 남는다 — 회수 쪽("적립금 회수")과 대칭
      const saved=await db.insertCredit({customer:cust.name,amount,type:"적립",reason:creditForm.reason.trim()||"직접 적립",manager:activeManager,memo:creditForm.memo.trim()});
      if(saved) setCredits(p=>[saved,...p]);
      setCreditForm({customer:"",amount:"",reason:"",memo:""});
      setCreditSearch("");
      showToast("적립금 등록 완료!");
    }catch(e){showToast("저장 실패","error");}
  });

  // ── 적립금 회수 — 등록과 대칭. type:"사용"으로 기록해 잔액에서 차감 (주문취소 회수와 동일 방식) ──
  const reclaimCredit = () => runLocked(async () => {
    const input=creditForm.customer.trim();
    if(!input||!creditForm.amount){showToast("고객명과 금액은 필수입니다","error");return;}
    const cust=customers.find(c=>(c.name||"").trim()===input);
    if(!cust){showToast("등록되지 않은 고객입니다","error");return;}
    const amount=parseInt(String(creditForm.amount).replace(/,/g,""))||0;
    if(amount<=0){showToast("금액을 입력해주세요","error");return;}
    const bal=getCreditBalance(cust.name);
    if(amount>bal){showToast(`적립금 잔액(${bal.toLocaleString()}원)보다 많이 회수할 수 없습니다`,"error");return;}
    if(!window.confirm(`${cust.name}님의 적립금 ${amount.toLocaleString()}원을 회수하시겠습니까?\n잔액 ${bal.toLocaleString()}원 → ${(bal-amount).toLocaleString()}원`)) return;
    try{
      const r=creditForm.reason.trim();
      const saved=await db.insertCredit({customer:cust.name,amount,type:"사용",reason:r?`회수 — ${r}`:"적립금 회수",manager:activeManager,memo:creditForm.memo.trim()});
      if(saved) setCredits(p=>[saved,...p]);
      setCreditForm({customer:"",amount:"",reason:"",memo:""});
      setCreditSearch("");
      showToast(`적립금 ${amount.toLocaleString()}원 회수 완료 (잔액 ${(bal-amount).toLocaleString()}원)`);
    }catch(e){showToast("저장 실패","error");}
  });

  // ── 무료배송권 발급/회수 (적립금 로직과 완전히 분리) ──
  const reloadFreeShipping = async () => {
    try { const data = await db.getAllFreeShipping(); setFreeShipping?.(data); } catch {}
  };

  const handleFreeShippingIssue = () => runLocked(async () => {
    const input = creditForm.customer.trim();
    if (!input) { showToast("고객명을 선택해주세요","error"); return; }
    const cust = customers.find(c=>(c.name||"").trim()===input);
    if (!cust) { showToast("등록되지 않은 고객입니다","error"); return; }
    const name = cust.name;
    const count = parseInt(String(fsCount).replace(/[^0-9]/g,""))||0;
    if (count<=0) { showToast("수량을 입력해주세요","error"); return; }
    try {
      const newCount = await db.adjustFreeShipping(name, count);
      setFsCount("");
      setCreditForm({customer:"",amount:"",reason:"",memo:""});
      setCreditSearch("");
      await reloadFreeShipping();
      showToast(`${name}님 무료배송권 ${count}장 발급 (총 ${newCount}장)`);
    } catch(e) { showToast("발급 실패: "+e.message,"error"); }
  });

  const handleFreeShippingCancel = () => runLocked(async () => {
    const input = creditForm.customer.trim();
    if (!input) { showToast("고객명을 선택해주세요","error"); return; }
    const cust = customers.find(c=>(c.name||"").trim()===input);
    if (!cust) { showToast("등록되지 않은 고객입니다","error"); return; }
    const name = cust.name;
    const count = parseInt(String(fsCount).replace(/[^0-9]/g,""))||0;
    if (count<=0) { showToast("수량을 입력해주세요","error"); return; }
    if (!window.confirm(`${name}님의 무료배송권 ${count}장을 회수하시겠습니까?`)) return;
    try {
      const newCount = await db.adjustFreeShipping(name, -count);
      setFsCount("");
      await reloadFreeShipping();
      showToast(`무료배송권 ${count}장 회수 (총 ${newCount}장)`);
    } catch(e) { showToast("회수 실패: "+e.message,"error"); }
  });

  const subTabs=[{k:"list",l:"📋 현황"},{k:"credit",l:"🎁 적립금 & 배송권 관리"}];

  return (
    <div>
      {/* 모바일(≤520px) 전용 레이아웃 — PC(>520px)는 인라인 스타일 그대로.
          - dep-kpi: 상단 KPI 3타일의 금액이 칸 폭을 넘어 화면 밖으로 밀리던 것 → 칸 고정(minmax 0) + 폰트 축소
          - dep-amt4: 상세 금액카드 4열이 좁은 화면에서 넘치므로 2×2로
          - dep-ogrid: 6열 고정폭 목록(고정영역 ~312px)이 고객/원단 열을 12px까지 짓누르던 것 → 3열×2행 재배치 */}
      <style>{`
        @media (max-width: 520px) {
          .dep-kpi { grid-template-columns: repeat(3, minmax(0,1fr)) !important; }
          .dep-kpi-val { font-size: 12px !important; }
          .dep-amt4 { grid-template-columns: 1fr 1fr !important; }
          .dep-ogrid {
            grid-template-columns: minmax(0, 1fr) auto auto !important;
            grid-template-areas: "cust date stat" "total paid unpaid";
            gap: 3px 10px !important;
          }
          .dep-oc-date  { grid-area: date; text-align: right; align-self: center; }
          .dep-oc-cust  { grid-area: cust; }
          .dep-oc-total { grid-area: total; }
          .dep-oc-paid  { grid-area: paid; }
          .dep-oc-unpaid{ grid-area: unpaid; }
          .dep-oc-stat  { grid-area: stat; align-self: center; }
        }
      `}</style>
      <div style={{fontFamily:SF,fontSize:22,fontWeight:800,marginBottom:16,color:G.cream}}>정산관리</div>

      {/* KPI */}
      <div className="dep-kpi" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
        {[
          {l:"총금액",v:kpiTotal,c:G.copper},
          {l:"입금액",v:kpiPaid,c:G.blue},
          {l:"미수금",v:kpiUnpaid,c:kpiUnpaid>0?G.red:G.green},
        ].map(s=>(
          <div key={s.l} style={{background:G.card,borderRadius:12,border:`1px solid ${G.border}`,boxShadow:G.cardShadow,padding:"12px 10px",textAlign:"center"}}>
            <div className="dep-kpi-val" style={{fontWeight:900,fontSize:14,color:s.c}}>{s.v.toLocaleString()}<span style={{fontSize:9,color:G.creamMuted}}>원</span></div>
            <div style={{fontSize:10,color:G.creamMuted,marginTop:4}}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* 서브탭 */}
      <div style={{display:"flex",gap:0,background:G.subtleBg,borderRadius:10,padding:3,marginBottom:14}}>
        {subTabs.map(t=>(
          <button key={t.k} className="dep-subtab" onClick={()=>{setSub(t.k);setSelectedOrder(null);}} style={{
            flex:1,padding:"9px 4px",borderRadius:8,border:"none",cursor:"pointer",
            fontFamily:S,fontWeight:sub===t.k?800:500,fontSize:12,
            background:sub===t.k?G.copper:"transparent",
            color:sub===t.k?"#fff":G.creamMuted,transition:"all .15s"
          }}>{t.l}</button>
        ))}
      </div>

      {/* ══════════ 현황 목록 ══════════ */}
      {sub==="list" && !selectedOrder && (
        <div>
          {/* 필터 */}
          <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
            {["","미입금","입금완료","환불신청"].map(f=>(
              <button key={f} onClick={()=>setPayFilter(f)} style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${payFilter===f?(f==="환불신청"?G.red:G.copper):G.border}`,background:payFilter===f?(f==="환불신청"?G.redBg:G.copperGlow):"transparent",color:payFilter===f?(f==="환불신청"?G.red:G.copper):G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:payFilter===f?700:400}}>
                {f||"전체"}{f==="환불신청"?` (${(orders||[]).filter(o=>o.payment==="환불신청").length})`:""}
              </button>
            ))}
          </div>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="고객명 / 연락처 검색" style={{...baseInp,marginBottom:10,background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>

          {filteredOrders.length===0 ? (
            payFilter==="환불신청"
              ? <Empty text="대기 중인 환불 신청이 없습니다" sub="처리된 내역은 아래에서 확인할 수 있어요"/>
              : <Empty text="주문이 없습니다" sub="필터를 조정해보세요"/>
          ) : (
            <Card style={{padding:0,overflow:"hidden"}}>
              <div className="dep-ogrid" style={{display:"grid",gridTemplateColumns:"54px 1fr 62px 62px 62px 62px",gap:2,padding:"8px 10px",fontSize:9,fontWeight:700,color:G.creamMuted,borderBottom:`1px solid ${G.border}`,textTransform:"uppercase",letterSpacing:"0.04em"}}>
                <span className="dep-oc-date">날짜</span><span className="dep-oc-cust">고객/원단</span><span className="dep-oc-total" style={{textAlign:"right"}}>총금액</span><span className="dep-oc-paid" style={{textAlign:"right"}}>입금액</span><span className="dep-oc-unpaid" style={{textAlign:"right"}}>미수금</span><span className="dep-oc-stat" style={{textAlign:"center"}}>상태</span>
              </div>

              {filteredOrders.slice(0, depositShowCount).map(o => {
                const total = getOrderTotal(o);
                const paid = getPaid(o); // 입금액 = 환불 차감 후 순액 (환불만큼 조정 반영)
                const unpaid = getUnpaid(o);
                const fabrics = (o.items||[]).map(i=>i.fabric).join(", ");

                return (
                  <div key={o.id} onClick={async()=>{setSelectedOrder(o);setPayInput("");setRefundInput("");setCreditInput("");if(historyLoaded!==o.id){try{const logs=await db.fetchPaymentLogs(o.id);setHistory(logs);setHistoryLoaded(o.id);}catch{setHistory([]);}}}}
                    className="dep-ogrid" style={{display:"grid",gridTemplateColumns:"54px 1fr 62px 62px 62px 62px",gap:2,padding:"10px 10px",fontSize:11,cursor:"pointer",alignItems:"center",borderBottom:`1px solid ${G.border}`,transition:"background 0.15s"}}
                    onMouseEnter={e=>e.currentTarget.style.background=G.subtleBg}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <span className="dep-oc-date" style={{fontSize:10,color:G.creamMuted}}>{o.date?.replace(/\.\s?/g,".").replace(/\.$/,"").slice(-5)}</span>
                    <div className="dep-oc-cust" style={{overflow:"hidden"}}>
                      <div style={{fontWeight:600,fontSize:11,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{o.customer}</div>
                      <div style={{fontSize:9,color:G.creamMuted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{fabrics||"—"}</div>
                    </div>
                    <span className="dep-oc-total" style={{textAlign:"right",fontWeight:700,fontFamily:SF,fontSize:10,color:G.copper}}>{total>0?total.toLocaleString():"-"}</span>
                    <span className="dep-oc-paid" style={{textAlign:"right",fontSize:10,color:paid>0?G.blue:G.creamMuted}}>{paid>0?paid.toLocaleString():"-"}</span>
                    <span className="dep-oc-unpaid" style={{textAlign:"right",fontSize:10,fontWeight:700,color:unpaid>0?G.red:G.green}}>{unpaid>0?unpaid.toLocaleString():"0"}</span>
                    {(()=>{const dp=getPayStatus(o);const label=dp==="입금완료"?"완료":dp==="부분입금"?"부분입금":dp==="부분환불"?"부분환불":dp==="환불완료"||dp==="환불"?"환불":dp==="환불신청"?"환불신청":"미입금";return <span className="dep-oc-stat" style={{textAlign:"center"}}><Tag c={pC(dp,G)[0]} bg={pC(dp,G)[1]}>{label}</Tag></span>;})()}
                  </div>
                );
              })}
            </Card>
          )}

          {filteredOrders.length > depositShowCount && (
            <button onClick={()=>setDepositShowCount(c=>c+50)} style={{width:"100%",padding:10,borderRadius:10,border:`1px solid ${G.border}`,background:G.surface,color:G.creamMuted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:S,marginTop:8}}>
              더 보기 ({depositShowCount}/{filteredOrders.length}건)
            </button>
          )}
          {filteredOrders.length > 0 && (
            <Card style={{marginTop:10,padding:"10px 14px"}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,fontWeight:600}}>
                <span style={{whiteSpace:"nowrap"}}>합계 <span style={{fontFamily:SF,fontWeight:800,color:G.copper}}>{filteredOrders.length}</span><span style={{fontSize:10,color:G.creamMuted}}>건</span></span>
                <span style={{whiteSpace:"nowrap"}}>미수금 <span style={{fontFamily:SF,fontWeight:800,color:G.red}}>{filteredOrders.reduce((s,o)=>s+getUnpaid(o),0).toLocaleString()}</span><span style={{fontSize:10,color:G.creamMuted}}>원</span></span>
              </div>
            </Card>
          )}

          {/* ── 환불 처리 내역 (환불신청 필터 전용) ──
              승인/반려된 신청 이력(refund_history) + 신청 없이 대표가 직접 처리한 환불 건.
              처리 후 목록에서 사라지던 신청 건을 여기서 계속 확인할 수 있다. */}
          {payFilter==="환불신청" && (()=>{
            const q = search.trim().toLowerCase();
            const entries = [];
            for (const o of orders||[]) {
              if (q && !(o.customer.toLowerCase().includes(q) || (o.phone||"").includes(q))) continue;
              const hist = Array.isArray(o.refundHistory) ? o.refundHistory : [];
              hist.forEach((h,i)=>entries.push({...h, customer:o.customer, orderId:o.id, _k:`${o.id}-${i}`}));
              // 신청 이력이 없는 환불 건(직접 처리) — 방식·금액만 기록되어 있음
              const directAmt = o._computed?.refundAmount ?? o.refundAmount ?? 0;
              if (hist.length===0 && (directAmt>0 || o.payment==="환불")) {
                entries.push({result:"직접환불", amount:directAmt, resolvedMethod:o.refundNote||"", customer:o.customer, orderId:o.id, orderDate:o.date, _k:`${o.id}-direct`});
              }
            }
            const ts = e => e.processedAt ? new Date(e.processedAt).getTime()
              : e.requestedAt ? new Date(e.requestedAt).getTime()
              : e.orderDate ? (new Date(String(e.orderDate).replace(/\.\s?/g,"/").replace(/\/$/,"")).getTime()||0) : 0;
            entries.sort((a,b)=>ts(b)-ts(a));
            const RES_COLORS = {"승인":[G.green,G.greenBg],"반려":[G.red,G.redBg],"취소":[G.creamMuted,G.subtleBg],"직접환불":[G.blue,G.blueBg]};
            const fmtDT = iso => iso ? new Date(iso).toLocaleString("ko-KR",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "";
            return (
              <div style={{marginTop:18}}>
                <div style={{fontSize:12,fontWeight:800,color:G.creamMuted,marginBottom:8,letterSpacing:".04em"}}>💸 환불 처리 내역 <span style={{fontFamily:SF,color:G.copper}}>{entries.length}</span><span style={{fontWeight:400}}>건</span></div>
                {entries.length===0 ? (
                  <div style={{textAlign:"center",padding:"16px 0",color:G.creamMuted,fontSize:12}}>처리된 환불 내역이 없습니다</div>
                ) : (
                  <>
                    <Card style={{padding:0,overflow:"hidden"}}>
                      {entries.slice(0,refundHistShowCount).map((r,i)=>{
                        const [rc,rbg] = RES_COLORS[r.result]||[G.creamMuted,G.subtleBg];
                        const ord = (orders||[]).find(x=>x.id===r.orderId);
                        return (
                          <div key={r._k}
                            onClick={async()=>{if(!ord)return;setSelectedOrder(ord);setPayInput("");setRefundInput("");setCreditInput("");if(historyLoaded!==ord.id){try{const logs=await db.fetchPaymentLogs(ord.id);setHistory(logs);setHistoryLoaded(ord.id);}catch{setHistory([]);}}}}
                            style={{padding:"10px 12px",borderTop:i>0?`1px solid ${G.border}`:"none",cursor:ord?"pointer":"default",fontSize:11,transition:"background 0.15s"}}
                            onMouseEnter={e=>e.currentTarget.style.background=G.subtleBg}
                            onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                            <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                              <span style={{fontSize:9,fontWeight:800,color:rc,background:rbg,padding:"1px 7px",borderRadius:10,border:`1px solid ${rc}40`}}>{r.result}</span>
                              <span style={{fontWeight:700,color:G.cream,fontSize:12}}>{r.customer}</span>
                              {r.method && <span style={{fontWeight:700,color:r.method==="credit"?G.purple:G.red}}>{r.method==="credit"?"🪙 적립금":"💵 현금"}</span>}
                              {r.kind && <span style={{color:G.copper,fontWeight:700}}>{r.kind==="full"?"전액":"부분"}</span>}
                              <span style={{fontFamily:SF,fontWeight:800,color:G.red}}>{((r.result==="승인"&&r.resolvedAmount>0?r.resolvedAmount:r.amount)||0).toLocaleString()}원</span>
                              <span style={{marginLeft:"auto",fontSize:10,color:G.creamMuted,fontFamily:SF}}>{r.processedAt?fmtDT(r.processedAt):String(r.orderDate||"").trim()}</span>
                            </div>
                            {(r.bank||r.accountNumber||r.accountHolder) && (
                              <div style={{marginTop:3,color:G.cream}}>
                                🏦 {r.bank||"은행 미기입"} <span style={{fontFamily:SF,fontWeight:700}}>{r.accountNumber||"계좌번호 미기입"}</span>
                                {r.accountHolder && <span style={{color:G.creamMuted}}> · {r.accountHolder}</span>}
                              </div>
                            )}
                            {r.reason && <div style={{marginTop:2,color:G.creamMuted}}>💬 {r.reason}</div>}
                            {r.result==="반려" && r.rejectReason && <div style={{marginTop:2,color:G.red}}>반려 사유: {r.rejectReason}</div>}
                            {(r.resolvedMethod||r.requestedBy||r.requestedAt) && (
                              <div style={{marginTop:2,fontSize:10,color:G.creamMuted}}>
                                {r.resolvedMethod||""}
                                {r.requestedBy?`${r.resolvedMethod?" · ":""}신청 ${r.requestedBy}`:""}
                                {r.requestedAt?` ${fmtDT(r.requestedAt)}`:""}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </Card>
                    {entries.length > refundHistShowCount && (
                      <button onClick={()=>setRefundHistShowCount(c=>c+20)} style={{width:"100%",padding:10,borderRadius:10,border:`1px solid ${G.border}`,background:G.surface,color:G.creamMuted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:S,marginTop:8}}>
                        더 보기 ({refundHistShowCount}/{entries.length}건)
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* ══════════ 주문 상세 패널 ══════════ */}
      {sub==="list" && selectedOrder && (()=>{
        const o = selectedOrder;
        const total = getOrderTotal(o);
        const paid = getPaid(o); // 환불 차감 후 순입금 (표시 · 환불 한도 체크 공용)
        const creditBal = getCreditBalance(o.customer);
        const unpaid = getUnpaid(o);
        const refund = o._computed?.refundAmount ?? o.refundAmount ?? 0;
        const creditUsed = o._computed?.creditUsed ?? 0;
        const displayPay = getPayStatus(o);
        const cust = customers.find(c=>c.name===o.customer);
        const orderHistory = history.filter(h=>(h.order_id||h.order)===o.id);
        // 환불신청 건이면 직원이 신청한 방식(현금/적립금)을 승인 버튼에 강조
        const reqMethod = o.payment==="환불신청" ? o.refundRequest?.method : null;

        return (
          <div>
            <button onClick={()=>setSelectedOrder(null)} style={{display:"flex",alignItems:"center",gap:4,marginBottom:12,padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:S}}>
              ← 목록으로
            </button>

            {/* 고객 + 주문 정보 */}
            <Card style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <span style={{fontFamily:SF,fontSize:18,fontWeight:800,color:G.cream}}>{o.customer}</span>
                <Tag c={pC(displayPay,G)[0]} bg={pC(displayPay,G)[1]}>{displayPay}</Tag>
              </div>
              <div style={{fontSize:11,color:G.creamMuted,marginBottom:8}}>
                {o.date} {o.time&&`· ${o.time}`}
                {(o.phone||cust?.phone)&&` · ${o.phone||cust?.phone}`}
              </div>

              {/* 주문 아이템 */}
              <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:10}}>
                {(o.items||[]).map((item,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 10px",background:G.surface,borderRadius:8,border:`1px solid ${G.border}`,fontSize:12}}>
                    {item.itemNo&&<span style={{color:G.copper,fontFamily:"monospace",fontWeight:700,fontSize:11}}>{item.itemNo.toUpperCase()}</span>}
                    <span style={{flex:1}}><span style={{fontWeight:600}}>{item.fabric}</span>{item.color&&<span style={{color:G.creamMuted,marginLeft:4}}>{item.color}</span>}</span>
                    <span style={{fontWeight:700}}>{item.qty}{item.unit||"마"}</span>
                    {item.amount>0&&<span style={{color:G.copper,fontSize:11}}>{item.amount.toLocaleString()}원</span>}
                  </div>
                ))}
              </div>
            </Card>

            {/* 금액 카드 4개 */}
            <div className="dep-amt4" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:12}}>
              {[
                {l:"총금액",v:total,c:G.copper},
                {l:"입금액",v:paid,c:G.blue},
                {l:"적립금",v:creditBal,c:G.purple},
                {l:"미수금",v:unpaid,c:unpaid>0?G.red:G.green},
              ].map(s=>(
                <div key={s.l} style={{background:G.card,borderRadius:10,border:`1px solid ${G.border}`,padding:"10px 6px",textAlign:"center"}}>
                  <div style={{fontWeight:800,fontSize:13,color:s.c}}>{s.v.toLocaleString()}<span style={{fontSize:8,color:G.creamMuted}}>원</span></div>
                  <div style={{fontSize:9,color:G.creamMuted,marginTop:3}}>{s.l}</div>
                </div>
              ))}
            </div>

            {refund > 0 && (
              <div style={{padding:"8px 12px",background:G.redBg,borderRadius:8,border:`1px solid ${G.red}40`,marginBottom:12,fontSize:12,color:G.red,fontWeight:600,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                <span>환불: {refund.toLocaleString()}원 {o.refundNote&&`(${o.refundNote})`}</span>
                <button onClick={handleCancelRefund} style={{padding:"4px 10px",fontSize:11,fontWeight:700,borderRadius:6,border:`1px solid ${G.red}`,background:"transparent",color:G.red,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>
                  ↺ 환불 취소
                </button>
              </div>
            )}

            {/* ── 입금 처리 ── */}
            <Card style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:700,color:G.blue,marginBottom:8}}>입금 처리</div>
              <div style={{display:"flex",gap:6}}>
                <input value={payInput} onChange={e=>setPayInput(e.target.value)} placeholder="입금 금액" type="text" inputMode="numeric" style={{...baseInp,flex:1,fontSize:12,padding:"8px 10px",background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                <button onClick={handlePay} style={{padding:"8px 16px",borderRadius:8,border:"none",background:G.blue,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>입금 확인</button>
              </div>
              {unpaid>0&&<div style={{fontSize:10,color:G.creamMuted,marginTop:6}}>미수금: {unpaid.toLocaleString()}원</div>}
            </Card>

            {/* ── 적립금 차감 ── */}
            {unpaid>0 && (
              <Card style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontSize:11,fontWeight:700,color:G.purple}}>적립금 차감</div>
                  <div style={{fontSize:11,fontWeight:700,color:creditBal>0?G.purple:G.creamMuted}}>보유 적립금: {creditBal.toLocaleString()}원</div>
                </div>
                {creditBal > 0 ? (
                  <>
                    <div style={{display:"flex",gap:6}}>
                      <input value={creditInput} onChange={e=>setCreditInput(e.target.value)} placeholder="차감 금액" type="text" inputMode="numeric" style={{...baseInp,flex:1,fontSize:12,padding:"8px 10px",background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                      <button onClick={handleCreditUse} style={{padding:"8px 16px",borderRadius:8,border:"none",background:G.purple,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>차감</button>
                    </div>
                    <div style={{fontSize:10,color:G.creamMuted,marginTop:6}}>차감 가능: 최대 {Math.min(creditBal, unpaid).toLocaleString()}원</div>
                  </>
                ) : (
                  <div style={{fontSize:11,color:G.creamMuted,textAlign:"center",padding:"6px 0"}}>보유 적립금이 없습니다</div>
                )}
              </Card>
            )}

            {/* ── 환불 신청 내역 (직원 신청 → 대표 승인 대기) ── */}
            {o.payment==="환불신청" && o.refundRequest && (
              <Card style={{marginBottom:10,border:`1.5px solid ${G.red}`,background:G.redBg}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontSize:13,fontWeight:800,color:G.red}}>🔴 환불 신청 · 승인 대기</div>
                  <div style={{fontSize:10,color:G.creamMuted}}>{o.refundRequest.requestedBy||"—"}{o.refundRequest.requestedAt?` · ${new Date(o.refundRequest.requestedAt).toLocaleString("ko-KR",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}`:""}</div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                  <div style={{fontSize:12,color:G.cream,padding:"7px 10px",background:G.card,borderRadius:8,border:`1px solid ${G.border}`}}>방식 <b style={{color:o.refundRequest.method==="credit"?G.purple:G.red}}>{o.refundRequest.method==="credit"?"🪙 적립금환불":"💵 현금환불"}</b></div>
                  <div style={{fontSize:12,color:G.cream,padding:"7px 10px",background:G.card,borderRadius:8,border:`1px solid ${G.border}`}}>범위 <b style={{color:G.copper}}>{o.refundRequest.kind==="full"?"전액환불":"부분환불"}</b></div>
                </div>
                <div style={{fontFamily:SF,fontSize:18,fontWeight:800,color:G.red,marginBottom:o.refundRequest.reason?4:8}}>{(o.refundRequest.amount||0).toLocaleString()}<span style={{fontSize:11,fontWeight:400,color:G.creamMuted,marginLeft:2}}>원</span></div>
                {/* 현금환불 계좌 정보 — 신청 시 기입된 은행/계좌번호/예금주. 복사 버튼으로 이체 편의 */}
                {o.refundRequest.method==="cash" && (o.refundRequest.bank||o.refundRequest.accountNumber||o.refundRequest.accountHolder) && (
                  <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:G.cream,marginBottom:8,padding:"8px 10px",background:G.card,borderRadius:8,border:`1px solid ${G.border}`}}>
                    <div style={{flex:1,minWidth:0,lineHeight:1.6}}>
                      <div style={{fontSize:10,color:G.creamMuted,fontWeight:700}}>🏦 환불 계좌</div>
                      <div style={{fontWeight:700,wordBreak:"break-all"}}>
                        {o.refundRequest.bank||"은행 미기입"} <span style={{fontFamily:SF}}>{o.refundRequest.accountNumber||"계좌번호 미기입"}</span>
                        {o.refundRequest.accountHolder && <span style={{color:G.creamMuted,fontWeight:600}}> · {o.refundRequest.accountHolder}</span>}
                      </div>
                    </div>
                    <button onClick={()=>{
                      const txt=[o.refundRequest.bank,o.refundRequest.accountNumber,o.refundRequest.accountHolder].filter(Boolean).join(" ");
                      if(navigator.clipboard){navigator.clipboard.writeText(txt).then(()=>showToast("계좌 정보 복사됨")).catch(()=>showToast("복사 실패","error"));}
                    }} style={{flexShrink:0,padding:"6px 10px",borderRadius:8,border:`1px solid ${G.border}`,background:G.surface,color:G.creamMuted,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:S}}>복사</button>
                  </div>
                )}
                {o.refundRequest.reason && <div style={{fontSize:12,color:G.cream,marginBottom:8,padding:"6px 10px",background:G.card,borderRadius:8,border:`1px solid ${G.border}`}}>💬 {o.refundRequest.reason}</div>}
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:10,lineHeight:1.5}}>아래 <b style={{color:G.cream}}>환불 처리</b>에서 금액·방식을 확인/조정한 뒤 <b style={{color:o.refundRequest.method==="credit"?G.purple:G.red}}>{o.refundRequest.method==="credit"?"적립금 전환":"현금 환불"}</b> 버튼으로 승인하세요.</div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <input value={rejectReason} onChange={e=>setRejectReason(e.target.value)} placeholder="반려 사유 (선택)" style={{...baseInp,flex:1,fontSize:12,padding:"8px 10px",background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                  <button onClick={handleRejectRefund} style={{padding:"9px 16px",borderRadius:8,border:`1px solid ${G.red}`,background:"transparent",color:G.red,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>✗ 반려</button>
                </div>
              </Card>
            )}

            {/* ── 환불 처리 ── */}
            {paid>0 && (
              <Card style={{marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <div style={{fontSize:11,fontWeight:700,color:G.red}}>환불 처리</div>
                  <div style={{fontSize:11,fontWeight:700,color:G.blue}}>입금액: {paid.toLocaleString()}원</div>
                </div>
                <div style={{display:"flex",gap:6,marginBottom:8}}>
                  <input value={refundInput} onChange={e=>setRefundInput(e.target.value)} placeholder="환불 금액" type="text" inputMode="numeric" style={{...baseInp,flex:1,fontSize:12,padding:"8px 10px",background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                  <button onClick={()=>setRefundInput(String(paid))} style={{padding:"8px 12px",borderRadius:8,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,fontWeight:700,fontSize:11,cursor:"pointer",fontFamily:S,whiteSpace:"nowrap"}}>전액</button>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>handleRefund("cash")} style={{flex:1,padding:"10px 8px",borderRadius:8,border:"none",background:G.red,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S,boxShadow:reqMethod==="cash"?`0 0 0 2px ${G.card}, 0 0 0 4px ${G.red}`:"none"}}>
                    {reqMethod==="cash"?"✓ 현금 환불 승인":"현금 환불"}
                  </button>
                  <button onClick={()=>handleRefund("credit")} style={{flex:1,padding:"10px 8px",borderRadius:8,border:"none",background:G.purple,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:S,boxShadow:reqMethod==="credit"?`0 0 0 2px ${G.card}, 0 0 0 4px ${G.purple}`:"none"}}>
                    {reqMethod==="credit"?"✓ 적립금 전환 승인":"적립금 전환"}
                  </button>
                </div>
                <div style={{fontSize:10,color:G.creamMuted,marginTop:6}}>환불 가능: 최대 {paid.toLocaleString()}원{reqMethod?" · 신청 방식이 강조 표시됩니다":""}</div>
              </Card>
            )}

            {/* ── 처리 내역 ── */}
            {orderHistory.length > 0 && (
              <Card>
                <div style={{fontSize:11,fontWeight:700,color:G.copper,marginBottom:8,letterSpacing:"0.06em"}}>처리 내역</div>
                {orderHistory.map((h,i)=>{
                  const t = h.type||"";
                  const amt = h.amount||h.amt||0;
                  const dt = h.created_at ? new Date(h.created_at).toLocaleString("ko-KR") : (h.date||"");
                  return (
                    <div key={h.id||i} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 0",borderTop:i>0?`1px solid ${G.border}`:"none",fontSize:12}}>
                      <Tag c={t.includes("환불")||t==="현금환불"?G.red:t.includes("적립")||t==="적립금전환"?G.purple:G.blue} bg={t.includes("환불")||t==="현금환불"?G.redBg:t.includes("적립")||t==="적립금전환"?"rgba(138,106,184,0.12)":G.blueBg}>{t}</Tag>
                      <span style={{flex:1,color:G.cream}}>{t.includes("환불")||t==="현금환불"||t==="적립금차감"?"-":"+"}{amt.toLocaleString()}원</span>
                      <span style={{fontSize:10,color:G.creamMuted}}>{dt}</span>
                    </div>
                  );
                })}
              </Card>
            )}
          </div>
        );
      })()}

      {/* ══════════ 적립금 ══════════ */}
      {sub==="credit" && (
        <div>
          <Card style={{marginBottom:12}}>
            <div style={{fontSize:12,fontWeight:800,color:G.copper,marginBottom:14,letterSpacing:".06em"}}>혜택 발급</div>
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              {[{k:"credit",l:"💰 적립금"},{k:"freeShipping",l:"🎟️ 무료배송권"}].map(t=>(
                <button key={t.k} type="button" onClick={()=>setBenefitType(t.k)} style={{flex:1,padding:"8px 4px",borderRadius:8,border:`1px solid ${benefitType===t.k?G.copper:G.border}`,background:benefitType===t.k?G.copperGlow:"transparent",color:benefitType===t.k?G.copper:G.creamMuted,fontWeight:benefitType===t.k?800:500,fontSize:12,cursor:"pointer",fontFamily:S}}>{t.l}</button>
              ))}
            </div>
            <div style={{marginBottom:10,position:"relative"}}>
              <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>고객명 *</div>
              <input value={creditSearch} onChange={e=>{setCreditSearch(e.target.value);setCreditForm(f=>({...f,customer:""}));setShowCreditDropdown(true);}}
                onFocus={()=>setShowCreditDropdown(true)}
                placeholder="고객명 검색" style={{...baseInp,borderColor:creditForm.customer?G.green:G.border,background:G.inputBg,border:`1px solid ${creditForm.customer?G.green:G.border}`,color:G.cream}}/>
              {creditForm.customer && <div style={{fontSize:11,color:G.green,marginTop:4,fontWeight:600}}>✓ {creditForm.customer}{benefitType==="credit" && <span style={{color:G.purple}}> · 보유 적립금 {getCreditBalance(creditForm.customer).toLocaleString()}원</span>}</div>}
              {showCreditDropdown && creditSearch && (
                <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:G.card,border:`1px solid ${G.border}`,borderRadius:8,maxHeight:180,overflowY:"auto",marginTop:4,boxShadow:"0 4px 16px rgba(0,0,0,0.3)"}}>
                  {customers.filter(c=>c.name.toLowerCase().includes(creditSearch.toLowerCase())).length===0
                    ? <div style={{padding:"12px 14px",fontSize:12,color:G.red}}>등록된 고객이 없습니다</div>
                    : customers.filter(c=>c.name.toLowerCase().includes(creditSearch.toLowerCase())).map(c=>(
                      <div key={c.id} onClick={()=>{setCreditForm(f=>({...f,customer:c.name}));setCreditSearch(c.name);setShowCreditDropdown(false);}}
                        style={{padding:"10px 14px",cursor:"pointer",fontSize:13,borderBottom:`1px solid ${G.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}
                        onMouseEnter={e=>e.currentTarget.style.background=G.surface}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                        <span style={{fontWeight:600}}>{c.name}</span>
                        <span style={{fontSize:11,color:G.creamMuted}}>{c.phone||""}</span>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
            {benefitType==="credit" ? (
              <>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <div>
                    <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>금액 (원) *</div>
                    <input value={creditForm.amount} onChange={e=>setCreditForm(f=>({...f,amount:e.target.value}))} placeholder="5000" type="number" style={{...baseInp,background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                  </div>
                  <div>
                    <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>사유</div>
                    <input value={creditForm.reason} onChange={e=>setCreditForm(f=>({...f,reason:e.target.value}))} placeholder="단골 적립" style={{...baseInp,background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>담당자 메모 <span style={{fontWeight:400}}>(내역 카드를 누르면 보임)</span></div>
                  <textarea value={creditForm.memo} onChange={e=>setCreditForm(f=>({...f,memo:e.target.value}))} placeholder="예: 8/30 배송 지연 사과, 다음 주문 때 쓰시라고 안내드림" rows={2}
                    style={{...baseInp,background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream,resize:"vertical",fontFamily:S,lineHeight:1.5}}/>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={addCredit} disabled={benefitBusy} style={{flex:2,padding:12,borderRadius:10,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:"#fff",fontWeight:800,fontSize:14,cursor:benefitBusy?"wait":"pointer",opacity:benefitBusy?0.55:1,fontFamily:S}}>
                    {benefitBusy?"처리 중…":"적립금 등록"}
                  </button>
                  <button onClick={reclaimCredit} disabled={benefitBusy} style={{flex:1,padding:12,borderRadius:10,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,fontWeight:800,fontSize:13,cursor:benefitBusy?"wait":"pointer",opacity:benefitBusy?0.55:1,fontFamily:S}}>
                    회수
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:11,color:G.creamMuted,marginBottom:5,fontWeight:600}}>수량 (장) *</div>
                  <input value={fsCount} onChange={e=>setFsCount(e.target.value)} placeholder="1" type="number" min={1} style={{...baseInp,background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={handleFreeShippingIssue} disabled={benefitBusy} style={{flex:2,padding:12,borderRadius:10,border:"none",background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,color:"#fff",fontWeight:800,fontSize:14,cursor:benefitBusy?"wait":"pointer",opacity:benefitBusy?0.55:1,fontFamily:S}}>
                    {benefitBusy?"처리 중…":"🎟️ 발급"}
                  </button>
                  <button onClick={handleFreeShippingCancel} disabled={benefitBusy} style={{flex:1,padding:12,borderRadius:10,border:`1px solid ${G.red}`,background:G.redBg,color:G.red,fontWeight:800,fontSize:13,cursor:benefitBusy?"wait":"pointer",opacity:benefitBusy?0.55:1,fontFamily:S}}>
                    회수
                  </button>
                </div>
              </>
            )}
          </Card>

          <SecTitle>적립금 내역</SecTitle>
          <input value={creditHistSearch} onChange={e=>{setCreditHistSearch(e.target.value);setCreditPage(1);}} placeholder="고객명 검색" style={{...baseInp,marginBottom:8,background:G.inputBg,border:`1px solid ${G.border}`,color:G.cream}}/>
          <div style={{display:"flex",gap:6,marginBottom:10}}>
            {["","적립","사용"].map(f=>(
              <button key={f} onClick={()=>{setCreditHistFilter(f);setCreditPage(1);}} style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${creditHistFilter===f?G.copper:G.border}`,background:creditHistFilter===f?G.copperGlow:"transparent",color:creditHistFilter===f?G.copper:G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:creditHistFilter===f?700:400}}>
                {f||"전체"}
              </button>
            ))}
          </div>
          {(()=>{
            let list = credits || [];
            if (creditHistFilter) list = list.filter(c=>c.type===creditHistFilter);
            if (creditHistSearch.trim()) { const q=creditHistSearch.trim().toLowerCase(); list=list.filter(c=>c.customer.toLowerCase().includes(q)); }
            const totalPages = Math.max(1, Math.ceil(list.length / CREDIT_PER_PAGE));
            const page = Math.min(creditPage, totalPages);
            const paged = list.slice((page-1)*CREDIT_PER_PAGE, page*CREDIT_PER_PAGE);
            return list.length===0
              ? <div style={{textAlign:"center",padding:"20px 0",color:G.creamMuted,fontSize:13}}>내역이 없습니다</div>
              : <>
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:6}}>총 {list.length}건</div>
                {paged.map(c=>{
                  const open = expandedCreditId===c.id;
                  const dt = c.created_at ? new Date(c.created_at).toLocaleString("ko-KR",{year:"2-digit",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}) : "";
                  return (
                  <div key={c.id} onClick={()=>setExpandedCreditId(open?null:c.id)}
                    style={{padding:"10px 14px",background:G.card,borderRadius:10,border:`1px solid ${open?G.copper:G.border}`,boxShadow:G.cardShadow,marginBottom:5,cursor:"pointer"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <Tag c={c.type==="적립"?G.green:G.red} bg={c.type==="적립"?G.greenBg:G.redBg}>{c.type}</Tag>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:13,fontWeight:700}}>{c.customer}</div>
                        <div style={{fontSize:11,color:G.creamMuted}}>{c.reason||"—"}</div>
                      </div>
                      <span style={{fontFamily:SF,fontSize:16,fontWeight:800,color:c.type==="적립"?G.green:G.red}}>{c.type==="적립"?"+":"-"}{c.amount.toLocaleString()}</span>
                    </div>
                    {open && (()=>{
                      // 주문에서 생긴 기록이면 그 주문의 💬 메모(주문현황 카드와 같은 것)를 담당자 메모와 나란히 보여준다
                      const ord = findCreditOrder(c);
                      const ordNote = (ord?.note||"").trim();
                      const ordLoading = !!c.order_id && !ord && !(c.order_id in creditOrderCache);
                      return (
                      <div style={{marginTop:8,paddingTop:8,borderTop:`1px dashed ${G.border}`,fontSize:12,color:G.creamMuted,lineHeight:1.7}}>
                        <div>🕒 {dt||"—"}{c.manager?<span> · 👤 <span style={{color:G.cream}}>{c.manager}</span></span>:" · 담당자 기록 없음"}</div>
                        {c.order_id && (
                          <div style={{whiteSpace:"pre-wrap",color:ordNote?G.cream:G.creamMuted}}>
                            💬 <span style={{fontSize:10,color:G.creamMuted}}>주문 메모</span> {ordLoading?"불러오는 중…":ordNote||(ord?"없음":"주문을 찾을 수 없음")}
                          </div>
                        )}
                        <div style={{whiteSpace:"pre-wrap",color:c.memo?G.cream:G.creamMuted}}>📝 <span style={{fontSize:10,color:G.creamMuted}}>담당자 메모</span> {c.memo||"없음"}</div>
                      </div>
                      );
                    })()}
                  </div>
                  );
                })}
                {totalPages>1 && (
                  <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:8,marginTop:10}}>
                    <button onClick={()=>setCreditPage(p=>Math.max(1,p-1))} disabled={page<=1} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:page<=1?"transparent":G.surface,color:page<=1?G.border:G.creamMuted,fontSize:12,cursor:page<=1?"default":"pointer",fontFamily:S}}>←</button>
                    <span style={{fontSize:12,color:G.creamMuted,fontFamily:SF}}>{page} / {totalPages}</span>
                    <button onClick={()=>setCreditPage(p=>Math.min(totalPages,p+1))} disabled={page>=totalPages} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:page>=totalPages?"transparent":G.surface,color:page>=totalPages?G.border:G.creamMuted,fontSize:12,cursor:page>=totalPages?"default":"pointer",fontFamily:S}}>→</button>
                  </div>
                )}
              </>;
          })()}

          <div style={{marginTop:24}}>
            <SecTitle>🎟️ 무료배송권 보유 현황</SecTitle>
            {(freeShipping||[]).length===0 ? (
              <div style={{textAlign:"center",padding:"20px 0",color:G.creamMuted,fontSize:13}}>보유 고객이 없습니다</div>
            ) : (
              <>
                <div style={{fontSize:11,color:G.creamMuted,marginBottom:6}}>총 {(freeShipping||[]).length}명</div>
                {(freeShipping||[]).map(fs=>(
                  <div key={fs.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:G.card,borderRadius:10,border:`1px solid ${G.border}`,boxShadow:G.cardShadow,marginBottom:5}}>
                    <Tag c="#92400e" bg="#fef3c7">🎟️</Tag>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700}}>{fs.customer}</div>
                      <div style={{fontSize:11,color:G.creamMuted}}>{fs.updatedAt?new Date(fs.updatedAt).toLocaleDateString("ko-KR"):"—"}</div>
                    </div>
                    <span style={{fontFamily:SF,fontSize:16,fontWeight:800,color:G.copper}}>{fs.count}장</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default DepositTab;
