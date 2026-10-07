import type { Lang } from './index';

/** The words of the Harness pages, in both languages. */
export interface HarnessDict {
  lang: Lang;
  htmlLang: string;
  /** the browse page's path */
  base: string;
  other: Lang;
  switchLabel: string;
  switchName: string;
  home: string;
  title: string;
  description: string;
  kicker: string;
  lede: string;
  count: (n: number) => string;
  search: { label: string; placeholder: string; submit: string; results: (n: number, q: string) => string; none: string; noneHint: string; clear: string };
  kinds: Record<'all' | 'skill' | 'mcp' | 'prompt' | 'assistant' | 'connector', string>;
  kind: Record<'skill' | 'mcp' | 'prompt' | 'assistant' | 'connector', string>;
  sort: { label: string; popular: string; new: string; updated: string };
  runtime: { label: string; any: string; names: Record<string, string> };
  tags: { label: string; all: string };
  more: string;
  first: string;
  browse: {
    eyebrow: string;
    shelves: string;
    kindsLabel: string;
    filters: string;
    done: string;
    clear: string;
    remove: (what: string) => string;
    /** how many items a listing has, when it is known */
    total: (n: number) => string;
    loading: string;
    /** `{n}`: how many */
    loaded: string;
    end: string;
    allTags: (n: number) => string;
    about: { title: string; text: string; api: string };
  };
  copy: { label: string; done: string };
  card: { stars: string; unclaimed: string; listed: string };
  item: {
    by: string;
    version: string;
    revision: string;
    updated: string;
    license: string;
    noLicense: string;
    runtime: string;
    source: string;
    sources: Record<'registry' | 'github' | 'upload' | 'form', string>;
    repository: string;
    website: string;
    install: string;
    openInCodeg: string;
    codegNote: string;
    download: string;
    notHosted: string;
    commit: string;
    permissions: string;
    declared: string;
    detected: string;
    nothing: string;
    perms: Record<'runsCode' | 'installs' | 'installScripts' | 'network' | 'secrets' | 'paths' | 'tools', string>;
    checks: string;
    risk: Record<'low' | 'medium' | 'high', string>;
    riskNote: Record<'low' | 'medium' | 'high', string>;
    reviewed: string;
    notReviewed: string;
    modelOff: string;
    findings: Record<string, string>;
    rule: string;
    minorFindings: (n: number) => string;
    secretsFound: (n: number) => string;
    dropped: string;
    description: string;
    server: string;
    files: string;
    filesCount: (n: number) => string;
    versions: string;
    listed: string;
    listedNote: string;
    reasons: Record<string, string>;
    toc: string;
    expand: string;
    collapse: string;
    readmeElsewhere: string;
    publisherAll: string;
    facts: string;
    safety: string;
    hosts: (n: number) => string;
    credentials: (n: number) => string;
    topLevel: string;
    filesTotal: (n: number, size: string) => string;
    current: string;
    stars: string;
  };
  publisher: { items: (n: number) => string; github: string; domain: string; unclaimed: string; label: string };
  footer: { privacy: string; terms: string };
  date: (iso: string) => string;
}

const runtimes = {
  en: { node: 'Node.js', python: 'Python', remote: 'Remote', docker: 'Docker', shell: 'Shell', none: 'No code', bundle: 'MCP bundle', dotnet: '.NET', rust: 'Rust' },
  zh: { node: 'Node.js', python: 'Python', remote: '远程', docker: 'Docker', shell: 'Shell', none: '无代码', bundle: 'MCP 包', dotnet: '.NET', rust: 'Rust' },
};

