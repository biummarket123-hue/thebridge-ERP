// 회사 브랜드 — 사이드바·모바일 상단·담당자 선택·PIN·온보딩이 같이 쓴다(2026-10-23).
// 로그인한 회사의 로고(회사 설정에서 올린 그림, 없으면 서비스 마크)와 회사명을 크게, 아래 작은 줄에 서비스 이름(THE BRIDGE ERP)을 적는다.
// 로그인 전 화면(홈·로그인·로딩)은 회사를 모르므로 서비스 이름을 그대로 쓴다.
import { BRAND } from "../config.js";
import { BrandMark } from "../icons.jsx";
import { useSaas } from "../data/SaasData.jsx";

export const SERVICE_NAME = `${BRAND.name} ${BRAND.suffix}`;

/** 로고 칸 — logo(데이터 URL)가 있으면 그 그림, 없으면 서비스 마크. */
export function CompanyLogo({ logo, className = "logo" }) {
  return logo
    ? <div className={`${className} custom`}><img src={logo} alt="" /></div>
    : <div className={className}><BrandMark /></div>;
}

/** compact: 모바일 상단처럼 회사명만. caption: 아래 작은 줄(기본은 서비스 이름). */
export function CompanyBrand({ caption, compact, style }) {
  const { config } = useSaas();
  return (
    <div className="brand company" style={style}>
      <CompanyLogo logo={config.logo} />
      <div style={{ minWidth: 0 }}>
        <div className="brand-name company">{config.companyName}</div>
        {!compact && <div className="brand-caption">{caption || SERVICE_NAME}</div>}
      </div>
    </div>
  );
}
