/* ═══════════════════════════════════════════════════════════
   LingXi Engine — Official Site i18n
   ───────────────────────────────────────────────────────────
   Kept separate from web/js/i18n.js (the in-app one, 264KB, 7 langs).
   The app dictionary serves "people using the product".
   This one serves "people landing on the website" — different
   audience, different keys, no reason to entangle them.

   Default = English (we target global users).
   Fallback = Simplified Chinese.

   Usage in HTML:
     <h1 data-i18n="hero.h1"></h1>
     <p  data-i18n="hero.sub"></p>
     <meta name="description" data-i18n-content="meta.desc">

   API:
     I18N_O.apply()        render everything
     I18N_O.set('en')      switch + persist
     I18N_O.lang           current code
     I18N_O.langs          list
   ═══════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Only advertise languages that actually have a finished dictionary.
     Offering 繁中 / 日本語 here would silently fall back to English on click,
     which is worse than not offering them at all. Add a dict here first,
     then the button appears by itself. */
  var LANGS = [
    { code: 'en', label: 'English',  short: 'EN' },
    { code: 'zh', label: '简体中文', short: '中文' }
  ];

  var STORAGE_KEY = 'lingxi-site-lang';
  var DEFAULT_LANG = 'en';

  /* ═══════════════ English (base) ═══════════════ */
  var en = {
    'meta.title': 'LingXi Engine — An open-source multimodal AI agent that runs on your own machine.',
    'meta.desc': 'LingXi Engine is an open-source, self-hosted multimodal AI agent. Text, images and documents as first-class input, with tool calling, long-term memory and a knowledge base. Runs on your own machine.',
    'meta.keywords': 'AI agent, multimodal AI agent, open source AI, self-hosted AI, local AI assistant, LingXi Engine',

    'nav.brand': 'LingXi Engine',

    'nav.features': 'Features',
    'nav.how': 'How it works',
    'nav.deploy': 'Why Hong Kong',
    'nav.pricing': 'Pricing',
    'nav.faq': 'FAQ',
    'nav.download': 'Download',
    'nav.login': 'Sign in',
    'nav.register': 'Create account',
    'nav.community': 'Community',

    'hero.badge': 'Simulated payments · testing phase',
    'hero.h1': "Your AI isn't just a chatbot. It earns.",
    'hero.sub': 'Every agent on LingXi can publish a skill, take a job, deliver the work, and get paid. Open source, MIT licensed, runs on your own machine.',
    'hero.cta1': 'Download free',
    'hero.cta2': 'See how agents earn',
    'hero.note1': 'Open source · MIT · Self-hosted · Your data stays yours',
    'hero.note2': 'Simulated payments — testing phase',

    'honest.t': '📌 How to get started',
    'honest.p1': '<b class="warn">LingXi Engine is an open-source, self-hosted multimodal AI agent.</b> It runs on your own machine or your own server: text, images and documents all become first-class input. Tool calling, long-term memory, knowledge-base retrieval and multi-channel access are <b>fully implemented and covered by automated tests</b>. <b>Your data never has to leave your machine.</b>',
    'honest.p2': 'We will gradually connect real payment rails and withdrawal review once this simulated settlement layer is stable, and will announce the go-live date on this page. <b>Until then, please do not deposit any real funds here</b>, and do not make investment decisions based on the idea that you can earn money here.',

    'flow.title': 'Four steps to your own AI agent',
    'flow.sub': 'From a fresh download to a working multimodal agent.',
    'flow.s1t': 'Download and install',
    'flow.s1d': 'One package, runs on your own machine.',
    'flow.s2t': 'Connect a model',
    'flow.s2d': "Bring any model API you like, or run a local model.",
    'flow.s3t': 'Teach it your tools',
    'flow.s3d': 'Files, browser, shell, and your own skills.',
    'flow.s4t': 'Reach it anywhere',
    'flow.s4d': 'Web UI, Telegram, WhatsApp and more.',

    'caps.title': 'A real agent runtime, running on your own machine',
    'caps.sub': "Every capability below is already implemented and tested.",
    'caps.1t': 'Multi-model, free switching',
    'caps.1d': 'DeepSeek, Kimi, Qwen, LLM, OpenAI, NVIDIA NIM and local Llama models. One config, every model.',
    'caps.2t': '18 built-in tools',
    'caps.2d': 'Search, code execution, sandboxed commands, file read/write, pipelines, sub-agents. The whole tool-call chain is visible in the reasoning panel.',
    'caps.3t': 'Sandbox safety',
    'caps.3d': 'Command whitelist + Docker isolation + path constraints, so file operations cannot escape the project directory.',
    'caps.4t': 'Visible reasoning',
    'caps.4d': 'Supports reasoning models such as DeepSeek R1 and OpenAI o1. The reasoning chain is streamed on screen, not a black box.',
    'caps.5t': 'Multimodal understanding',
    'caps.5d': 'See images, read documents, and understand screenshots as a first-class input.',
    'caps.6t': 'Private knowledge base',
    'caps.6d': 'Local document indexing plus vectorised retrieval, so your AI answers from your own materials instead of hallucinating. Data never leaves your host.',

    'tag.live': 'Live',
    'tag.soon': 'Simulated settlement · testing',

    'cmp.title': 'What actually works today',
    'cmp.sub': 'Every line below is implemented and tested. The amber rows are the only things not yet real.',
    'cmp.h1': 'Capability',
    'cmp.h2': 'Business rule',
    'cmp.h3': 'Status',
    'cmp.r1t': 'Task posting',
    'cmp.r1d': "Text, images and documents as first-class input",
    'cmp.r1s': 'Live',
    'cmp.r2t': 'Quote vs budget',
    'cmp.r2d': 'When the contract value is below budget, the difference is refunded automatically',
    'cmp.r2s': 'Live',
    'cmp.r3t': 'Acceptance settlement',
    'cmp.r3d': 'Remembers you across sessions and restarts',
    'cmp.r3s': 'Live',
    'cmp.r4t': 'Dispute resolution',
    'cmp.r4d': 'Full release / full refund / partial refund, with a complete audit trail',
    'cmp.r4s': 'Live',
    'cmp.r5t': 'Platform fee',
    'cmp.r5d': 'Any OpenAI-compatible API, plus local models',
    'cmp.r5s': 'Live',
    'cmp.r6t': 'Simulated recharge',
    'cmp.r6d': 'Telegram, WhatsApp, Discord, Slack and more',
    'cmp.r6s': 'Testing',
    'cmp.r7t': 'Real payments',
    'cmp.r7d': 'Opens after a compliant payment channel is connected',
    'cmp.r7s': 'Planned',
    'cmp.r8t': 'Withdrawals',
    'cmp.r8d': 'Internal accounting unit, no withdrawal support yet',
    'cmp.r8s': 'Not open',

    'dep.title': 'Why the server sits in Hong Kong',
    'dep.sub': 'This is a platform for users worldwide. Every node is in Hong Kong.',
    'dep.c1t': 'Global reach, low latency',
    'dep.c1d': 'Hong Kong is a major internet exchange hub. Asia, Europe and North America are all within a few hops, which suits a globally served platform.',
    'dep.c2t': 'A path to real payments',
    'dep.c2d': 'Integrating channels such as Stripe or PayPal requires an offshore compliant entity and a corresponding receiving path. A Hong Kong presence makes that far more direct.',
    'dep.c3t': 'Relatively open policy',
    'dep.c3d': 'Hong Kong is a free-market jurisdiction with clear commercial precedent for cross-border SaaS, added value telecom services and data services, so the compliance path is predictable.',
    'dep.c4t': 'Why not mainland China',
    'dep.c4d': 'Mainland restrictions on cross-border capital settlement, data export and value-added telecom licensing are severe. Many business models cannot be operated compliantly there, and product iteration is limited as a result.',
    'dep.n1t': 'Please note',
    'dep.n1d': 'Choosing Hong Kong is a <b>business positioning and compliance cost</b> consideration. It does not exempt you from any legal obligation: data protection, tax and content compliance still apply in every jurisdiction where users are located. ',
    'dep.n2t': 'Open-source nature is unchanged',
    'dep.n2d': 'The engine is MIT licensed and <b>you can deploy it anywhere</b> — your own VPS, your own host, even a local machine. The official Hong Kong node is only the default hosting option, not a requirement. ',

    'pri.title': 'Pricing',
    'pri.sub': 'Open source, free forever. The engine is MIT licensed and the hosting is entirely up to you. <b style="color:var(--green)">No platform fee</b>, no middleman, and no lock-in.',
    'pri.s1l': 'Engine price (MIT open source)',
    'pri.s2l': 'Service provider keeps per order',
    'pri.s3l': 'Platform channel fee (adjustable 0%–50%)',
    'pri.s4l': 'Your data stays on your machine',
    'pri.s5l': 'Withdrawal handling fee (not yet open)',

    'faq.title': 'Frequently asked questions',
    'faq.sub': 'Straight answers.',
    'faq.q1': 'Do I need to pay to use the engine?',
    'faq.a1': 'No. The engine is MIT open source. You only pay for the model API you choose to connect.',
    'faq.q2': 'Does the engine send my files to a third party?',
    'faq.a2': "It depends on which model you connect. Use a local model and nothing leaves your machine.",
    'faq.q3': 'Why is the server in Hong Kong?',
    'faq.a3': 'Three reasons. First, we target users worldwide and Hong Kong is a low-latency node. Second, real payments later require offshore payment channels and a compliant entity, and Hong Kong connects more directly. Third, Hong Kong policy is relatively open, whereas mainland restrictions on cross-border settlement, data export and value-added telecom services are severe and many models cannot run compliantly.',
    'faq.q4': 'Does Hong Kong hosting avoid regulatory requirements?',
    'faq.a4': 'No. Hong Kong hosting is a commercial and technical choice and exempts no legal obligation. Data protection, tax and content compliance still apply according to the jurisdictions where users are located. This is also why we are open source and support self-hosting.',
    'faq.q5': 'Do I have to use the Hong Kong server?',
    'faq.a5': 'No. The engine is MIT open source. You can deploy it to any cloud host, your own server, or even a local machine. The official Hong Kong node is only the default hosting option.',
    'faq.q6': 'Which models can I connect?',
    'faq.a6': 'Any OpenAI-compatible API, plus local models such as Llama and Qwen.',
    'faq.q7': 'Can I run it on my own server?',
    'faq.a7': 'Yes. That is the recommended way to use it, and your data never leaves your server.',
    'faq.q8': 'Do I need to register?',
    'faq.a8': 'No. Local AI chat needs no registration at all.',
    'faq.q9': 'Will my data go abroad?',
    'faq.a9': 'It depends on which model you use. With a local model such as Ollama nothing leaves the machine at all. With a cloud model it is handled by that provider. The platform sits in the middle layer and stores no conversation content.',

    'dl.title': 'Go and take it for a spin',
    'dl.sub': 'Install with a single PowerShell / Shell command, or download the archive and deploy manually.',
    'dl.win': 'PowerShell one-liner',
    'dl.mac': 'Shell one-liner',
    'dl.linux': 'Shell one-liner',
    'dl.btn': 'Download',
    'dl.or': 'or grab it straight from GitHub',
    'dl.copy': 'Copy',
    'dl.lbl.win': 'Windows',
    'dl.lbl.win2': 'macOS / Linux',
    'dl.lbl.src': 'Source',
    'dl.hint': 'These commands point at the official site (Cloudflare-protected). If they fail, use the manual archive on the download page.',

    'cm.title': 'Community',
    'cm.sub': 'Questions, skill requests, agent ideas. The fastest way to get help is the channels below.',
    'cm.c1t': 'GitHub Discussions',
    'cm.c1d': 'Technical questions, feature requests, bug reports. Open source, public, searchable.',
    'cm.c2t': 'Documentation',
    'cm.c2d': 'Setup guides, model configuration, tool integration and channel setup.',
    'cm.c3t': 'Contributing',
    'cm.c3d': 'Read CONTRIBUTING.md. Issues and pull requests are both welcome.',
    'cm.c4t': 'Build it with us',
    'cm.c4d': 'This is an open-source project built by one person. Open source means you can self-host, self-modify, and self-decide.',
    'dep.n3t': 'Engine evaluation',
    'dep.n3d': 'The engine runtime is a complete implementation, not a prototype. Multimodal input, tool calling, long-term memory and knowledge-base retrieval are all implemented and tested, and everything runs inside a single installation.',

    'cm.cta': 'Join the community',

    'foot.license': 'LingXi Engine · MIT open source',
    'foot.l1': 'GitHub',
    'foot.l2': 'Docs',
    'foot.l3': 'Terms',
    'foot.l4': 'Privacy',
    'foot.fine': 'MIT open source. Runs on your own machine; your data stays yours. The default deployment node is in Hong Kong, serving users worldwide; the engine is open source and you can deploy it in any environment. The Hong Kong deployment does not exempt you from any legal obligation.'
  };

  /* ═══════════════ 简体中文 ═══════════════ */
  var zh = {
    'meta.title': '灵犀引擎 — 你的 AI 不只是聊天，是一个能接活、能收钱的人',
    'meta.desc': '灵犀引擎：开源 AI 智能体平台。每个 AI 都能发布技能、接单赚钱。现为模拟积分结算测试阶段，后期接入真实支付。',
    'meta.keywords': 'AI 智能体、多模态 AI 智能体、公网上 AI、自托管 AI、本地 AI 助手、灵犀引擎',

    'nav.brand': '灵犀引擎',

    'nav.features': '能力',
    'nav.how': '怎么赚钱',
    'nav.deploy': '为什么香港',
    'nav.pricing': '价格',
    'nav.faq': '常见问题',
    'nav.download': '下载',
    'nav.login': '登录',
    'nav.register': '注册',
    'nav.community': '社区',

    'hero.badge': '当前为模拟支付测试阶段',
    'hero.h1': '你的 AI 不只是聊天，是一个能接活、能收钱的人',
    'hero.sub': '灵犀上的每个 AI 都能发布技能、接单、交付、收钱。开源、MIT 许可、跑在你自己机器上。',
    'hero.cta1': '免费下载试用',
    'hero.cta2': '先看看怎么赚钱',
    'hero.note1': '开源 · MIT 许可 · 本地部署 · 数据完全自持',
    'hero.note2': '当前为模拟支付测试阶段',

    'honest.t': '📌 开始使用说明',
    'honest.p1': '<b class="warn">灵犀引擎是一个公网上、可自托管的多模态 AI 智能体。</b>它跑在你自己的电脑或服务器上：文字、图片和文档都是等价的输入。工具调用、长期记忆、知识库检索和多渠道接入都已完成实现并有自动化测试。<b>你的数据根本不必离开你的机器。</b>',
    'honest.p2': '平台会在这套模拟结算稳定之后，<b>逐步接入真实支付通道</b>与提现审核，并在本页明确标注上线时间。<b>在此之前，请勿向本平台充值任何真实资金</b>，也不要基于「在这里能赚钱」做投资决策。',

    'flow.title': '四步启动你的 AI 智能体',
    'flow.sub': '从下载到完成，四步搭建多模态智能体。',
    'flow.s1t': '下载安装',
    'flow.s1d': '一个包，跑在你自己的机器上。',
    'flow.s2t': '接入模型',
    'flow.s2d': '任何模型 API 都行，也可以用本地模型。',
    'flow.s3t': '训练工具',
    'flow.s3d': '文件、浏览器、命令行，以及你自己的技能。',
    'flow.s4t': '随时随地达',
    'flow.s4d': '网页、Telegram、WhatsApp 等多种渠道。',

    'caps.title': '真正能干派的智能体运行时，跑在你自己的机器上',
    'caps.sub': '下列能力均已完成实现并通过测试。',
    'caps.1t': '多模型自由切换',
    'caps.1d': '支持 DeepSeek、Kimi、通义、LLM、OpenAI、NVIDIA NIM、Llama 本地模型。一配置即可用。',
    'caps.2t': '18 个内置工具',
    'caps.2d': '搜索、代码执行、沙箱命令、文件读写、管道、端子代理。工具调用过程全程可观看。',
    'caps.3t': '沙箱清单',
    'caps.3d': '命令白名单 + Docker 隔离 + 路径约束，文件操作不能越出项目目录。',
    'caps.4t': '思维链可观看',
    'caps.4d': '支持 DeepSeek R1 / OpenAI o1 等推理模型，思考链流式展示，不是黑盒。',
    'caps.5t': '多模态理解',
    'caps.5d': '能看图、读文档，截图也能直接理解。',
    'caps.6t': '私人知识库',
    'caps.6d': '本地文档索引 + 向量化检索，让 AI 基于你的资料回答，数据不出本机。',

    'tag.live': '已上线',
    'tag.soon': '模拟结算测试中',

    'cmp.title': '哪些是真能用的',
    'cmp.sub': '下面每一行都已经实现并通过测试，黄色行是唯一还没变成真的部分。',
    'cmp.h1': '能力项',
    'cmp.h2': '业务规则',
    'cmp.h3': '状态',
    'cmp.r1t': '任务发布',
    'cmp.r1d': '文字、图片和文档都是等价的输入',
    'cmp.r1s': '已跑通',
    'cmp.r2t': '预算 vs 报价',
    'cmp.r2d': '成交额 < 预算时，差额自动退回',
    'cmp.r2s': '已跑通',
    'cmp.r3t': '验收结算',
    'cmp.r3d': '跨会话、跨重启仍然记得你',
    'cmp.r3s': '已跑通',
    'cmp.r4t': '争议仲裁',
    'cmp.r4d': '全额释放 / 全额退款 / 部分退款，链路留痕',
    'cmp.r4s': '已跑通',
    'cmp.r5t': '平台抽佣',
    'cmp.r5d': '任意齐序的 OpenAI 兼容 API，以及本地模型',
    'cmp.r5s': '已跑通',
    'cmp.r6t': '模拟充值',
    'cmp.r6d': 'Telegram、WhatsApp、Discord、Slack 等多种渠道',
    'cmp.r6s': '测试中',
    'cmp.r7t': '真实支付',
    'cmp.r7d': '接好合规支付通道后开放',
    'cmp.r7s': '规划中',
    'cmp.r8t': '提现',
    'cmp.r8d': '内部记账单位，暂不支持提现',
    'cmp.r8s': '未开放',

    'dep.title': '为什么服务器放在香港',
    'dep.sub': '这是一个面向全球用户的平台，所有节点都在香港。',
    'dep.c1t': '全球可达，延迟低',
    'dep.c1d': '香港是亚太骨干网枢纽，访问欧美、东南亚均处于低延迟区间，适合做全球服务的入口节点。',
    'dep.c2t': '为接真实支付铺路',
    'dep.c2d': '后期要接 Stripe、PayPal 这类国际支付通道，需要境外合规主体与可对接的收款路径。香港的支付生态与国际通道更顺。',
    'dep.c3t': '政策相对宽松',
    'dep.c3d': '香港是自由市场司法辖区，对跨境 SaaS、增值结算、跨境数据服务有明确的商业惯例，合规路径可预期。',
    'dep.c4t': '为什么不在中国大陆',
    'dep.c4d': '大陆对跨境资金结算、数据出境、增值电信业务许可等限制较多，很多业务形态无法合法开展，也直接限制了产品迭代。',
    'dep.n1t': '说明',
    'dep.n1d': '选择香港节点是出于<b>业务定位与合规成本</b>的考量，<b>不代表可以规避任何法定义务</b>：用户数据处理、个人信息保护、税务申报、内容合规，仍需按用户所在地法域分别遵守。',
    'dep.n2t': '开源性质不变',
    'dep.n2d': '引擎本身 MIT 许可，<b>你可以自部署到任何地方</b> —— 包括大陆服务器、自己的云主机，甚至本地环境。官方香港节点只是默认托管选项，不是强制。',

    'pri.title': '价格',
    'pri.sub': '开源项目永久免费。引擎本身 MIT 许可，托管全赵你自己。<b style="color:var(--green)">无平台费用</b>，无中间商，也无锁定。',
    'pri.s1l': '引擎本体价格（MIT 开源）',
    'pri.s2l': '服务方每单实收',
    'pri.s3l': '平台通道费（可调 0%–50%）',
    'pri.s4l': '你的数据留在你自己机器上',
    'pri.s5l': '提现手续费（未开放）',

    'faq.title': '常见问题',
    'faq.sub': '答案不绕弯。',
    'faq.q1': '使用引擎需要付费吗？',
    'faq.a1': '不用。公网上优出的 MIT 许可，你只需付濠你自己选的模型 API 费。',
    'faq.q2': '引擎会把我的文件传给第三方吗？',
    'faq.a2': '优先级用性守卫。接入本地模型，你的文件根本不出你的机器。',
    'faq.q3': '为什么服务器要放香港？',
    'faq.a3': '三个原因：一是面向全球用户，香港是低延迟的实际骨干节点；二是后期接真实支付需要境外支付通道与合规主体，香港接得更顺；三是香港政策相对宽松，而大陆对跨境结算、数据出境、增值电信业务限制较多，很多模式无法合法开展。',
    'faq.q4': '放香港能规避监管吗？',
    'faq.a4': '不能。香港部署只是商业和技术选择，不豁免任何法定义务，数据保护、税务、内容合规仍需按各法域要求遵守。这也是我们坚持开源、支持自部署的原因。',
    'faq.q5': '我必须用香港的服务器吗？',
    'faq.a5': '不是。引擎是 MIT 开源的，你可以部署到任何云主机、自己的服务器，甚至纯本地环境。官方香港节点只是默认的托管选项。',
    'faq.q6': '我能接入哪些模型？',
    'faq.a6': '任意齐序的 OpenAI 兼容 API，以及 Llama、Qwen 等本地模型。',
    'faq.q7': '可以部署到我自己的服务器吗？',
    'faq.a7': '可以。这也是推荐的用法，你的数据不会出你的服务器。',
    'faq.q8': '需要注册吗？',
    'faq.a8': '不用。本地 AI 对话完全不需要注册。',
    'faq.q9': '数据会传到国外吗？',
    'faq.a9': '取决于你选的模型：用 Ollama 本地模型则完全不外本机；用云端模型则由对应厂商处理。平台在中间层，不存储对话内容。',

    'dl.title': '现在去把它拉下来',
    'dl.sub': 'PowerShell / Shell 一行命令安装，或直接下载压缩包手动部署。',
    'dl.win': 'PowerShell 一行命令',
    'dl.mac': 'Shell 一行命令',
    'dl.linux': 'Shell 一行命令',
    'dl.btn': '下载',
    'dl.or': '或直接打开 GitHub',
    'dl.copy': '复制',
    'dl.lbl.win': 'Windows',
    'dl.lbl.win2': 'macOS / Linux',
    'dl.lbl.src': '源码',
    'dl.hint': '以上命令均指向正式官网（Cloudflare 防护）。若执行失败，可前往下载页使用手动安装包。',

    'cm.title': '社区',
    'cm.sub': '有问题、想提技能需求、想聊 Agent 想法，都可以来下面这几个地方。',
    'cm.c1t': 'GitHub Discussions',
    'cm.c1d': '技术提问、功能建议、Bug 报告。开源、公开、可搜索。',
    'cm.c2t': '开发文档',
    'cm.c2d': '安装指南、模型配置、工具接入与渠道配置。',
    'cm.c3t': '参与贡献',
    'cm.c3d': '先读 CONTRIBUTING.md，Issue 和 PR 都欢迎。',
    'cm.c4t': '一起把它做起来',
    'cm.c4d': '这是一个一个人做的开源项目。开源意味着你可以自部署、自修改、自作主张。',
    'dep.n3t': '引擎评估',
    'dep.n3d': '引擎运行时是完整实现，而非原型。多模态输入、工具调用、长期记忆与知识库检索均已实现并通过测试，且全部集中在一次安装内。',

    'cm.cta': '加入社区',

    'foot.license': '灵犀引擎 · MIT 开源',
    'foot.l1': 'GitHub',
    'foot.l2': '文档',
    'foot.l3': '服务协议',
    'foot.l4': '隐私政策',
    'foot.fine': '公网上优出的 MIT 许可，跑在你自己的机器上，你的文件永远属于你。默认部署节点在香港，面向全球用户；你也可以在任意环境自建部署。香港部署不会使你免除任何法律义务。'
  };

  var DICTS = { 'en': en, 'zh': zh };

  var current = DEFAULT_LANG;

  function t(key) {
    var d = DICTS[current] || en;
    if (d[key] !== undefined) return d[key];
    if (en[key] !== undefined) return en[key];
    return key;
  }

  function detect() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && DICTS[saved]) return saved;
    } catch (e) {}
    var nav = (navigator.language || 'en').toLowerCase();
    if (nav.indexOf('zh') === 0) {
      return (nav.indexOf('tw') >= 0 || nav.indexOf('hk') >= 0 || nav.indexOf('hant') >= 0) ? 'zh' : 'zh';
    }
    return 'en';
  }

  function applyMeta() {
    var title = t('meta.title');
    var desc = t('meta.desc');
    var kw = t('meta.keywords');
    if (document.title) document.title = title;
    var mt = document.querySelector('meta[name="description"]');
    if (mt) mt.setAttribute('content', desc);
    var mk = document.querySelector('meta[name="keywords"]');
    if (mk) mk.setAttribute('content', kw);
    var ogT = document.querySelector('meta[property="og:title"]');
    if (ogT) ogT.setAttribute('content', title);
    var ogD = document.querySelector('meta[property="og:description"]');
    if (ogD) ogD.setAttribute('content', desc);
  }

  function apply() {
    document.documentElement.lang = (current === 'zh') ? 'zh-Hans' : current;
    document.documentElement.setAttribute('data-lang', current);
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    applyMeta();
    document.querySelectorAll('.lang-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-lang-code') === current);
    });
  }

  function set(lang) {
    if (!DICTS[lang]) lang = DEFAULT_LANG;
    current = lang;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
    apply();
  }

  function buildSwitcher(container) {
    if (!container) return;
    container.innerHTML = '';
    LANGS.forEach(function (l) {
      var b = document.createElement('button');
      b.className = 'lang-btn' + (l.code === current ? ' active' : '');
      b.setAttribute('data-lang-code', l.code);
      b.textContent = l.short;
      b.title = l.label;
      b.addEventListener('click', function () { set(l.code); });
      container.appendChild(b);
    });
  }

  current = detect();

  global.I18N_O = {
    langs: LANGS,
    get lang() { return current; },
    t: t,
    apply: apply,
    set: set,
    buildSwitcher: buildSwitcher
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); });
  } else {
    apply();
  }
})(window);
