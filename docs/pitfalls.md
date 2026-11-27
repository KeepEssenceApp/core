# 踩过的坑

写核心第一批代码时碰到的。每条写：现象、原因、现在怎么做。验证方式都是本机（macOS，Node 22）跑的自动测试或 `wrangler dev`，没有在线上验过。

## 工具链

**`npm install` 报 `Cannot read properties of null (reading 'edgesOut')`**
`@cloudflare/vitest-pool-workers` 0.23 要求 vitest 4.1，而 `npm install vitest` 缺省装的是 5.x；npm 10 在解这组依赖时自己崩了。现在的做法：`package.json` 里把 `vitest`、`@vitest/runner`、`@vitest/snapshot` 钉在 4.1.12，仓库里放了 `.npmrc`（`legacy-peer-deps=true`）。

**`@cloudflare/vitest-pool-workers` 已经改名**
跑测试时会打印一段提示：这个包改名为 `@cloudflare/vitest-plugin`，旧包不再更新。规格点名要用旧包，所以先用着。以后换：`npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`。

**`compatibility_date` 不能写得比测试里的运行时新**
写 `2026-11-01` 时测试直接起不来：`This Worker requires compatibility date "2026-11-01", but the newest date supported by this server binary is "2026-08-22"`。测试包自带的运行时比 wrangler 的旧。现在写 `2026-08-01`。换了新的测试包之后可以往后调。

**本机的 `cp`、`rm` 是带确认的别名**
脚本里 `cp` 覆盖文件时停下来问 y/n，没覆盖成也不报错。同步契约时要用 `/bin/cp -f`。

**提交前的密钥扫描（gitleaks）会误报**
解读的「关键事实」字段名里带 key，把它直接写成「字段名、冒号、另一个带 key 的表达式」时被当成「通用 API key」拦下（连这份文档里照抄那一行也会被拦）。没有绕过检查，改成先赋给一个变量再用。字段名里带 key 的地方留意。

## 测试环境

**测试会读到本地的 `.dev.vars`**
本地建了 `.dev.vars`（里面有 `ALLOW_HTTP=1`）之后，「只走 HTTPS」和 CORS 两条测试挂了；更糟的是如果里面有真的 `LLM_API_KEY`，测试可能去调真的模型。现在 `test/helpers.ts` 的 `makeEnv()` 把这些值全部写死，并且缺省把所有对外请求换成一个直接失败的假函数：没被替换的对外请求在测试里一律到不了网络。

**每条测试之间要清库**
新版测试包没有「每条测试自动回滚」了，用 `reset()` 清空所有绑定，再重新跑迁移（`test/setup.ts`）。

**拨了时钟以后，凭据也会过期**
这是对的行为，但写测试时容易忘：助手的访问凭据 1 小时过期，设备 90 天不用就失效。测试里跨过这些时间要先续期（`refresh()`），或者一边拨时钟一边让设备有请求（`leap()`）。

**测试里的请求没有 `Content-Length`**
在测试里直接构造的 `Request` 不带 `Content-Length`，真实的 HTTP 请求有。上传接口两条路都处理了：有这个头就先比大小（超过 3 MB 回 413）；没有就边收边数，超出申请的大小就断开。

**上传被拒时测试输出里有 `Can't read from request stream because client disconnected`**
上传的大小不对时核心会中途停止读取，测试运行时就打印这一行。不影响结果，没找到办法让它不打印。

## 每日摘要的数字

**总结里的条数不能让模型数。** 一份摘要的页眉数（`counts.saved`）和列表来自快照（`entries`，交回那一刻的 `coveredItems`），总结却是模型写的字。线上有一份：页眉 16、列表 16 个不同的条目，总结说 15（core#3、internal-qa #27）。两个来源：模型数错；以及模型写的时候又有一条解读落进来了（21:00 以后到午夜前解读还会进这一天），交回时的集合比模型看到的多一条。现在：`services/digestcheck.ts` 找出总结里「当作总数说的数字」（数字、英文数词、中文数字到 99，`存入了 15 条`、`saved fifteen items`、`共 16 条`、`15 items were saved` 一类），和交回时的条数比。内置助手：给模型的输入带 `total`，不一致就带着更正再问一次（最多两次），还不一致就由核心自己写一句（`这份每日摘要汇总了 16 条解读。` / `This daily digest covers 16 analyses.`），模型的睡前一问和值得深挖照用；别的助手：`invalid_result`，原因里写着正确的数目，什么都不存。没有当作总数说的数字（「其中 3 条是讲茶的」）不算数，也不拦。这是个守卫不是证明：写成别的样子的总数它认不出来。

