/**
 * 诊断日志：关键路径都留痕，出事时用一个 id 把整台机器的现场拉回来。
 *
 * 起因是一次真实的失败：别人装完之后界面上只有一句
 * `transport failure for /agentmesh/panel/state: HTTP 405`。那句里既没有原因也没有下一步，而
 * **插件在两台机器上跑，日志在对方的机器上**——我这边什么都看不到，只能靠来回问。这个模块要解决的
 * 就是那件事：把"看现场"变成"知道一个 id 就够了"。
 *
 * 三样东西：
 *
 * 1. **两份日志各记一份**（宿主半、客户端半各一个 `DiagLog`），关键路径都写：加载、通道注册、每一次
 *    RPC、发现扫描、匹配/工具位置/配置写入、面板开关、栏的挂载与接管、麦克风动作。
 * 2. **本地诊断 ID**：由**客户端半**生成并存在 `localStorage` 里（`diag-xxxxxxxx`）。为什么由客户端
 *    生成而不是宿主半：宿主半没上线时也要能报出 id——那正是最需要它的场合。它会出现在界面的报错里。
 * 3. **本地合并与导出**：客户端半把自己的日志交给宿主半，宿主半合并成一份报告；
 *    操作者从面板复制或下载诊断报告。
 *
 * 边界要说清：**合并要宿主半在线**。宿主半没上线时，界面上的「复制/下载诊断
 * 报告」是唯一的出路——所以本地导出始终可用。
 */

/** 一条记录。`data` 里只放结构化的短字段，不要把整段文本塞进来。 */
export interface DiagEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  /** 哪一半、哪一块：`host`/`client`/`dock`/`rpc`/`scan`/`meeting`… */
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * 环形缓冲的长度。
 *
 * 400 条看着够用，实际不够：面板每 3 秒轮询一次，而一次轮询要写好几条（客户端请求 + 宿主收到 +
 * 扫描结论 + 两次成功），于是一份报告只剩最后两三分钟——用户"打不开面板"的动作往往发生在更早，
 * 现场已经被冲掉了（`c-ecb79562` 那份报告就是这样：400 里 280 条是轮询）。现在 2000 条，并且
 * 成功调用按端点限流记录（见 `infoThrottled`），两条一起才让"关键路径的痕迹"活到我去看的时候。
 */
const MAX_ENTRIES = 2000;

/**
 * 报告里必须抹掉的东西。
 *
 * 报告可能被复制或交给别人，所以**密钥不是"尽量别写"，而是"写了也会被抹"**：
 * 万一日志里出现 `apiKey=…`、`password: …`、Bearer 令牌或一整个连接 JSON，这里兜底。
 */
export function redactSecrets(text: string): string {
  if(!/(password|sharedsecret|api_?key|token|secret|proof|Bearer|enroll_|pair_|endpoint_|dsh-auth-)/i.test(text))return text;
  const secretKey=/(?:password|sharedSecret|api_?key|token|secret|proof)$/i;
  const plain=(value:string)=>value
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi,'Bearer <redacted>')
    .replace(/((?:password|sharedSecret|api_?key|token|secret|proof)"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|[^"\s,}]+)/gi,
      (whole,prefix:string,secret:string)=>{
        if(/^(?:true|false|null)$/.test(secret))return whole;
        return prefix+(secret.startsWith('"')?'"<redacted>"':'<redacted>');
      })
    .replace(/\b(enroll|pair|endpoint)_[A-Za-z0-9._-]{8,}\b/g,'$1_<redacted>')
    .replace(/(dsh-auth-[A-Za-z0-9]+=[^\s;]+)/g,'dsh-auth-<redacted>');
  const structured=(json:string)=>{
    // Tokenize only strings/structure: never round-trip Rust u64 counters through JS numbers.
    type Scope={kind:'object'|'array';secret:boolean;keySecret:boolean;expectsKey:boolean};
    const scopes:Scope[]=[];
    const valueIsSecret=()=>{const scope=scopes.at(-1);return !!scope&&(scope.secret||scope.kind==='object'&&scope.keySecret);};
    return json.replace(/"(?:\\.|[^"\\])*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,(token,offset)=>{
      if(token==='{'||token==='['){const inherited=valueIsSecret();scopes.push({kind:token==='{'?'object':'array',secret:inherited,keySecret:false,expectsKey:token==='{'});return token;}
      if(token==='}'||token===']'){scopes.pop();return token;}
      if(token===','){const scope=scopes.at(-1);if(scope?.kind==='object'){scope.expectsKey=true;scope.keySecret=false;}return token;}
      if(token===':')return token;
      const scope=scopes.at(-1);
      if(token.startsWith('"')){
        const value=JSON.parse(token) as string;
        if(scope?.kind==='object'&&scope.expectsKey){scope.keySecret=scope.secret||secretKey.test(value);scope.expectsKey=false;return token;}
        return JSON.stringify(valueIsSecret()?'<redacted>':plain(value));
      }
      return valueIsSecret()&&!/^(?:true|false|null)$/.test(token)?'"<redacted>"':token;
    });
  };
  try{JSON.parse(text);return structured(text);}catch{/* prose or prefixed log */}
  const start=text.indexOf('{');
  if(start>=0){try{JSON.parse(text.slice(start));return plain(text.slice(0,start))+structured(text.slice(start));}catch{/* human-readable report */}}
  return plain(text);
}

