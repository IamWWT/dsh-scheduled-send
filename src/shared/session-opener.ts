/**
 * 把「跳转到会话」的客户端 sessions 服务调用收敛为可单测的 helper。
 *
 * 为什么单独成文件：DSH 的 `ISessions.open(id)` 方法体依赖 `this.manager`
 *（见 deepseek-harness packages/api/session-controller/src/client/sessions/service.ts：
 * `open(id: SessionId): void { this.manager.select(id) }`）。
 * 若调用方先 `const f = svc.open` 再 `f(id)`，方法内的 `this` 变 undefined，
 * 直接报 `Cannot read properties of undefined (reading 'manager')`（v0.6.0 真实故障）。
 *
 * 正确姿势：始终以 `svc.open(id)` 形式经箭头函数保引用调用——`this` 仍指向 svc。
 */
export interface SessionsOpenService {
  open?: (id: string) => void;
}

/**
 * 构造安全的跳转函数：`svc.open` 缺失或非函数 → 返回 undefined（调用方降级/隐藏按钮）。
 * @returns 保引用调用 `svc.open(id)` 的函数；服务不可用时 undefined。
 */
export function sessionOpenerOf(svc: SessionsOpenService | undefined): ((id: string) => void) | undefined {
  if (!svc || typeof svc.open !== "function") return undefined;
  const open = svc.open;
  return (id: string) => {
    // 经局部 const 保引用调用：open 内部 this 仍指向 svc（不可在别处再解构）
    open.call(svc, id);
  };
}