import type { Lang } from './index';

/**
 * The console's words (components/console/Console.astro, client/console.ts):
 * its sections, and what each says about the data it shows. Names of things
 * (providers, apps) and the account itself come from the API.
 */

export type ConsoleSection = 'overview' | 'clients' | 'security' | 'activity' | 'card' | 'backups' | 'relay';

/** The sections in the side's order: the account's own, then what is planned. */
export const CONSOLE_SECTIONS: ConsoleSection[] = ['overview', 'clients', 'security', 'activity', 'card', 'backups', 'relay'];
export const PLANNED_SECTIONS: ConsoleSection[] = ['backups', 'relay'];

/** Where a section lives, under a language's path: overview at console/, the others at console/<section>/. */
export const sectionPath = (section: ConsoleSection) => (section === 'overview' ? 'console/' : `console/${section}/`);

export interface ConsoleDict {
  title: string;
  description: string;
  /** the side's name, for screen readers */
  nav: string;
  planned: string;
  sections: Record<ConsoleSection, { name: string; title: string; lede: string }>;
  signOut: string;
  signOutFailed: string;
  loading: string;
  failed: string;
  retry: string;
  more: string;
  confirm: string;
  /** what any change that did not go through says */
  notDone: string;
  /** the account signed in here changed while the page was open */
  changed: string;
  gate: { title: string; lede: string };
  /** the holder's picture and name, changed in a dialog opened from the overview's heading or the side ({max}: the longest name) */
  profile: {
    edit: string;
    close: string;
    name: string;
    nameHint: string;
    change: string;
    remove: string;
    save: string;
    saving: string;
    cancel: string;
    saved: string;
    problems: { empty: string; long: string; image: string; imageSize: string; limited: string };
  };
  overview: {
    clients: { label: string; value: (n: number) => string; none: string; hint: string };
    sessions: { label: string; value: (n: number) => string; hint: string };
    lastSignIn: { label: string; none: string };
    planned: string;
  };
  clients: {
    empty: string;
    connected: string;
    used: string;
    status: { active: string; expired: string; revoked: string; disabled: string };
    disconnect: string;
    scope: string;
    web: string;
  };
  security: {
    methods: string;
    linked: string;
    notLinked: string;
    methodsNote: string;
    sessions: string;
    current: string;
    signedIn: string;
    active: string;
    signOut: string;
    signOutOthers: string;
    noOthers: string;
    sessionsNote: string;
  };
  activity: {
    /** by type, or type.variant (a provider; .1 for one browser signed out); {n} is how many */
    events: Record<string, string>;
    /** an event this page has no words for */
    other: string;
    thisNetwork: string;
    empty: string;
    note: string;
  };
  /** what the planned sections will hold */
  points: Record<'backups' | 'relay', string[]>;
  device: { unknown: string; on: string };
}