/** Bounded, redacted error chains shared by browser and Host diagnostics. */
export function errorEvidence(error:unknown,secrets:readonly string[]=[],depth=0):Record<string,unknown>{
  const safe=(value:string)=>redactSecrets(secrets.filter(Boolean).reduce((text,secret)=>text.split(secret).join('<redacted>'),value)).slice(0,4000);
  if(!(error instanceof Error))return {message:safe(String(error))};
  const code=(error as Error&{code?:unknown}).code;
  return {name:safe(error.name),message:safe(error.message),stack:safe(error.stack??''),
    ...(typeof code==='string'?{code:safe(code)}:{}),
    ...(depth<3&&error.cause?{cause:errorEvidence(error.cause,secrets,depth+1)}:{})};
}

/** 一条日志，附带一份人读的报告文本。 */
/**
 * 一条记录的出口。**除了环形缓冲之外的每一路都长这样**：宿主日志服务一路、本地 JSONL 一路。
 *
 * 加这个接缝的理由：`push` 以前只写 console，而"应用日志"这条出口在 DSH 0.2.0-rc.2 上
 * 并不存在（宿主没有落盘 exporter）——于是 68 处调用点在磁盘上一条都留不下。出口做成可挂的，
 * 接线（`diag-file.ts` 的 `attachDiagnostics`）就有了唯一一处，两个插件各调一次。
 */
export type DiagSink = (entry: DiagEntry) => void;

export class DiagLog {
  private entries: DiagEntry[] = [];
  /** 限流状态：key → {上次记录时间, 期间累计次数}。 */
  private throttle = new Map<string, {at: number; suppressed: number}>();
  /** 环形缓冲之外的出口（宿主日志、JSONL 文件）；一路都没有时行为与以前一样，只写 console。 */
  private sinks: DiagSink[] = [];
  readonly source: string;
  constructor(source: string) { this.source = source; }

  /**
   * 挂一路出口。出口自己负责"绝不抛"——这里再兜一层：诊断写失败不该弄坏业务路径。
   */
  addSink(sink: DiagSink): void {
    this.sinks.push(sink);
  }

