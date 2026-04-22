---
title: RAG 企业知识库问答系统设计
date: 2026-04-22
tags: [RAG, AI, Python]
---

最近在做一个企业知识库问答系统，把整个过程记录下来，顺便把技术选型的思考也写出来，供参考。

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

## 技术选型

选型时面临几个决策点，这里说一下我的思路。

**Embedding 模型：本地 vs API**

本地用 `sentence-transformers`，API 用 OpenAI 或 Voyage。

本地方案的好处是免费、数据不出去、延迟低；缺点是首次加载模型要等几秒。我选了本地，用 `paraphrase-multilingual-MiniLM-L12-v2`，支持中文，384 维向量，效果够用。

**向量存储：FAISS vs 向量数据库**

文档量不大的话，FAISS 就够了——纯本地文件，不需要起服务，查询速度也快。如果是生产环境、多用户并发，再考虑 Pinecone、Weaviate 这类。

**LLM：Claude**

直接用 Anthropic API，`claude-sonnet-4-6`，效果不错，中文理解也好。

**界面：Streamlit**

快速搭一个 Web 界面，Python 写，几十行代码就能跑起来。

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

每个模块职责单一，比较好维护。

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

项目代码在 GitHub 上，感兴趣的可以拉下来跑跑看。
