# 输出 schema 与文件读取规则

## manifest.json（唯一入口，固定文件名）

`doc read` 的 manifest：

```json
{
  "schemaVersion": 1,
  "operation": "doc.read",
  "generatedAt": "<unix 秒>",
  "total": 2, "succeeded": 1, "failed": 1,
  "items": [
    {"seq":0, "docId":"doc_001", "ok":true, "file":"docs/0001.md", "title":"业绩增长", "meta":{...}},
    {"seq":1, "docId":"doc_002", "ok":false, "error":{"code":"API","message":"..."}}
  ]
}
```

- `items[].file` 是**相对 manifest 所在目录**的路径（如 `docs/0001.md`），不是绝对路径。
- 失败项 `ok:false`，`error.code` 是机器可读码，`error.message` 是说明。

`doc list` 的 manifest 不含 `items`，而是：

```json
{
  "schemaVersion": 1,
  "operation": "doc.list",
  "generatedAt": "<unix 秒>",
  "tree": {"file":"tree.jsonl", "documents": 100}
}
```

`tree.jsonl` 每行一个扁平节点，含 `docId`/`title`/`path` 等字段，不含递归 `children`。

## 文件读取规则

用 shell/Read 工具读落地文件。不猜路径、不跨轮复用历史文件、不整读大文件。

1. 先 `cat "<manifest路径>"` 了解本次有哪些文件、哪些成功/失败。
2. 搜索文档树：`grep -i "关键词" "<directory>/tree.jsonl"`，按 `title`/`path` 做大小写不敏感子串匹配，只取命中的 `docId`。
3. 读正文：按 manifest 里对应 `file` 字段读 `<directory>/docs/NNNN.md`。先看文件大小，大文件用 `head -c 4000` 分段读，不一次读完。

落地文件在本轮对话内可反复读取（支持"刚刚的列表里有没有 xxx"这类回查）；跨轮/跨会话一律重新落地，不复用旧文件。