  private push(level: DiagEntry['level'], scope: string, message: string, data?: Record<string, unknown>): DiagEntry {
    const entry: DiagEntry = { at: Date.now(), level, scope, message, ...(data && Object.keys(data).length ? { data } : {}) };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.deliver(entry);
    return entry;
  }
  /** Console and persistence share the same outlet, including adopted client entries. */
  private deliver(entry:DiagEntry):void{
    const {level,scope,message,data}=entry;
    // 控制台那一份保持在：应用日志（DSH Desktop 自己的日志文件）是另一个入口，两边都要有。
    //
    // **三个级别要落到三个方法上**。以前三条分支都是 `console.warn`，级别只剩行首那个 ✖/⚠ 字符，
    // 于是操作者按 error 过滤 DSH 日志时一条也捞不到——"两边都要有"这句话在应用日志那一侧是假的。
    const line = redactSecrets(`[${this.source}] ${scope}: ${message}${data ? ` ${JSON.stringify(data)}` : ''}`);
    if (level === 'error') console.error(`✖ ${line}`);
    else if (level === 'warn') console.warn(`⚠ ${line}`);
    else console.log(line);
    // 挂了出口就每条都送一份（宿主日志服务 / 本地 JSONL）。**一条失败不影响下一条**：
    // 出口里的错误在这里吞掉，否则一次磁盘抖动会顺着 diag 调用点炸进业务路径。
    for (const sink of this.sinks) {
      try { sink(entry); } catch { /* 诊断出口自己出了问题，不能反过来弄坏调用方 */ }
    }
  }
  info(scope: string, message: string, data?: Record<string, unknown>) { return this.push('info', scope, message, data); }
  /**
   * 限流的 info：同 `key` 在 `ms` 内只记一条，并把这段时间里的次数带在 `n` 上。
   *
   * 用于**成功**路径（面板每 3 秒的轮询、每次扫描）：它们数量大、信息量低，会把自己之外的一切冲出
   * 缓冲区。失败永远不经过这里——那才是要留住的。
   */
  infoThrottled(key: string, scope: string, message: string, data: Record<string, unknown> = {}, ms = 30_000) {
    return this.throttled('info',key,scope,message,data,ms);
  }
  /** Snapshot failures may occur on every render; keep their warning severity while coalescing repeats. */
  warnThrottled(key:string,scope:string,message:string,data:Record<string,unknown>={},ms=30_000){
    return this.throttled('warn',key,scope,message,data,ms);
  }
  private throttled(level:DiagEntry['level'],key:string,scope:string,message:string,data:Record<string,unknown>,ms:number){
    const now=Date.now(),last=this.throttle.get(key);
    if(last&&now-last.at<ms){last.suppressed+=1;return;}
    this.throttle.set(key,{at:now,suppressed:0});
    return this.push(level,scope,message,{...data,...(last?.suppressed?{sinceLast:last.suppressed}:{})});
  }
  warn(scope: string, message: string, data?: Record<string, unknown>) { return this.push('warn', scope, message, data); }
  error(scope: string, message: string, data?: Record<string, unknown>) { return this.push('error', scope, message, data); }

  list(): DiagEntry[] { return [...this.entries]; }
  clear() { this.entries = []; this.throttle.clear(); }
  /**
   * 把另一半的日志并进来（客户端半 → 宿主半）。
   *
   * 按 (时间, scope, message) 去重：客户端半会反复推同一批（每次推送带全量环形缓冲），不去重的话
   * 报告里同一件事会重复几十遍，把真正有用的几行埋掉。
   */
  adopt(entries: DiagEntry[], source?: string) {
    /**
     * 去重的键**必须带上前缀**：客户端半每次推的是全量缓冲，而存下来的 scope 带 `client/` 前缀，
     * 用不带前缀的键去比就永远"没见过"，同一件事会被记二十遍（第一版就是这么错的，测试当场抓到）。
     */
    const keyOf = (at: number, scope: string, message: string) => `${at}|${scope}|${message}`;
    const seen = new Set(this.entries.map(entry => keyOf(entry.at, entry.scope, entry.message)));
    for (const entry of entries) {
      const scope = source ? `${source}/${entry.scope}` : entry.scope;
      const key = keyOf(entry.at, scope, entry.message);
      if (seen.has(key)) continue;
      seen.add(key);
      const adopted={...entry,scope};
      this.entries.push(adopted);
      this.deliver(adopted);
    }
    this.entries.sort((left, right) => left.at - right.at);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }
}

/**
 * 按名字取一份日志：同一份产物里多次加载（HMR 换 bundle、两个插件各打一份）时复用同一个环形缓冲。
 *
 * 挂在全局对象上而不是模块里，理由与侧栏名单一样：模块会被换成新的，全局不会——HMR 之后还翻得到
 * 上一次那份日志，往往正是需要的那一段。
 */
