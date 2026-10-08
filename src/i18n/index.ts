export type Lang = 'en' | 'zh';
export type Status = 'live' | 'planned';

export interface Chapter {
  /** the product's role, shown in the meta row */
  tag: string;
  title: string;
  kicker: string;
  body: string;
}

export interface Dict {
  lang: Lang;
  htmlLang: string;
  path: string;
  meta: { title: string; description: string };
  nav: {
    label: string;
    ring: string;
    space: string;
    assistant: string;
    harness: string;
    openSource: string;
    openMenu: string;
    closeMenu: string;
    langSwitch: string;
    langSwitchLabel: string;
    skip: string;
    chapters: string;
    home: string;
  };
  hero: {
    title: [string, string];
    /** one sentence per line on wide screens */
    lede: string[];
    primary: string;
    secondary: string;
    scroll: string;
  };
  status: Record<Status, string> & { preview: string };
  account: {
    signIn: string;
    signOut: string;
    /** the account button's name once signed in */
    label: string;
    title: string;
    lede: string;
    github: string;
    google: string;
    /** shown under the providers when not empty */
    note: string;
    /** before the terms link, the terms, between, the privacy policy, after */
    consent: [string, string, string, string, string];
    failed: string;
    signOutFailed: string;
    redirecting: string;
    close: string;
    /** the ring card view of the dialog: share the card, choose what it shows */
    card: {
      /** the signed-in view's button that opens it */
      open: string;
      title: string;
      back: string;
      /** what the options are about, for screen readers */
      show: string;
      showName: string;
      showImage: string;
      loading: string;
      private: string;
      shared: string;
      stopped: string;
      share: string;
      link: string;
      copy: string;
      copied: string;
      native: string;
      post: string;
      save: string;
      stop: string;
      failed: string;
      /** what a post on X says before the link; {n} is the ring number */
      postText: string;
    };
  };
  /** a shared ring card's page, /ring/<number>/ */
  ring: {
    eyebrow: string;
    /** the page's heading: the holder's ring, by name when the card shows it */
    heading: (number: number, name: string | null) => string;
    /** under it: when the ring was forged, then what SpaceRing is */
    lede: (forged: string) => string;
    /** the page's description for search and link previews */
    description: (number: number, name: string | null, forged: string) => string;
    /** the button, as it reads to someone signed out, signed in, and to the card's holder */
    claim: string;
    shareOwn: string;
    manage: string;
    about: string;
  };
  loader: string;
  scramble: string;
  dial: string[];
  /** The example assistant that turns up in every hologram. Users name their own. */
  assistantName: string;
  space: Chapter & {
    /** the chapter's button to the product's page */
    actions: { plan: string };
    holo: {
      label: string;
      encrypted: string;
      query: string;
      hits: { kind: string; name: string; from: string }[];
      usage: { label: string; value: string; share: number }[];
    };
  };
  assistant: Chapter & {
    actions: { plan: string };
    holo: {
      role: string;
      online: string;
      rows: { time: string; text: string; kind: 'done' | 'working' | 'ask'; p?: number }[];
      done: string;
      approve: string;
      later: string;
      memory: string;
    };
  };
  harness: Chapter & {
    actions: { enter: string };
    holo: {
      label: string;
      summary: string;
      rows: { kind: string; slug: string; desc: string; installs: string }[];
      equipping: string;
    };
  };
  relay: Chapter & {
    holo: { hub: string; nodes: { name: string; ms: number; relayed?: boolean }[]; caption: string };
  };
  signet: Chapter & {
    holo: {
      label: string;
      summary: string;
      grants: { who: string; scope: string; access: string; expires: string; expired?: boolean }[];
      revoke: string;
      audit: string;
    };
  };
  codeg: Chapter & {
    actions: { github: string; docs: string; download: string };
    stats: { stars: string; forks: string };
    holo: {
      title: string;
      summary: string;
      rows: { agent: string; task: string; state: string; diff: string; p: number; done?: boolean }[];
      platforms: string;
    };
  };
  open: {
    title: string;
    body: string;
    roadmap: string;
    actions: { org: string; star: string };
    footer: string;
    privacy: string;
    terms: string;
  };
  /** the page for an address with nothing behind it */
  notFound: {
    title: string;
    heading: string;
    lede: string;
    home: string;
    harness: string;
  };
  /** the theme switch, on every page but the homepage */
  theme: {
    label: string;
    light: string;
    dark: string;
    system: string;
  };
  menu: {
    label: string;
    destinations: string;
    elsewhere: string;
    items: { key: string; name: string; desc: string; status: Status }[];
    external: { key: string; name: string; desc: string }[];
    chartLabel: string;
  };
}

