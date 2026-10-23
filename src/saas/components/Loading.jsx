// 새 UI 공용 로딩 화면 — 첫 청크 폴백(main.jsx)·AppEntry·회사 세션 확인(SaasAuth)·앱 데이터 로딩(SaasApp)이 전부 이것을 쓴다.
// 옛 ERP 의 CuteFullLoader(어두운 배경·🧶)는 SaaS 상품에서 더 이상 쓰지 않는다(2026-10-23).
// main.jsx 가 바로 import 하므로 여기서 db·supabase 를 끌어오면 안 된다 — 로고·브랜드 이름·CSS 만.
import "../tokens.css";
import "../loading.css";
import { BrandMark } from "../icons.jsx";
import { BRAND } from "../config.js";

/** 전체 화면 로딩. text 는 아래 작은 안내 문구("불러오는 중…" 등). */
export function SaasLoader({ text = "불러오는 중…", caption = BRAND.caption }) {
  return (
    <div className="saas-loading" role="status" aria-live="polite" aria-label={text}>
      <div className="logo"><BrandMark /></div>
      <div className="name">{BRAND.name} <span>{BRAND.suffix}</span></div>
      {caption ? <div className="caption">{caption}</div> : null}
      <div className="bar"><i /></div>
      {text ? <div className="text">{text}</div> : null}
    </div>
  );
}
