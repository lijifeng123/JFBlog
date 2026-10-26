---
title: iOS 内测包的内网 OTA 分发与 JP 重签支持
date: 2026-10-26 23:55:00
tags: iOS、OTA、itms-services、nginx、Python
---

## 背景

内测包要有地方发。原来走 fir，但 fir 的下载页靠 **UA 正则**判断设备，而 iPadOS 13 之后默认「请求桌面网站」，UA 会报成 `Macintosh`——fir 判不出是 iOS，直接把下载按钮藏了，部分 iPad 根本装不了包。这个问题在第三方侧、改不动。

于是在打包机上另搭了一条内网 OTA 通道：nginx 直出静态安装页，页面不做任何 UA 判断，安装按钮永远显示。附带好处是走内网直连，实测 100M 的包 5 秒下完（约 19.6 MB/s）。

同一套 nginx 下还挂了一个服务，解决另一个问题：日本客户用自有证书重签 JP 包时，包里的 Widget 会碍事，需要一个「点一下就去掉 Widget」的页面。

## 安装机制：itms-services 与 manifest.plist

理解这条通道，关键是先搞清楚「点按钮」到「装上包」中间发生了什么。

### 按钮里是什么

安装按钮的 `href` 不指向 ipa，而是拼出来的一个特殊 scheme：

```html
itms-services://?action=download-manifest
  &url=https%3A%2F%2Fjenkins-app-new.umu.work%2Fota%2FUMU-JP%2F20260805_155200-7.7.26.2%2Fmanifest.plist
```

`url` 参数是 **`manifest.plist` 的绝对地址**，整体做了 URL 转义。必须是绝对地址，是因为这个 scheme 会被交给**系统**处理、脱离了页面上下文，写相对路径没用。

（转义结果能硬编码，是因为脚本入口就限定站点标识只允许字母数字和 `. _ -`，不需要运行时转义。）

### 点击之后发生了什么

1. Safari 识别 `itms-services://`，把它交给系统的安装服务；
2. 系统按 `url` 参数去拉 `manifest.plist`；
3. 从清单里读出 ipa 的真实地址并下载；
4. **校验签名**——必须是 Ad Hoc（或企业 / 开发）签名的包，且描述文件里**登记了这台设备的 UDID**；
5. 通过之后才安装，对话框里的图标和名称同样来自清单。

也就是说，按钮只负责**告诉系统去哪读清单**；真正的下载地址、包名、版本都在清单里。

### manifest.plist 的内容

由发布脚本现场生成：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>https://…/app.ipa</string>
        </dict>
        <dict>
          <key>kind</key><string>display-image</string>
          <key>url</key><string>https://…/icon.png</string>
        </dict>
        <dict>
          <key>kind</key><string>full-size-image</string>
          <key>url</key><string>https://…/icon.png</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>com.UMU.UMU-JP</string>
        <key>bundle-version</key><string>7.7.26.2</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>UMU</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
