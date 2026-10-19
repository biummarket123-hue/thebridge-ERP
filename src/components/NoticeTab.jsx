import { useState, useMemo } from "react";
import { Card, Empty } from "./UI.jsx";
import { S, SF, useTheme } from "../constants.js";
import * as db from "../lib/db.js";
import { parseDepositList, guessManagers } from "../lib/parseDeposit.js";

// 공지판 — 입금은 들어왔는데 ERP에 주문이 없는 건을 주인에게 보낸다.
//
// 지금까지는 관리자가 직원용 네이버 밴드에 올렸다. 밴드로는 세 가지가 안 됐다:
//  1) 글이 흘러내려 아직 안 끝난 건이 스크롤 위로 사라진다
//  2) 누구 건인지 사람이 기억을 뒤져야 한다
//  3) 처리됐는지가 댓글로 흩어진다
//
// 그래서 이 화면은:
//  · 미해결만 위에 남기고, 처리되면 접는다 — 목록 길이가 곧 남은 일의 양이다
//  · 입금자명으로 과거 주문의 담당자를 조회해 후보를 띄운다 (ERP라서 되는 일)
//  · 주인 찾음 → 처리 완료 두 단계를 나눈다. 그 사이에 시간이 걸리고,
//    그동안 다른 사람이 중복으로 달라붙으면 두 번 일한다

