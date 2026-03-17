---
title: 流式生成 UI 与 GenUI 框架完整指南：从 A2UI 到 Flutter 落地
date: 2026-03-17 14:53:21
tags: 
---

## 一、流式生成 UI 是什么

**流式生成 UI** 指服务端持续、分片地向客户端发送 UI 描述或内容，客户端边收边解析、边渲染，用户能逐步看到界面被拼出来，而不是等整段响应结束才一次性显示。

特点可以概括为：**渐进式**（先出来的先渲染）、**低首屏延迟**、适合 AI 对话、智能体界面、动态表单等「边想边展示」的场景。

---

## 二、当前常见实践方案

| 方案 | 形态 | 流式方式 | 典型场景 |
|------|------|----------|----------|
| **A2UI 协议**（Google） | 声明式 JSON | JSONL + SSE | 多端、智能体 UI、标准化 |
| **Vercel AI SDK** | React 节点 | RSC 流 | Next.js / React 全栈 |
| **Hashbrown** | 组件 + 工具 | 框架内置流式 | 多模型、生成式 UI |
| **SSE + Markdown** | 文本/MD | SSE | 聊天、文档展示 |
| **LLM 直接生成代码** | 可执行代码 | 文本流 | 高定制、需沙箱 |

其中 **A2UI** 是声明式 UI 协议：Agent 发 JSON 描述界面，客户端用自有组件渲染，安全、跨平台、LLM 友好。**GenUI** 是 Flutter 官方对 A2UI 的落地实现。

---

## 三、A2UI 与移动端支持

- **官方**：Flutter GenUI SDK 稳定支持 **iOS、Android、桌面、Web**；SwiftUI（iOS）、Jetpack Compose（Android）计划 2026 Q2。
- **社区**：A2UI-Android（Jetpack Compose）、a2ui-react-native（iOS+Android）等。

要在移动端用 A2UI，当前最直接的方式是 **Flutter + GenUI**。

---

## 四、GenUI 如何落地、如何使用

### 核心概念

- **Catalog**：组件目录，AI 只能使用这里声明的组件（名称、schema、Flutter builder）。
- **SurfaceController / A2uiMessageProcessor**：收 A2UI 消息、维护 DataModel、驱动 Surface 更新。
- **DataModel**：集中式、可观察的 UI 状态；组件通过数据绑定读写。
- **GenUiSurface**：根据 surfaceId 从 host 取 UI 定义，用 Catalog 渲染。
- **GenUiConversation**：对话门面，发消息、接流、把事件回传 Agent。
- **ContentGenerator**：和 AI 通信（如 Gemini、Firebase、A2A 服务端）。

### 两种典型落地方式

1. **客户端 LLM（Gemini）**：`genui` + `genui_google_generative_ai`，Flutter 直接调 Gemini，无需自建服务端。
2. **服务端 A2UI**：`genui` + `genui_a2ui`，Agent 跑在服务器，通过 A2A 协议推送 A2UI 消息，Flutter 只负责渲染和发事件。

### 适用场景

- **适合**：根据用户/对话动态生成表单、列表、按钮等；设计好的**组件库** + Agent 组合出界面；页面里**某一块区域**由 AI 动态生成。
- **不适合**：把 Figma 某一张固定页面 1:1 实现（应用常规 Flutter 开发）；完全随机、无约束的界面。

生成结果由 **Catalog + Agent 的 prompt** 约束，不是随机。

---

## 五、生成的 UI 点击后谁处理、在哪处理

- **默认**：点击由 **Agent** 处理。事件链路为：Catalog 里 Button 的 `onPressed` → `dispatchEvent(UserActionEvent)` → GenUiSurface → `host.handleUiEvent` → A2uiMessageProcessor 推到 `onSubmit` → GenUiConversation 的 `onSubmit.listen(sendRequest)` → **ContentGenerator.sendRequest**，即把「用户点击了某按钮、context 为 {...}」作为新的一轮用户消息发给 Gemini；**Gemini 的下一轮回复**就是对这次点击的“处理”。
- **在哪处理**：Flutter 侧只负责「捕获 + 上报」；业务逻辑在 **服务端/Agent** 的回复里（文字或新 A2UI）。若要在 Flutter 里自己处理部分点击，可监听 `A2uiMessageProcessor.onSubmit` 做分支，或使用 A2UI 的本地 action（若 Catalog 支持）。

---

## 六、标准组件如何告知 Agent

- **Catalog = 标准组件清单**：在自定义 Catalog（JSON Schema）里只声明你允许的组件；Agent 只能使用这些组件名和属性。
- **客户端声明优先使用**：在发给服务端的 `a2uiClientCapabilities.supportedCatalogIds` 里，把**你的标准组件 Catalog 的 URL 放在第一位**，Agent 创建 surface 时会优先选这份 catalog。
- **Agent 创建 surface**：服务端发 `createSurface` 时指定 `catalogId` 为你的 catalog。
- **Prompt**：在 Agent 的 system prompt 里写「只使用 catalog 内组件，优先使用 XX、YY 组件做某某场景」。
- **Flutter 侧**：在 GenUI 的 Catalog 里，把 catalog 中的每个组件名映射到你们的标准 Widget，保证渲染的是你们的 UI。

---

## 七、本地 GenUI Demo 与配置

### 项目结构（示例）