```

| 字段 | 作用 |
|---|---|
| `assets` → `software-package` | **真正要下载的 ipa 地址** |
| `display-image` / `full-size-image` | 安装对话框和主屏图标，脚本里只有图标存在时才输出 |
| `metadata.bundle-identifier` | 要与包内一致，安装时会校验 |
| `metadata.bundle-version` | 显示用（`CFBundleShortVersionString`） |
| `metadata.title` | 安装对话框显示的名称 |

### 必须满足的条件

- **必须 HTTPS，且只能用 Safari**。微信 / 企业微信的内置浏览器里点这个按钮没有任何反应——所以页面上单独判断 UA，命中微信这类才显示一行橙色警告引导去 Safari。
- **plist 的 Content-Type 要映射成 `application/xml`**，nginx 片段里专门配了。
- **`manifest.plist` 绝对不能缓存**。缓存了会出现「点了按钮却装到上一个版本」——整个 `/ota/` 都设了 `Cache-Control: no-store`。
- **包必须是 Ad Hoc 签名，且本机 UDID 在描述文件里**。

> 这条链路和普通网页下载最大的区别：它不受「文件能不能下」限制，受**签名和设备白名单**限制。装不上通常不是网络问题，是设备没登记。

## 分发页与发布脚本

部署在打包机已有的 nginx 上（该机器同时在反代 Jenkins，已有正式通配符证书），纯静态直出，不额外引入服务。发布脚本由 fastlane 的 `archive_and_publish_adhoc` 调用，产出三级页面：

```
/ota/                    站点入口，每个站点显示最新包
/ota/{SITE}/             该站点最新包（可直接装）+ 历史版本列表
/ota/{SITE}/{STAMP}/     某次构建的安装页
```

每个构建目录里放 ipa、图标、二维码、`manifest.plist` 和元信息（`meta.env`）。站点级二维码永远指向最新包；每个站点保留最近 20 版。

打包机上的数据目录：

```
/Users/Shared/ota/
├── site/ota/            nginx 根目录（不入库：单个 ipa 上百 MB）
│   ├── index.html       全部站点
│   └── {SITE}/          站点页：顶部最新包 + 历史版本列表
│       ├── index.html
│       ├── site-qr.png  站点二维码，永远指向最新包
│       └── {STAMP}/     单次构建：app.ipa / icon.png / qr.png /
│                        manifest.plist / meta.env / note.txt / index.html
├── nginx-ota.conf       nginx 实际 include 的配置（setup.sh 生成）
└── jp-support/          JP 重签支持服务副本 + 日志
```

## 几个关键设计决定

**发布脚本随仓库走，打包机上不放副本。** 两边各存一份迟早会漂移，仓库里的那份是唯一信息源，改完推代码即生效。

**nginx 片段生成到固定路径，而不是让 nginx 直接 include 仓库里的文件。** 一旦 include 仓库文件，nginx 就被绑死在 Jenkins workspace 的存在和当前 checkout 的分支上——切到一个没有这个文件的分支再 reload，整个 Jenkins 反代都会跟着起不来。风险和收益不成比例。

**Slack 通知必须用「本次构建的精确地址」，不能用站点入口。** 站点入口永远指向最新包，别人再打一次包，旧消息就指到别人的包上了。所以脚本结尾专门输出一行机器可读的 `OTA_BUILD_URL=` 给 fastlane 解析。

**靠数据目录存不存在判断「本机是否部署了 OTA」。** 开发者本机没有这个目录就直接跳过发布——不然页面生成了也没 nginx 服务，还白拷一个上百 MB 的 ipa；同时不影响打包和 fir 上传。

**UA 判断的失败方向要选对。** 安装按钮永不隐藏；二维码默认显示、只在**确认是 iOS** 时才隐藏——判断错了最多多显示一个二维码，不会让人装不了包。

**只允许内网访问。** nginx 片段里覆盖了全部 RFC1918 私有网段。

## 踩过的坑

**`head -1` 会让脚本自己中断。** 脚本是 `set -euo pipefail`，`head` 读够了就退出、给上游发 SIGPIPE，整条管道返回非零，被 `set -e` 当成错误。所以「取最新版本」改用参数展开取首行，不走管道。

**函数里的临时变量必须 `local`。** 有个读元信息的函数没加 `local`，覆盖了调用方 `while read` 循环里的同名变量，结果历史版本的链接全被写成了 `/`。

**ipa 里的图标浏览器不认。** 包内 png 是苹果 CgBI 优化过的，得先用 `pngcrush -revert-iphone-optimizations` 反优化。注意 `pngcrush` 失败时仍返回 0，只能靠产物是否存在来判断。

**commit message 要转义。** 里面出现 `& < >` 完全可能，不转义会把页面和 plist 撑坏，所以统一走一个转义函数。

**页面样式一改，老包的安装页要跟着更新。** 所以每次发布都把该站点下所有版本页重渲染一遍，避免同一站点下新旧页面长得不一样。

## JP 重签支持（去除 Widget）

### 为什么需要

日本客户用**自有证书**重签我们 JP 的 App Store 包。包里的 `Widget-JPExtension.appex` 会让重签工具额外索要扩展的描述文件；而且 Widget 用的 App Group `group.umu.jp` 是写死的，重签后本来也拿不到数据。所以给客户的包，要先去 Widget。

### 服务形态

静态页做不到「点击后生成 ipa」，所以加了一个轻量动态服务：

- **系统自带 python3 标准库**实现 HTTP 服务，监听 `127.0.0.1:8765`，launchd 常驻；
- nginx 在 `/ota/` **里面嵌套** `/ota/jp-support/` 反代过去——直接继承已有的内网白名单、MIME 映射和 `no-store`，不用重复配置；
- 上百 MB 的 ipa **下载交给 nginx 直出**（正则 location + `alias`，只放行 `UMU-JP-*.ipa`，dSYM 之类不暴露），Python 只负责页面、生成和记录；
- 页面服务端渲染 HTML，表单 POST + 303 跳转，**不引入前端框架、不提供 JSON API**，与现有 OTA 静态页风格保持一致。

页面就是列表 + 每行两个按钮：默认是「查看当前 IPA」和「去除 Widget」；生成过之后按钮变成「查看无 Widget IPA」，直接进详情页。详情页下载的文件名统一成 `UMU-JP-<版本>.<build>.ipa`。

### 去 Widget 的动作

把源包 clone 一份副本 → 按精确条目名删掉 `PlugIns/Widget-*.appex` → 校验压缩包完整 → **原子改名**落到正式位置 → 成功之后才清理旧产物。**源包全程只读。**

### 几个关键决定

- **用 `zip -d` 而不是 Python 的 `zipfile` 重新打包**。要保留其余条目的原始压缩数据和属性、不重新压缩；同时关掉通配符、从 stdin 传精确条目名，避免误删。Python 的 `zipfile` 做不到免重压缩地复制条目。
- **失败要能隔离**。半成品只写在临时目录，校验全过了才原子改名，成功之后才 prune。任何一步失败都不动已有产物，源包不受影响；服务启动时还会清理残留半成品。
- **全局锁串行生成**，避免并发互踩；生成前检查剩余空间是否够源包的两倍。
- **只删扩展条目，不动主 App 的二进制和资源**。删完之后主 App 的签名封印失效是**预期行为**——这个产物本来就是拿去重签的。
- **服务跑的是安装副本，不是仓库里的文件**。理由和 nginx 片段一样：不能让服务被 Jenkins workspace 当前 checkout 的分支绑死。
- **下载记录只能从页面点击采集**。下载是 nginx 直出的，服务端感知不到，所以放在页面点击时用 `sendBeacon` 上报一条。这是取舍不是漏洞——直接访问下载链接确实不会留记录。
- **每个文件访问都走白名单正则校验**（不含 `/` 和 `..`），挡住路径穿越。
- **线上版本标记用 iTunes Lookup，不用 App Store Connect 凭证**。好处是不用配密钥，代价是只能拿到营销版本号、精确不到 build；成功缓存 1 小时、失败缓存 5 分钟，接口挂了只是丢标记，不影响生成与下载。

### 已知脆弱点

- 列表依赖 fastlane 的 ipa 命名格式和输出目录，任一改动匹配不到，列表就会变空；
- 去 Widget 依赖扩展命名是 `Widget-*.appex`，改名或新增扩展就要同步调整；
- 产物只保留 1 个（按 mtime），需要时再次生成——打包机磁盘已用约 94%，这是当前的取舍。

## 小结

这套东西解决的都是「内部交付」的问题，两个点值得记一下：

1. **itms-services 这条链路的特殊性**：它不受「文件能不能下载」限制，受**签名和设备白名单**限制。所以「装了没反应」八成不是网络问题，而是设备没登记，或者不在 Safari 里打开。
2. **配置与数据的边界**：nginx 片段生成到固定路径、服务跑安装副本、发布脚本随仓库走——本质都是**不让生产环境被构建工作区绑死**。这在 CI 机器上尤其重要，误配一次可能连带把整个反代搞挂。
