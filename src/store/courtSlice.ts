import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  Actor, Baseline, Commit, CommitPayload, Evidence, MergeReport, Objection,
  SessionPhase, SessionState, TimelineEntry
} from "../types";
import {
  applyCommit, commitDetail, commitLabel, loadRemoteBaseline, makeCommit, migrate,
  reconcile, saveRemoteBaseline, type ApplyResult
} from "./collab";
import type { RootState, AppDispatch } from "./index";

/* ============================ 种子基线 ============================ */

function seedEvidence(): Evidence[] {
  return [
    { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", presenterRole: "代理人", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定", revision: 0, shownAt: null, needsReview: false },
    { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", presenterRole: "代理人", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩", revision: 0, shownAt: null, needsReview: false },
    { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", presenterRole: "代理人", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45", revision: 0, shownAt: null, needsReview: false }
  ];
}

export const seedBaseline = (): Baseline => {
  const evidence = seedEvidence();
  return {
    revision: 0,
    domainRev: { order: 0, playback: 0, mask: 0, phase: 0 },
    evidence,
    objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
    phase: "举证",
    currentEvidenceId: "e1",
    timerSeconds: 8 * 60
  };
};

const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

export interface SnapshotRecord {
  id: string;
  label: string;
  time: string;
  baselineRevision: number;
  baseline: Baseline;
}

interface CourtState {
  initialized: boolean;
  migratedFromLegacy: boolean;
  /** 协同基线 */
  baseline: Baseline;
  /** 本地会话（基线镜像 + 模式开关） */
  session: SessionState;
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: SnapshotRecord[];
  online: boolean;
  /** 当前操作人角色 */
  actor: Actor;
  /** 离线期间本地乐观提交，等待重连回放 */
  pendingCommits: Commit[];
  /** 最近一次重连合并报告 */
  lastReport: MergeReport | null;
}

const initialState: CourtState = {
  initialized: false,
  migratedFromLegacy: false,
  baseline: seedBaseline(),
  session: seedSession,
  objections: [],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  online: true,
  actor: { role: "法官" },
  pendingCommits: [],
  lastReport: null
};

function addEntry(state: CourtState, actor: TimelineEntry["actor"], action: string, detail: string, revision?: number) {
  state.timeline.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    actor, action,
    detail: revision !== undefined ? `${detail}（r${revision}）` : detail
  });
}

/** 把基线同步进本地会话 */
function adoptBaseline(state: CourtState, baseline: Baseline) {
  state.baseline = baseline;
  state.objections = baseline.objections;
  state.session.phase = baseline.phase;
  state.session.currentEvidenceId = baseline.currentEvidenceId;
  state.session.timerSeconds = baseline.timerSeconds;
}

/* ============================ Slice ============================ */

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    /** 启动时载入远端基线（含旧数据升级补齐） */
    bootstrap(state, action: PayloadAction<{ baseline: Baseline; migrated: boolean }>) {
      if (state.initialized) return;
      adoptBaseline(state, action.payload.baseline);
      state.initialized = true;
      state.migratedFromLegacy = action.payload.migrated;
      if (action.payload.migrated) {
        addEntry(state, "书记员", "旧数据升级", "缺少修订号与角色字段的旧档已按首次展示补齐，可正常打开");
      }
    },

    setOnline(state, action: PayloadAction<boolean>) { state.online = action.payload; },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    setActor(state, action: PayloadAction<Actor>) { state.actor = action.payload; },

    /** 应用一条提交结果（离线乐观更新 / 在线即时提交共用） */
    applyResult(state, action: PayloadAction<{ result: ApplyResult; commit: Commit; queued: boolean }>) {
      const { result, commit, queued } = action.payload;
      adoptBaseline(state, result.baseline);
      if (result.event) addEntry(state, result.event.actor, result.event.action, result.event.detail, result.baseline.revision);
      if (queued) {
        state.pendingCommits.push(commit);
        addEntry(state, "书记员", "离线排队", `${commitLabel(commit.kind)}（r${commit.baseRevision} 基线）待重连合并`);
      }
    },

    /** 权限/状态校验未通过：拒绝并留痕 */
    rejectCommit(state, action: PayloadAction<{ actor: Actor; label: string; reason: string }>) {
      addEntry(state, "书记员", "提交被拒绝", `${action.payload.actor.role}「${action.payload.label}」：${action.payload.reason}`);
    },

    /** 重连合并完成 */
    reconciled(state, action: PayloadAction<{ baseline: Baseline; report: Omit<MergeReport, "id" | "time"> }>) {
      adoptBaseline(state, action.payload.baseline);
      state.pendingCommits = [];
      state.online = true;
      const { applied, skipped, rejected: rej } = action.payload.report;
      state.lastReport = { id: crypto.randomUUID(), time: new Date().toISOString(), ...action.payload.report };
      addEntry(
        state, "书记员", "重连合并",
        `按修订号合并：采纳 ${applied.length} 条，已播/旧修订跳过 ${skipped.length} 条，拒绝 ${rej.length} 条（远端 r${action.payload.report.remoteRevision}）`
      );
      skipped.forEach((s) => addEntry(state, "书记员", "旧修订跳过", s));
      rej.forEach((r) => addEntry(state, "书记员", "越权/冲突拒绝", `${r.detail}：${r.reason}`));
    },

    /** 离线期间对端（模拟）写入：重连时才拉取，此处只登记 */
    remoteQueued(state, action: PayloadAction<string>) {
      addEntry(state, "书记员", "对端离线提交", action.payload);
    },

    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({
        id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(),
        baselineRevision: state.baseline.revision, baseline: structuredClone(state.baseline)
      });
      state.snapshots = state.snapshots.slice(0, 10);
      addEntry(state, state.actor.role === "书记员" ? "书记员" : "法官", "保存庭审快照", `${action.payload}（基线 r${state.baseline.revision}）`);
    },

    restore(state, action: PayloadAction<string>) {
      const record = state.snapshots.find((entry) => entry.id === action.payload);
      if (!record) return;
      adoptBaseline(state, structuredClone(record.baseline));
      state.pendingCommits = [];
      addEntry(state, state.actor.role === "书记员" ? "书记员" : "法官", "恢复庭审快照", `${record.label}（基线 r${record.baselineRevision}），待同步提交已清空`);
    },

    tick(state) {
      if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1;
    }
  }
});

