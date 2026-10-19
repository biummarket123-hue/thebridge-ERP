// 거래처 — 고객 목록·검색(전화번호 기준 식별), 주소, 주문 이력, 적립금·배송권 잔액, 등록·수정·삭제(지시서 4절 거래처).
import { useEffect, useMemo, useState } from "react";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Modal } from "../components/Modal.jsx";
import { useAsk } from "../components/useAsk.jsx";
import { PageHead, StatCard, Button, SearchInput, FilterChips, StatusBadge, Empty, LoadingLine, TaskRow, won, shortId } from "../components/ui.jsx";
import { maskPhone } from "../../constants.js";
import { customerStats, regionOf, orderTotal, isActiveOrder, itemsSummary, monthRange, dayKey, parseKoDate } from "../lib/metrics.js";
import { orderBadges } from "./HomePage.jsx";
import { PAGE_SIZE, OLD_ERP_PATH } from "../config.js";

function Field({ label, children, opt, htmlFor }) {
  return <div><label className="formlabel" htmlFor={htmlFor}>{label}{opt ? <span className="opt">선택</span> : null}</label>{children}</div>;
}

function CustomerForm({ initial, onClose, onSaved }) {
  const { customers, setCustomers } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [f, setF] = useState(() => ({ name: initial?.name || "", phone: initial?.phone || "", nickname: initial?.nickname || "", address: initial?.address || "", addressDetail: initial?.addressDetail || "", address2: initial?.address2 || "", address2Detail: initial?.address2Detail || "", note: initial?.note || "" }));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const name = f.name.trim();
    if (!name) { toast("이름을 적어 주세요", "error"); return; }
    const digits = f.phone.replace(/\D/g, "");
    setBusy(true);
    try {
      if (!initial) {
        if (customers.find(c => c.name === name && digits && (c.phone || "").replace(/\D/g, "") === digits)) throw new Error("이미 등록된 고객입니다 (같은 이름·연락처)");
        const sameName = customers.filter(c => c.name === name);
        if (sameName.length && !await confirm(`같은 이름의 고객이 이미 ${sameName.length}명 있습니다.\n동명이인(다른 사람)으로 새로 등록할까요?\n\n※ 연락처로 구분되니 전화번호를 꼭 입력해 주세요.`)) return;
        const samePhone = digits.length >= 9 ? customers.filter(c => (c.phone || "").replace(/\D/g, "") === digits && c.name !== name) : [];
        if (samePhone.length && !await confirm(`같은 전화번호의 고객이 이미 있습니다.\n\n${samePhone.slice(0, 4).map(c => `· ${c.name}${c.nickname ? ` (${c.nickname})` : ""} · 주문 ${c.totalOrders || 0}건`).join("\n")}\n\n같은 사람이면 [취소] 후 그 고객을 수정해 주세요.\n[확인] 다른 사람 — 새 고객으로 등록`)) return;
        const saved = await db.insertCustomer({ ...f, name, totalOrders: 0, lastOrder: "—" });
        if (saved) setCustomers(p => [...p, saved]);
        toast("고객 등록 완료"); onSaved(saved);
      } else {
        const updated = await db.updateCustomer(initial.id, { ...initial, ...f, name });
        if (updated) setCustomers(p => p.map(c => c.id === initial.id ? updated : c));
        toast("고객 정보 저장"); onSaved(updated || { ...initial, ...f, name });
      }
    } catch (e) { toast(e.message || "저장 실패", "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={initial ? "거래처 수정" : "거래처 등록"} onClose={onClose} width="wide">
      {host}
      <p className="helptext warn">실제 고객 정보(운영 DB)가 저장됩니다. 전화번호는 동명이인을 가르는 기준이라 꼭 적어 주세요.</p>
      <div className="formrow">
        <Field label="이름" htmlFor="cf-name"><input id="cf-name" className="forminput" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="연락처" htmlFor="cf-phone"><input id="cf-phone" className="forminput" inputMode="tel" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} placeholder="010-0000-0000" /></Field>
        <Field label="닉네임" opt><input className="forminput" value={f.nickname} onChange={e => setF({ ...f, nickname: e.target.value })} placeholder="밴드·카톡 별명" /></Field>
        <Field label="메모" opt><input className="forminput" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></Field>
      </div>
      <Field label="기본 배송지"><input className="forminput" value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></Field>
      <Field label="상세 주소" opt><input className="forminput" value={f.addressDetail} onChange={e => setF({ ...f, addressDetail: e.target.value })} /></Field>
      <Field label="배송지 2" opt><input className="forminput" value={f.address2} onChange={e => setF({ ...f, address2: e.target.value })} /></Field>
      <Field label="배송지 2 상세" opt><input className="forminput" value={f.address2Detail} onChange={e => setF({ ...f, address2Detail: e.target.value })} /></Field>
      <div className="btnrow" style={{ marginTop: 20 }}><Button kind="white" onClick={onClose}>취소</Button><Button icon="check" onClick={save} loading={busy}>저장</Button></div>
    </Modal>
  );
}

