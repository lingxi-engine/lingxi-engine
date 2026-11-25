/**
 * v2.0.44 公开注册开关（自部署模型）
 * ================================================================
 * 灵犀的原则：各自部署各自的服务器，各自登录各自的实例。
 *
 * - 自建实例默认开放注册（REGISTRATION_OPEN 未设置 / true / 1 / on）：
 *   用户在自己的实例上注册自己的账号，数据完全归自己。
 * - 私有实例设 REGISTRATION_OPEN=false（或 0 / off / closed / no）关闭公开注册：
 *   陌生人无法注册使用这台服务器；已有账号登录不受影响。
 *
 * 官网示例站即采用私有模式：只提供下载与部署指南，不提供共享算力。
 */

/** 当前实例是否开放公开注册（默认开放，私有实例显式关闭）。 */
export function registrationOpen(): boolean {
  return !/^(0|false|off|closed|no)$/i.test(String(process.env.REGISTRATION_OPEN ?? 'true').trim());
}

/** 注册关闭时的统一 403 应答（中英双语，引导自部署）。 */
export function registrationClosedReply(res: any): any {
  return res.status(403).json({
    error: '本实例已关闭公开注册，请部署自己的灵犀引擎（官网下载页有一键部署指南）。/ This instance is private. Please deploy your own LingXi engine (self-hosting guide on the download page).',
    code: 'registration_closed',
  });
}