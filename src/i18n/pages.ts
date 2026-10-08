import type { Lang } from './index';

/**
 * The words of the pages the HUD opens besides Harness: Space and the
 * personal assistant (both planned, so their pages say what is planned), and
 * open source. Names, kickers and the samples the homepage's projections
 * show come from the main dictionary (index.ts), so the two never differ.
 */

/** A part of the ring another page links to: its own page, or its chapter on the homepage. */
export type RingPart = 'space' | 'assistant' | 'harness' | 'relay' | 'signet' | 'codeg';

export interface Point {
  name: string;
  text: string;
}

export type AssetKind = 'files' | 'photos' | 'notes' | 'links' | 'memory';

export interface PagesDict {
  /** what the pages of planned products share */
  planned: {
    /** the button that gets a ring (signing in, then the ring card), and its words once there is one */
    claim: string;
    mine: string;
    github: string;
    /** the section on how the other parts of the ring work with this one */
    ring: string;
  };
  space: {
    title: string;
    description: string;
    lede: string;
    holds: { title: string; lede: string; items: (Point & { key: AssetKind })[] };
    search: { title: string; lede: string; results: (n: number) => string };
    keeps: { title: string; items: Point[] };
    ring: { lede: string; items: { key: RingPart; text: string }[] };
    cta: { title: string; text: string };
  };
  assistant: {
    title: string;
    description: string;
    lede: string;
    /** the hero's day: under the assistant's name; the day's marks, as they are passed */
    dial: { status: string };
    day: {
      title: string;
      lede: string;
      /** what an approval asks, `{name}` being the assistant's */
      sheet: { asks: string; title: string; facts: [string, string][]; approve: string; later: string; signed: string };
    };
    ways: { title: string; items: Point[] };
    ring: { lede: string; items: { key: RingPart; text: string }[] };
    cta: { title: string; text: string; harness: string };
  };
  openSource: {
    title: string;
    description: string;
    /** under the drawing of the mark */
    blueprint: string;
    today: {
      title: string;
      lede: string;
      site: { tag: string; kicker: string; body: string; api: string };
      facts: { license: string; version: string; stars: string; platforms: string; stack: string; api: string };
      note: string;
    };
    roadmap: { title: string; lede: string };
    why: { title: string; items: Point[] };
    cta: { title: string; text: string };
  };
}

