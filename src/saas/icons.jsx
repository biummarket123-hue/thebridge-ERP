// 시안의 아이콘(24px stroke 1.85) 을 그대로 옮긴 것. 새 아이콘은 같은 규격으로만 추가한다.
const PATHS = {
  home: <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" />,
  orders: <><rect x="4" y="4" width="16" height="17" rx="2" /><path d="M8 4V2m8 2V2M8 10h8M8 14h8" /></>,
  stock: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18m-9 0v12M7 5V3m10 2V3" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m2 9v-2a6 6 0 0 0-2-4.47" /></>,
  finance: <><rect x="3" y="5" width="18" height="15" rx="2" /><path d="M3 10h18m-14 5h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  truck: <><path d="M3 5h11v12H3zM14 9h4l3 3v5h-7z" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  alert: <><path d="M12 3 2.5 20h19L12 3z" /><path d="M12 9v4m0 3h.01" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  back: <path d="m15 18-6-6 6-6" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16.2 16.2 4.3 4.3" /></>,
  box: <path d="m3 8 9-5 9 5v10l-9 5-9-5V8zM3 8l9 5 9-5M12 13v10" />,
  check: <path d="m5 12 4 4L19 6" />,
  layers: <path d="m12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5" />,
  trend: <path d="M3 17 9 11l4 4 8-8M15 7h6v6" />,
  close: <path d="M5 5l14 14M19 5 5 19" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6l4 2" /></>,
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 18v3h16v-3" />,
  sparkle: <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6.3 6.3l2.8 2.8m5.8 5.8 2.8 2.8M6.3 17.7l2.8-2.8m5.8-5.8 2.8-2.8" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-1a8 8 0 0 1 16 0v1" /></>,
  phone: <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />,
  pin: <><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3zM13 7l3 3" />,
  trash: <path d="M4 7h16M9 7V4h6v3m-7 0v13h8V7" />,
  pause: <path d="M8 5v14m8-14v14" />,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1.5" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
  logout: <path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4m5-4 4-4-4-4m4 4H9" />,
  paste: <><rect x="6" y="5" width="12" height="16" rx="2" /><path d="M9 5V3h6v2M9 11h6M9 15h4" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  refresh: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  wallet: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M16 12h5M3 10h18" /></>,
  ticket: <path d="M4 8a2 2 0 0 0 0 8v3h16v-3a2 2 0 0 0 0-8V5H4zM12 5v14" />,
  file: <><path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5M9 13h6m-6 4h6" /></>,
};

export function Icon({ name, className, size }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" className={className} style={size ? { width: size, height: size } : undefined}>
      {d}
    </svg>
  );
}

/** 시안의 브랜드 마크(28px, 흰 선 두 개 + 점) */
export function BrandMark() {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path d="M8 7c3.5-3 9-2 12.5 1.5" stroke="white" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M20 14c-3.5 4-9 6-13.5 3.5" stroke="white" strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="8" cy="7" r="2" fill="white" />
    </svg>
  );
}
