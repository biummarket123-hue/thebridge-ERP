// 온보딩(가입 직후 첫 설정) — 전체 화면 단계별 마법사. SaasApp 이 구독 회사의 관리자에게 settings.saas.onboardingDone 이 아닐 때 보여준다.
//   1 회사 정보 → 2 담당자 → 3 운영 값 → 4 발송인 정보 → 5 마무리(첫 품번·첫 주문 링크, 구독 안내)
// 단계마다 "다음"(저장) / "건너뛰기". 마지막 "시작하기" 와 위의 "나중에" 가 onboardingDone 을 true 로 저장해 다시 뜨지 않는다.
// 입력 조각과 검증은 SettingsPage 와 같은 것을 쓴다(OpsFields·validateOps·SenderFields) — 두 화면이 어긋나지 않게.
import { useState } from "react";
import "../saas-settings.css";
import * as db from "../../lib/db.js";
import { useSaas } from "../data/SaasData.jsx";
import { useToast } from "../components/Toast.jsx";
import { Button, Chip, TaskRow } from "../components/ui.jsx";
import { BrandMark } from "../icons.jsx";
import { CompanyBrand } from "../components/CompanyBrand.jsx";
import { BRAND } from "../config.js";
import { PLANS, managerSeatsLeft } from "../lib/subscription.js";
import { Field, OpsFields, validateOps, opsFromConfig, SenderFields, senderFromConfig, senderPatch } from "./SettingsPage.jsx";

const STEPS = [
  { key: "company", label: "회사 정보", title: "회사 정보를 확인해 주세요" },
  { key: "managers", label: "담당자", title: "같이 일하는 담당자를 넣어 주세요" },
  { key: "ops", label: "운영 값", title: "택배비·재고 기준을 맞춰 주세요" },
  { key: "sender", label: "발송인", title: "송장에 찍힐 발송인 정보" },
  { key: "done", label: "마무리", title: "준비가 끝났습니다" },
];

function Steps({ at }) {
  return (
    <div className="ob-steps" aria-label={`${at + 1} / ${STEPS.length} 단계`}>
      {STEPS.map((s, i) => <span key={s.key} className={i < at ? "done" : i === at ? "on" : ""} />)}
    </div>
  );
}

