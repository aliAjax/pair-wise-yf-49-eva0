import type {
  CourtSnapshot,
  Evidence,
  EvidenceStatus,
  Objection,
  OpKind,
  Role,
  SessionPhase,
  TimelineEntry,
} from "../types";

const HUB_KEY = "pair-wise-yf-49/court";

/** 各角色可处理的操作：越权提交一律拒绝 */
export const ROLE_PERMISSIONS: Record<Role, OpKind[]> = {
  法官: ["select", "show", "complete", "sensitive", "phase", "resolveObjection", "restore"],
  书记员: ["reorder", "snapshot", "restore"],
  代理人: ["addObjection"],
};

export const OP_LABEL: Record<OpKind, string> = {
  select: "选中证据",
  show: "开始展示",
  complete: "完成并切换下一条",
  sensitive: "敏感内容遮罩",
  reorder: "调整证据顺序",
  phase: "切换庭审阶段",
  addObjection: "提出异议",
  resolveObjection: "异议裁定",
  snapshot: "保存快照",
  restore: "恢复快照",
};

/** 状态只允许正向推进：待展示 < 展示中 < 已展示/已跳过，旧修订不能把已播内容退回未展示 */
const STATUS_RANK: Record<EvidenceStatus, number> = {
  待展示: 0,
  展示中: 1,
  已跳过: 2,
  已展示: 2,
};

function seedEvidence(): Evidence[] {
  return [
    { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定", order: 0, pendingReview: false },
    { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩", order: 1, pendingReview: false },
    { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45", order: 2, pendingReview: false },
  ];
}

function seedObjections(): Objection[] {
  return [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }];
}

function seedTimeline(): TimelineEntry[] {
  return [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }];
}

function seedSession(): CourtSnapshot["session"] {
  return { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60 };
}

function seedSnapshot(): CourtSnapshot {
  return { revision: 0, evidence: seedEvidence(), objections: seedObjections(), timeline: seedTimeline(), session: seedSession(), savedAt: new Date().toISOString() };
}

/** 补齐单条证据的缺失字段（旧数据升级） */
function normalizeEvidence(raw: Partial<Evidence>, index: number): Evidence {
  return {
    id: raw.id ?? crypto.randomUUID(),
    exhibitNo: raw.exhibitNo ?? "",
    title: raw.title ?? "",
    type: raw.type ?? "书证",
    duration: raw.duration ?? 0,
    presenter: raw.presenter ?? "审判庭",
    sensitive: raw.sensitive ?? false,
    status: raw.status ?? "待展示",
    note: raw.note ?? "",
    order: typeof raw.order === "number" ? raw.order : index,
    pendingReview: raw.pendingReview ?? false,
  };
}

function normalizeSnapshot(raw: Partial<CourtSnapshot>): CourtSnapshot {
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map((item, i) => normalizeEvidence(item, i)) : seedEvidence();
  const session = raw.session ?? seedSession();
  return {
    revision: typeof raw.revision === "number" ? raw.revision : 0,
    evidence,
    objections: Array.isArray(raw.objections) ? raw.objections : seedObjections(),
    timeline: Array.isArray(raw.timeline) ? raw.timeline : seedTimeline(),
    session: {
      phase: session.phase ?? "举证",
      currentEvidenceId: session.currentEvidenceId ?? evidence[0]?.id ?? null,
      timerSeconds: typeof session.timerSeconds === "number" ? session.timerSeconds : (evidence[0]?.duration ?? 0) * 60,
    },
    savedAt: raw.savedAt ?? new Date().toISOString(),
  };
}

/** 旧格式数据（无修订号）升级：仍能打开，缺失字段在首次展示时补齐 */
function migrateLegacy(raw: Record<string, unknown>): CourtSnapshot {
  const evidence = Array.isArray(raw.evidence)
    ? (raw.evidence as Partial<Evidence>[]).map((item, i) => normalizeEvidence(item, i))
    : seedEvidence();
  const session = seedSession();
  session.currentEvidenceId = evidence[0]?.id ?? null;
  session.timerSeconds = (evidence[0]?.duration ?? 0) * 60;
  return {
    revision: 0,
    evidence,
    objections: Array.isArray(raw.objections) ? (raw.objections as Objection[]) : seedObjections(),
    timeline: seedTimeline(),
    session,
    savedAt: new Date().toISOString(),
  };
}

export function loadHub(): CourtSnapshot {
  try {
    const raw = localStorage.getItem(HUB_KEY);
    if (!raw) return seedSnapshot();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && typeof parsed.revision === "number" && Array.isArray(parsed.evidence)) {
      return normalizeSnapshot(parsed as Partial<CourtSnapshot>);
    }
    // 旧数据：只有 evidence，没有修订号与角色字段
    return migrateLegacy(parsed);
  } catch {
    return seedSnapshot();
  }
}

function saveHub(snapshot: CourtSnapshot): void {
  localStorage.setItem(HUB_KEY, JSON.stringify(snapshot));
}

export interface CommitRequest {
  /** 提交方所依据的基线修订号 */
  baseRevision: number;
  /** 提交方所依据的基线快照（三路合并用） */
  baseSnapshot: CourtSnapshot;
  /** 提交方本地快照 */
  snapshot: CourtSnapshot;
  /** 本次提交包含的操作（用于权限校验） */
  ops: OpKind[];
  /** 提交方角色 */
  role: Role;
}

export type CommitResult =
  | { ok: true; snapshot: CourtSnapshot }
  | { ok: false; code: "FORBIDDEN" | "CONFLICT"; error: string; snapshot?: CourtSnapshot };

