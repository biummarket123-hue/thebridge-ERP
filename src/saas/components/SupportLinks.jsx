// 고객 문의 창구 — 전화·카카오톡 채널·이메일. 값은 환경변수(VITE_SUPPORT_PHONE / VITE_SUPPORT_KAKAO / VITE_SUPPORT_EMAIL / VITE_SUPPORT_HOURS).
// 랜딩·로그인·가입·설정(구독·데이터 이관)·사이드바 "도움말·문의" 가 같은 조각을 쓴다(사용자 지적 2026-10-23: "운영자에게 연락하라"는데 연락처가 없었다).
// 하나도 설정돼 있지 않으면 아무것도 그리지 않는다(note 를 주면 그 글만).
import { useState } from "react";
import { SUPPORT } from "../config.js";
import { Icon } from "../icons.jsx";
import { Modal } from "./Modal.jsx";

/** 글로 쓸 때 — "전화 010-… · 카카오톡 채널 · help@…" (없으면 "") */
export function supportLine() {
  const parts = [];
  if (SUPPORT.phone) parts.push(`전화 ${SUPPORT.phone}`);
  if (SUPPORT.kakao) parts.push("카카오톡 채널");
  if (SUPPORT.email) parts.push(SUPPORT.email);
  return parts.join(" · ");
}

export function SupportLinks({ title = "문의", compact = false, note = "" }) {
  if (!SUPPORT.any) return note ? <p className="helptext" style={{ margin: "8px 0 0" }}>{note}</p> : null;
  return (
    <div className={`support-links${compact ? " compact" : ""}`}>
      {title ? <div className="section-label">{title}</div> : null}
      <div className="btnrow">
        {SUPPORT.phone && <a className="btn btn-white btn-sm" href={`tel:${SUPPORT.phone.replace(/\D/g, "")}`}><Icon name="phone" />{SUPPORT.phone}</a>}
        {SUPPORT.kakao && <a className="btn btn-white btn-sm" href={SUPPORT.kakao} target="_blank" rel="noreferrer"><Icon name="user" />카카오톡 문의</a>}
        {SUPPORT.email && <a className="btn btn-white btn-sm" href={`mailto:${SUPPORT.email}`}><Icon name="file" />{SUPPORT.email}</a>}
      </div>
      {SUPPORT.hours ? <p className="helptext" style={{ margin: "6px 0 0" }}>{SUPPORT.hours}</p> : null}
    </div>
  );
}

/** 사이드바·담당자 창의 "도움말·문의" 창 */
export function HelpModal({ onClose }) {
  return (
    <Modal title="도움말 · 문의" onClose={onClose}>
      <ul className="help-tips">
        <li><b>주문 등록</b> — 카톡·문자 글이나 주문서 사진을 넣으면 AI 가 읽어 채웁니다(구독 회사). 직접 입력도 됩니다.</li>
        <li><b>출고</b> — 포장완료 → 송장(택배사 고르기) → 출고완료 순서입니다. 입금이 끝난 주문만 나갑니다.</li>
        <li><b>직원</b> — 회사 계정 하나로 로그인하고, 담당자 이름과 4자리 PIN 으로 작업합니다. 회사 설정 › 담당자에서 추가합니다.</li>
        <li><b>비밀번호·PIN</b> — 비밀번호는 로그인 화면의 "비밀번호를 잊었어요"에서 휴대폰 인증으로, PIN 은 담당자 선택 화면의 "PIN 을 잊었어요"에서 회사 비밀번호로 다시 정합니다.</li>
        <li><b>쓰던 엑셀</b> — 회사 설정 › 데이터 이관에서 보내 주시면 운영팀이 대신 넣어 드립니다.</li>
      </ul>
      <SupportLinks note="문의 연락처가 아직 설정되지 않았습니다. 운영자가 환경변수(VITE_SUPPORT_PHONE 등)에 넣으면 여기 보입니다." />
      <div className="btnrow" style={{ marginTop: 18 }}><button className="btn btn-white" onClick={onClose}>닫기</button></div>
    </Modal>
  );
}

/** "도움말·문의" 단추 + 창 — 사이드바 아래와 담당자 창에서 쓴다 */
export function HelpButton({ className = "nav", children = "도움말 · 문의" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}><Icon name="bell" /><span>{children}</span></button>
      {open && <HelpModal onClose={() => setOpen(false)} />}
    </>
  );
}
