/**
 * 把一条浏览器 ↔ 宿主半的 RPC 通道注册牢。
 *
 * 背景（两次真事故）：插件分两半，浏览器那一半要靠一条 HTTP 路由把调用送到宿主半。DSH 提供的是
 * `ctx.connection.rpc.handle(channel, handler)`，而它内部做的是
 * `owner.effect(() => owner.webServer.register(route))`——**`owner` 是读这个服务的那个 context**。
 * 于是"注册不上"有好几种死法，而且大多是静默的：
 *
 *  * cordis 找不到 `webServer` 的路径 → 抛 `cannot get property "webServer" without inject`
 *    （我们踩过两次，第二次是在别人机器上）；
 *  * `connection`/`webServer` 到得比我们晚 → cordis 的 `inject` 是**等待**，等不到就永远不注册；
 *  * `handle()` 的形状在不同版本里不同 → 抛异常；而这类异常如果落在加载阶段的**前面几步之后**，
 *    后面的通道注册根本执行不到（现在每一步都各自 try/catch，见两个宿主半的 apply）；
 *  * 注册成功了但被更早的前缀路由抢先 → POST 落到 SPA 兜底处理器上，回 405。
 *
 * 所以这里不再把命运交给那一条路径：
 *
 *  1. 在**一个声明了 `connection` + `webServer` 的作用域**里（隔离要求，绕不过去：实测
 *     `ctx.get('webServer')` 在真 DSH 里读到的是 `undefined`）**自己往 `webServer` 上挂前缀路由**，
 *     信任检查直接用 DSH 自己的 `connection.requestRejection`——不另造一套、也不放宽；
 *  2. 自己挂失败才退回 `ctx.connection.rpc.handle()`；
 *  3. 两条都不行、或作用域**迟迟没建立**（服务没到，回调根本不会跑）→ 20 秒看门狗明确报出来，
 *     而不是让日志一片空白。
 *
 * # 所有权与生命周期（两处都修过）
 *
 * * **一次注册只有一个所有者**：两条路互斥——自己挂成功就 `return`，不再去 `connection` 上重复
 *   注册同一条通道。这条不变量由 `test/rpc-channel.test.ts` 的 `connection.handled` 断言盯着。
 * * **注册是可回收的**：`webServer.register` 的返回值就是"摘掉这条路由"的 disposer，而它以前
 *   被丢掉了——宿主换实例（dispose 后重建）时旧 handler 留在表里，新实例撞 `duplicate`，
 *   于是**旧实例的闭包继续应答**（旧 ctx 已经释放）。现在 `installRpcChannel` 返回 disposer，
 *   调用方把它挂到 `ctx.effect` 上（两个宿主半都是这样接的）。
 * * **撞 `duplicate` 不等于成功**：那只说明"这条路径被别的实例占着"，本实例的 dispatch
 *   并不会被调用。以前这里把它记成 `live = true`，于是面板一直拿着旧实例的答案而日志说一切正常。
 *   现在它是一条 warn，并且继续尝试下一条路（或由看门狗如实报出"未注册成功"）。
 *
 * # 为什么"官方那条路"排在第二
 *
 * `connection.rpc.handle()` 是 DSH 的规范扩展点，但它把路由**追加**到 webServer 的路由表上；
 * 前端静态资源那条 fallback 路由先注册，于是 POST 会落到它上面回 405——这就是线上那次
 * `transport failure for /agentmesh/panel/state: HTTP 405` 的来历。自己挂前缀路由能排在 fallback
 * 之前，所以它是首选。要让顺序翻过来，得先有"宿主保证通道路由优先于 fallback"的机制。
 * 手写的那份信封与宿主 schema 的一致性由 `test/rpc-envelope-schema.test.ts` 对着**宿主真包**
 * 里的 `rpcMessageSchema` 现场校验（两边都装着的时候各验一次）。
 *
 * 线上协议与 DSH 的 `rpcFetchHandler` 对齐（照 `dsh-client-connection/lib/index.js` 写）：
 * 请求 `{type:'client-request', rpcId, method, payload}`，响应 `{type:'server-response', rpcId, result}`，
 * `result` 是 `{ok:true,value}` 或 `{ok:false,error:{code,message,details}}`。客户端那一半用的还是
 * `connection.rpc.call(channel, …)`，不需要知道这条路由是谁挂上去的。
 */

