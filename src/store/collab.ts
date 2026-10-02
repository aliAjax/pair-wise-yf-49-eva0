import type {
  Actor, Baseline, Commit, CommitKind, CommitPayload, Evidence, EvidenceStatus,
  Role, SessionPhase, TimelineEntry
} from "../types";

/* ============================ 常量与工具 ============================ */

const STORAGE_KEY = "pair-wise-yf-49/court";
const STORAGE_VERSION = 2;
/** 旧档迁移锚点：旧数据没有首次展示时间，按该锚点加序补齐 */
export const LEGACY_ANCHOR = "2026-01-01T09:00:00.000Z";

const PLAYED: EvidenceStatus[] = ["已展示", "已跳过"];
export const isPlayed = (status: EvidenceStatus) => PLAYED.includes(status);

export function nextRevision(b: Baseline) { return b.revision + 1; }
export function findEvidence(b: Baseline, id: string | null) {
  return id ? b.evidence.find((e) => e.id === id) : undefined;
}
export function firstPending(b: Baseline) {
  return b.evidence.find((e) => e.status === "待展示");
}

/* ============================ 权限矩阵 ============================ */
/**
 * 法官：阶段控制、完成质证、异议裁定、已展示留痕复核
 * 书记员：证据顺序、敏感遮罩、阶段流程（不参与实质质证）
 * 代理人：仅能操作本方证据的展示，只能对对对方证据提出异议
 */
const ALLOWED: Record<CommitKind, Role[]> = {
  reorder: ["书记员"],
  select: ["法官", "书记员", "代理人"],
  show: ["法官", "书记员", "代理人"],
  complete: ["法官", "书记员"],
  sensitive: ["书记员"],
  objection: ["代理人"],
  resolve: ["法官"],
  phase: ["法官", "书记员"],
  review: ["法官"]
};

export type CheckResult = { ok: true } | { ok: false; reason: string };

export function checkPermission(actor: Actor, kind: CommitKind, evidence?: Evidence): CheckResult {
  if (!ALLOWED[kind].includes(actor.role)) {
    return { ok: false, reason: `${actor.role}无权执行「${commitLabel(kind)}」，越权提交已拒绝` };
  }
  if (actor.role === "代理人") {
    if (!actor.party || actor.party === "审判庭") {
      return { ok: false, reason: "代理人未归属原告或被告，操作已拒绝" };
    }
    if ((kind === "select" || kind === "show") && evidence && evidence.presenter !== actor.party) {
      return { ok: false, reason: `代理人只能操作本方（${actor.party}）证据，${evidence.exhibitNo} 属于${evidence.presenter}` };
    }
    if (kind === "objection" && evidence && evidence.presenter === actor.party) {
      return { ok: false, reason: "只能对对方证据提出异议，不能对本方证据提出异议" };
    }
  }
  return { ok: true };
}

export function commitLabel(kind: CommitKind): string {
  return {
    reorder: "调整证据顺序", select: "切换展示证据", show: "开始展示", complete: "完成质证",
    sensitive: "敏感遮罩", objection: "提出异议", resolve: "异议裁定", phase: "切换庭审阶段", review: "复核确认"
  }[kind];
}

export function actorLabel(actor: Actor): TimelineEntry["actor"] {
  if (actor.role === "书记员") return "书记员";
  if (actor.role === "法官") return "法官";
  return actor.party ?? "审判庭";
}

export function commitDetail(payload: CommitPayload, b: Baseline): string {
  switch (payload.kind) {
    case "reorder": return `按修订顺序重排 ${payload.order.length} 项证据`;
    case "select":
    case "sensitive":
    case "show":
    case "complete":
    case "review": {
      const e = findEvidence(b, payload.evidenceId);
      return e ? `${e.exhibitNo} ${e.title}` : payload.evidenceId;
    }
    case "objection": {
      const e = findEvidence(b, payload.evidenceId);
      return `${e?.exhibitNo ?? payload.evidenceId} ${payload.ground}`;
    }
    case "resolve": {
      const o = b.objections.find((x) => x.id === payload.id);
      const e = o ? findEvidence(b, o.evidenceId) : undefined;
      return payload.status === "支持" ? `${e?.exhibitNo ?? ""} 异议成立，暂不展示` : `${e?.title ?? "证据"} 异议驳回，继续质证`;
    }
    case "phase": return `切换为${payload.phase}阶段`;
  }
}

