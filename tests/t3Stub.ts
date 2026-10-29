/**
 * T3 over HTTP and its RPC socket, for tests of the HTTP adapter: `routes` answers HTTP reads by path; every RPC frame
 * is recorded, and `rpc` answers it (throw { rpcError } to refuse).
 */
import { HttpT3Adapter } from "../src/adapter/http.ts";

const ENVIRONMENT = { environmentId: "env", label: "box", serverVersion: "0.1.3-nightly.20261027.3748", orchestrationProtocolVersion: 2 };

export function t3Stub(routes: Record<string, unknown>, rpc: (frame: { tag: string; payload: any }) => unknown = () => null) {
  const frames: Array<{ tag: string; payload: any }> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname;
    const body = path === "/.well-known/t3/environment" ? ENVIRONMENT : path === "/api/auth/websocket-ticket" ? { ticket: "tk" } : (routes[path] ?? null);
    return new Response(JSON.stringify(body ?? { error: "not found" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  class Socket {
    private readonly listeners = new Map<string, Array<(event: any) => void>>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(type: string, listener: (event: any) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(data: string): void {
      const frame = JSON.parse(data);
      frames.push({ tag: frame.tag, payload: frame.payload });
      const exit = (value: unknown) => this.emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: value }) });
      queueMicrotask(() => {
        try {
          exit({ _tag: "Success", value: rpc({ tag: frame.tag, payload: frame.payload }) ?? null });
        } catch (error) {
          exit({ _tag: "Failure", cause: [{ _tag: "Fail", error: (error as { rpcError: unknown }).rpcError }] });
        }
      });
    }
    close(): void {
      this.emit("close", {});
    }
  }
  return { adapter: new HttpT3Adapter({ baseUrl: "http://t3.local:3773", accessToken: "tok", fetchImpl, webSocketImpl: Socket }), frames };
}
