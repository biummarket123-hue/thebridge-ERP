// 홈(/) — 로그인과 체험, 두 갈래. 체험은 방문자마다 1시간짜리 임시 회사를 만들어 샘플 데이터로 써 보게 한다.
// 체험 회사는 1시간 뒤 읽기 전용이 되고(trial_end), 브라우저는 자동 로그아웃, 서버 크론이 통째로 지운다 — 남는 게 없다.
// 2026-10-20: 랜딩페이지 — 메시지는 "어디서 팔았든(카톡·밴드·쿠팡·자사몰·매장) 주문 하나로". 글 대신 "실제 화면처럼 생긴 목업"이 움직이며 설명한다. 목업은 앱과 같은 CSS 클래스(panel·badge·btn·chip·progressbar)로
// 그렸고, 스크롤로 보이는 순간(data-reveal → .in) CSS 애니메이션이 돈다. 히어로의 주문 등록 시연만 JS 로 단계를 돌린다(useCycle).
import { useEffect, useState } from "react";
import "./tokens.css";
import "./saas.css";
import * as db from "../lib/db.js";
import { supabase } from "../lib/supabase.js";
import { Button } from "./components/ui.jsx";
import { Modal } from "./components/Modal.jsx";
import { BrandMark, Icon } from "./icons.jsx";
import { BRAND } from "./config.js";
import { postAccount } from "./lib/accountApi.js";
import { SupportLinks, supportLine } from "./components/SupportLinks.jsx";
import { SUPPORT } from "./config.js";

export const DEMO_UNTIL_KEY = "erp_demo_until";

const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** [data-reveal] 요소가 화면에 들어오면 .in 을 붙인다(한 번만). 섹션 등장 + 목업 애니메이션 시작을 같이 맡는다. */
function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll("[data-reveal]"));
    if (!("IntersectionObserver" in window) || reduceMotion()) { els.forEach(e => e.classList.add("in")); return; }
    const io = new IntersectionObserver((ents) => {
      ents.forEach(en => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
    }, { threshold: 0.2, rootMargin: "0px 0px -6% 0px" });
    els.forEach(e => io.observe(e));
    return () => io.disconnect();
  }, []);
}

/** 단계별 길이(ms)를 돌며 0..n-1 을 반복한다. 모션 줄이기면 마지막 단계에 고정. */
function useCycle(durations) {
  const [i, setI] = useState(0);
  const still = reduceMotion();
  useEffect(() => {
    if (still) return;
    const t = setTimeout(() => setI(v => (v + 1) % durations.length), durations[i]);
    return () => clearTimeout(t);
  }, [i, still]);   // eslint-disable-line react-hooks/exhaustive-deps
  return still ? durations.length - 1 : i;
}

// ── 목업 틀 ──────────────────────────────────────────────
const NAV = [["home", "home", "홈"], ["orders", "orders", "주문"], ["ship", "truck", "출고"], ["stock", "stock", "재고"], ["users", "users", "거래처"], ["finance", "finance", "정산"]];

function AppFrame({ title, nav, children, className = "" }) {
  return (
    <div className={"lp-win " + className} aria-hidden="true">
      <div className="lp-winbar"><i /><i /><i /><span>{BRAND.name} {BRAND.suffix} · {title}</span></div>
      <div className="lp-winbody">
        <aside className="lp-side">
          {NAV.map(([k, icon, label]) => <div key={k} className={"lp-nav" + (k === nav ? " active" : "")}><Icon name={icon} />{label}</div>)}
        </aside>
        <div className="lp-winmain">{children}</div>
      </div>
    </div>
  );
}

function PhoneFrame({ children, className = "" }) {
  return (
    <div className={"lp-phone " + className} aria-hidden="true">
      <div className="lp-notch" />
      <div className="lp-phonetop"><div className="logo"><BrandMark /></div><b>{BRAND.name} <span>{BRAND.suffix}</span></b></div>
      <div className="lp-phonebody">{children}</div>
    </div>
  );
}

// 목업용 버튼 — 눌리지 않는다. 진짜 Button 은 리플·로딩이 있어 시연에 안 맞는다.
const FakeBtn = ({ kind = "primary", icon, children, className = "" }) => (
  <span className={`btn btn-${kind} btn-sm lp-fakebtn ${className}`}>{icon && <Icon name={icon} />}{children}</span>
);

// ── 히어로: 주문 등록 시연 — 두 장면이 번갈아 돈다. A) 카톡 대화 붙여넣기 → AI 분석  B) 쿠팡 주문서 사진 → 이미지로 분석.
// 어느 쪽이든 같은 폼이 채워지고 "주문 등록"으로 끝난다 — 판매 경로가 달라도 주문은 하나로 모인다는 걸 보여준다.
const HERO_LINES = ["홍길동 010-0000-0000", "면 30수 아이보리 12마, 린넨 네이비 1롤", "서울 가상구 예시로 12 2층", "내일 받을 수 있을까요?"];
const SOURCES = [["paste", "카톡·밴드 대화"], ["camera", "주문서 사진"], ["orders", "쿠팡·스마트스토어"], ["box", "자사 쇼핑몰"], ["pin", "매장 판매"]];

