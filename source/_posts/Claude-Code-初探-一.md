---
title: Claude Code 初探 一
date: 2026-04-02 11:58:10
tags: 
---

# Claude Code 初探 一

> 深入拆解 Anthropic 官方 CLI 智能体的架构设计

## 前言

Claude Code 是 Anthropic 推出的官方命令行 AI 编程助手。与普通的聊天式 AI 不同，它是一个真正的**智能体（Agent）**——能够自主规划、调用工具、读写文件、执行命令，并在终端中提供完整的交互式体验。

本文基于对 Claude Code 还原版源码的深度阅读，从运行机制、系统提示词、工具调用、文件操作、网络能力、认证体系、TUI 渲染等多个维度，拆解其核心架构。

---

## 一、整体架构：两层循环

Claude Code 的运行时架构可以概括为**两层循环**：

```
┌─────────────────────────────────────────────┐
│  外层：React 事件驱动 REPL                    │
│  (useQueueProcessor → 等待用户输入)           │
│                                              │
│   ┌───────────────────────────────────────┐  │
│   │  内层：queryLoop while(true)          │  │
│   │  (发送消息 → 模型推理 → 工具调用 →     │  │
│   │   追加结果 → 继续循环)                 │  │
│   └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 外层 REPL

基于 React Hook 的事件驱动循环，代码位于 `src/hooks/useQueueProcessor.ts`：

```typescript
// 当没有活跃查询 + 队列有待处理命令时触发
useEffect(() => {
  if (isQueryActive) return
  if (hasActiveLocalJsxUI) return
  if (queueSnapshot.length === 0) return
  processQueueIfReady({ executeInput: executeQueuedInput })
}, [queueSnapshot, isQueryActive, ...])
```

它不是传统的 `while(true)`，而是 React 的 `useSyncExternalStore` + `useEffect` 响应式模型——队列变化或查询状态变化时自动触发。

### 内层 queryLoop

真正的智能体循环，位于 `src/query.ts` 第 241 行：

```typescript
while (true) {
  // 1. 调用 Claude API
  const response = await api.messages.create({ messages, tools, ... })
  
  // 2. 检测是否有工具调用
  for (const block of response.content) {
    if (block.type === 'tool_use') {
      needsFollowUp = true
    }
  }
  
  // 3. 执行工具，获取结果
  const toolResults = await executeTools(toolUseBlocks)
  
  // 4. 追加到消息列表，继续循环
  messages = [...messages, ...assistantMessages, ...toolResults]
  
  // 5. 没有工具调用时退出
  if (!needsFollowUp) break
}
```

关键点：**模型不返回工具调用时循环才结束**。一次用户提问可能触发数十轮工具调用。

---

## 二、系统提示词：智能体的"宪法"

系统提示词的构建位于 `src/constants/prompts.ts`，由多个部分拼接而成：

| 模块 | 内容 |
|------|------|
| 身份声明 | "你是 Claude，由 Anthropic 创建" |
| 工具使用规范 | 每个工具的使用场景和注意事项 |
| 安全边界 | 文件操作安全、命令执行限制 |
| 输出格式 | Markdown 格式、简洁风格要求 |
| 环境信息 | 操作系统、shell 类型、工作目录 |
| 动态上下文 | CLAUDE.md 内容、用户偏好 |

提示词中有一个重要的分界线 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`：

```
[静态内容 - 可被 API 缓存] ← 节省 token 费用
────────── 分界线 ──────────
[动态内容 - 每次请求变化] ← 环境信息、时间等
```

这是一个精巧的成本优化设计——静态部分利用 Anthropic API 的 prompt caching 特性，避免重复计费。

---

## 三、工具调用：从文本到函数

这是 Claude Code 最核心的能力。整个流程如下：

### 3.1 工具注册

每个工具用 Zod Schema 定义输入参数，启动时通过 `zodToJsonSchema()` 转换为 JSON Schema，随 API 请求发送给模型：