export default function Onboarding({ go }) {
  const { account, config, managers, subscription, reloadSettings, reloadAccount, reloadManagers, reloadPinStatus } = useSaas();
  const toast = useToast();
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const step = STEPS[at];

  // 1 회사 정보
  const [company, setCompany] = useState({ name: config.companyName, contact: account?.contact || "" });
  // 2 담당자
  const [mgr, setMgr] = useState({ name: "", isAdmin: false, isPacker: false });
  // 3 운영 값
  const [ops, setOps] = useState(() => opsFromConfig(config));
  // 4 발송인
  const [sender, setSender] = useState(() => senderFromConfig(config));

  const finish = async (navigateTo) => {
    setBusy(true);
    try {
      await db.saveSaasSettings({ onboardingDone: true });
      await reloadSettings();
      if (navigateTo) go?.(navigateTo);
    } catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
    finally { setBusy(false); }
  };
  const next = () => setAt(a => Math.min(STEPS.length - 1, a + 1));
  const back = () => setAt(a => Math.max(0, a - 1));

  const saveCompany = async () => {
    const name = company.name.trim();
    if (!name) return toast("회사명을 입력해 주세요", "error");
    setBusy(true);
    try {
      await db.updateCompanyAccount({ name, contact: company.contact });
      await db.saveSaasSettings({ companyName: name });
      await Promise.all([reloadAccount(), reloadSettings()]);
      // 발송인 기본값이 회사명을 따라가도록 — 아직 손대지 않았으면 새 회사명으로
      setSender(s => ({ ...s, name: s.name === config.companyName || !s.name ? name : s.name, phone: s.phone || company.contact.trim() }));
      next();
    } catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
    finally { setBusy(false); }
  };

  const seats = managerSeatsLeft(account, managers);
  const addManager = async () => {
    const name = mgr.name.trim();
    if (!name) return toast("이름을 입력해 주세요", "error");
    if (managers.some(m => m.name === name)) return toast("같은 이름의 담당자가 있습니다", "error");
    if (seats <= 0) return toast(`담당자 자리가 없습니다 (요금제 최대 ${account?.max_managers}명) — 프로 요금제는 무제한`, "error");
    setBusy(true);
    try {
      await db.addManager({ name, isAdmin: mgr.isAdmin, isPacker: mgr.isPacker, isPublic: false, code: "" });
      await Promise.all([reloadManagers(), reloadPinStatus()]);
      setMgr({ name: "", isAdmin: false, isPacker: false });
      toast(`${name} 담당자를 추가했습니다`, "ok");
    } catch (e) { toast(e.message || "추가하지 못했습니다", "error"); }
    finally { setBusy(false); }
  };

  const saveOps = async () => {
    const v = validateOps(ops);
    if (v.error) return toast(v.error, "error");
    setBusy(true);
    try { await db.saveSaasSettings(v.patch); await reloadSettings(); next(); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
    finally { setBusy(false); }
  };

  const saveSender = async () => {
    setBusy(true);
    try { await db.saveSaasSettings(senderPatch(sender)); await reloadSettings(); next(); }
    catch (e) { toast(e.message || "저장하지 못했습니다", "error"); }
    finally { setBusy(false); }
  };

  const personal = managers.filter(m => !m.isPublic);

  return (
    <div className="gate">
      <div className="sheet wide ob-sheet" role="dialog" aria-modal="true" aria-label="첫 설정">
        <div className="ob-top">
          <CompanyBrand style={{ margin: 0 }} />
          {at < STEPS.length - 1 && <button type="button" className="later" onClick={() => finish()} disabled={busy}>나중에 할게요</button>}
        </div>
        <Steps at={at} />
        <div className="ob-step-label">{at + 1} / {STEPS.length} · {step.label}</div>
        <div className="sheethead"><h2>{step.title}</h2></div>

        {step.key === "company" && (
          <>
            <p className="helptext" style={{ margin: "8px 0 0" }}>가입 때 적은 회사명입니다. 사이드바와 송장·명세서에 이 이름이 보입니다. 모든 값은 나중에 회사 설정에서 바꿀 수 있습니다.</p>
            <Field label="회사명" htmlFor="ob-name"><input id="ob-name" className="forminput" value={company.name} onChange={e => setCompany({ ...company, name: e.target.value })} /></Field>
            <Field label="담당 연락처" htmlFor="ob-contact" hint="선택 · 운영팀이 연락드릴 번호"><input id="ob-contact" className="forminput" inputMode="tel" value={company.contact} onChange={e => setCompany({ ...company, contact: e.target.value })} placeholder="010-" /></Field>
            <div className="ob-foot">
              <span className="grow" />
              <button type="button" className="skip" onClick={next} disabled={busy}>건너뛰기</button>
              <Button icon="chevron" onClick={saveCompany} loading={busy}>다음</Button>
            </div>
          </>
        )}

        {step.key === "managers" && (
          <>
            <p className="helptext" style={{ margin: "8px 0 0" }}>직원은 회사 계정 하나로 들어와 자기 이름을 고르고 4자리 PIN 으로 작업합니다. 이름만 먼저 넣어 두세요 — PIN 은 각자 처음 들어올 때 만들거나 회사 설정에서 정합니다.</p>
            <ul className="ob-mgrs">
              {personal.map(m => <li key={m.id ?? m.name}><span className="avatar" style={{ width: 30, height: 30, borderRadius: 9, fontSize: 13 }}>{m.name.slice(0, 1)}</span><strong>{m.name}</strong><small>{m.isAdmin ? "관리자" : m.isPacker ? "포장 담당" : "담당자"}</small></li>)}
            </ul>
            {account && <p className="helptext" style={{ margin: "8px 0 0" }}>{PLANS[account.plan]?.label || account.plan} · 담당자 {personal.length} / {account.max_managers}명 ({seats}자리 남음)</p>}
            <Field label="새 담당자 이름" htmlFor="ob-mgr"><input id="ob-mgr" className="forminput" value={mgr.name} onChange={e => setMgr({ ...mgr, name: e.target.value })} placeholder="예: 김포장" onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addManager(); } }} /></Field>
            <div className="chiprow" style={{ marginTop: 8 }}>
              <Chip on={mgr.isAdmin} onClick={() => setMgr({ ...mgr, isAdmin: !mgr.isAdmin })}>관리자</Chip>
              <Chip on={mgr.isPacker} onClick={() => setMgr({ ...mgr, isPacker: !mgr.isPacker })}>포장 담당</Chip>
              <Button kind="white" size="sm" icon="plus" onClick={addManager} loading={busy} disabled={seats <= 0}>추가</Button>
            </div>
            <div className="ob-foot">
              <Button kind="white" icon="back" onClick={back} disabled={busy}>이전</Button>
              <span className="grow" />
              <button type="button" className="skip" onClick={next} disabled={busy}>건너뛰기</button>
              <Button icon="chevron" onClick={next} disabled={busy}>다음</Button>
            </div>
          </>
        )}

        {step.key === "ops" && (
          <>
            <p className="helptext" style={{ margin: "8px 0 0" }}>주문 등록의 택배비 버튼, 재고 "부족" 판정, 품번 번호, 출고예정일 계산이 이 값을 씁니다. 잘 모르면 그대로 두고 다음으로.</p>
            <OpsFields f={ops} setF={setOps} idPrefix="ob" />
            <div className="ob-foot">
              <Button kind="white" icon="back" onClick={back} disabled={busy}>이전</Button>
              <span className="grow" />
              <button type="button" className="skip" onClick={next} disabled={busy}>건너뛰기</button>
              <Button icon="chevron" onClick={saveOps} loading={busy}>다음</Button>
            </div>
          </>
        )}

        {step.key === "sender" && (
          <>
            <p className="helptext" style={{ margin: "8px 0 0" }}>송장과 거래명세서의 "보내는 분" 칸입니다. 비워 두면 회사명과 담당 연락처를 씁니다.</p>
            <SenderFields f={sender} setF={setSender} idPrefix="ob-sd" />
            <div className="ob-foot">
              <Button kind="white" icon="back" onClick={back} disabled={busy}>이전</Button>
              <span className="grow" />
              <button type="button" className="skip" onClick={next} disabled={busy}>건너뛰기</button>
              <Button icon="chevron" onClick={saveSender} loading={busy}>다음</Button>
            </div>
          </>
        )}

        {step.key === "done" && (
          <>
            <p className="helptext" style={{ margin: "8px 0 0" }}>이제 바로 쓸 수 있습니다. 처음이라면 이 순서를 권합니다 — 품번을 입고하고, 그 품번으로 첫 주문을 등록해 보세요.</p>
            <div className="ob-links">
              <TaskRow icon="stock" title="첫 품번 입고" hint="재고 관리 › 입고 등록 — 품번·단가·롤 길이" onClick={() => finish("/app/stock")} />
              <TaskRow icon="orders" tone="alert" title="첫 주문 등록" hint="주문 관리 › 주문 등록 — 고객·품목·수량" onClick={() => finish("/app/orders/new")} />
              <TaskRow icon="users" tone="mint" title="기존 데이터 이관 요청" hint="쓰던 엑셀·장부는 운영팀이 대신 넣어 드립니다 — 회사 설정 › 데이터 이관" onClick={() => finish("/app/settings")} />
            </div>
            <div className="notice-box" style={{ marginTop: 10 }}>
              {subscription.phase === "trial"
                ? <>무료 체험이 <b>{subscription.daysLeft}일</b> 남았습니다. 체험 중에도 모든 기능(AI 분석 제외)을 쓸 수 있고, 회사 설정 › 구독에서 카드를 등록하고 결제하면 체험이 끝난 뒤부터 30일씩 이어집니다. 데이터는 체험이 끝나도 지워지지 않습니다.</>
                : <>구독·결제는 회사 설정 › 구독에서 관리합니다. 스타터 {PLANS.starter.price.toLocaleString()}원부터, 스탠다드 {PLANS.standard.price.toLocaleString()}원 / 프로 {PLANS.pro.price.toLocaleString()}원(월, 부가세 별도).</>}
            </div>
            <div className="ob-foot">
              <Button kind="white" icon="back" onClick={back} disabled={busy}>이전</Button>
              <span className="grow" />
              <Button icon="check" onClick={() => finish()} loading={busy}>시작하기</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
