type GatewayCall = (
  method: string,
  opts: { timeout?: string },
  params?: unknown,
  extra?: { progress?: boolean },
) => Promise<Record<string, unknown>>;

let gatewayCall: GatewayCall = async (method) => {
  throw new Error(`no gateway in tests: ${method}`);
};

// Test seam: answers the plugin's gateway client calls.
export function __setGatewayCall(next: GatewayCall): void {
  gatewayCall = next;
}

export function callGatewayFromCli(...args: Parameters<GatewayCall>): Promise<Record<string, unknown>> {
  return gatewayCall(...args);
}