export const harnessDicts: Record<Lang, HarnessDict> = {
  en: {
    lang: 'en',
    htmlLang: 'en',
    base: '/harness/',
    other: 'zh',
    switchLabel: '切换到中文',
    switchName: '中文',
    home: 'SpaceRing home',
    title: 'Harness',
    description: 'Skills, MCP servers, prompts, assistants and connectors. Every listing shows its author, version and the permissions it needs.',
    kicker: 'Put raw intelligence to work.',
    lede: 'Skills, MCP servers, prompts, assistants and connectors. Every listing shows its author, version and the permissions it needs.',
    count: (n) => `${n.toLocaleString('en')} on the shelves`,
    search: {
      label: 'Search Harness',
      placeholder: 'Search skills, MCP servers…',
      submit: 'Search',
      results: (n, q) => `${n === 200 ? '200+' : n} results for “${q}”`,
      none: 'Nothing matches.',
      noneHint: 'Try fewer words, another language, or a name such as anthropics/pdf.',
      clear: 'Clear',
    },
    kinds: { all: 'All', skill: 'Skills', mcp: 'MCP servers', prompt: 'Prompts', assistant: 'Assistants', connector: 'Connectors' },
    kind: { skill: 'Skill', mcp: 'MCP', prompt: 'Prompt', assistant: 'Assistant', connector: 'Connector' },
    sort: { label: 'Sort', popular: 'Popular', new: 'New', updated: 'Updated' },
    runtime: { label: 'Runs on', any: 'Any', names: runtimes.en },
    tags: { label: 'Tags', all: 'All tags' },
    more: 'More',
    first: 'Back to the start',
    browse: {
      eyebrow: 'harness · market',
      shelves: 'On the shelves',
      kindsLabel: 'Kinds',
      filters: 'Filters',
      done: 'Done',
      clear: 'Clear filters',
      remove: (what) => `Remove ${what}`,
      total: (n) => `${n.toLocaleString('en')} item${n === 1 ? '' : 's'}`,
      loading: 'Loading…',
      loaded: '{n} more loaded',
      end: 'That is everything.',
      allTags: (n) => `All ${n} tags`,
      about: {
        title: 'About Harness',
        text: 'Imported from the official MCP Registry and curated skill repositories. Every version is checked for its format, leaked credentials and risky commands before it is listed.',
        api: 'Read-only API',
      },
    },
    copy: { label: 'Copy', done: 'Copied' },
    card: { stars: 'GitHub stars', unclaimed: 'Unclaimed', listed: 'Listed only' },
    item: {
      by: 'by',
      version: 'Version',
      revision: 'Revision',
      updated: 'Updated',
      license: 'License',
      noLicense: 'None stated',
      runtime: 'Runs on',
      source: 'From',
      sources: { registry: 'MCP Registry', github: 'GitHub', upload: 'Upload', form: 'Form' },
      repository: 'Repository',
      website: 'Website',
      install: 'Install',
      openInCodeg: 'Open in Codeg',
      codegNote: 'Codeg checks every file against these hashes before installing.',
      download: 'Download zip',
      notHosted: 'Its license does not let Harness hand out copies: Codeg fetches the files from GitHub at this commit and checks their hashes.',
      commit: 'Commit',
      permissions: 'Permissions',
      declared: 'Declared',
      detected: 'Detected',
      nothing: 'None',
      perms: {
        runsCode: 'Runs code',
        installs: 'Installs',
        installScripts: 'Runs install scripts',
        network: 'Network',
        secrets: 'Needs credentials',
        paths: 'Outside the workspace',
        tools: 'Agent tools',
      },
      checks: 'Checks',
      risk: { low: 'Low risk', medium: 'Medium risk', high: 'High risk' },
      riskNote: {
        low: 'Nothing worth a warning was found.',
        medium: 'Some things deserve a look before you install it. See below.',
        high: 'Waiting for a person to review it.',
      },
      reviewed: 'Reviewed by a person',
      notReviewed: 'Not reviewed by a person',
      modelOff: 'Checked by rules; the model review is not switched on yet.',
      findings: {
        executable_binary: 'Executable file',
        encrypted_archive: 'Password-protected archive',
        nested_archive: 'Archive inside the package',
        document_container: 'Office document',
        padding: 'Mostly blank file',
        blank_lines: 'Long run of blank lines',
        long_line: 'Very long line',
        hidden_characters: 'Invisible characters',
        encoded_blob: 'Long encoded text',
        long_html_comment: 'Long hidden comment',
      },
      rule: 'Rule',
      minorFindings: (n) => `${n} minor mark${n === 1 ? '' : 's'}: common commands and the like, noted but not a concern`,
      secretsFound: (n) => `${n} credential${n === 1 ? '' : 's'} found in the source; not copied here.`,
      dropped: 'Left out of the package',
      description: 'Description',
      server: 'server.json',
      files: 'Files',
      filesCount: (n) => `${n} file${n === 1 ? '' : 's'}`,
      versions: 'Versions',
      listed: 'Listed only',
      listedNote: 'Reachable by its address and exact name, but not browsed, ranked or recommended:',
      reasons: {
        no_repository: 'no source repository',
        no_description: 'no real description',
        remote_not_public: 'its endpoint is not a public https address',
        package_unverifiable: 'its package registry is not checked yet',
        package_missing: 'its package version does not exist',
        package_unverified: 'its package could not be checked yet',
        nothing_to_install: 'nothing to install',
        deprecated: 'deprecated by its author',
        duplicate: 'a copy of another listing',
        bulk_publisher: 'its publisher lists in bulk',
        secrets: 'credentials were found in it',
        format: 'its package has format errors',
      },
      toc: 'On this page',
      expand: 'Show all',
      collapse: 'Show less',
      readmeElsewhere: 'Its license does not let Harness keep a copy, so its description is read at the source.',
      publisherAll: 'Everything from this publisher',
      facts: 'Details',
      safety: 'At a glance',
      hosts: (n) => `${n} host${n === 1 ? '' : 's'}`,
      credentials: (n) => `${n} credential${n === 1 ? '' : 's'}`,
      topLevel: 'Top level',
      filesTotal: (n, size) => `${n} file${n === 1 ? '' : 's'} · ${size}`,
      current: 'latest',
      stars: 'GitHub stars',
    },
    publisher: {
      items: (n) => `${n.toLocaleString('en')} on the shelves`,
      github: 'GitHub account',
      domain: 'Domain',
      unclaimed: 'Imported from public sources. Its owner can claim it by signing in.',
      label: 'Publisher',
    },
    footer: { privacy: 'Privacy Policy', terms: 'Terms of Service' },
    date: (iso) => new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }),
  },
  zh: {
    lang: 'zh',
    htmlLang: 'zh-CN',
    base: '/zh/harness/',
    other: 'en',
    switchLabel: 'Switch to English',
    switchName: 'English',
    home: 'SpaceRing 首页',
    title: 'Harness',
    description: '技能、MCP 服务、提示词、助手与连接器。每一项都写明作者、版本和所需权限。',
    kicker: '让 AI 的能力，落到实处。',
    lede: '技能、MCP 服务、提示词、助手与连接器。每一项都写明作者、版本和所需权限。',
    count: (n) => `已上架 ${n.toLocaleString('zh-CN')} 项`,
    search: {
      label: '搜索 Harness',
      placeholder: '搜索技能、MCP 服务…',
      submit: '搜索',
      results: (n, q) => `「${q}」找到 ${n === 200 ? '200+' : n} 项`,
      none: '没有找到。',
      noneHint: '试试少几个词、换种语言，或者直接输入名字，例如 anthropics/pdf。',
      clear: '清除',
    },
    kinds: { all: '全部', skill: '技能', mcp: 'MCP 服务', prompt: '提示词', assistant: '助手', connector: '连接器' },
    kind: { skill: '技能', mcp: 'MCP', prompt: '提示词', assistant: '助手', connector: '连接器' },
    sort: { label: '排序', popular: '热门', new: '最新', updated: '最近更新' },
    runtime: { label: '运行环境', any: '不限', names: runtimes.zh },
    tags: { label: '标签', all: '全部标签' },
    more: '更多',
    first: '回到开头',
    browse: {
      eyebrow: 'Harness · 综合市场',
      shelves: '已上架',
      kindsLabel: '类别',
      filters: '筛选',
      done: '完成',
      clear: '清除筛选',
      remove: (what) => `去掉「${what}」`,
      total: (n) => `共 ${n.toLocaleString('zh-CN')} 项`,
      loading: '加载中…',
      loaded: '又加载了 {n} 项',
      end: '已经全部列出。',
      allTags: (n) => `全部 ${n} 个标签`,
      about: {
        title: '关于 Harness',
        text: '收录自官方 MCP 注册表和精选技能仓库。每个版本上架前都检查过格式、泄露的凭据和有风险的命令。',
        api: '只读 API',
      },
    },
    copy: { label: '复制', done: '已复制' },
    card: { stars: 'GitHub 星标', unclaimed: '未认领', listed: '仅收录' },
    item: {
      by: '发布者',
      version: '版本',
      revision: '修订',
      updated: '更新于',
      license: '许可证',
      noLicense: '未声明',
      runtime: '运行环境',
      source: '来源',
      sources: { registry: 'MCP 注册表', github: 'GitHub', upload: '上传', form: '表单' },
      repository: '仓库',
      website: '网站',
      install: '安装',
      openInCodeg: '在 Codeg 中打开',
      codegNote: 'Codeg 安装前会按这些哈希逐个核对文件。',
      download: '下载 zip',
      notHosted: '它的许可证不允许 Harness 分发副本：Codeg 按这个提交从 GitHub 取文件，并核对哈希。',
      commit: '提交',
      permissions: '权限',
      declared: '声明',
      detected: '检测',
      nothing: '无',
      perms: {
        runsCode: '运行代码',
        installs: '安装',
        installScripts: '安装时运行脚本',
        network: '网络',
        secrets: '需要的凭据',
        paths: '工作区外的路径',
        tools: '智能体工具',
      },
      checks: '检查',
      risk: { low: '低风险', medium: '中风险', high: '高风险' },
      riskNote: {
        low: '没有发现需要提醒的地方。',
        medium: '有些地方值得在安装前看一看，见下方。',
        high: '等待人工审核。',
      },
      reviewed: '已人工审核',
      notReviewed: '未经人工审核',
      modelOff: '已做规则检查；模型审核尚未开启。',
      findings: {
        executable_binary: '可执行文件',
        encrypted_archive: '带密码的压缩包',
        nested_archive: '包里的压缩包',
        document_container: 'Office 文档',
        padding: '几乎全是空白的文件',
        blank_lines: '成片的空行',
        long_line: '超长的行',
        hidden_characters: '不可见字符',
        encoded_blob: '长段编码文本',
        long_html_comment: '很长的隐藏注释',
      },
      rule: '规则',
      minorFindings: (n) => `另有 ${n} 处低风险标记：常见命令之类，只记录、不提醒`,
      secretsFound: (n) => `来源里发现 ${n} 处凭据，没有复制到这里。`,
      dropped: '未收进包里的文件',
      description: '说明',
      server: 'server.json',
      files: '文件',
      filesCount: (n) => `${n} 个文件`,
      versions: '版本',
      listed: '仅收录',
      listedNote: '能通过地址和精确名称找到，但不进浏览和排行，也不推荐：',
      reasons: {
        no_repository: '没有源码仓库',
        no_description: '没有像样的说明',
        remote_not_public: '服务地址不是公网 https',
        package_unverifiable: '它所在的包注册表还未接入检查',
        package_missing: '找不到它引用的包版本',
        package_unverified: '它引用的包暂时没能核对',
        nothing_to_install: '没有可安装的内容',
        deprecated: '作者已弃用',
        duplicate: '与另一条目重复',
        bulk_publisher: '发布者批量发布',
        secrets: '里面发现了凭据',
        format: '包的格式有错误',
      },
      toc: '本页内容',
      expand: '展开全部',
      collapse: '收起',
      readmeElsewhere: '它的许可证不允许 Harness 保存副本，说明请到来源查看。',
      publisherAll: '这个发布者的全部条目',
      facts: '详情',
      safety: '安全概要',
      hosts: (n) => `${n} 个主机`,
      credentials: (n) => `${n} 项凭据`,
      topLevel: '顶层',
      filesTotal: (n, size) => `${n} 个文件 · ${size}`,
      current: '最新',
      stars: 'GitHub 星标',
    },
    publisher: {
      items: (n) => `${n.toLocaleString('zh-CN')} 项上架`,
      github: 'GitHub 账号',
      domain: '域名',
      unclaimed: '收录自公开来源。所有者登录后即可认领。',
      label: '发布者',
    },
    footer: { privacy: '隐私政策', terms: '用户协议' },
    date: (iso) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
  },
};

/** Display text in the reader's language, else the other one. */
export const pick = (text: { en?: string; zh?: string }, lang: Lang): string | undefined => text[lang] ?? text[lang === 'en' ? 'zh' : 'en'];