```typescript
// src/utils/api.ts
function toolToAPISchema(tool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: zodToJsonSchema(tool.inputSchema)
  }
}
```

### 3.2 模型返回结构化调用

Claude 模型返回的不是纯文本，而是结构化的 JSON：

```json
{
  "type": "tool_use",
  "id": "toolu_01A09q90qw90lq917835lq9",
  "name": "Read",
  "input": {
    "file_path": "/src/index.ts",
    "offset": 0,
    "limit": 100
  }
}
```

> **重要**：这是 Anthropic 模型训练层面的能力，不是 prompt engineering 的结果。模型在预训练和 RLHF 阶段就学会了生成符合 JSON Schema 的结构化输出。这也是为什么 Claude Code 只支持 Claude 模型——其他厂商的模型不一定具备相同的工具调用协议。

### 3.3 客户端派发执行

`src/services/tools/toolExecution.ts` 负责将模型的结构化输出转为实际的函数调用：

```typescript
// 第 337 行
async function runToolUse(toolUse, tools, ...) {
  const tool = tools.find(t => t.name === toolUse.name)  // 按名称匹配
  const validatedInput = tool.inputSchema.parse(toolUse.input)  // Zod 校验
  const result = await tool.call(validatedInput, ...)  // 执行！
  return result
}
```

### 3.4 流式并发执行

`StreamingToolExecutor` 更进一步——在模型**还在流式输出**时就开始执行已解析完的工具：

```typescript
// src/services/tools/StreamingToolExecutor.ts
addTool(toolUse) {
  this.queue.push(toolUse)
  this.processQueue()  // 立即开始执行，不等模型输出完
}
```

---

## 四、文件操作：两条路径

Claude Code 操作文件有两种方式：

### 路径一：Node.js fs 模块（直接操作）

用于 Read、Write、Edit 等文件工具：

```
FileWriteTool.call()
  → writeTextContent()
    → fs.writeFileSync(tempPath, content)  // 先写临时文件
    → fs.renameSync(tempPath, targetPath)  // 原子重命名
```

原子写入设计保证了**崩溃安全**——即使写入过程中断电，原文件也不会损坏。

### 路径二：child_process.spawn（Shell 命令）

用于 Bash 工具，执行任意终端命令：

```typescript
// src/utils/Shell.ts
const childProcess = spawn(spawnBinary, shellArgs, { env, cwd })
```

`spawn` 创建的是独立子进程，直接调用操作系统的 shell（如 `/bin/zsh`），可以执行 `git`、`npm`、`curl` 等任何命令。

> `spawn` 和 `fs` 是完全不同的机制：`fs` 是 Node.js 直接调用内核系统调用（如 `write(2)`），而 `spawn` 是创建一个新的 shell 进程来执行命令。

---

## 五、网络能力

### WebFetch（网页抓取）

使用 `axios.get()` 发送 HTTP 请求，并有域名黑名单机制：

```typescript
// 先检查域名是否被封禁
const domainInfo = await api.anthropic.com/api/web/domain_info
if (domainInfo.blocked) throw Error('Domain blocked')

// 然后抓取
const response = await axios.get(url)
```

### WebSearch（网页搜索）

这个并非本地实现，而是利用 Anthropic API 的**服务端工具**：

```typescript
// 发送给 API 的工具定义
{ type: "web_search_20250305" }  // 服务端工具标识
```

搜索由 Anthropic 后端执行，结果通过 API 返回。客户端只负责展示。

---

## 六、认证与安全

### 认证方式

Claude Code 支持两种认证：

1. **OAuth 登录**：通过 `claude.ai` 网页授权，Token 存储在 macOS Keychain
2. **API Key**：直接配置 `ANTHROPIC_API_KEY` 环境变量

优先级链（`src/utils/auth.ts`）：

```
环境变量 ANTHROPIC_AUTH_TOKEN
  → OAuth 存储的 Token
    → 环境变量 ANTHROPIC_API_KEY
      → Keychain 存储的 API Key
        → 配置文件中的 Key
```