function CustomerDetail({ customer: c, stat, onClose, go }) {
  const { isAdmin, setCustomers, credits, freeShipping } = useSaas();
  const toast = useToast();
  const { confirm, host } = useAsk();
  const [edit, setEdit] = useState(false);
  const [bal, setBal] = useState(null);
  const [fs, setFs] = useState(null);
  const [detail, setDetail] = useState({});
  useEffect(() => {
    let alive = true;
    db.getCustomerCredit(c.name).then(v => alive && setBal(v)).catch(() => alive && setBal(0));
    db.getCustomerFreeShipping(c.name).then(v => alive && setFs(v)).catch(() => alive && setFs(0));
    return () => { alive = false; };
  }, [c.name, credits, freeShipping]);
  const history = useMemo(() => [...(stat?.orders || [])].sort((a, b) => String(b.createdAt || dayKey(parseKoDate(b.date))).localeCompare(String(a.createdAt || dayKey(parseKoDate(a.date))))).slice(0, 10), [stat]);
  const needIds = useMemo(() => history.filter(o => !o.items).map(o => o.id).filter(id => !(id in detail)), [history, detail]);
  useEffect(() => {
    if (!needIds.length) return;
    db.fetchOrdersByIds(needIds).then(rows => setDetail(p => ({ ...p, ...Object.fromEntries(needIds.map(id => [id, rows.find(r => r.id === id) || null])) }))).catch(() => {});
  }, [needIds]);
  const remove = async () => {
    if (!await confirm(`${c.name} 고객을 삭제합니다. 주문 기록은 남지만 고객 카드는 사라집니다.`, { danger: true, confirmLabel: "삭제" })) return;
    try { await db.deleteCustomer(c.id); setCustomers(p => p.filter(x => x.id !== c.id)); toast("고객 삭제"); onClose(); }
    catch (e) { toast("삭제 실패: " + e.message, "error"); }
  };
  if (edit) return <CustomerForm initial={c} onClose={() => setEdit(false)} onSaved={() => setEdit(false)} />;
  return (
    <Modal title="거래처 상세" onClose={onClose} width="wide">
      {host}
      <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0 6px" }}>
        <div className="initial" style={{ width: 52, height: 52, fontSize: 20 }}>{(c.name || "?").slice(0, 1)}</div>
        <div style={{ minWidth: 0 }}><strong style={{ fontSize: 21 }}>{c.name}</strong>{c.nickname ? <span style={{ color: "#8d9bab", marginLeft: 8 }}>{c.nickname}</span> : null}<div style={{ color: "#8d9bab", fontSize: 15 }}>{isAdmin ? (c.phone || "연락처 없음") : (maskPhone(c.phone) || "연락처 없음")}</div></div>
      </div>
      <div className="kv">
        <div className="invrow"><span>기본 배송지</span><strong style={{ fontWeight: 600 }}>{c.address ? `${c.address}${c.addressDetail ? ` ${c.addressDetail}` : ""}` : "—"}</strong></div>
        {c.address2 ? <div className="invrow"><span>배송지 2</span><strong style={{ fontWeight: 600 }}>{c.address2}{c.address2Detail ? ` ${c.address2Detail}` : ""}</strong></div> : null}
        <div className="invrow"><span>주문</span><strong>{stat?.count ?? c.totalOrders ?? 0}건<small style={{ display: "block", fontWeight: 600, color: "#8d9bab" }}>최근 {stat?.lastAt || c.lastOrder || "—"}{stat?.activeCount ? ` · 진행 중 ${stat.activeCount}건` : ""}</small></strong></div>
        <div className="invrow"><span>미수금</span><strong style={{ color: stat?.unpaid ? "#d76964" : undefined }}>{won(stat?.unpaid || 0)}</strong></div>
        <div className="invrow"><span>적립금</span><strong>{bal === null ? "…" : won(bal)}</strong></div>
        <div className="invrow"><span>무료배송권</span><strong>{fs === null ? "…" : `${fs}장`}</strong></div>
        {c.note ? <div className="invrow"><span>메모</span><strong style={{ fontWeight: 600 }}>{c.note}</strong></div> : null}
      </div>
      <div className="section-label">주문 이력 (최근 10건)</div>
      <div className="tasklist">
        {history.length === 0 && <Empty small>주문 기록이 없어요.</Empty>}
        {history.map(o => { const full = o.items ? o : detail[o.id]; const b = full ? orderBadges(full)[0] : ["gray", o.status || "접수"]; return (
          <TaskRow key={o.id} icon="orders" tone={isActiveOrder(o) ? "" : "mint"} title={`${o.date || dayKey(o.createdAt)} · ${shortId(o.id)}`} hint={full ? `${itemsSummary(full, 2)} · ${won(orderTotal(full))}` : "불러오는 중…"} count={b[1]} onClick={() => go(`/app/orders/${o.id}`)} />
        ); })}
      </div>
      <div className="inline-actions">
        <Button kind="white" icon="edit" onClick={() => setEdit(true)}>수정</Button>
        <Button kind="white" icon="plus" onClick={() => go("/app/orders/new")}>주문 등록</Button>
        {isAdmin && <Button kind="danger" icon="trash" onClick={remove}>삭제</Button>}
      </div>
      <div className="link-old">적립금 등록·사용 이력, 무료배송권 발급은 <a href="/app/settlement">정산</a> 또는 <a href={OLD_ERP_PATH}>옛 화면</a>에서.</div>
    </Modal>
  );
}

