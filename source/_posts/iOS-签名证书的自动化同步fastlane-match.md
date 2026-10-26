---
title: iOS 签名证书的自动化同步（fastlane match）
date: 2026-10-26 23:40:00
tags: iOS、fastlane、证书、CI
---

## 背景

工程有两个 Apple 账号、五个区域 target（CN / Global / TW / JP / SEJ），每个 target 还带一个 Widget 扩展；签名类型又分 appstore / adhoc / development。也就是几十套「证书 + 描述文件」的组合，全部靠人工在各台机器上维护。

真正的问题不是「手动操作麻烦」，而是**状态没人对得上**：

- 证书有三类有效期，各自独立；
- 描述文件里绑着设备列表，加一台设备就要重建；
- 设备本身还有启用 / 禁用的状态。

这三样分头变化，任何一环没传到打包机上，结果都是「包能打出来，但装不上」——**而且全程不报错**。

一次典型事故：`umu_en_ad` 的新版描述文件（97 台设备）在 7-30 生成并提交进仓库，但 11 天里没被装到任何一台打包机上。8-05 打出来的包，里面嵌的还是旧版本（96 台），新注册的那台设备一直装不上测试包。整个过程零报警，因为打包确实成功了，只是签错了文件。

自动化就是为了消掉这个人工环节。

## 整体模型

证书不散落在各人电脑上，全部加密存在私有 Git 仓库，按 Apple 账号分两条分支：

| Team ID | Team Name | 覆盖区域 | match 分支 |
|---|---|---|---|
| `SHV56P72QA` | Beijing UMU Technology CO.LTD. | CN | `release/cn` |
| `9N777LKWZK` | UMU Technology Co., Limited | Global / TW / JP / SEJ | `release/global` |

- 仓库：`git@git.umu.work:usd/ios-certificates.git`，`storage_mode("git")`。
- `team_id` 和 `git_branch` 不写死在 `Matchfile` 里，由命令行传入。
- 分支名必须带 `release/` 前缀，因为 GitLab 的 pre-receive hook 要求分支以 `master|feature|dev|hotfix|release` 开头。
- 解密口令 `MATCH_PASSWORD` 团队共享。
- 明确定位：SEJ 的 `com.umu.ates` 在 `9N777LKWZK` 名下，归本项目管；走客户方独立账号的 `jp.co.sej.ssc.app.ates` 和 `com.sekisuihouse.umu` 不纳管。

两个关键设计决定：

1. **按账号分分支**，把两个账号的证书彻底隔离；
2. **日常只读**（`--readonly`），所有会写仓库的操作单独收口到脚本里，不允许随手写。

## 签名解析的三条线

代码签名要在三个环节各解析一次，依据不同：

| 环节 | 依据 | 谁提供 |
|---|---|---|
| archive 编译签名 | pbxproj 的 `PROVISIONING_PROFILE_SPECIFIER`（**名字**，如 `umu_cn_ad`） | `update_project_provisioning` 从 `mobileprovision/` 读出名字写进去 |
| export 打 ipa | gym 的 `export_options.provisioningProfiles`（名字） | match 写 lane_context，gym 自动填 |
| 本机要有这个文件 | 按名字在 profile 目录里匹配 | match 每次打包同步 |

几个容易搞错的地方：

- **UUID 不起作用**。pbxproj 里的 `PROVISIONING_PROFILE = "<UUID>"` 是 Xcode 8 之后弃用的 legacy key，已经被忽略。实测同一个 UUID 同时挂在 8 个不同 specifier 下、本机还不存在，打包却一直成功——**名字才是唯一有效的标识**。
- **本机同名描述文件常有多份**。加设备会重新生成，旧的不会被删，实测 `umu_en_ad` 有 4 份（91/96/96/97 台各一）。Xcode 挑哪份没有公开文档，经验上是取最新。match 每次把仓库当前那份装下来使它成为最新，「取最新」才总是对的。**所以 match 不是可选的加速项**。
- **`mobileprovision/` 目录必须存在，但不需要跟着设备列表更新**。`update_project_provisioning` 只从这些文件里取 `Name`，而加设备只改 UUID 和设备列表、不改 `Name`。所以那些文件退化成「提供正确名字的占位文件」，内容新旧不影响打包结果。