**「总数」要认窄：别的数量、子集、话题都不算。** 第一版把 `a total of 5 minutes`、`其中共3条讲茶`、`茶叶合计50克` 都当成了「这份摘要的条数」，一份说对了 16 的总结被拒（外部助手 `invalid_result`，摘要卡在待写）或白白多问模型一次、丢掉好好的总结（QA 在 c9b9fea 上复现）。现在 `digestcheck.ts` 要三样：数的是条目（条目词或条目量词，`分钟`、`克`、`个小时`、`元` 不算）；不是子集（前面同一句里有 `其中`、`of these`、`including` 一类，或者数字后面紧跟话题 `about tea` / `讲茶`、来源 `from videos`）；光写「共 / 合计 / a total of」这种裸的总数词时，只在第一句或者旁边有「今天」「这份摘要」「across the day」才算。写了「存入了 / saved」这类动词的不用这最后一条。代价写在这里：`茶叶共3条。` 如果是摘要的第一句，会被当成总数；`今天共3条值得细读` 也会（旁边有「今天」）。这是守卫，不是证明；宁可漏掉一个写错的总数，也不要拒掉一份对的总结。

**但摘要自己做主语时，数字后面的话不让它变成子集。** 收窄之后漏了另一边（QA 在 a3c855e 上复现）：`This digest covers 15 items, which span tea and coffee.`、`这份每日摘要汇总了15条关于茶的解读。` 明明是在说这份摘要涵盖多少条，却因为数字后面的 `which` / `关于` 被当成「话题」，写错的 15 就这样放行了。现在要两样一起有才绕过「后面是话题」这条：数字前面有摘要本身（`digest`、`summary`、`这份`、`摘要`），而且动词是「涵盖」一类的范围动词（`covers`、`汇总了`、`涵盖了`、`包含了`）。`saved 3 items about tea`、`这份摘要里共3条讲茶`、`The digest has 3 items saved from videos` 仍然是部分，因为「存入了」「共」可以只说一部分。同一句里先有 `其中` / `of these`，还是子集。

**两次回答是这一份摘要的总预算，不是每一次 Cron 的。** 内置助手第一次回答读不出来时，把认领放回去、返回，下一分钟的 Cron 又从头问；`DIGEST_ASKS = 2` 只管一次调用，用量也没记（QA 在 6f28c34 上看到 3 次 Cron 3 次调用，`usage_records` 是空的）。现在读不出来的回答也记一条用量（`recordUnusedUsage`，挂在那次认领上，不收任何条目），每次认领先用 `digestCallsSpent` 数这一天这份摘要已经被回答了几次（认领的 `refs` 是这一天，只数核心自己测的 `self_reported = 0`），总共两次，用完当天不再问，摘要保持待写，不编问题也不编值得深挖的列表。没有回答（模型挂了、超时）不记、不占预算，所以一小段故障不会让一天的摘要写不出来。第二天是新的一天、新的预算。没有新的迁移：预算就是用量记录本身，记账和限额是同一份数据。

**旧的错摘要原样留着。** 这次改动只管之后新写的摘要。已经存下来的那份（总结 15、页眉 16）核心不改、不补、不迁移：用户的历史内容不动，QA 也不改。要不要更正它是另一件事，要有人批准；如果批准，办法是运营者对那一天单独处理，不是一个批量重写。核心里没有这个入口，也没有加。

## 读取页面

**短链也是小红书，要在跳转之前就认出来。** `xhslink.cn` / `xhslink.com` 一开始没进「小红书」那份域名表（只有 `xhslink.com`），统计里记成 `other`，没有优先交给 runner，也没有先用手机身份。现在表只有一份，`pagerules.ts` 的 `XIAOHONGSHU`，用户代理顺序、短帖、核心的平台分类、runner 的平台分类都读它；新加一个域名只改这一处。

