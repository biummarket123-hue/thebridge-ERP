// 가벼운 경로 분기 — history.pushState 기반. 외부 라우터는 넣지 않는다(지시서 2절).
//
// 경로:  /app            홈
//        /app/orders     주문 관리     /app/orders/new  주문 등록    /app/orders/:id  주문 상세(모달)
//        /app/stock      재고 관리     /app/stock/:productId  원단 상세(모달)
//        /app/customers  거래처        /app/customers/:id     거래처 상세(모달)
//        /app/settlement 정산
//        /app/settings   회사 설정(구독·담당자 PIN·운영 값) — 메뉴에는 없고 프로필에서 들어간다
// 모달은 경로에 담는다 — 뒤로가기로 닫히고, 주소를 복사해 다른 사람에게 줄 수 있다.
import { useEffect, useState, useCallback } from "react";

export const BASE = "/app";

export const MENUS = [
  { key: "home", path: "/app", label: "홈", short: "홈", icon: "home", crumb: "홈", eyebrow: "HOME" },
  { key: "orders", path: "/app/orders", label: "주문 관리", short: "주문", icon: "orders", crumb: "주문 관리", eyebrow: "ORDERS" },
  { key: "stock", path: "/app/stock", label: "재고 관리", short: "재고", icon: "stock", crumb: "재고 관리", eyebrow: "INVENTORY" },
  { key: "customers", path: "/app/customers", label: "거래처", short: "거래처", icon: "users", crumb: "거래처", eyebrow: "CUSTOMERS" },
  { key: "settlement", path: "/app/settlement", label: "정산", short: "정산", icon: "finance", crumb: "정산", eyebrow: "SETTLEMENT" },
];

/** 경로 문자열 → { menu, sub, params } */
// 메뉴 밖 경로 — 하단 탭·사이드바 메뉴에는 안 나오고 프로필 메뉴에서 들어간다.
export const EXTRA_ROUTES = [
  { key: "settings", path: "/app/settings", label: "회사 설정", short: "설정", icon: "settings", crumb: "회사 설정", eyebrow: "SETTINGS" },
];
export const ALL_ROUTES = [...MENUS, ...EXTRA_ROUTES];

export function parsePath(pathname) {
  const p = String(pathname || "").replace(/\/+$/, "") || "/";
  const rest = p === BASE ? "" : p.startsWith(BASE + "/") ? p.slice(BASE.length + 1) : null;
  if (rest === null) return { menu: "home", sub: "", id: "" };
  const [seg, id = ""] = rest.split("/");
  const menu = ALL_ROUTES.find(m => m.key === seg)?.key || "home";
  return { menu, sub: seg, id: decodeURIComponent(id) };
}

const listeners = new Set();
function emit() { for (const l of listeners) l(); }

export function navigate(to, { replace = false } = {}) {
  if (typeof window === "undefined") return;
  if (window.location.pathname === to) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  emit();
}

export function useRoute() {
  const [path, setPath] = useState(() => (typeof window !== "undefined" ? window.location.pathname : BASE));
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    listeners.add(sync);
    window.addEventListener("popstate", sync);
    return () => { listeners.delete(sync); window.removeEventListener("popstate", sync); };
  }, []);
  const go = useCallback((to, opts) => navigate(to, opts), []);
  return { path, ...parsePath(path), go };
}

export const menuPath = (key) => ALL_ROUTES.find(m => m.key === key)?.path || BASE;
