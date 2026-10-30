/**
 * 会议助手插件——客户端半。
 *
 * 一个会话入口，配合侧栏面板与全局设置：
 *
 *  * 输入框旁的会议助手（`conversation.input.left`）——只打开面板，面板内控制录音；
 *  * 侧栏那根共享的栏（`shell.overlay` → `DockHost`）——会议面板；
 *  * 设置里的「会议语音」（`settings.section`）——识别服务设置。
 *
 * 侧栏那一根是**两个插件共用的**：名单挂在全局上（见 plugins/plugin-shared/dock/dock-store.ts），谁先加载
 * 谁建；栏本身也只有一个宿主，所以供给面板与会议面板是同一根栏里的两个标签页，而不是两根栏。
 * 只装这一个插件时它照样开得出栏——`DockHost` 不依赖别的插件。
 */
import React from 'react';
import {MeetingCapture,type VoiceCall} from './voice/capture.js';
import type {BriefCache} from './voice/coach-ui.js';
import {MeetingToggle, MeetingSettings} from './voice/client.js';
import {DockHost} from './shared/dock/dock.js';
import {DOCK_SEATS,dockMount} from './shared/dock/mounts.js';
import {yieldRightPanel} from './shared/right-panel.js';
import {createRpcCall} from './shared/rpc-call.js';
import {sharedLog} from './shared/diag.js';

/** 会议客户端的诊断日志（与 mesh 那份同一个环形缓冲，报告里合并看）。 */
const diag = sharedLog('meeting-assistant-client');

declare const __PLUGIN_VERSION__: string;
const CLIENT_VERSION=typeof __PLUGIN_VERSION__==='string'?__PLUGIN_VERSION__:'';
export const inject = ['slots', 'sessions', 'connection', 'layout'];
type Call = (endpoint: string, payload?: unknown) => Promise<any>;

/** 输入框上方的状态条容器是第三个插件（`dsh-plugin-status-bar`）提供的，这里不碰它。 */
export function apply(ctx: any) {
  // 与 mesh 走的是**同一个** `createRpcCall`：上限、错误翻译、日志一行三件事只有一份实现，
  // 两个插件不会再对"传输卡住了"给出不同答案。
  const call: Call = createRpcCall({
    transport: ctx.connection.rpc,
    channel: '/meeting-assistant',
    label: '会议助手',
    marker: '[meeting-assistant-host …]',
    diag,
    defaultDeadlineMs: 30_000,
    retry: {
      endpoints: ['audio', 'stop', 'status', 'config', 'read', 'brief/get', 'coach/read'],
      delaysMs: [100, 200, 400, 800, 1000, 1000],
    },
  });
  const capture = new MeetingCapture(call as VoiceCall);
  const briefCache: BriefCache = new Map();
  // Page close and actual plugin removal stop capture; model settings do not replace this client fiber.
  const unload = () => { void capture.shutdown(); };
  window.addEventListener('pagehide', unload);
  ctx.effect(() => () => { window.removeEventListener('pagehide', unload); return capture.shutdown(); }, 'meeting-assistant: stop microphone on client disposal');
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'meeting-toggle',
    order: -99,
    inject: (sessionId: string) => ({
      sessionId,
      clientVersion: CLIENT_VERSION,
      call,
      capture,
      briefCache,
      getCwd: () => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd || '',
      closeDetails: () => yieldRightPanel(ctx),
      // 子代理会话（subagent）没有麦克风：那是模型自己开的会话，会议入口在那里没有意义。
      available: ctx.sessions.subagentAddress(sessionId) === undefined,
    }),
  }, MeetingToggle));
  ctx.slots.inject(DOCK_SEATS.overlay.name, () => {
    (globalThis as unknown as {__dshDiagLogs?: Map<string, {info: (s: string, m: string) => void}>}).__dshDiagLogs?.get('agent-mesh-client')?.info('load', 'shell.overlay 槽位已就绪（会议助手）');
    return ctx.slots.register(dockMount('overlay', 'meeting-dock'), DockMount);
  });
  // 同 mesh：`shell.overlay` 在别人的 DSH 版本里可能不存在，用**已经在渲染**的输入框槽位兜底一个宿主，
  // 否则会出现"设置里的会议语音能用、但会议面板打不开"。
  ctx.slots.inject(DOCK_SEATS.fallback.name, () => ctx.slots.register(dockMount('fallback', 'meeting-dock-fallback'), DockMount));
  ctx.slots.inject('settings.section', () => ctx.slots.register({name: 'settings.section', id: 'meeting-voice', order: 16, label: () => '会议语音', inject: () => ({call})}, MeetingSettings));
}

/**
 * 把共享的那根栏挂起来。
 *
 * 挂在 frame 级 overlay 上是因为栏必须能**先于任何面板**存在：会议面板是从输入框旁的统一入口打开的，
 * 而那时不一定有会话。overlay 这一项自己什么也不渲染，栏是由 DockHost 插到原生布局旁边的。
 */
function DockMount() {
  return <DockHost/>;
}