export const {
  bootstrap, setOnline, setMode, setActor, applyResult, rejectCommit,
  reconciled, remoteQueued, snapshot, restore, tick
} = slice.actions;
export default slice.reducer;

/* ============================ Thunk：带修订号的协同提交 ============================ */

export interface SubmitOutcome {
  ok: boolean;
  outcome?: ApplyResult["outcome"];
  reason?: string;
}

/** 统一提交入口：权限在 applyCommit 内判定（越权拒绝），离线则乐观执行并入队 */
export function submitCommit(payload: CommitPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): SubmitOutcome => {
    const root = getState().court;
    const actor = root.actor;
    const commit = makeCommit(actor, root.baseline.revision, payload);
    const result = applyCommit(root.baseline, commit);
    if (result.outcome === "rejected") {
      dispatch(rejectCommit({ actor, label: commitLabel(payload.kind), reason: result.reason ?? "提交被拒绝" }));
      return { ok: false, outcome: "rejected", reason: result.reason };
    }
    dispatch(applyResult({ result, commit, queued: !root.online }));
    if (root.online) saveRemoteBaseline(result.baseline);
    return { ok: true, outcome: result.outcome, reason: result.reason };
  };
}

/** 启动：读取 localStorage 中的远端基线（v0 旧档自动升级，v2 防御性归一化） */
export function bootstrapCourt() {
  return (dispatch: AppDispatch, getState: () => RootState) => {
    if (getState().court.initialized) return;
    // 直接走 migrate，覆盖旧档 { evidence: [...] } 形态
    const { baseline, migrated } = migrate(
      (() => { try { return JSON.parse(localStorage.getItem("pair-wise-yf-49/court") ?? "null"); } catch { return null; } })(),
      seedBaseline()
    );
    dispatch(bootstrap({ baseline, migrated }));
    if (migrated) saveRemoteBaseline(baseline);
  };
}

/** 重连：拉取远端基线，按修订号回放本地离线提交 */
export function goOnline() {
  return (dispatch: AppDispatch, getState: () => RootState) => {
    const root = getState().court;
    if (!root.online) {
      const remote = loadRemoteBaseline(seedBaseline());
      const merged = reconcile(remote, root.pendingCommits);
      saveRemoteBaseline(merged.baseline);
      dispatch(reconciled({
        baseline: merged.baseline,
        report: { remoteRevision: merged.remoteRevision, applied: merged.applied, skipped: merged.skipped, rejected: merged.rejected }
      }));
    } else {
      dispatch(setOnline(true));
    }
  };
}

export function goOffline() {
  return (dispatch: AppDispatch) => dispatch(setOnline(false));
}

/**
 * 模拟“对端屏”在离线期间写入远端：
 * 用于演示操作屏与公开屏断线后同时提交，重连按修订号合并、旧修订不倒覆盖。
 * 支持三种典型对端动作：重排顺序 / 完成当前质证 / 对当前证据提异议。
 */