function HeroDemo() {
  // 장면 A(0~10): 0 빈칸 · 1~4 한 줄씩 · 5 분석 누름 · 6~9 폼 한 칸씩 · 10 등록 완료
  // 장면 B(11~21): 11 빈칸(탭 전환) · 12 사진 떨어짐 · 13~15 (짧게 지나감) · 16 분석 누름 · 17~20 폼 · 21 등록 완료
  const p = useCycle([800, 520, 520, 520, 520, 900, 420, 380, 380, 520, 2600, 900, 900, 10, 10, 10, 900, 420, 380, 380, 520, 2600]);
  const img = p >= 11;
  const q = img ? p - 11 : p;            // 장면 안의 단계
  // 컴포넌트가 아니라 함수 호출 — 단계가 바뀔 때 요소가 다시 만들어지면 transition 이 안 돈다
  const field = (label, at, children) => (
    <div className={"lp-field" + (q >= at ? " on" : "")}><span>{label}</span><div className="lp-val">{children}</div></div>
  );
  return (
    <AppFrame title="주문 등록" nav="orders" className="lp-hero-win">
      <div className="lp-neworder">
        <div className="lp-col">
          <div className="lp-seg"><span className={!img ? "active" : ""}><Icon name="paste" /> 대화 붙여넣기</span><span className={img ? "active" : ""}><Icon name="camera" /> 주문서 사진</span></div>
          {!img ? (
            <div className={"lp-textarea" + (q >= 1 && q <= 4 ? " typing" : "")}>
              {q === 0 && <span className="lp-placeholder">카톡·밴드 대화를 그대로 붙여 넣으세요</span>}
              {HERO_LINES.map((l, i) => <div key={l} className={"lp-line" + (q >= i + 1 ? " on" : "")}>{l}</div>)}
            </div>
          ) : (
            <div className={"lp-textarea lp-drop" + (q >= 1 ? " has" : "")}>
              {q === 0 && <span className="lp-placeholder"><Icon name="camera" /> 주문서를 찍거나 캡처를 끌어다 놓으세요</span>}
              <div className={"lp-sheet" + (q >= 1 ? " on" : "")}>
                <div className="lp-sheethead"><b>쿠팡</b> 주문서 · 2026-10-20</div>
                <div className="lp-sheetrow"><span>주문자</span><b>홍길동</b></div>
                <div className="lp-sheetrow"><span>상품</span><b>트윌 블랙 2롤</b></div>
                <div className="lp-sheetrow"><span>배송지</span><b>서울 가상구 예시로 12 2층</b></div>
                <div className="lp-sheetrow"><span>결제</span><b>124,000원 · 완료</b></div>
              </div>
            </div>
          )}
          <FakeBtn icon={img ? "camera" : "sparkle"} className={q === 5 ? "press" : q >= 6 ? "ok" : ""}>{q >= 6 ? "분석 완료" : img ? "이미지로 분석" : "AI 분석"}</FakeBtn>
        </div>
        <div className="lp-col">
          <div className="lp-label"><Icon name="check" /> 읽어서 채운 주문</div>
          {field("고객", 6, <><b>홍길동</b><span className="badge progress">기존 고객</span></>)}
          {field("품목", 7, img ? <span className="chip on">트윌 블랙 · 2롤</span> : <><span className="chip on">면 30수 아이보리 · 12마</span><span className="chip on">린넨 네이비 · 1롤</span></>)}
          {field("주소", 8, "서울 가상구 예시로 12 2층")}
          {field("판매처", 9, img ? <><b>쿠팡</b><span className="badge done">결제 완료</span></> : <><b>카톡</b><span className="badge wait">입금 대기</span></>)}
          <FakeBtn className={q >= 10 ? "press" : ""}>주문 등록</FakeBtn>
        </div>
        <div className={"lp-toast" + (q >= 10 ? " on" : "")}><Icon name="check" /> {img ? "주문 #1043 등록 · 쿠팡 · 포장 대기" : "주문 #1042 등록 · 카톡 · 입금 대기"}</div>
      </div>
    </AppFrame>
  );
}