/* ============================ 顺序合并 ============================ */
/**
 * 已展示/已跳过的证据锚定在当前位置（已播内容留痕，不被重排倒动）；
 * 未展示项按新提交的顺序填入空位；遗漏项按当前顺序补齐。
 */
export function mergeOrder(current: Evidence[], order: string[]): Evidence[] {
  const byId = new Map(current.map((e) => [e.id, e]));
  const playedSet = new Set(current.filter((e) => isPlayed(e.status)).map((e) => e.id));
  const slots: (Evidence | undefined)[] = current.map((e) => (playedSet.has(e.id) ? e : undefined));
  const place = (e: Evidence) => {
    const i = slots.findIndex((s) => s === undefined);
    if (i >= 0) slots[i] = e; else slots.push(e);
  };
  for (const id of order) {
    if (playedSet.has(id)) continue;
    const e = byId.get(id);
    if (e) place(e);
  }
  for (const e of current) {
    if (!playedSet.has(e.id) && !slots.includes(e)) place(e);
  }
  for (const e of byId.values()) {
    if (!slots.includes(e)) place(e);
  }
  return slots.filter((e): e is Evidence => Boolean(e));
}

/** 顺序变化后重算未展示项与计时：展示中的保留现场，否则指向第一条待展示并重设计时 */
function recomputeAfterOrder(b: Baseline): Baseline {
  const current = findEvidence(b, b.currentEvidenceId);
  if (current && !isPlayed(current.status) && current.status === "展示中") return b;
  const next = firstPending(b);
  return { ...b, currentEvidenceId: next?.id ?? null, timerSeconds: (next?.duration ?? 0) * 60 };
}

/* ============================ 提交应用 ============================ */

export interface ApplyResult {
  baseline: Baseline;
  outcome: "applied" | "skipped" | "rejected";
  reason?: string;
  event?: { actor: TimelineEntry["actor"]; action: string; detail: string };
}

const applied = (baseline: Baseline, event: ApplyResult["event"]): ApplyResult => ({ baseline, outcome: "applied", event });
const skipped = (baseline: Baseline, reason: string): ApplyResult => ({ baseline, outcome: "skipped", reason });
const rejected = (baseline: Baseline, reason: string): ApplyResult => ({ baseline, outcome: "rejected", reason });

