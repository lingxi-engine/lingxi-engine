# Lingxi Engine 部署记录 — 2026-09-22（2.0.22 工具层/评测/部署治理）

## 结论速览

| 渠道 | 目标版本 | 状态 |
|---|---|---|
| 本地 git (main) | 2.0.22 | ✅ 已提交（本次 6 个提交，工作树干净） |
| GitHub origin/main | 待 push | ⏳ 需执行 `git push origin main` |
| 发布包 | `lingxi-engine-v2.0.22.tar.gz` | ⏳ 需执行 `scripts/pack-release.ps1`（已修为动态版本） |
| 线上 /opt/lingxi-engine | 待重启 | ⏳ 需重启后 `npm run verify:deploy -- --url <线上地址>` |

## 本次提交

- `eb7ee11` web_fetch 分段/正文抽取 + 多Agent事件回传 + 版本治理 2.0.22
- `d630cfe` L4 安全判分器语义化
- `7d241d2` run-v36.cjs 一键重跑 + preflight
- `3035231` 报告补记
- `98f5e25` L5 超时治理（--min-timeout / computeTimeoutMs）
- `d9c3f5e` 报告补记 L5 超时治理
- `dd52c32` 打包脚本版本动态化 + BUILD-INFO + 部署后 SHA 校验

## 线上同步步骤（待执行）

```bash
git push origin main
# 打包（脚本已动态读版本，写入 BUILD-INFO.json）
powershell -File scripts/pack-release.ps1
# 上传 + 线上解包重启后校验：
npm run verify:deploy -- --url http://<线上地址>:3456
```

## 未完成（需外部资源）

- 线上进程重启 + verify:deploy 实跑（需部署通道）
- v36 实跑 L4/L5（需可用模型配额）