// ── 전/후: 카톡 창 vs 주문 카드 ──
function Compare() {
  return (
    <div className="lp-compare lp-mock" data-reveal>
      <div className="lp-chat">
        <div className="lp-chathead"><span className="initial">홍</span><div><b>홍사장님</b><small>오늘 오전</small></div></div>
        <div className="lp-bubble">면 30수 아이보리 12마요</div>
        <div className="lp-bubble">아 린넨 네이비도 1롤 같이</div>
        <div className="lp-bubble">예시로 12요 내일 되나요</div>
        <div className="lp-bubble me">넵 입금 확인되면 보낼게요</div>
        <div className="lp-bubble">입금했어요~</div>
        <div className="lp-mark m1"><Icon name="alert" /> 몇 층인지 빠짐</div>
        <div className="lp-mark m2"><Icon name="alert" /> 통장엔 아직 없음</div>
        <div className="lp-mark m3"><Icon name="alert" /> 네이비 롤 잔량 모름</div>
      </div>
      <div className="lp-vs"><Icon name="chevron" /></div>
      <div className="panel lp-order">
        <div className="lp-orderhead"><div><b>#1042 홍길동</b><small>010-0000-0000 · 기존 고객</small></div><span className="badge wait">입금 대기</span></div>
        <div className="lp-kv"><span>품목</span><b>면 30수 아이보리 12마<br />린넨 네이비 1롤</b></div>
        <div className="lp-kv"><span>주소</span><b>서울 가상구 예시로 12 2층 <em className="lp-ask">층수 확인됨</em></b></div>
        <div className="lp-kv"><span>재고</span><b>네이비 롤 <em className="lp-ok">42마 재단 가능</em></b></div>
        <div className="lp-kv"><span>금액</span><b>187,000원 <em className="lp-warn">미입금</em></b></div>
        <div className="lp-lock"><Icon name="alert" /> 입금 확인 전에는 출고 버튼이 잠겨 있습니다</div>
      </div>
    </div>
  );
}

// ── 하루 흐름 4단계 목업 ──
function OrdersMock() {
  return (
    <div className="lp-mini lp-mock" data-reveal>
      <div className="lp-minihead"><strong>주문</strong><span className="badge wait">입금 대기 3</span></div>
      <div className="lp-row new"><b>#1042 홍길동</b><span>카톡 · 면 30수 아이보리 12마 외 1</span><span className="badge wait">입금 대기</span></div>
      <div className="lp-row"><b>#1041 이몽룡</b><span>쿠팡 · 트윌 블랙 2롤</span><span className="badge progress">포장 중</span></div>
      <div className="lp-row"><b>#1040 임꺽정</b><span>매장 · 데님 인디고 25마</span><span className="badge done">출고완료</span></div>
      <div className="lp-row"><b>#1039 성춘향</b><span>자사몰 · 린넨 베이지 1롤</span><span className="badge done">출고완료</span></div>
    </div>
  );
}

function SettleMock() {
  return (
    <div className="lp-mini lp-mock" data-reveal>
      <div className="lp-minihead"><strong>미입금</strong><span className="lp-count"><b className="a">3</b><b className="b">2</b>건</span></div>
      <div className="lp-row pay">
        <b>#1042 홍길동</b><span>187,000원</span>
        <span className="lp-swap"><span className="badge wait">입금 대기</span><span className="badge done">입금 완료</span></span>
        <FakeBtn kind="green" icon="check" className="lp-paybtn">입금 확인</FakeBtn>
      </div>
      <div className="lp-row"><b>#1038 전우치</b><span>64,000원</span><span className="badge wait">입금 대기</span></div>
      <div className="lp-row"><b>#1036 홍길순</b><span>312,000원</span><span className="badge late">3일 지남</span></div>
      <div className="lp-cursor"><Icon name="pin" /></div>
    </div>
  );
}

function ShipMock() {
  return (
    <div className="lp-board lp-mock" data-reveal>
      {[["포장 전", "wait"], ["송장 출력", "progress"], ["출고완료", "done"]].map(([t, tone]) => (
        <div className="lp-colm" key={t}><div className="lp-colhead"><span className={"badge " + tone}>{t}</span></div><div className="lp-slot" /><div className="lp-slot" /></div>
      ))}
      <div className="lp-card ghost g1"><b>#1041 이몽룡</b><small>트윌 블랙 2롤</small></div>
      <div className="lp-card ghost g2"><b>#1040 임꺽정</b><small>데님 인디고 25마</small></div>
      <div className="lp-card mover"><b>#1042 홍길동</b><small>면 30수 외 1 · CJ</small><span className="lp-tag t1">포장완료</span><span className="lp-tag t2">송장 출력</span><span className="lp-tag t3">출고완료</span></div>
      <div className="lp-boardfoot"><FakeBtn kind="white" icon="download">CJ 송장 3장 엑셀</FakeBtn></div>
    </div>
  );
}