**一条失效的短链会跳到小红书首页，首页的字被当成内容存下来。** 真跑一条不存在的 `xhslink.cn/o/…`：Chromium 回 200，最后落在 `https://www.xiaohongshu.com/`，页面是「热门笔记」的信息流（264 字），够长，进了条目。现在小红书的链接如果被要求的不是首页、最后落在首页或 `/explore`（信息流），直接算读不到（直接读在跳转那一步就不再取；runner 回 502）。别的站没有这条：没见过证据，也有短链指向首页本来就是用户要的。

**登录页没被当成拦截页，它的字成了条目的标题。** 小红书对不认识的访客把笔记跳到 `rednote.com/login?redirectPath=…`；页面标题（`登录 - rednote …`）不能用，条目就退到「正文第一句」当标题，而登录页的字够长，被当成内容存了下来，解读还把它描述成「一个登录页」。现在：地址是登录地址（路径第一段是 `login` / `signin`，或主机是 `passport.`）就不再去取；登录页的字样（`使用手机号或扫码登录`、`Continue with Google` 等）算拦截，但只在标题、描述，和文字很短的页面开头里算：一篇讲怎么做「Continue with Google」按钮的长文还是文章。笔记自己的数据（`__INITIAL_STATE__`）有的，runner 只判笔记自己的字，不判它周围的页面（笔记上盖着的登录框不是笔记）。

**拦截页的字样不能在整页源码里找。** 旧项目对页面前 2 万字符的源码找「验证墙」的字样；直接搬过来，一篇长文章的脚本或菜单里出现一句「完成验证」就会被当成被拦。现在标题、描述、正文开头一直算，源码开头只在页面本身很短（不到 400 个字）时才算。`<noscript>` 里的「Enable JavaScript and cookies」不在正文里（正文抽取跳过 noscript），所以单独收一段。

**短帖的正文最少 15 字就放行，这条没有搬。** 旧项目靠 trafilatura 抽出干净的正文，所以 15 字够了；这里用 HTMLRewriter 抽，页面自己的菜单字（`Explore`、`Notifications`）也会凑够 15 字，把壳当成了内容（这条测试 `a page that is only a shell keeps its title` 会挂）。只留「描述有 40 字就是帖子本身」，并且存进去的正文换成描述，不是壳里的字。

**标题的「像错误页」要整句匹配。** 旧正则 `error\b` 开头匹配，「Error handling in Rust」会被丢；`\W` 在 JS 里不认中文，「我的登录页设计」会被当成登录页。现在只在整个标题就是那个词、或者词后面跟分隔符（`登录 - 知乎`）时才算，字母和数字用 `\p{L}\p{N}` 判。

## 解读的语言

**写成什么语言是按条目算的，`Target`（`builtin.ts`）。** 缺省跟着条目自己的字（标题、正文、识别出来的文字）：看字形，汉字为主就写简体中文，拉丁字母为主就「条目自己的语言」（核心分不出英文和法文，只叫模型别翻成别的）；少于五个字母、假名、谚文、西里尔等判断不了的，用账户的语言。账户里「总用我的语言」（`always_my_language`，缺省关）打开时一律用账户的语言（Cheney 2026-11-26，选 2）。**只管新写的**，改开关不重写已有的解读。每日摘要按当天多数解读（`digestTarget`），一样多用账户的语言。别的助手经 `get_rules` 拿到 `lang` 和 `always_my_language`，自己照规格写。**摘要两次对不上数、由核心自己写的那一句，语言也走同一个 `Target`（`targetOf(ctx).check`），不是账户的**：第一版写死 `user.lang`，开关关着、当天多数解读是中文的英文账户，提示要求中文，兜底句却是英文（QA、Project 认定为本 PR 的契约偏差）。凡是「摘要用什么语言」的地方只认 `digestTarget` 这一个出口，别在旁边再读一次 `user.lang`。

**模型照着条目的语言写，不照系统提示里的语言。** 英文账户存一条中文笔记，系统提示写着「Write in English」，解读却是中文（QA #18、core#2）；反过来也一样。提示在最前面，条目的标题、正文、用户的规则都是另一种语言，模型就跟着它们走。所以要写成账户语言时（开关开着，或条目语言判断不了）三处一起管：系统提示最后一句明说「不管条目是什么语言，都译成账户的语言」；事实 JSON 里放 `write_in`，紧挨着数据；回来的字段**逐个**按文字的字核对，不对就带着 `correction` 再问一次。跟着条目写时，提示反过来说「不要翻成别的语言」，核对的是「有没有写成另一类文字」。

