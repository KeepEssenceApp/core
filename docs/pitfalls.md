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
