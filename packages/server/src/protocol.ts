export interface ToolError {
  code: string;
  message: string;
  hint?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface HelloMessage {
  kind: "hello";
  role: "extension" | "internal";
  token: string;
  version: string;
  browser?: string;
  instanceId?: string;
  label?: string;
}

export interface InstanceInfo {
  id: string;
  label: string;
  active: boolean;
  connected: boolean;
  browser?: string;
  connectedAt: number;
}

export interface RoleMessage {
  kind: "role";
  active: boolean;
  activeLabel?: string;
}

export interface CallMessage {
  kind: "call";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface ResultMessage {
  kind: "result";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ToolError;
}

export interface PingMessage {
  kind: "ping";
}

export interface PongMessage {
  kind: "pong";
}

export interface ReadyMessage {
  kind: "ready";
  allowEval: boolean;
  extensionConnected: boolean;
  bridgeVersion: string;
}

export interface StatusMessage {
  kind: "status";
  extensionConnected: boolean;
}

export interface RejectMessage {
  kind: "reject";
  error: ToolError;
}

export type ExtensionMessage = ResultMessage | PongMessage | HelloMessage;
export type ClientMessage = CallMessage | PongMessage | HelloMessage;
export type BridgeMessage =
  | CallMessage
  | PingMessage
  | PongMessage
  | ReadyMessage
  | StatusMessage
  | RejectMessage
  | ResultMessage
  | RoleMessage;
