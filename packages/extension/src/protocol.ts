export interface ToolErrorPayload {
  code: string;
  message: string;
  hint?: string;
}

export interface CallEnvelope {
  kind: "call";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface ConfigEnvelope {
  kind: "config";
  allowEval: boolean;
}

export interface RejectEnvelope {
  kind: "reject";
  error: ToolErrorPayload;
}

export type BridgeToExtension = CallEnvelope | ConfigEnvelope | RejectEnvelope | { kind: "ping" };

export type ExtensionToBridge =
  | { kind: "result"; id: string; ok: true; result: unknown }
  | { kind: "result"; id: string; ok: false; error: ToolErrorPayload }
  | { kind: "pong" };

export interface ContentRequest {
  type: "content:req";
  method: string;
  params: Record<string, unknown>;
}

export interface ContentResponse {
  ok: boolean;
  result?: unknown;
  error?: ToolErrorPayload;
}