/** 在给定基线上回放一条带修订号的提交。纯函数，不碰存储。 */
export function applyCommit(input: Baseline, commit: Commit): ApplyResult {
  const p = commit.payload;
  const evidence =
    p.kind === "select" || p.kind === "sensitive" || p.kind === "objection" ||
    p.kind === "review" || p.kind === "show" || p.kind === "complete"
      ? findEvidence(input, p.evidenceId)
      : findEvidence(input, input.currentEvidenceId);
  const perm = checkPermission(commit.actor, p.kind, evidence);
  if (!perm.ok) return rejected(input, perm.reason);

  const rev = nextRevision(input);
  const actor = actorLabel(commit.actor);
  const label = commitLabel(p.kind);
  const bump = (e: Evidence | undefined): Evidence | undefined => e ? { ...e, revision: rev } : e;
  let b: Baseline = { ...input, revision: rev };

  switch (p.kind) {
    case "reorder": {
      // 旧修订不能倒着覆盖：顺序域已有更新修订则整单跳过
      if (input.domainRev.order > commit.baseRevision) {
        return skipped(input, `顺序已有更新修订（r${input.domainRev.order}），基于 r${commit.baseRevision} 的旧提交不倒覆盖`);
      }
      const known = new Set(input.evidence.map((e) => e.id));
      if (p.order.length !== input.evidence.length || p.order.some((id) => !known.has(id))) {
        return rejected(input, "顺序清单与当前证据目录不一致，提交被拒绝");
      }
      // 已展示留痕：顺序一变，已展示/已跳过项标记待复核（法官后续确认）
      const reviewed = input.evidence.map((e) =>
        isPlayed(e.status) && !e.needsReview ? { ...e, needsReview: true, revision: rev } : e);
      b = {
        ...b,
        evidence: mergeOrder(reviewed, p.order),
        domainRev: { ...b.domainRev, order: rev },
        phase: input.phase
      };
      b = recomputeAfterOrder(b);
      const reviewCount = reviewed.filter((e) => e.needsReview).length;
      return applied(b, { actor, action: label, detail: `重排 ${p.order.length} 项，未展示项与计时已重算；${reviewCount} 项已展示留痕待复核` });
    }

    case "select": {
      if (!evidence) return rejected(input, "目标证据不存在");
      if (isPlayed(evidence.status)) return skipped(input, `${evidence.exhibitNo} 已播放，已播内容跳过`);
      if (input.domainRev.playback > commit.baseRevision) {
        return skipped(input, `展示进程已有更新修订（r${input.domainRev.playback}），旧选择不倒覆盖`);
      }
      b = {
        ...b,
        currentEvidenceId: evidence.id,
        timerSeconds: evidence.duration * 60,
        domainRev: { ...b.domainRev, playback: rev },
        evidence: b.evidence.map((e) => e.id === evidence.id ? { ...e, revision: rev } : e)
      };
      return applied(b, { actor, action: label, detail: `${evidence.exhibitNo} ${evidence.title}` });
    }

    case "show": {
      // 提交绑定具体证据：重连重放时即使指针因对端重排漂移，仍作用于原目标
      const target = evidence;
      if (!target) return rejected(input, "目标证据不存在，无法开始展示");
      if (isPlayed(target.status)) return skipped(input, `${target.exhibitNo} 已播放，已播内容跳过`);
      if (target.status === "展示中") return skipped(input, `${target.exhibitNo} 正在展示中，重复提交跳过`);
      if (input.domainRev.playback > commit.baseRevision) {
        return skipped(input, `展示进程已有更新修订（r${input.domainRev.playback}），旧展示请求不倒覆盖`);
      }
      b = {
        ...b,
        phase: "质证",
        currentEvidenceId: target.id,
        domainRev: { ...b.domainRev, playback: rev },
        evidence: b.evidence.map((e) =>
          e.id === target.id ? { ...e, status: "展示中" as EvidenceStatus, shownAt: commit.at, revision: rev } : e)
      };
      return applied(b, { actor, action: label, detail: target.title });
    }

    case "complete": {
      const target = evidence;
      if (!target) return rejected(input, "目标证据不存在，无法完成质证");
      if (isPlayed(target.status)) return skipped(input, `${target.exhibitNo} 已播放，已播内容跳过`);
      if (target.status !== "展示中") return rejected(input, `${target.exhibitNo} 尚未开始展示，不能完成质证`);
      if (input.domainRev.playback > commit.baseRevision) {
        return skipped(input, `展示进程已有更新修订（r${input.domainRev.playback}），旧完成请求不倒覆盖`);
      }
      const withDone = b.evidence.map((e) =>
        e.id === target.id ? { ...e, status: "已展示" as EvidenceStatus, shownAt: e.shownAt ?? commit.at, revision: rev } : e);
      b = { ...b, evidence: withDone, domainRev: { ...b.domainRev, playback: rev } };
      const next = b.evidence.find((e) => e.status === "待展示");
      b = {
        ...b,
        currentEvidenceId: next?.id ?? null,
        timerSeconds: (next?.duration ?? 0) * 60,
        phase: next ? "举证" : "休庭"
      };
      if (next) b.evidence = b.evidence.map((e) => e.id === next.id ? { ...e, revision: rev } : e);
      return applied(b, { actor, action: label, detail: target.title });
    }

    case "sensitive": {
      if (!evidence) return rejected(input, "目标证据不存在");
      if (input.domainRev.mask > commit.baseRevision) {
        return skipped(input, `遮罩已有更新修订（r${input.domainRev.mask}），旧修订不倒覆盖`);
      }
      b = {
        ...b,
        domainRev: { ...b.domainRev, mask: rev },
        evidence: b.evidence.map((e) =>
          e.id === evidence.id ? { ...e, sensitive: p.sensitive, revision: rev } : e)
      };
      return applied(b, { actor, action: p.sensitive ? "隐藏敏感内容" : "恢复公开内容", detail: evidence.title });
    }

    case "objection": {
      if (!evidence) return rejected(input, "目标证据不存在");
      const objection = {
        id: commit.id, evidenceId: evidence.id, ground: p.ground,
        explanation: p.explanation, status: "待裁定" as const, createdAt: commit.at
      };
      b = { ...b, phase: "质证", objections: [objection, ...b.objections] };
      return applied(b, { actor, action: label, detail: `${evidence.exhibitNo} ${p.ground}` });
    }

    case "resolve": {
      const objection = b.objections.find((x) => x.id === p.id);
      if (!objection) return skipped(input, "异议不存在，可能已被对端处理");
      if (objection.status !== "待裁定") return skipped(input, `异议已${objection.status}，重复裁定跳过`);
      if (input.domainRev.playback > commit.baseRevision) {
        return skipped(input, `展示进程已有更新修订（r${input.domainRev.playback}），旧裁定不倒覆盖`);
      }
      const target = findEvidence(input, objection.evidenceId);
      b = {
        ...b,
        objections: b.objections.map((o) => o.id === p.id ? { ...o, status: p.status } : o),
        domainRev: { ...b.domainRev, playback: rev }
      };
      if (p.status === "支持" && target) {
        b.evidence = b.evidence.map((e) =>
          e.id === target.id ? { ...e, status: "已跳过" as EvidenceStatus, shownAt: e.shownAt ?? commit.at, revision: rev } : e);
      }
      // 跳过后当前指针若指向它，重算未展示项与计时
      const current = findEvidence(b, b.currentEvidenceId);
      if (!current || isPlayed(current.status)) {
        const next = firstPending(b);
        b = { ...b, currentEvidenceId: next?.id ?? null, timerSeconds: (next?.duration ?? 0) * 60 };
      }
      return applied(b, {
        actor, action: p.status === "支持" ? "异议成立" : "异议驳回",
        detail: p.status === "支持" ? `${target?.exhibitNo ?? ""} 暂不展示` : `${target?.title ?? "继续质证"}`
      });
    }

    case "phase": {
      if (input.domainRev.phase > commit.baseRevision) {
        return skipped(input, `庭审阶段已有更新修订（r${input.domainRev.phase}），旧修订不倒覆盖`);
      }
      b = { ...b, phase: p.phase, domainRev: { ...b.domainRev, phase: rev } };
      return applied(b, { actor, action: label, detail: `切换为${p.phase}阶段` });
    }

    case "review": {
      if (!evidence) return rejected(input, "目标证据不存在");
      if (evidence.status !== "已展示") return skipped(input, "仅已展示证据需要复核留痕");
      if (!evidence.needsReview) return skipped(input, `${evidence.exhibitNo} 无需复核`);
      b = { ...b, evidence: b.evidence.map((e) => e.id === evidence.id ? { ...e, needsReview: false, revision: rev } : e) };
      return applied(b, { actor, action: label, detail: `${evidence.exhibitNo} 展示留痕复核完成` });
    }
  }
}