function TrackMock() {
  return (
    <div className="lp-track lp-mock" data-reveal>
      <div className="lp-rail"><i /></div>
      {[["wallet", "입금"], ["box", "포장"], ["file", "송장"], ["truck", "출고"]].map(([ic, l], i) => (
        <div className={"lp-node n" + i} key={l}><div className="lp-nodeicon"><Icon name={ic} /></div><b>{l}</b></div>
      ))}
      <div className="lp-truck"><Icon name="truck" /></div>
      <div className="lp-trackfoot"><span className="badge done">오늘 출고 3건</span><span className="badge gray">택배 마감 16:00</span></div>
    </div>
  );
}

const STEPS = [
  ["주문이 들어오면", "어디서 왔든 붙여넣기나 사진 한 장이면 주문 목록 맨 위로. 판매처가 함께 기록되고, 입금 전이면 '입금 대기'입니다.", OrdersMock],
  ["입금을 확인하면", "미입금 목록에서 버튼 하나. 적립금·부분 입금도 같은 자리에서 처리합니다.", SettleMock],
  ["포장하고 송장 뽑고", "입금이 끝난 주문만 포장 칸에 옵니다. 포장완료 → 송장 엑셀 → 출고, 칸을 건너뛸 수 없습니다.", ShipMock],
  ["출고완료", "송장이 나간 박스만 출고완료가 찍힙니다. 택배 마감 시각은 회사 설정에서.", TrackMock],
];

// ── 재고·사진 ──
function StockMock() {
  const rolls = [["R-0231", 42, "A-3"], ["R-0228", 27, "A-3"], ["R-0219", 11, "B-1"]];
  return (
    <AppFrame title="재고" nav="stock" className="lp-mock lp-stock-win">
      <div data-reveal className="lp-mock lp-stockin">
        <div className="lp-minihead"><div><strong>린넨 네이비</strong><small> · LN-NV-02</small></div><span className="badge done">재단 가능 42마</span></div>
        {rolls.map(([code, m, loc], i) => (
          <div className="roll-row lp-roll" key={code} style={{ "--w": `${m * 2}%`, "--i": i }}>
            <span className="code">{code}</span>
            <div className="progressbar"><span /></div>
            <span className="len">{m}마</span><span className="loc">{loc}</span>
          </div>
        ))}
        <div className="lp-rollfoot"><FakeBtn kind="white" icon="file">QR 라벨 출력</FakeBtn><FakeBtn kind="white" icon="plus">입고 등록</FakeBtn></div>
      </div>
    </AppFrame>
  );
}

function PhotoMock() {
  return (
    <PhoneFrame className="lp-mock" >
      <div data-reveal className="lp-mock lp-photoin">
        <div className="lp-phonetitle">입고 등록</div>
        <div className="lp-photo"><div className="lp-fabric" /><div className="lp-flash" /><Icon name="camera" /></div>
        <div className="lp-field on"><span>품번</span><div className="lp-val"><b>LN-NV-02</b><small>린넨 네이비</small></div></div>
        <div className="lp-field on"><span>롤</span><div className="lp-val"><b>2롤 · 42마 / 27마</b></div></div>
        <FakeBtn icon="camera" className="lp-shutter">사진 찍기</FakeBtn>
      </div>
    </PhoneFrame>
  );
}

// ── 담당자 PIN · 정산 ──
function PinMock() {
  return (
    <div className="panel lp-pin lp-mock" data-reveal>
      <div className="lp-minihead"><strong>담당자</strong><small>회사 계정은 하나, 직원은 PIN</small></div>
      <div className="lp-who"><span className="initial">김</span><b>김철수</b></div>
      <div className="pindots">{[0, 1, 2, 3].map(i => <span key={i} className={"d" + i} />)}</div>
      <div className="lp-keys">{[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => <i key={n} className={"k" + n}>{n}</i>)}</div>
      <div className="lp-toast inline"><Icon name="check" /> 김철수 님 작업 시작 · 기록에 이름이 남습니다</div>
    </div>
  );
}

function ChartMock() {
  const bars = [["5월", 52], ["6월", 61], ["7월", 48], ["8월", 73], ["9월", 80], ["10월", 94]];
  return (
    <div className="panel lp-chart lp-mock" data-reveal>
      <div className="lp-minihead"><strong>월별 매출</strong><small>입금 기준</small></div>
      <div className="chartsum"><strong className="lp-amount">12,480,000원</strong><small>+17%</small></div>
      <div className="lp-bars">{bars.map(([l, h], i) => <div className="lp-baritem" key={l} style={{ "--h": `${h}%`, "--i": i }}><span className={"lp-bar" + (i === 5 ? " sel" : "")} /><em>{l}</em></div>)}</div>
      <div className="lp-rollfoot"><span className="badge gray">거래명세서 출력</span><span className="badge gray">적립금</span><span className="badge gray">환불</span></div>
    </div>
  );
}