export function simulateRemote(kind: "reorder" | "complete" | "objection") {
  return (dispatch: AppDispatch): SubmitOutcome => {
    const remote = loadRemoteBaseline(seedBaseline());
    let payload: CommitPayload;
    let actor: Actor;
    let working = remote;
    if (kind === "reorder") {
      actor = { role: "书记员" };
      // 已播项不动，未展示项整体前移一位（模拟对端改变证据顺序）
      const played = remote.evidence.filter((e) => e.status === "已展示" || e.status === "已跳过");
      const pending = remote.evidence.filter((e) => !played.includes(e));
      const rotated = [...pending.slice(1), ...pending.slice(0, 1)];
      const ids: string[] = [];
      let pi = 0;
      remote.evidence.forEach((e) => { ids.push(played.some((p) => p.id === e.id) ? e.id : rotated[pi++].id); });
      payload = { kind: "reorder", order: ids };
    } else if (kind === "complete") {
      actor = { role: "法官" };
      const current = remote.evidence.find((e) => e.id === remote.currentEvidenceId);
      if (!current) return { ok: false, reason: "对端当前无选中证据" };
      if (current.status === "待展示") {
        // 对端先开始展示，再完成，形成两条顺序提交
        const shown = applyCommit(remote, makeCommit(actor, remote.revision, { kind: "show", evidenceId: current.id }));
        if (shown.outcome !== "applied") return { ok: false, outcome: shown.outcome, reason: shown.reason };
        working = shown.baseline;
      }
      payload = { kind: "complete", evidenceId: current.id };
    } else {
      const current = remote.evidence.find((e) => e.id === remote.currentEvidenceId);
      if (!current) return { ok: false, reason: "对端当前无选中证据" };
      if (current.presenter === "被告") return { ok: false, reason: "当前为被告证据，被告代理人不能对本方证据提异议" };
      actor = { role: "代理人", party: "被告" };
      payload = { kind: "objection", evidenceId: current.id, ground: "真实性异议", explanation: "对端屏离线提交：质疑该证据形成过程的真实性，请法庭审查。" };
    }
    const commit = makeCommit(actor, working.revision, payload);
    const result = applyCommit(working, commit);
    if (result.outcome === "rejected") return { ok: false, outcome: "rejected", reason: result.reason };
    saveRemoteBaseline(result.baseline);
    dispatch(remoteQueued(`${commitLabel(payload.kind)}（对端 r${result.baseline.revision}），待本屏重连合并`));
    return { ok: true, outcome: result.outcome, reason: result.reason };
  };
}

/** 恢复快照：仅法官/书记员，恢复后以恢复基线为新的协同基线 */
export function restoreSnapshot(id: string) {
  return (dispatch: AppDispatch, getState: () => RootState): SubmitOutcome => {
    const root = getState().court;
    const record = root.snapshots.find((s) => s.id === id);
    if (!record) return { ok: false, reason: "快照不存在" };
    if (root.actor.role === "代理人") {
      dispatch(rejectCommit({ actor: root.actor, label: "恢复庭审快照", reason: "代理人无权恢复庭审快照" }));
      return { ok: false, outcome: "rejected", reason: "代理人无权恢复庭审快照" };
    }
    dispatch(restore(id));
    const baseline = getState().court.baseline;
    saveRemoteBaseline(baseline);
    return { ok: true };
  };
}

/* ============================ 语义化便捷方法 ============================ */

export const reorderEvidence = (order: string[]) => submitCommit({ kind: "reorder", order });
export const selectEvidence = (evidenceId: string) => submitCommit({ kind: "select", evidenceId });
export const showEvidence = (evidenceId: string) => submitCommit({ kind: "show", evidenceId });
export const completeEvidence = (evidenceId: string) => submitCommit({ kind: "complete", evidenceId });
export const setSensitive = (evidenceId: string, sensitive: boolean) => submitCommit({ kind: "sensitive", evidenceId, sensitive });
export const raiseObjection = (objection: { evidenceId: string; ground: string; explanation: string }) =>
  submitCommit({ kind: "objection", ...objection });
export const resolveObjection = (id: string, status: "支持" | "驳回") =>
  submitCommit({ kind: "resolve", id, status });
export const changePhase = (phase: SessionPhase) => submitCommit({ kind: "phase", phase });
export const reviewEvidence = (evidenceId: string) => submitCommit({ kind: "review", evidenceId });

/** 供 UI 展示提交详情 */
export function describeCommit(payload: CommitPayload, baseline: Baseline) {
  return commitDetail(payload, baseline);
}
