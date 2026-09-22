export interface WeChatSignatureVerifier {
  verifySignature(signature: string, timestamp: string, nonce: string): boolean;
}

export function verifyWeChatWebhook(adapter: WeChatSignatureVerifier, query: Record<string, unknown>): boolean {
  const signature = String(query.signature || query.msg_signature || '');
  const timestamp = String(query.timestamp || '');
  const nonce = String(query.nonce || '');
  if (!signature || !timestamp || !nonce) return false;
  return adapter.verifySignature(signature, timestamp, nonce);
}