**语言检查是按文字判断的启发式，不是语言识别。** 英文：汉字、假名、谚文、西里尔等非拉丁字母占字母的比例不到三成；中文：汉字占三成以上，且假名等非汉字、非拉丁的字母不到两成（日文过不了）。数字、符号、网址、邮箱、引号里的话不算；少于五个字母的字段（`PDF，3 页`、人名）不判。**别把几个字段拼在一起判**：一段长长的英文摘要会把另一个字段里整句的中文稀释到三成以下，漏掉（QA 在 core#5 上给的例子）。

**再问一次是尽力而为，不是保证。** 第二次只有比第一次好才换：交得上去的答复（有内容概述和三选一的判定）好过交不上去的，同样交得上去的，毛病少的好；一样就留第一次的，第二次不是 JSON、说「读不出来」或缺判定也一样：条目不会因为语言或要点被判成读不出来，也不会丢掉本来能交的第一份（QA 在 core#5 上给的例子：第二次语言对了、有要点，却没有判定）。一个条目的所有模型请求共用一份预算（`ANALYSIS_BUDGET_MS`，缺省 40 秒；第一次最多 25 秒，修正拿剩下的，剩不到 8 秒就不问；HTTP 请求最多 3 个）。以前每次 `callModel` 各有 25 秒，再加上网关不认 `effort` 字段时的那一次重发，一个条目最多 50 秒、4 个请求；现在一个网关拒绝过 `effort` 之后，修正请求不再带它。**回来的每一个答复都是花了钱的**，不管最后用不用：用量把一个条目所有答复的 token 加起来，一个没交上去的答复（不是 JSON）也记一条 `items = 0` 的用量。拒绝（`stop_reason: refusal`）、没有内容、内容是空的这三种，`callModel` 返回 `null`，但服务方报了 `usage` 就照记（`onUnusedReply`）；没报的不编。测试里的假模型要「照条目的语言写，除非带了 correction」才像真的；默认的假模型照标题写，会被这条检查拦下重问。

## 模型调用的花费

**答案能不能用，和这一次花没花钱，是两件事。** `callModel` 对「没有可用文字」（空答案、`stop_reason: refusal`、没有 `content`）一律回 `null`，调用方只对非 `null` 记次数和 token：一个带着 `usage` 的空答案或拒答，钱花了、账没记，每日摘要「累计最多两次」的预算也没被用掉，下一次 Cron 还能再问（QA 对 `3e751d1` / `316e20d` 的复审）。现在 `askModel` 把两件事分开回：`reply`（能用的答案，或 `null`）和 `cost`（模型自己说的 `usage`；没说就是 `null`，不替它编）。每日摘要按 `cost` 记账、按 `cost` 用预算；`callModel` 是它的一层包装，别的调用（分派、解读）行为不变。

**没有回应就没有花费。** 超时、网络错误、4xx/5xx（不管响应体里写没写 `usage`）、或者 200 但体里根本没有 `usage`（网关自己的报错）：`cost` 都是 `null`，不记次数，不用预算。这也意味着：一个总是回 200 且不带 `usage` 的空答案，预算数不上去，每次 Cron 还会再问；那一类持续故障的次数上限不在这里（要另做：持久的尝试计数或退避）。

## 抓取 runner（`runner/`）

**浏览器自己走网络，只经过 `runner/src/proxy.ts`。** 一开始让 Node 替浏览器发所有请求（`route.fulfill`），结果 Cloudflare 对 `example.com` 回 403：Node 的 HTTP/1.1 和 TLS 指纹不是 Chrome 的，`curl` 同一台机器却是 200。现在 Chromium 用自己的网络栈（指纹是 Chrome 的），代理只管「能连到哪」：主机是公开的、端口是 80/443、名字解析出的**每个**地址都是公开的，再连到查过的那个地址。`route` 只留下拦图片/音视频/字体和网址检查。

