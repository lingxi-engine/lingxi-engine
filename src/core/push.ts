/**
 * 推送通知管理器 - Push Notification Manager
 * 支持 Web Push API + FCM (Android) + APNs (iOS)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;       // Web Push endpoint 或 FCM/APNs token
  keys?: {
    p256dh: string;
    auth: string;
  };
  platform: 'web' | 'android' | 'ios';
  createdAt: number;
}

export class PushNotificationManager {
  private subscriptions: Map<string, PushSubscription> = new Map();
  private dataDir: string;
  private vapidPublicKey: string | null;
  private vapidPrivateKey: string | null;
  private fcmServerKey: string | null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.vapidPublicKey = process.env.VAPID_PUBLIC_KEY || null;
    this.vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || null;
    this.fcmServerKey = process.env.PUSH_FCM_SERVER_KEY || null;
    this.load();
  }

  /**
   * 添加订阅
   */
  subscribe(userId: string, subscription: Omit<PushSubscription, 'id' | 'userId' | 'createdAt'>): PushSubscription {
    const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sub: PushSubscription = {
      id,
      userId,
      ...subscription,
      createdAt: Date.now(),
    };
    this.subscriptions.set(id, sub);
    this.save();
    console.log(`[Push] 新订阅: ${id} (${subscription.platform}) for ${userId}`);
    return sub;
  }

  /**
   * 取消订阅
   */
  unsubscribe(id: string): boolean {
    const ok = this.subscriptions.delete(id);
    if (ok) this.save();
    return ok;
  }

  /**
   * 获取用户的订阅
   */
  getByUser(userId: string): PushSubscription[] {
    return Array.from(this.subscriptions.values()).filter(s => s.userId === userId);
  }

  /**
   * 发送通知给用户
   */
  async sendToUser(userId: string, title: string, body: string, data?: any): Promise<number> {
    const subs = this.getByUser(userId);
    let sent = 0;
    for (const sub of subs) {
      try {
        if (sub.platform === 'web') {
          await this.sendWebPush(sub, title, body, data);
        } else if (sub.platform === 'android') {
          await this.sendFCM(sub, title, body, data);
        } else if (sub.platform === 'ios') {
          await this.sendAPNs(sub, title, body, data);
        }
        sent++;
      } catch (err: any) {
        console.error(`[Push] 发送失败 ${sub.id}:`, err.message);
      }
    }
    return sent;
  }

  /**
   * Web Push（浏览器推送）
   */
  private async sendWebPush(sub: PushSubscription, title: string, body: string, data?: any) {
    if (!this.vapidPublicKey || !this.vapidPrivateKey) {
      // 没有 VAPID key，跳过
      return;
    }
    
    // Web Push 需要 web-push 库
    // 这里用 fetch 直接调用 Push API endpoint
    const payload = JSON.stringify({ title, body, data, icon: '/favicon.ico' });
    
    try {
      // 简化：实际 Web Push 需要 VAPID 签名
      // 建议安装 web-push 包：npm install web-push
      // 动态 import 避免在 TypeScript/ESM 中使用 require
      const WebPush = await import('web-push');
      WebPush.setVapidDetails(
        'mailto:admin@lingxi.engine',
        this.vapidPublicKey,
        this.vapidPrivateKey
      );
      await WebPush.sendNotification({
        endpoint: sub.endpoint,
        keys: sub.keys || { p256dh: '', auth: '' },
      }, payload);
    } catch (err: any) {
      console.error('[Push] Web Push 失败:', err.message);
      throw err;
    }
  }

  /**
   * FCM（Android 推送）
   */
  private async sendFCM(sub: PushSubscription, title: string, body: string, data?: any) {
    if (!this.fcmServerKey) return;
    
    try {
      await fetch('https://fcm.googleapis.com/fcm/send', {
        method: 'POST',
        headers: {
          'Authorization': `key=${this.fcmServerKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: sub.endpoint,
          notification: { title, body, icon: 'ic_stat_icon', color: '#4a9eff' },
          data: data || {},
        }),
      });
    } catch (err: any) {
      throw err;
    }
  }

  /**
   * APNs（iOS 推送）
   */
  private async sendAPNs(sub: PushSubscription, title: string, body: string, data?: any) {
    const teamId = process.env.PUSH_APNS_TEAM_ID;
    const keyId = process.env.PUSH_APNS_KEY_ID;
    const authKey = process.env.PUSH_APNS_KEY;
    if (!teamId || !keyId || !authKey) return;

    try {
      // 生成 APNs JWT（ES256 签名）
      const jwtLib = await import('jsonwebtoken');
      const signFn: any = jwtLib.default || jwtLib;
      const now = Math.floor(Date.now() / 1000);
      const jwt = signFn.sign(
        { iss: teamId, iat: now },
        authKey.replace(/\\n/g, '\n'),
        { algorithm: 'ES256', keyid: keyId }
      );

      const payload = JSON.stringify({
        aps: { alert: { title, body }, sound: 'default', badge: 1 },
        data: data || {},
      });

      await fetch(`https://api.push.apple.com/3/device/${sub.endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'authorization': `bearer ${jwt}`,
          'apns-topic': 'com.lingxi.engine',
          'apns-push-type': 'alert',
        },
        body: payload,
      });
    } catch (err: any) {
      throw err;
    }
  }

  /**
   * 获取 VAPID 公钥（前端注册推送需要）
   */
  getVapidPublicKey(): string | null {
    return this.vapidPublicKey;
  }

  /**
   * 推送是否可用
   */
  isAvailable(): boolean {
    return !!(this.vapidPublicKey || this.fcmServerKey);
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      available: this.isAvailable(),
      vapidConfigured: !!this.vapidPublicKey,
      fcmConfigured: !!this.fcmServerKey,
      apnsConfigured: !!(process.env.PUSH_APNS_TEAM_ID && process.env.PUSH_APNS_KEY_ID),
      subscriptions: this.subscriptions.size,
    };
  }

  /**
   * 保存
   */
  private save() {
    try {
      const data = Array.from(this.subscriptions.values());
      writeFileSync(join(this.dataDir, 'push-subscriptions.json'), JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error('[Push] 保存失败:', err.message);
    }
  }

  /**
   * 加载
   */
  private load() {
    try {
      const file = join(this.dataDir, 'push-subscriptions.json');
      if (!existsSync(file)) return;
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      for (const sub of data) {
        this.subscriptions.set(sub.id, sub);
      }
    } catch {}
  }
}