const en: PagesDict = {
  planned: {
    claim: 'Get your ring',
    mine: 'Your ring card',
    github: 'Follow on GitHub',
    ring: 'In the ring',
  },
  space: {
    title: 'Space · SpaceRing',
    description:
      'Space is the room inside your ring: files, photos, notes, links and your assistant’s memory, kept together, encrypted, and found with one search. Planned.',
    lede: 'The room inside your ring. Files, photos, notes, links and what your assistant learns about you live together, encrypted, and one search reaches all of it.',
    holds: {
      title: 'One room for everything that is yours.',
      lede: 'Not a drive for files, an app for photos and another for notes: five kinds of assets side by side, in one place that belongs to you.',
      items: [
        { key: 'files', name: 'Files', text: 'Documents, spreadsheets, archives: anything with a name.' },
        { key: 'photos', name: 'Photos', text: 'Your library, each picture with the day and the place it was taken.' },
        { key: 'notes', name: 'Notes', text: 'Lists, drafts and the things you meant to remember.' },
        { key: 'links', name: 'Links', text: 'Pages, posts and videos you saved for later.' },
        { key: 'memory', name: 'Memory', text: 'What your assistant has learned about you, kept here in your ring, not with the assistant.' },
      ],
    },
    search: {
      title: 'Search by what you remember.',
      lede: 'A trip, a person, a month. One search answers from every kind of asset at once: the photo, the boarding pass in your mail, the route in your notes, and what your assistant knows about how you like to travel.',
      results: (n) => `${n} results`,
    },
    keeps: {
      title: 'It answers only to you.',
      items: [
        { name: 'Encrypted', text: 'Files, photos, notes, links and memories are all stored encrypted.' },
        {
          name: 'A key for each door',
          text: 'An assistant or an app sees only what you hand it a key to: one folder, for a set time. Signet keeps the keys, and takes any of them back when you say so.',
        },
        { name: 'A vault for each ring', text: 'Every ring keeps its own store and its own index, apart from everyone else’s.' },
      ],
    },
    ring: {
      lede: 'How the rest of the ring works with Space.',
      items: [
        { key: 'assistant', text: 'Looks things up in your Space, and keeps its memory here.' },
        { key: 'harness', text: 'Its connectors bring in what already sits in other drives and apps.' },
        { key: 'relay', text: 'Files on your own devices stay where they are, and within reach.' },
        { key: 'signet', text: 'Hands out the keys: each opens one folder, for a set time.' },
      ],
    },
    cta: {
      title: 'Space opens inside your ring.',
      text: 'Rings are already being forged. Sign in and your number is engraved inside the band; when Space opens, it opens in that ring.',
    },
  },
  assistant: {
    title: 'Personal assistant · SpaceRing',
    description:
      'An assistant that is always on and only yours. It works on its own cloud machine while you are away, looks things up in your Space and asks before anything sensitive. Planned.',
    lede: 'Give it a name and a goal. While you are away it keeps working on its own cloud machine, looks things up in your Space, and asks before anything sensitive.',
    dial: { status: 'online around the clock' },
    day: {
      title: 'Hand it a goal, not a script.',
      lede: 'It breaks the goal into tasks, works through them on its own and reports back. Anything that spends money, speaks for you or cannot be undone waits for your yes.',
      sheet: {
        asks: '{name} asks',
        title: 'Pay $180 to Lumen Studio',
        facts: [
          ['For', 'Invoice 0412, from your Space'],
          ['From', 'Card ending 0817'],
          ['Key', 'Payments, this one only'],
        ],
        approve: 'Approve with passkey',
        later: 'Later',
        signed: 'You sign it in Signet, with your passkey.',
      },
    },
    ways: {
      title: 'How it works for you.',
      items: [
        {
          name: 'Its own machine',
          text: 'It runs on a cloud machine of its own, so it keeps going after you close your laptop. When a task needs one of your devices, Relay lends it the one you choose.',
        },
        {
          name: 'It asks first',
          text: 'Payments, messages in your name, anything that cannot be undone: these wait for your approval, which you sign with a passkey in Signet.',
        },
        { name: 'Memory in your Space', text: 'What it learns about you is kept in your Space, inside your ring, not with the assistant.' },
        {
          name: 'Skills from Harness',
          text: 'Skills, MCP servers, prompts and connectors install in one step, and each shows the permissions it needs before you add it.',
        },
        { name: 'A name of your choosing', text: '{name} is only our example. Yours answers to whatever you call it.' },
      ],
    },
    ring: {
      lede: 'How the rest of the ring works with your assistant.',
      items: [
        { key: 'space', text: 'Where it looks things up, and where its memory is kept.' },
        { key: 'harness', text: 'Where its skills come from, each with the permissions it needs.' },
        { key: 'relay', text: 'Lends it one of your devices when a task needs one.' },
        { key: 'signet', text: 'Keeps the keys you hand it, and your signature on what it asks.' },
      ],
    },
    cta: {
      title: 'Your assistant will live in your ring.',
      text: 'Rings are already being forged: sign in and your number is engraved inside the band. The skills it will use are in Harness today.',
      harness: 'Browse Harness',
    },
  },
  openSource: {
    title: 'Open source · SpaceRing',
    description: 'SpaceRing is built in public at github.com/spacering-net: what is open today, the ring’s roadmap, and how to take part.',
    blueprint: 'How the mark is drawn: the ring lies at 30° to the page, and every proportion comes from φ.',
    today: {
      title: 'Open today',
      lede: 'Code you can read, run and build on now.',
      site: {
        tag: 'This website',
        kicker: 'The site you are on, and the services behind it.',
        body: 'The homepage’s ring, signing in and ring numbers, ring cards, and Harness with its catalog, imports and public API. One Cloudflare Worker serves all of it.',
        api: 'Harness API',
      },
      facts: { license: 'License', version: 'Version', stars: 'Stars', platforms: 'Runs on', stack: 'Built with', api: 'API' },
      note: 'The SpaceRing name and logo are not covered by these licenses.',
    },
    roadmap: { title: 'The ring, piece by piece.', lede: 'Each part of the ring, and where it stands.' },
    why: {
      title: 'Why in the open',
      items: [
        {
          name: 'A ring you can inspect',
          text: 'A ring that answers only to you should be one you can check. The code that signs you in, numbers your ring and shows your ring card is public.',
        },
        {
          name: 'A marketplace in plain sight',
          text: 'Harness’s server is open source: how listings are imported, stored and served, and the API any client can call.',
        },
        { name: 'Licenses you can build on', text: 'Codeg is under {codeg} and this website under {site}: read them, run them, build on them.' },
      ],
    },
    cta: {
      title: 'Take part.',
      text: 'Use what has shipped, open an issue when something is wrong, and watch the rest of the ring take shape at github.com/spacering-net.',
    },
  },
};

