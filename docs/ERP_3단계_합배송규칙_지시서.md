# THE BRIDGE ERP (Company) — 3단계 작업 지시서: 합배송 규칙 통일과 택배비 재계산

작성일: 2026-10-01
대상 저장소: `C:\Users\A\thebridge-ERP-company` (master ≥ `20035c2`)
작업자: Claude Code / 검토자: Cowork(읽기 전용)
배포 전 필요한 것: **셀러 공지** — 합배송으로 묶으면 출고예정일이 늦춰지는 쪽으로 바뀐다.

---

## 0. 무엇을 왜 바꾸는가

합배송 묶기가 네 경로에 흩어져 있고 규칙이 제각각이다.

| 경로 | 파일 | 출고일 | 택배비 |
|---|---|---|---|
| 주문등록 후 자동 묶기 | `OrderInput.jsx` 2027행 근처 `findMergeCandidates`+`groupShipTarget` | 가장 빠른 날 | 안 건드림 |
| 주문등록 시 수동 선택 | `OrderInput.jsx` 2011행 근처 `setMergeGroup` | 안 건드림 | 안 건드림 |
| 주문현황 합배송 모달 | `MergeModal.jsx` 93행 | 안 건드림 | 안 건드림 |
| 같은 고객 전체 자동 묶기 | `ErpApp.jsx` 1497행 `autoMergeSameCustomer` | 안 건드림 | 안 건드림 |
| 운임비 조정 모달 | `MergeModal.jsx` `FreightModal` | — | 사람이 1건 지정, 나머지 0 |
| 그룹 해제 | `ErpApp.jsx` 1522행 | 안 건드림 | 안 건드림 |

택배비는 "묶으면 사람이 운임비 조정을 눌러 1건만 남긴다"는 전제인데, 안 누르면 4,000원이 두 건에 남는다. 2026-09-30 김○연 건이 그 사례였고, 택배사 판정을 최대값으로 바꾼 건(`5e5cac8`) 증상 처리였다. 이번에 원인을 없앤다.

다음 단계(링크 주문)에서 고객이 직접 합배송을 고르게 되므로, 그 전에 셀러 경로와 고객 경로가 같은 규칙을 타야 한다.

### 바꿀 규칙 세 가지 (2026-09-29 결정)
1. **합배송 제외 대상은 출고완료뿐.** 포장완료된 주문도 묶인다 — 박스를 다시 열며, 기존 `packed_sig` 재포장 경고가 그걸 알린다. (`findMergeCandidates`는 이미 이렇게 돼 있다. 확인만.)
2. **그룹 출고예정일 = 가장 늦은 멤버의 날짜.** 지금은 가장 빠른 날로 당긴다. 묶는다는 건 "한 번에 받겠다"는 뜻이므로 마지막 주문에 맞춘다. 단, 긴급(`isUrgent`) 멤버가 하나라도 있으면 긴급 유지(당일).
3. **택배비 부담 주문은 그룹 구성이 바뀔 때마다 자동 재계산.** 사람이 운임비 조정을 누르지 않아도 한 건에만 남는다.

### 범위에서 제외
- 입금 자동매칭 (하지 않기로 결정)
- 링크 주문 (4단계 지시서)
- `FreightModal` 삭제 — 남겨둔다. 자동 재계산 결과를 사람이 덮어쓰는 용도.

---

## 1. 택배비 재계산 함수 — `src/lib/freight.js` (신규, 순수 함수)

```js
/**
 * 그룹의 택배비 부담 주문을 정한다. 반환: [{ id, shippingFee }] — 바뀌는 주문만.
 *
 * 규칙:
 *  - 그룹 안에서 택배비는 한 건에만 남고 나머지는 0.
 *  - 이미 부담자가 있으면(shippingFee > 0 인 주문) 그중 **가장 먼저 등록된 건**을 유지한다.
 *    둘 이상이 >0 이면 첫 번째만 남기고 나머지를 0 으로 — 이게 김○연 사례의 교정이다.
 *  - 아무도 안 들고 있으면 가장 먼저 등록된 건에 baseFee.
 *  - 멤버가 1건(그룹 해제·분리·만료로 혼자 남음)이면 그 건이 baseFee 를 들어야 한다.
 *    단, 무료배송권 사용(freeShippingUsed)이면 0 유지.
 *
 * 돈이 이미 들어온 주문은 건드리지 않는다:
 *  - paymentStatus 가 '입금완료'·'부분환불'·'환불완료' 인 주문의 shippingFee 는 바꾸지 않는다.
 *    바꾸면 청구액이 달라져 입금 대조가 틀어진다.
 *  - 부담자를 새로 정해야 하는데 입금완료 건이 이미 >0 으로 들고 있으면 그 건이 부담자다(변경 없음).
 *  - 입금완료 건이 둘 이상 >0 이면 자동으로 못 고친다 → 변경 없이 { conflict: true } 를 돌려주고
 *    화면이 토스트로 알린다("입금완료 2건에 택배비가 각각 있어 수동 조정 필요").
 *
 * baseFee: settings.data.freight.baseFee (기본 4000). 설정 탭에 입력칸 추가(아래 4절).
 */
export function recomputeGroupFreight(groupOrders, { baseFee, paymentStatusOf }) { ... }
```

`paymentStatusOf(order)`는 `getPayStatus`(constants.js) 또는 `_computed.paymentStatus`를 쓴다 — 호출부가 넘긴다. 순수 함수라 `tests/`에서 바로 돌린다.