/** 与 DSH 的 `DEFAULT_MAX_REQUEST_BODY_BYTES` 同一量级：我们的载荷都很小。 */
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * 多久还没注册成功就报一声：够慢到不误报，够快到不用等人来问。
 *
 * 每次调用现读环境变量：测试要把这 20 秒压到几毫秒来验"失败会被记下来"，而模块级常量在测试里改不动
 * （导入时就已经求值了）。生产路径上这个变量不存在，就是 20 秒。
 */
const watchdogMs = () => Number(process.env.MESH_RPC_WATCHDOG_MS ?? 20_000);

export interface RpcEnvelope { ok: boolean; value?: unknown; error?: {code: string; message: string; details: Record<string, unknown>} }
export type RpcDispatch = (endpoint: string, payload: unknown) => Promise<RpcEnvelope>;
export interface RpcLog {
  info(scope: string, message: string, data?: Record<string, unknown>): void;
  warn(scope: string, message: string, data?: Record<string, unknown>): void;
  error(scope: string, message: string, data?: Record<string, unknown>): void;
}
/**
 * 注册是**可能延后**完成的：`ctx.inject(...)` 的回调在服务到齐之后才跑（真 DSH 上实测就是异步的）。
 * 所以这里不返回"成没成"——那会在延后的情况下**误报失败**（第一版就误报了，还顺带触发一次没必要的
 * 上报）。改用回调：只有到看门狗那一刻还没成功，才叫失败。
 */

interface NodeishRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): void;
}
interface NodeishResponse { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }
interface Scope {
  webServer?: {register?: (route: unknown) => unknown};
  connection?: {requestRejection?: (request: unknown) => number | undefined; rpc?: {handle: (channel: string, handler: RpcDispatch) => unknown}};
}

