import { useEffect, useState } from "react";
import { Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  bootstrapCourt, changePhase, completeEvidence, goOffline, goOnline, raiseObjection,
  reorderEvidence, resolveObjection, restoreSnapshot, reviewEvidence, selectEvidence,
  setActor, setMode, showEvidence, simulateRemote, snapshot as snapshotAction, tick
} from "./store/courtSlice";
import { setSensitive } from "./store/courtSlice";
import type { Actor, Party, Role, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

function notify(outcome: { ok: boolean; outcome?: string; reason?: string }, successText: string) {
  if (!outcome.ok) { Message.error(outcome.reason ?? "提交被拒绝"); return; }
  if (outcome.outcome === "skipped") Message.info(outcome.reason ?? "已播内容/旧修订已跳过");
  else Message.success(successText);
}

const ROLE_OPTIONS: { label: string; value: string }[] = [
  { label: "法官（审判庭）", value: "法官" },
  { label: "书记员", value: "书记员" },
  { label: "原告代理人", value: "原告" },
  { label: "被告代理人", value: "被告" }
];

function actorOf(value: string): Actor {
  if (value === "原告" || value === "被告") return { role: "代理人", party: value as Party };
  return { role: value as Role };
}

function RoleSwitcher() {
  const dispatch = useAppDispatch();
  const actor = useAppSelector((root) => root.court.actor);
  const value = actor.role === "代理人" ? (actor.party ?? "原告") : actor.role;
  return <Select size="small" value={value} style={{ width: 150 }} onChange={(v) => dispatch(setActor(actorOf(v)))} options={ROLE_OPTIONS} />;
}

/** 协同状态条：在线/离线、待同步提交、对端离线写入模拟、重连合并报告 */
function SyncBar() {
  const dispatch = useAppDispatch();
  const { online, pendingCommits, baseline, lastReport } = useAppSelector((root) => root.court);
  const remote = () => {
    const r = dispatch(simulateRemote("reorder"));
    notify(r, "对端已离线写入新顺序（重连时按修订号合并）");
  };
  const remoteComplete = () => {
    const r = dispatch(simulateRemote("complete"));
    notify(r, "对端已离线完成当前质证（重连时已播内容跳过）");
  };
  const remoteObjection = () => {
    const r = dispatch(simulateRemote("objection"));
    notify(r, "对端已离线提交异议（重连时按修订号合并）");
  };
  return <Card className="sync-card">
    <Space wrap>
      <Tag color={online ? "green" : "red"}>{online ? `协作同步 · 基线 r${baseline.revision}` : `离线操作 · 本地基线 r${baseline.revision}`}</Tag>
      {!online && <Tag color="orange">待同步提交 {pendingCommits.length} 条</Tag>}
      {online
        ? <Button size="small" status="warning" onClick={() => dispatch(goOffline())}>断开网络（演示）</Button>
        : <Button size="small" type="primary" onClick={() => { dispatch(goOnline()); }}>重连并按修订号合并</Button>}
    </Space>
    {!online && <Space wrap style={{ marginTop: 10 }}>
      <span style={{ color: "#7a8496", fontSize: 12 }}>模拟“对端屏”离线同时提交：</span>
      <Button size="mini" onClick={remote}>对端调整顺序</Button>
      <Button size="mini" onClick={remoteComplete}>对端完成质证</Button>
      <Button size="mini" onClick={remoteObjection}>对端提异议</Button>
    </Space>}
    {lastReport && <div className="merge-report">
      <b>最近重连合并（{new Date(lastReport.time).toLocaleTimeString("zh-CN", { hour12: false })}，远端 r{lastReport.remoteRevision}）</b>
      <Space wrap>
        <Tag color="green">采纳 {lastReport.applied.length}</Tag>
        <Tag color="gray">跳过 {lastReport.skipped.length}</Tag>
        <Tag color="red">拒绝 {lastReport.rejected.length}</Tag>
      </Space>
      {[...lastReport.applied.map((d) => `✓ ${d}`), ...lastReport.skipped.map((d) => `⊘ ${d}`), ...lastReport.rejected.map((r) => `✗ ${r.detail}：${r.reason}`)]
        .map((line, i) => <div key={i} className="report-line">{line}</div>)}
    </div>}
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const actor = state.actor;
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.baseline.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);

  const isClerk = actor.role === "书记员";
  const isJudge = actor.role === "法官";
  const isAgent = actor.role === "代理人";

  const submitObjection = (values: ObjectionForm) => {
    if (!current) return;
    notify(dispatch(raiseObjection({ evidenceId: current.id, ...values })), "异议已进入待裁定分支");
    reset(); setObjectionOpen(false);
  };

  const move = (from: number, to: number) => {
    if (!isClerk) { Message.error("只有书记员可以调整证据顺序，越权提交已拒绝"); return; }
    const items = [...state.baseline.evidence];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    notify(dispatch(reorderEvidence(items.map((e) => e.id))), "顺序已更新：未展示项与计时重算，已展示留痕待复核");
  };

  return <div className="court-grid">
    <Card className="operator" title={<Space>证据操作台 <Tag>{actor.role === "代理人" ? `${actor.party}代理人` : actor.role}</Tag></Space>}
      extra={<Space>
        <Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag>
        {(isJudge || isClerk) && <Button size="small" onClick={() => dispatch(snapshotAction("手动存档"))}>保存快照</Button>}
      </Space>}>
      <div className="evidence-list">{state.baseline.evidence.map((item, index) => <article key={item.id}
        draggable={isClerk}
        onDragStart={(event) => isClerk && event.dataTransfer.setData("text/plain", String(index))}
        onDragOver={(event) => isClerk && event.preventDefault()}
        onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); if (!Number.isNaN(from)) move(from, index); }}
        className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span>
        <div><b>{item.exhibitNo} · {item.title}</b>
          <small>{item.type} · {item.presenter} · {item.duration}分钟 · 修订 r{item.revision}{item.shownAt ? ` · 展示于 ${new Date(item.shownAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}</small>
        </div>
        <Space size={4} direction="vertical">
          <Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : item.status === "已跳过" ? "red" : "gray"}>{item.status}</Tag>
          {item.needsReview && <Tag color="purple">待复核</Tag>}
        </Space>
        <Space direction="vertical" size={4}>
          <Button size="mini" onClick={() => notify(dispatch(selectEvidence(item.id)), `已选中 ${item.exhibitNo}`)}>选中</Button>
          {item.status === "已展示" && item.needsReview && isJudge &&
            <Button size="mini" type="outline" status="success" onClick={() => notify(dispatch(reviewEvidence(item.id)), "展示留痕复核完成")}>复核</Button>}
        </Space>
      </article>)}</div>
      <div className="control-strip">
        <Button type="primary" disabled={!current} onClick={() => current && notify(dispatch(showEvidence(current.id)), "开始展示（已记录首次展示时间）")}>开始展示</Button>
        <Button disabled={!current} onClick={() => current && notify(dispatch(completeEvidence(current.id)), "完成质证并切换下一条")}>完成并切换下一条</Button>
        <Button status="warning" disabled={!current || !isAgent} onClick={() => setObjectionOpen(true)}>提出异议{!isAgent && "（仅代理人）"}</Button>
        <Button disabled={!current || !isClerk} onClick={() => { if (current) notify(dispatch(setSensitive(current.id, !current.sensitive)), current.sensitive ? "已恢复公开内容" : "敏感内容已遮罩"); }}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}{!isClerk && "（书记员）"}</Button>
      </div>
    </Card>
    <div className="side-stack">
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { const v = value as "控制" | "预览"; setLocalMode(v); dispatch(setMode(v === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{ value: "控制", label: "控制者视图" }, { value: "预览", label: "公开屏" }]} />} className="preview-card">
        <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>{current?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{current?.note}</p>}<footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase} · r{state.baseline.revision}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}</div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => {
        const target = state.baseline.evidence.find((e) => e.id === item.evidenceId);
        return <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><small>{target?.exhibitNo} · 提交于 {new Date(item.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</small><Space style={{ marginTop: 6 }}>
          <Button size="mini" status="success" disabled={!isJudge} onClick={() => notify(dispatch(resolveObjection(item.id, "支持")), "异议成立，该证据跳过，后续顺序与计时已重算")}>支持并跳过</Button>
          <Button size="mini" disabled={!isJudge} onClick={() => notify(dispatch(resolveObjection(item.id, "驳回")), "异议驳回，继续质证")}>驳回继续</Button>
        </Space>{!isJudge && <p><Tag color="red">仅法官可裁定</Tag></p>}</div>;
      })}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
    </div>
    <Modal title="提出证据异议（仅代理人）" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}>
      <Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{ value: "关联性异议", label: "关联性异议" }, { value: "真实性异议", label: "真实性异议" }, { value: "合法性异议", label: "合法性异议" }]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form>
    </Modal>
    <Card title="庭审阶段" className="phase-card" extra={!(isJudge || isClerk) ? <Tag color="red">仅法官/书记员可切换</Tag> : undefined}>
      <Radio.Group value={state.session.phase} disabled={!(isJudge || isClerk)} onChange={(value) => notify(dispatch(changePhase(value as SessionPhase)), `已切换至${value}阶段`)}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group>
    </Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const canRestore = state.actor.role !== "代理人";
  return <div className="timeline-grid"><Card title="庭审时间线（含修订号与拒绝/跳过记录）"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card>
    <Card title={`本地恢复点（协同基线 r${state.baseline.revision}）`}><p>每次手动存档都会固化当前证据顺序、修订号与阶段；恢复后作为新基线同步，待重连提交会清空。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><Button size="mini" disabled={!canRestore} onClick={() => notify(dispatch(restoreSnapshot(item.id)), "快照已恢复并作为新协同基线")}>恢复</Button><small>{new Date(item.time).toLocaleString("zh-CN")} · 基线 r{item.baselineRevision}</small></div>)}{!canRestore && <p><Tag color="red">代理人无权恢复快照</Tag></p>}</Card>
  </div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  const isClerk = state.actor.role === "书记员";
  return <Card title={`证据目录与公开属性（基线 r${state.baseline.revision}）`} extra={!isClerk ? <Tag color="red">敏感遮罩仅书记员可操作</Tag> : undefined}><div className="catalog">{state.baseline.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p><small>举证角色：{item.presenterRole} · 修订 r{item.revision} · {item.status}{item.needsReview ? " · 待复核" : ""}</small></div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} disabled={!isClerk} onChange={(v) => notify(dispatch(setSensitive(item.id, v)), v ? "敏感内容已遮罩" : "已恢复公开内容")} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { t, i18n } = useTranslation();
  useEffect(() => { dispatch(bootstrapCourt()); }, [dispatch]);
  const metrics = {
    shown: state.baseline.evidence.filter((item) => item.status === "已展示").length,
    sensitive: state.baseline.evidence.filter((item) => item.sensitive).length,
    objections: state.objections.length,
    review: state.baseline.evidence.filter((item) => item.needsReview).length
  };
  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav>
    <div style={{ color: "#aeb8cb", fontSize: 12 }}>当前身份<RoleSwitcher /></div>
    <Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside>
    <main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div>
      <div className="top-tools"><label>本地恢复 <Switch checked={!state.online} onChange={(value) => value ? dispatch(goOffline()) : dispatch(goOnline())} /></label><Tag color={state.online ? "green" : "orange"}>{state.online ? "协作同步" : "离线操作"}</Tag></div></header>
      {state.migratedFromLegacy && <Card className="legacy-banner"><Tag color="purple">旧档已升级</Tag> 检测到缺少修订号和角色字段的历史数据，已按首次展示顺序补齐，证据目录可正常打开。</Card>}
      <SyncBar />
      <section className="metrics"><Card><Statistic title="证据总数" value={state.baseline.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="异议 / 待复核" value={`${metrics.objections} / ${metrics.review}`} /></Card></section>
      <Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