/* ============================ 重连合并 ============================ */

export interface ReconcileResult {
  baseline: Baseline;
  applied: string[];
  skipped: string[];
  rejected: { detail: string; reason: string }[];
  remoteRevision: number;
}

/** 以远端基线为准，逐条回放本地离线期间的待同步提交 */
export function reconcile(remote: Baseline, pending: Commit[]): ReconcileResult {
  const result: ReconcileResult = {
    baseline: remote, applied: [], skipped: [], rejected: [], remoteRevision: remote.revision
  };
  for (const commit of pending) {
    const r = applyCommit(result.baseline, commit);
    result.baseline = r.baseline;
    const detail = commitDetail(commit.payload, result.baseline);
    if (r.outcome === "applied") result.applied.push(detail);
    else if (r.outcome === "skipped") result.skipped.push(`${detail}：${r.reason}`);
    else result.rejected.push({ detail, reason: r.reason ?? "未知原因" });
  }
  return result;
}

/* ============================ 旧数据迁移 ============================ */

interface LegacyEvidence {
  id: string; exhibitNo: string; title: string;
  type: Evidence["type"]; duration: number; presenter: Evidence["presenter"];
  sensitive?: boolean; status?: EvidenceStatus; note?: string;
}

function normalizeEvidence(raw: Partial<Evidence> & LegacyEvidence, shownSeq: number): Evidence {
  const status = raw.status ?? "待展示";
  const played = isPlayed(status);
  return {
    id: raw.id,
    exhibitNo: raw.exhibitNo,
    title: raw.title,
    type: raw.type,
    duration: raw.duration,
    presenter: raw.presenter,
    presenterRole: raw.presenterRole ?? (raw.presenter === "审判庭" ? "法官" : "代理人"),
    sensitive: raw.sensitive ?? false,
    status,
    note: raw.note ?? "",
    // 缺少修订号：已播放项按首次展示顺序补齐 1..n，未展示项为 0
    revision: typeof raw.revision === "number" ? raw.revision : played ? shownSeq : 0,
    // 缺少首次展示时间：按锚点 + 序号补齐
    shownAt: raw.shownAt ?? (played ? new Date(Date.parse(LEGACY_ANCHOR) + shownSeq * 60000).toISOString() : null),
    needsReview: raw.needsReview ?? false
  };
}