const zh: PagesDict = {
  planned: {
    claim: '领取你的戒指',
    mine: '你的戒指卡片',
    github: '在 GitHub 关注',
    ring: '在戒指里',
  },
  space: {
    title: '空间 · SpaceRing',
    description: '空间是戒指里的那方天地：文件、照片、笔记、收藏，连同助手对你的记忆，都加密存放在一起，一次搜索就能找到。规划中。',
    lede: '戒指里的那方天地。文件、照片、笔记、收藏，连同助手对你的了解，都加密存放在一起，一次搜索就能找到。',
    holds: {
      title: '属于你的一切，收进同一个房间。',
      lede: '不再是文件放一个网盘、照片放一个应用、笔记又放一个应用：五类资产并排存放，都在属于你自己的地方。',
      items: [
        { key: 'files', name: '文件', text: '文档、表格、压缩包，凡是有名字的都算。' },
        { key: 'photos', name: '照片', text: '你的图库，每一张都带着拍摄的日子和地点。' },
        { key: 'notes', name: '笔记', text: '清单、草稿，还有那些你想记住的事。' },
        { key: 'links', name: '收藏', text: '存下来、打算以后再看的网页、帖子和视频。' },
        { key: 'memory', name: '记忆', text: '助手对你的了解。它存放在你的戒指里，而不在助手那里。' },
      ],
    },
    search: {
      title: '凭记忆去找。',
      lede: '一次旅行、一个人、某个月份。一次搜索，就能从每一类资产里同时找出答案：那张照片、邮箱里的登机牌、备忘录里的路线，还有助手知道的、你出行的习惯。',
      results: (n) => `${n} 条结果`,
    },
    keeps: {
      title: '只听你的。',
      items: [
        { name: '加密存放', text: '文件、照片、笔记、收藏和记忆，全部加密存放。' },
        { name: '一把钥匙开一扇门', text: '助手或应用只能看到你交出钥匙的那部分：一个文件夹，限定时间。钥匙由 Signet 保管，你说收回就收回。' },
        { name: '一枚戒指，一座库', text: '每枚戒指都有自己的存储和索引，与其他人的分开存放。' },
      ],
    },
    ring: {
      lede: '戒指的其他部分，怎样和空间协作。',
      items: [
        { key: 'assistant', text: '在你的空间里查找资料，也把记忆存放在这里。' },
        { key: 'harness', text: '它的连接器，把其他网盘和应用里的东西收进来。' },
        { key: 'relay', text: '留在你自己设备上的文件，原地不动，也随时取得到。' },
        { key: 'signet', text: '发放钥匙：每一把只开一个文件夹，限时有效。' },
      ],
    },
    cta: {
      title: '空间会在你的戒指里打开。',
      text: '戒指已经开始锻造。登录后，你的编号会刻在戒身内侧；空间上线时，就在这枚戒指里打开。',
    },
  },
  assistant: {
    title: '个人助手 · SpaceRing',
    description: '全天候在线、只属于你的个人助手：你不在时，它在自己的云端机器上继续工作，需要时翻阅你的空间，遇到敏感操作先征求你的同意。规划中。',
    lede: '给它起个名字，交代一个目标。你不在的时候，它在自己的云端机器上继续工作，需要时翻阅你的空间，遇到敏感操作先征求你的同意。',
    dial: { status: '全天候在线' },
    day: {
      title: '交给它目标，而不是步骤。',
      lede: '它自己把目标拆成任务，一件件做完，再向你汇报。花钱的、以你的名义发言的、做了就撤不回的，都会先等你点头。',
      sheet: {
        asks: '{name}请你确认',
        title: '向 Lumen 工作室付款 ¥1,280',
        facts: [
          ['用途', '空间里找到的 0412 号发票'],
          ['付款方式', '尾号 0817 的银行卡'],
          ['钥匙', '付款，仅限这一笔'],
        ],
        approve: '用通行密钥批准',
        later: '稍后',
        signed: '在 Signet 里，用你的通行密钥签署。',
      },
    },
    ways: {
      title: '它怎样替你做事。',
      items: [
        { name: '自己的机器', text: '它运行在自己的云端机器上，你合上电脑，它照样干活。任务需要用到你的设备时，Relay 会把你指定的那一台借给它。' },
        { name: '先问你', text: '付款、以你的名义发消息、做了就撤不回的操作，都要等你批准；批准时，你在 Signet 里用通行密钥签字。' },
        { name: '记忆在你的空间里', text: '它对你的了解存放在你的空间里，留在你的戒指中，而不在助手那里。' },
        { name: '能力来自 Harness', text: '技能、MCP 服务、提示词和连接器一步装好，每一项在安装前都写明需要哪些权限。' },
        { name: '名字由你来起', text: '{name}只是我们举的例子。你的助手叫什么，由你决定。' },
      ],
    },
    ring: {
      lede: '戒指的其他部分，怎样和你的助手协作。',
      items: [
        { key: 'space', text: '它查资料的地方，也是它存放记忆的地方。' },
        { key: 'harness', text: '它的能力从这里来，每一项都写明所需权限。' },
        { key: 'relay', text: '任务需要时，把你的某台设备借给它。' },
        { key: 'signet', text: '保管你交给它的钥匙，也留下你在每次批准上的签名。' },
      ],
    },
    cta: {
      title: '你的助手，会住在你的戒指里。',
      text: '戒指已经开始锻造：登录后，你的编号会刻在戒身内侧。它将用到的能力，今天已经在 Harness 里了。',
      harness: '逛逛 Harness',
    },
  },
  openSource: {
    title: '开源 · SpaceRing',
    description: 'SpaceRing 在 github.com/spacering-net 公开构建：现在开源了什么、戒指的路线图，以及如何参与。',
    blueprint: '标志的画法：戒面与画面成 30°，每一处比例都取自 φ。',
    today: {
      title: '已经开源',
      lede: '现在就能阅读、运行，也能拿来用的代码。',
      site: {
        tag: '本站',
        kicker: '你正在浏览的网站，以及它背后的服务。',
        body: '首页的戒指、登录与戒指编号、戒指卡片，还有 Harness 的目录、导入和公开 API。全部由一个 Cloudflare Worker 提供。',
        api: 'Harness API',
      },
      facts: { license: '许可证', version: '版本', stars: 'Star', platforms: '平台', stack: '技术', api: 'API' },
      note: 'SpaceRing 的名称和标志不在这些许可证的范围内。',
    },
    roadmap: { title: '一枚戒指，逐件锻造。', lede: '戒指的每个部分，以及它们各自的进展。' },
    why: {
      title: '为什么公开构建',
      items: [
        { name: '经得起检查的戒指', text: '一枚只听你的戒指，应该经得起你检查。为你登录、给戒指编号、展示戒指卡片的代码，都是公开的。' },
        { name: '摆在明处的市场', text: 'Harness 的服务端是开源的：条目怎样导入、存放和提供，以及任何客户端都能调用的 API，都写在代码里。' },
        { name: '拿去就能用的许可', text: 'Codeg 采用 {codeg}，本站采用 {site}：可以阅读、运行，也可以在此基础上开发。' },
      ],
    },
    cta: {
      title: '参与进来。',
      text: '用上已经上线的部分，遇到问题就提一个 issue，在 github.com/spacering-net 看着戒指的其余部分成形。',
    },
  },
};

export const pageDicts: Record<Lang, PagesDict> = { en, zh };

/** Fills `{key}` in a line of copy. */
export const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);