const TRIAL_STEPS = [
  ["sparkle", "버튼 하나", "가입·카드·이메일 없음. 누르면 임시 회사가 바로 열립니다."],
  ["orders", "샘플로 눌러 보기", "주문 6건·고객 4명·품번 3개·롤 4개·입금 4건. 등록부터 출고까지 직접(AI 분석은 구독 전용)."],
  ["clock", "1시간 뒤 자동 삭제", "체험 회사는 통째로 지워집니다. 어디에도 남지 않습니다."],
];

// 첫 구독 서비스 — 쓰던 엑셀을 운영팀이 대신 넣어 준다(사용자 결정 2026-10-23, 절차는 docs/saas-data-import.md).
const MIGRATE_STEPS = [
  ["file", "쓰던 엑셀 보내기", "거래처·품번·지난 주문, 세 가지 중 있는 것만. 양식이 달라도 됩니다. 가입 뒤 회사 설정 › 데이터 이관에서 메일로 보냅니다."],
  ["users", "운영팀이 대신 넣기", "중복은 걸러내고 전화번호·날짜·금액을 정리해서 넣습니다. 보통 영업일 1~2일이면 끝나고, 못 읽은 줄은 따로 알려 드립니다."],
  ["check", "첫날부터 이어서", "거래처·품번·주문 이력이 들어 있는 상태로 시작합니다. 보내신 파일은 이관이 끝나면 지웁니다."],
];

function MigrateMock() {
  return (
    <div className="lp-compare lp-migrate-mock lp-mock" data-reveal>
      <div className="lp-xls">
        <div className="lp-xlshead"><span>주문장_2025.xlsx</span><span>시트1</span></div>
        <div className="lp-xlsrow h"><span>날짜</span><span>고객명</span><span>품목</span><span>금액</span></div>
        <div className="lp-xlsrow"><span>3/4</span><span>홍길동</span><span>면30수 아이보리 12마</span><span>187000</span></div>
        <div className="lp-xlsrow"><span>3/4</span><span>이몽룡</span><span>트윌 블랙 2롤</span><span>124,000원</span></div>
        <div className="lp-xlsrow"><span>3/5</span><span>홍길동</span><span>린넨 네이비 1롤</span><span className="bad">?</span></div>
        <div className="lp-xlsrow"><span>3/6</span><span>성춘향</span><span>린넨 베이지</span><span>58000</span></div>
      </div>
      <div className="lp-vs"><Icon name="chevron" /></div>
      <div className="lp-mini">
        <div className="lp-minihead"><strong>지난 주문</strong><span className="lp-chips"><span className="badge done">거래처 128</span><span className="badge progress">품번 54</span><span className="badge gray">주문 1,920</span></span></div>
        <div className="lp-row"><b>#0231 홍길동</b><span>3월 4일 · 면 30수 아이보리 12마</span><span className="badge done">187,000원</span></div>
        <div className="lp-row"><b>#0232 이몽룡</b><span>3월 4일 · 트윌 블랙 2롤</span><span className="badge done">124,000원</span></div>
        <div className="lp-row"><b>#0233 홍길동</b><span>3월 5일 · 린넨 네이비 1롤</span><span className="badge wait">금액 확인</span></div>
        <div className="lp-row"><b>#0234 성춘향</b><span>3월 6일 · 린넨 베이지</span><span className="badge done">58,000원</span></div>
      </div>
    </div>
  );
}

const FAQ = [
  ["쓰던 엑셀 자료는 어떻게 하나요?", "처음 구독을 시작하면 운영팀이 거래처·품번·지난 주문 엑셀을 대신 넣어 드립니다(무료, 1회). 가입 뒤 회사 설정 › 데이터 이관에서 파일을 보내면 보통 영업일 1~2일 안에 끝납니다. 쿠팡·스마트스토어의 '오늘 주문' 엑셀은 매일 화면에서 직접 가져옵니다."],
  ["가입이나 결제가 필요한가요?", "체험은 아무것도 필요 없습니다. 실제로 쓰기로 하면 회사 계정을 만들고 14일 무료 체험 뒤 구독으로 이어집니다."],
  ["체험에서도 AI 분석이 되나요?", "AI 로 글·사진을 읽는 기능은 구독 회사 전용입니다. 1시간 체험과 14일 무료 체험에서는 직접 입력으로 주문을 등록하면서 입금·포장·출고·재고 흐름을 그대로 써 볼 수 있습니다."],
  ["쿠팡·스마트스토어·자사몰 주문도 되나요?", "주문서 화면을 캡처하거나 사진을 찍어 넣으면 대화 붙여넣기와 같은 방식으로 읽습니다. 판매처가 주문에 함께 기록됩니다. 매장에서 받은 손 주문서도 사진으로 됩니다."],
  ["휴대폰에서도 되나요?", "네. 매장에서는 PC, 창고와 외부에서는 휴대폰으로 같은 화면을 씁니다. 입고 사진은 휴대폰 카메라로 바로 찍습니다."],
  ["직원마다 계정을 만들어야 하나요?", "아니요. 회사 계정 하나로 로그인하고, 직원은 이름과 4자리 PIN 만 누르면 됩니다. 작업 기록에는 담당자 이름이 남습니다."],
  ["우리 가게 방식이랑 다르면요?", `쓰는 택배사(CJ·경동 말고도 더하고 뺄 수 있고 송장 양식도 고릅니다), 택배 마감 시각, 택배비 기본값, 재고 부족 기준, 품번 접두어는 회사 설정에서 바꿉니다. 그래도 안 맞는 부분은 알려 주세요${supportLine() ? ` — ${supportLine()}` : ""}.`],
  ["체험 중 입력한 데이터는 어떻게 되나요?", "1시간이 지나면 체험 회사가 통째로 삭제됩니다. 서버에도, 브라우저에도 남지 않습니다."],
];

