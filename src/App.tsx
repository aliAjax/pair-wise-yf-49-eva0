import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline, Tooltip } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useCommitSnapshotMutation, useGetSnapshotQuery } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addObjection, clearError, commitRejected, commitSucceeded, completeEvidence, initialize,
  reorder, resolveObjection, restore, selectEvidence, setMode, setOnline, setParty, setPhase,
  setRole, showEvidence, snapshot, tick, toggleSensitive,
} from "./store/courtSlice";
import { buildSnapshot, OP_LABEL, ROLE_PERMISSIONS } from "./store/collab";
import type { Evidence, OpKind, Party, Role, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "法官", label: "法官" },
  { value: "书记员", label: "书记员" },
  { value: "代理人", label: "代理人" },
];
const PARTY_OPTIONS: { value: Party; label: string }[] = [
  { value: "原告", label: "原告代理人" },
  { value: "被告", label: "被告代理人" },
];

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  // 公开屏为只读视图；操作屏按角色权限禁用越权操作
  const can = (op: OpKind) => state.session.operatorMode === "庭审控制" && ROLE_PERMISSIONS[state.role].includes(op);
  const deniedTip = (op: OpKind) => can(op) ? undefined : `越权：${state.role} 无权「${OP_LABEL[op]}」`;

  return <div className="court-grid">
    <Card className="operator" title="证据操作台" extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Tooltip content={deniedTip("snapshot")}><span><Button size="small" onClick={() => dispatch(snapshot("手动存档"))} disabled={!can("snapshot")}>保存快照</Button></span></Tooltip></Space>}>
      <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable={can("reorder")} onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟</small></div>
        {item.pendingReview && <Tag color="purple">待复核</Tag>}
        <Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : item.status === "已跳过" ? "gray" : "blue"}>{item.status}</Tag>
        <Tooltip content={deniedTip("select")}><span><Button size="mini" onClick={() => dispatch(selectEvidence(item.id))} disabled={!can("select")}>选中</Button></span></Tooltip>
      </article>)}</div>
      <div className="control-strip">
        <Tooltip content={deniedTip("show")}><span><Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current || !can("show")}>开始展示</Button></span></Tooltip>
        <Tooltip content={deniedTip("complete")}><span><Button onClick={() => dispatch(completeEvidence())} disabled={!current || !can("complete")}>完成并切换下一条</Button></span></Tooltip>
        <Tooltip content={deniedTip("addObjection")}><span><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current || !can("addObjection")}>提出异议</Button></span></Tooltip>
        <Tooltip content={deniedTip("sensitive")}><span><Button onClick={() => dispatch(toggleSensitive(current?.id ?? ""))} disabled={!current || !can("sensitive")}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button></span></Tooltip>
      </div>
    </Card>
    <div className="side-stack">
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{value:"控制",label:"控制者视图"},{value:"预览",label:"公开屏"}]} />} className="preview-card">
        <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>{current?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{current?.note}</p>}<footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}</div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Tooltip content={deniedTip("resolveObjection")}><span><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))} disabled={!can("resolveObjection")}>支持并跳过</Button></span></Tooltip><Tooltip content={deniedTip("resolveObjection")}><span><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))} disabled={!can("resolveObjection")}>驳回继续</Button></span></Tooltip></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
    </div>
    <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}><Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{value:"关联性异议",label:"关联性异议"},{value:"真实性异议",label:"真实性异议"},{value:"合法性异议",label:"合法性异议"}]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form></Modal>
    <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const canRestore = state.session.operatorMode === "庭审控制" && ROLE_PERMISSIONS[state.role].includes("restore");
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段；恢复按当前修订号合并，已播内容不回退。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Tooltip content={canRestore ? undefined : `越权：${state.role} 无权恢复快照`}><span><Button size="mini" onClick={() => dispatch(restore(item.id))} disabled={!canRestore}>恢复</Button></span></Tooltip></div>)}</Card></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const canSensitive = state.session.operatorMode === "庭审控制" && ROLE_PERMISSIONS[state.role].includes("sensitive");
  return <Card title="证据目录与公开属性"><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p>{item.pendingReview && <Tag color="purple">待复核</Tag>}</div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive(item.id))} disabled={!canSensitive} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data } = useGetSnapshotQuery();
  const [commit] = useCommitSnapshotMutation();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (data) dispatch(initialize(data)); }, [data, dispatch]);

  // 用 ref 持有最新状态，保证提交时读到最新快照，且防抖不被 tick 计时打断
  const stateRef = useRef(state);
  stateRef.current = state;

  // 断线恢复 / 本地有未同步修订时，按修订号提交合并
  useEffect(() => {
    if (!state.online || state.syncStatus !== "dirty" || !state.lastSynced) return;
    const timer = window.setTimeout(() => {
      const s = stateRef.current;
      const baseSnapshot = s.lastSynced;
      if (!baseSnapshot) return;
      const snapshot = buildSnapshot({
        evidence: s.evidence,
        objections: s.objections,
        timeline: s.timeline,
        session: {
          phase: s.session.phase,
          currentEvidenceId: s.session.currentEvidenceId,
          timerSeconds: s.session.timerSeconds,
        },
      });
      void commit({
        baseRevision: s.syncedRevision,
        baseSnapshot,
        snapshot,
        ops: s.pendingOps,
        role: s.role,
      }).unwrap()
        .then((result) => {
          if (result.ok) dispatch(commitSucceeded({ snapshot: result.snapshot, committedSeq: s.dirtySeq }));
          else dispatch(commitRejected({ error: result.error, snapshot: result.snapshot }));
        })
        .catch(() => dispatch(commitRejected({ error: "提交失败：基线不可用，已回滚到最近同步点", snapshot: s.lastSynced ?? undefined })));
    }, 300);
    return () => window.clearTimeout(timer);
    // dirtySeq 仅在真实修改时递增；tick 计时不触发，避免防抖被无限重置
  }, [state.online, state.syncStatus, state.dirtySeq, state.role, commit, dispatch]);

  // 越权/冲突提示
  useEffect(() => {
    if (!state.lastError) return;
    Message.error(state.lastError);
    dispatch(clearError());
  }, [state.lastError, dispatch]);

  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, review: state.evidence.filter((item) => item.pendingReview).length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length }), [state]);
  const syncColor = state.syncStatus === "synced" ? "green" : state.syncStatus === "dirty" ? "orange" : "gray";
  const syncText = state.syncStatus === "synced" ? "已同步" : state.syncStatus === "dirty" ? "待同步" : "离线未提交";

  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>本地恢复 <Switch checked={!state.online} onChange={(value) => dispatch(setOnline(!value))} /></label><Tag color="blue">基线 #{state.revision}</Tag><Tag color={syncColor}>{syncText}</Tag><Select size="small" value={state.role} onChange={(value) => dispatch(setRole(value as Role))} options={ROLE_OPTIONS} />{state.role === "代理人" && <Select size="small" value={state.session.party} onChange={(value) => dispatch(setParty(value as Party))} options={PARTY_OPTIONS} />}</div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="待复核证据" value={metrics.review} /></Card><Card><Statistic title="异议记录" value={metrics.objections} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
