// 协同基线合并逻辑验证脚本（构建产物运行，不进应用包）
// 运行：node scripts/test-collab.mjs  （会先用 esbuild 打包 src/store/collab.ts）
import { build } from "esbuild";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const outdir = await mkdtemp(join(tmpdir(), "collab-"));
await build({
  entryPoints: ["src/store/collab.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: join(outdir, "collab.mjs"),
  logLevel: "silent",
});
const { loadHub, commitToHub } = await import(join(outdir, "collab.mjs"));

// ---- 内存版 localStorage ----
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};

let passed = 0;
function test(name, fn) {
  store.clear();
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const ids = (snap) => snap.evidence.map((e) => e.id);
const byId = (snap, id) => snap.evidence.find((e) => e.id === id);

test("初始基线：无旧数据时生成修订号 0 的完整快照", () => {
  const snap = loadHub();
  assert.equal(snap.revision, 0);
  assert.equal(snap.evidence.length, 3);
  assert.ok(snap.evidence.every((e) => typeof e.order === "number" && e.status === "待展示" && e.pendingReview === false));
  assert.equal(snap.session.role ?? undefined, undefined); // 角色是设备本地字段，不入基线
});

test("旧数据升级：只有 evidence、无修订号也能打开，缺失字段按首次展示补齐", () => {
  store.set("pair-wise-yf-49/court", JSON.stringify({ evidence: [{ id: "x1", exhibitNo: "书证-1", title: "旧证据", duration: 5, presenter: "原告", sensitive: false, note: "" }] }));
  const snap = loadHub();
  assert.equal(snap.revision, 0);
  assert.equal(snap.evidence.length, 1);
  assert.equal(snap.evidence[0].status, "待展示");
  assert.equal(snap.evidence[0].order, 0);
  assert.equal(snap.evidence[0].pendingReview, false);
  assert.equal(snap.session.currentEvidenceId, "x1");
  assert.equal(snap.session.timerSeconds, 300);
});

test("快进提交：基线等于最新修订直接接受，修订号 +1", () => {
  const base = loadHub();
  const client = structuredClone(base);
  client.evidence[0].status = "展示中";
  const result = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: client, ops: ["show"], role: "法官" });
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.revision, 1);
  assert.equal(byId(result.snapshot, "e1").status, "展示中");
});

test("越权提交：书记员执行展示被拒绝且不落库", () => {
  const base = loadHub();
  const client = structuredClone(base);
  client.evidence[0].status = "展示中";
  const result = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: client, ops: ["show"], role: "书记员" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "FORBIDDEN");
  assert.match(result.error, /越权/);
  // 基线未被改写
  assert.equal(loadHub().revision, 0);
  assert.equal(byId(loadHub(), "e1").status, "待展示");
});

test("三路合并：断线方离线展示 + 基线方调顺序，状态与顺序互不覆盖", () => {
  const base = loadHub();
  byId(base, "e1").status = "已展示";
  // 基线方调顺序（模拟 reducer：已展示留痕标待复核）
  const headSnap = structuredClone(base);
  headSnap.evidence = [headSnap.evidence[2], headSnap.evidence[0], headSnap.evidence[1]].map((e, i) => ({ ...e, order: i, pendingReview: e.status === "已展示" }));
  const headResult = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: headSnap, ops: ["reorder"], role: "书记员" });
  assert.equal(headResult.ok, true);
  // 断线方离线开始展示 e2
  const clientSnap = structuredClone(base);
  byId(clientSnap, "e2").status = "展示中";
  clientSnap.session.currentEvidenceId = "e2";
  clientSnap.session.phase = "质证";
  const mergeResult = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: clientSnap, ops: ["show"], role: "法官" });
  assert.equal(mergeResult.ok, true);
  const merged = mergeResult.snapshot;
  assert.equal(merged.revision, 2);
  // 已播内容不回退
  assert.equal(byId(merged, "e1").status, "已展示");
  // 离线展示生效
  assert.equal(byId(merged, "e2").status, "展示中");
  // 基线方的顺序保留，双方提交不互相覆盖
  assert.deepEqual(ids(merged), ["e3", "e1", "e2"]);
  // 已展示留痕 + 待复核标记保留
  assert.equal(byId(merged, "e1").pendingReview, true);
  // 计时按当前证据重算
  assert.equal(merged.session.currentEvidenceId, "e2");
  assert.equal(merged.session.timerSeconds, 10 * 60);
});

test("旧修订不能倒着覆盖：基线已展示的证据，断线方旧快照退回待展示无效", () => {
  const base = loadHub();
  const headSnap = structuredClone(base);
  byId(headSnap, "e2").status = "已展示";
  headSnap.session.currentEvidenceId = "e3";
  headSnap.session.phase = "举证";
  const headResult = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: headSnap, ops: ["complete"], role: "法官" });
  assert.equal(headResult.ok, true);
  // 断线方拿着旧基线，本地把 e2 当待展示并选中
  const clientSnap = structuredClone(base);
  byId(clientSnap, "e2").status = "待展示";
  clientSnap.session.currentEvidenceId = "e2";
  const mergeResult = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: clientSnap, ops: ["select"], role: "法官" });
  assert.equal(mergeResult.ok, true);
  // 旧修订无法倒着覆盖：e2 仍是已展示
  assert.equal(byId(mergeResult.snapshot, "e2").status, "已展示");
  // 已播内容跳过：基线方已切到 e3，旧修订的选择不回退当前证据
  assert.equal(mergeResult.snapshot.session.currentEvidenceId, "e3");
  assert.equal(mergeResult.snapshot.session.phase, "举证");
});

test("顺序变更：未展示项重新排队，已展示留痕标待复核", () => {
  const base = loadHub();
  byId(base, "e1").status = "已展示";
  // 基线方先提交一次阶段切换，制造 revision 1（断线方持旧基线）
  const headSnap = structuredClone(base);
  headSnap.session.phase = "休庭";
  const headResult = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: headSnap, ops: ["phase"], role: "法官" });
  assert.equal(headResult.ok, true);
  // 断线方离线调顺序（旧基线合并路径触发待复核标记）
  const client = structuredClone(base);
  client.evidence = [client.evidence[2], client.evidence[0], client.evidence[1]].map((e, i) => ({ ...e, order: i }));
  const result = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: client, ops: ["reorder"], role: "书记员" });
  assert.equal(result.ok, true);
  assert.deepEqual(ids(result.snapshot), ["e3", "e1", "e2"]);
  assert.equal(byId(result.snapshot, "e3").order, 0);
  assert.equal(byId(result.snapshot, "e2").status, "待展示");
  assert.equal(byId(result.snapshot, "e1").pendingReview, true);
});

test("代理人只能提异议：代理人执行展示被拒，提异议被接受", () => {
  const base = loadHub();
  const forbidSnap = structuredClone(base);
  forbidSnap.evidence[0].status = "展示中";
  const forbidden = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: forbidSnap, ops: ["show"], role: "代理人" });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, "FORBIDDEN");

  const okSnap = structuredClone(base);
  okSnap.objections.unshift({ id: "o2", evidenceId: "e1", ground: "真实性异议", explanation: "代理人对证据真实性提出异议", status: "待裁定", createdAt: new Date().toISOString() });
  const accepted = commitToHub({ baseRevision: 0, baseSnapshot: base, snapshot: okSnap, ops: ["addObjection"], role: "代理人" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.snapshot.objections.length, 2);
});

console.log(`\n${passed} 个协同基线场景全部通过`);