export default function Landing() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const expired = typeof location !== "undefined" && /[?&]expired=1/.test(location.search);

  useEffect(() => {
    document.body.setAttribute("data-saas", "1");
    document.title = `${BRAND.name} ${BRAND.suffix}`;
    return () => document.body.removeAttribute("data-saas");
  }, []);
  useReveal();

  // 체험은 먼저 회사명을 묻는다(2026-10-23) — 체험 중 화면 왼쪽 위·송장에 그 이름이 들어가 내 회사처럼 써 보게.
  const [askName, setAskName] = useState(false);
  const [demoName, setDemoName] = useState("");
  const openDemo = () => { setErr(""); setAskName(true); };

  const startDemo = async (e) => {
    e?.preventDefault?.();
    const companyName = demoName.trim();
    if (!companyName) return setErr("체험할 회사 이름을 입력해 주세요");
    setErr(""); setBusy(true);
    try {
      // 이전 세션·토큰이 남아 있으면 지운다 — 체험 회사와 섞이지 않게
      try { await db.revokeManagerToken(); } catch { /* 무시 */ }
      try { await supabase.auth.signOut({ scope: "local" }); } catch { /* 무시 */ }
      const r = await postAccount("demo", { companyName });
      const { error } = await supabase.auth.setSession({ access_token: r.session.access_token, refresh_token: r.session.refresh_token });
      if (error) throw error;
      // 담당자 선택·PIN 확인을 대신 해 둔다(체험자는 PIN 을 모른다). 기기 고정이라 30분 뒤 다시 묻지 않는다.
      localStorage.setItem("erp_manager", r.manager.name);
      localStorage.setItem("erp_manager_pinned", "1");
      localStorage.setItem("erp_manager_pin_at", String(Date.now()));
      localStorage.setItem(DEMO_UNTIL_KEY, String(new Date(r.expiresAt).getTime()));
      try { const v = await db.verifyManagerPin(r.manager.id, r.manager.pin); if (v?.ok && v.token) db.setManagerToken(v.token); } catch { /* 토큰 없이도 둘러보기는 된다 */ }
      window.location.href = "/app";
    } catch (e) { setErr(e.message || "체험 환경을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."); setBusy(false); }
  };

  const CtaRow = ({ compact }) => (
    <div className="landing-cta">
      <Button icon="sparkle" loading={busy} onClick={openDemo}>1시간 체험해 보기</Button>
      <a className="btn btn-white" href="/app" style={{ textDecoration: "none" }}><Icon name="user" /> 회사 계정 로그인</a>
      {!compact && <p className="landing-note">가입 없음 · 카드 없음 · 1시간 뒤 자동 삭제</p>}
    </div>
  );

  return (
    <div className="saas">
      {askName && (
        <Modal title="체험할 회사 이름" onClose={() => { if (!busy) setAskName(false); }}>
          <form onSubmit={startDemo}>
            <p className="helptext" style={{ marginTop: 8 }}>체험하는 동안 화면 왼쪽 위와 송장·명세서에 이 이름이 들어갑니다. 1시간 뒤 회사와 함께 지워집니다.</p>
            <label className="formlabel" htmlFor="demo-name">회사명</label>
            <input id="demo-name" className="forminput" value={demoName} onChange={e => setDemoName(e.target.value)} placeholder="예: 동대문 원단" maxLength={30} autoFocus autoComplete="organization" />
            {err && <p className="helptext err" style={{ marginBottom: 0 }}>{err}</p>}
            <div style={{ marginTop: 22 }}><Button type="submit" icon="sparkle" loading={busy}>체험 시작</Button></div>
            <p className="helptext" style={{ margin: "14px 0 0", textAlign: "center" }}>가입 없음 · 카드 없음 · 1시간 뒤 자동 삭제</p>
          </form>
        </Modal>
      )}
      <div className="landing lp">
        <div className="lp-blob a" aria-hidden="true" /><div className="lp-blob b" aria-hidden="true" />

        <header className="landing-top lp-up" style={{ "--d": "0ms" }}>
          <div className="brand" style={{ margin: 0 }}>
            <div className="logo"><BrandMark /></div>
            <div><div className="brand-name">{BRAND.name} <span>{BRAND.suffix}</span></div><div className="brand-caption">{BRAND.caption}</div></div>
          </div>
          <nav className="landing-nav">
            <a href="#how">업무 흐름</a>
            <a href="#stock">재고 · 사진</a>
            <a href="#migrate">데이터 이관</a>
            <a href="#trial">체험 안내</a>
            <a href="#faq">자주 묻는 질문</a>
            {SUPPORT.any && <a href="#contact">문의</a>}
            <a className="btn btn-white btn-sm" href="/app" style={{ textDecoration: "none" }}>로그인</a>
          </nav>
        </header>

        {/* ── 히어로 ─────────────────────────────────────── */}
        <section className="landing-hero">
          <p className="eyebrow lp-up" style={{ "--d": "80ms" }}>원단 도매 전용 ERP</p>
          <h1 className="lp-up" style={{ "--d": "160ms" }}>어디서 팔았든,<br />주문 하나로 모여 출고까지 흘러갑니다.</h1>
          <p className="lead lp-up" style={{ "--d": "240ms" }}>카톡·밴드 대화, 쿠팡·스마트스토어 주문서, 자사 쇼핑몰, 매장에서 받은 주문서 사진까지. 글이든 사진이든 그대로 넣으면 AI 가 고객·품목·금액·주소를 읽어 주문으로 등록하고, 입금·포장·출고로 이어집니다.</p>
          {expired && <p className="helptext warn" style={{ maxWidth: 520, margin: "0 auto 18px" }}>체험 1시간이 끝났습니다. 체험 중 입력한 내용은 저장되지 않습니다. 다시 체험하거나 회사 계정으로 로그인해 주세요.</p>}
          {err && <p className="helptext err" style={{ maxWidth: 520, margin: "0 auto 18px" }}>{err}</p>}
          <div className="lp-up" style={{ "--d": "320ms" }}><CtaRow /></div>
          <div className="lp-up lp-sources" style={{ "--d": "400ms" }}>
            {SOURCES.map(([icon, label], i) => <span className="chip" key={label} style={{ "--i": i }}><Icon name={icon} />{label}</span>)}
            <span className="lp-sources-arrow"><Icon name="chevron" /> 같은 주문 등록 화면으로</span>
          </div>
          <div className="lp-up lp-herodemo" style={{ "--d": "460ms" }}><HeroDemo /></div>
        </section>

        {/* ── 전/후 ───────────────────────────────────────── */}
        <section className="landing-section">
          <p className="eyebrow" data-reveal>판매 경로는 여러 개, 주문은 하나</p>
          <h2 data-reveal style={{ "--d": "80ms" }}>카톡이든 쿠팡이든 매장이든, 손으로 옮겨 적던 주문이 카드 한 장으로 모입니다.</h2>
          <Compare />
        </section>

        {/* ── 하루 흐름 ───────────────────────────────────── */}
        <section className="landing-section" id="how">
          <p className="eyebrow" data-reveal>하루가 이렇게 흘러갑니다</p>
          <h2 data-reveal style={{ "--d": "80ms" }}>네 단계를 건너뛸 수 없어서, 실수도 건너뜁니다.</h2>
          <div className="lp-steps">
            {STEPS.map(([title, desc, Mock], i) => (
              <div className={"lp-step" + (i % 2 ? " flip" : "")} key={title}>
                <div className="lp-steptext" data-reveal>
                  <div className="step-no">{i + 1}</div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
                <div className="lp-stepmock"><Mock /></div>
              </div>
            ))}
          </div>
        </section>

        {/* ── 재고 · 사진 ─────────────────────────────────── */}
        <section className="landing-section" id="stock">
          <p className="eyebrow" data-reveal>재고는 롤 단위로</p>
          <h2 data-reveal style={{ "--d": "80ms" }}>"몇 마 남았어요?" 에 창고 안 가고 바로 답합니다.</h2>
          <div className="lp-duo">
            <div className="lp-duo-main"><StockMock /><p className="lp-cap" data-reveal>품번 아래 롤마다 잔량·위치. 가장 긴 롤이 재단 가능 기준이라 "되는지"가 바로 보입니다. QR 라벨로 찍어 붙입니다.</p></div>
            <div className="lp-duo-side"><PhotoMock /><p className="lp-cap" data-reveal>입고할 때 휴대폰으로 바로 찍어 품번에 붙입니다. 이름만으로 헷갈리던 원단이 사진으로 구분됩니다.</p></div>
          </div>
        </section>

        {/* ── PIN · 정산 ──────────────────────────────────── */}
        <section className="landing-section">
          <p className="eyebrow" data-reveal>직원과 돈</p>
          <h2 data-reveal style={{ "--d": "80ms" }}>누가 했는지 남고, 얼마 들어왔는지 보입니다.</h2>
          <div className="lp-pair">
            <div><PinMock /><p className="lp-cap" data-reveal>회사 계정 하나로 로그인, 직원은 이름과 4자리 PIN. 주문·입금·출고 기록마다 담당자 이름이 붙습니다.</p></div>
            <div><ChartMock /><p className="lp-cap" data-reveal>미입금 목록, 입금 처리, 적립금, 환불, 거래명세서 출력, 월별 매출이 정산 한 화면에 있습니다.</p></div>
          </div>
        </section>

        {/* ── 첫 구독 서비스: 엑셀 이관 ───────────────────── */}
        <section className="landing-section landing-trial landing-migrate" id="migrate">
          <div className="panel trial-panel" data-reveal>
            <div className="trial-head">
              <p className="eyebrow"><span className="badge done">첫 구독 혜택 · 무료</span></p>
              <h2>쓰던 엑셀, 그대로 옮겨 드립니다.</h2>
              <p className="lead">처음 구독을 시작하는 회사는 지금까지 엑셀·장부로 적어 온 거래처·품번·주문 이력을 운영팀이 대신 ERP 에 넣어 드립니다. 빈 화면에서 다시 시작하지 않습니다.</p>
            </div>
            <MigrateMock />
            <div className="trial-steps" style={{ marginTop: 26 }}>
              {MIGRATE_STEPS.map(([icon, title, desc], i) => (
                <div className="trial-step" key={title} data-reveal style={{ "--d": `${i * 120}ms` }}>
                  <div className="feat-icon"><Icon name={icon} /></div>
                  <div><h3>{title}</h3><p>{desc}</p></div>
                </div>
              ))}
            </div>
            <p className="landing-note" style={{ margin: 0 }}>유료 구독을 시작한 회사에 1회 무료 · 엑셀(xlsx)·CSV · 보내신 파일은 이관 뒤 삭제</p>
          </div>
        </section>

        {/* ── 체험 안내 ───────────────────────────────────── */}
        <section className="landing-section landing-trial" id="trial">
          <div className="panel trial-panel" data-reveal>
            <div className="trial-head">
              <p className="eyebrow">1시간 체험</p>
              <h2>설명을 읽는 것보다 직접 눌러 보는 게 빠릅니다.</h2>
              <p className="lead">가입 없이 바로 시작됩니다. 샘플 주문·재고가 들어 있는 임시 회사가 만들어지고, 1시간 뒤 자동으로 끝나며 입력한 내용은 남지 않습니다.</p>
            </div>
            <div className="trial-steps">
              {TRIAL_STEPS.map(([icon, title, desc], i) => (
                <div className="trial-step" key={title} data-reveal style={{ "--d": `${i * 120}ms` }}>
                  <div className="feat-icon"><Icon name={icon} /></div>
                  <div><h3>{title}</h3><p>{desc}</p></div>
                </div>
              ))}
            </div>
            <CtaRow compact />
          </div>
        </section>

        {/* ── FAQ ────────────────────────────────────────── */}
        <section className="landing-section" id="faq">
          <p className="eyebrow" data-reveal>자주 묻는 질문</p>
          <h2 data-reveal style={{ "--d": "80ms" }}>시작하기 전에 궁금한 것들</h2>
          <div className="landing-faq">
            {FAQ.map(([q, a], i) => (
              <details className="panel faq" key={q} data-reveal style={{ "--d": `${i * 60}ms` }}>
                <summary><span>{q}</span><Icon name="chevron" /></summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ── 마무리 CTA ──────────────────────────────────── */}
        <section className="landing-final" data-reveal>
          <h2>오늘 받은 주문 하나, 글이든 사진이든 넣어 보세요.</h2>
          <p className="lead">1시간이면 우리 가게에 맞는지 충분히 알 수 있습니다.</p>
          <CtaRow />
        </section>

        {SUPPORT.any && (
          <section className="landing-section landing-contact" id="contact" data-reveal>
            <p className="eyebrow">문의</p>
            <h2>궁금한 건 바로 물어보세요.</h2>
            <p className="lead" style={{ maxWidth: 560, margin: "0 auto 18px" }}>가입·요금·데이터 이관·기능 요청 모두 아래로 연락 주시면 됩니다.</p>
            <SupportLinks title="" />
          </section>
        )}

        <footer className="landing-foot">
          <span>{BRAND.name} {BRAND.suffix} · 구독형 원단 ERP</span>
          <span style={{ display: "inline-flex", gap: 14, flexWrap: "wrap" }}>
            <a href="/app">새 회사 가입 · 14일 무료</a>
            {SUPPORT.any && <a href="#contact">문의</a>}
          </span>
        </footer>
      </div>
    </div>
  );
}
