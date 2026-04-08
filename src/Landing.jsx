import { useState } from "react";

function Landing({onStart}) {
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoTab, setDemoTab] = useState("input");
  const [aiText, setAiText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const heroGrad = "linear-gradient(135deg,#7C3AED,#EC4899,#F59E0B)";
  const V = {v1:"#7C3AED",v2:"#A855F7",v3:"#C084FC",g1:"#F59E0B",g2:"#FCD34D",t1:"#06B6D4",t2:"#67E8F9",r1:"#F43F5E",e2:"#6EE7B7",muted:"#8B82A8",border:"#252040",card:"#1A1630",surface:"#110E1E",cream:"#F0EBF8",ink:"#07050F"};
  const S = "'Noto Sans KR',sans-serif";
  const SF = "'Noto Serif KR',serif";

  const analyze = () => {
    if(!aiText.trim()) return;
    setParsing(true); setAiResult(null);
    setTimeout(()=>{
      const lines = aiText.split("\n").filter(l=>l.trim());
      const customer = lines[0]||"홍길동";
      const items = lines.filter(l=>/마/.test(l));
      const paid = aiText.includes("입금");
      setAiResult({customer, items, paid});
      setParsing(false);
    },1200);
  };

  const Tag = ({c,bg,children}) => (
    <span style={{padding:"2px 9px",borderRadius:20,fontSize:10,fontWeight:700,color:c,background:bg,display:"inline-block"}}>{children}</span>
  );

  return (
    <div style={{fontFamily:S,background:"#07050F",color:V.cream,minHeight:"100vh",overflowX:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@700;900&family=Noto+Sans+KR:wght@300;400;500;700;900&display=swap');
        *{margin:0;padding:0;box-sizing:border-box}
        @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
        @keyframes marquee{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
        @keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:.5}}
        @keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(20px,-25px)}}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
      `}</style>

      {/* 플래시 스트립 */}
      <div style={{height:36,background:"linear-gradient(135deg,#7C3AED,#A855F7)",overflow:"hidden",display:"flex",alignItems:"center"}}>
        <div style={{whiteSpace:"nowrap",animation:"marquee 16s linear infinite",display:"flex"}}>
          {["🤖 AI 주문 자동분석","📦 실시간 재고","🚚 CJ·경동 송장","🎁 계약금·잔금","📊 매출 대시보드","💬 카카오 알림"].concat(["🤖 AI 주문 자동분석","📦 실시간 재고","🚚 CJ·경동 송장","🎁 계약금·잔금","📊 매출 대시보드","💬 카카오 알림"]).map((t,i)=>(
            <span key={i} style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,.85)",padding:"0 28px",borderRight:"1px solid rgba(255,255,255,.15)"}}>{t}</span>
          ))}
        </div>
      </div>

      {/* NAV */}
      <nav style={{position:"sticky",top:0,zIndex:200,height:56,padding:"0 20px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(7,5,15,.88)",backdropFilter:"blur(20px)",borderBottom:"1px solid rgba(124,58,237,.2)"}}>
        <div style={{fontFamily:SF,fontSize:18,fontWeight:900,background:heroGrad,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>더브릿지</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={()=>setDemoOpen(true)} style={{padding:"8px 16px",borderRadius:8,border:"1.5px solid rgba(6,182,212,.4)",background:"rgba(6,182,212,.1)",color:"#67E8F9",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:S}}>👁 데모</button>
          <button onClick={onStart} style={{padding:"8px 18px",borderRadius:8,border:"none",background:heroGrad,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S,boxShadow:"0 4px 20px rgba(124,58,237,.4)"}}>ERP 시작 →</button>
        </div>
      </nav>

      {/* HERO */}
      <section style={{minHeight:"calc(100vh - 92px)",padding:"60px 20px 60px",display:"flex",flexDirection:"column",alignItems:"center",textAlign:"center",position:"relative",overflow:"hidden"}}>
        {/* 배경 orbs */}
        {[[600,600,"#7C3AED","-150px","-150px","0s"],[400,400,"#F59E0B","25%","right","-4s"],[350,350,"#06B6D4","bottom","15%","-7s"]].map(([w,h,c,t,l,d],i)=>(
          <div key={i} style={{position:"absolute",width:w,height:h,borderRadius:"50%",background:c,filter:"blur(90px)",opacity:.16,animation:`drift 10s ease-in-out infinite`,animationDelay:d,top:typeof t==="string"&&t.includes("%")?t:t,left:typeof l==="string"&&l!=="right"?l:undefined,right:l==="right"?"−100px":undefined,pointerEvents:"none"}}/>
        ))}
        <div style={{display:"inline-flex",alignItems:"center",gap:7,marginBottom:24,background:"rgba(124,58,237,.18)",border:"1px solid rgba(124,58,237,.4)",borderRadius:24,padding:"7px 18px",fontSize:11,fontWeight:700,color:V.v3,animation:"fadeUp .8s ease both"}}>
          <span style={{width:6,height:6,borderRadius:"50%",background:V.v1,animation:"pulse 1.8s infinite",display:"inline-block"}}/>
          동대문 원단시장 전용 AI ERP
        </div>
        <h1 style={{fontFamily:SF,fontSize:"clamp(34px,8vw,68px)",fontWeight:900,lineHeight:1.15,marginBottom:22,animation:"fadeUp .8s .1s ease both"}}>
          원단 도매업의<br/>
          <span style={{background:heroGrad,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>새로운 연결</span>
        </h1>
        <p style={{fontSize:"clamp(14px,2.5vw,17px)",color:V.muted,lineHeight:1.9,maxWidth:520,margin:"0 auto 44px",animation:"fadeUp .8s .2s ease both"}}>
          카카오톡 주문장을 붙여넣으면 <strong style={{color:V.cream}}>AI가 15초 안에</strong> 처리합니다.<br/>
          주문·재고·계약금·잔금·송장까지 하나의 플랫폼.
        </p>
        <div style={{display:"flex",gap:12,flexWrap:"wrap",justifyContent:"center",animation:"fadeUp .8s .3s ease both"}}>
          <button onClick={()=>setDemoOpen(true)} style={{padding:"14px 32px",borderRadius:13,border:"1.5px solid rgba(6,182,212,.4)",background:"rgba(6,182,212,.1)",color:"#67E8F9",fontWeight:800,fontSize:15,cursor:"pointer",fontFamily:S,display:"inline-flex",alignItems:"center",gap:7}}>👁 데모 보기</button>
          <button onClick={onStart} style={{padding:"15px 38px",borderRadius:13,border:"none",background:heroGrad,color:"#fff",fontWeight:800,fontSize:15,cursor:"pointer",fontFamily:S,boxShadow:"0 8px 36px rgba(124,58,237,.5)",display:"inline-flex",alignItems:"center",gap:7,position:"relative",overflow:"hidden"}}>
            🚀 ERP 바로 시작
          </button>
        </div>
        {/* 통계 */}
        <div style={{display:"flex",flexWrap:"wrap",gap:0,border:"1px solid "+V.border,borderRadius:18,overflow:"hidden",background:V.card,maxWidth:640,width:"100%",margin:"52px auto 0",animation:"fadeUp .8s .5s ease both"}}>
          {[["15초","카톡→주문 등록"],["100%","재고 자동 차감"],["0원","무료 시작"]].map(([n,l],i)=>(
            <div key={n} style={{flex:1,minWidth:120,padding:"24px 16px",textAlign:"center",borderRight:i<2?"1px solid "+V.border:"none"}}>
              <div style={{fontFamily:SF,fontSize:30,fontWeight:900,background:heroGrad,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text",lineHeight:1}}>{n}</div>
              <div style={{fontSize:11,color:V.muted,marginTop:6}}>{l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 기능 섹션 */}
      <section style={{padding:"80px 20px",maxWidth:900,margin:"0 auto"}}>
        <div style={{textAlign:"center",fontSize:11,fontWeight:700,letterSpacing:".14em",textTransform:"uppercase",color:V.v3,marginBottom:14}}>핵심 기능</div>
        <h2 style={{fontFamily:SF,fontSize:"clamp(24px,5vw,40px)",fontWeight:900,textAlign:"center",lineHeight:1.3,marginBottom:12}}>원단 도매업을 위한<br/>올인원 플랫폼</h2>
        <p style={{textAlign:"center",color:V.muted,fontSize:15,lineHeight:1.8,marginBottom:52}}>주문부터 재고, 계약금·잔금, 고객까지 — 하나에서.</p>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(250px,1fr))",gap:14}}>
          {[
            {icon:"🤖",t:"AI 주문 자동 분석",d:"카카오톡 메시지 붙여넣기 → AI가 고객·원단·수량 자동 추출. 15초."},
            {icon:"📦",t:"실시간 재고 관리",d:"주문 등록 시 재고 자동 차감. 바코드 연동. 부족 카카오 알림."},
            {icon:"🚚",t:"택배 송장 출력",d:"CJ대한통운·경동화물. 체크 후 엑셀 즉시 출력."},
            {icon:"💰",t:"계약금·잔금 관리",d:"계약금 등록 → 잔금 자동 계산 → 완납 처리. 미납 현황 한눈에."},
            {icon:"👥",t:"고객 DB 자동 구축",d:"주문 등록 시 자동 등록. 구매 이력·연락처·배송지."},
            {icon:"📊",t:"매출 대시보드",d:"월별 차트, 채널별 분석, 원단 TOP20, 담당자별 실적."},
          ].map(f=>(
            <div key={f.t} style={{background:V.card,border:"1px solid "+V.border,borderRadius:18,padding:"26px 22px",transition:"all .25s"}}>
              <div style={{fontSize:26,marginBottom:14}}>{f.icon}</div>
              <div style={{fontFamily:SF,fontSize:17,fontWeight:800,marginBottom:8}}>{f.t}</div>
              <div style={{fontSize:13,color:V.muted,lineHeight:1.75}}>{f.d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 요금제 */}
      <section style={{padding:"80px 20px",background:"rgba(124,58,237,.04)",borderTop:"1px solid "+V.border}}>
        <div style={{maxWidth:900,margin:"0 auto"}}>
          <div style={{textAlign:"center",fontSize:11,fontWeight:700,letterSpacing:".14em",textTransform:"uppercase",color:V.g2,marginBottom:14}}>요금제</div>
          <h2 style={{fontFamily:SF,fontSize:"clamp(24px,5vw,40px)",fontWeight:900,textAlign:"center",marginBottom:48}}>투명한 가격</h2>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:16}}>
            {[
              {n:"무료",p:"0",c:"원",cycle:"영구무료",feats:["주문 50건/월","AI 10회/일","재고 관리","담당자 1명"],hot:false},
              {n:"베이직",p:"29,000",c:"원",cycle:"/월",feats:["주문 무제한","AI 무제한","택배 송장","계약금·잔금","담당자 5명"],hot:true},
              {n:"프로",p:"59,000",c:"원",cycle:"/월",feats:["베이직 포함","담당자 무제한","바코드 스캐너","매출 대시보드","우선 지원"],hot:false},
            ].map(pc=>(
              <div key={pc.n} style={{background:pc.hot?"linear-gradient(135deg,rgba(124,58,237,.18),rgba(168,85,247,.08))":V.card,border:pc.hot?"1px solid #7C3AED":"1px solid "+V.border,borderRadius:20,padding:"30px 24px",position:"relative"}}>
                {pc.hot&&<div style={{position:"absolute",top:-13,left:"50%",transform:"translateX(-50%)",background:heroGrad,color:"#fff",fontSize:10,fontWeight:800,padding:"3px 14px",borderRadius:20,whiteSpace:"nowrap"}}>🔥 인기</div>}
                <div style={{fontSize:11,fontWeight:700,color:V.muted,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>{pc.n}</div>
                <div style={{fontFamily:SF,fontSize:38,fontWeight:900,lineHeight:1,...(pc.hot?{background:heroGrad,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}:{color:V.cream})}}>{pc.p}<span style={{fontSize:14,color:V.muted,...(pc.hot?{WebkitTextFillColor:V.muted}:{})}}>{pc.c}</span></div>
                <div style={{fontSize:12,color:V.muted,marginBottom:22}}>{pc.cycle}</div>
                <ul style={{listStyle:"none",display:"flex",flexDirection:"column",gap:8,marginBottom:24}}>
                  {pc.feats.map(f=><li key={f} style={{fontSize:13,color:V.muted,display:"flex",gap:7}}><span style={{color:"#A855F7",fontWeight:800}}>✓</span>{f}</li>)}
                </ul>
                <button onClick={onStart} style={{display:"block",width:"100%",padding:12,borderRadius:11,fontFamily:S,fontSize:14,fontWeight:800,cursor:"pointer",...(pc.hot?{background:heroGrad,color:"#fff",border:"none",boxShadow:"0 4px 20px rgba(124,58,237,.4)"}:{background:"transparent",color:V.cream,border:"1.5px solid "+V.border})}}>
                  {pc.hot?"14일 무료 체험":"시작하기"}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{padding:"80px 20px",textAlign:"center",background:heroGrad,position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse 70% 80% at 50% 50%,rgba(255,255,255,.08),transparent 70%)"}}/>
        <div style={{position:"relative"}}>
          <h2 style={{fontFamily:SF,fontSize:"clamp(26px,5vw,48px)",fontWeight:900,color:"#fff",lineHeight:1.25,marginBottom:16}}>지금 바로 시작하세요</h2>
          <p style={{fontSize:16,color:"rgba(255,255,255,.75)",marginBottom:40}}>카드 등록 없이 무료로 시작할 수 있습니다.</p>
          <button onClick={onStart} style={{padding:"16px 44px",borderRadius:14,border:"none",background:"#fff",color:"#7C3AED",fontWeight:900,fontSize:16,cursor:"pointer",fontFamily:S,boxShadow:"0 8px 32px rgba(0,0,0,.2)"}}>
            🚀 더브릿지 ERP 시작하기
          </button>
        </div>
      </section>

      {/* 푸터 */}
      <footer style={{padding:"32px 20px",borderTop:"1px solid "+V.border,display:"flex",flexWrap:"wrap",gap:12,justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontFamily:SF,fontSize:16,fontWeight:900,background:heroGrad,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>더브릿지</div>
        <div style={{fontSize:11,color:V.border}}>© 2025 LOWHIGH MARKET · 더브릿지 ERP</div>
      </footer>

      {/* 데모 모달 */}
      {demoOpen&&(
        <div onClick={e=>{if(e.target===e.currentTarget)setDemoOpen(false)}} style={{position:"fixed",inset:0,zIndex:500,background:"rgba(7,5,15,.93)",backdropFilter:"blur(18px)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:V.card,border:"1px solid "+V.border,borderRadius:24,overflow:"hidden",width:"100%",maxWidth:380,maxHeight:"88vh",display:"flex",flexDirection:"column",boxShadow:"0 40px 80px rgba(0,0,0,.7)"}}>
            <div style={{padding:"13px 16px",background:V.surface,borderBottom:"1px solid "+V.border,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontFamily:SF,fontSize:15,fontWeight:800,display:"flex",alignItems:"center",gap:7}}>
                더브릿지 <span style={{background:heroGrad,color:"#fff",fontSize:8,fontWeight:800,padding:"2px 7px",borderRadius:3,fontFamily:S}}>ERP v2.1</span>
              </div>
              <button onClick={()=>setDemoOpen(false)} style={{width:30,height:30,borderRadius:"50%",background:"rgba(255,255,255,.06)",border:"1px solid "+V.border,color:V.muted,fontSize:14,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{display:"flex",background:V.surface,borderBottom:"1px solid "+V.border}}>
              {["주문입력","주문현황","재고","계약/잔금"].map(t=>(
                <button key={t} onClick={()=>setDemoTab(t)} style={{flex:1,padding:"9px 4px",fontFamily:S,fontSize:10,fontWeight:demoTab===t?800:500,color:demoTab===t?V.v3:V.muted,background:"transparent",border:"none",borderBottom:demoTab===t?"2px solid "+V.v3:"2px solid transparent",cursor:"pointer",transition:"all .2s"}}>
                  {t}
                </button>
              ))}
            </div>
            <div style={{overflowY:"auto",flex:1,padding:14}}>
              {demoTab==="주문입력"&&(
                <div>
                  <div style={{fontSize:11,color:V.muted,marginBottom:8,fontWeight:700}}>카카오톡 주문 붙여넣기</div>
                  <textarea value={aiText} onChange={e=>setAiText(e.target.value)} placeholder={"홍길동\n린넨 베이지 3마\n면 화이트 5마\n\n입금완료"} style={{width:"100%",height:110,background:"rgba(255,255,255,.05)",border:"1px solid "+V.border,borderRadius:9,padding:11,color:V.cream,fontFamily:S,fontSize:13,resize:"none",outline:"none",lineHeight:1.8}}/>
                  <button onClick={analyze} disabled={parsing||!aiText.trim()} style={{width:"100%",padding:12,marginTop:9,borderRadius:9,border:"none",background:parsing||!aiText.trim()?"#2A2545":heroGrad,color:parsing||!aiText.trim()?V.muted:"#fff",fontWeight:800,fontSize:14,cursor:parsing||!aiText.trim()?"not-allowed":"pointer",fontFamily:S}}>
                    {parsing?"⏳ 분석 중...":"✦ AI 주문 분석"}
                  </button>
                  {aiResult&&(
                    <div style={{marginTop:12,padding:12,background:"rgba(124,58,237,.1)",border:"1px solid rgba(124,58,237,.3)",borderRadius:9}}>
                      <div style={{fontSize:10,color:V.v3,fontWeight:800,marginBottom:9}}>✓ 분석 완료</div>
                      <div style={{background:"rgba(255,255,255,.04)",borderRadius:8,overflow:"hidden",border:"1px solid "+V.border,marginBottom:9}}>
                        {[["고객명",aiResult.customer],["결제",aiResult.paid?"입금완료":"미입금"]].map(([k,v],i)=>(
                          <div key={k} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 11px",borderBottom:i<1?"1px solid "+V.border:"none",fontSize:12}}>
                            <span style={{color:V.muted}}>{k}</span>
                            {k==="결제"?<Tag c={aiResult.paid?"#6EE7B7":"#FCD34D"} bg={aiResult.paid?"rgba(16,185,129,.15)":"rgba(245,158,11,.15)"}>{v}</Tag>:<strong>{v}</strong>}
                          </div>
                        ))}
                      </div>
                      {aiResult.items.length>0&&<div>{aiResult.items.map((it,i)=><div key={i} style={{padding:"8px 11px",background:"rgba(255,255,255,.03)",borderRadius:7,border:"1px solid "+V.border,marginBottom:5,fontSize:12}}>{it}</div>)}</div>}
                      <button onClick={onStart} style={{width:"100%",marginTop:10,padding:11,borderRadius:9,border:"none",background:heroGrad,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S}}>
                        ◈ 실제 ERP로 등록하기 →
                      </button>
                    </div>
                  )}
                </div>
              )}
              {demoTab==="주문현황"&&(
                <div>
                  {[{id:"#2084",n:"박혜경",item:"린넨코튼 10마",s:"입금완료",s2:"출고완료"},{id:"#2085",n:"이수진",item:"쉬폰 20마",s:"미입금",s2:"준비중"},{id:"#2086",n:"정한별",item:"마8수 15마",s:"입금완료",s2:"접수"}].map(o=>(
                    <div key={o.id} style={{background:"rgba(255,255,255,.03)",border:"1px solid "+V.border,borderRadius:11,padding:12,marginBottom:8}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                        <div><span style={{fontSize:10,color:V.v3,fontWeight:700}}>{o.id} </span><strong style={{fontSize:14}}>{o.n}</strong></div>
                        <div style={{display:"flex",flexDirection:"column",gap:3,alignItems:"flex-end"}}>
                          <Tag c={o.s==="입금완료"?"#6EE7B7":"#FCD34D"} bg={o.s==="입금완료"?"rgba(16,185,129,.15)":"rgba(245,158,11,.15)"}>{o.s}</Tag>
                          <Tag c="#67E8F9" bg="rgba(6,182,212,.15)">{o.s2}</Tag>
                        </div>
                      </div>
                      <div style={{fontSize:11,color:V.muted,background:"rgba(255,255,255,.04)",padding:"4px 8px",borderRadius:6}}>{o.item}</div>
                    </div>
                  ))}
                  <button onClick={onStart} style={{width:"100%",padding:11,borderRadius:9,border:"none",background:heroGrad,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S}}>전체 기능 사용하기 →</button>
                </div>
              )}
              {demoTab==="재고"&&(
                <div>
                  {[{n:"린넨코튼",s:421,m:500,c:"#A855F7"},{n:"쉬폰",s:370,m:500,c:"#06B6D4"},{n:"마8수",s:89,m:200,c:"#FCD34D"},{n:"라미36수",s:8,m:100,c:"#F43F5E"}].map(st=>(
                    <div key={st.n} style={{marginBottom:12}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:5}}>
                        <span style={{fontWeight:700}}>{st.n}</span>
                        <span style={{fontWeight:800,color:st.c}}>{st.s}마{st.s<10?" ⚠":""}</span>
                      </div>
                      <div style={{height:6,background:"rgba(255,255,255,.06)",borderRadius:3,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${Math.min(100,st.s/st.m*100)}%`,background:st.c,borderRadius:3}}/>
                      </div>
                    </div>
                  ))}
                  <button onClick={onStart} style={{width:"100%",marginTop:8,padding:11,borderRadius:9,border:"none",background:heroGrad,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S}}>재고 직접 관리하기 →</button>
                </div>
              )}
              {demoTab==="계약/잔금"&&(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                    {[{n:"3건",l:"계약 중",c:"#A855F7"},{n:"120만",l:"미납 잔금",c:"#F43F5E"},{n:"2건",l:"완납",c:"#6EE7B7"}].map(k=>(
                      <div key={k.l} style={{background:"rgba(255,255,255,.04)",borderRadius:10,padding:"11px 8px",textAlign:"center",border:"1px solid "+V.border}}>
                        <div style={{fontSize:18,fontWeight:900,color:k.c,lineHeight:1}}>{k.n}</div>
                        <div style={{fontSize:10,color:V.muted,marginTop:4}}>{k.l}</div>
                      </div>
                    ))}
                  </div>
                  {[{c:"박혜경",total:500000,dep:100000,paid:false},{c:"정한별",total:300000,dep:300000,paid:true}].map(d=>(
                    <div key={d.c} style={{background:"rgba(255,255,255,.03)",border:"1px solid "+V.border,borderRadius:11,padding:12,marginBottom:8}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                        <strong>{d.c}</strong>
                        <Tag c={d.paid?"#6EE7B7":"#F43F5E"} bg={d.paid?"rgba(16,185,129,.15)":"rgba(244,63,94,.12)"}>{d.paid?"완납":"잔금미납"}</Tag>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5}}>
                        {[{l:"총금액",v:d.total.toLocaleString()+"원",c:"#C8794A"},{l:"계약금",v:d.dep.toLocaleString()+"원",c:"#67E8F9"},{l:"잔금",v:(d.total-d.dep).toLocaleString()+"원",c:d.paid?"#6EE7B7":"#F43F5E"}].map(s=>(
                          <div key={s.l} style={{textAlign:"center",background:"rgba(255,255,255,.04)",borderRadius:7,padding:"7px 4px",border:"1px solid "+V.border}}>
                            <div style={{fontSize:12,fontWeight:800,color:s.c}}>{s.v}</div>
                            <div style={{fontSize:9,color:V.muted,marginTop:2}}>{s.l}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <button onClick={onStart} style={{width:"100%",marginTop:4,padding:11,borderRadius:9,border:"none",background:heroGrad,color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S}}>계약금·잔금 관리 시작 →</button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════
//  루트 (랜딩 ↔ ERP 전환)
export default Landing;
