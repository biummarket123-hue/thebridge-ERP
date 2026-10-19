// AI 주문 분석 결과의 합계 검증 + 자동 보정.
// 사용자가 totalAmount를 명시한 경우, items.amount 합 + shippingFee와 비교해
// 일치하지 않으면 단가/합계 해석 오류를 가설별로 시도해 자동 보정한다.
//
// 보정 가설:
//   1) 단가가 사실은 합계였음 (예: "6마 8,000원" → AI가 6×8000=48,000으로 본 케이스)
//      → unitPrice를 amount로, 새 unitPrice = supposedTotal / qty
//   2) amount가 사실은 단가였음 (반대 케이스)
//      → amount를 unitPrice로, 새 amount = supposedUnitPrice × qty
//
// 결과는 parsed에 _validation 필드를 붙여 UI에서 알림 표시. 보정된 item에는 _autoCorrected 플래그.

export function validateAndCorrectAmounts(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const items = parsed.items || [];
  const shippingFee = Number(parsed.shippingFee) || 0;
  const totalAmount = Number(parsed.totalAmount) || 0;

  // 검증 불가능한 케이스
  if (!items.length) return parsed;
  if (!totalAmount) {
    // 사용자가 총액 안 적었으면 검증 스킵
    return parsed;
  }

  // 1. AI 추출 그대로 합계 계산
  const itemsSum = items.reduce(
    (sum, item) => sum + (Number(item.amount) || 0),
    0
  );
  const calculatedTotal = itemsSum + shippingFee;

  // 2. 일치하면 OK
  const diff = Math.abs(calculatedTotal - totalAmount);
  if (diff < 1) {
    return { ...parsed, _validation: { status: "ok" } };
  }

  // 3. 가설 1: 단가가 사실은 합계였음
  const hypothesis1Items = items.map(item => {
    const qty = Number(item.qty) || 1;
    const supposedTotal = Number(item.unitPrice) || 0;
    return {
      ...item,
      amount: supposedTotal,
      unitPrice: qty > 0 ? Math.round(supposedTotal / qty) : supposedTotal,
      _autoCorrected: true,
      _correctionType: "unitPriceWasTotal",
    };
  });
  const hypothesis1Sum = hypothesis1Items.reduce(
    (sum, i) => sum + (Number(i.amount) || 0),
    0
  );
  const hypothesis1Total = hypothesis1Sum + shippingFee;

  if (Math.abs(hypothesis1Total - totalAmount) < 1) {
    console.log("[합계검증] 자동 보정: 단가→합계로 해석 변경", {
      AI계산: calculatedTotal,
      보정후: hypothesis1Total,
      사용자총액: totalAmount,
    });
    return {
      ...parsed,
      items: hypothesis1Items,
      _validation: {
        status: "auto-corrected",
        message: "단가/합계 표기가 모호해 자동 보정했습니다",
        type: "unitPriceWasTotal",
        before: calculatedTotal,
        after: hypothesis1Total,
        expected: totalAmount,
      },
    };
  }

  // 4. 가설 2: amount가 사실은 단가였음
  const hypothesis2Items = items.map(item => {
    const qty = Number(item.qty) || 1;
    const supposedUnitPrice = Number(item.amount) || 0;
    return {
      ...item,
      unitPrice: supposedUnitPrice,
      amount: supposedUnitPrice * qty,
      _autoCorrected: true,
      _correctionType: "amountWasUnitPrice",
    };
  });
  const hypothesis2Sum = hypothesis2Items.reduce(
    (sum, i) => sum + (Number(i.amount) || 0),
    0
  );
  const hypothesis2Total = hypothesis2Sum + shippingFee;

  if (Math.abs(hypothesis2Total - totalAmount) < 1) {
    console.log("[합계검증] 자동 보정: 합계→단가로 해석 변경", {
      AI계산: calculatedTotal,
      보정후: hypothesis2Total,
      사용자총액: totalAmount,
    });
    return {
      ...parsed,
      items: hypothesis2Items,
      _validation: {
        status: "auto-corrected",
        message: "단가/합계 표기가 모호해 자동 보정했습니다",
        type: "amountWasUnitPrice",
        before: calculatedTotal,
        after: hypothesis2Total,
        expected: totalAmount,
      },
    };
  }

  // 5. 모든 보정 실패 → 경고만 (데이터는 그대로)
  const diffSigned = calculatedTotal - totalAmount;
  console.warn("[합계검증] 보정 실패. 수동 확인 필요", {
    AI계산: calculatedTotal,
    사용자총액: totalAmount,
    차이: diffSigned,
  });
  return {
    ...parsed,
    _validation: {
      status: "mismatch",
      message: `합계가 맞지 않습니다 (차이: ${diffSigned.toLocaleString()}원)`,
      calculated: calculatedTotal,
      expected: totalAmount,
      diff: diffSigned,
    },
  };
}