### 적용 함수 — `src/lib/db.js`
```js
/** 그룹 재계산 결과를 DB 에 쓴다. 바뀌는 게 없으면 아무 요청도 안 보낸다. */
export async function applyGroupFreight(groupOrders, opts)  // recomputeGroupFreight → updateOrdersBulk 를 shippingFee 별로 묶어 호출
```

---

## 2. 출고예정일 규칙 — `src/lib/autoMerge.js`

`groupShipTarget(orders)`:
```js
// 가장 늦은 날짜. 긴급이 하나라도 있으면 긴급 유지.
// 이유: 묶는다 = 한 번에 받는다. 먼저 넣은 주문을 나중 주문이 당기는 게 아니라 나중 주문에 맞춘다.
const urgent = orders.some(o => o.isUrgent);
const dates = orders.map(o => o.shipDate).filter(Boolean).sort();
return { shipDate: dates[dates.length - 1] || null, isUrgent: urgent };
```
`findMergeCandidates`의 제외 조건(출고완료·환불·splitShipping)은 그대로. `isReserved`(예약 건 끼면 묻기)도 그대로 — 규칙 2가 "늦춤"이라 예약 건이 끼면 더 늦춰지는데, 그건 셀러가 묻는 창에서 보고 정한다.

`AutoMergeAskModal`(OrderInput)의 문구가 "빠른 날로 당긴다"는 전제로 쓰여 있으면 고친다.

---

## 3. 모든 경로가 같은 두 함수를 부르게

묶음·해제·분리·출고 뒤에 **반드시** `groupShipTarget`(출고일)과 `applyGroupFreight`(택배비)를 그룹 전체에 적용한다.

| 경로 | 바꿀 것 |
|---|---|
| `OrderInput.jsx` 자동 묶기(2027행~) | 이미 `groupShipTarget` 씀 → 규칙 2 반영은 자동. `updateOrdersBulk` 뒤에 `applyGroupFreight` 추가 |
| `OrderInput.jsx` 수동 선택(2011행~) | `setMergeGroup` 뒤에 출고일 적용 + `applyGroupFreight` |
| `MergeModal.jsx` 93행 | 동일 |
| `ErpApp.jsx` `autoMergeSameCustomer` | 그룹마다 동일. 되돌리기(`undoAutoMerge`)는 그룹을 풀면서 각 주문을 1건 그룹으로 보고 재계산 |
| `ErpApp.jsx` 1522행 그룹 해제 | 풀린 주문들 각각 1건 그룹으로 재계산(= 미입금이면 baseFee 복구) |
| `splitShipping` 토글(있는 곳 전부 grep) | 분리된 건은 1건 그룹, 남은 그룹은 재계산 |
| 출고(`ErpApp.jsx` 626행 `shipGroupOf` 쓰는 함수) | 출고 뒤 그룹에 **미출고 멤버가 남아 있으면**(미입금 등으로 못 나간 건) 남은 멤버들로 재계산. 이게 "합배송 골랐는데 먼저 나가버린" 케이스의 처리다 |
| `FreightModal` | 그대로. 사람이 정한 값이 자동 재계산보다 우선해야 하므로, 모달에서 저장한 뒤엔 재계산을 부르지 않는다 |

공통 헬퍼를 하나 두면 호출부가 짧아진다:
```js
// db.js
export async function afterGroupChange(groupOrders, { baseFee, paymentStatusOf })
// = 출고일(groupShipTarget) + 택배비(applyGroupFreight) 한 번에. 멤버 0건이면 아무것도 안 함.
```

---

## 4. 설정 — 기본 택배비

`settings.data.freight = { baseFee: 4000 }`. 설정 탭(`ManagerSettings.jsx` 또는 설정 화면)에 "기본 택배비" 숫자 입력칸 하나. 없으면 4000. 4단계 링크 주문 페이지도 이 값을 쓴다.

---

## 5. 완료 기준

1. `recomputeGroupFreight` 순수 함수 테스트: (a) 4,000+4,000 → 첫 건 4,000, 둘째 0 (b) 0+0 → 첫 건 baseFee (c) 1건만 → baseFee, 무료배송권이면 0 (d) 입금완료 건이 4,000 들고 있고 미입금 건도 4,000 → 미입금 건만 0 (e) 입금완료 2건 모두 4,000 → 변경 없음 + conflict
2. `groupShipDate` 테스트: 10/2·10/5 → 10/5. 긴급 포함 → 긴급
3. 주문등록 자동 묶기 → 그룹 출고일이 늦은 날, 택배비 한 건만
4. 합배송 모달로 묶기 → 동일
5. 그룹 해제 → 풀린 미입금 주문에 baseFee 복구, 입금완료 주문은 그대로
6. 그룹에서 1건만 출고(나머지 미입금) → 남은 건이 baseFee 부담
7. `FreightModal`로 수동 지정 → 그 값 유지(자동 재계산이 덮지 않음)
8. 기존 그룹 데이터는 건드리지 않는다 — 마이그레이션 없음. 다음 변경 때 재계산된다
9. 빌드·테스트 통과

## 6. 배포 전 셀러 공지 문구(초안)
> 합배송으로 묶으면 출고예정일이 **가장 늦은 주문 기준**으로 바뀝니다(긴급 건 제외). 택배비는 묶는 순간 한 건에만 자동으로 남습니다. 직접 바꾸려면 운임비 조정을 쓰세요.