const en: ConsoleDict = {
  title: 'Console',
  description: 'Your SpaceRing console: your profile, the apps connected to your ring, where you are signed in, your sign-in log and your ring card.',
  nav: 'Console sections',
  planned: 'Planned',
  sections: {
    overview: { name: 'Overview', title: 'Your ring', lede: '' },
    clients: {
      name: 'Clients',
      title: 'Clients',
      lede: 'Apps signed in with your SRN. Each device, and each Codeg Web service, holds a connection of its own: use as many as you like at once, and disconnect any one without touching the others.',
    },
    security: { name: 'Security', title: 'Security', lede: 'How you sign in, and the browsers signed in to SpaceRing right now.' },
    activity: { name: 'Sign-in log', title: 'Sign-in log', lede: 'Sign-ins, account changes and app connections over the last 12 months.' },
    card: { name: 'Ring card', title: 'Ring card', lede: 'A card with your ring number for others to see. It shows only what you choose.' },
    backups: {
      name: 'Backups',
      title: 'Backups',
      lede: 'Codeg’s settings, agents and session history, encrypted on your device before they leave it, and restored on any device signed in with your SRN.',
    },
    relay: {
      name: 'Relay',
      title: 'Relay',
      lede: 'Reach the Codeg on your desktop from your phone or any browser, through an encrypted relay, with no ports to open.',
    },
  },
  signOut: 'Sign out',
  signOutFailed: 'Sign-out did not finish. Please try again.',
  loading: 'Loading…',
  failed: 'Unable to load. Check your connection and try again.',
  retry: 'Try again',
  more: 'Load more',
  confirm: 'Confirm',
  notDone: 'That did not go through. Please try again.',
  changed: 'The account signed in here changed. This is the one signed in now.',
  gate: {
    title: 'Sign in to open your console',
    lede: 'Your profile, the apps connected to your ring, where you are signed in, your sign-in log and your ring card, in one place.',
  },
  profile: {
    edit: 'Edit profile',
    close: 'Close',
    name: 'Name',
    nameHint: 'Shown in your console and the apps you connect, and on your ring card if you choose to show it.',
    change: 'Change picture',
    remove: 'Remove picture',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    saved: 'Saved',
    problems: {
      empty: 'Enter a name.',
      long: 'A name can be up to {max} characters.',
      image: 'That picture could not be used. Try a JPG, PNG or WebP image.',
      imageSize: 'That picture is too large. Choose one under 20 MB.',
      limited: 'Too many changes in a row. Wait a minute and try again.',
    },
  },
  overview: {
    clients: { label: 'Clients', value: (n) => (n === 1 ? '1 connected' : `${n} connected`), none: 'None yet', hint: 'Codeg on your devices, and the Codeg Web services you use' },
    sessions: { label: 'Signed-in browsers', value: (n) => String(n), hint: 'This one included' },
    lastSignIn: { label: 'Latest sign-in', none: 'None recorded' },
    planned: 'Coming to your ring',
  },
  clients: {
    empty: 'No apps yet. Apps you sign in to with your SRN, such as Codeg, appear here.',
    connected: 'Connected {date}',
    used: 'Last used {time}',
    status: { active: 'Active', expired: 'Expired', revoked: 'Disconnected', disabled: 'Service disabled' },
    disconnect: 'Disconnect',
    scope: 'A connection can read your name, picture and ring number, and nothing else. It ends by itself after 30 days without use.',
    web: 'A Codeg Web service is run by whoever operates it, and they receive the same information.',
  },
  security: {
    methods: 'Sign-in methods',
    linked: 'Linked {date}',
    notLinked: 'Not linked',
    methodsNote: 'Signing in with the other one joins this account when both have verified the same email address.',
    sessions: 'Signed-in browsers',
    current: 'This browser',
    signedIn: 'Signed in {date}',
    active: 'Active {time}',
    signOut: 'Sign out',
    signOutOthers: 'Sign out all other browsers',
    noOthers: 'No other browser is signed in.',
    sessionsNote: 'Signing a browser out takes effect at once. A session also ends by itself 30 days after it was last used.',
  },
  activity: {
    events: {
      'user.created': 'Ring forged: account created',
      'session.created': 'Signed in',
      'session.created.github': 'Signed in with GitHub',
      'session.created.google': 'Signed in with Google',
      'session.revoked': 'Signed {n} other browsers out',
      'session.revoked.1': 'Signed another browser out',
      'account.linked': 'Sign-in method linked',
      'account.linked.github': 'GitHub linked',
      'account.linked.google': 'Google linked',
      'client.authorized': 'App authorized',
      'client.denied': 'App declined',
      'client.connected': 'App connected',
      'client.revoked': 'App disconnected',
      'client.code_reused': 'Reused sign-in code blocked; its connection was revoked',
      'ring_card.shared': 'Ring card shared',
      'ring_card.changed': 'Ring card changed',
      'ring_card.unshared': 'Ring card sharing stopped',
      'profile.name_changed': 'Name changed',
      'profile.avatar_changed': 'Picture changed',
      'profile.avatar_removed': 'Picture removed',
    },
    other: 'Account event',
    thisNetwork: 'This network',
    empty: 'Nothing recorded yet.',
    note: 'Kept for 12 months. Network addresses are kept only as a keyed hash: the log can tell that two events came from the same network, not where that was.',
  },
  points: {
    backups: ['Encrypted before upload: only ciphertext reaches SpaceRing.', 'Snapshots by device, with their size and time.', 'Restore from Codeg, delete from here.'],
    relay: ['End-to-end encrypted: the relay passes on what it cannot read.', 'Your devices, and whether each is online.', 'Turn any device off from here.'],
  },
  device: { unknown: 'Unknown device', on: '{browser} on {os}' },
};

