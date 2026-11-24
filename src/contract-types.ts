export type Schema = { [key: string]: any };

export interface ContractParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: Schema;
  description?: string;
}

export interface ContractOperation {
  operationId: string;
  method: string;
  path: string;
  auth: "none" | "device" | "poll" | "assistant";
  tier: "save" | "read" | "manage" | null;
  tool: string | null;
  readOnly: boolean;
  idempotent: boolean;
  params: ContractParam[];
  bodyType: string | null;
  bodyRequired: boolean;
  body: Schema | null;
}

export interface ContractTool {
  name: string;
  operationId: string;
  description: string;
  readOnly: boolean;
  inputSchema: Schema;
}

export interface Contract {
  version: string;
  limits: Record<string, any>;
  sharedRules: Record<string, any>;
  errorCodes: string[];
  steps: string[];
  enums: Record<string, string[]>;
  operations: ContractOperation[];
  tools: ContractTool[];
}
