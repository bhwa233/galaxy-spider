# Gallery Spider

A web crawler system designed to collect media content from Weibo topics and user posts using a producer-consumer architecture.

一个使用生产者-消费者架构设计的网络爬虫系统，用于收集微博话题和用户帖子中的媒体内容。

## Features / 功能特点

- Producer-consumer architecture for efficient data collection
- Support for Weibo topic crawling
- Support for Weibo user posts crawling
- Media content (images/videos) downloading and processing
- Database storage using Prisma
- Automated testing with Vitest

## Prerequisites / 环境要求

- Node.js >= 22
- [pnpm](https://pnpm.io/) package manager
- Database (supported by Prisma)

## Installation / 安装

```bash
# Install dependencies / 安装依赖
pnpm install

# Setup database / 初始化数据库
pnpm run migrate
```

## Usage / 使用方法

```bash
# Run producer to collect data / 运行生产者收集数据
pnpm run produce

# Run consumer to process data / 运行消费者处理数据
pnpm run consume

# Run tests / 运行测试
pnpm run test

# Run tests in watch mode / 以监听模式运行测试
pnpm run test:watch
```

## Project Structure / 项目结构

```
src/
├── producers/         # Data collection modules / 数据收集模块
│   ├── weiboTopic/   # Weibo topic crawler / 微博话题爬虫
│   └── weiboperson/  # Weibo user posts crawler / 微博用户帖子爬虫
├── consumer/         # Data processing modules / 数据处理模块
├── db/              # Database models and operations / 数据库模型和操作
├── utils/           # Utility functions / 工具函数
└── types/           # TypeScript type definitions / TypeScript 类型定义
```

## Dependencies / 依赖

- `@prisma/client` - Database ORM
- `axios` - HTTP client
- `playwright` - Browser automation
- `sharp` - Image processing
- `vitest` - Testing framework

## Development / 开发

### 微博登录态与 CI 故障恢复

GitHub Actions 的 Producer 和 Consumer 都会从 Gist 获取最新的
`weibo.storage.json`。在仓库 Actions secrets 中配置 `GIST_ID`、
`ACCESS_TOKEN`（需要读写该 Gist）和 `DATABASE_URL`。
下载失败、登录失效或接口拒绝请求会使任务失败。正常空列表仍会成功结束。
运行数据写入数据库，CI 不再自动提交文件，避免把更新后的登录态提交到仓库。

登录态失效时，在有图形界面的电脑上准备 `.env`：

```dotenv
GIST_ID=你的GistID
GIST_TOKEN=有该Gist读写权限的Token
STORAGE_STATE_PATH=weibo.storage.json
```

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm storage:refresh
```

依次完成网页端与移动端微博登录，按终端提示回车。脚本会验证两端接口可用，
然后保存登录态并上传 Gist。刷新后手动运行 Producer，成功后再运行 Consumer。
本地可运行 `pnpm storage:fetch` 检查 Gist 下载与 Cookie 格式。

若刷新后 CI 仍返回 HTTP 418/432，说明登录态刷新尚未解决运行环境中的拦截，
应在同一登录态下对比本地与 CI 请求，确认原因后再考虑使用自己的 runner。
不要对被拦截的接口持续重试。

不连接数据库或微博的故障回归检查：

```bash
pnpm exec vitest run test/producers/weibo-failure.test.ts test/utils/storageState.test.ts
```

The project uses TypeScript and follows a modular architecture. The producer modules collect data from Weibo, while the consumer modules process and store the collected data.

项目使用 TypeScript 开发，采用模块化架构。生产者模块负责从微博收集数据，消费者模块负责处理和存储收集到的数据。

## License / 许可证

MIT
