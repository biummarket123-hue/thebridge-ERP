import { useState } from "react";
import * as XLSX from "xlsx-js-style";
import * as db from "../lib/db.js";

import { SF, S, baseInp, useTheme } from "../constants.js";
import { isChannelDummyRow } from "../lib/patterns.js";

// 연락처를 가운데 4자리로 정규화.
// 11자리(010-XXXX-YYYY) → 가운데 4자리(XXXX), 4자리면 그대로, 그 외엔 원본 trim.
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.length === 11) return digits.slice(3, 7);
  if (digits.length === 4) return digits;
  return String(raw || "").trim();
}

// 미래 날짜 자동 보정 — 업로드 시점(today)보다 미래면 1년 빼서 작년으로 변경
// 원인: 원본 엑셀에 연도 없이 "12/30"만 적혀 있어 Excel이 현재 연도로 해석하는 케이스 등
function autoCorrectFutureYear(y, m, d, customerLabel) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidate = new Date(y, m - 1, d);
  if (candidate > today) {
    const correctedY = y - 1;
    console.warn(`[엑셀업로드] 미래 날짜 자동보정: ${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")} → ${correctedY}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}${customerLabel?` (${customerLabel})`:""}`);
    return correctedY;
  }
  return y;
}

// Excel 날짜 → "YYYY. MM. DD." 변환
// XLSX.read(..., {cellDates:true}) 사용 시 Date 객체로 옴 (1900/1904 시스템 자동 처리)
// 레거시: 숫자(시리얼)로 들어오는 경우도 처리 (1900 시스템 가정)
// 미래 날짜는 자동 -1년 보정 (원본 엑셀의 연도 누락 케이스 대응)
function fromExcelDate(val, customerLabel) {
  if (val instanceof Date && !isNaN(val)) {
    // XLSX 라이브러리의 시리얼+날짜포맷 셀 변환 시 51초 어긋남 버그 회피.
    // (예: 시리얼 45550 → 2024-09-14T14:59:08Z 로 변환되어 KST .getDate()가 14 반환)
    // 12시간 더해 안전한 정오로 옮긴 뒤 로컬 컴포넌트 추출.
    const safe = new Date(val.getTime() + 12 * 60 * 60 * 1000);
    let y = safe.getFullYear();
    const m = safe.getMonth() + 1;
    const d = safe.getDate();
    y = autoCorrectFutureYear(y, m, d, customerLabel);
    return y + ". " + String(m).padStart(2, "0") + ". " + String(d).padStart(2, "0") + ".";
  }
  if (typeof val === "number") {
    const date = new Date(Math.round((val - 25569) * 86400 * 1000) + 9 * 60 * 60 * 1000);
    let y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    y = autoCorrectFutureYear(y, m, d, customerLabel);
    return y + ". " + String(m).padStart(2, "0") + ". " + String(d).padStart(2, "0") + ".";
  }
  return String(val || "");
}