### 每次请求校验

认证信息**不在本地校验**——每次 API 请求都携带 Token/Key，由 Anthropic 后端验证：

```typescript
// src/services/api/client.ts
const client = new Anthropic({
  apiKey: apiKey,
  authToken: oauthToken,  // 二选一
})
// 每次 messages.create() 都会在 Header 中携带认证信息
```

后端负责：身份验证、速率限制、用量计费、安全审计、模型推理。

---

## 七、TUI 渲染：终端里的 React

Claude Code 的终端界面不是简单的 `console.log`，而是一个完整的 **React 渲染引擎**：

```
React JSX 组件
    ↓ react-reconciler
自定义 DOM 节点
    ↓ Yoga Layout
Flexbox 布局计算
    ↓ 字符矩阵
屏幕缓冲区
    ↓ Diff 算法
ANSI 转义序列 → 终端
```

### 关键实现

- **自定义 Ink 引擎**（`src/ink/`）：fork 自开源 Ink，深度定制
- **React Reconciler**（`src/ink/reconciler.ts`）：将 JSX 桥接到自定义 DOM
- **Yoga 布局**：Facebook 的 Flexbox 布局引擎，计算每个元素的终端位置
- **Diff 渲染**：维护两帧缓冲区，只重绘变化的字符，避免闪烁
- **16ms 渲染循环**：约 60fps 的刷新率

组件体系：

```
App (顶层容器)
  └── REPL (主屏幕)
       ├── MessageHistory (消息列表)
       ├── PromptInput (输入框)
       ├── PermissionDialog (权限弹窗)
       ├── StatusBar (状态栏)
       └── ToolRenderer (工具执行渲染)
```

共 148 个组件文件，位于 `src/components/`。

---

## 八、上下文管理

### 跨任务上下文持久化

`QueryEngine` 维护一个 `mutableMessages` 数组，贯穿整个会话：

```typescript
// src/QueryEngine.ts
class QueryEngine {
  private mutableMessages: Message[] = []
  
  async submitMessage(input) {
    // 新消息追加到数组
    this.mutableMessages.push(userMessage)
    // 调用 query，传入完整历史
    await query({ messages: this.mutableMessages, ... })
    // 模型回复也追加进去
    this.mutableMessages.push(...assistantMessages)
  }
}
```

任务 A 的对话历史对任务 B **完全可见**。

### 上下文压缩

当消息接近上下文窗口限制时，自动触发压缩——用模型总结早期对话，替换原始消息，释放空间。

---

## 九、Skill 系统：可扩展的能力

Skill 本质上是**预定义的提示词模板 + 工具权限集**：

```typescript
// 技能执行流程
SkillTool.call("commit")
  → 加载 skill 定义
  → 生成提示词 (ContentBlockParam[])
  → 注入为 UserMessage（模型以为是用户说的）
  → contextModifier 自动授权相关工具
  → 模型自主执行
```

例如 `simplify` 技能会启动 3 个并行的子智能体进行代码审查；`commit` 技能会引导模型完成 git 提交流程。

---

## 总结

Claude Code 的架构可以用一句话概括：

> **一个以 Claude 模型为大脑、以结构化工具调用为手脚、以 React 终端引擎为面孔的自主智能体。**

核心设计亮点：

| 特性 | 实现 |
|------|------|
| 自主决策 | queryLoop while(true) + 模型驱动的工具调用 |
| 安全写入 | 临时文件 + 原子重命名 |
| 流式执行 | StreamingToolExecutor 边接收边执行 |
| 高效渲染 | React + Yoga + Diff 的终端渲染管线 |
| 成本优化 | Prompt Caching 分界线设计 |
| 上下文连续 | mutableMessages 跨任务持久化 |

在下一篇中，我们将继续探索 MCP 协议实现、多智能体协调、以及 Claude Code 的插件扩展机制。

---

*本文基于 Claude Code 还原版源码（版本 999.0.0-restored）的实际代码分析，非逆向工程。*