- `pubspec.yaml`：依赖 `genui`、`genui_google_generative_ai`。
- `lib/main.dart`：创建 `A2uiMessageProcessor`（CoreCatalogItems）、`GoogleGenerativeAiContentGenerator`、`GenUiConversation`；通过 `onSurfaceAdded` 收集 surfaceId，用 `GenUiSurface(host, surfaceId)` 渲染；底部输入框调用 `conversation.sendRequest(UserMessage.text(...))`。

### 运行与 GEMINI_API_KEY

- 运行：`flutter run --dart-define=GEMINI_API_KEY=你的Key`。Key 从 [Google AI Studio](https://aistudio.google.com/apikey) 获取。
- 在 IDE 运行：在「Additional run args」里填 **`--dart-define=GEMINI_API_KEY=你的Key`**（必须是 `KEY=value` 格式，不能只写 value）。
- Flutter/Dart 版本：genui 0.7.x 要求 **Dart ≥ 3.9**，一般对应 **Flutter 3.24+** 稳定版。

### 配额与绑卡

- 「Set up your Google Cloud billing account」= 开通可计费账号（绑卡），不等于立刻付费。
- 只用免费额度一般不扣费；超出免费额度或使用付费功能才会计费。绑卡后通常会有正常免费额度和更高限额；若遇 quota limit 0，可尝试换模型（如 gemini-1.5-flash）或换账号/等重置。

---

## 八、surfaceId 与要绘制的 UI 组件的对应

- **surfaceId**：一块「画布」的 ID（如 `"main"`），不是某个具体组件。
- **对应关系**：Agent 在 A2UI 消息里用 **surfaceId + components + root** 声明「这块画布上要画哪些组件、树结构是什么」；A2uiMessageProcessor 按 surfaceId 存成 **UiDefinition**（组件树 + 数据）；GenUiSurface(host, surfaceId) 向 host 取该 surfaceId 的 UiDefinition，用 Catalog 递归转成 Widget 树并渲染。
- 因此：**surfaceId 和要绘制的 UI 组件的对应，是在 A2UI 消息里由 Agent 指定，在 host 里按 surfaceId 存起来，再由 GenUiSurface 按 surfaceId 取出来画。**

---

## 九、框架完整流程（串起来）

1. **初始化**：建 Catalog、A2uiMessageProcessor、ContentGenerator、GenUiConversation；接好「A2UI 流 → host」「onSubmit → sendRequest」；界面里为每个 surfaceId 建 GenUiSurface。
2. **发文字**：用户文字 → sendRequest → ContentGenerator 调 Gemini → 模型返回工具调用（A2UI）+ 文字 → a2uiMessageStream / textResponseStream → host.handleMessage / onTextResponse。
3. **渲染**：handleMessage 按 surfaceId 更新 surfaces 和 dataModels；surfaceUpdates 触发 onSurfaceAdded → 新 surfaceId 进列表 → GenUiSurface(host, surfaceId) 从 host 取定义，用 Catalog 递归生成 Widget 树并绘制。
4. **点击**：Button onPressed → dispatchEvent → GenUiSurface 交给 host.handleUiEvent → onSubmit 发出 UserUiInteractionMessage → GenUiConversation.sendRequest → 作为新一轮用户消息发给 Gemini，由 Agent 下一轮回复「处理」。

整体形成：**用户发消息/点 UI → GenUiConversation + ContentGenerator 把消息交给 AI → AI 的 A2UI 消息被 host 存成按 surfaceId 的 UI 定义 → GenUiSurface 用 Catalog 把定义画出来；画出来的 UI 上的操作再通过 host 和 sendRequest 回传给 AI。**

---

## 十、页面渲染在哪里、怎么渲染

- **在哪里**：在你的界面里，**每个 `GenUiSurface(host, surfaceId)` 占的那一块区域**就是「页面」的渲染位置；具体绘制逻辑在 genui 包的 **GenUiSurface** 及其使用的 Catalog 里。
- **怎么渲染**：GenUiSurface 通过 **host.getSurfaceNotifier(surfaceId)** 取该 surface 的 **UiDefinition**（根节点 id + 组件列表）；按组件树递归，每个节点根据**类型**在 **Catalog** 里找到对应 **CatalogItem**，用其 **widgetBuilder** 和 DataContext、dispatchEvent 生成 Widget；最终组成整棵 Widget 树，由 Flutter 绘制到 GenUiSurface 所在区域。若无定义则使用你传入的 defaultBuilder（如「加载中…」）。

---

## 十一、小结

- **流式生成 UI**：服务端持续推送 UI 描述，客户端边收边画，适合 AI 驱动界面。
- **A2UI + GenUI**：声明式、安全、跨平台；Flutter 上用 GenUI 即可在 iOS/Android 落地。
- **谁处理点击**：默认由 Agent 通过下一轮回复处理；在 Flutter 里是「捕获 → host → onSubmit → sendRequest」。
- **标准组件**：用 Catalog 限定组件集，supportedCatalogIds 优先自己的 catalog，再配合 prompt。
- **Demo**：genui + genui_google_generative_ai，GEMINI_API_KEY 用 `--dart-define` 传入，Dart ≥ 3.9；页面渲染 = GenUiSurface 从 host 取定义并用 Catalog 画出来。

以上内容基于 GenUI / A2UI 文档与 Flutter 官方 GenUI 示例整理，便于后续查阅与分享。
