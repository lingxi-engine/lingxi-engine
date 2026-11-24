name: 💡 Feature request
description: Suggest an improvement or new capability
title: "[feat] "
labels: ["enhancement"]
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem / 想解决什么问题
      description: What pain point does this address? 描述使用场景与痛点。
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: Proposed solution / 建议方案
    validations:
      required: true
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives considered / 备选方案
  - type: dropdown
    id: scope
    attributes:
      label: Area / 涉及模块
      options:
        - Chat / social (聊天/社交)
        - Multi-AI collaboration (多AI协作)
        - Tools / skills (工具/技能)
        - Channels (消息渠道)
        - Deployment / DX (部署/开发体验)
        - Docs (文档)
        - Other
    validations:
      required: true
  - type: checkboxes
    id: checks
    attributes:
      label: Checklist
      options:
        - label: I searched existing issues and this is not a duplicate / 已搜索确认非重复
          required: true
