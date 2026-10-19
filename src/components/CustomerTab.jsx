import { useState, useMemo, useEffect } from "react";
import { Tag, SecTitle, Card, Empty, Toast, PrimaryBtn, GhostBtn, FLabel, ConfirmModal, EditOrderModal, EditInvModal, EditCustModal, AddressSearchModal } from "./UI.jsx";
import { SF, S, baseInp, sC, useTheme } from "../constants.js";
import * as db from "../lib/db.js";

function CustomerTab({customers, setCustomers, orders, exportCustomers, showToast, kakaoAlert, setConfirmDel, setEditingCust, credits, freeShipping = [], isAdmin = false}) {
  const G = useTheme();
  const [form, setForm] = useState({name:"",phone:"",address:"",addressDetail:"",note:"",nickname:""});
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [sort, setSort] = useState("latest");
  const [creditOnly, setCreditOnly] = useState(false);
  const [freeShipOnly, setFreeShipOnly] = useState(false);
  const [dupOnly, setDupOnly] = useState(false);   // 중복 의심만 보기 — 관리자 전용
  const [page, setPage] = useState(1);
  const [addrOpen, setAddrOpen] = useState(false);
  const PER_PAGE = 10;

  const add = async () => {
    const name = form.name.trim();
    if (!name) return;
    const phoneDigits = (form.phone || "").replace(/\D/g, "");
    // 진짜 중복만 차단: 같은 이름 + 같은 전화번호. 동명이인(번호가 다르거나 없음)은 허용.
    const dup = customers.find(c => c.name === name && phoneDigits && (c.phone || "").replace(/\D/g, "") === phoneDigits);
    if (dup) { showToast("이미 등록된 고객입니다 (같은 이름·연락처)", "error"); return; }
    // 동명이인 안내 — 차단이 아니라 확인. 연락처로 구분되므로 번호 입력 권장.
    const sameName = customers.filter(c => c.name === name);
    if (sameName.length > 0) {
      const ok = window.confirm(`같은 이름의 고객이 이미 ${sameName.length}명 있습니다.\n동명이인(다른 사람)으로 새로 등록할까요?\n\n※ 연락처로 구분되니 전화번호를 꼭 입력해 주세요.`);
      if (!ok) return;
    }
    // 같은 번호, 다른 이름 — 주문 등록과 같은 확인. 호칭이나 별명으로 한 사람을 두 번 등록하는 걸 막는다.
    // 막지는 않는다: 한 번호를 가족이나 같은 공방 사람이 함께 쓰는 경우가 있다.
    const samePhone = phoneDigits.length >= 9
      ? customers.filter(c => (c.phone || "").replace(/\D/g, "") === phoneDigits && c.name !== name)
      : [];
    if (samePhone.length > 0) {
      const list = samePhone.slice(0, 4).map(c => `  · ${c.name}${c.nickname ? ` (${c.nickname})` : ""} · 주문 ${c.totalOrders || 0}건`).join("\n");
      const ok = window.confirm(`같은 전화번호의 고객이 이미 있습니다.\n\n${list}\n\n같은 사람이면 [취소] 후 그 고객을 수정해 주세요.\n[확인] 다른 사람 — 새 고객으로 등록 (가족·같은 공방 등)`);
      if (!ok) return;
    }
    try {
      const saved = await db.insertCustomer({...form, name, totalOrders:0, lastOrder:"—"});
      if (saved) setCustomers(p=>[...p, saved]);
      setForm({name:"",phone:"",address:"",addressDetail:"",note:"",nickname:""}); showToast("고객 등록 완료");
    } catch(e) { showToast("등록 실패","error"); }
  };

  // 연락처 → 가운데 4자리(전체 11자리) / 4자리 그대로 / 그 외 원본 trim
  const normalizePhone = raw => {
    const d = String(raw||"").replace(/[^0-9]/g,"");
    if (d.length === 11) return d.slice(3,7);
    if (d.length === 4) return d;
    return String(raw||"").trim();
  };

  // "YYYY. M. D." / "YYYY. MM. DD." 모두 파싱 → ms timestamp (없으면 0)
  const parseOrderDate = s => {
    if (!s) return 0;
    const m = String(s).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return m ? new Date(+m[1], +m[2]-1, +m[3]).getTime() : 0;
  };

  // 두 전화번호 비교 — 둘 다 풀번호(10+자리)면 전체 일치, 아니면 가운데 4자리 비교.
  // 반환: true(같음) / false(다름) / null(한쪽이라도 번호 없어 판별 불가)
  const samePhone = (a, b) => {
    const ad = String(a || "").replace(/\D/g, "");
    const bd = String(b || "").replace(/\D/g, "");
    if (!ad || !bd) return null;
    if (ad.length >= 10 && bd.length >= 10) return ad === bd;
    const am = ad.length >= 10 ? ad.slice(3, 7) : ad;
    const bm = bd.length >= 10 ? bd.slice(3, 7) : bd;
    return am === bm;
  };

  // 주문 o가 고객 c에 속하는지 — 주문 저장값(전화번호) 우선으로 판별해 동명이인 교차귀속 방지.
  // 1) 양쪽 다 번호 보유 → 번호로 확정 (일치=같은 사람, 불일치=다른 사람, 이름 같아도 제외)
  // 2) 번호로 판별 불가(한쪽이라도 번호 없음) → 이름/닉네임 매칭
  const isSameCustomer = (o, c) => {
    if (!o || !c) return false;
    const oName = o.customer || "";
    const cName = c.name || "";
    const ph = samePhone(o.phone, c.phone);
    if (ph === true) return true;    // 번호 일치 → 같은 사람
    if (ph === false) return false;  // 둘 다 번호 있는데 다름 → 동명이인 등 다른 사람
    // ph === null: 번호로 판별 불가 → 이름/닉네임으로 매칭 (기존 방식)
    if (cName && oName === cName) return true;
    if (cName && oName.includes(cName)) return true;
    if (c.nickname && oName.includes(c.nickname)) return true;
    return false;
  };

  // 출고완료 주문 — 이 화면이 직접 읽는다.
  // 넘겨받는 orders 는 활성 주문뿐이라(2026-08-25 부터) 출고완료가 하나도 없다. 그걸 모르고
  // orders 에서 출고완료를 세는 바람에, 같은 이름의 고객이 둘 이상이면 출고가 0건으로 나왔고
  // 주문 이력은 누구든 '주문 없음'이었다.
  //   null = 아직 읽는 중 (그동안 건수는 '…' 로 보인다 — 0 으로 보이면 그게 곧 거짓말이다)
  const [shippedKeys, setShippedKeys] = useState(null);
  const [shippedFailed, setShippedFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    db.fetchShippedOrderKeys()
      .then(r => { if (alive) { setShippedKeys(r); setShippedFailed(false); } })
      .catch(e => { console.error("출고완료 주문 조회 실패:", e); if (alive) { setShippedKeys([]); setShippedFailed(true); } });
    return () => { alive = false; };
  }, []);

  // 활성 주문 + 출고완료 주문. 환불신청 중인 출고완료 건은 양쪽에 다 있어 id 로 한 번만 넣는다.
  const allOrders = useMemo(() => {
    const seen = new Set((shippedKeys || []).map(o => o.id));
    return [...(shippedKeys || []), ...orders.filter(o => !seen.has(o.id))];
  }, [orders, shippedKeys]);

  // 성능: 고객별 통계(출고건수/최근주문 timestamp/최근출고일/출고완료주문 배열)를 한 번에 계산.
  //
  // 고객 2천 명 × 주문 5천 건을 전부 맞대면 천만 번을 견준다. 전화번호로 먼저 묶어 두고
  // 고객마다 자기 번호 칸만 본다. 판정 기준은 위 isSameCustomer 와 같다 —
  //   둘 다 번호가 있으면 번호로만 정하고(둘 다 10자리 이상이면 전체, 아니면 가운데 4자리),
  //   한쪽이라도 번호가 없으면 이름·닉네임으로 맞춘다.
  const orderStatsByCustomer = useMemo(() => {
    // 동명이인 판별 — 같은 이름 고객이 2명 이상이면 저장 카운터(totalOrders)가 서로 섞여
    // 부정확하므로, 그 이름은 실제 매칭된 주문 수만 신뢰한다.
    const nameCount = {};
    for (const c of customers) nameCount[c.name] = (nameCount[c.name] || 0) + 1;

    const dg = s => String(s || "").replace(/\D/g, "");
    const byMid = new Map();   // 가운데 4자리(또는 짧은 번호 그대로) → 주문들
    const noPhone = [];        // 번호 없는 주문 — 이름으로만 맞출 수 있다
    const prepared = allOrders.map(o => {
      const d = dg(o.phone);
      const p = { o, d, name: o.customer || "" };
      if (!d) noPhone.push(p);
      else {
        const mid = d.length >= 10 ? d.slice(3, 7) : d;
        if (!byMid.has(mid)) byMid.set(mid, []);
        byMid.get(mid).push(p);
      }
      return p;
    });
    const nameHit = (p, c) =>
      (!!c.name && (p.name === c.name || p.name.includes(c.name))) || (!!c.nickname && p.name.includes(c.nickname));

    const map = new Map();
    for (const c of customers) {
      const cd = dg(c.phone);
      let hits;
      if (!cd) hits = prepared.filter(p => nameHit(p, c));
      else {
        const cmid = cd.length >= 10 ? cd.slice(3, 7) : cd;
        hits = [
          ...(byMid.get(cmid) || []).filter(p => (cd.length >= 10 && p.d.length >= 10) ? p.d === cd : true),
          ...noPhone.filter(p => nameHit(p, c)),
        ];
      }
      const cAll = hits.map(p => p.o);
      const shipped = cAll.filter(o => o.status === "출고완료");
      let lastTs = 0;
      for (const o of cAll) {
        const ts = parseOrderDate(o.date);
        if (ts > lastTs) lastTs = ts;
      }
      let shipTs = 0, shipStr = "";
      for (const o of shipped) {
        const ts = parseOrderDate(o.date);
        if (ts > shipTs) { shipTs = ts; shipStr = o.date; }
      }
      // 동명이인: 실제 매칭 주문 수만 사용 / 유일 이름: 저장 카운터를 하한으로(엑셀·과거이력 반영)
      const isDup = (nameCount[c.name] || 0) > 1;
      map.set(c.id, {
        cnt: isDup ? shipped.length : Math.max(c.totalOrders||0, shipped.length),
        lastOrderTs: lastTs,
        latestShipStr: shipStr,
        shipped,
      });
    }
    return map;
  }, [customers, allOrders]);

  // 펼친 고객의 주문 이력 — 품목까지 보여야 해서 그 몇 건만 따로 읽는다.
  const [orderDetail, setOrderDetail] = useState({});   // 주문 id → 품목이 든 주문
  useEffect(() => {
    if (!selected) return;   // selected 는 고객 객체다
    const ids = (orderStatsByCustomer.get(selected.id)?.shipped || []).slice(0, 4).map(o => o.id).filter(id => !orderDetail[id]);
    if (ids.length === 0) return;
    let alive = true;
    db.fetchOrdersByIds(ids)
      .then(rows => { if (alive) setOrderDetail(p => ({ ...p, ...Object.fromEntries(rows.map(r => [r.id, r])) })); })
      .catch(e => console.warn("주문 이력 조회 실패:", e));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, orderStatsByCustomer]);

  // 적립금: name → balance Map (credits 변경 시에만 재계산)
  const balanceByCustomer = useMemo(() => {
    const map = new Map();
    for (const c of (credits||[])) {
      const cur = map.get(c.customer) || 0;
      map.set(c.customer, cur + (c.type === "적립" ? c.amount : -c.amount));
    }
    return map;
  }, [credits]);

  // 무료배송권: name → 보유 수량 Map (freeShipping 변경 시에만 재계산)
  const freeShippingByCustomer = useMemo(() => {
    const map = new Map();
    for (const fs of (freeShipping||[])) map.set(fs.customer, fs.count || 0);
    return map;
  }, [freeShipping]);
  const getFreeShipping = name => freeShippingByCustomer.get(name) || 0;

  const getStats = c => orderStatsByCustomer.get(c.id) || { cnt:0, lastOrderTs:0, latestShipStr:"", shipped:[] };
  const custOrders = c => getStats(c).shipped;
  // 읽는 중에는 '…' — 다 읽기 전의 숫자는 틀린 숫자다
  const shipCount = c => shippedKeys === null ? "…" : getStats(c).cnt;
  const latestShipDate = c => getStats(c).latestShipStr;
  const getBalance = name => balanceByCustomer.get(name) || 0;

  // 중복 의심 — 같은 전화번호를 쓰는 고객이 둘 이상인 묶음. 관리자만 본다.
  //
  // 번호는 숫자만 남겨 견준다(010-1234-5678 과 01012345678 은 같은 번호다). 9자리 미만은
  // 뺀다 — 가운데 4자리만 저장된 옛 고객은 서로 다른 사람끼리도 숫자가 겹친다.
  // 감시(ops/watch)와 같은 기준이되, 감시는 이름이 다른 묶음만 세고 여기는 이름까지
  // 같은 묶음도 넣는다. 이름까지 같은 쪽이 오히려 같은 사람일 가능성이 높다.
  //
  // '의심'이다. 한 번호를 가족이나 같은 공방 사람이 함께 쓰는 경우가 실제로 있어서,
  // 묶음에 들었다고 중복인 건 아니다. 그래서 자동으로 합치지 않고 보여주기만 한다.
  const dupInfo = useMemo(() => {
    const groups = new Map();
    for (const c of customers) {
      const d = String(c.phone || "").replace(/\D/g, "");
      if (d.length < 9) continue;
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(c);
    }
    const byId = new Map();
    let n = 0;
    for (const [d, list] of groups) {
      if (list.length < 2) continue;
      n++;
      const sameName = new Set(list.map(c => (c.name || "").trim())).size === 1;
      for (const c of list) byId.set(c.id, { key: d, no: n, size: list.length, sameName });
    }
    return { byId, groups: n };
  }, [customers]);

  // 필터+정렬을 메모이즈 — 페이지 변경 시 재계산되지 않도록.
  const filtered = useMemo(() => {
    const list = customers
      .filter(c => c.name.includes(search) || (c.phone||"").includes(search) || (c.nickname||"").includes(search))
      .filter(c => !creditOnly || (balanceByCustomer.get(c.name) || 0) > 0)
      .filter(c => !freeShipOnly || (freeShippingByCustomer.get(c.name) || 0) > 0)
      .filter(c => !dupOnly || dupInfo.byId.has(c.id));
    // 중복 의심만 볼 때는 고른 정렬 대신 묶음끼리 붙여 놓는다 — 견줘 보려고 여는 화면이라
    // 같은 번호의 고객이 떨어져 있으면 쓸모가 없다. 이름까지 같은 묶음을 위로.
    if (dupOnly) {
      return list.sort((a, b) => {
        const x = dupInfo.byId.get(a.id), y = dupInfo.byId.get(b.id);
        return (y.sameName ? 1 : 0) - (x.sameName ? 1 : 0) || x.key.localeCompare(y.key) || (a.id > b.id ? 1 : -1);
      });
    }
    return list
      .sort((a, b) => {
        if (sort === "orders") {
          return (orderStatsByCustomer.get(b.id)?.cnt || 0) - (orderStatsByCustomer.get(a.id)?.cnt || 0);
        }
        if (sort === "name") return a.name.localeCompare(b.name, "ko");
        if (sort === "latest") {
          return (orderStatsByCustomer.get(b.id)?.lastOrderTs || 0) - (orderStatsByCustomer.get(a.id)?.lastOrderTs || 0);
        }
        if (sort === "registered") return (b.id || 0) - (a.id || 0);
        return 0;
      });
  }, [customers, search, sort, creditOnly, freeShipOnly, dupOnly, dupInfo, orderStatsByCustomer, balanceByCustomer, freeShippingByCustomer]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const paged = filtered.slice((curPage-1)*PER_PAGE, curPage*PER_PAGE);

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontFamily:SF,fontSize:20,fontWeight:700}}>고객 관리</div>
        <GhostBtn onClick={exportCustomers} small>⬇ 엑셀</GhostBtn>
      </div>
      <div style={{marginBottom:12,position:"relative"}}>
        <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="고객명 / 연락처 / 닉네임 검색" style={{...baseInp,paddingLeft:34}}/>
        <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",color:G.creamMuted,fontSize:13}}>🔍</span>
      </div>
      <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
        {[["latest","최신순"],["orders","주문수"],["name","기본"],["registered","등록순"]].map(([k,l])=>(
          <button key={k} onClick={()=>{setSort(k);setPage(1);}} style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${sort===k?G.copper:G.border}`,background:sort===k?G.copperGlow:"transparent",color:sort===k?G.copper:G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:sort===k?700:400}}>{l}</button>
        ))}
        <button onClick={()=>{setCreditOnly(v=>!v);setPage(1);}} style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${creditOnly?G.purple:G.border}`,background:creditOnly?"rgba(138,106,184,0.15)":"transparent",color:creditOnly?G.purple:G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:creditOnly?700:400}}>💰 적립금 보유</button>
        <button onClick={()=>{setFreeShipOnly(v=>!v);setPage(1);}} style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${freeShipOnly?"#b45309":G.border}`,background:freeShipOnly?"rgba(180,83,9,0.15)":"transparent",color:freeShipOnly?"#b45309":G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:freeShipOnly?700:400}}>🎟️ 배송권 보유</button>
        {/* 중복 의심 — 관리자만. 고객을 지우는 것도 관리자만 할 수 있어서, 찾아도 정리할 수 없는
            사람에게는 보여주지 않는다. 묶음 수를 늘 달아 둔다 — 늘었는지가 버튼에서 보이게. */}
        {isAdmin && (
          <button onClick={()=>{setDupOnly(v=>!v);setPage(1);setSelected(null);}} aria-pressed={dupOnly}
            title="같은 전화번호를 쓰는 고객 묶음"
            style={{padding:"5px 12px",fontSize:11,borderRadius:16,border:`1px solid ${dupOnly?G.red:G.border}`,background:dupOnly?G.redBg:"transparent",color:dupOnly?G.red:G.creamMuted,cursor:"pointer",fontFamily:S,fontWeight:dupOnly?700:400}}>
            👥 중복 의심 {dupInfo.groups}묶음
          </button>
        )}
      </div>
      {dupOnly && (
        <div style={{fontSize:11.5,color:G.creamMuted,marginBottom:10,padding:"9px 12px",borderRadius:10,border:`1px solid ${G.border}`,background:G.surface,lineHeight:1.6}}>
          <b style={{color:G.cream}}>같은 전화번호</b>를 쓰는 고객끼리 붙여 놓았습니다 · 이름까지 같은 묶음이 위에 있습니다.
          가족이나 같은 공방처럼 <b style={{color:G.cream}}>실제로 다른 사람일 수 있습니다</b> — 같은 사람이 맞으면 한쪽을 펼쳐 🗑 로 지우세요.
          주문은 전화번호로 이어져 있어 남은 고객에게 그대로 보입니다.
        </div>
      )}
      {filtered.length>0 && (
        <div style={{fontSize:11,color:G.creamMuted,marginBottom:8}}>
          총 {filtered.length}명 {totalPages>1 && <>· {(curPage-1)*PER_PAGE+1}–{Math.min(curPage*PER_PAGE, filtered.length)}번째</>}
        </div>
      )}
      <div style={{marginBottom:12}}>
        {filtered.length===0
          ? <Empty text={search?"검색 결과 없음":"등록된 고객이 없습니다"} sub={search?"":"주문 등록 시 자동으로 추가됩니다"}/>
          : paged.map((c, idx)=>{
            const isOpen = selected?.id===c.id;
            const dup = isAdmin ? dupInfo.byId.get(c.id) : null;
            // 중복 의심만 볼 때 — 묶음이 바뀌는 자리에 줄을 하나 긋는다
            const newGroup = dupOnly && dup && (idx === 0 || dupInfo.byId.get(paged[idx-1].id)?.key !== dup.key);
            return (
              <div key={c.id} style={{marginBottom:6}}>
                {newGroup && (
                  <div style={{display:"flex",alignItems:"center",gap:8,margin:idx===0?"0 0 6px":"14px 0 6px"}}>
                    <span style={{fontSize:11,fontWeight:800,color:dup.sameName?G.red:G.yellow,whiteSpace:"nowrap"}}>
                      {dup.sameName ? "이름까지 같음" : "이름은 다름"} · {dup.size}명 · …{dup.key.slice(-4)}
                    </span>
                    <div style={{flex:1,height:1,background:G.border}}/>
                  </div>
                )}
                <div onClick={()=>setSelected(isOpen?null:c)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",background:G.card,borderRadius:isOpen?"12px 12px 0 0":"12px",border:`1px solid ${isOpen?G.copper+"60":G.border}`,borderBottom:isOpen?"none":`1px solid ${G.border}`,cursor:"pointer",transition:"all 0.15s"}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:G.copperGlow,border:`1px solid ${G.copper}40`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:SF,fontSize:14,fontWeight:700,color:G.copper,flexShrink:0}}>
                    {c.name.slice(0,1)}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:14,marginBottom:2,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span>{c.name}</span>
                      {c.phone && <span style={{fontSize:11,fontWeight:700,fontFamily:SF,color:G.copper,background:G.copperGlow,border:`1px solid ${G.copper}40`,borderRadius:6,padding:"1px 6px"}}>{normalizePhone(c.phone)}</span>}
                      {c.address2 && <span style={{fontSize:10,fontWeight:700,color:G.blue,background:G.blueBg,border:`1px solid ${G.blue}40`,borderRadius:6,padding:"1px 6px"}}>📍 배송지 2곳</span>}
                      {/* 관리자에게는 평소 목록에서도 보인다 — 검색하다 마주쳤을 때 알아채게 */}
                      {dup && !dupOnly && <span title="같은 전화번호를 쓰는 고객이 또 있습니다" style={{fontSize:10,fontWeight:700,color:dup.sameName?G.red:G.yellow,background:dup.sameName?G.redBg:G.yellowBg,border:`1px solid ${(dup.sameName?G.red:G.yellow)}40`,borderRadius:6,padding:"1px 6px"}}>👥 같은 번호 {dup.size}명</span>}
                    </div>
                    <div style={{fontSize:11,color:G.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.phone||"연락처 없음"}{c.nickname?` · ${c.nickname}`:""} · {c.address||"배송지 없음"}{c.addressDetail?` ${c.addressDetail}`:""}</div>
                    {/* 배송지 2 보유 고객 — 카드에서도 두 번째 주소를 바로 확인 */}
                    {c.address2 && (
                      <div style={{fontSize:11,color:G.creamMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:1}}>
                        📍 배송지2{c.address2Label?` (${c.address2Label})`:""} · {c.address2}{c.address2Detail?` ${c.address2Detail}`:""}
                      </div>
                    )}
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
                    {getBalance(c.name)>0 && (
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:SF,fontSize:13,fontWeight:700,color:G.purple}}>{getBalance(c.name).toLocaleString()}</div>
                        <div style={{fontSize:9,color:G.creamMuted}}>적립금</div>
                      </div>
                    )}
                    {getFreeShipping(c.name)>0 && (
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:SF,fontSize:13,fontWeight:700,color:"#b45309"}}>🎟️ {getFreeShipping(c.name)}</div>
                        <div style={{fontSize:9,color:G.creamMuted}}>배송권</div>
                      </div>
                    )}
                    <div style={{textAlign:"right"}}>
                      <div style={{fontFamily:SF,fontSize:16,fontWeight:700,color:G.copper}}>{shipCount(c)}</div>
                      <div style={{fontSize:10,color:G.creamMuted}}>출고</div>
                    </div>
                  </div>
                </div>
                {isOpen && (
                  <div style={{padding:"14px 16px",background:G.card,borderRadius:"0 0 12px 12px",border:`1px solid ${G.copper}60`,borderTop:`1px solid ${G.border}`}}>
                    <div style={{display:"flex",gap:5,marginBottom:12,flexWrap:"wrap"}}>
                      <button onClick={()=>setEditingCust({...c})} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.border}`,background:"transparent",color:G.creamMuted,cursor:"pointer",fontFamily:S}}>✏ 수정</button>
                      <button onClick={()=>kakaoAlert(`[로하이마켓] ${c.name} 고객님 메시지 테스트`)} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.yellow}`,background:G.yellowBg,color:G.yellow,cursor:"pointer",fontFamily:S}}>카톡</button>
                      {isAdmin && <button onClick={()=>{setConfirmDel({type:"customer",id:c.id,label:c.name});setSelected(null);}} style={{padding:"5px 10px",fontSize:11,borderRadius:8,border:`1px solid ${G.red}40`,background:G.redBg,color:G.red,cursor:"pointer",fontFamily:S}}>🗑</button>}
                    </div>
                    <div style={{background:G.surface,borderRadius:10,overflow:"hidden",border:`1px solid ${G.border}`,marginBottom:12}}>
                      {[{l:"연락처",v:c.phone||"—"},{l:"닉네임",v:c.nickname||"—"},{l:"배송지",v:(c.address||"—")+(c.addressDetail?` ${c.addressDetail}`:"")},...(c.address2?[{l:`배송지 2${c.address2Label?` (${c.address2Label})`:""}`,v:c.address2+(c.address2Detail?` ${c.address2Detail}`:"")}]:[]),{l:"출고완료",v:`${shipCount(c)}건`},{l:"최근출고",v:latestShipDate(c)||"—"},{l:"적립금",v:getBalance(c.name)>0?`${getBalance(c.name).toLocaleString()}원`:"없음"},{l:"무료배송권",v:getFreeShipping(c.name)>0?`${getFreeShipping(c.name)}장`:"없음"},{l:"메모",v:c.note||"—"}].map(({l,v},i)=>(
                        <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"9px 14px",borderTop:i>0?`1px solid ${G.border}`:"none",fontSize:13}}>
                          <span style={{color:G.creamMuted,whiteSpace:"nowrap",flexShrink:0,marginRight:12}}>{l}</span>
                          <span style={{fontWeight:500,textAlign:"right",minWidth:0}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{fontSize:11,color:G.copper,fontWeight:700,letterSpacing:"0.08em",marginBottom:8}}>주문 이력</div>
                    {shippedKeys === null
                      ? <div style={{color:G.creamMuted,fontSize:12,textAlign:"center",padding:"8px 0"}}>불러오는 중…</div>
                      : custOrders(c).length===0
                      ? <div style={{color:G.creamMuted,fontSize:12,textAlign:"center",padding:"8px 0"}}>{shippedFailed ? "출고 이력을 불러오지 못했습니다 — 새로고침해 주세요" : "출고된 주문 없음"}</div>
                      : custOrders(c).slice(0,4).map((o,i)=>{
                        // 품목은 펼칠 때 따로 읽는다(orderDetail). 오기 전에는 날짜와 상태만 보인다.
                        const items = orderDetail[o.id]?.items || o.items;
                        return (
                        <div key={o.id} style={{display:"flex",gap:8,alignItems:"center",padding:"7px 0",borderTop:i>0?`1px solid ${G.border}`:"none",fontSize:12}}>
                          <span style={{color:G.copper,fontWeight:700,fontSize:11}}>#{String(o.id).slice(0,8)}</span>
                          <span style={{color:G.creamMuted}}>{o.date}</span>
                          <span style={{flex:1}}>{items ? items.map(i=>`${i.fabric} ${i.qty}${i.unit||"마"}`).join(", ") : "…"}</span>
                          <Tag c={sC(o.status,G)[0]} bg={sC(o.status,G)[1]}>{o.status}</Tag>
                        </div>
                        );
                      })
                    }
                    {custOrders(c).length > 4 && (
                      <div style={{color:G.creamMuted,fontSize:11,textAlign:"center",paddingTop:6}}>최근 4건 · 전체 {custOrders(c).length}건</div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        }
        {totalPages>1 && (
          <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:8,marginTop:10}}>
            <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={curPage<=1} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:curPage<=1?"transparent":G.surface,color:curPage<=1?G.border:G.creamMuted,fontSize:12,cursor:curPage<=1?"default":"pointer",fontFamily:S}}>←</button>
            <span style={{fontSize:12,color:G.creamMuted,fontFamily:SF}}>{curPage} / {totalPages}</span>
            <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={curPage>=totalPages} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${G.border}`,background:curPage>=totalPages?"transparent":G.surface,color:curPage>=totalPages?G.border:G.creamMuted,fontSize:12,cursor:curPage>=totalPages?"default":"pointer",fontFamily:S}}>→</button>
          </div>
        )}
      </div>
      <Card>
        <SecTitle>신규 고객 등록</SecTitle>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
          <div><FLabel>고객명 *</FLabel><input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="홍길동" style={baseInp}/></div>
          <div><FLabel>연락처</FLabel><input type="tel" inputMode="tel" value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="010-0000-0000" style={baseInp}/></div>
        </div>
        <div style={{marginBottom:8}}><FLabel>닉네임</FLabel><input value={form.nickname} onChange={e=>setForm(f=>({...f,nickname:e.target.value}))} placeholder="별명/상호" style={baseInp}/></div>
        <div style={{marginBottom:8}}>
          <FLabel>배송지</FLabel>
          <div style={{display:"flex",gap:6}}>
            <input value={form.address} onChange={e=>setForm(f=>({...f,address:e.target.value}))} placeholder="주소 검색을 눌러주세요" style={{...baseInp,flex:1,minWidth:0}}/>
            <button onClick={()=>setAddrOpen(true)} style={{flexShrink:0,padding:"0 14px",borderRadius:10,border:`1px solid ${G.copper}`,background:G.copperGlow,color:G.copper,fontSize:12,fontWeight:700,fontFamily:S,cursor:"pointer",whiteSpace:"nowrap"}}>🔍 검색</button>
          </div>
        </div>
        <div style={{marginBottom:8}}><FLabel>상세주소</FLabel><input value={form.addressDetail} onChange={e=>setForm(f=>({...f,addressDetail:e.target.value}))} placeholder="단지명 · 동/호 등" style={baseInp}/></div>
        <div style={{marginBottom:10}}><FLabel>메모</FLabel><input value={form.note} onChange={e=>setForm(f=>({...f,note:e.target.value}))} placeholder="특이사항" style={baseInp}/></div>
        <PrimaryBtn onClick={add} full>고객 등록</PrimaryBtn>
      </Card>
      {addrOpen && <AddressSearchModal onComplete={({address})=>setForm(f=>({...f,address}))} onClose={()=>setAddrOpen(false)}/>}
    </div>
  );
}


// ══════════════════════════════════════════
export default CustomerTab;
