---
name: youdu-kb
description: >-
  读取、搜索和浏览有度（Youdu）知识库。用于回答企业内部知识问题、按标题查找文档、
  批量读取正文、浏览空间和文档树、查看版本历史；即使用户未明确提到有度，只要问题需要
  企业内部资料就应使用。通过 youdu-cli 命令查询，需先确认 CLI 已安装并 init。
---

# 有度知识库

通过 `youdu-cli` 查询知识库，把结果落地成本地文件，再用 shell/Read 工具检索读取。

## 前置条件

执行任何 kb 命令前先确认 CLI 可用：

```bash
youdu-cli --version
```

命令不存在则停止，提示管理员安装 CLI。管理员需已用 `youdu-cli init` 完成配置；
agent 不执行 init，也不索要或回显 botId/secret。

## 查询流程

1. 每个新问题都重新查询，不把历史对话里的空间列表、文档树、正文当缓存。
2. 已知 `docId` 时，收集本轮全部 ID，一次 `kb doc read --output file` 批量读。
3. 按名称或主题查找时，先 `kb wiki list`，再对相关空间 `kb doc list --output file`。
4. 在文档树落地文件里按 `title`/`path` 检索，定位命中的 `docId`。
5. 收集命中 `docId`，一次 `kb doc read --output file` 批量读正文。
6. 按 manifest 定位正文文件，分段读 Markdown。
7. 需要历史内容时，用 `kb doc versions` 和 `kb doc version-read`。

## 命令

```bash
youdu-cli kb wiki list
youdu-cli kb doc list --wiki-id <wikiId> --output file
youdu-cli kb doc read --doc-id <docId> [--doc-id <docId> ...] --output file
youdu-cli kb doc read --doc-id-file <path> --output file
youdu-cli kb doc versions --doc-id <docId>
youdu-cli kb doc version-read --doc-id <docId> --version-id <vId>
```

参数细节以 `youdu-cli <command> --help` 为准。不要猜测 `wikiId`/`docId`/`vId`。

## 输出模式

`--output file` 把结果写入系统临时目录，stdout 只返回摘要（JSON），其中 `directory`/`manifest` 是定位入口：

```json
{"output":"file","operation":"doc.read","directory":"<绝对路径>","manifest":"<绝对路径>/manifest.json","total":2,"succeeded":1,"failed":1}
```

`doc list` 的摘要多一个 `tree` 字段，指向文档树文件。

完整字段、`manifest.json`/`tree.jsonl` 结构与文件读取规则见 [reference/output-schema.md](reference/output-schema.md)。

## 共享规则

标题搜索、批量读取、回答与引用规则见 [reference/shared-rules.md](reference/shared-rules.md)。

## 错误处理

- 尚未初始化（提示先运行 init）：停止，提示管理员完成 `youdu-cli init`。
- 服务端错误为数字码 + 描述（形如 `开放接口错误 [70003] token is expired`）。CLI 遇到 token 类失败（70003）会自动刷新一次并重试，失败会如实转述：
  - `70003`（token 缺失/无效/过期/吊销）：CLI 已自动重试一次；仍失败则停止，提示稍后重试或检查 bot 配置。
  - `70004` 无权限：报错含 scope 字样（token 权限不足）→ 停止，提示管理员检查授权；单篇文档读取失败 → 该篇失败、继续处理其余文档。
  - `70001` 参数错误 / `70005` 内部错误：如实说明，不重试。
  - `70007` 不存在：如实说明文档/空间/版本不存在，不绕过。
- 网络错误最多重试一次；业务错误不重试。
- 空间或文档树为空：如实说明当前没有可用空间或文档。