## 打包链路接入

核心是 `Fastfile` 里的一个 helper，每个打包 lane 的第一件事就是它：

```ruby
def sync_signing_profiles(type)
  return false unless ENV['MATCH_ENABLED'] == 'true'
  # 1. 读 .env 里的分支、team、bundle id（主 App + Widget）
  # 2. match(readonly: true) 只读拉取，失败重试 3 次，退避 5s / 10s
  # 3. verify_profile_name 校验装下来的描述文件名与 .env 期望的一致
end
```

设计要点：

- **开关**：`MATCH_ENABLED`，回退时改 `false` 即可。
- **只读**：`readonly: true`，日常打包绝不新建、吊销证书。含义是「不去 Apple 后台做任何写操作」——仓库里有什么就装什么，找不到就报错，而不是偷偷新建。这正是我们要的。
- **主 App + Widget 一次带走**：`app_identifier` 传数组。
- **名字兜底校验**：读 match 写回的环境变量，确认描述文件名字与 `.env` 里期望的一致，不一致直接报错。这一句专门堵「同步了但装的是旧文件」这种静默失败。
- **位置在最前面**：放在 lane 第一条，注释里写明是为了避免白跑 Flutter 构建。

gym 侧配合：`export_xcargs: "-allowProvisioningUpdates"`；`export_options` 在 match 已经写了 lane_context 时就不重复填。

## 使用脚本

三个脚本职责分开，所有写操作只从这几个入口走。

### 日常同步 `fastlane/match_sync.sh`

```bash
bash fastlane/match_sync.sh
```

流程：

1. 先 `ssh -T git@git.umu.work` 校验连通性（输出含 `welcome` 才算通）；
2. 处理 gem 镜像源和 bundler 版本（`>= 3` 或未安装时自动装 2.7.2 并改用 `bundle _2.7.2_`）；
3. 对两个账号各遍历 `appstore / adhoc / development` 三种类型，全 `--readonly`，合计 6 组。

跑完描述文件落在 `~/Library/MobileDevice/Provisioning Profiles/`，证书进钥匙串，之后可打任意区域、任意环境的包。

### 添加测试设备 `fastlane/match_add_device.sh`

```bash
bash fastlane/match_add_device.sh          # 交互式，默认两个账号
bash fastlane/match_add_device.sh both|cn|global
```

设备清单每行一条 `UDID 设备名`，Ctrl+D 结束；UDID 会校验格式（25 位带横杠 / 40 位十六进制），支持 `#` 注释。

执行链路：

1. **预拉取比对**：先拉已注册设备清单，按设备类型统计名额用量；
2. **三态处理**：

   | 状态 | 含义 | 行为 |
   |---|---|---|
   | `NEW` | 未注册 | 注册，占 1 个名额 |
   | `ENABLED` | 已注册且启用 | 跳过 |
   | `DISABLED` | 已注册但被禁用 | 自动启用（不占新名额） |

3. **逐个重建描述文件**：对每个「bundle id × 类型」跑

   ```bash
   fastlane match <type> \
     --git_branch <branch> --team_id <team> \
     --readonly false --force \
     --app_identifier <app_id> \
     --profile_name <项目用名> \
     --api_key_path <key.json>
   ```

4. **校验目标设备真在 profile 里**（`security cms -D` + `plistlib` 读 `ProvisionedDevices`），不在就报错；
5. 同步进 `mobileprovision/`（留档，漏了不影响打包）→ 跑验证脚本 → 提示 commit。

只动 adhoc + development（appstore 描述文件不含设备）。CN 账号 4 个、国际账号 14 个描述文件。

**为什么加设备是安全的**：`--force` 只重生成描述文件，证书复用现有的、**不重新打包 p12**，因此不会触发下面 OpenSSL 那个坑。前提是本机已有对应证书私钥，否则 match 可能去新建证书——那是红线。

