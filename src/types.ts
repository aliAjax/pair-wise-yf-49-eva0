export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

/** 庭审角色：法官、书记员、代理人；公开屏为只读视图，不产生提交 */
export type Role = "法官" | "书记员" | "代理人";

/** 操作类型，用于权限校验与协同合并 */
export type OpKind =
  | "select"
  | "show"
  | "complete"
  | "sensitive"
  | "reorder"
  | "phase"
  | "addObjection"
  | "resolveObjection"
  | "snapshot"
  | "restore";

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
  /** 顺序号：协同合并时按号排队，重排后重算 */
  order: number;
  /** 已展示留痕在顺序变更后标记待复核 */
  pendingReview: boolean;
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
  actor: Party | "书记员";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
  /** 当前操作角色（设备本地设置，不随快照同步） */
  role: Role;
  /** 代理人所属方（role = 代理人 时生效） */
  party: Party;
}

/** 庭审协同基线：带修订号的不可变快照，提交与合并都以修订号为准 */
export interface CourtSnapshot {
  /** 修订号，单调递增；旧修订不得倒着覆盖 */
  revision: number;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  session: Pick<SessionState, "phase" | "currentEvidenceId" | "timerSeconds">;
  savedAt: string;
}
