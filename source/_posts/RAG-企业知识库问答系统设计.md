---
title: RAG 企业知识库问答系统设计
date: 2026-04-22
tags: [RAG, AI, Python]
---

最近在做一个企业知识库问答系统，把整个过程记录下来，顺便把技术选型的思考也写出来，供参考。

项目地址：[rag-knowledge-base](https://github.com/lijifeng123/ai_agent_learning_rag/tree/main/rag-knowledge-base)

## 为什么要做这个

企业内部文档越来越多，PDF 规范、Word 合同、Markdown 文档，散落在各处。每次找东西都要翻半天，更别说跨文档综合查找了。于是想做一个能直接用自然语言提问的系统，上传文档后直接问"这个合同的付款条款是什么"，系统自动找到相关内容并给出答案。

这类系统的核心技术就是 **RAG（Retrieval-Augmented Generation）**，先检索再生成。

## RAG 的基本原理

RAG 分两个阶段：

**索引阶段**（离线）
1. 加载文档，解析成纯文本
2. 把长文本切成小块（chunk）
3. 每个 chunk 用 Embedding 模型转成向量
4. 向量存入数据库

**查询阶段**（在线）
1. 用户提问，把问题也转成向量
2. 在向量数据库里找最相近的几个 chunk
3. 把这些 chunk 作为上下文，连同问题一起发给 LLM
4. LLM 基于这些上下文生成回答

关键在于：LLM 不是凭空回答，而是"看着参考资料"回答，这样既能保证准确性，也能避免幻觉。

## 技术选型方案对比

### Embedding 模型

| 方案 | 代表选项 | 优点 | 缺点 | 费用 |
|------|----------|------|------|------|
| 本地模型 | sentence-transformers | 免费、数据不出去、无网络延迟 | 首次加载慢、占用本地内存 | 免费 |
| OpenAI API | text-embedding-3-small | 效果好、无需本地资源 | 数据上传第三方、有费用 | 按 token 计费 |
| Voyage AI | voyage-2 | 检索效果优秀 | 数据上传第三方、有费用 | 按 token 计费 |

**本项目选择：sentence-transformers（`paraphrase-multilingual-MiniLM-L12-v2`）**

理由：数据本地处理，适合对数据安全有要求的企业场景；支持中文，384 维向量，效果够用；完全免费。

---

### 向量存储

| 方案 | 代表选项 | 优点 | 缺点 | 适用场景 |
|------|----------|------|------|----------|
| 本地文件库 | FAISS | 纯本地、无需启动服务、零运维 | 不支持并发写、不支持分布式 | 单机、中小规模文档 |
| 托管向量数据库 | Pinecone | 全托管、支持大规模 | 有费用、数据在第三方 | 生产环境、大规模 |
| 自托管向量数据库 | Weaviate / Qdrant | 功能全、支持并发 | 需要运维、部署复杂 | 多用户、高并发场景 |
| 传统数据库扩展 | pgvector（PostgreSQL）| 复用现有数据库 | 性能不如专用向量库 | 已有 PG 的项目 |

**本项目选择：FAISS**

理由：文档量不大，单机部署，无需起额外服务；本地文件形式，简单直接，部署零成本。

---

### LLM（大语言模型）

| 方案 | 代表选项 | 优点 | 缺点 | 费用 |
|------|----------|------|------|------|
| Claude API | claude-sonnet-4-6 | 中文理解好、上下文长、指令遵循强 | 需要 API Key | 按 token 计费 |
| OpenAI API | GPT-4o | 生态成熟、插件丰富 | 需要 API Key | 按 token 计费 |
| 本地部署 | Ollama + Llama 3 | 完全本地、数据不出去 | 需要高配 GPU、效果弱于商业模型 | 硬件成本 |
| 国产模型 | 通义千问、DeepSeek | 中文优化、国内访问稳定 | 部分功能受限 | 按 token 计费 |

**本项目选择：Claude API（claude-sonnet-4-6）**

理由：中文理解和指令遵循效果好，回答质量稳定；长上下文窗口适合塞入多个检索片段。

---

### RAG 实现方式

| 方案 | 说明 | 优点 | 缺点 |
|------|------|------|------|
| 手写 RAG | 自己实现各模块 | 完全可控、无额外依赖、便于学习原理 | 开发量稍大 |
| LangChain | 框架封装全流程 | 文档丰富、快速上手 | 抽象层多、调试复杂、版本变动频繁 |
| LlamaIndex | 专注于 RAG 场景 | RAG 功能完整 | 学习曲线较陡、灵活性受限 |

**本项目选择：手写 RAG**

理由：逻辑并不复杂，自己实现能完全掌控每个环节，也更便于理解 RAG 的原理。框架封装带来的便利，在这个规模下反而是负担。

---

### Web 界面

| 方案 | 代表选项 | 优点 | 缺点 |
|------|----------|------|------|
| Streamlit | streamlit | Python 原生、几十行代码搞定 | 界面定制性有限 |
| Gradio | gradio | 适合 AI demo | 组件较少 |
| FastAPI + 前端 | FastAPI + React | 完全定制 | 开发成本高 |

**本项目选择：Streamlit**

理由：快速出可用界面，Python 写，和其他模块无缝集成，适合这种工具型项目。

## 系统架构

```
rag-knowledge-base/
├── app.py                  # Streamlit 主界面
├── config.py               # 全局配置
├── indexer/
│   ├── document_loader.py  # 文档解析（PDF/DOCX/TXT/URL）
│   ├── text_splitter.py    # 文本切块
│   └── embedder.py         # Embedding + FAISS 索引
├── retriever/
│   └── searcher.py         # 向量检索
└── generator/
    └── claude_client.py    # Claude API 调用
```

## 几个实现细节

**切块大小怎么定**

切块大小（chunk size）不是 Embedding 的标准，而是一个需要根据场景调的参数。太大了检索精度下降，太小了上下文不完整。我用的 512 字符、64 字符重叠，适合普通文档，密集技术文档可以适当调小。

重叠的目的是避免关键信息刚好被切断在两个 chunk 的边界处。

**System Prompt 的设计**

把 Prompt 拆成两部分：
- `system`：角色设定，告诉模型"你是知识库助手，只根据参考内容回答"
- `user`：具体的参考内容 + 用户问题

分开写是因为 Claude API 支持独立的 `system` 参数，这样角色约束更稳定，不容易被用户输入干扰。

**URL 文档的处理**

用 BeautifulSoup 抓取网页内容，过滤掉 `<script>`、`<style>` 等噪音标签，只保留正文文本。对于需要登录的页面就没办法了，这个场景可以让用户手动复制文本上传。

## 踩过的坑

**macOS 上 Streamlit 崩溃**

PyTorch 的多进程和 macOS 的 fork 机制有冲突，会 segfault。解决方法是启动时加环境变量：

```bash
OMP_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false streamlit run app.py
```

**API Key 没生效**

在 `~/.zshrc` 里设了 `ANTHROPIC_API_KEY`，但新开的终端 source 了，Streamlit 启动的子进程却没拿到。解决方法是在启动命令里显式传：

```bash
ANTHROPIC_API_KEY=你的key OMP_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false streamlit run app.py
```

## 效果

支持上传 PDF、Word、TXT、Markdown，也能直接输入网页 URL。索引完成后就可以对话了，回答会附带参考来源，可以展开查看原文片段。

本地跑，数据不出去，适合对数据安全有要求的场景。

---

完整代码：[https://github.com/lijifeng123/ai_agent_learning_rag/tree/main/rag-knowledge-base](https://github.com/lijifeng123/ai_agent_learning_rag/tree/main/rag-knowledge-base)
