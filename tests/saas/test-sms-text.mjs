// 출고 안내 문자 글 규칙(api/_sms_text.js · src/saas/lib/smsText.js) — LMS 로 넘어가지 않게 90바이트 안에서.
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const t = await import(pathToFileURL(path.join(ROOT, "api/_sms_text.js")).href);
const c = await import(pathToFileURL(path.join(ROOT, "src/saas/lib/smsText.js")).href);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

check("바이트: 한글 2 · 영문 1", t.smsBytes("가a1") === 4 && t.smsBytes("") === 0 && c.smsBytes("가a1") === 4);
check("기본 문구는 보통 회사명으로 90바이트 안", t.smsBytes(t.fillTemplate(t.DEFAULT_TEMPLATE, { 회사명: "동대문원단", 고객명: "김영희", 택배사: "CJ대한통운" })) <= 90);

const vars = { 회사명: "동대문원단", 고객명: "김영희", 택배사: "CJ대한통운" };
const r1 = t.composeSms("[{회사명}] {고객명}님, {택배사}로 발송했습니다.", vars);
check("회사 문구가 짧으면 그대로", r1 && r1.fallback === "" && r1.text === "[동대문원단] 김영희님, CJ대한통운로 발송했습니다." && r1.bytes <= 90, JSON.stringify(r1));

const long = "[{회사명}] {고객명}님, 주문하신 원단이 오늘 {택배사}로 출고되었습니다. 도착까지 1~2일 걸립니다. 감사합니다.";
const r2 = t.composeSms(long, vars);
check("회사 문구가 길면 기본 문구로", r2 && r2.fallback === "default" && r2.bytes <= 90, JSON.stringify(r2));

const longCo = { ...vars, 회사명: "서울동대문종합원단도매상사" };
const r3 = t.composeSms(long, longCo);
check("회사명이 길어 기본 문구도 넘치면 짧은 문구로", r3 && (r3.fallback === "short" || r3.fallback === "trimmed") && r3.bytes <= 90, JSON.stringify(r3));

const hugeCo = { ...vars, 회사명: "가".repeat(60) };
const r4 = t.composeSms(long, hugeCo);
check("회사명이 아주 길면 회사명을 줄여서라도 90바이트 안", r4 && r4.fallback === "trimmed" && r4.bytes <= 90 && r4.text.includes("김영희님"), JSON.stringify(r4));

const r5 = t.composeSms(long, { ...vars, 고객명: "가".repeat(50) });
check("고객 이름이 너무 길어 못 맞추면 null(보내지 않음)", r5 === null);

check("빈 문구·빈 값은 기본 문구·'고객'·'택배'", (() => { const r = t.composeSms("", { 회사명: "A" }); return r && r.text === "[A] 고객님, 주문하신 상품이 택배(으)로 발송되었습니다. 감사합니다."; })());

check("설정 화면: 가장 긴 값으로 잰 바이트가 서버 규칙과 같다", c.templateMaxBytes("[{회사명}] {고객명}님, {택배사}", { companyName: "동대문원단", couriers: ["CJ대한통운", "경동화물"] }) === t.smsBytes("[동대문원단] 홍길동님, CJ대한통운") && c.templateMaxBytes("[{회사명}] {고객명}님, {택배사}", { companyName: "동대문원단", couriers: ["CJ대한통운", "경동화물"] }) === t.templateMaxBytes("[{회사명}] {고객명}님, {택배사}", { companyName: "동대문원단", couriers: ["CJ대한통운", "경동화물"] }));
check("설정 화면: 기본 문구 + 보통 회사명은 90바이트 안, 긴 문구는 넘는다", c.templateMaxBytes(t.DEFAULT_TEMPLATE, { companyName: "동대문원단" }) <= 90 && c.templateMaxBytes(long, { companyName: "동대문원단" }) > 90);
check("상수가 같다", c.SMS_MAX_BYTES === t.SMS_MAX_BYTES && c.SAMPLE_COURIER === t.SAMPLE_COURIER && c.SAMPLE_TRACKING === t.SAMPLE_TRACKING);
check("{송장번호} 자리표시자 — 서버·화면 둘 다, 없으면 빈 글", t.fillTemplate("{택배사} {송장번호}", { 택배사: "CJ", 송장번호: "123" }) === "CJ 123" && c.fillTemplate("{송장번호}", {}) === "" && t.composeSms("[{회사명}] {송장번호}", { 회사명: "A", 송장번호: "999" }).text === "[A] 999");

const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} 통과`);
process.exit(failed ? 1 : 0);