/** 防御性补齐：即使是新版本数据，也保证新字段存在 */
export function normalizeBaseline(raw: Partial<Baseline> | undefined, seed: Baseline): Baseline {
  if (!raw || !Array.isArray(raw.evidence) || !raw.evidence.length) return structuredClone(seed);
  let shownSeq = 0;
  const evidence = raw.evidence.map((e) => {
    const played = isPlayed((e.status ?? "待展示") as EvidenceStatus);
    if (played) shownSeq += 1;
    return normalizeEvidence(e as Partial<Evidence> & LegacyEvidence, shownSeq);
  });
  return {
    revision: typeof raw.revision === "number" ? raw.revision : shownSeq,
    domainRev: {
      order: raw.domainRev?.order ?? shownSeq,
      playback: raw.domainRev?.playback ?? shownSeq,
      mask: raw.domainRev?.mask ?? 0,
      phase: raw.domainRev?.phase ?? shownSeq
    },
    evidence,
    objections: Array.isArray(raw.objections) ? raw.objections : [],
    phase: (raw.phase ?? "举证") as SessionPhase,
    currentEvidenceId: raw.currentEvidenceId ?? evidence.find((e) => e.status === "待展示")?.id ?? null,
    timerSeconds: typeof raw.timerSeconds === "number" ? raw.timerSeconds : (evidence.find((e) => e.status === "待展示")?.duration ?? 0) * 60
  };
}

/**
 * 旧数据升级：
 * - v0：{ evidence: [...] }，缺少修订号、角色、首次展示字段 —— 仍能打开，按首次展示补齐
 * - v2：{ version: 2, baseline: {...} } —— 防御性归一化
 */
export function migrate(raw: unknown, seed: Baseline): { baseline: Baseline; migrated: boolean } {
  if (!raw || typeof raw !== "object") return { baseline: structuredClone(seed), migrated: false };
  const data = raw as Record<string, unknown>;
  if (Array.isArray(data.evidence)) {
    let shownSeq = 0;
    const evidence = (data.evidence as LegacyEvidence[]).map((e) => {
      const played = isPlayed(e.status ?? "待展示");
      if (played) shownSeq += 1;
      return normalizeEvidence(e, shownSeq);
    });
    const first = evidence.find((e) => e.status === "待展示");
    return {
      migrated: true,
      baseline: {
        revision: shownSeq,
        domainRev: { order: shownSeq, playback: shownSeq, mask: 0, phase: shownSeq },
        evidence,
        objections: [],
        phase: "举证",
        currentEvidenceId: first?.id ?? null,
        timerSeconds: (first?.duration ?? 0) * 60
      }
    };
  }
  if (data.baseline) {
    const baseline = normalizeBaseline(data.baseline as Partial<Baseline>, seed);
    const legacyEvidence = (data.baseline as Partial<Baseline>).evidence ?? [];
    const migrated = legacyEvidence.some((e) => typeof (e as Partial<Evidence>).revision !== "number" || !(e as Evidence).presenterRole);
    return { baseline, migrated };
  }
  return { baseline: structuredClone(seed), migrated: false };
}

/* ============================ localStorage 模拟协同存储 ============================ */

export function loadStored(): unknown {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function loadRemoteBaseline(seed: Baseline): Baseline {
  return migrate(loadStored(), seed).baseline;
}

export function saveRemoteBaseline(baseline: Baseline) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, baseline }));
}

let seq = 0;
export function makeCommit(actor: Actor, baseRevision: number, payload: CommitPayload): Commit {
  seq += 1;
  return {
    id: crypto.randomUUID(),
    kind: payload.kind,
    baseRevision,
    actor,
    payload,
    at: new Date(Date.now() + seq).toISOString()
  };
}
