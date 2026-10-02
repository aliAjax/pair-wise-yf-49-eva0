export type Party = "原告" | "被告" | "审判庭";
export type Role = "法官" | "书记员" | "代理人";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

/** 当前操作人：代理人必须归属一方 */
export interface Actor {
  role: Role;
  party?: Party;
}

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  /** 举证方在庭审中的角色：原/被告为代理人，审判庭为法官（旧数据迁移时补齐） */
  presenterRole: Role;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
  /** 该证据最后一次变更所对应的修订号，用于旧修订不倒覆盖 */
  revision: number;
  /** 首次展示时间（旧数据按首次展示顺序补齐） */
  shownAt: string | null;
  /** 顺序在展示后发生变化，已展示留痕并标记待复核 */
  needsReview: boolean;
}

export interface Objection {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回";
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员" | "法官";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}

/** 协同提交类型，与庭审权限矩阵对应 */
export type CommitKind =
  | "reorder" | "select" | "show" | "complete" | "sensitive"
  | "objection" | "resolve" | "phase" | "review";

export type CommitPayload =
  | { kind: "reorder"; order: string[] }
  | { kind: "select"; evidenceId: string }
  | { kind: "show"; evidenceId: string }
  | { kind: "complete"; evidenceId: string }
  | { kind: "sensitive"; evidenceId: string; sensitive: boolean }
  | { kind: "objection"; evidenceId: string; ground: string; explanation: string }
  | { kind: "resolve"; id: string; status: "支持" | "驳回" }
  | { kind: "phase"; phase: SessionPhase }
  | { kind: "review"; evidenceId: string };

/** 一次带修订号的协同提交（操作屏 / 公开屏重连时按它回放合并） */
export interface Commit {
  id: string;
  kind: CommitKind;
  baseRevision: number;
  actor: Actor;
  payload: CommitPayload;
  at: string;
}

/** 各业务域各自记录修订号，旧修订只能在未被新修订触碰的域内生效 */
export interface DomainRevision {
  order: number;
  playback: number;
  mask: number;
  phase: number;
}

/** 庭审快照协同基线 */
export interface Baseline {
  revision: number;
  domainRev: DomainRevision;
  evidence: Evidence[];
  objections: Objection[];
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
}

export interface MergeReport {
  id: string;
  time: string;
  remoteRevision: number;
  applied: string[];
  skipped: string[];
  rejected: { detail: string; reason: string }[];
}