**`http.request({ createConnection })` 不够：没有自己的 agent 时它还是自己解析名字。** 代理转发 `http://` 地址时一开始这么写，测试里一个不在任何 DNS 里的名字报 `ENOTFOUND`，才发现 Node 绕过了我们查过的地址（放到线上就是 SSRF）。要用一个覆盖 `createConnection` 的 `http.Agent` 子类（`PinnedAgent`），`proxy.test.ts` 里有回归测试。

**Chromium 对回环地址默认不走代理。** 要给每个 context 的代理写 `bypass: "<-loopback>"`，并且启动时 `proxy: { server: "per-context" }`；否则页面请求 `localhost` 会直接连到本机。测试里用一个只计数的 canary 服务验证（含 WebSocket）。

**代理把 `http://` 地址拒掉时，浏览器当成站点自己的 403。** 所以拒绝的应答带 `x-runner-refused` 头，`render.ts` 看到就当错误，不当成「站点拒绝，换 UA 再试」。

**无头 Chromium 的 `--accept-lang=` 照写进 `navigator.languages`。** 写成 `zh-CN,zh;q=0.9` 会让它变成三项乱码；只写 `zh-CN,zh,en`，请求头由 Chrome 自己写（完整 Chromium 是 `zh-CN,zh;q=0.9`，headless shell 不带权重）。

**Node 直接跑 `.ts` 不认构造函数的参数属性（`constructor(private x)`）。** 只擦类型，不转换语法。`runner/tsconfig.json` 开了 `erasableSyntaxOnly`，写错时 `typecheck` 就报。导入要带 `.ts` 后缀；`src/services/pagerules.ts` 和 `publicurl.ts` 因此不能有别的导入。

**不能靠 yt-dlp 叫起来的 ffmpeg 自己守规矩。** 某些 HLS/DASH 流 yt-dlp 可以交给 ffmpeg 去下，那条连接走不走 `--proxy` 要看 yt-dlp 的版本，这里没有去验证，也不依赖它。所以下载参数里写 `--downloader "dash,m3u8:native"`（用它自己的下载器，走 `--proxy`），子进程环境里也写上代理；`ffmpeg` 抽音频时只开 `-protocol_whitelist file`，下载回来的文件就算是一份指向别处的播放列表也打不开任何地址。`runner/test/media.test.ts` 有参数列表的测试，和一条用真 yt-dlp + ffmpeg 穿过真代理的冒烟测试（没装就跳过）。

**yt-dlp 和 ffmpeg 的参数里有代理密码。** 每次读取的代理账号和密码在参数列表里（`ps` 看得到，和环境一样只在本机、读完即失效）。所以 `exec.ts` 的报错只有固定的几个词，不带参数也不带程序的输出；日志里没有地址、任务号、正文。收到「取消」要杀整个进程组（`detached` + `kill(-pid)`），yt-dlp 起的 ffmpeg 才会一起停。

**视频任务的 20 分钟期限从开始跑算，不从排队算。** 排 4 个、一个约十几分钟，排队就要近一小时（core 等 60 分钟）；期限算排队的话后面的任务会在开始前就过期。

**小红书视频笔记的字段是照单子里写的路径取的，没拿真页面验过。** `noteData.type === "video"`、`video.capa.duration` 或 `video.media.video.duration`（按秒）、`video.media.stream.h264[].masterUrl`。测试里的页面是照这些路径做的；真站点改了字段，视频笔记会变成「没取到媒体地址」（`unavailable`），作者自己的话照旧返回。腾讯视频不在 core 的「短帖站点」名单里（`pagerules.ts` 的 `SHORT_FORM`），它页面的描述不当作者的话，作者的话为空。

**`vitest` 不会去跑 `runner/test`。** core 的 `vitest.config.ts` 只收 `test/**/*.test.ts`；runner 的测试用 `node:test`，在 `runner/` 里 `npm test`，CI 里是单独一项。

## 转写 worker（`transcriber/`）

下面几条都是写这个 worker 和它的测试时碰到的，在本机（macOS，Python 3.9 到 3.14）和一个 Linux 容器（Python 3.11、断网）里跑自动测试验过。MLX 没有装，真正的引擎没有跑过。