export function sharedLog(source: string): DiagLog {
  const registry = globalThis as unknown as {__dshDiagLogs?: Map<string, DiagLog>};
  const logs = registry.__dshDiagLogs ??= new Map<string, DiagLog>();
  const known = logs.get(source);
  if (known) return known;
  const created = new DiagLog(source);
  logs.set(source, created);
  return created;
}

/**
 * 一次 RPC 调用怎么记。
 *
 * **成功要限流，失败不限流**——这条规则是用户报出来的：会议开关每 1.5 秒轮询一次 `status`，
 * 而原来每次调用都记"开始 + ok"，于是日志被 `rpc: status ok {"ms":0}` 刷满（他自己看到的那个刷屏）。
 * 轮询成功是**预期内的常态**：记它一次（外加"上一个窗口又发生了 N 次"）就够回答"轮询有多密"，
 * 而失败永远逐条记——那才是要看的东西。
 *
 * 另外**不再单独记"开始"**：一次调用一行，成功那行带耗时；失败那行带原因。
 */
export function logRpc(log: DiagLog, endpoint: string, outcome: {ok: boolean; ms: number; error?: string}) {
  if (outcome.ok) {
    log.infoThrottled(`rpc:${endpoint}`, 'rpc', `${endpoint} ok`, {ms: outcome.ms});
    return;
  }
  log.warn('rpc', `${endpoint} 失败`, {ms: outcome.ms, error: outcome.error ?? '（没有错误信息）'});
}

/** Keep the storage key so existing local reports remain correlatable. */
const CONSUMER_KEY = 'mesh.diag.consumer';

/** 一个短 id，人念得出来、也念得对（8 位十六进制）。 */
const shortId = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');

/**
 * 这份面板的**本地诊断 ID**（`diag-xxxxxxxx`）。
 *
 * 由客户端半生成、存 `localStorage`，所以换浏览器会换一个 id——那是对的：报告是"这一次安装 + 这个
 * 浏览器"的现场。宿主半收到客户端日志时用它关联本地报告。
 */
export function diagnosticId(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): string {
  try {
    const known = storage?.getItem(CONSUMER_KEY);
    if (known && /^diag-[0-9a-f]{8}$/.test(known)) return known;
    const created = known && /^c-[0-9a-f]{8}$/.test(known) ? `diag-${known.slice(2)}` : `diag-${shortId()}`;
    storage?.setItem(CONSUMER_KEY, created);
    return created;
  } catch {
    return `diag-${shortId()}`;
  }
}

/** 报告文本：人读的头部 + 逐行日志。 */
export interface DiagnosticIdentity {
  platformConsumerId: string | null;
  platformUrl: string | null;
}

export function formatReport(input: { plugin: string; version: string; diagnosticId?: string | null; platformConsumerId?: string | null; platformUrl?: string | null; extra?: Record<string, unknown>; entries: DiagEntry[] }): string {
  const head = [
    `# ${input.plugin} 诊断报告`,
    `生成时间：${new Date().toISOString()}`,
    `本地诊断 ID：${input.diagnosticId ?? '（未知）'}`,
    `平台消费端 ID（consumerId）：${input.platformConsumerId ?? '（未取得平台身份）'}`,
    `平台地址：${input.platformUrl ?? '（未取得平台地址）'}`,
    '平台日志按 consumerId 查询；本地诊断 ID 仅关联本机面板日志。',
    `版本：${input.version}`,
    ...Object.entries(input.extra ?? {}).map(([key, value]) => `${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`),
  ];
  const lines = input.entries.map(entry => {
    const stamp = new Date(entry.at).toISOString().slice(11, 23);
    const level = entry.level === 'error' ? 'E' : entry.level === 'warn' ? 'W' : 'I';
    return `${stamp} [${level}] ${entry.scope}: ${entry.message}${entry.data ? ` ${JSON.stringify(entry.data)}` : ''}`;
  });
  return redactSecrets([...head, '', '## 日志（时间顺序）', ...lines, ''].join('\n'));
}