function ExcelImport({orders, setOrders, customers, setCustomers, showToast}) {
  const G = useTheme();

  const [step, setStep] = useState("idle"); // idle | preview | done
  const [preview, setPreview] = useState(null); // {orders:[], customers:[]}
  const [mode, setMode] = useState("orders"); // orders | customers
  const [colMap, setColMap] = useState({});
  const [headers, setHeaders] = useState([]);
  const [rawRows, setRawRows] = useState([]);
  const [fileName, setFileName] = useState("");
  const [importType, setImportType] = useState("append"); // append | replace
  const [isLedger, setIsLedger] = useState(false); // 마켓원장 형식 자동 감지

  const ORDER_FIELDS = [
    {k:"date",l:"날짜",req:true},
    {k:"customer",l:"고객명",req:true},
    {k:"phone",l:"연락처(뒤4자리)"},
    {k:"fabric",l:"원단명",req:true},
    {k:"qty",l:"수량(마)"},
    {k:"amount",l:"금액"},
    {k:"payment",l:"결제구분"},
    {k:"address",l:"배송지"},
    {k:"note",l:"메모"},
    {k:"manager",l:"담당자"},
    {k:"status",l:"상태"},
  ];
  const CUST_FIELDS = [
    {k:"name",l:"고객명",req:true},
    {k:"phone",l:"연락처"},
    {k:"nickname",l:"닉네임"},
    {k:"address",l:"주소"},
    {k:"note",l:"메모"},
  ];

  // 자동 컬럼 매핑
  const autoMap = (hdrs, type) => {
    const map = {};
    const hints = {
      date:["날짜","일자","주문일","date"],
      customer:["고객명","고객","이름","name","customer","성명"],
      phone:["연락처","전화","phone","tel","뒤4","휴대폰"],
      fabric:["원단","원단명","품명","품목","상품명","fabric","item"],
      qty:["수량","마","qty","quantity"],
      amount:["금액","단가","가격","amount","price","원"],
      payment:["결제","입금","결제구분","payment"],
      address:["배송지","주소","address","배송"],
      note:["메모","비고","note","notes","특이"],
      manager:["담당자","담당","manager"],
      status:["상태","status"],
      name:["고객명","이름","name","성명"],
      nickname:["닉네임","별명","nickname","alias"],
    };
    const fields = type==="orders" ? ORDER_FIELDS : CUST_FIELDS;
    fields.forEach(f=>{
      const h=f.k; const kws=hints[h]||[h];
      const found=hdrs.find(col=>kws.some(kw=>col&&col.toString().toLowerCase().includes(kw.toLowerCase())));
      if(found) map[h]=found;
    });
    return map;
  };

  const handleFile = (e) => {
    const file = e.target.files[0];
    if(!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(ev.target.result, {type:"binary", cellDates: true});
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, {header:1,defval:""});
        if(rows.length<2){showToast("데이터가 없습니다","error");return;}

        // 마켓원장 헤더 자동 감지: 첫 5행에서 핵심 컬럼 4개 모두 있는 행을 찾음.
        // 마켓원장 export는 Row 1~3에 안내문/합계/빈 행이 있고 Row 4가 실제 헤더라
        // 무조건 Row 1을 헤더로 잡으면 감지 실패 + 매핑 깨짐.
        const REQUIRED = ["판매처","입금자명","주문일","마수"];
        let headerIdx = -1;
        const scanLimit = Math.min(5, rows.length);
        for (let i = 0; i < scanLimit; i++) {
          const row = rows[i];
          if (!row) continue;
          const cells = row.map(h => String(h).trim());
          if (REQUIRED.every(kw => cells.includes(kw))) {
            headerIdx = i;
            break;
          }
        }

        const ledgerDetected = headerIdx >= 0;

        // 빈 행 판정 강화 — 기존 c !== "" 만 체크하면 null/undefined/공백/NBSP 통과해
        // XLSX가 만든 padding row 수천 건이 "미입력"으로 저장됨 (분석 결과 3,893건).
        // trim 기반 + 모든 falsy 처리.
        const isCellEmpty = (c) =>
          c === null || c === undefined || (typeof c === "string" && c.trim() === "");
        const isRowEmpty = (r) => !r || r.length === 0 || r.every(isCellEmpty);

        let hdrs, dataRows;
        if (ledgerDetected) {
          hdrs = rows[headerIdx].map(h => String(h).trim());
          dataRows = rows.slice(headerIdx + 1).filter(r => !isRowEmpty(r));
        } else {
          hdrs = rows[0].map(h => String(h).trim());
          dataRows = rows.slice(1).filter(r => !isRowEmpty(r));
        }

        setHeaders(hdrs);
        setRawRows(dataRows);
        setIsLedger(ledgerDetected);

        if (ledgerDetected) {
          if (mode === "customers") {
            // 마켓원장 → 고객: 입금자명/연락처 자동 매핑 (컬럼명 문자열)
            setColMap({ name: "입금자명", phone: "연락처" });
          } else {
            setColMap({}); // 주문은 buildLedgerOrders가 헤더명으로 직접 처리
          }
          setStep("preview");
          const skipMsg = headerIdx > 0 ? ` (안내 ${headerIdx}행 자동 스킵)` : "";
          showToast(`✓ 마켓원장 감지 · ${dataRows.length}행 자동 매핑${skipMsg}`);
        } else {
          const autoM = autoMap(hdrs, mode);
          setColMap(autoM);
          setStep("preview");
          showToast(`✓ ${dataRows.length}행 감지 · 컬럼 자동 매핑`);
        }
      } catch(err) {
        showToast("파일 읽기 오류: "+err.message,"error");
      }
    };
    reader.readAsBinaryString(file);
    e.target.value="";
  };

  const getCell = (row, col) => {
    if(!col) return "";
    const idx = headers.indexOf(col);
    return idx>=0 ? String(row[idx]||"").trim() : "";
  };

  // 셀의 원본 값(숫자/문자열)을 그대로 반환 — Excel serial 처리용
  const getRawCell = (row, col) => {
    if (!col) return null;
    const idx = headers.indexOf(col);
    return idx >= 0 ? row[idx] : null;
  };

  // 마켓원장 전용 파서 (헤더명 기준 하드코딩 매핑)
  const buildLedgerOrders = () => {
    const idxOf = {
      date:         headers.indexOf("주문일"),
      paymentDate:  headers.indexOf("입금일"), // 주문일이 비정상(<2000년)일 때 fallback
      customer:     headers.indexOf("입금자명"),
      phone:        headers.indexOf("연락처"),
      fabric:       headers.indexOf("품목"),
      qty:          headers.indexOf("마수"),
      amount:       headers.indexOf("매출"),
      shippingFee:  headers.indexOf("운임비"),
      totalAmount:  headers.indexOf("운임비포함매출"),
      manager:      headers.indexOf("담당자"),
      salesChannel: headers.indexOf("판매처"),
      note:         headers.indexOf("비고"),
      unitPrice:    headers.indexOf("입고가"),
      // TODO: I열 "출고" (출고일) — orders 테이블에 ship_date 컬럼 없어서 보류.
      //       스키마에 ship_date 추가되면 idxOf.shipDate = headers.indexOf("출고") 추가
    };
    const cellRaw = (row, idx) => idx >= 0 ? row[idx] : "";
    const cellStr = (row, idx) => idx >= 0 ? String(row[idx]||"").trim() : "";
    const cellNum = (row, idx) => {
      if (idx < 0) return 0;
      const v = row[idx];
      if (typeof v === "number") return Math.round(v);
      return Math.round(Number(String(v||"0").replace(/[^0-9.]/g,""))) || 0;
    };
    const cellFloat = (row, idx) => {
      if (idx < 0) return 0;
      const v = row[idx];
      if (typeof v === "number") return v;
      return parseFloat(String(v||"0").replace(/[^0-9.]/g,""))||0;
    };

    let skipped = 0;
    const orders = [];
    rawRows.forEach((row, i) => {
      const customer = cellStr(row, idxOf.customer);
      const phone = cellStr(row, idxOf.phone);
      const fabric = cellStr(row, idxOf.fabric);
      const qty = cellFloat(row, idxOf.qty);
      const amount = cellNum(row, idxOf.amount);
      const unitPrice = cellNum(row, idxOf.unitPrice);
      const dateStr = cellStr(row, idxOf.date);

      // 핵심 5필드(주문일/입금자명/품목/마수/매출) 모두 비어있으면 padding 행으로 간주.
      // handleFile의 빈 행 필터를 통과한 잔여 케이스를 방어 (NBSP/스타일 셀 등).
      if (!dateStr && !customer && !fabric && qty === 0 && amount === 0) {
        skipped++;
        console.log(`[엑셀업로드] 빈 행 skip: row=${i + 2}`);
        return;
      }

      // 정산 채널 더미 행(쿠팡/Npay정산/KB12345 등 + qty=0 + amount=0) 자동 차단
      if (isChannelDummyRow(customer, qty, amount)) {
        skipped++;
        console.log(`[엑셀업로드] 정산 더미 행 skip: row=${i + 2} customer="${customer}"`);
        return;
      }

      // 운임비: "합배" 텍스트면 0(combinedShipping=true), 숫자면 그대로
      const shippingRaw = cellRaw(row, idxOf.shippingFee);
      const isCombinedShipping = typeof shippingRaw === "string" && shippingRaw.includes("합배");
      let shippingFee = 0;
      if (typeof shippingRaw === "number") shippingFee = Math.round(shippingRaw);
      else if (typeof shippingRaw === "string" && !isCombinedShipping) {
        shippingFee = Math.round(Number(shippingRaw.replace(/[^0-9.]/g,""))) || 0;
      }

      const totalAmount = cellNum(row, idxOf.totalAmount) || (amount + shippingFee);
      const manager = cellStr(row, idxOf.manager);
      const salesChannel = cellStr(row, idxOf.salesChannel);
      const note = cellStr(row, idxOf.note);

      // 비고에서 환불 내역 파싱 (마켓원장 export가 "현금환불 N원 적립금환불 N원" 형태로 기입)
      const parseAmt = (s) => parseInt(String(s||"").replace(/[^0-9]/g,""))||0;
      const cashMatch = note.match(/현금환불\s*([\d,]+)/);
      const creditMatch = note.match(/적립금(?:환불|전환)\s*([\d,]+)/);
      const cashRefund = cashMatch ? parseAmt(cashMatch[1]) : 0;
      const creditRefund = creditMatch ? parseAmt(creditMatch[1]) : 0;

      // 주문일 계산 + 비정상(2020~2039년 외) 시 입금일 fallback.
      // 마켓원장 H열에 시리얼 정수(예: 10, 2414)가 들어와 1900~1921년으로 변환되거나
      // "-", "(누락)", " 10/26" 같은 텍스트가 그대로 들어오는 데이터 품질 사고 대응.
      // 입금일(C열)은 같은 행에서 신뢰 가능.
      let orderDate = fromExcelDate(cellRaw(row, idxOf.date), customer) || "";
      const isNormalDate = (s) => /^20[2-3][0-9]\./.test(s); // 2020-2039만 정상
      if (!isNormalDate(orderDate)) {
        const fallback = fromExcelDate(cellRaw(row, idxOf.paymentDate), customer) || "";
        if (isNormalDate(fallback)) {
          console.warn(
            `[엑셀업로드] 주문일 비정상 → 입금일로 대체: row=${i + 2} customer=${customer || "(빈)"} ` +
            `주문일=${orderDate || "빈값"} → 입금일=${fallback}`
          );
          orderDate = fallback;
        } else if (orderDate) {
          console.warn(`[엑셀업로드] 주문일+입금일 모두 비정상: row=${i + 2} customer=${customer || "(빈)"} 주문일=${orderDate}`);
          orderDate = "";
        }
      }

      orders.push({
        id: `#L${String(Date.now()).slice(-4)}${i}`,
        date: orderDate,
        time: "00:00",
        customer: customer || "미입력",
        phone,
        items: [{
          itemNo: null,
          fabric: fabric || "원단 미입력",
          color: "",
          qty,
          amount,
          unitPrice,
        }],
        payment: "입금완료",   // 마켓원장은 항상 완료 (DB 레이어도 hardcoded)
        address: "",
        addressDetail: "",
        links: [],
        note,
        status: "출고완료",    // 마켓원장은 항상 완료
        manager,
        totalAmount,
        shippingFee,
        salesChannel,
        combinedShipping: isCombinedShipping,
        combinedPayment: false,
        _refunds: { cash: cashRefund, credit: creditRefund },
      });
    });
    return { orders, skipped };
  };

  const buildOrders = () => {
    const _d = new Date();
    const now = `${_d.getFullYear()}. ${String(_d.getMonth()+1).padStart(2,"0")}. ${String(_d.getDate()).padStart(2,"0")}.`;
    let skipped = 0;
    const orders = [];
    rawRows.forEach((row, i) => {
      const fabric = getCell(row, colMap.fabric) || "원단 미입력";
      const qty = parseFloat(getCell(row, colMap.qty))||0;
      const amount = parseInt(String(getCell(row, colMap.amount)).replace(/[^0-9]/g,""))||0;
      const customer = getCell(row, colMap.customer);
      // 정산 채널 더미 행 자동 차단
      if (isChannelDummyRow(customer, qty, amount)) {
        skipped++;
        console.log(`[엑셀업로드] 정산 더미 행 skip: row=${i + 2} customer="${customer}"`);
        return;
      }
      const pmt = getCell(row, colMap.payment);
      let payment = "미입금";
      if(pmt && (pmt.includes("완료")||pmt.includes("입금")||pmt.includes("paid"))) payment="입금완료";
      else if(pmt) payment=pmt;
      const status = getCell(row,colMap.status)||"접수";
      orders.push({
        id:`#I${String(Date.now()).slice(-4)}${i}`,
        date: fromExcelDate(getRawCell(row, colMap.date), customer) || now,
        time:"00:00",
        customer: customer || "미입력",
        phone:getCell(row,colMap.phone)||"",
        items:[{fabric, color:"", qty, amount}],
        payment, address:getCell(row,colMap.address)||"",
        note:getCell(row,colMap.note)||"",
        status, manager:getCell(row,colMap.manager)||"",
        totalAmount:amount,
      });
    });
    return { orders, skipped };
  };

  const buildCustomers = () => {
    return rawRows.map((row,i) => {
      const name = getCell(row,colMap.name)||"미입력";
      return {
        id:name+i,
        name, phone:normalizePhone(getCell(row,colMap.phone)),
        address:getCell(row,colMap.address)||"",
        totalOrders:0,total:0,lastOrder:"",
        note:getCell(row,colMap.note)||"",
      };
    });
  };

  const doImport = async () => {
    if(mode==="orders"){
      const { orders: newOrders, skipped } = isLedger ? buildLedgerOrders() : buildOrders();
      try {
        const saved = await db.insertOrderBatch(newOrders);
        // DB에서 최신 주문 다시 조회 (status/payment는 DB 레이어에서 출고완료/입금완료로 강제됨)
        const fresh = await db.fetchOrders();
        setOrders(fresh);
        const skipMsg = skipped > 0 ? ` (정산 행 ${skipped}개 자동 제외됨)` : "";
        showToast(`✓ 주문 ${saved.length}건 저장 완료${isLedger ? " (마켓원장)" : ""}${skipMsg}`);
      } catch (e) {
        showToast(`저장 실패: ${e.message}`, "error");
        return;
      }
    } else {
      // 고객: name+정규화 phone으로 그룹핑 후 신규만 INSERT (기존은 그대로 둠).
      // total_orders 부풀림 방지 — 엑셀 업로드는 명단 보강용으로만 사용.
      // 마켓원장 업로드 케이스 — 합계 행/헤더 행은 입금자명 비어 자동 스킵.
      // 정산 더미 행(쿠팡/Npay정산/KB12345 등)도 차단.
      let dummySkipped = 0;
      const rawList = rawRows.map(row => ({
        name: (getCell(row, colMap.name) || "").trim(),
        phone: normalizePhone(getCell(row, colMap.phone)),
        nickname: getCell(row, colMap.nickname) || "",
        address: getCell(row, colMap.address) || "",
        note: getCell(row, colMap.note) || "",
      })).filter(c => {
        if (!c.name || c.name === "미입력") return false;
        if (isChannelDummyRow(c.name, 0, 0)) {
          dummySkipped++;
          return false;
        }
        return true;
      });

      const grouped = new Map();
      rawList.forEach(c => {
        const key = c.name + "|" + c.phone;
        // 같은 (이름+phone) 중복일 경우 가장 정보 많은 행을 유지
        const prev = grouped.get(key);
        if (!prev) grouped.set(key, c);
        else grouped.set(key, {
          name: c.name,
          phone: c.phone,
          nickname: prev.nickname || c.nickname,
          address: prev.address || c.address,
          note: prev.note || c.note,
        });
      });

      let inserted = 0, exists = 0, failed = 0;
      for (const c of grouped.values()) {
        try {
          const res = await db.insertCustomerIfNew(c);
          if (res.status === "inserted") inserted++;
          else if (res.status === "exists") exists++;
        } catch (e) {
          console.error("insert 실패:", c, e);
          failed++;
        }
      }

      try {
        const fresh = await db.fetchCustomers();
        setCustomers(fresh);
      } catch (e) {
        console.error("고객 리로드 실패:", e);
      }

      const failMsg = failed > 0 ? ` / 실패 ${failed}건` : "";
      const dummyMsg = dummySkipped > 0 ? ` (정산행 ${dummySkipped}건 제외)` : "";
      showToast(`✓ 신규 ${inserted}명 추가 / 기존 ${exists}명 그대로 유지${failMsg}${dummyMsg}`);
    }
    setStep("done");
  };

  const reset = () => {
    setStep("idle");setPreview(null);setHeaders([]);setRawRows([]);
    setColMap({});setFileName("");setIsLedger(false);
  };

  const fields = mode==="orders" ? ORDER_FIELDS : CUST_FIELDS;
  const previewRows = rawRows.slice(0,5);

  return (
    <div>
      <div style={{fontSize:12,color:G.creamMuted,lineHeight:1.7,marginBottom:12}}>
        기존 사용하던 엑셀 파일(.xlsx/.xls/.csv)을 업로드하면<br/>
        컬럼을 자동 인식해서 ERP에 불러옵니다.
      </div>

      {/* 가져올 데이터 종류 */}
      <div style={{display:"flex",gap:0,background:G.subtleBg,borderRadius:9,padding:3,marginBottom:12}}>
        {[{k:"orders",l:"📋 주문 데이터"},{k:"customers",l:"👥 고객 데이터"}].map(t=>(
          <button key={t.k} onClick={()=>{setMode(t.k);setStep("idle");setColMap({});setHeaders([]);setRawRows([]);setIsLedger(false);}}
            style={{flex:1,padding:"9px 4px",borderRadius:7,border:"none",cursor:"pointer",
              fontFamily:S,fontWeight:mode===t.k?800:500,fontSize:12,
              background:mode===t.k?G.copper:"transparent",
              color:mode===t.k?"#fff":G.creamMuted,transition:"all .15s"}}>
            {t.l}
          </button>
        ))}
      </div>

      {step==="idle"&&(
        <label style={{display:"block",cursor:"pointer"}}>
          <div style={{border:`2px dashed ${G.copper}`,borderRadius:13,padding:"28px 20px",textAlign:"center",
            background:G.copperGlow,transition:"all .2s"}}>
            <div style={{fontSize:32,marginBottom:10}}>📂</div>
            <div style={{fontWeight:800,fontSize:15,color:G.cream,marginBottom:5}}>엑셀 파일 선택</div>
            <div style={{fontSize:12,color:G.creamMuted}}>.xlsx · .xls · .csv 지원</div>
          </div>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} style={{display:"none"}}/>
        </label>
      )}

      {step==="preview"&&(
        <div>
          <div style={{background:G.surface,border:`1px solid ${G.border}`,borderRadius:10,padding:11,marginBottom:12,fontSize:12,display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16}}>📄</span>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,color:G.cream}}>{fileName}</div>
              <div style={{color:G.creamMuted,marginTop:2}}>
                {rawRows.length}행 감지 · 컬럼 {headers.length}개
                {isLedger && <span style={{marginLeft:8,padding:"1px 6px",background:G.copperGlow,color:G.copper,borderRadius:4,fontSize:10,fontWeight:800}}>마켓원장 자동 매핑</span>}
              </div>
            </div>
          </div>

          {/* 컬럼 매핑 — 마켓원장 형식이 아닐 때만 */}
          {!isLedger && (
            <>
              <div style={{fontSize:11,fontWeight:800,color:G.copper,letterSpacing:".06em",marginBottom:8,textTransform:"uppercase"}}>컬럼 매핑</div>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:14}}>
                {fields.map(f=>(
                  <div key={f.k} style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:90,fontSize:11,color:f.req?G.cream:G.creamMuted,fontWeight:f.req?700:400,flexShrink:0}}>
                      {f.l}{f.req&&<span style={{color:G.copper}}>*</span>}
                    </div>
                    <select value={colMap[f.k]||""} onChange={e=>setColMap(m=>({...m,[f.k]:e.target.value}))}
                      style={{flex:1,padding:"7px 10px",borderRadius:8,border:`1px solid ${G.border}`,
                        background:G.surface,fontFamily:S,fontSize:12,color:G.cream,outline:"none"}}>
                      <option value="">-- 매핑 안함 --</option>
                      {headers.map(h=><option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 미리보기 */}
          <div style={{fontSize:11,fontWeight:800,color:G.copper,letterSpacing:".06em",marginBottom:8}}>미리보기 (상위 5행)</div>
          <div style={{overflowX:"auto",marginBottom:12}}>
            {isLedger && mode === "customers" ? (
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,minWidth:300}}>
                <thead>
                  <tr style={{background:G.surface}}>
                    {["상태","입금자명","연락처(뒤4자리)"].map(label => (
                      <th key={label} style={{padding:"6px 8px",textAlign:"left",color:G.copper,fontWeight:700,borderBottom:`1px solid ${G.border}`,whiteSpace:"nowrap"}}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(()=>{
                    const ci = headers.indexOf("입금자명");
                    const pi = headers.indexOf("연락처");
                    return previewRows.map((row,ri)=>{
                      const rName = ci>=0 ? String(row[ci]||"").trim() : "";
                      const rPhone = pi>=0 ? normalizePhone(String(row[pi]||"")) : "";
                      const isExisting = rName && customers.some(c => c.name === rName && (c.phone||"") === rPhone);
                      const badge = !rName
                        ? <span style={{padding:"1px 6px",background:G.subtleBg,color:G.creamMuted,borderRadius:4,fontSize:10,fontWeight:700}}>스킵</span>
                        : isExisting
                          ? <span style={{padding:"1px 6px",background:G.copperGlow,color:G.copper,borderRadius:4,fontSize:10,fontWeight:800}}>기존 고객</span>
                          : <span style={{padding:"1px 6px",background:G.subtleBg,color:G.creamMuted,borderRadius:4,fontSize:10,fontWeight:700}}>신규</span>;
                      return (
                        <tr key={ri} style={{borderBottom:`1px solid ${G.border}`}}>
                          <td style={{padding:"6px 8px",whiteSpace:"nowrap"}}>{badge}</td>
                          <td style={{padding:"6px 8px",color:G.cream,whiteSpace:"nowrap"}}>{rName || "-"}</td>
                          <td style={{padding:"6px 8px",color:G.cream,whiteSpace:"nowrap",fontFamily:"monospace"}}>{rPhone || "-"}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            ) : isLedger ? (
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,minWidth:300}}>
                <thead>
                  <tr style={{background:G.surface}}>
                    {["주문일","입금자명","품목","마수","매출","합계"].map(label => (
                      <th key={label} style={{padding:"6px 8px",textAlign:"left",color:G.copper,fontWeight:700,borderBottom:`1px solid ${G.border}`,whiteSpace:"nowrap"}}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(()=>{
                    const di = headers.indexOf("주문일");
                    const ci = headers.indexOf("입금자명");
                    const fi = headers.indexOf("품목");
                    const qi = headers.indexOf("마수");
                    const ai = headers.indexOf("매출");
                    const ti = headers.indexOf("운임비포함매출");
                    return previewRows.map((row,ri)=>(
                      <tr key={ri} style={{borderBottom:`1px solid ${G.border}`}}>
                        <td style={{padding:"6px 8px",color:G.cream,whiteSpace:"nowrap"}}>{fromExcelDate(di>=0?row[di]:null) || "-"}</td>
                        <td style={{padding:"6px 8px",color:G.cream,whiteSpace:"nowrap"}}>{ci>=0?String(row[ci]||"-").trim():"-"}</td>
                        <td style={{padding:"6px 8px",color:G.cream,maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fi>=0?String(row[fi]||"-").trim():"-"}</td>
                        <td style={{padding:"6px 8px",color:G.cream,whiteSpace:"nowrap"}}>{qi>=0?String(row[qi]||"-").trim():"-"}</td>
                        <td style={{padding:"6px 8px",color:G.cream,whiteSpace:"nowrap"}}>{ai>=0?String(row[ai]||"-").trim():"-"}</td>
                        <td style={{padding:"6px 8px",color:G.copper,fontWeight:700,whiteSpace:"nowrap"}}>{ti>=0?String(row[ti]||"-").trim():"-"}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            ) : (
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,minWidth:300}}>
                <thead>
                  <tr style={{background:G.surface}}>
                    {mode==="customers" && (
                      <th style={{padding:"6px 8px",textAlign:"left",color:G.copper,fontWeight:700,borderBottom:`1px solid ${G.border}`,whiteSpace:"nowrap"}}>상태</th>
                    )}
                    {fields.filter(f=>colMap[f.k]).map(f=>(
                      <th key={f.k} style={{padding:"6px 8px",textAlign:"left",color:G.copper,fontWeight:700,borderBottom:`1px solid ${G.border}`,whiteSpace:"nowrap"}}>{f.l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row,ri)=>{
                    let existingBadge = null;
                    if (mode === "customers") {
                      const rName = (getCell(row, colMap.name) || "").trim();
                      const rPhone = normalizePhone(getCell(row, colMap.phone));
                      const isExisting = rName && customers.some(c => c.name === rName && (c.phone||"") === rPhone);
                      existingBadge = isExisting
                        ? <span style={{padding:"1px 6px",background:G.copperGlow,color:G.copper,borderRadius:4,fontSize:10,fontWeight:800}}>기존 고객</span>
                        : <span style={{padding:"1px 6px",background:G.subtleBg,color:G.creamMuted,borderRadius:4,fontSize:10,fontWeight:700}}>신규</span>;
                    }
                    return (
                      <tr key={ri} style={{borderBottom:`1px solid ${G.border}`}}>
                        {mode==="customers" && (
                          <td style={{padding:"6px 8px",whiteSpace:"nowrap"}}>{existingBadge}</td>
                        )}
                        {fields.filter(f=>colMap[f.k]).map(f=>{
                          const display = f.k === "date"
                            ? (fromExcelDate(getRawCell(row, colMap[f.k])) || "-")
                            : (getCell(row, colMap[f.k]) || "-");
                          return (
                            <td key={f.k} style={{padding:"6px 8px",color:G.cream,maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* 추가/교체 옵션 */}
          <div style={{display:"flex",gap:0,background:G.subtleBg,borderRadius:9,padding:3,marginBottom:14}}>
            {[{k:"append",l:"기존 데이터에 추가"},{k:"replace",l:"기존 데이터 교체"}].map(t=>(
              <button key={t.k} onClick={()=>setImportType(t.k)}
                style={{flex:1,padding:"8px 4px",borderRadius:7,border:"none",cursor:"pointer",
                  fontFamily:S,fontWeight:importType===t.k?700:400,fontSize:11,
                  background:importType===t.k?(t.k==="replace"?G.red:G.green):"transparent",
                  color:importType===t.k?"#fff":G.creamMuted,transition:"all .15s"}}>
                {t.l}
              </button>
            ))}
          </div>

          <div style={{display:"flex",gap:8}}>
            <button onClick={reset}
              style={{flex:1,padding:11,borderRadius:10,border:`1px solid ${G.border}`,
                background:"transparent",color:G.creamMuted,fontWeight:600,fontSize:13,cursor:"pointer",fontFamily:S}}>
              취소
            </button>
            <button onClick={doImport}
              style={{flex:2,padding:11,borderRadius:10,border:"none",
                background:`linear-gradient(135deg,${G.copper},${G.copperLight})`,
                color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:S,
                boxShadow:`0 4px 20px ${G.copperGlow}`}}>
              ✓ {rawRows.length}건 불러오기
            </button>
          </div>
        </div>
      )}

      {step==="done"&&(
        <div style={{textAlign:"center",padding:"24px 0"}}>
          <div style={{fontSize:40,marginBottom:10}}>✅</div>
          <div style={{fontWeight:800,fontSize:16,color:G.cream,marginBottom:8}}>불러오기 완료!</div>
          <div style={{fontSize:13,color:G.creamMuted,marginBottom:20}}>데이터가 ERP에 반영됐습니다.</div>
          <button onClick={reset}
            style={{padding:"11px 28px",borderRadius:10,border:`1px solid ${G.border}`,
              background:"transparent",color:G.creamMuted,fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:S}}>
            다시 업로드
          </button>
        </div>
      )}
    </div>
  );
}

export default ExcelImport;