**没读完请求体就答，连接会被重置，答案到不了客户端。**
401、busy 的 503 这类早早就拒绝的情况，一开始答完就关连接；请求体（测试里约 1 MB）还留在套接字里，关的时候系统发 RST，客户端报连接错误，看不到 401 或 503。现在答完以后把剩下的请求体读掉丢掉（busy 最多读到 40 MiB，别的拒绝最多读 1 MiB，总共不超过 10 秒）。把这一步去掉，`test_a_refused_upload_is_still_answered_when_the_body_is_large` 和 busy 那条测试就挂。

**「答完了」之前，引擎要先放开、临时文件要先删掉。**
第一版是先把答案写给客户端，再在 `finally` 里放锁、删文件。调用方拿到答案立刻发下一条，可能撞上还没放开的锁，得到 busy；检查临时目录的人也可能还看得到文件。现在处理的结果先算出来，放锁、删文件，最后才写答案。注意：连发 30 条请求的测试**抓不到**这个错（窗口太小，改回旧顺序它照样过）。能抓到的是在写日志的那一刻（就在写答案之前）看锁和临时目录，`test_the_engine_is_free_and_the_file_gone_before_the_answer_goes_out`。

**`serve_forever()` 的轮询间隔让每条测试多等半秒。**
`shutdown()` 要等循环醒来，默认 0.5 秒，一百多条测试跑了 20 秒。测试里用 `serve_forever(0.01)`，现在 2 秒。

**做变异检查（临时改源码再还原）时，还原也要用 `/bin/cp -f`。**
脚本里的 `cp` 又是带确认的别名，停在「overwrite? (y/n)」，源码留在改坏的状态，要手工还原。先把原文件另存一份，还原后用 `diff` 确认。
**长度不明的请求体（分块上传）被拒后不能立刻关连接。** `test_a_body_without_a_length_is_411` 在 CI 上偶尔挂在 `BrokenPipeError`（本机循环 400 次约 7 次）。原因在服务端，不在测试：回 411 时分块的请求体还在路上，`_drain` 只会按 `Content-Length` 读，分块的长度不明，读 0 字节就关了连接，随后到的数据让内核回一个 RST，客户端写第二下就 `EPIPE`，答复也可能随 RST 丢掉。现在这种连接答完先 `shutdown(SHUT_WR)`，再把还在来的数据读掉扔掉（最多 `DRAIN_LIMIT`、`LINGER_SECONDS` 没动静就停，客户端关了就停），再关。`test_the_411_does_not_cut_off_a_chunked_body_that_is_still_on_its_way` 把请求体放在答复读完之后才发，旧写法每次都挂在同一处（`0\r\n\r\n` 那一下）。客户端真的断了（`OSError`）还是照旧当作断了，没有吞别的异常。

## 视频（#103）

**等视频的条目要和「等页面」的一起排除，漏一处就会被解读。** 条目分派、解读的选取在好几处各写了一遍 `fetch_state <> 'pending'`（`work.ts` 的两个 WHERE、`cron.ts` 里内置助手的两条查询）。新增 `video_wait` 以后只改一处，另一处就会把还在等视频的条目拿去解读。现在统一写成 `services/items.ts` 里的 `WAITING_STATES`；把它改回只有 `pending`，`test/video.test.ts` 里四条测试会挂。核心自己的默认初筛（`applyTriageDefaults`、`triageDefaults`）原来对 pending 也不设防，这里对 `video_wait` 单独排除。

**核心默认初筛的 10 分钟要从「不再等」那一刻算，不能还从存入算。** 等了 20 分钟才读好的视频，如果还按存入时间算，读好的那一分钟里核心就先给它默认值，分派助手和用户自己的助手一次机会都没有。所以多了 `video_done_at`，默认初筛用 `COALESCE(video_done_at, created_at)`；把它改回 `created_at`，「用户自己的助手」那条测试会挂。

**测试里先 GET 条目再查通知，通知是空的。** 打开一条解读过的条目就算「看过了」（`viewed_at`），通知里就不再提它。要核对通知的文字，先把 `viewed_at` 清掉，或者先查通知再打开条目。