export function installRpcChannel(input: {
  ctx: unknown;
  channel: string;
  dispatch: RpcDispatch;
  label: string;
  log: RpcLog;
  scopedToServices: (ctx: unknown, services: readonly string[], run: (scoped: unknown) => void) => void;
  onFailure?: (reason: string) => void;
}): () => void {
  const {ctx, channel, dispatch, label, log} = input;
  let live = false;
  let via: 'own' | 'connection' | 'none' = 'none';
  /** 宿主给的回收句柄。挂到 `ctx.effect` 上，插件被卸载时这条路由要跟着走。 */
  let dispose: (() => void) | undefined;

  /**
   * 先直接读插件自己的 ctx。
   *
   * 为什么不是 `ctx.inject(...)` 的子 context：实测（真 DSH，见 `.local` 里的探针）子 context 上
   * `webServer` 读不到——DSH 的 host-webserver 把服务隔离了，**只有插件顶层 `inject` 声明过的 fiber
   * 才看得见**。DSH 自己的 `dsh-host-frontend-static` 就是这么写的：`inject = ["webServer","connection"]`
   * 然后直接用 `ctx.webServer.registerFallback(...)`。读取本身可能抛（cordis 对未声明的服务抛
   * `cannot get property … without inject`），所以这里逐项 try。
   */
  const direct = ctx as {webServer?: Scope['webServer']; connection?: Scope['connection']};
  const readDirect = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };
  const directScope: Scope = {
    webServer: readDirect(() => direct.webServer),
    connection: readDirect(() => direct.connection),
  };
  /**
   * 规范路径：宿主自己的通道注册（`connection.rpc.handle`）。它挂的也是 `{kind:'prefix', path: channel}`
   * 的路由，只是信封、rpcId、错误码与 schema 校验都由宿主负责——插件不该自己再实现一遍。
   *
   * **它排第一**（这一版换过顺序）：宿主的 `WebServer` 文档写明"路由注册顺序不影响请求"，
   * `match()` 的判据是**最长前缀优先**、fallback 由 `registerFallback` 单独接管——也就是说
   * 当年那次 `HTTP 405` 不是"被静态兜底抢先"，而是**这条路由根本没注册上**（服务隔离，
   * 子 context 上读不到 webServer）。所以先试规范路径、被隔离就退回自己挂，是安全的，
   * 也让"同一个 HTTP 路径两个所有者"这件事不再存在：**能走宿主就走宿主**。
   */
  const tryCanonical = (scope: Scope): boolean => {
    const rpc = scope.connection?.rpc;
    const handle = rpc?.handle;
    if (typeof handle !== 'function' || rpc === undefined) return false;
    try {
      // `handle` 是 `get rpc()` 返回的那个对象上的方法，内部用闭包（`this.register(owner, …)`），
      // `this` 仍需是它自己——照 `rpc` 调。
      const registered = handle.call(rpc, channel, dispatch);
      if (typeof registered === 'function') dispose = registered as () => void;
      log.info('rpc', `${channel} 已注册（DSH connection：信封与校验由宿主负责）`, {recyclable: typeof registered === 'function'});
      live = true; via = 'connection';
      return true;
    } catch (error) {
      log.warn('rpc', `${channel} 走宿主 connection 注册失败，退回自己挂路由`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  /**
   * 兜底：插件自己往 `webServer` 上挂一条前缀路由（信封照 `rpcFetchHandler` 手写，
   * 信任检查直接用宿主自己的 `connection.requestRejection`）。
   *
   * 只有规范路径**读不到或抛异常**（服务隔离）时才走到这里。手写的那份与宿主 schema 的一致性
   * 由 `test/rpc-envelope-schema.test.ts` 对着两代宿主真包里的 `rpcMessageSchema` 现场校验。
   */
  const tryOwnRoute = (scope: Scope): boolean => {
    // **不要把方法拆出来单独调用**：`register` 内部要读 `this.prefixes`，拆出来 `this` 就丢了
    // （第一版就是这么错的，真 DSH 上回 `Cannot read properties of undefined (reading 'prefixes')`）。
    const webServer = scope.webServer;
    const connection = scope.connection;
    const fence = connection?.requestRejection;

    if (typeof webServer?.register !== 'function' || typeof fence !== 'function') {
      log.warn('rpc', `${channel} 这条 context 上看不到 webServer/信任检查`, {webServer: typeof webServer?.register === 'function', requestRejection: typeof fence === 'function'});
      return false;
    }
    try {
      const registered = webServer.register({kind: 'prefix', path: channel, handler: makeOwnHandler({channel, dispatch, label, fence, connection})});
      // **接住 disposer**：以前它被丢掉，于是宿主换实例时旧 handler 留在表里、新实例撞 duplicate，
      // 请求继续由旧实例（已经释放的 ctx）的闭包应答。返回给调用方挂 `ctx.effect`。
      if (typeof registered === 'function') dispose = registered as () => void;
      log.info('rpc', `${channel} 已注册（插件自己的路由：宿主 connection 不可用时的兜底）`, {recyclable: typeof registered === 'function'});
      live = true; via = 'own';
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // 路径被别的实例占着：**这不是成功**——本实例的 dispatch 不会被调用，面板拿到的会是
      // 旧实例的闭包（而旧 ctx 可能已经释放）。如实记下来。
      if (/duplicate/i.test(text)) {
        log.warn('rpc', `${channel} 已被其他实例占用，本实例的 dispatch 不会生效`, {detail: text, hint: '旧实例若是已释放的 ctx，请重启宿主或让旧实例先 dispose'});
        return false;
      }
      log.warn('rpc', `${channel} 自己挂路由失败`, {error: text});
      return false;
    }
  };

  /** 一个作用域里的顺序：**规范路径优先**，不行再自己挂。两条互斥（前者成功就不再试后者）。 */
  const tryRegister = (scope: Scope): boolean => tryCanonical(scope) || tryOwnRoute(scope);

  /**
   * 回收句柄：把这条路由从宿主的表里摘掉（并让看门狗不再把它算成"还活着"）。
   *
   * 调用方应当 `ctx.effect(() => installRpcChannel({...}))`——这样插件被卸载或换实例时，
   * 旧路由先走，新实例才能拿到这条路径。
   */
  const release = (): void => {
    const disposeNow = dispose;
    dispose = undefined;
    live = false;
    via = 'none';
    try { disposeNow?.(); } catch { /* 已经没了：回收失败不该影响卸载 */ }
  };

  // 1) 插件自己的 ctx（顶层 inject 声明过，DSH 自己的前端插件也是这么读的）。
  if (tryRegister(directScope)) { finish(); return release; }

  // 2) 再试声明了服务的子作用域（旧版本 cordis 上它才是可行的那条路）。
  input.scopedToServices(ctx, ['connection', 'webServer'], (scoped) => {
    // 子作用域里同样先规范、后自己挂（服务隔离时前者的 owner 绑定会抛，正好退回后者）。
    if (tryRegister(scoped as Scope)) return;
    log.error('rpc', `${channel} 两种注册方式都失败`, {hint: '客户端会看到 HTTP 405'});
  });
  finish();

  /** 收尾：看门狗（真正的失败判据）。 */
  function finish(): void {

    /** 看门狗：服务没到时回调根本不会跑，日志里什么都不会出现——那正是最难查的状态。 */
    const watchdog = setTimeout(() => {
      if (live) return;
      const reason = '注册未完成：connection/webServer 至少缺一个，或几种注册方式都失败（详见 rpc 日志行）';
      log.error('rpc', `${channel} 超时仍未注册成功（客户端会看到 HTTP 405）`, {afterMs: watchdogMs()});
      input.onFailure?.(reason);
    }, watchdogMs());
    (watchdog as unknown as {unref?: () => void}).unref?.();
  }

  return release;
}

/** 我们自己那条路由：协议照 DSH 的 `rpcFetchHandler`，信任检查用它自己的。 */
function makeOwnHandler(input: {channel: string; dispatch: RpcDispatch; label: string; fence: (request: unknown) => number | undefined; connection: unknown}) {
  const {channel, dispatch, label, fence, connection} = input;
  return async (request: NodeishRequest, response: NodeishResponse) => {
    // 与 DSH 一致：只收 POST，其余一律 404（这条路径上没有别的东西）。
    if ((request.method ?? 'GET') !== 'POST') { response.writeHead(404); response.end('not found'); return; }
    const rejection = fence.call(connection, request);
    if (rejection !== undefined) {
      response.writeHead(rejection);
      response.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }
    const endpoint = new URL(request.url ?? '/', 'http://dsh.internal').pathname.slice(channel.length).replace(/^\//, '');
    const body = await readBody(request);
    if (body === undefined) { response.writeHead(413, {connection: 'close'}); response.end(); return; }
    let envelope: {type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown} | undefined;
    try { envelope = JSON.parse(body) as typeof envelope; } catch { envelope = undefined; }
    const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid';
    const reply = (result: unknown) => {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({type: 'server-response', rpcId, result}));
    };
    if (!envelope || envelope.type !== 'client-request' || typeof envelope.method !== 'string') {
      reply({ok: false, error: {code: 'gateway/bad-request', message: 'invalid client-request envelope', details: {}}});
      return;
    }
    if (endpoint === '' || envelope.method !== endpoint) {
      reply({ok: false, error: {code: 'gateway/bad-request', message: `method ${JSON.stringify(String(envelope.method))} does not match endpoint ${JSON.stringify(endpoint)}`, details: {}}});
      return;
    }
    try {
      reply(await dispatch(envelope.method, envelope.payload));
    } catch (error) {
      reply({ok: false, error: {code: `${label}/error`, message: error instanceof Error ? error.message : String(error), details: {}}});
    }
  };
}

/** 读请求体；超过上限返回 undefined（调用方回 413）。 */
function readBody(request: NodeishRequest): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (value: string | undefined) => { if (!done) { done = true; resolve(value); } };
    const declared = request.headers['content-length'];
    if (typeof declared === 'string' && Number(declared) > MAX_BODY_BYTES) { finish(undefined); return; }
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      received += buffer.byteLength;
      if (received > MAX_BODY_BYTES) { finish(undefined); return; }
      chunks.push(buffer);
    });
    request.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => finish(undefined));
  });
}
