# openclaude Agnes / OpenAI-compatible 协议适配补丁

这是一个针对 `Keep-maker/openclaude` 的源码 overlay。它新增第三种 provider：

```text
Claude Code (Anthropic /v1/messages)
        ↓
openclaude
        ↓  Anthropic → OpenAI Chat Completions
Agnes /v1/chat/completions
        ↓  OpenAI SSE → 严格 Anthropic SSE 状态机
stream-fixup.js（最后安全网）
        ↓
Claude Code
```

目标是解决 OpenAI 兼容网关转换 tool calls 时容易出现的：

```text
API Error: Content block not found
```

## 已实现

- Anthropic `system/messages` → OpenAI Chat Completions `messages`
- Anthropic `tool_use` → OpenAI `assistant.tool_calls`
- Anthropic `tool_result` → OpenAI `role: tool`
- Anthropic tool schema → OpenAI function tools
- `tool_choice` 与 `disable_parallel_tool_use` 映射
- base64 / URL 图片 → OpenAI `image_url`
- OpenAI 普通 JSON response → Anthropic Message
- OpenAI SSE text delta → Anthropic text content block
- **并行 OpenAI tool_calls 缓冲并串行输出为 Anthropic tool_use blocks**
- 工具 arguments 分片重组
- 每个 block 严格 `start → delta → stop`
- 非法 tool id 清洗
- 非法 tool JSON 包装为 `_raw_arguments`，防止 Claude parser 崩溃
- 不把第三方 reasoning 伪装成 Anthropic signed thinking block
- `/v1/messages/count_tokens` 本地估算，避免 Agnes 404
- OpenAI error → Anthropic error shape
- `/v1/models` 可发现配置中的 Agnes 模型
- 转换后的流再次经过 openclaude 原有 `stream-fixup.js`

## 1. 准备上游源码

在你自己的机器上：

```powershell
git clone https://github.com/Keep-maker/openclaude.git
cd openclaude
```

Node.js 要求与 openclaude 一致，建议 Node 20+。

## 2. 应用补丁

把本目录解压到任意位置，然后：

```powershell
node .\apply-openclaude-agnes.mjs C:\path\to\openclaude
```

脚本会：

1. 新增 `src/router/openai-compat.js`
2. 新增 `src/router/provider/openai-compatible.js`
3. 新增 regression test
4. 在 router 中注册 `openai-compatible`
5. 给 `/v1/models` 增加配置型 Agnes 模型发现
6. 把新测试加入 `npm test`

脚本可重复执行。

## 3. 配置 Agnes

编辑：

```text
%USERPROFILE%\.openclaude\config.json
```

把 `config.agnes.example.json` 中的 `agnes` provider 合并进去。中国站：

```json
"agnes": {
  "type": "openai-compatible",
  "baseUrl": "https://api.agnes-ai.cn/v1",
  "apiKey": "$AGNES_API_KEY",
  "chatPath": "chat/completions",
  "models": ["agnes-2.5-flash", "agnes-2.0-flash"]
}
```

国际主站可改为：

```text
https://apihub.agnes-ai.com/v1
```

不要把 API Key 写进 config.json。

## 4. 设置 Key

PowerShell 当前窗口：

```powershell
$env:AGNES_API_KEY="你的 key"
```

持久化到当前用户环境：

```powershell
[Environment]::SetEnvironmentVariable("AGNES_API_KEY", "你的 key", "User")
```

设置后重新开一个终端。

## 5. 测试

在 patched openclaude 源码目录：

```powershell
npm test
```

至少应看到新增测试覆盖：普通工具调用、并行工具调用、SSE 任意切片、非法 arguments、图片、token estimate。

## 6. 本地安装 patched 版本

在 patched openclaude 源码目录：

```powershell
npm install -g .
```

然后：

```powershell
oc start
```

进入 Claude Code 后 `/model` 应出现 `Agnes 2.5 Flash` / `Agnes 2.0 Flash`（启用 discovery 时）。也可以直接输入：

```text
/model agnes:agnes-2.5-flash
```

## 7. 建议先做稳定性压测

让 Claude Code 连续执行 20~50 轮串行工具操作，例如 Read/Bash/Edit。然后再测试两个并行 tool calls。

如果还出现 `Content block not found`：

```powershell
$env:OPENCLAUDE_DEBUG_STREAM="1"
oc start
```

查看：

```text
%USERPROFILE%\.openclaude\stream-debug.log
```

本适配器故意把 OpenAI 并行 tool calls **全部缓存到 finish 后再以稳定的 Anthropic block 顺序输出**。这会牺牲一点工具调用流式延迟，但最大限度降低 content block index 生命周期错乱。

## 配置扩展

若某个 OpenAI-compatible 网关需要额外参数：

```json
"agnes": {
  "type": "openai-compatible",
  "baseUrl": "https://api.agnes-ai.cn/v1",
  "apiKey": "$AGNES_API_KEY",
  "models": ["agnes-2.5-flash"],
  "requestDefaults": {
    "temperature": 0
  },
  "headers": {
    "X-Custom-Header": "$MY_HEADER_VALUE"
  }
}
```

`model` 和 `messages` 始终由 router 控制，不会被 `requestDefaults` 覆盖。

## 当前有意不做的功能

- 不将 Agnes reasoning/thinking 输出成 Anthropic `thinking` block。第三方 reasoning 没有 Anthropic 签名，伪装后会污染会话并导致后续 replay 失败。
- `count_tokens` 是本地估算，不是精确 tokenizer。它的目的主要是避免 Claude Code 请求 `/v1/messages/count_tokens` 时直接 404。
- tool call 在 OpenAI SSE 中先缓冲再输出，因此工具参数不会逐 token 显示；这是为了协议稳定性。