脚本是**幂等**的：设备已注册就不重复注册，描述文件已含目标设备就跳过重建。实测拿一台已就位设备重跑，结果是「重建 0 / 跳过 14 / 失败 0」且 git 零 diff。

### 验证 `fastlane/match_verify.sh`

这个是安全带，也是我认为整套里最值得讲的设计。

match 在私钥没真正装进钥匙串的时候，**照样打印成功**。本机因为本来就有私钥，完全察觉不到，只有干净的机器或 CI 才爆发。所以这个脚本的做法是：**造一个全新的临时钥匙串**（`/tmp/match_verify_$$.keychain`），在里面跑一次真实的 `match --readonly`，模拟「另一台机器」的处境——

- 检测输出里是否出现 `MAC verification failed`；
- 数临时钥匙串里可签名的身份数量，**≥ 2 且无 MAC 错**才打印 `✅✅✅ 验证通过`；
- `trap cleanup EXIT` 保证退出时删掉临时钥匙串。

只读、不改仓库、无副作用。**铁律：任何写证书的操作后必跑它，只信 `✅✅✅`，别信 `installed 🙌`。**

## 踩过的坑

### 一、OpenSSL 3.x 导致私钥装不进钥匙串

最隐蔽的一个。

- **现象**：别的机器 / CI 同步后证书没有私钥，无法签名；但 match 依然打印 `installed 🙌`，`security: MAC verification failed during PKCS12 import` 被淹没在输出里。本机察觉不到，只有干净机器 / CI 打包才爆发。
- **根因**：OpenSSL 3.0 起打包 p12 默认用现代算法（AES / PBKDF2 / SHA256），旧版 macOS 的 `security` 框架不认，私钥装不进去。而 match 自带的导入命令内部就是用 OpenSSL 打包 p12。
- **解法**：用 **legacy 格式**的 p12。macOS 钥匙串访问右键导出的天然就是 legacy 格式。纯 CI 无图形界面时用 openssl 强制：

  ```bash
  openssl pkcs12 -export -legacy \
    -certpbe pbeWithSHA1And40BitRC2-CBC \
    -keypbe pbeWithSHA1And3-KeyTripleDES-CBC \
    -macalg sha1 -in cert_and_key.pem -out out.p12 -passout pass:
  ```

- **关键约束**：**入库绝不能用 match 自带的导入命令**，因为它会用 openssl 重新打包，又把格式改坏。正确做法是「解密仓库 → 直接替换 p12 → 重新加密 → push」。

### 二、必须 `--force` + `--profile_name`

两个参数缺一不可：

1. **不给 `--profile_name`** → match 用自己的默认命名（`match AdHoc com.UMU.UMU-TW`）建一个**平行 profile**，而工程按 `umu_tw_ad` 找——产出根本用不上，Portal 上还多一条垃圾。
2. **用 `--force_for_new_devices`** → 它判定设备已齐时直接复用旧 profile，此时 `--profile_name` **根本不生效**（只在真正创建 profile 时才读取）。必须用 `--force`。
3. 好消息：用同名 `--profile_name` 重建时，match 会自动删掉 Portal 上旧的同名 profile，不产生重名，无需手动预删。

### 三、设备状态与描述文件不同步

被**禁用**的设备不会被包含进描述文件。实测 CN 账号总设备 87、禁用 8，而 `umu_cn_ad` 里正好 **79** 个——差额精确等于禁用数。

而重复注册对已存在的 UDID 是**幂等忽略**的：既不报错，**也不会启用它**。所以不识别这个状态，就会出现「注册成功 → 描述文件重建成功 → 设备还是装不上」。

两道防护：注册前先 classify，检测到 `DISABLED` 就调 ASC API 启用；重建后校验目标设备真的在里面。

> 写 `Device.enable` 时注意：它收的是 **UDID 不是 id**。传错时 `find_by_udid` 返回 nil **且不抛异常**，必须校验返回值，否则又是一个静默失败。

