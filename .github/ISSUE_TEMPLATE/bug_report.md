name: 🐛 Bug report
description: Something is broken or behaves unexpectedly
title: "[bug] "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: |
        Thanks for taking the time to report a bug!
        提交前请先搜索已有 issue，避免重复。Security vulnerabilities: see SECURITY.md (do NOT report publicly).
  - type: input
    id: version
    attributes:
      label: LingXi version / 版本
      description: "Shown at startup, in /api/health, or `package.json` (e.g. 2.0.42)"
    validations:
      required: true
  - type: dropdown
    id: area
    attributes:
      label: Affected area / 涉及模块
      options:
        - Chat / friends / groups (聊天/好友/群组)
        - Multi-AI collaboration (多AI交流)
        - AI providers / model routing (模型接入/路由)
        - Tools / sandbox (工具/沙箱)
        - Channels (Telegram/Discord/...)
        - Mobile app / remote control (手机/远程)
        - Cross-engine mesh / LAN (跨引擎组网)
        - Docker / deployment (部署)
        - Other
    validations:
      required: true
  - type: textarea
    id: what-happened
    attributes:
      label: What happened? / 发生了什么
      description: Actual behavior vs. expected behavior. 实际表现与期望表现。
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Steps to reproduce / 复现步骤
      placeholder: |
        1. Start engine with ...
        2. Send message ...
        3. See error ...
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant logs / 相关日志
      description: Engine console output around the failure. REDACT API keys and tokens! 注意脱敏！
      render: shell
  - type: input
    id: env
    attributes:
      label: Environment / 运行环境
      placeholder: "Windows 11 / Node 24 / npm start  —or—  Ubuntu 22.04 / Docker"
    validations:
      required: true