const en: Dict = {
  lang: 'en',
  htmlLang: 'en',
  path: '/',
  meta: {
    title: 'SpaceRing — Your digital world, in a space ring',
    description:
      'SpaceRing is a space ring for the network. Your data, devices, identity and the AI that works for you, linked into one ring you carry anywhere and manage in one place. The Harness marketplace is open; coming next to the ring: Space, a personal assistant, Relay and Signet.',
  },
  nav: {
    label: 'Primary',
    ring: 'Ring',
    space: 'Space',
    assistant: 'Assistant',
    harness: 'Harness',
    openSource: 'Open source',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    langSwitch: '中文',
    langSwitchLabel: '切换到中文',
    skip: 'Skip intro',
    chapters: 'Chapters',
    home: 'SpaceRing home',
  },
  hero: {
    title: ['Your digital world,', 'in a space ring.'],
    lede: [
      'Your data, your devices, your identity and the AI that works for you, linked into one ring over the network.',
      'Carry it anywhere, manage it in one place. It answers only to you.',
    ],
    primary: 'Open the ring',
    secondary: 'GitHub',
    scroll: 'Scroll to project',
  },
  status: { live: 'Live', planned: 'Planned', preview: 'Concept preview' },
  account: {
    signIn: 'Sign in',
    signOut: 'Sign out',
    label: 'Your account',
    title: 'Sign in to SpaceRing',
    lede: 'Your ring number is engraved on the band.',
    github: 'Continue with GitHub',
    google: 'Continue with Google',
    note: '',
    consent: ['By continuing you agree to the ', 'Terms of Service', ' and the ', 'Privacy Policy', '.'],
    failed: 'Sign-in did not finish. Please try again.',
    signOutFailed: 'Sign-out did not finish. Please try again.',
    redirecting: 'Redirecting…',
    close: 'Close',
    card: {
      open: 'Share your ring card',
      title: 'Your ring card',
      back: 'Back',
      show: 'What the card shows',
      showName: 'Show my name',
      showImage: 'Show my picture',
      loading: 'Loading your card…',
      private: 'Only you can see this card. Share it to get a link.',
      shared: 'Shared. Anyone with the link can see this card.',
      stopped: 'Sharing stopped. The link no longer opens your card.',
      share: 'Share card',
      link: 'Link to your card',
      copy: 'Copy',
      copied: 'Copied',
      native: 'Share…',
      post: 'Post on X',
      save: 'Save image',
      stop: 'Stop sharing',
      failed: 'That did not go through. Please try again.',
      postText: 'My ring on SpaceRing: SRN {n}',
    },
  },
  ring: {
    eyebrow: 'Ring card',
    heading: (number, name) => (name ? `${name}’s space ring` : `Space ring SRN ${number}`),
    lede: (forged) => `Forged on ${forged}. SpaceRing links your data, your devices, your identity and the AI that works for you into one ring you carry anywhere.`,
    description: (number, name, forged) => `${name ? `${name} holds ` : ''}ring SRN ${number} on SpaceRing, forged on ${forged}. Your digital world, in a space ring.`,
    claim: 'Get your own ring',
    shareOwn: 'Share your ring card',
    manage: 'Manage your card',
    about: 'What is SpaceRing',
  },
  loader: 'Calibrating orbit',
  scramble: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  dial: ['Ring', 'Space', 'Assistant', 'Harness', 'Relay', 'Signet', 'Codeg', 'Open source'],
  assistantName: 'Aster',
  space: {
    tag: 'Personal assets',
    title: 'Space',
    kicker: 'Bigger on the inside.',
    body: 'The room inside your ring. Files, photos, notes, links and your assistant’s memory live together, encrypted, and one search reaches all of it. Whatever already sits in other drives and apps can move in too.',
    actions: { plan: 'See the plan' },
    holo: {
      label: 'space · 248.6 GB',
      encrypted: 'encrypted',
      query: 'iceland trip',
      hits: [
        { kind: 'photo', name: 'IMG_2041.heic', from: 'Reykjavík · Apr 3' },
        { kind: 'pdf', name: 'boarding-pass.pdf', from: 'from Mail' },
        { kind: 'note', name: 'Ring Road itinerary', from: 'Notes' },
        { kind: 'memory', name: 'Prefers a window seat', from: 'learned in chat' },
      ],
      usage: [
        { label: 'files', value: '12.4k', share: 0.36 },
        { label: 'photos', value: '8.9k', share: 0.3 },
        { label: 'notes', value: '1.2k', share: 0.12 },
        { label: 'links', value: '3.4k', share: 0.13 },
        { label: 'memory', value: '642', share: 0.09 },
      ],
    },
  },
  assistant: {
    tag: 'Personal AI',
    title: 'Personal assistant',
    kicker: 'Always on, and only yours.',
    body: 'Give it a name and a goal. While you are away it keeps working on its own cloud machine, looks things up in your Space, and asks before anything sensitive. What it remembers stays in your ring.',
    actions: { plan: 'See the plan' },
    holo: {
      role: 'your assistant',
      online: 'online · 3 tasks',
      rows: [
        { time: '07:30', text: 'Morning brief is ready, 3 items', kind: 'done' },
        { time: '09:12', text: 'Dentist moved to Thu 15:00', kind: 'done' },
        { time: '10:05', text: 'Expense report from 6 receipts in Space', kind: 'working', p: 0.62 },
        { time: '11:40', text: 'Pay $180 to Lumen Studio?', kind: 'ask' },
      ],
      done: 'done',
      approve: 'Approve',
      later: 'Later',
      memory: 'Memory stays in your Space · 642 things learned',
    },
  },
  harness: {
    tag: 'Marketplace',
    title: 'Harness',
    kicker: 'Put raw intelligence to work.',
    body: 'Skills, MCP servers, prompts, assistants and connectors in one marketplace. Every listing shows its author, version and the permissions it needs, and installs in one step into your personal assistant, Codeg or any compatible client.',
    actions: { enter: 'Enter Harness' },
    holo: {
      label: 'harness · market',
      summary: '5 kinds · one install',
      rows: [
        { kind: 'skill', slug: 'pdf-forms', desc: 'Fill and sign PDF forms', installs: '18.2k' },
        { kind: 'mcp', slug: 'postgres', desc: 'Query and inspect databases', installs: '9.6k' },
        { kind: 'prompt', slug: 'weekly-review', desc: 'A Friday retro in five questions', installs: '4.1k' },
        { kind: 'assistant', slug: 'trip-planner', desc: 'Plans, compares and books trips', installs: '2.7k' },
        { kind: 'connector', slug: 'google-drive', desc: 'Bring Drive files into Space', installs: '31k' },
      ],
      equipping: 'Equipping',
    },
  },
  relay: {
    tag: 'Network',
    title: 'Relay',
    kicker: 'Miles away, at your fingertips.',
    body: 'Join your laptop, phone, home server and cloud drives into one private network. Files and running sessions stay where they are and remain reachable, end-to-end encrypted, with no ports to open. Lend your assistant a machine when it needs one.',
    holo: {
      hub: 'your ring',
      nodes: [
        { name: 'laptop', ms: 3 },
        { name: 'phone', ms: 18 },
        { name: 'home-nas', ms: 41, relayed: true },
        { name: 'aster-vm', ms: 12 },
        { name: 'cloud-drive', ms: 24 },
        { name: 'studio-pc', ms: 6 },
      ],
      caption: '6 devices · 5 direct, 1 relayed · end-to-end encrypted',
    },
  },
  signet: {
    tag: 'Identity',
    title: 'Signet',
    kicker: 'Long before passwords, a ring proved who you were.',
    body: 'Signet keeps your identity, passwords and API keys. When an assistant or app needs access, you hand it a key that opens one door for a set time. Every use is signed and logged, and any key can be taken back in one tap.',
    holo: {
      label: 'signet · keys in use',
      summary: '2 active',
      grants: [
        { who: 'Aster', scope: 'space/receipts', access: 'read', expires: '6 days left' },
        { who: 'Codeg', scope: 'github/acme-web', access: 'write', expires: 'this session' },
        { who: 'trip-planner', scope: 'calendar', access: 'read', expires: 'expired', expired: true },
      ],
      revoke: 'revoke',
      audit: '11:40:07 · Aster paid $180 · signed by you with a passkey',
    },
  },
  codeg: {
    tag: 'Open source 01',
    title: 'Codeg',
    kicker: 'The multi-agent coding workspace.',
    body: 'Fifteen coding agents in one workspace, including Claude Code, Codex and OpenCode. Resume any agent’s session, delegate with an @, and run tasks in parallel worktrees.',
    actions: { github: 'View on GitHub', docs: 'Read the docs', download: 'Download' },
    stats: { stars: 'stars', forks: 'forks' },
    holo: {
      title: 'codeg · workspace',
      summary: '4 agents · 3 running',
      rows: [
        { agent: 'Claude Code', task: 'Refactor auth middleware', state: 'editing', diff: '+128 −34', p: 0.72 },
        { agent: 'Codex', task: 'Write migration tests', state: 'testing', diff: '+56 −2', p: 0.46 },
        { agent: 'OpenCode', task: 'Review PR #212', state: 'reviewing', diff: '', p: 0.28 },
        { agent: 'Pi', task: 'Update API docs', state: 'done', diff: '+41 −9', p: 1, done: true },
      ],
      platforms: 'macOS · Windows · Linux · Docker · iOS · Android',
    },
  },
  open: {
    title: 'Forged in the open.',
    body: 'SpaceRing is built in public at github.com/spacering-net. Codeg and Harness have shipped, and the rest of the ring is still on the anvil.',
    roadmap: 'Roadmap',
    actions: { org: 'Follow spacering-net', star: 'Star Codeg' },
    footer: 'SpaceRing · spacering.net',
    privacy: 'Privacy',
    terms: 'Terms',
  },
  notFound: {
    title: 'Not found · SpaceRing',
    heading: 'This page is not in the ring.',
    lede: 'The address may be mistyped, or what was here has moved on. The ring is still where you left it.',
    home: 'Back to the ring',
    harness: 'Browse Harness',
  },
  theme: {
    label: 'Theme',
    light: 'Light',
    dark: 'Dark',
    system: 'As the system',
  },
  menu: {
    label: 'Site menu',
    destinations: 'Products',
    elsewhere: 'Elsewhere',
    items: [
      { key: 'space', name: 'Space', desc: 'Your files, notes and memories, encrypted', status: 'planned' },
      { key: 'assistant', name: 'Personal assistant', desc: 'Always on, working while you are away', status: 'planned' },
      { key: 'harness', name: 'Harness', desc: 'Skills · MCP · prompts · assistants · connectors', status: 'live' },
      { key: 'relay', name: 'Relay', desc: 'Every device on one private network', status: 'planned' },
      { key: 'signet', name: 'Signet', desc: 'Identity, keys and permissions', status: 'planned' },
      { key: 'codeg', name: 'Codeg', desc: 'Open-source multi-agent coding workspace', status: 'live' },
    ],
    external: [
      { key: 'docs', name: 'Codeg docs', desc: 'docs.codeg.app' },
      { key: 'github', name: 'GitHub', desc: 'github.com/spacering-net' },
    ],
    chartLabel: 'Orbit chart: the SpaceRing mark at the centre, each product on its own orbit. Codeg and Harness, the live ones, are lit.',
  },
};