### 四、fastlane 版本

旧版（2.225.0）在苹果改了接口之后**建不了描述文件**，报 `'templateName' is not an attribute on the resource 'profiles'`。根因是苹果 ASC API 移除了 `profiles` 资源的 `templateName` 属性，而旧版 spaceship 仍在 POST 里发它。

**但只读同步不受影响**——所以这个坑平时完全藏着，只有加设备时才炸。Gemfile 里钉死 **2.237.0**。

### 附：描述文件的过期规律（实测归纳，非苹果官方规则）

重建描述文件**不会延长有效期**。基于本项目 32 个 profile 的实测：

```
分发类（adhoc / appstore）  过期日 = min(创建日+1年, 证书到期日)   → 锚定证书
开发类（development）        过期日 = 创建日 + 1 年                → 不看证书
```

样本命中率：adhoc 10/10，development 10/10。所以同一天同一命令生成的 `umu_tw_ad` 是 357 天（被证书截断）、`umu_tw_dev` 是 365 天。**真正的死线始终是证书到期日。**

> 这是观察到的行为，苹果官方文档对此只字未提。

## 安全边界

```
✅ 随便用：  match ... --readonly（同步，日常）
⚠️ 想清楚：  --readonly false（写仓库）/ --force（重生成描述文件）
⚠️ 必配对：  --force 时必须同时给 --profile_name
🔴 别碰：    --force_for_new_certificates（换证书，会连锁失效 + OpenSSL 坏格式）
🔴 别碰：    match import（OpenSSL 重打包毁 p12 格式）
🔴🔴 绝不：  match nuke（删光 Team 证书）
```

**续期**只做到半自动：Portal 上的建 / 吊证书**必须人工**（证书每个 Team 上限 3 个，误吊销会连锁失效），其余步骤可以脚本化。

续期后还要查打包机的 partition list——这是唯一会用到 `MATCH_KEYCHAIN_PASSWORD` 的时机。有图形界面会弹「codesign 想要使用钥匙串机密信息」卡到超时；无图形界面直接报 `errSecInternalComponent`。而这个失败**只警告不中断**，故障会推迟到很后面的 codesign 才爆发，很容易往证书过期、profile 不匹配上查很久。所以续期后在打包机上跑一次试签确认：

```bash
echo test > /tmp/cs_probe
codesign -s "Apple Distribution: ..." /tmp/cs_probe \
  && echo "✅ 免密签名正常" || echo "❌ partition list 有问题"
rm -f /tmp/cs_probe
```

## 尚未解决

- **`mobileprovision/` 依赖**。打包已经走 match，但 `update_project_provisioning` 仍然需要那个目录里的文件，只为取一个 `Name` 字符串。fastlane 有现役 action 可以直接传名字，计划先让 match 在打包机跑稳一段时间，再换 action、删目录。顺带还能消掉一个隐藏依赖：`update_project_provisioning` 会往 `/tmp` 下载 Apple 根证书用于验签，而 `/tmp` 会被系统清理——这是条公网依赖。
- **CN 真机调试的隐患**。`umu_cn_dev` / `umu_cn_dev_widget` 里内嵌两张开发证书，其中一张已过期；另两张新的有效证书因为 profile 生成时间更早而没被包含进去。目前有一张有效证书兜底，但换台没有对应私钥的机器，真机调试就会失败。
- **设备名额是硬约束**。每个设备类型（iPhone / iPad / iPod）每年各 100 个，删除 / 禁用**不释放名额**，只能等年度重置。格式合法但不存在的 UDID 苹果照样接受，白占名额。

## 小结

签名这类「错了很难查、平时又不常动」的环节，重点不在于自动化得多彻底，而在于：

- 把状态收敛到一个**可验证的单一来源**；
- 给每个危险动作**配上护栏**（只读默认、写操作收口、验证脚本强制跑）。

最值得花心思的往往不是主流程，而是**怎么让失败能被看见**——因为这类问题的代价恰恰在于它不报错。