/**
 * 三路合并：base 是共同祖先，client 是断线方快照，head 是基线最新快照。
 * 规则：
 * 1. 状态只进不退——已播内容（已展示/展示中）不会被旧修订退回未展示；
 * 2. 顺序按项三路合并——只有一方移动过的项采用该方位置，双方都动过则新修订（head）优先；
 * 3. 已展示留痕在顺序变更后标待复核；
 * 4. 异议/时间线只合并不回退；
 * 5. 合并后未展示项重新排队、计时按当前证据重算。
 */
function mergeSnapshots(base: CourtSnapshot, client: CourtSnapshot, head: CourtSnapshot, ops: OpKind[]): CourtSnapshot {
  const merged: CourtSnapshot = structuredClone(head);
  const baseById = new Map(base.evidence.map((e) => [e.id, e]));
  const mergedById = new Map(merged.evidence.map((e) => [e.id, e]));

  // 1) 合并断线方本地新增的证据项
  for (const item of client.evidence) {
    if (!mergedById.has(item.id)) {
      merged.evidence.push(normalizeEvidence(item, merged.evidence.length));
    }
  }
  const byId = new Map(merged.evidence.map((e) => [e.id, e]));

  // 2) 状态单调推进 + 待复核标记 sticky + 顺序三路合并
  const clientOnlyOrder = new Map<string, number>();
  for (const item of client.evidence) {
    const target = byId.get(item.id);
    if (!target) continue;
    if (STATUS_RANK[item.status] > STATUS_RANK[target.status]) target.status = item.status;
    if (item.pendingReview) target.pendingReview = true;
    const baseItem = baseById.get(item.id);
    const headItem = head.evidence.find((e) => e.id === item.id);
    if (baseItem && headItem && item.order !== baseItem.order && headItem.order === target.order) {
      // 只有断线方移动过该项，基线未动 → 采用断线方位置
      clientOnlyOrder.set(item.id, item.order);
    }
  }
  for (const [id, order] of clientOnlyOrder) {
    const target = byId.get(id);
    if (target) target.order = order;
  }
  // 重新排队，未展示项按新顺序重算位置
  merged.evidence.sort((a, b) => a.order - b.order);
  merged.evidence.forEach((item, index) => {
    item.order = index;
  });

  // 3) 顺序变更：已展示留痕标成待复核
  if (ops.includes("reorder")) {
    for (const item of merged.evidence) {
      if (item.status === "已展示") item.pendingReview = true;
    }
  }

  // 4) 异议只新增，状态以新修订为准（不回退）
  const objectionIds = new Set(merged.objections.map((o) => o.id));
  for (const objection of client.objections) {
    if (!objectionIds.has(objection.id)) merged.objections.push(structuredClone(objection));
  }

  // 5) 时间线只新增，按时间倒序
  const timelineIds = new Set(merged.timeline.map((t) => t.id));
  for (const entry of client.timeline) {
    if (!timelineIds.has(entry.id)) merged.timeline.push(structuredClone(entry));
  }
  merged.timeline.sort((a, b) => (a.time < b.time ? 1 : -1));

  // 6) 会话：展示中状态必须保留；当前证据已播则跳到下一条未展示（已播内容跳过），阶段以新修订为准
  const showing = merged.evidence.find((e) => e.status === "展示中");
  if (showing) {
    merged.session.currentEvidenceId = showing.id;
    merged.session.phase = "质证";
  } else {
    const current = merged.evidence.find((e) => e.id === merged.session.currentEvidenceId);
    if (!current || current.status === "已展示" || current.status === "已跳过") {
      const next = merged.evidence.find((e) => e.status === "待展示");
      merged.session.currentEvidenceId = next?.id ?? null;
      if (!next) merged.session.phase = "休庭";
    }
  }
  // 计时按当前证据重算
  const current = merged.evidence.find((e) => e.id === merged.session.currentEvidenceId);
  merged.session.timerSeconds = (current?.duration ?? 0) * 60;

  return merged;
}

/**
 * 提交入口：带修订号合并。
 * - 越权操作直接拒绝（FORBIDDEN），不落库；
 * - 基线等于最新修订：直接快进；
 * - 基线旧于最新修订：按修订号三路合并，旧修订不倒着覆盖；
 * - 基线新于最新修订：冲突拒绝。
 */
export function commitToHub(request: CommitRequest): CommitResult {
  const head = loadHub();
  const denied = [...new Set(request.ops)].filter((op) => !ROLE_PERMISSIONS[request.role].includes(op));
  if (denied.length) {
    return {
      ok: false,
      code: "FORBIDDEN",
      error: `越权提交已拒绝：${request.role} 无权执行「${denied.map((op) => OP_LABEL[op]).join("、")}」`,
      snapshot: head,
    };
  }

  let merged: CourtSnapshot;
  if (request.baseRevision === head.revision) {
    merged = structuredClone(request.snapshot);
  } else if (request.baseRevision < head.revision) {
    merged = mergeSnapshots(request.baseSnapshot, request.snapshot, head, request.ops);
  } else {
    return { ok: false, code: "CONFLICT", error: "提交基线新于当前基线，请刷新后重试", snapshot: head };
  }

  merged.revision = head.revision + 1;
  merged.savedAt = new Date().toISOString();
  saveHub(merged);
  return { ok: true, snapshot: merged };
}

/** 由应用状态构造待提交快照 */
export function buildSnapshot(input: {
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  session: Pick<SessionStateLike, "phase" | "currentEvidenceId" | "timerSeconds">;
}): CourtSnapshot {
  return {
    revision: 0,
    evidence: structuredClone(input.evidence),
    objections: structuredClone(input.objections),
    timeline: structuredClone(input.timeline),
    session: { ...input.session },
    savedAt: new Date().toISOString(),
  };
}

type SessionStateLike = { phase: SessionPhase; currentEvidenceId: string | null; timerSeconds: number };
