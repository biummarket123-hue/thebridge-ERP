// supabase-js 흉내 — 쿼리 빌더를 SQL 로 옮겨 PGlite(진짜 Postgres)에 보낸다.
// db.js 를 고치지 않고 그대로 불러 시험하려는 것이다. 필요한 메서드만 있다.
const pg = () => globalThis.__pg;
const uid = () => globalThis.__uid;
export const calls = (globalThis.__calls = globalThis.__calls || []);

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

class Q {
  constructor(table) { this.table = table; this.op = "select"; this.where = []; this.params = []; this.orders = []; this.single = false; this.returning = false; }
  p(v) { this.params.push(v); return `$${this.params.length}`; }
  // select("*, stock_rolls(roll_code)") 처럼 FK 로 묶인 행을 같이 달라는 것(PostgREST embed)을
  // 흉내 낸다. 어느 칸이 FK 인지는 PostgREST 가 스키마에서 알아내지만 여기서는 표로 둔다.
  select(cols) {
    if (this.op !== "select") { this.returning = true; return this; }
    const m = /(\w+)\(([^)]+)\)/.exec(String(cols || ""));
    if (m) this.embed = { table: m[1], cols: m[2].split(",").map(s => s.trim()), fk: { stock_rolls: "roll_id" }[m[1]] };
    return this;
  }
  // or("status.is.null,status.neq.출고완료") — claimShipOut 이 쓰는 두 가지 꼴만
  or(expr) {
    const parts = String(expr).split(",").map(s => {
      const [c, op, ...rest] = s.split("."); const v = rest.join(".");
      if (op === "is" && v === "null") return `${ident(c)} is null`;
      if (op === "neq") return `${ident(c)} <> ${this.p(v)}`;
      if (op === "eq") return `${ident(c)} = ${this.p(v)}`;
      throw new Error("or(): 모르는 꼴 " + s);
    });
    this.where.push(`(${parts.join(" or ")})`); return this;
  }
  insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(obj) { this.op = "update"; this.patch = obj; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.where.push(`${ident(c)} = ${this.p(v)}`); return this; }
  in(c, arr) { this.where.push(`${ident(c)}::text = any(${this.p(arr.map(String))}::text[])`); return this; }
  is(c, v) { if (v !== null) throw new Error("is() 는 null 만"); this.where.push(`${ident(c)} is null`); return this; }
  not(c, op, v) {
    if (op !== "in") throw new Error("not() 는 in 만");
    const arr = String(v).replace(/^\(|\)$/g, "").split(",");
    this.where.push(`not (${ident(c)}::text = any(${this.p(arr)}::text[]))`); return this;
  }
  ilike(c, v) { this.where.push(`${ident(c)} ilike ${this.p(v)}`); return this; }
  order(c, o = {}) { this.orders.push(`${ident(c)} ${o.ascending === false ? "desc" : "asc"}`); return this; }
  range(a, b) { this.off = a; this.lim = b - a + 1; return this; }
  limit(n) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }

  async run() {
    const w = this.where.length ? ` where ${this.where.join(" and ")}` : "";
    let sql;
    if (this.op === "select") {
      const e = this.embed;
      const embedSel = e && e.fk
        ? `, (select row_to_json(e) from (select ${e.cols.map(ident).join(", ")} from ${ident(e.table)} e where e.id = x.${ident(e.fk)}) e) as ${ident(e.table)}`
        : "";
      sql = `select row_to_json(t) r from (select x.*${embedSel} from ${ident(this.table)} x${w}`
        + (this.orders.length ? ` order by ${this.orders.join(", ")}` : "")
        + (this.lim !== undefined ? ` limit ${this.lim}` : "")
        + (this.off ? ` offset ${this.off}` : "") + `) t`;
    } else if (this.op === "insert") {
      const cols = Object.keys(this.rows[0]);
      const vals = this.rows.map(r => `(${cols.map(c => this.p(r[c])).join(", ")})`).join(", ");
      sql = `with t as (insert into ${ident(this.table)} (${cols.map(ident).join(", ")}) values ${vals} returning *) select row_to_json(t) r from t`;
    } else if (this.op === "update") {
      // set 절의 파라미터를 where 절 뒤에 붙인다(번호가 이어지게)
      const sets = Object.entries(this.patch).map(([c, v]) => `${ident(c)} = ${this.p(v)}`).join(", ");
      sql = `with t as (update ${ident(this.table)} set ${sets}${w} returning *) select row_to_json(t) r from t`;
    } else {
      sql = `with t as (delete from ${ident(this.table)}${w} returning *) select row_to_json(t) r from t`;
    }
    calls.push({ table: this.table, op: this.op });
    try {
      const res = await pg().query(sql, this.params);
      const rows = res.rows.map(x => x.r);
      if (this.op !== "select" && !this.returning) return { data: null, error: null };
      if (this.single) return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code } };
    }
  }
  then(a, b) { return this.run().then(a, b); }
}

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session: uid() ? { user: { id: uid() } } : null } }),
    setSession: async () => ({ data: { session: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  from: (t) => new Q(t),
  async rpc(name, params = {}) {
    calls.push({ rpc: name, params });
    try {
      const keys = Object.keys(params);
      const args = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
      const vals = keys.map(k => params[k]);
      // 행(복합형)을 돌려주는 함수는 row_to_json 으로 받는다
      if (["roll_apply_movement", "pack_item_from_roll", "roll_add_piece", "unpack_item_cut"].includes(name)) {
        const r = await pg().query(`select row_to_json(t) r from ${name}(${args}) t`, vals);
        return { data: r.rows[0]?.r ?? null, error: null };
      }
      const r = await pg().query(`select ${name}(${args}) r`, vals);
      return { data: r.rows[0]?.r ?? null, error: null };
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code } };
    }
  },
  storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }),
  removeChannel() {},
};