const won = (n) => (n || 0).toLocaleString() + "원";

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function NoticeTab({ notices = [], orders = [], reloadNotices, showToast, activeManager = "", isAdmin = false }) {
  const T = useTheme();
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState([]);     // 파싱 결과. 그대로 저장하지 않고 고칠 수 있게 둔다
  const [busy, setBusy] = useState(null);
  const [showDone, setShowDone] = useState(false);

  const open = useMemo(() => notices.filter(n => !n.resolvedAt), [notices]);
  const done = useMemo(() => notices.filter(n => n.resolvedAt), [notices]);

  // 이미 올라온 건과 겹치는지 — 같은 금액·같은 입금자면 중복으로 본다.
  // 밴드 글은 어제 것까지 통째로 다시 붙여넣게 되는데, 그때마다 같은 건이 쌓이면
  // '처리할 일'이 부풀어 신뢰를 잃는다.
  const dupKeys = useMemo(
    () => new Set(notices.map(n => `${n.amount}|${(n.depositor || "").trim()}`)), [notices]);

  // 붙여넣는 즉시 여러 건을 한꺼번에 뽑는다. 밴드 글은 하루치를 한 덩어리로 올리므로
  // 한 건씩 입력받으면 그게 곧 손으로 옮겨 적는 일이 된다.
  const onPaste = (text) => {
    setRaw(text);
    setRows(parseDepositList(text).map((r, i) => ({ ...r, key: i, memo: "" })));
  };

  const patch = (key, f) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...f } : r)));
  const drop = (key) => setRows(rs => rs.filter(r => r.key !== key));

  const submit = async () => {
    const ok = rows.filter(r => r.amount > 0);
    if (!ok.length) { showToast?.("올릴 건이 없습니다 — 입금액을 확인해 주세요", "error"); return; }
    setBusy("new");
    try {
      // 한 건이라도 실패하면 어디까지 올라갔는지 알아야 다시 붙여넣을 수 있다
      let n = 0;
      for (const r of ok) {
        await db.insertNotice({
          amount: r.amount, depositor: r.depositor, depositedAt: r.at,
          rawText: r.raw, memo: r.memo || "", createdBy: activeManager || "",
        });
        n++;
      }
      await reloadNotices?.();
      setRaw(""); setRows([]);
      showToast?.(`${n}건 올렸습니다 — 전원 화면에 뜹니다`);
    } catch (e) {
      await reloadNotices?.();
      showToast?.("처리 실패: " + e.message + " — 올라간 건은 목록에서 확인해 주세요", "error");
    } finally { setBusy(null); }
  };

  const claim = async (n) => {
    setBusy(n.id);
    try {
      // 이미 내가 잡은 건이면 놓아준다(잘못 눌렀을 때 되돌릴 길이 필요하다)
      const mine = n.claimedBy === activeManager;
      await db.claimNotice(n.id, mine ? "" : (activeManager || "확인"));
      await reloadNotices?.();
      showToast?.(mine ? "내 건 표시를 해제했습니다" : `${activeManager || "확인"}님이 맡았습니다`);
    } catch (e) { showToast?.("처리 실패: " + e.message, "error"); }
    finally { setBusy(null); }
  };

  const resolve = async (n, on) => {
    setBusy(n.id);
    try {
      await db.resolveNotice(n.id, on ? (activeManager || "확인") : "", null);
      await reloadNotices?.();
      showToast?.(on ? "처리 완료" : "미해결로 되돌렸습니다");
    } catch (e) { showToast?.("처리 실패: " + e.message, "error"); }
    finally { setBusy(null); }
  };

  const remove = async (n) => {
    setBusy(n.id);
    try {
      await db.deleteNotice(n.id);
      await reloadNotices?.();
      showToast?.("삭제했습니다");
    } catch (e) { showToast?.("처리 실패: " + e.message, "error"); }
    finally { setBusy(null); }
  };

  const Row = ({ n, dim }) => {
    const working = busy === n.id;
    const mine = n.claimedBy && n.claimedBy === activeManager;
    // 담당자 추측 — 확정이 아니라 힌트다. 못 맞히면 아무 표시도 안 한다(틀린 이름은 헛걸음을 만든다).
    const guess = useMemo(() => n.claimedBy ? [] : guessManagers(n.depositor, orders), [n.claimedBy, n.depositor]);
    return (
      <div style={{padding:"12px 0",borderTop:`1px solid ${T.border}`,opacity:dim?0.55:1}}>
        <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
          <span style={{fontFamily:SF,fontSize:19,fontWeight:900,color:T.cream}}>{won(n.amount)}</span>
          <span style={{fontSize:14,fontWeight:800,color:T.copper}}>{n.depositor || "입금자명 없음"}</span>
          {n.depositedAt && <span style={{fontSize:11,color:T.creamMuted}}>{fmtWhen(n.depositedAt)} 입금</span>}
          <span style={{marginLeft:"auto",fontSize:10.5,color:T.creamMuted,whiteSpace:"nowrap"}}>
            {n.createdBy && `${n.createdBy} · `}{fmtWhen(n.createdAt)}
          </span>
        </div>

        {n.memo && (
          <div style={{marginTop:5,fontSize:12.5,color:T.cream,background:T.subtleBg,
            padding:"6px 9px",borderRadius:6,lineHeight:1.55,whiteSpace:"pre-wrap"}}>📝 {n.memo}</div>
        )}

        {/* 담당자 후보 — 입금자명으로 과거 주문을 뒤진 결과. 이게 "누구 거예요?"를 없앤다. */}
        {guess.length > 0 && (
          <div style={{marginTop:6,fontSize:11.5,color:T.creamMuted,lineHeight:1.6}}>
            💡 과거 주문 기준 —{" "}
            {guess.map((g, i) => (
              <span key={g.name}>
                {i > 0 && ", "}
                <b style={{color:T.blue,fontWeight:800}}>{g.name}</b>님 {g.n}건
              </span>
            ))}
          </div>
        )}

        {n.resolvedAt ? (
          <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span style={{fontSize:11.5,fontWeight:800,color:T.green}}>
              ✅ {n.resolvedBy}님 처리 · {fmtWhen(n.resolvedAt)}
            </span>
            <button onClick={()=>resolve(n, false)} disabled={working} style={{
              padding:"4px 10px",borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",
              color:T.creamMuted,fontFamily:S,fontSize:11,cursor:"pointer"}}>되돌리기</button>
          </div>
        ) : (
          <div style={{marginTop:9,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {n.claimedBy && !mine && (
              <span style={{fontSize:11.5,fontWeight:800,color:T.blue,background:T.blueBg,
                padding:"5px 9px",borderRadius:7}}>🙋 {n.claimedBy}님이 맡음</span>
            )}
            <button onClick={()=>claim(n)} disabled={working} style={{
              padding:"8px 12px",borderRadius:8,cursor:working?"wait":"pointer",fontFamily:S,
              fontSize:12.5,fontWeight:800,
              border: mine ? "none" : `1px solid ${T.blue}`,
              background: mine ? T.blue : "transparent", color: mine ? "#fff" : T.blue}}>
              {mine ? "🙋 내가 맡음 (해제)" : "🙋 제 건입니다"}
            </button>
            {/* 주문 등록으로 넘기는 버튼은 두지 않는다 — 어차피 로하톡에 기록을 남겨야 해서
                거기 다시 쓰게 된다. 여기서 넘겨도 한 번 더 옮겨 적는 일이 될 뿐이다. */}
            <button onClick={()=>resolve(n, true)} disabled={working} style={{
              padding:"8px 12px",borderRadius:8,cursor:working?"wait":"pointer",fontFamily:S,
              fontSize:12.5,fontWeight:900,border:"none",
              background:`linear-gradient(135deg,${T.green},${T.green})`,color:"#fff"}}>
              ✅ 처리 완료
            </button>
            {isAdmin && (
              <button onClick={()=>remove(n)} disabled={working} style={{
                marginLeft:"auto",padding:"6px 9px",borderRadius:7,border:"none",background:"transparent",
                color:T.creamMuted,fontFamily:S,fontSize:11,cursor:"pointer"}}>삭제</button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* 올리기 — 관리자만. 은행 알림을 그대로 붙여넣으면 금액·입금자명을 뽑아준다. */}
      {isAdmin && (
        <Card>
          <div style={{fontFamily:SF,fontSize:15,fontWeight:900,color:T.cream,marginBottom:4}}>
            입금 알림 올리기
          </div>
          <div style={{fontSize:11.5,color:T.creamMuted,marginBottom:8,lineHeight:1.55}}>
            밴드에 올리시던 목록이나 은행 문자를 <b style={{color:T.cream}}>그대로 통째로</b> 붙여넣으세요.
            여러 건을 한 번에 뽑아 드립니다
          </div>
          <textarea value={raw} onChange={e=>onPaste(e.target.value)} rows={4}
            placeholder={"예)\n2026-08-13 10:10:12      31,500\n이미행\n2026-08-13 10:31:02       4,000\n이현경"}
            style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:9,
              border:`1px solid ${T.border}`,background:T.surface,color:T.cream,
              fontFamily:S,fontSize:13,outline:"none",resize:"vertical",lineHeight:1.6}}/>

          {raw.trim() && rows.length === 0 && (
            <div style={{marginTop:8,fontSize:11.5,fontWeight:800,color:T.yellow,
              background:T.yellowBg,padding:"8px 11px",borderRadius:7,lineHeight:1.55}}>
              ⚠️ 입금 건을 못 찾았습니다 — 금액이 있는 줄이 있는지 확인해 주세요
            </div>
          )}

          {rows.length > 0 && (
            <>
              <div style={{margin:"10px 0 6px",fontSize:12,fontWeight:800,color:T.cream}}>
                {rows.length}건을 찾았습니다 — 확인하고 고쳐 주세요
              </div>
              {/* 뽑아낸 값은 고칠 수 있는 칸에 채운다. 은행·형식마다 문구가 달라 틀릴 수 있고,
                  잘못된 금액이 조용히 올라가면 그걸 믿고 주문을 만든다. */}
              {rows.map(r => {
                const dup = dupKeys.has(`${r.amount}|${(r.depositor||"").trim()}`);
                const g = r.depositor ? guessManagers(r.depositor, orders) : [];
                return (
                  <div key={r.key} style={{marginBottom:6,padding:"8px 9px",borderRadius:8,
                    border:`1px solid ${dup ? T.yellow : T.border}`,
                    background: dup ? T.yellowBg : T.subtleBg}}>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                      <input value={r.amount ? r.amount.toLocaleString() : ""}
                        onChange={e=>patch(r.key,{amount:Number(String(e.target.value).replace(/[^\d]/g,""))||0})}
                        placeholder="입금액" inputMode="numeric"
                        style={{flex:"1 1 110px",minWidth:0,boxSizing:"border-box",padding:"8px 10px",borderRadius:7,
                          border:`1px solid ${r.amount?T.border:T.red}`,background:T.surface,color:T.cream,
                          fontFamily:SF,fontSize:15,fontWeight:800,outline:"none"}}/>
                      <input value={r.depositor} onChange={e=>patch(r.key,{depositor:e.target.value})}
                        placeholder="입금자명"
                        style={{flex:"1 1 110px",minWidth:0,boxSizing:"border-box",padding:"8px 10px",borderRadius:7,
                          border:`1px solid ${r.depositor?T.border:T.yellow}`,background:T.surface,color:T.cream,
                          fontFamily:S,fontSize:13.5,fontWeight:700,outline:"none"}}/>
                      <button onClick={()=>drop(r.key)} title="이 건 빼기" style={{flexShrink:0,
                        width:30,height:30,borderRadius:7,border:`1px solid ${T.border}`,background:"transparent",
                        color:T.creamMuted,fontSize:13,cursor:"pointer",lineHeight:1}}>✕</button>
                    </div>
                    <div style={{marginTop:4,fontSize:11,color:T.creamMuted,lineHeight:1.6}}>
                      {r.at && <span>{fmtWhen(r.at)} 입금</span>}
                      {dup && <b style={{color:T.yellow,marginLeft:6}}>· 이미 올라온 건 같습니다</b>}
                      {g.length > 0 && (
                        <span style={{marginLeft:6}}>
                          💡 {g.map((x,i)=>(<span key={x.name}>{i>0 && ", "}<b style={{color:T.blue}}>{x.name}</b>님 {x.n}건</span>))}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <button onClick={submit} disabled={busy==="new"} style={{
                width:"100%",marginTop:4,padding:"12px",borderRadius:9,border:"none",
                cursor:busy==="new"?"wait":"pointer",fontFamily:S,fontSize:14.5,fontWeight:900,
                background:`linear-gradient(135deg,${T.copper},${T.copperLight})`,color:"#fff",
                opacity:busy==="new"?0.6:1}}>
                {busy==="new" ? "올리는 중…" : `📣 ${rows.filter(r=>r.amount>0).length}건 올리기`}
              </button>
            </>
          )}
        </Card>
      )}

      <div style={{display:"flex",alignItems:"center",gap:8,margin:"14px 0 4px"}}>
        <span style={{fontFamily:SF,fontSize:16,fontWeight:900,color:open.length?T.copper:T.creamMuted}}>
          처리할 일 {open.length}건
        </span>
        {done.length > 0 && (
          <button onClick={()=>setShowDone(v=>!v)} style={{
            marginLeft:"auto",padding:"5px 11px",borderRadius:20,border:`1px solid ${T.border}`,
            background:"transparent",color:T.creamMuted,fontFamily:S,fontSize:11.5,cursor:"pointer"}}>
            {showDone ? "완료 숨기기" : `완료 ${done.length}건 보기`}
          </button>
        )}
      </div>

      <Card>
        {open.length === 0
          ? <Empty msg="처리할 입금 건이 없습니다" />
          : open.map(n => <Row key={n.id} n={n} />)}
      </Card>

      {showDone && done.length > 0 && (
        <div style={{marginTop:12}}>
          <div style={{fontSize:12,color:T.creamMuted,marginBottom:4}}>처리 완료</div>
          <Card>{done.map(n => <Row key={n.id} n={n} dim />)}</Card>
        </div>
      )}
    </div>
  );
}

export default NoticeTab;