const zh: ConsoleDict = {
  title: '控制台',
  description: '你的 SpaceRing 控制台：个人资料、连接到戒指的应用、登录中的浏览器、登录日志和戒指卡片。',
  nav: '控制台分区',
  planned: '规划中',
  sections: {
    overview: { name: '概览', title: '你的戒指', lede: '' },
    clients: {
      name: '客户端',
      title: '客户端',
      lede: '用 SRN 登录的应用。每台设备、每个 Codeg Web 服务各自持有一个连接：可以同时使用多个，断开其中一个不影响其他。',
    },
    security: { name: '安全', title: '安全', lede: '你的登录方式，以及此刻登录着 SpaceRing 的浏览器。' },
    activity: { name: '登录日志', title: '登录日志', lede: '过去 12 个月的登录、账号变更与应用连接记录。' },
    card: { name: '戒指卡片', title: '戒指卡片', lede: '一张刻着你戒指编号的卡片，只显示你选择公开的内容。' },
    backups: {
      name: '备份',
      title: '备份',
      lede: 'Codeg 的设置、智能体配置和会话记录，在设备上加密后才离开它，可在任何登录了 SRN 的设备上恢复。',
    },
    relay: {
      name: 'Relay',
      title: 'Relay',
      lede: '通过加密中继，从手机或任意浏览器访问你桌面上的 Codeg，无需开放端口。',
    },
  },
  signOut: '退出登录',
  signOutFailed: '退出没有完成，请再试一次。',
  loading: '正在加载…',
  failed: '暂时无法加载，请检查网络后重试。',
  retry: '重试',
  more: '加载更多',
  confirm: '确认',
  notDone: '没有成功，请再试一次。',
  changed: '这里登录的账号已变化，现在显示的是当前登录的账号。',
  gate: {
    title: '登录后打开控制台',
    lede: '个人资料、连接到戒指的应用、登录中的浏览器、登录日志和戒指卡片，都在这里管理。',
  },
  profile: {
    edit: '编辑资料',
    close: '关闭',
    name: '名字',
    nameHint: '显示在控制台和你连接的应用里；如果你选择显示，也会出现在戒指卡片上。',
    change: '更换头像',
    remove: '移除头像',
    save: '保存',
    saving: '正在保存…',
    cancel: '取消',
    saved: '已保存',
    problems: {
      empty: '请输入名字。',
      long: '名字最多 {max} 个字。',
      image: '这张图片无法使用，请换一张 JPG、PNG 或 WebP 图片。',
      imageSize: '这张图片太大了，请选择 20 MB 以内的图片。',
      limited: '修改太频繁，请稍等一分钟再试。',
    },
  },
  overview: {
    clients: { label: '客户端', value: (n) => `${n} 个已连接`, none: '暂无', hint: '你设备上的 Codeg，以及你使用的 Codeg Web 服务' },
    sessions: { label: '登录中的浏览器', value: (n) => String(n), hint: '包括当前这一个' },
    lastSignIn: { label: '最近登录', none: '暂无记录' },
    planned: '戒指里即将加入',
  },
  clients: {
    empty: '暂无应用。用 SRN 登录的应用（例如 Codeg）会显示在这里。',
    connected: '连接于 {date}',
    used: '最近使用：{time}',
    status: { active: '使用中', expired: '已过期', revoked: '已断开', disabled: '服务已停用' },
    disconnect: '断开',
    scope: '连接只能读取你的名字、头像和戒指编号，不能读取其他信息；连续 30 天未使用会自动结束。',
    web: 'Codeg Web 服务由其运营者运行，运营者会收到同样的信息。',
  },
  security: {
    methods: '登录方式',
    linked: '关联于 {date}',
    notLinked: '未关联',
    methodsNote: '用另一种方式登录时，如果两边验证过的邮箱相同，会并入此账号。',
    sessions: '登录中的浏览器',
    current: '当前浏览器',
    signedIn: '登录于 {date}',
    active: '活动：{time}',
    signOut: '退出',
    signOutOthers: '退出其他所有浏览器',
    noOthers: '没有其他浏览器登录。',
    sessionsNote: '退出立即生效。会话在最后一次使用 30 天后也会自动结束。',
  },
  activity: {
    events: {
      'user.created': '戒指锻造：创建账号',
      'session.created': '登录',
      'session.created.github': '使用 GitHub 登录',
      'session.created.google': '使用 Google 登录',
      'session.revoked': '退出了其他 {n} 个浏览器',
      'session.revoked.1': '退出了另一个浏览器',
      'account.linked': '关联了登录方式',
      'account.linked.github': '关联了 GitHub',
      'account.linked.google': '关联了 Google',
      'client.authorized': '授权了应用',
      'client.denied': '拒绝了应用',
      'client.connected': '应用已连接',
      'client.revoked': '断开了应用',
      'client.code_reused': '拦截了被重复使用的登录码，相应连接已撤销',
      'ring_card.shared': '分享了戒指卡片',
      'ring_card.changed': '修改了戒指卡片',
      'ring_card.unshared': '停止分享戒指卡片',
      'profile.name_changed': '修改了名字',
      'profile.avatar_changed': '更换了头像',
      'profile.avatar_removed': '移除了头像',
    },
    other: '账号事件',
    thisNetwork: '当前网络',
    empty: '暂无记录。',
    note: '保留 12 个月。网络地址只以密钥哈希保存：日志能看出两次事件来自同一网络，但看不出在哪里。',
  },
  points: {
    backups: ['上传前加密：到达 SpaceRing 的只有密文。', '按设备生成快照，标明大小和时间。', '在 Codeg 里恢复，在这里删除。'],
    relay: ['端到端加密：中继只转发它读不了的内容。', '你的设备，以及每台是否在线。', '在这里停用任何一台设备。'],
  },
  device: { unknown: '未知设备', on: '{os} 上的 {browser}' },
};

export const consoleDicts: Record<Lang, ConsoleDict> = { en, zh };
