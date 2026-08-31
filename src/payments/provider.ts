/**
 * 支付通道占位接口（v2.4.0）
 *
 * 当前版本【仅功能占位】：不调用任何真实支付通道，所有支付返回"未接入"。
 * 后续接入真实支付时，只需实现 PaymentProvider 接口并替换 createPaymentProvider() 的返回即可，
 * 业务层（钱包路由/结算）无需改动。
 *
 * 已预留标准通道：
 *  - stripe   : Stripe Checkout / Payment Intents
 *  - alipay   : 支付宝当面付 / 手机网站支付
 *  - wechat   : 微信支付 Native / JSAPI
 */

export type PaymentChannel = 'stripe' | 'alipay' | 'wechat' | 'internal';

export interface PaymentIntent {
  /** 平台内部订单号（对应 wallet_transactions.id） */
  orderId: string;
  /** 金额（正数） */
  amount: number;
  /** USD | CNY */
  currency: 'USD' | 'CNY';
  /** 支付描述 */
  description?: string;
  /** 回调地址（支付完成后平台回调） */
  callbackUrl?: string;
}

export interface PaymentResult {
  ok: boolean;
  /** 支付链接 / 二维码内容 / 交易号 */
  payUrl?: string;
  transactionId?: string;
  message?: string;
  /** 占位模式恒为 true，真实接入后为 false */
  placeholder: boolean;
}

export interface RefundResult {
  ok: boolean;
  refundId?: string;
  message?: string;
  placeholder: boolean;
}

/**
 * 标准支付通道接口。
 * 实现它即可接入任意支付服务商。
 */
export interface PaymentProvider {
  readonly channel: PaymentChannel;
  /** 发起支付：返回支付链接/二维码 */
  createPayment(intent: PaymentIntent): Promise<PaymentResult>;
  /** 查询订单状态 */
  query(orderId: string): Promise<{ status: 'pending' | 'paid' | 'failed'; raw?: any }>;
  /** 退款 */
  refund(orderId: string, amount?: number): Promise<RefundResult>;
}

/** 占位实现：所有通道返回"未接入真实支付" */
class PlaceholderProvider implements PaymentProvider {
  readonly channel: PaymentChannel;
  constructor(channel: PaymentChannel) { this.channel = channel; }

  async createPayment(intent: PaymentIntent): Promise<PaymentResult> {
    return {
      ok: false,
      message: `[占位] ${this.channel} 支付通道未接入，当前为功能占位（订单 ${intent.orderId}，${intent.amount} ${intent.currency}）`,
      placeholder: true,
    };
  }
  async query(_orderId: string): Promise<{ status: 'pending' | 'paid' | 'failed'; raw?: any }> {
    return { status: 'pending', raw: { placeholder: true } };
  }
  async refund(_orderId: string, _amount?: number): Promise<RefundResult> {
    return { ok: false, message: '[占位] 支付通道未接入，无法退款', placeholder: true };
  }
}

const _instances: Record<string, PaymentProvider> = {};

/**
 * 获取支付通道实例。
 * @param channel stripe | alipay | wechat | internal
 */
export function getPaymentProvider(channel: PaymentChannel = 'internal'): PaymentProvider {
  if (!_instances[channel]) {
    // 占位阶段：一律返回占位实现；接入真实支付时在这里 switch 到真实 SDK
    _instances[channel] = new PlaceholderProvider(channel);
  }
  return _instances[channel];
}

/**
 * 当前支付能力是否已接入真实通道（占位阶段恒为 false）
 */
export function isPaymentLive(): boolean {
  return false;
}