export default function CustomersPage({ route }) {
  const { customers, orders, shipped, loaded, credits } = useSaas();
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get("q") || "");
  const [filter, setFilter] = useState("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [creating, setCreating] = useState(false);
  const [shippedKeys, setShippedKeys] = useState(null);
  const go = route.go;
  useEffect(() => { let alive = true; db.fetchShippedOrderKeys().then(r => alive && setShippedKeys(r)).catch(() => alive && setShippedKeys([])); return () => { alive = false; }; }, []);
  // 활성 + 최근 60일 출고완료(품목 포함) + 그 밖의 출고완료(키만). id 로 한 번만.
  const allOrders = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const o of [...orders, ...shipped, ...(shippedKeys || [])]) { if (seen.has(o.id)) continue; seen.add(o.id); out.push(o); }
    return out;
  }, [orders, shipped, shippedKeys]);
  const stats = useMemo(() => customerStats(customers, allOrders), [customers, allOrders]);
  const creditBy = useMemo(() => { const m = new Map(); for (const c of credits || []) m.set(c.customer, (m.get(c.customer) || 0) + (c.type === "적립" ? c.amount : -c.amount)); return m; }, [credits]);
  const { start } = monthRange(new Date());
  const monthActive = useMemo(() => { let n = 0; for (const [, s] of stats) if (s.monthSum > 0) n++; return n; }, [stats]);
  const unpaidCount = useMemo(() => { let n = 0; for (const [, s] of stats) if (s.unpaid > 0) n++; return n; }, [stats]);
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase(); const digits = ql.replace(/\D/g, "");
    return customers.filter(c => {
      const s = stats.get(c.id);
      if (filter === "unpaid" && !(s?.unpaid > 0)) return false;
      if (filter === "credit" && !((creditBy.get(c.name) || 0) > 0)) return false;
      if (filter === "month" && !(s?.monthSum > 0)) return false;
      if (!ql) return true;
      return String(c.name || "").toLowerCase().includes(ql) || String(c.nickname || "").toLowerCase().includes(ql) || (digits.length >= 3 && String(c.phone || "").replace(/\D/g, "").includes(digits)) || String(c.address || "").toLowerCase().includes(ql);
    }).sort((a, b) => String(stats.get(b.id)?.lastAt || "").localeCompare(String(stats.get(a.id)?.lastAt || "")) || String(a.name).localeCompare(String(b.name), "ko-KR"));
  }, [customers, stats, filter, q, creditBy]);
  useEffect(() => { setShown(PAGE_SIZE); }, [filter, q]);
  const selected = route.id ? customers.find(c => String(c.id) === route.id) : null;
  const lastLabel = (s) => { const k = s?.lastAt; if (!k) return "주문 없음"; const t = dayKey(new Date()); return k === t ? "최근 주문 오늘" : `최근 주문 ${k.slice(5).replace("-", "월 ")}일`; };

  return (
    <>
      <PageHead eyebrow="CUSTOMERS" title="거래처" subtitle="거래처 정보와 거래 현황을 한곳에서 관리하세요." />
      <div className="stats">
        <StatCard title="등록된 거래처" value={customers.length} unit="곳" icon="users" note="전체 거래처" noteTone="muted" />
        <StatCard title="이번 달 거래" value={monthActive} unit="곳" icon="trend" tone="mint" note={`${start.getMonth() + 1}월 주문이 있는 업체`} onClick={() => setFilter("month")} />
        <StatCard title="미수금 확인" value={unpaidCount} unit="곳" icon="alert" tone="orange" note="정산 확인 필요" noteTone="alert" onClick={() => setFilter("unpaid")} />
        <StatCard title="신규 거래처" value={null} icon="plus" note="등록일 기록이 없어 집계 불가" noteTone="muted" />
      </div>
      <div className="searchline">
        <SearchInput value={q} onChange={setQ} placeholder="이름 · 닉네임 · 전화번호 · 주소" />
        <Button icon="plus" onClick={() => setCreating(true)}>거래처 등록</Button>
      </div>
      <FilterChips style={{ marginBottom: 16 }} value={filter} onChange={setFilter} options={[["all", "전체", customers.length], ["month", "이번 달 거래", monthActive], ["unpaid", "미수금", unpaidCount], ["credit", "적립금 보유"]]} />
      {!loaded ? <LoadingLine /> : list.length === 0 ? <Empty>조건에 맞는 거래처가 없어요.</Empty> : (
        <div className="customer-grid">
          {list.slice(0, shown).map(c => { const s = stats.get(c.id); return (
            <button key={c.id} className="customercard" onClick={() => go(`/app/customers/${c.id}`)}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div className="initial">{(c.name || "?").slice(0, 1)}</div>{s?.unpaid > 0 ? <StatusBadge tone="late">미수금 {won(s.unpaid)}</StatusBadge> : null}</div>
              <h3>{c.name}{c.nickname ? <span style={{ color: "#8d9bab", fontSize: 14, fontWeight: 600 }}> {c.nickname}</span> : null}</h3>
              <p>{regionOf(c.address) || "주소 없음"} · {maskPhone(c.phone) || "연락처 없음"}</p>
              <p>{lastLabel(s)} · 주문 {s?.count ?? c.totalOrders ?? 0}건</p>
              <div className="money">{won(s?.monthSum || 0)} <span>이번 달 거래</span></div>
            </button>
          ); })}
        </div>
      )}
      {list.length > shown && <div className="pager"><Button kind="white" onClick={() => setShown(s => s + PAGE_SIZE)}>더 보기 ({list.length - shown}곳 남음)</Button></div>}
      {selected && <CustomerDetail customer={selected} stat={stats.get(selected.id)} onClose={() => go("/app/customers")} go={go} />}
      {creating && <CustomerForm onClose={() => setCreating(false)} onSaved={(c) => { setCreating(false); if (c?.id) go(`/app/customers/${c.id}`); }} />}
    </>
  );
}