const zh: Dict = {
  lang: 'zh',
  htmlLang: 'zh-CN',
  path: '/zh/',
  meta: {
    title: 'SpaceRing 网络空间戒指 — 把数字世界，收进空间戒指',
    description:
      'SpaceRing 网络空间戒指：通过网络，把数据、设备、身份，以及替你做事的 AI 与它的能力连进同一枚戒指，随身携带，统一管理。Harness 综合市场已经上线，空间、个人助手、Relay 与 Signet 正在规划中。',
  },
  nav: {
    label: '主导航',
    ring: '戒指',
    space: '空间',
    assistant: '助手',
    harness: '驾驭',
    openSource: '开源',
    openMenu: '打开菜单',
    closeMenu: '关闭菜单',
    langSwitch: 'EN',
    langSwitchLabel: 'Switch to English',
    skip: '跳过开场',
    chapters: '章节',
    home: 'SpaceRing 首页',
  },
  hero: {
    title: ['把数字世界，', '收进空间戒指。'],
    lede: ['数据、设备、身份，还有替你做事的 AI 与它的能力，都是你的数字资产。', '通过网络把它们连进同一枚戒指：随身携带，统一管理，只听你的。'],
    primary: '打开戒指',
    secondary: 'GitHub',
    scroll: '滚动，开始投射',
  },
  status: { live: '已上线', planned: '规划中', preview: '概念预览' },
  account: {
    signIn: '登录',
    signOut: '退出登录',
    label: '你的账号',
    title: '登录 SpaceRing',
    lede: '登录后，你的编号会刻在戒身上。',
    github: '使用 GitHub 登录',
    google: '使用 Google 登录',
    note: '中国大陆网络下可能无法使用 Google 登录。',
    consent: ['继续即表示你同意', '《用户协议》', '和', '《隐私政策》', '。'],
    failed: '登录没有完成，请再试一次。',
    signOutFailed: '退出没有完成，请再试一次。',
    redirecting: '正在跳转…',
    close: '关闭',
    card: {
      open: '分享戒指卡片',
      title: '你的戒指卡片',
      back: '返回',
      show: '卡片上显示的内容',
      showName: '显示我的名字',
      showImage: '显示我的头像',
      loading: '正在取出你的卡片…',
      private: '这张卡片只有你能看到。分享后会生成一个链接。',
      shared: '已分享。拿到链接的人都能看到这张卡片。',
      stopped: '已停止分享，链接不再打开你的卡片。',
      share: '分享卡片',
      link: '卡片链接',
      copy: '复制',
      copied: '已复制',
      native: '分享到…',
      post: '发到 X',
      save: '保存图片',
      stop: '停止分享',
      failed: '没有成功，请再试一次。',
      postText: '我的空间戒指：SRN {n}',
    },
  },
  ring: {
    eyebrow: '戒指卡片',
    heading: (number, name) => (name ? `${name} 的空间戒指` : `空间戒指 SRN ${number}`),
    lede: (forged) => `锻造于 ${forged}。SpaceRing 把数据、设备、身份，还有替你做事的 AI 连进同一枚戒指：随身携带，统一管理，只听你的。`,
    description: (number, name, forged) => `${name ? `${name} 的` : ''}空间戒指 SRN ${number}，锻造于 ${forged}。把数字世界，收进空间戒指。`,
    claim: '领取你的戒指',
    shareOwn: '分享你的戒指卡片',
    manage: '管理这张卡片',
    about: '了解 SpaceRing',
  },
  loader: '正在校准轨道',
  scramble: '网络空间戒指星环轨道节点投射光束',
  dial: ['戒指', '空间', '助手', 'Harness', 'Relay', 'Signet', 'Codeg', '开源'],
  assistantName: '小星',
  space: {
    tag: '个人资产',
    title: '空间',
    kicker: '方寸之间，自有乾坤。',
    body: '戒指里的那方天地。文件、照片、笔记、收藏，连同助手对你的记忆，都加密存放在一起，一次搜索就能找到。散落在网盘和各个应用里的东西，也能一并收进来。',
    actions: { plan: '查看规划' },
    holo: {
      label: '空间 · 248.6 GB',
      encrypted: '已加密',
      query: '冰岛之行',
      hits: [
        { kind: '照片', name: 'IMG_2041.heic', from: '黑沙滩 · 4 月 3 日' },
        { kind: '文档', name: '登机牌.pdf', from: '来自邮箱' },
        { kind: '笔记', name: '环岛自驾路线', from: '备忘录' },
        { kind: '记忆', name: '喜欢靠窗的座位', from: '来自对话' },
      ],
      usage: [
        { label: '文件', value: '12.4k', share: 0.36 },
        { label: '照片', value: '8.9k', share: 0.3 },
        { label: '笔记', value: '1.2k', share: 0.12 },
        { label: '收藏', value: '3.4k', share: 0.13 },
        { label: '记忆', value: '642', share: 0.09 },
      ],
    },
  },
  assistant: {
    tag: '个人 AI',
    title: '个人助手',
    kicker: '全天候在线，只属于你。',
    body: '给它起个名字，交代一个目标。你不在的时候，它在自己的云端机器上继续工作，需要时翻阅你的空间，遇到敏感操作先征求你的同意。它记住的一切，都留在你的戒指里。',
    actions: { plan: '查看规划' },
    holo: {
      role: '你的助手',
      online: '在线 · 3 项任务',
      rows: [
        { time: '07:30', text: '晨间简报已备好，共 3 件事', kind: 'done' },
        { time: '09:12', text: '牙医改约到周四 15:00', kind: 'done' },
        { time: '10:05', text: '用空间里的 6 张票据整理报销单', kind: 'working', p: 0.62 },
        { time: '11:40', text: '向 Lumen 工作室付款 ¥1,280？', kind: 'ask' },
      ],
      done: '已完成',
      approve: '批准',
      later: '稍后',
      memory: '记忆只存放在你的空间 · 已记住 642 件关于你的事',
    },
  },
  harness: {
    tag: '综合市场',
    title: 'Harness',
    kicker: '让 AI 的能力，落到实处。',
    body: '技能、MCP 服务、提示词、助手与连接器，汇集在同一个市场。每一项都写明作者、版本和所需权限，一步装进你的个人助手、Codeg 或任何兼容的客户端。',
    actions: { enter: '进入 Harness' },
    holo: {
      label: 'Harness · 市场',
      summary: '5 类能力 · 一步安装',
      rows: [
        { kind: '技能', slug: 'pdf-forms', desc: '填写并签署 PDF 表单', installs: '18.2k' },
        { kind: 'MCP', slug: 'postgres', desc: '查询与检查数据库', installs: '9.6k' },
        { kind: '提示词', slug: 'weekly-review', desc: '五个问题做完周五复盘', installs: '4.1k' },
        { kind: '助手', slug: 'trip-planner', desc: '规划、比价并预订行程', installs: '2.7k' },
        { kind: '连接器', slug: 'google-drive', desc: '把云端硬盘的文件收进空间', installs: '31k' },
      ],
      equipping: '正在装配',
    },
  },
  relay: {
    tag: '网络',
    title: 'Relay',
    kicker: '远在万里，近在指间。',
    body: '把电脑、手机、家里的服务器和云盘连成一张私有网络。文件和运行中的会话留在原处，也能随时访问；全程端到端加密，无需开放端口。助手需要时，还可以借用你指定的一台机器。',
    holo: {
      hub: '你的戒指',
      nodes: [
        { name: '笔记本', ms: 3 },
        { name: '手机', ms: 18 },
        { name: '家里的 NAS', ms: 41, relayed: true },
        { name: '小星的云主机', ms: 12 },
        { name: '云端硬盘', ms: 24 },
        { name: '工作室主机', ms: 6 },
      ],
      caption: '6 台设备 · 5 条直连，1 条中继 · 端到端加密',
    },
  },
  signet: {
    tag: '身份与授权',
    title: 'Signet',
    kicker: '早在密码出现之前，戒指就用来证明你是谁。',
    body: 'Signet 保管你的身份、密码和 API 密钥。助手或应用需要权限时，你只交给它一把钥匙：只开一扇门，只在限定时间内有效。每次使用都有签名和记录，任何一把钥匙都能一键收回。',
    holo: {
      label: 'Signet · 已交出的钥匙',
      summary: '2 把生效中',
      grants: [
        { who: '小星', scope: '空间/票据', access: '只读', expires: '剩 6 天' },
        { who: 'Codeg', scope: 'github/acme-web', access: '读写', expires: '本次会话' },
        { who: 'trip-planner', scope: '日历', access: '只读', expires: '已过期', expired: true },
      ],
      revoke: '收回',
      audit: '11:40:07 · 小星付款 ¥1,280 · 由你用通行密钥签署',
    },
  },
  codeg: {
    tag: '开源 01',
    title: 'Codeg',
    kicker: '多智能体协作编程工作台。',
    body: '十五个编程智能体共用一个工作台，包括 Claude Code、Codex、OpenCode 等。接续任意智能体的会话，用 @ 分派任务，在并行的 worktree 里同时推进。',
    actions: { github: '在 GitHub 查看', docs: '阅读文档', download: '下载' },
    stats: { stars: 'Star', forks: 'Fork' },
    holo: {
      title: 'codeg · 工作台',
      summary: '4 个智能体 · 3 个运行中',
      rows: [
        { agent: 'Claude Code', task: '重构鉴权中间件', state: '编辑中', diff: '+128 −34', p: 0.72 },
        { agent: 'Codex', task: '编写迁移测试', state: '测试中', diff: '+56 −2', p: 0.46 },
        { agent: 'OpenCode', task: '审查 PR #212', state: '审查中', diff: '', p: 0.28 },
        { agent: 'Pi', task: '更新 API 文档', state: '已完成', diff: '+41 −9', p: 1, done: true },
      ],
      platforms: 'macOS · Windows · Linux · Docker · iOS · Android',
    },
  },
  open: {
    title: '在开源中锻造。',
    body: 'SpaceRing 在 github.com/spacering-net 公开构建。Codeg 和 Harness 已经上线，其余部分还在锻造。',
    roadmap: '路线图',
    actions: { org: '关注 spacering-net', star: '为 Codeg 点 Star' },
    footer: 'SpaceRing 网络空间戒指 · spacering.net',
    privacy: '隐私政策',
    terms: '用户协议',
  },
  notFound: {
    title: '页面不存在 · SpaceRing',
    heading: '这一页不在戒指里。',
    lede: '可能是地址输错了，也可能这里的内容已经搬走。戒指还在原处。',
    home: '回到戒指',
    harness: '逛逛 Harness',
  },
  theme: {
    label: '外观',
    light: '浅色',
    dark: '深色',
    system: '跟随系统',
  },
  menu: {
    label: '站点菜单',
    destinations: '产品',
    elsewhere: '更多',
    items: [
      { key: 'space', name: '空间', desc: '加密存放文件、笔记与记忆', status: 'planned' },
      { key: 'assistant', name: '个人助手', desc: '全天候在线，你不在时也在工作', status: 'planned' },
      { key: 'harness', name: 'Harness', desc: '技能 · MCP · 提示词 · 助手 · 连接器', status: 'live' },
      { key: 'relay', name: 'Relay', desc: '所有设备连成一张私有网络', status: 'planned' },
      { key: 'signet', name: 'Signet', desc: '身份、密钥与授权', status: 'planned' },
      { key: 'codeg', name: 'Codeg', desc: '开源的多智能体编程工作台', status: 'live' },
    ],
    external: [
      { key: 'docs', name: 'Codeg 文档', desc: 'docs.codeg.app' },
      { key: 'github', name: 'GitHub', desc: 'github.com/spacering-net' },
    ],
    chartLabel: '轨道图：SpaceRing 标志居中，每个产品各占一条轨道，已上线的 Codeg 和 Harness 被点亮',
  },
};

export const dicts: Record<Lang, Dict> = { en, zh };

/** Chapter anchors, in scroll order. Index 0 is the hero, the last is the finale. */
export const CHAPTER_IDS = ['top', 'space', 'assistant', 'harness', 'relay', 'signet', 'codeg', 'open-source'] as const;

/**
 * The HUD's destinations with pages of their own, under each language's path:
 * Space and the personal assistant (planned: their pages say what is planned),
 * Harness, and open source. The HUD links to them from every page, the
 * homepage's included, and the products' homepage chapters end with a button
 * to theirs; the menu's other products are chapters of the homepage until
 * they have pages.
 */
export const PAGES = { space: 'space/', assistant: 'assistant/', harness: 'harness/', 'open-source': 'open-source/' } as const;
