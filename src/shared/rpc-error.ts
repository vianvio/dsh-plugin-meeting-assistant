/**
 * 把"宿主半没上线"这件事实翻译成能照着做的提示。
 *
 * 为什么需要：插件分两半，只有**宿主半**能注册 RPC 通道（`ctx.connection.rpc.handle()`）。
 * 如果宿主半在加载阶段抛了异常——或者这份 DSH 缺了某个我们声明的服务——渲染端那一半照样会被
 * 服务出去（插件页、设置页都在），但通道没有，于是所有调用都变成一句
 * `transport failure for /agentmesh/panel/state: HTTP 405`：DSH 的静态前端处理器只认 GET/HEAD，
 * 没被任何人接走的 POST 就落到它身上（`dsh-host-frontend-static/lib/index.js` 里那行 405）。
 *
 * 用户拿到的就是这一句——它既没说是谁的问题，也没说下一步做什么。别人装完第一次报错时，这正是
 * 唯一能拿到手的线索，所以把它翻译成人话：**宿主半没上线 + 去哪看原因**。
 */
export interface RpcFailureHint {
  /** 这条通道属于哪个插件，例如 `agent-mesh`。 */
  label: string;
  /** 通道名，例如 `/agentmesh`。 */
  channel: string;
  /** 出错的调用，例如 `panel/state`。 */
  endpoint: string;
  /** 宿主半加载时往 stderr 打的那一行前缀，例如 `[agent-mesh-host …]`。 */
  marker: string;
}

/** 这句话的判据：DSH 客户端在通道没人接时抛的就是它（404/403 同理）。 */
const UNREACHABLE=/transport failure|HTTP\s*(?:403|404|405)\b/i;

/**
 * 调用带着 `AbortSignal.timeout(...)` 出去、到点还没回来时抛的就是它。
 *
 * 与"通道没人接"要分开讲：通道**在**、宿主半**上线了**，只是这一次没有在期限内回话。
 * 让人去查"宿主半为什么没上线"是查错了方向。
 */
const TIMED_OUT=/timeout|timed out|the operation was aborted/i;

export function describeRpcFailure(error:unknown,hint:RpcFailureHint):Error{
  const text=error instanceof Error?error.message:String(error);
  if(TIMED_OUT.test(text)&&!UNREACHABLE.test(text)){
    return new Error([
      `${hint.label} 的宿主半没有在期限内回应：${hint.channel}/${hint.endpoint} 这一调用超时（或被取消）了。`,
      '通道是通的——也就是说宿主半已经上线，这不是"插件没装好"，而是这一次调用卡住了：',
      '供给方或模型可能还在跑，也可能是连接已经断了但回调没落地。',
      '先重试一次；每次都卡在同一个端点的话，导出诊断信息（DSH Desktop → 设置 → 导出诊断信息），',
      `里面 ${hint.marker} 开头的行会写它走到了哪一步。`,
      `（原始错误：${text}）`,
    ].join('\n'));
  }
  if(!UNREACHABLE.test(text))return error instanceof Error?error:new Error(text);
  const status=/\bHTTP\s*(\d{3})\b/.exec(text)?.[1]??'';
  const lines=[
    `${hint.label} 的宿主半没有上线：${hint.channel}/${hint.endpoint} 没有响应${status?`（HTTP ${status}）`:''}。`,
    '也就是说插件只在渲染端加载了——设置页、面板壳子都在，但注册 RPC 通道的那一半没跑起来。',
    '原因通常在加载阶段（DSH 的插件加载失败会写日志，而且**不会**让界面报错）。请把日志里这些行发出来：',
  ];
  return new Error([
    ...lines,
    `  · 以 ${hint.marker} 开头的行（能确认宿主半加载到了哪一步）`,
    '  · 以 [agent-mesh] / [meeting-assistant] 开头的错误行（例如 cannot get property "…" without inject）',
    '日志位置：DSH Desktop → 设置 → 导出诊断信息；或 ~/Library/Application Support/DSH Desktop/logs/dsh-<日期>.log',
    `（原始错误：${text}）`,
  ].join('\n'));
}
