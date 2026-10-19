// 담당자 락 — 주문에 대한 수정/삭제/환불 등 민감 액션이 가능한지 판정
//
// 규칙 (앞에서부터 우선):
//   1. 현재 작업자가 관리자(isAdmin) → 모두 허용
//   2. 주문에 담당자 미지정(o.manager 비어있음) → 허용
//   3. 주문 담당자 == 현재 작업자 → 허용
//   4. 주문 담당자가 공용(isPublic) → 허용
//   5. 합배송 그룹 멤버 中 본인 담당 주문이 하나라도 있으면 → 허용
//   6. 그 외 → 잠김 (사유 문자열 반환)

export function checkOrderLock(order, currentManagerName, allManagers, allOrders = []) {
  const current = (allManagers || []).find((m) => m.name === currentManagerName);
  if (current?.isAdmin) return null;
  if (!order?.manager) return null;
  if (order.manager === currentManagerName) return null;
  const om = (allManagers || []).find((m) => m.name === order.manager);
  if (om?.isPublic) return null;
  // 합배송 그룹 예외 — 같은 그룹에 본인 담당 주문이 있으면 허용
  if (order.mergeGroupId && Array.isArray(allOrders)) {
    const groupHasMine = allOrders.some(o =>
      o.mergeGroupId === order.mergeGroupId && o.manager === currentManagerName
    );
    if (groupHasMine) return null;
  }
  return `이 주문은 ${order.manager} 담당입니다. 담당자에게 문의해주세요`;
}

// 관리자만 가능한 액션 (담당자 추가/삭제/수정 등)
export function checkAdminOnly(currentManagerName, allManagers) {
  const current = (allManagers || []).find((m) => m.name === currentManagerName);
  if (current?.isAdmin) return null;
  return "관리자만 가능합니다";
}

// 포장 담당자 여부 — isPacker 이면서 관리자가 아닌 경우.
// (관리자는 모든 권한을 가지므로 isPacker 보다 우선)
// 허용: 메모/담당자 메모(공유) 편집, 상태 '접수'·'포장완료' 변경,
//       합배송 같은 고객 묶기(자동 묶기·모아보기의 묶기)
// 차단: 주문 수정/삭제, 다른 고객과 합배송, 입금·환불, 배송권, 보관/출고완료, 대량 송장 등
export function isPacker(currentManagerName, allManagers) {
  const current = (allManagers || []).find((m) => m.name === currentManagerName);
  return !!(current && current.isPacker && !current.isAdmin);
}

// 카드에서 담당자 표시 색상 결정용
// 반환: { label, color, bg, italic }
export function getManagerDisplay(orderManagerName, currentManagerName, allManagers, T) {
  if (!orderManagerName) {
    return {
      label: "담당자 없음",
      color: T.creamMuted,
      bg: T.surface,
      italic: true,
    };
  }
  const om = (allManagers || []).find((m) => m.name === orderManagerName);
  if (om?.isPublic) {
    return {
      label: orderManagerName,
      color: T.blue,
      bg: T.blueBg,
      italic: false,
    };
  }
  const isOwn = orderManagerName === currentManagerName;
  return {
    label: orderManagerName,
    color: isOwn ? T.cream : T.creamMuted,
    bg: T.surface,
    italic: false,
  };
}
