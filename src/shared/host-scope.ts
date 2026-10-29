/**
 * 在一个**声明了这些服务**的作用域里做一件事。
 *
 * 为什么需要它：`ctx.connection.rpc.handle()`（注册一条 HTTP RPC 通道）会把路由挂到**读它的那个
 * context** 的 `webServer` 上——`get rpc() { const owner = this.ctx; … }` →
 * `owner.effect(() => owner.webServer.register(route))`。所以读它的 ctx 必须自己声明 webServer，
 * 否则 cordis 在 fiber 链上找不到提供者就抛 `cannot get property "webServer" without inject`，
 * 而那发生在**加载阶段**：整个 profile 起不来（别人机器上就是这样）。
 *
 * 这个写法与 DSH 自己的 `dsh-api-gateway` 一致（它对同一件事用的就是
 * `ctx.inject(["connection", "webServer"], (webCtx) => …)`）。
 *
 * 旧版本 cordis 没有 `ctx.inject`（测试替身也常常没有）：那时直接在传入的 ctx 上做——行为与
 * 从前一致，不会更糟。
 */
export function scopedToServices(ctx: unknown, services: readonly string[], run: (scoped: any) => void): void {
  const injectable = ctx as { inject?: (names: readonly string[], callback: (scoped: unknown) => void) => unknown };
  if (typeof injectable?.inject === 'function') {
    injectable.inject(services, scoped => run(scoped));
    return;
  }
  run(ctx);
}