**B站给手机端的是 `m.bilibili.com/video/BV…?site=OVERSEAS&lang=…`，yt-dlp 在那个地址上什么也读不到。** runner 先用 iPhone 身份读页面（B站在「手机优先」名单里），浏览器就落在了手机站；用落地的地址去问时长，得到 `null`，视频被判成「没取到」（`unavailable`），而不是「太长」或开始读。现在凡是 `bilibili.com` 下 `/video/BV…`、`/video/av…` 的地址，都改成同一个视频在 `www.bilibili.com` 上的页面，只留分 P 的 `p`。是用真视频（一条 20 分钟的央视新闻）在 think 上才发现的；测试里的假页面是 `www` 的，看不出来。

**yt-dlp 的 stderr 一直被丢掉，所以看不到站点回的是 567。** Bilibili 的 CDN 拒绝下载时回 HTTP 567（yt-dlp 写 `HTTP Error 567`），而下载是 HTTPS，代理只看得到一条 CONNECT 隧道，看不见状态码。只能从 yt-dlp 的输出里读：`exec.ts` 的 `watchStatus` 只取 `HTTP Error <三位数>` 这个数字，其余（里面有地址）读完即丢，不进错误、不进日志。冷却按站点名（`bilibili.com`，`b23.tv` 算同一个站）记在内存里，只记名字不记地址；重启就忘，所以重启后第一个视频会再被拒一次，再开始冷却。

## Workers 运行时

**往 R2 流式写入必须知道长度**
`TransformStream` 出来的流没有已知长度，`R2.put` 不收。现在用 `FixedLengthStream`（长度就是申请上传时说的字节数），前面再接一个计数的 `TransformStream`，这样既是流式的，又能把大小锁死。

**请求体只能读一次**
路由层按契约先读了请求体做校验，MCP 端点再读就是空的，回了 `Parse error`。现在 MCP 端点的请求体由它自己读（JSON-RPC 的报错格式也和别的接口不一样）。

**表单请求不要用 `request.text()`**
`application/x-www-form-urlencoded` 的请求用 `.text()` 读，运行时会打印「看起来不是文字」的警告。现在读成字节再解码。

**D1 没有交互式事务**
只有 `batch()`：一组语句要么全做要么全不做，但不能在中间读了再决定。所以：
- 认领是一条带条件的 `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING`，两只助手同时来也只会各拿到不同的条目。
- 交回是先把所有检查做完、把要写的语句攒齐，最后一次 `batch()` 写入。格式不对的交回在写之前就整个拒掉。
- 撤销助手、放回它认领的活、把它负责的步骤改回缺省，是同一个 `batch()`。

**FTS5 的缺省分词不认中文**
`unicode61` 不切中文，「乌龙茶」搜不到。笔记的索引用 `trigram`，任意三个字都能匹配；不足三个字的查询、或者索引不可用时，退回 `LIKE`。条目的关键词查询（`GET /v1/items/search`）直接用 `LIKE`，没建索引。

**Hono 的路径参数不认 `{secret}.svg`**
`/c/:secret.svg` 会把 `.svg` 当成参数名的一部分。现在注册成 `/c/:secret{[^/]+\.svg}`，处理时再去掉后缀。

## 设计上要记住的

**抓网页防不住「域名解析到内网」**
Workers 里查不了 DNS，只能按地址的写法拦：非 http/https、内网和回环和链路本地的 IP（含十进制、十六进制写法和 IPv6）、`localhost`、`.local`、`.internal` 等，每次跳转都重查。一个公网域名解析到内网地址这种情况拦不住；不过 Workers 发出的请求本来也到不了账号的内网。

**通知的批次是先删再发**
到点的批次先从库里删掉再发送，发送失败只在当次重试一回。这样保证一条不会说两遍，代价是推送服务连续失败两次时这一批就丢了。

**时区的 21:00 是算出来的**
没有用数据库的时间函数。用户的本地日期和小时用 `Intl.DateTimeFormat` 算，「本地 21:00 是哪个时刻」用猜一次再修正的办法算（`src/time.ts`）。夏令时切换那一小时没有专门测。

**免费档的限制**
每次调用 CPU 时间很短、数据库查询最多 50 次。每分钟的定时任务里，每多照顾一个用户大约要 10 到 20 次查询，所以缺省每分钟只初筛 2 个用户、解读 1 个用户的活。这个数是估的，没有在线上的免费档实测过。
