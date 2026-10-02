import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { CourtSnapshot, Evidence, Objection, OpKind, Party, Role, SessionPhase, SessionState, TimelineEntry } from "../types";

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定", order: 0, pendingReview: false },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩", order: 1, pendingReview: false },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45", order: 2, pendingReview: false }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制", role: "法官", party: "原告" };

interface SnapshotPoint {
  id: string;
  label: string;
  time: string;
  evidence: Evidence[];
  phase: SessionPhase;
  currentEvidenceId: string | null;
}

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: SnapshotPoint[];
  session: SessionState;
  online: boolean;
  /** 设备本地角色，不随快照同步 */
  role: Role;
  /** 当前修订号（基线最新修订） */
  revision: number;
  /** 最近一次已同步的修订号（提交基线） */
  syncedRevision: number;
  syncStatus: "synced" | "dirty" | "offline";
  /** 最近一次已同步快照：提交失败时回滚 */
  lastSynced: CourtSnapshot | null;
  /** 距上次同步累积的操作，提交时随快照上送 */
  pendingOps: OpKind[];
  /** 本地修改计数：提交期间又有修改时保留本地状态，避免被成功回调覆盖 */
  dirtySeq: number;
  lastError: string | null;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  session: seedSession,
  online: true,
  role: "法官",
  revision: 0,
  syncedRevision: 0,
  syncStatus: "synced",
  lastSynced: null,
  pendingOps: [],
  dirtySeq: 0,
  lastError: null,
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

function currentItem(state: State): Evidence | undefined {
  return state.evidence.find((item) => item.id === state.session.currentEvidenceId);
}

/** 记录一次待同步操作；离线时不提交，联网后按修订号合并 */
function markDirty(state: State, op: OpKind) {
  if (!state.pendingOps.includes(op)) state.pendingOps.push(op);
  state.dirtySeq += 1;
  state.syncStatus = state.online ? "dirty" : "offline";
}

/** 将基线快照应用到状态（角色/方/操作模式为设备本地设置，不覆盖） */
function applySnapshot(state: State, snapshot: CourtSnapshot) {
  state.evidence = structuredClone(snapshot.evidence);
  state.objections = structuredClone(snapshot.objections);
  state.timeline = structuredClone(snapshot.timeline);
  state.session.phase = snapshot.session.phase;
  state.session.currentEvidenceId = snapshot.session.currentEvidenceId;
  state.session.timerSeconds = snapshot.session.timerSeconds;
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<CourtSnapshot>) {
      if (state.initialized) return;
      const snapshot = action.payload;
      applySnapshot(state, snapshot);
      state.revision = snapshot.revision;
      state.syncedRevision = snapshot.revision;
      state.lastSynced = snapshot;
      state.pendingOps = [];
      state.syncStatus = "synced";
      state.initialized = true;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
      state.syncStatus = action.payload ? (state.pendingOps.length ? "dirty" : "synced") : "offline";
    },
    setRole(state, action: PayloadAction<Role>) { state.role = action.payload; },
    setParty(state, action: PayloadAction<Party>) { state.session.party = action.payload; },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      // 顺序一变：未展示项按新顺序排队，计时按当前证据重算；已展示留痕标待复核
      state.evidence = action.payload.map((item, index) => ({
        ...item,
        order: index,
        pendingReview: item.status === "已展示" ? true : item.pendingReview,
      }));
      const current = currentItem(state);
      state.session.timerSeconds = (current?.duration ?? 0) * 60;
      addEntry(state, "书记员", "调整证据顺序", "未展示项重新排队并重算计时，已展示留痕标记待复核");
      markDirty(state, "reorder");
    },
    selectEvidence(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      state.session.currentEvidenceId = item.id;
      state.session.timerSeconds = item.duration * 60;
      addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`);
      markDirty(state, "select");
    },
    showEvidence(state) {
      const item = currentItem(state);
      if (!item) return;
      item.status = "展示中";
      state.session.phase = "质证";
      addEntry(state, item.presenter, "开始展示", item.title);
      markDirty(state, "show");
    },
    completeEvidence(state) {
      const item = currentItem(state);
      if (!item) return;
      item.status = "已展示";
      const next = state.evidence.find((entry) => entry.status === "待展示");
      state.session.currentEvidenceId = next?.id ?? null;
      state.session.timerSeconds = (next?.duration ?? 0) * 60;
      state.session.phase = next ? "举证" : "休庭";
      addEntry(state, "审判庭", "完成质证", item.title);
      markDirty(state, "complete");
    },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.sensitive = !item.sensitive;
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
      markDirty(state, "sensitive");
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId);
      state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() });
      state.session.phase = "质证";
      addEntry(state, state.session.party, "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`);
      markDirty(state, "addObjection");
    },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) {
      const objection = state.objections.find((entry) => entry.id === action.payload.id);
      if (!objection) return;
      objection.status = action.payload.status;
      const item = state.evidence.find((entry) => entry.id === objection.evidenceId);
      if (action.payload.status === "支持" && item) {
        item.status = "已跳过";
        addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`);
      } else {
        addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证");
      }
      markDirty(state, "resolveObjection");
    },
    snapshot(state, action: PayloadAction<string>) {
      state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId });
      state.snapshots = state.snapshots.slice(0, 10);
      markDirty(state, "snapshot");
    },
    restore(state, action: PayloadAction<string>) {
      const snapshot = state.snapshots.find((entry) => entry.id === action.payload);
      if (!snapshot) return;
      state.evidence = structuredClone(snapshot.evidence);
      state.session.phase = snapshot.phase;
      state.session.currentEvidenceId = snapshot.currentEvidenceId;
      addEntry(state, "审判庭", "恢复庭审快照", snapshot.label);
      markDirty(state, "restore");
    },
    tick(state) {
      if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1;
    },
    setPhase(state, action: PayloadAction<SessionPhase>) {
      state.session.phase = action.payload;
      addEntry(state, "审判庭", "切换庭审阶段", action.payload);
      markDirty(state, "phase");
    },
    /** 提交成功：以基线返回快照为准；提交期间又有本地修改则保留本地状态，待下次合并 */
    commitSucceeded(state, action: PayloadAction<{ snapshot: CourtSnapshot; committedSeq: number }>) {
      const { snapshot, committedSeq } = action.payload;
      if (state.dirtySeq === committedSeq) {
        applySnapshot(state, snapshot);
        state.pendingOps = [];
        state.syncStatus = "synced";
      } else {
        state.syncStatus = "dirty";
      }
      state.revision = snapshot.revision;
      state.syncedRevision = snapshot.revision;
      state.lastSynced = snapshot;
      state.lastError = null;
    },
    /** 提交被拒（越权/冲突）：回滚到最近基线，旧修订不倒着覆盖 */
    commitRejected(state, action: PayloadAction<{ error: string; snapshot?: CourtSnapshot }>) {
      const fallback = action.payload.snapshot ?? state.lastSynced;
      if (fallback) {
        applySnapshot(state, fallback);
        state.revision = fallback.revision;
        state.syncedRevision = fallback.revision;
        state.lastSynced = fallback;
      }
      state.pendingOps = [];
      state.syncStatus = "synced";
      state.lastError = action.payload.error;
    },
    clearError(state) { state.lastError = null; },
  }
});

export const {
  initialize, setOnline, setRole, setParty, setMode, reorder, selectEvidence, showEvidence, completeEvidence,
  toggleSensitive, addObjection, resolveObjection, snapshot, restore, tick, setPhase,
  commitSucceeded, commitRejected, clearError,
} = slice.actions;
export default slice.reducer;
